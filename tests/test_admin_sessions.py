import hashlib
import tempfile
import time
import unittest
from pathlib import Path

from fastapi import Request, Response

from src.api import admin
from src.core.config import config
from src.core.database import Database


class AdminSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self.db_path = f"{self._temp_dir.name}/flow.db"
        self.db = Database(db_path=self.db_path)
        await self.db.init_db()
        await self.db.init_config_from_toml({
            "global": {
                "admin_username": "session-admin",
                "admin_password": "session-password",
                "api_key": "test-api-key",
            }
        })

        self._original_db = admin.db
        self._original_admin_username = config._admin_username
        self._original_admin_password = config._admin_password
        self._original_global_config = dict(config._config.get("global", {}))

        config.set_admin_username_from_db("session-admin")
        config.set_admin_password_from_db("session-password")
        config._config.setdefault("global", {})["admin_session_ttl_days"] = 7
        admin.db = self.db

    async def asyncTearDown(self):
        admin.db = self._original_db
        config._admin_username = self._original_admin_username
        config._admin_password = self._original_admin_password
        config._config.setdefault("global", {}).clear()
        config._config["global"].update(self._original_global_config)
        self._temp_dir.cleanup()

    async def _login(self):
        response = Response()
        payload = await admin.admin_login(
            admin.LoginRequest(
                username="session-admin",
                password="session-password",
            ),
            response,
        )
        return response, payload

    @staticmethod
    def _request_with_session(token: str) -> Request:
        return Request({
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/manage",
            "raw_path": b"/manage",
            "query_string": b"",
            "headers": [(b"cookie", f"admin_session={token}".encode("utf-8"))],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8000),
        })

    async def test_login_survives_database_instance_restart_and_sets_persistent_cookie(self):
        response, payload = await self._login()
        token = payload["token"]
        set_cookie = response.headers["set-cookie"]

        self.assertIn("Max-Age=604800", set_cookie)
        self.assertIn("expires=", set_cookie.lower())
        self.assertIn("HttpOnly", set_cookie)

        async with self.db._connect() as conn:
            cursor = await conn.execute(
                "SELECT token_hash FROM admin_sessions"
            )
            stored_hash = (await cursor.fetchone())[0]

        self.assertEqual(stored_hash, hashlib.sha256(token.encode("utf-8")).hexdigest())
        self.assertNotEqual(stored_hash, token)

        restarted_db = Database(db_path=self.db_path)
        admin.db = restarted_db
        request = self._request_with_session(token)

        self.assertEqual(await admin.verify_admin_token(request, authorization=None), token)

    async def test_expired_session_is_rejected_and_removed(self):
        _, payload = await self._login()
        token = payload["token"]
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

        async with self.db._connect(write=True) as conn:
            await conn.execute(
                "UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?",
                (int(time.time()) - 1, token_hash),
            )
            await conn.commit()

        self.assertFalse(await self.db.is_admin_session_valid(token))
        async with self.db._connect() as conn:
            cursor = await conn.execute(
                "SELECT COUNT(*) FROM admin_sessions WHERE token_hash = ?",
                (token_hash,),
            )
            self.assertEqual((await cursor.fetchone())[0], 0)

    async def test_logout_revokes_only_the_current_session(self):
        _, first_payload = await self._login()
        _, second_payload = await self._login()

        await admin.admin_logout(Response(), first_payload["token"])

        self.assertFalse(await self.db.is_admin_session_valid(first_payload["token"]))
        self.assertTrue(await self.db.is_admin_session_valid(second_payload["token"]))

    async def test_password_change_revokes_all_sessions(self):
        _, first_payload = await self._login()
        _, second_payload = await self._login()

        await admin.change_password(
            admin.ChangePasswordRequest(
                old_password="session-password",
                new_password="new-session-password",
            ),
            first_payload["token"],
        )

        self.assertFalse(await self.db.is_admin_session_valid(first_payload["token"]))
        self.assertFalse(await self.db.is_admin_session_valid(second_payload["token"]))

    def test_manage_page_initializes_without_removed_local_storage_auth_helper(self):
        manage_html = (
            Path(__file__).resolve().parents[1] / "static" / "manage.html"
        ).read_text()

        self.assertNotIn("checkAuth()", manage_html)
        self.assertIn(
            "DOMContentLoaded',()=>{refreshTokens();loadATAutoRefreshConfig()",
            manage_html,
        )


if __name__ == "__main__":
    unittest.main()
