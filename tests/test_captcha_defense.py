import asyncio
import json
import time
import unittest
from types import SimpleNamespace

from src.core.config import config
from src.core.models import Token
from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionConnection
from src.services.flow_client import FlowClient
from src.services.load_balancer import LoadBalancer


class _TokenManagerStub:
    def __init__(self, tokens):
        self.tokens = tokens

    async def get_active_tokens(self):
        return self.tokens

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

        await balancer.record_captcha_success(first.id)
        manager.tokens = [first]
        selected = await balancer.select_token(for_image_generation=True)
        self.assertEqual(selected.id, first.id)


class ExtensionRouteThrottleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.captcha_config = config._config.setdefault("captcha", {})
        self.original = dict(self.captcha_config)
        self.captcha_config["extension_route_min_interval_seconds"] = 0.05
        self.captcha_config["extension_global_min_interval_seconds"] = 0.0

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


class RecaptchaRetryBudgetTests(unittest.TestCase):
    def setUp(self):
        self.captcha_config = config._config.setdefault("captcha", {})
        self.original = dict(self.captcha_config)
        self.captcha_config["browser_captcha_generation_retries"] = 2

    def tearDown(self):
        self.captcha_config.clear()
        self.captcha_config.update(self.original)

    def test_recaptcha_budget_does_not_inherit_larger_generic_retry_count(self):
        client = FlowClient(proxy_manager=None)
        resolved = client._resolve_generation_retry_budget(
            5,
            "PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed",
        )
        self.assertEqual(resolved, 2)


if __name__ == "__main__":
    unittest.main()
