import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.services.browser_captcha_extension import (
    ExtensionCaptchaError,
    ExtensionCaptchaService,
    ExtensionConnection,
)
from src.services.generation_handler import GenerationHandler
from src.services.flow_client import FlowClient
from src.api import admin
from src.api.routes import _get_error_status_code


class _FakeDB:
    def __init__(self, route_key=""):
        self.route_key = route_key

    async def get_token(self, _token_id):
        return SimpleNamespace(extension_route_key=self.route_key)


class _FakeWebSocket:
    def __init__(self, service, response):
        self.service = service
        self.response = response

    async def send_text(self, payload):
        request = json.loads(payload)
        response = {"req_id": request["req_id"], **self.response}
        asyncio.get_running_loop().call_soon(
            lambda: asyncio.create_task(self.service.handle_message(self, json.dumps(response)))
        )


class _FakeTokenManager:
    def __init__(self, tokens):
        self.tokens = tokens

    async def get_active_tokens(self):
        return self.tokens


class ExtensionCaptchaServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_connection_has_actionable_code(self):
        service = ExtensionCaptchaService(db=_FakeDB("9223"))

        with self.assertRaises(ExtensionCaptchaError) as raised:
            await service.get_token("project", token_id=1)

        self.assertEqual(raised.exception.code, "extension_not_connected")

    async def test_route_mismatch_has_actionable_code(self):
        service = ExtensionCaptchaService(db=_FakeDB("9223"))
        other = _FakeWebSocket(service, {"status": "success", "token": "unused"})
        service.active_connections.append(ExtensionConnection(other, route_key="9333"))

        with self.assertRaises(ExtensionCaptchaError) as raised:
            await service.get_token("project", token_id=1)

        self.assertEqual(raised.exception.code, "extension_route_mismatch")
        self.assertIn("9333", str(raised.exception))

    async def test_extension_error_is_not_flattened_to_none(self):
        service = ExtensionCaptchaService(db=_FakeDB("9223"))
        websocket = _FakeWebSocket(
            service,
            {"status": "error", "error": "grecaptcha.enterprise is not ready"},
        )
        service.active_connections.append(ExtensionConnection(websocket, route_key="9223"))

        with self.assertRaises(ExtensionCaptchaError) as raised:
            await service.get_token("project", token_id=1)

        self.assertEqual(raised.exception.code, "extension_token_failed")
        self.assertIn("not ready", str(raised.exception))

    async def test_empty_success_token_is_rejected(self):
        service = ExtensionCaptchaService(db=_FakeDB("9223"))
        websocket = _FakeWebSocket(service, {"status": "success", "token": "  "})
        service.active_connections.append(ExtensionConnection(websocket, route_key="9223"))

        with self.assertRaises(ExtensionCaptchaError) as raised:
            await service.get_token("project", token_id=1)

        self.assertEqual(raised.exception.code, "extension_empty_token")

    async def test_solution_preserves_browser_fingerprint(self):
        service = ExtensionCaptchaService(db=_FakeDB("9223"))
        websocket = _FakeWebSocket(service, {
            "status": "success",
            "token": "captcha-token",
            "user_agent": "Mozilla/5.0 Chrome/147.0.0.0",
            "accept_language": "ko-KR,ko,en-US,en",
        })
        service.active_connections.append(ExtensionConnection(websocket, route_key="9223"))

        solution = await service.get_token_bundle("project", token_id=1)

        self.assertEqual(solution["token"], "captcha-token")
        self.assertIn("Chrome/147", solution["user_agent"])
        self.assertEqual(solution["accept_language"], "ko-KR,ko,en-US,en")


class CaptchaErrorResponseTests(unittest.TestCase):
    def setUp(self):
        self.handler = GenerationHandler.__new__(GenerationHandler)

    def test_extension_failure_maps_to_503(self):
        error = ExtensionCaptchaError("route mismatch", code="extension_route_mismatch")
        self.assertFalse(self.handler._should_count_token_error(error))
        self.assertEqual(
            self.handler._classify_generation_error(error),
            (503, "extension_route_mismatch"),
        )
        payload = json.loads(self.handler._create_error_response(
            str(error), status_code=503, error_code=error.code
        ))
        self.assertEqual(_get_error_status_code(payload), 503)
        self.assertEqual(payload["error"]["code"], "extension_route_mismatch")

    def test_upstream_evaluation_failure_maps_to_502(self):
        self.assertEqual(
            self.handler._classify_generation_error(
                RuntimeError("PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed")
            ),
            (502, "captcha_evaluation_failed"),
        )

    def test_upstream_traffic_failure_maps_to_429(self):
        self.assertEqual(
            self.handler._classify_generation_error(
                RuntimeError("PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC: reCAPTCHA evaluation failed")
            ),
            (429, "captcha_rate_limited"),
        )


class ExtensionFingerprintTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous_instance = ExtensionCaptchaService._instance

    async def asyncTearDown(self):
        ExtensionCaptchaService._instance = self.previous_instance

    async def test_flow_client_reuses_extension_browser_user_agent(self):
        database = _FakeDB("9223")
        service = ExtensionCaptchaService(db=database)
        websocket = _FakeWebSocket(service, {
            "status": "success",
            "token": "captcha-token",
            "user_agent": "Mozilla/5.0 Chrome/147.0.0.0",
            "accept_language": "ko-KR,ko,en-US,en",
        })
        service.active_connections.append(ExtensionConnection(websocket, route_key="9223"))
        ExtensionCaptchaService._instance = service
        flow = FlowClient(proxy_manager=SimpleNamespace(), db=database)

        with patch("src.services.flow_client.config") as runtime_config:
            runtime_config.captcha_method = "extension"
            token, browser_id = await flow._get_recaptcha_token(
                "project-1", action="IMAGE_GENERATION", token_id=1
            )

        self.assertEqual(token, "captcha-token")
        self.assertIsNone(browser_id)
        fingerprint = flow.get_request_fingerprint()
        self.assertIn("Chrome/147", fingerprint["user_agent"])
        self.assertEqual(fingerprint["accept_language"], "ko-KR,ko,en-US,en")
        self.assertIn("project-1", fingerprint["referer"])

    async def test_old_extension_without_fingerprint_is_rejected(self):
        database = _FakeDB("9223")
        service = ExtensionCaptchaService(db=database)
        websocket = _FakeWebSocket(service, {
            "status": "success",
            "token": "captcha-token",
        })
        service.active_connections.append(ExtensionConnection(websocket, route_key="9223"))
        ExtensionCaptchaService._instance = service
        flow = FlowClient(proxy_manager=SimpleNamespace(), db=database)

        with patch("src.services.flow_client.config") as runtime_config:
            runtime_config.captcha_method = "extension"
            with self.assertRaises(ExtensionCaptchaError) as raised:
                await flow._get_recaptcha_token(
                    "project-1", action="IMAGE_GENERATION", token_id=1
                )

        self.assertEqual(raised.exception.code, "extension_fingerprint_missing")


class CaptchaAdminUiTests(unittest.TestCase):
    def test_extension_method_and_route_controls_are_present(self):
        html = Path("static/manage.html").read_text(encoding="utf-8")
        self.assertIn('<option value="extension">', html)
        self.assertIn('id="extensionCaptchaStatus"', html)
        self.assertIn('id="addTokenExtensionRouteKey"', html)
        self.assertIn('id="editTokenExtensionRouteKey"', html)
        self.assertIn("extension_route_key:extensionRouteKey", html)


class CaptchaAdminStatusTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous_instance = ExtensionCaptchaService._instance
        self.previous_db = admin.db
        self.previous_token_manager = admin.token_manager

    async def asyncTearDown(self):
        ExtensionCaptchaService._instance = self.previous_instance
        admin.db = self.previous_db
        admin.token_manager = self.previous_token_manager

    async def test_matching_online_route_is_reported_ready(self):
        database = _FakeDB("9223")
        service = ExtensionCaptchaService(db=database)
        websocket = _FakeWebSocket(service, {"status": "success", "token": "unused"})
        service.active_connections.append(ExtensionConnection(websocket, route_key="9223"))
        ExtensionCaptchaService._instance = service
        admin.db = database
        admin.token_manager = _FakeTokenManager([
            SimpleNamespace(id=1, extension_route_key="9223")
        ])

        status = await admin._get_extension_captcha_status()

        self.assertTrue(status["ready"])
        self.assertEqual(status["configured_routes"], ["9223"])
        self.assertEqual(status["tokens_without_route"], [])


if __name__ == "__main__":
    unittest.main()
