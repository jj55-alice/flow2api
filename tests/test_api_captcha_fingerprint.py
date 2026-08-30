"""Verify API-mode captcha injects solution user_agent into the request fingerprint.

背景: YesCaptcha / CapMonster / EzCaptcha / CapSolver 返回的 solution 包含
gRecaptchaResponse 与 userAgent。Google reCAPTCHA V3 评估会校验 token 与
提交请求的 User-Agent 一致性, 因此调用 Flow API 时必须沿用打码服务返回的
UA, 否则服务端判定 UNUSUAL_ACTIVITY 并返回 reCAPTCHA evaluation failed。
"""

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
    def __init__(self, fingerprint):
        self.fingerprint = fingerprint

    async def get_token_bundle(self, *args, **kwargs):
        return {
            "token": "extension-token",
            "fingerprint": self.fingerprint,
        }


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


if __name__ == "__main__":
    unittest.main()
