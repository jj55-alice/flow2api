import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from src.core.config import config
from src.core.models import Token
from src.services.token_manager import TokenManager


class _RefreshDbStub:
    def __init__(self, tokens):
        self.tokens = tokens
        self.updates = []

    async def get_token_refresh_config(self):
        return SimpleNamespace(enabled=False, refresh_interval_minutes=120)

    async def get_active_tokens(self):
        return self.tokens

    async def get_token(self, token_id):
        return next((token for token in self.tokens if token.id == token_id), None)

    async def update_token(self, token_id, **updates):
        self.updates.append((token_id, updates))
        token = await self.get_token(token_id)
        if token:
            for key, value in updates.items():
                setattr(token, key, value)


class _RecordingTokenManager(TokenManager):
    def __init__(self, db, refresh_result=True):
        super().__init__(db, flow_client=SimpleNamespace())
        self.refresh_result = refresh_result
        self.refresh_calls = []
        self.disabled_tokens = []

    async def _refresh_at_inner(self, token_id, *, disable_on_failure=True):
        self.refresh_calls.append((token_id, disable_on_failure))
        return self.refresh_result

    async def disable_token(self, token_id):
        self.disabled_tokens.append(token_id)


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
