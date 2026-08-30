import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from src.core.config import config
from src.core.models import Token
from src.services.token_manager import TokenManager


class _RefreshDbStub:
    def __init__(self, tokens):
        self.tokens = tokens

    async def get_token_refresh_config(self):
        return SimpleNamespace(enabled=False, refresh_interval_minutes=120)

    async def get_active_tokens(self):
        return self.tokens

    async def get_token(self, token_id):
        return next((token for token in self.tokens if token.id == token_id), None)


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

    async def test_only_non_expired_extension_session_token_inside_window_is_refreshed(self):
        now = datetime.now(timezone.utc)
        tokens = [
            self._token(1, now + timedelta(minutes=30)),
            self._token(2, now - timedelta(minutes=1)),
            self._token(3, now + timedelta(hours=2)),
            self._token(4, now + timedelta(minutes=30), protocol_mode="protocol"),
        ]
        manager = _RecordingTokenManager(_RefreshDbStub(tokens))

        await manager.run_protocol_refresh_once()

        self.assertEqual(manager.refresh_calls, [(1, False)])

    async def test_failed_proactive_refresh_waits_before_retry_and_never_disables(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now + timedelta(minutes=30))
        manager = _RecordingTokenManager(_RefreshDbStub([token]), refresh_result=False)

        await manager.run_protocol_refresh_once()
        await manager.run_protocol_refresh_once()

        self.assertEqual(manager.refresh_calls, [(1, False)])
        self.assertEqual(manager.disabled_tokens, [])

    async def test_refresh_inner_keeps_token_active_when_background_refresh_fails(self):
        now = datetime.now(timezone.utc)
        token = self._token(1, now + timedelta(minutes=30))
        manager = TokenManager(_RefreshDbStub([token]), flow_client=SimpleNamespace())
        manager._do_refresh_at = AsyncMock(return_value=False)
        manager._try_refresh_st = AsyncMock(return_value=None)
        manager.disable_token = AsyncMock()

        refreshed = await manager._refresh_at_inner(1, disable_on_failure=False)

        self.assertFalse(refreshed)
        manager.disable_token.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
