import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.core.config import config
from src.core.models import Token
from src.services.token_manager import TokenManager


class _RefreshDbStub:
    def __init__(self, tokens):
        self.tokens = tokens
        self.updates = []
        self.consecutive_error_counts = {token.id: 0 for token in tokens}
        self.reset_error_calls = []

    async def get_token_refresh_config(self):
        return SimpleNamespace(enabled=False, refresh_interval_minutes=120)

    async def get_active_tokens(self):
        return self.tokens

    async def get_all_tokens(self):
        return self.tokens

    async def get_token(self, token_id):
        return next((token for token in self.tokens if token.id == token_id), None)

    async def get_token_by_extension_route_key(self, route_key):
        return next(
            (token for token in self.tokens if token.extension_route_key == route_key),
            None,
        )

    async def update_token(self, token_id, **updates):
        self.updates.append((token_id, updates))
        token = await self.get_token(token_id)
        if token:
            for key, value in updates.items():
                setattr(token, key, value)

    async def increment_token_stats(self, token_id, stat_type):
        if stat_type == "error":
            self.consecutive_error_counts[token_id] += 1

    async def get_token_stats(self, token_id):
        return SimpleNamespace(
            consecutive_error_count=self.consecutive_error_counts[token_id],
        )

    async def get_admin_config(self):
        return SimpleNamespace(error_ban_threshold=3)

    async def reset_error_count(self, token_id):
        self.consecutive_error_counts[token_id] = 0
        self.reset_error_calls.append(token_id)


class _RecordingTokenManager(TokenManager):
    def __init__(self, db, refresh_result=True):
        super().__init__(db, flow_client=SimpleNamespace())
        self.refresh_result = refresh_result
        self.refresh_calls = []
        self.sync_calls = []
        self.disabled_tokens = []

    async def _refresh_at_inner(self, token_id, *, disable_on_failure=True):
        self.refresh_calls.append((token_id, disable_on_failure))
        return self.refresh_result

    async def disable_token(self, token_id):
        self.disabled_tokens.append(token_id)

    async def sync_extension_browser_session(self, token_id):
        self.sync_calls.append(token_id)
        return self.refresh_result


class ExtensionAtAutoRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.captcha_config = config._config.setdefault("captcha", {})
        self.original = dict(self.captcha_config)
        self.captcha_config["captcha_method"] = "extension"

    async def asyncTearDown(self):
        self.captcha_config.clear()
        self.captcha_config.update(self.original)

    @staticmethod
    def _token(token_id, expires_at, *, protocol_mode="session"):
        return Token(
            id=token_id,
            st=f"st-{token_id}",
            at=f"at-{token_id}",
            email=f"account-{token_id}@example.com",
            at_expires=expires_at,
            protocol_mode=protocol_mode,
            auto_refresh_enabled=True,
        )

    async def test_expired_expiring_and_incomplete_extension_tokens_are_refreshed(self):
        now = datetime.now(timezone.utc)
        missing_expiry = self._token(5, None)
        missing_at = self._token(6, now + timedelta(hours=2))
        missing_at.at = ""
        tokens = [
            self._token(1, now + timedelta(minutes=30)),
            self._token(2, now - timedelta(minutes=1)),
            self._token(3, now + timedelta(hours=2)),
            self._token(4, now + timedelta(minutes=30), protocol_mode="protocol"),
            missing_expiry,
            missing_at,
        ]
        manager = _RecordingTokenManager(_RefreshDbStub(tokens))

        await manager.run_protocol_refresh_once()

        self.assertEqual(
            manager.refresh_calls,
            [(1, False), (2, False), (5, False), (6, False)],
        )

    async def test_failed_proactive_refresh_waits_before_retry_and_never_disables(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now - timedelta(minutes=30))
        manager = _RecordingTokenManager(_RefreshDbStub([token]), refresh_result=False)

        await manager.run_protocol_refresh_once()
        await manager.run_protocol_refresh_once()

        self.assertEqual(manager.refresh_calls, [(1, False)])
        self.assertEqual(manager.disabled_tokens, [])
        self.assertEqual(manager._proactive_at_failure_counts[1], 1)

        manager._proactive_at_retry_after[1] = 0
        await manager.run_protocol_refresh_once()

        self.assertEqual(manager.refresh_calls, [(1, False), (1, False)])
        self.assertEqual(manager._proactive_at_failure_counts[1], 2)

    async def test_paused_browser_is_excluded_from_background_refresh(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now - timedelta(minutes=30))
        token.browser_enabled = False
        manager = _RecordingTokenManager(_RefreshDbStub([token]))

        await manager.run_protocol_refresh_once()

        self.assertEqual(manager.refresh_calls, [])
        self.assertEqual(manager.sync_calls, [])

    async def test_pending_browser_session_uses_sync_path(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now + timedelta(hours=2))
        token.browser_session_sync_pending = True
        manager = _RecordingTokenManager(_RefreshDbStub([token]))

        await manager.run_protocol_refresh_once()

        self.assertEqual(manager.sync_calls, [1])
        self.assertEqual(manager.refresh_calls, [])

    async def test_inactive_enabled_browser_is_included_in_automatic_recovery(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now + timedelta(hours=2))
        token.is_active = False
        token.browser_session_sync_pending = True
        manager = _RecordingTokenManager(_RefreshDbStub([token]))

        await manager.run_protocol_refresh_once()

        self.assertEqual(manager.sync_calls, [1])
        self.assertEqual(manager.refresh_calls, [])

    async def test_browser_toggle_persists_pending_sync_and_updates_route(self):
        token = self._token(1, datetime.now(timezone.utc) + timedelta(hours=2))
        token.extension_route_key = "google-1"
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        extension_service = SimpleNamespace(
            set_route_enabled=AsyncMock(),
            has_connection_for_route_key=Mock(return_value=False),
        )

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=extension_service),
        ):
            updated, connected = await manager.set_browser_connection_enabled(1, False)

        self.assertFalse(updated.browser_enabled)
        self.assertFalse(updated.is_active)
        self.assertTrue(updated.browser_session_sync_pending)
        self.assertFalse(connected)
        extension_service.set_route_enabled.assert_awaited_once_with("google-1", False)

    async def test_browser_toggle_on_reactivates_account_and_clears_captcha_state(self):
        token = self._token(1, datetime.now(timezone.utc) + timedelta(hours=2))
        token.extension_route_key = "google-1"
        token.browser_enabled = False
        token.is_active = False
        token.captcha_failure_count = 2
        token.captcha_cooldown_until = datetime.now(timezone.utc) + timedelta(minutes=5)
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        extension_service = SimpleNamespace(
            set_route_enabled=AsyncMock(),
            has_connection_for_route_key=Mock(return_value=True),
        )

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=extension_service),
        ):
            updated, connected = await manager.set_browser_connection_enabled(1, True)

        self.assertTrue(updated.browser_enabled)
        self.assertTrue(updated.is_active)
        self.assertTrue(updated.browser_session_sync_pending)
        self.assertEqual(updated.captcha_failure_count, 0)
        self.assertIsNone(updated.captcha_cooldown_until)
        self.assertTrue(connected)
        extension_service.set_route_enabled.assert_awaited_once_with("google-1", True)

    async def test_browser_toggle_on_does_not_bypass_429_ban(self):
        token = self._token(1, datetime.now(timezone.utc) + timedelta(hours=2))
        token.extension_route_key = "google-1"
        token.browser_enabled = False
        token.is_active = False
        token.ban_reason = "429_rate_limit"
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        extension_service = SimpleNamespace(
            set_route_enabled=AsyncMock(),
            has_connection_for_route_key=Mock(return_value=True),
        )

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=extension_service),
        ):
            updated, connected = await manager.set_browser_connection_enabled(1, True)

        self.assertTrue(updated.browser_enabled)
        self.assertFalse(updated.is_active)
        self.assertEqual(updated.ban_reason, "429_rate_limit")
        self.assertTrue(connected)

    async def test_browser_session_sync_refreshes_st_and_at_then_clears_pending(self):
        token = self._token(1, datetime.now(timezone.utc) + timedelta(hours=2))
        token.current_project_id = "project-1"
        token.extension_route_key = "google-1"
        token.browser_session_sync_pending = True
        token.is_active = False
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        manager._do_refresh_at = AsyncMock(return_value=True)
        extension_service = SimpleNamespace(
            get_token_bundle=AsyncMock(return_value={"token": "captcha-token"}),
            get_session_token=AsyncMock(return_value="fresh-session-token"),
        )

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=extension_service),
        ):
            synchronized = await manager.sync_extension_browser_session(1)

        self.assertTrue(synchronized)
        self.assertEqual(token.st, "fresh-session-token")
        self.assertTrue(token.is_active)
        self.assertFalse(token.browser_session_sync_pending)
        self.assertEqual(db.reset_error_calls, [1])
        manager._do_refresh_at.assert_awaited_once_with(1, "fresh-session-token", token)

    async def test_browser_session_sync_does_not_reactivate_429_ban(self):
        token = self._token(1, datetime.now(timezone.utc) + timedelta(hours=2))
        token.current_project_id = "project-1"
        token.extension_route_key = "google-1"
        token.browser_session_sync_pending = True
        token.is_active = False
        token.ban_reason = "429_rate_limit"
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        manager._do_refresh_at = AsyncMock(return_value=True)
        extension_service = SimpleNamespace(
            get_token_bundle=AsyncMock(return_value={"token": "captcha-token"}),
            get_session_token=AsyncMock(return_value="fresh-session-token"),
        )

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=extension_service),
        ):
            synchronized = await manager.sync_extension_browser_session(1)

        self.assertTrue(synchronized)
        self.assertFalse(token.is_active)
        self.assertEqual(token.ban_reason, "429_rate_limit")
        self.assertEqual(db.reset_error_calls, [])

    async def test_extension_error_threshold_schedules_session_recovery(self):
        token = self._token(1, datetime.now(timezone.utc) + timedelta(hours=2))
        token.browser_enabled = True
        db = _RefreshDbStub([token])
        db.consecutive_error_counts[1] = 2
        manager = TokenManager(db, flow_client=SimpleNamespace())

        await manager.record_error(1)

        self.assertFalse(token.is_active)
        self.assertTrue(token.browser_session_sync_pending)
        self.assertEqual(db.consecutive_error_counts[1], 0)
        self.assertEqual(db.reset_error_calls, [1])

    async def test_route_reconnect_completes_only_pending_enabled_session(self):
        token = self._token(1, datetime.now(timezone.utc) + timedelta(hours=2))
        token.extension_route_key = "google-1"
        token.browser_session_sync_pending = True
        manager = TokenManager(_RefreshDbStub([token]), flow_client=SimpleNamespace())
        manager.sync_extension_browser_session = AsyncMock(return_value=True)

        await manager.handle_extension_route_connected("google-1")

        manager.sync_extension_browser_session.assert_awaited_once_with(1)

    async def test_refresh_inner_keeps_token_active_when_background_refresh_fails(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now - timedelta(minutes=30))
        manager = TokenManager(_RefreshDbStub([token]), flow_client=SimpleNamespace())
        manager._do_refresh_at = AsyncMock(return_value=False)
        manager._try_refresh_st = AsyncMock(return_value=None)
        manager.disable_token = AsyncMock()

        refreshed = await manager._refresh_at_inner(1, disable_on_failure=False)

        self.assertFalse(refreshed)
        manager.disable_token.assert_not_awaited()

    async def test_st_to_at_response_with_expired_at_is_rejected(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now - timedelta(minutes=30))
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        manager._st_to_at_for_token = AsyncMock(return_value={
            "access_token": "still-expired-at",
            "expires": (now - timedelta(minutes=1)).isoformat(),
        })

        refreshed = await manager._do_refresh_at(token.id, token.st, token)

        self.assertFalse(refreshed)
        self.assertEqual(token.at, "at-1")

    async def test_extension_st_refresh_failure_is_persisted(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now - timedelta(minutes=30))
        token.current_project_id = "project-1"
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        extension_service = SimpleNamespace(
            get_token_bundle=AsyncMock(return_value={"token": "captcha-token"}),
            get_session_token=AsyncMock(return_value=None),
        )

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=extension_service),
        ):
            refreshed_st = await manager._try_refresh_st(token.id, token)

        self.assertIsNone(refreshed_st)
        extension_service.get_token_bundle.assert_awaited_once_with(
            "project-1",
            action="IMAGE_GENERATION",
            timeout=30,
            token_id=1,
        )
        self.assertIsNotNone(token.last_st_refresh_at)
        self.assertEqual(
            token.last_st_refresh_result,
            "failure: extension did not return a session cookie",
        )

    async def test_extension_reads_cookie_even_when_session_warmup_fails(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now - timedelta(minutes=30))
        token.current_project_id = "project-1"
        db = _RefreshDbStub([token])
        manager = TokenManager(db, flow_client=SimpleNamespace())
        extension_service = SimpleNamespace(
            get_token_bundle=AsyncMock(side_effect=RuntimeError("captcha unavailable")),
            get_session_token=AsyncMock(return_value="new-session-token"),
        )

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=extension_service),
        ):
            refreshed_st = await manager._try_refresh_st(token.id, token)

        self.assertEqual(refreshed_st, "new-session-token")
        self.assertEqual(token.st, "new-session-token")
        self.assertEqual(token.last_st_refresh_result, "success")


if __name__ == "__main__":
    unittest.main()
