import asyncio
import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from src.core.config import config
from src.core.database import Database
from src.core.models import Token
from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionConnection
from src.services.flow_client import FlowClient
from src.services.load_balancer import LoadBalancer


class _TokenManagerStub:
    def __init__(self, tokens):
        self.tokens = tokens

    async def get_active_tokens(self):
        return self.tokens

    async def get_token(self, token_id):
        return next((token for token in self.tokens if token.id == token_id), None)

    async def update_captcha_circuit(
        self,
        token_id,
        *,
        failure_count,
        cooldown_until,
        circuit_opened_at,
        last_failure_at,
    ):
        token = await self.get_token(token_id)
        token.captcha_failure_count = failure_count
        token.captcha_cooldown_until = cooldown_until
        token.captcha_circuit_opened_at = circuit_opened_at
        token.captcha_last_failure_at = last_failure_at

    async def reset_captcha_circuit(self, token_id):
        await self.update_captcha_circuit(
            token_id,
            failure_count=0,
            cooldown_until=None,
            circuit_opened_at=None,
            last_failure_at=None,
        )

    def needs_at_refresh(self, token):
        return False

    async def ensure_valid_token(self, token):
        return token


class _RouteDbStub:
    async def get_token(self, token_id):
        return SimpleNamespace(extension_route_key=f"google-{token_id}")


class _ImmediateExtensionSocket:
    def __init__(self, service):
        self.service = service
        self.dispatch_times = []

    async def send_text(self, data):
        payload = json.loads(data)
        if payload.get("type") != "get_token":
            if payload.get("type") == "get_session_cookie":
                await self.service.handle_message(
                    self,
                    json.dumps({
                        "type": "session_cookie_result",
                        "req_id": payload["req_id"],
                        "status": "success",
                        "session_token": "labs-session-token",
                    }),
                )
            return
        self.dispatch_times.append(time.monotonic())
        await self.service.handle_message(
            self,
            json.dumps({
                "type": "token_result",
                "req_id": payload["req_id"],
                "status": "success",
                "token": f"captcha-{len(self.dispatch_times)}",
                "fingerprint": {
                    "user_agent": "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36",
                    "accept_language": "ko-KR,ko;q=0.9",
                    "sec_ch_ua_platform": '"macOS"',
                },
            }),
        )


class CaptchaCircuitBreakerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.captcha_config = config._config.setdefault("captcha", {})
        self.original = dict(self.captcha_config)
        self.captcha_config.update({
            "captcha_method": "browser",
            "captcha_failure_threshold": 1,
            "captcha_failure_cooldown_seconds": 60,
        })

    async def asyncTearDown(self):
        self.captcha_config.clear()
        self.captcha_config.update(self.original)

    async def test_cooling_token_is_skipped_and_success_resets_it(self):
        first = Token(id=1, st="st-1", at="at-1", email="first@example.com")
        second = Token(id=2, st="st-2", at="at-2", email="second@example.com")
        manager = _TokenManagerStub([first, second])
        balancer = LoadBalancer(manager)

        remaining = await balancer.record_captcha_failure(
            first.id,
            Exception("PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed"),
        )
        self.assertGreater(remaining, 0)

        selected = await balancer.select_token(for_image_generation=True)
        self.assertEqual(selected.id, second.id)

        first.captcha_cooldown_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        await balancer.record_captcha_success(first.id, attempt_started_at=time.time())
        manager.tokens = [first]
        selected = await balancer.select_token(for_image_generation=True)
        self.assertEqual(selected.id, first.id)

    async def test_probe_failures_use_adaptive_cooldown_and_success_resets_level(self):
        token = Token(id=1, st="st-1", at="at-1", email="first@example.com")
        balancer = LoadBalancer(_TokenManagerStub([token]))
        error = Exception("PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed")

        first_remaining = await balancer.record_captcha_failure(token.id, error)
        duplicate_remaining = await balancer.record_captcha_failure(token.id, error)
        self.assertEqual(token.captcha_failure_count, 1)

        token.captcha_cooldown_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        second_remaining = await balancer.record_captcha_failure(token.id, error)
        token.captcha_cooldown_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        third_remaining = await balancer.record_captcha_failure(token.id, error)
        token.captcha_cooldown_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        fourth_remaining = await balancer.record_captcha_failure(token.id, error)

        self.assertGreaterEqual(first_remaining, 59)
        self.assertGreaterEqual(duplicate_remaining, 59)
        self.assertGreaterEqual(second_remaining, 179)
        self.assertGreaterEqual(third_remaining, 719)
        self.assertGreaterEqual(fourth_remaining, 719)

        token.captcha_cooldown_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        await balancer.record_captcha_success(token.id, attempt_started_at=time.time())
        reset_remaining = await balancer.record_captcha_failure(token.id, error)
        self.assertGreaterEqual(reset_remaining, 59)
        self.assertLess(reset_remaining, 61)

    async def test_circuit_survives_new_load_balancer_instance(self):
        first = Token(id=1, st="st-1", at="at-1", email="first@example.com")
        second = Token(id=2, st="st-2", at="at-2", email="second@example.com")
        manager = _TokenManagerStub([first, second])

        await LoadBalancer(manager).record_captcha_failure(first.id, Exception("captcha"))
        selected = await LoadBalancer(manager).select_token(for_image_generation=True)

        self.assertEqual(selected.id, second.id)

    async def test_stale_inflight_results_do_not_escalate_or_reset_open_circuit(self):
        token = Token(id=1, st="st-1", at="at-1", email="first@example.com")
        balancer = LoadBalancer(_TokenManagerStub([token]))
        stale_attempt_started_at = time.time() - 10

        await balancer.record_captcha_failure(
            token.id,
            Exception("captcha"),
            attempt_started_at=stale_attempt_started_at,
        )
        await balancer.record_captcha_failure(
            token.id,
            Exception("captcha"),
            attempt_started_at=stale_attempt_started_at,
        )
        reset = await balancer.record_captcha_success(
            token.id,
            attempt_started_at=stale_attempt_started_at,
        )

        self.assertEqual(token.captcha_failure_count, 1)
        self.assertFalse(reset)


class CaptchaCircuitMigrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self.db = Database(db_path=f"{self._temp_dir.name}/flow.db")
        await self.db.init_db()

    async def asyncTearDown(self):
        self._temp_dir.cleanup()

    async def test_upgrade_backfills_recent_unrecovered_captcha_failure(self):
        async with self.db._connect(write=True) as conn:
            await conn.execute("PRAGMA foreign_keys = OFF")
            await conn.execute("DROP TABLE tokens")
            await conn.execute("""
                CREATE TABLE tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    st TEXT UNIQUE NOT NULL,
                    email TEXT NOT NULL,
                    is_active BOOLEAN DEFAULT 1
                )
            """)
            await conn.execute(
                "INSERT INTO tokens (id, st, email, is_active) VALUES (1, 'st-1', 'one@example.com', 1)"
            )
            await conn.execute("""
                INSERT INTO request_logs (
                    token_id, operation, response_body, status_code,
                    duration, status_text, progress, created_at, updated_at
                ) VALUES (
                    1, 'generate_image',
                    '{"error":"PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed"}',
                    500, 1.0, 'failed', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """)
            await conn.commit()

        await self.db.check_and_migrate_db({
            "captcha": {"captcha_failure_cooldown_seconds": 7200}
        })

        async with self.db._connect() as conn:
            cursor = await conn.execute("""
                SELECT captcha_failure_count,
                       captcha_cooldown_until > CURRENT_TIMESTAMP,
                       captcha_circuit_opened_at IS NOT NULL,
                       captcha_last_failure_at IS NOT NULL
                FROM tokens WHERE id = 1
            """)
            row = await cursor.fetchone()

        self.assertEqual(row, (1, 1, 1, 1))


class ExtensionRouteThrottleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.captcha_config = config._config.setdefault("captcha", {})
        self.original = dict(self.captcha_config)
        self.captcha_config["extension_route_min_interval_seconds"] = 0.05
        self.captcha_config["extension_global_min_interval_seconds"] = 0.0
        self.captcha_config["captcha_method"] = "extension"

    async def asyncTearDown(self):
        self.captcha_config.clear()
        self.captcha_config.update(self.original)

    async def test_same_route_requests_are_serialized_and_spaced(self):
        service = ExtensionCaptchaService(db=_RouteDbStub())
        websocket = _ImmediateExtensionSocket(service)
        service.active_connections.append(
            ExtensionConnection(websocket=websocket, route_key="google-1")
        )

        results = await asyncio.gather(
            service.get_token("project-a", token_id=1),
            service.get_token("project-a", token_id=1),
        )

        self.assertEqual(results, ["captcha-1", "captcha-2"])
        self.assertGreaterEqual(websocket.dispatch_times[1] - websocket.dispatch_times[0], 0.045)

    async def test_session_cookie_can_be_read_for_mapped_profile(self):
        service = ExtensionCaptchaService(db=_RouteDbStub())
        websocket = _ImmediateExtensionSocket(service)
        service.active_connections.append(
            ExtensionConnection(websocket=websocket, route_key="google-1")
        )

        session_token = await service.get_session_token(token_id=1)

        self.assertEqual(session_token, "labs-session-token")

    async def test_token_bundle_preserves_browser_fingerprint(self):
        service = ExtensionCaptchaService(db=_RouteDbStub())
        websocket = _ImmediateExtensionSocket(service)
        service.active_connections.append(
            ExtensionConnection(websocket=websocket, route_key="google-1")
        )

        bundle = await service.get_token_bundle("project-a", token_id=1)

        self.assertEqual(bundle["token"], "captcha-1")
        self.assertIn("Chrome/150", bundle["fingerprint"]["user_agent"])
        self.assertEqual(bundle["fingerprint"]["sec_ch_ua_platform"], '"macOS"')

    async def test_disabled_browser_route_is_logically_disconnected(self):
        service = ExtensionCaptchaService(db=_RouteDbStub())
        websocket = _ImmediateExtensionSocket(service)
        service.active_connections.append(
            ExtensionConnection(websocket=websocket, route_key="google-1")
        )
        service.configure_route_states([
            SimpleNamespace(extension_route_key="google-1", browser_enabled=False),
        ])

        self.assertFalse(service.has_connection_for_route_key("google-1"))
        with self.assertRaisesRegex(RuntimeError, "No Chrome Extension connection"):
            await service.get_token_bundle("project-a", token_id=1)

        await service.set_route_enabled("google-1", True)
        self.assertTrue(service.has_connection_for_route_key("google-1"))

    async def test_load_balancer_skips_manually_paused_browser(self):
        paused = Token(
            id=1,
            st="st-1",
            at="at-1",
            email="paused@example.com",
            browser_enabled=False,
        )
        enabled = Token(
            id=2,
            st="st-2",
            at="at-2",
            email="enabled@example.com",
            browser_enabled=True,
        )
        selected = await LoadBalancer(_TokenManagerStub([paused, enabled])).select_token()

        self.assertEqual(selected.id, 2)


class RecaptchaRetryBudgetTests(unittest.TestCase):
    def setUp(self):
        self.captcha_config = config._config.setdefault("captcha", {})
        self.original = dict(self.captcha_config)
        self.captcha_config["browser_captcha_generation_retries"] = 1

    def tearDown(self):
        self.captcha_config.clear()
        self.captcha_config.update(self.original)

    def test_recaptcha_budget_does_not_inherit_larger_generic_retry_count(self):
        client = FlowClient(proxy_manager=None)
        resolved = client._resolve_generation_retry_budget(
            5,
            "PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed",
        )
        self.assertEqual(resolved, 1)


if __name__ == "__main__":
    unittest.main()
