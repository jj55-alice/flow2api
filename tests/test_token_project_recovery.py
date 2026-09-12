import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from src.services.token_manager import TokenManager


class TokenProjectRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_reset_project_pool_removes_only_target_token_mappings(self):
        projects = [
            SimpleNamespace(project_id="stale-1"),
            SimpleNamespace(project_id="stale-2"),
        ]
        db = SimpleNamespace(
            get_token=AsyncMock(return_value=SimpleNamespace(id=9)),
            get_projects_by_token=AsyncMock(return_value=projects),
            delete_project=AsyncMock(),
            update_token=AsyncMock(),
        )
        manager = object.__new__(TokenManager)
        manager.db = db
        manager._project_locks = {}
        manager._project_lock_guard = asyncio.Lock()

        removed = await manager.reset_project_pool(9)

        self.assertEqual(removed, 2)
        self.assertEqual(
            [call.args[0] for call in db.delete_project.await_args_list],
            ["stale-1", "stale-2"],
        )
        db.update_token.assert_awaited_once_with(
            9,
            current_project_id=None,
            current_project_name=None,
        )


if __name__ == "__main__":
    unittest.main()
