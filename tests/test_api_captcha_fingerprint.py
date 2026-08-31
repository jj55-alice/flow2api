"""Verify API-mode captcha injects solution user_agent into the request fingerprint.

背景: YesCaptcha / CapMonster / EzCaptcha / CapSolver 返回的 solution 包含
gRecaptchaResponse 与 userAgent。Google reCAPTCHA V3 评估会校验 token 与
提交请求的 User-Agent 一致性, 因此调用 Flow API 时必须沿用打码服务返回的
UA, 否则服务端判定 UNUSUAL_ACTIVITY 并返回 reCAPTCHA evaluation failed。
"""

import json
import unittest
from unittest.mock import patch, AsyncMock, MagicMock

from src.services.flow_client import FlowClient


class _FakeProxyManager:
    async def get_request_proxy_url(self):
        return None


class _FakeAsyncSession:
    """模拟 curl_cffi 的 AsyncSession: createTask 返回 taskId, getTaskResult 返回 ready。"""

    def __init__(self):
        self._calls = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, *args, **kwargs):
        self._calls += 1
        response = MagicMock()
        if self._calls == 1:
            # createTask
            response.status_code = 200
            response.json.return_value = {
                "errorId": 0,
                "taskId": "tid-xyz",
            }
        else:
            # getTaskResult
            response.status_code = 200
            response.json.return_value = {
                "errorId": 0,
                "status": "ready",
                "solution": {
                    "gRecaptchaResponse": "token-abc",
                    "userAgent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/147.0.0.0 Safari/537.36"
                    ),
                },
            }
        return response


class _FakeExtensionService:
    def __init__(self, fingerprint, submit_response=None):
        self.fingerprint = fingerprint
        self.submit_response = submit_response or {
            "status": 200,
            "text": '{"mediaGenerationId":"browser-result"}',
            "headers": {"content-type": "application/json"},
            "fingerprint": fingerprint,
        }
        self.flow_submits = []

    async def get_token_bundle(self, *args, **kwargs):
        return {
            "token": "extension-token",
            "fingerprint": self.fingerprint,
        }

    async def submit_flow_request(self, **kwargs):
        self.flow_submits.append(kwargs)
        return self.submit_response


class ApiCaptchaFingerprintTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_captcha_returns_token_and_user_agent(self):
        """_get_api_captcha_token 必须返回 (token, userAgent) 元组。"""
        flow = FlowClient(proxy_manager=_FakeProxyManager())
        fake_session = _FakeAsyncSession()

        with patch("src.services.flow_client.AsyncSession", lambda *a, **kw: fake_session), \
             patch("src.services.flow_client.config") as cfg, \
             patch("asyncio.sleep", new=AsyncMock()):
            cfg.yescaptcha_api_key = "key"
            cfg.yescaptcha_base_url = "https://api.yescaptcha.com"
            cfg.yescaptcha_task_type = "RecaptchaV3TaskProxylessM1"
            cfg.debug_enabled = False

            result = await flow._get_api_captcha_token(
                method="yescaptcha",
                project_id="proj-1",
                action="IMAGE_GENERATION",
            )

        self.assertIsNotNone(result, "函数不应返回 None, 因为我们 mock 了 ready 状态")
        self.assertIsInstance(result, tuple, "_get_api_captcha_token 应返回 (token, userAgent) 元组")
        token, user_agent = result
        self.assertEqual(token, "token-abc")
        self.assertIn("Windows", user_agent, "userAgent 应当来自打码服务 solution, 包含 Windows")
        self.assertIn("Chrome/147", user_agent)

    async def test_extension_captcha_uses_browser_fingerprint(self):
        browser_user_agent = (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/150.0.0.0 Safari/537.36"
        )
        service = _FakeExtensionService({
            "user_agent": browser_user_agent,
            "accept_language": "ko-KR,ko;q=0.9",
            "sec_ch_ua_platform": '"macOS"',
        })
        flow = FlowClient(proxy_manager=None)

        with patch("src.services.flow_client.config") as cfg, \
             patch(
                 "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
                 new=AsyncMock(return_value=service),
             ):
            cfg.captcha_method = "extension"
            cfg.extension_fallback_user_agent = ""
            token, _ = await flow._get_recaptcha_token("project-1", token_id=1)

        fingerprint = flow.get_request_fingerprint()
        self.assertEqual(token, "extension-token")
        self.assertEqual(fingerprint["user_agent"], browser_user_agent)
        self.assertEqual(fingerprint["sec_ch_ua_platform"], '"macOS"')
        self.assertEqual(fingerprint["project_id"], "project-1")

    async def test_extension_captcha_uses_configured_fallback_for_legacy_worker(self):
        fallback_user_agent = (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/150.0.0.0 Safari/537.36"
        )
        service = _FakeExtensionService({})
        flow = FlowClient(proxy_manager=None)

        with patch("src.services.flow_client.config") as cfg, \
             patch(
                 "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
                 new=AsyncMock(return_value=service),
             ):
            cfg.captcha_method = "extension"
            cfg.extension_fallback_user_agent = fallback_user_agent
            token, _ = await flow._get_recaptcha_token("project-1", token_id=1)

        fingerprint = flow.get_request_fingerprint()
        self.assertEqual(token, "extension-token")
        self.assertEqual(fingerprint["user_agent"], fallback_user_agent)
        self.assertEqual(fingerprint["sec_ch_ua_platform"], '"macOS"')

    async def test_extension_image_request_is_submitted_inside_mapped_chrome(self):
        browser_fingerprint = {
            "user_agent": "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36",
            "accept_language": "ko-KR,ko;q=0.9",
        }
        service = _FakeExtensionService(browser_fingerprint)
        flow = FlowClient(proxy_manager=None)

        with patch("src.services.flow_client.config") as cfg, patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=service),
        ):
            cfg.captcha_method = "extension"
            cfg.flow_image_request_timeout = 30
            cfg.flow_image_timeout_retry_count = 0
            cfg.flow_image_timeout_retry_delay = 0
            cfg.flow_image_timeout_use_media_proxy_fallback = False
            cfg.flow_image_prefer_media_proxy = False
            result = await flow._make_image_generation_request(
                url=(
                    "https://aisandbox-pa.googleapis.com/v1/projects/project-1/"
                    "flowMedia:batchGenerateImages"
                ),
                json_data={"clientContext": {"projectId": "project-1"}},
                at="access-token",
                project_id="project-1",
                token_id=7,
            )

        self.assertEqual(result["mediaGenerationId"], "browser-result")
        self.assertEqual(len(service.flow_submits), 1)
        self.assertEqual(service.flow_submits[0]["token_id"], 7)
        self.assertEqual(service.flow_submits[0]["at_token"], "access-token")
        self.assertEqual(flow.get_request_fingerprint(), browser_fingerprint)

    async def test_extension_browser_submit_preserves_flow_recaptcha_error(self):
        service = _FakeExtensionService(
            {},
            submit_response={
                "status": 403,
                "text": json.dumps({
                    "error": {
                        "message": "reCAPTCHA evaluation failed",
                        "details": [{"reason": "PUBLIC_ERROR_UNUSUAL_ACTIVITY"}],
                    }
                }),
                "fingerprint": {},
            },
        )
        flow = FlowClient(proxy_manager=None)

        with patch("src.services.flow_client.config") as cfg, patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=service),
        ):
            cfg.captcha_method = "extension"
            cfg.flow_image_request_timeout = 30
            cfg.flow_image_timeout_retry_count = 0
            cfg.flow_image_timeout_retry_delay = 0
            cfg.flow_image_timeout_use_media_proxy_fallback = False
            cfg.flow_image_prefer_media_proxy = False
            with self.assertRaisesRegex(
                Exception,
                "PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed",
            ):
                await flow._make_image_generation_request(
                    url=(
                        "https://aisandbox-pa.googleapis.com/v1/projects/project-1/"
                        "flowMedia:batchGenerateImages"
                    ),
                    json_data={"clientContext": {"projectId": "project-1"}},
                    at="access-token",
                    project_id="project-1",
                    token_id=7,
                )

    async def test_extension_image_generation_skips_standalone_captcha_token(self):
        flow = FlowClient(proxy_manager=None)
        flow._get_recaptcha_token = AsyncMock(return_value=("should-not-be-used", None))
        flow._make_image_generation_request = AsyncMock(return_value={"ok": True})

        with patch("src.services.flow_client.config") as cfg:
            cfg.captcha_method = "extension"
            cfg.flow_max_retries = 1
            result, _session_id, trace = await flow.generate_image(
                at="access-token",
                project_id="project-1",
                prompt="test image",
                model_name="NARWHAL",
                aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
                token_id=7,
            )

        flow._get_recaptcha_token.assert_not_awaited()
        self.assertEqual(result, {"ok": True})
        submitted_body = flow._make_image_generation_request.await_args.kwargs["json_data"]
        self.assertEqual(
            submitted_body["clientContext"]["recaptchaContext"]["token"],
            "__FLOW2API_EXTENSION_BROWSER_SUBMIT__",
        )
        self.assertTrue(trace["generation_attempts"][0]["captcha_via_browser_submit"])


if __name__ == "__main__":
    unittest.main()
