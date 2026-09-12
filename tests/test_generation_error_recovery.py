import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from src.core.config import config
from src.services.browser_captcha_extension import ExtensionCaptchaError
from src.services.flow_client import FlowClient
from src.services.generation_handler import GenerationHandler


class GenerationErrorRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.handler = object.__new__(GenerationHandler)
        self.client = FlowClient(proxy_manager=None)

    def test_policy_rejection_does_not_count_as_account_error_or_retry(self):
        error = "PUBLIC_ERROR_UNSAFE_GENERATION: Request contains an invalid argument."

        self.assertFalse(self.handler._should_count_token_error(error))
        self.assertIsNone(self.client._get_retry_reason(error))

    def test_missing_browser_response_retries_without_counting_account_error(self):
        error = "Flow browser submit returned no HTTP response"

        self.assertFalse(self.handler._should_count_token_error(error))
        self.assertEqual(self.client._get_retry_reason(error), "网络/TLS错误")

    def test_authentication_failure_still_counts_as_account_error(self):
        self.assertTrue(
            self.handler._should_count_token_error("HTTP 401 UNAUTHENTICATED")
        )


class ImageAccountFailoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_stalled_extension_route_switches_to_another_account_once(self):
        first = SimpleNamespace(
            id=1,
            at="at-1",
            email="first@example.com",
            user_paygate_tier="PAYGATE_TIER_NOT_PAID",
            image_concurrency=-1,
        )
        second = SimpleNamespace(
            id=2,
            at="at-2",
            email="second@example.com",
            user_paygate_tier="PAYGATE_TIER_NOT_PAID",
            image_concurrency=-1,
        )
        stalled = ExtensionCaptchaError(
            "Flow browser progress stalled",
            code="extension_flow_stalled",
        )
        flow_client = SimpleNamespace(
            generate_image=AsyncMock(side_effect=[
                stalled,
                (
                    {
                        "media": [{
                            "name": "media-2",
                            "image": {
                                "generatedImage": {
                                    "fifeUrl": "https://example.com/generated.jpg",
                                },
                            },
                        }],
                    },
                    "session-2",
                    {"generation_attempts": [{}]},
                ),
            ]),
            prefill_remote_browser_pool=AsyncMock(),
            clear_request_fingerprint=MagicMock(),
        )
        load_balancer = SimpleNamespace(
            record_extension_transport_failure=AsyncMock(),
            release_pending=AsyncMock(),
            select_token=AsyncMock(return_value=second),
        )
        token_manager = SimpleNamespace(
            ensure_project_exists=AsyncMock(return_value="project-2"),
        )
        handler = object.__new__(GenerationHandler)
        handler.flow_client = flow_client
        handler.load_balancer = load_balancer
        handler.token_manager = token_manager
        handler._update_request_log_progress = AsyncMock()

        generation_result = handler._create_generation_result()
        response_state = handler._create_response_state()
        pending_state = {
            "active": True,
            "token": first,
            "attempt_started_at": 1.0,
        }

        cache_config = config._config.setdefault("cache", {})
        captcha_config = config._config.setdefault("captcha", {})
        original_cache = dict(cache_config)
        original_captcha = dict(captcha_config)
        cache_config["enabled"] = False
        captcha_config["captcha_method"] = "extension"
        captcha_config["extension_transport_generation_retries"] = 2
        try:
            chunks = [
                chunk
                async for chunk in handler._handle_image_generation(
                    first,
                    "project-1",
                    {
                        "model_name": "NARWHAL",
                        "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
                    },
                    "gemini-3.1-flash-image-landscape",
                    "test prompt",
                    None,
                    False,
                    generation_result=generation_result,
                    response_state=response_state,
                    pending_token_state=pending_state,
                )
            ]
        finally:
            cache_config.clear()
            cache_config.update(original_cache)
            captcha_config.clear()
            captcha_config.update(original_captcha)

        self.assertTrue(generation_result["success"])
        self.assertTrue(chunks)
        self.assertIs(pending_state["token"], second)
        self.assertEqual(flow_client.generate_image.await_count, 2)
        self.assertEqual(
            [call.kwargs["token_id"] for call in flow_client.generate_image.await_args_list],
            [1, 2],
        )
        load_balancer.record_extension_transport_failure.assert_awaited_once_with(1)
        load_balancer.release_pending.assert_awaited_once_with(
            1,
            for_image_generation=True,
        )
        self.assertEqual(load_balancer.select_token.await_args.kwargs["exclude_token_ids"], {1})
        flow_client.prefill_remote_browser_pool.assert_awaited_once_with(
            project_id="project-2",
            action="IMAGE_GENERATION",
            token_id=2,
        )


if __name__ == "__main__":
    unittest.main()
