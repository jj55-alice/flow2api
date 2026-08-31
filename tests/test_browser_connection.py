import tempfile
import unittest
from pathlib import Path

from src.core.database import Database
from src.core.models import Token


class BrowserConnectionPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_switch_and_pending_sync_are_persisted(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            db = Database(str(Path(tmp_dir) / "flow.db"))
            await db.init_db()
            token_id = await db.add_token(Token(
                st="session-1",
                at="access-1",
                email="account@example.com",
                extension_route_key="google-1",
            ))

            created = await db.get_token(token_id)
            self.assertTrue(created.browser_enabled)
            self.assertFalse(created.browser_session_sync_pending)

            await db.update_token(
                token_id,
                browser_enabled=False,
                browser_session_sync_pending=True,
            )
            updated = await db.get_token_by_extension_route_key("google-1")

            self.assertFalse(updated.browser_enabled)
            self.assertTrue(updated.browser_session_sync_pending)


if __name__ == "__main__":
    unittest.main()
