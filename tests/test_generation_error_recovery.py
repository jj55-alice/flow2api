import json
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


class FlowUiDiagnosticsTests(unittest.TestCase):
    def test_image_ui_requires_the_fixed_extension_version(self):
        from src.services.browser_captcha_extension import ExtensionCaptchaService

        with self.assertRaises(ExtensionCaptchaError) as caught:
            ExtensionCaptchaService._require_image_ui_version("1.3.20")
        self.assertEqual(caught.exception.code, "extension_reload_required")
        with self.assertRaises(ExtensionCaptchaError):
            ExtensionCaptchaService._require_image_ui_version("1.3.23")
        ExtensionCaptchaService._require_image_ui_version("1.3.24")

    def test_missing_project_has_a_specific_recovery_code(self):
        from src.services.browser_captcha_extension import ExtensionCaptchaService

        service = ExtensionCaptchaService(None)
        response = json.dumps({
            "error": {
                "message": "Timed out; UI: " + json.dumps({
                    "dialogs": [],
                    "buttons": [],
                    "projectUnavailable": True,
                }),
            },
        })
        with self.assertRaises(ExtensionCaptchaError) as caught:
            service._check_flow_ui_result("google-h", response)

        self.assertEqual(caught.exception.code, "extension_project_unavailable")
        self.assertNotIn("google-h", service._video_ui_blocked_routes)

    def test_onboarding_blocks_the_route_without_accepting_it(self):
        from src.services.browser_captcha_extension import ExtensionCaptchaService

        service = ExtensionCaptchaService(None)
        response = json.dumps({
            "error": {
                "message": "Timed out; UI: " + json.dumps({
                    "dialogs": [],
                    "buttons": ["동의함", "나중에"],
                    "projectUnavailable": False,
                }),
            },
        })
        with self.assertRaises(ExtensionCaptchaError) as caught:
            service._check_flow_ui_result("google-h", response)

        self.assertEqual(caught.exception.code, "extension_user_action_required")
        self.assertIn("google-h", service._video_ui_blocked_routes)

    def test_generic_image_agent_failure_is_retryable_on_another_route(self):
        from src.services.browser_captcha_extension import ExtensionCaptchaService

        service = ExtensionCaptchaService(None)
        response = json.dumps({
            "error": {
                "message": (
                    "Flow agent reported that it could not generate the image; UI: "
                    + json.dumps({
                        "dialogs": [],
                        "buttons": ["thumb_up", "thumb_down"],
                        "projectUnavailable": False,
                    })
                ),
            },
        })

        with self.assertRaises(ExtensionCaptchaError) as caught:
            service._check_flow_ui_result("google-h", response)

        self.assertEqual(caught.exception.code, "flow_image_agent_reported_failure")
        self.assertEqual(caught.exception.http_status, 502)


class ImageAccountFailoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_project_preparation_failure_switches_image_account(self):
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
        load_balancer = SimpleNamespace(
            select_token=AsyncMock(side_effect=[first, second]),
            record_extension_transport_failure=AsyncMock(),
            release_pending=AsyncMock(),
            record_captcha_success=AsyncMock(),
            record_extension_transport_success=AsyncMock(),
        )
        token_manager = SimpleNamespace(
            ensure_valid_token=AsyncMock(side_effect=[first, second]),
            ensure_project_exists=AsyncMock(side_effect=[
                ValueError("Failed to prepare project pool: HTTP Error 401"),
                "project-2",
            ]),
            record_usage=AsyncMock(),
            record_success=AsyncMock(),
        )
        flow_client = SimpleNamespace(
            clear_request_fingerprint=MagicMock(),
            prefill_remote_browser_pool=AsyncMock(),
        )
        handler = object.__new__(GenerationHandler)
        handler.flow_client = flow_client
        handler.load_balancer = load_balancer
        handler.token_manager = token_manager
        handler._update_request_log_progress = AsyncMock()
        handler._log_request = AsyncMock(return_value=None)

        async def complete_image(*args, **kwargs):
            kwargs["generation_result"]["success"] = True
            yield {"ok": True}

        handler._handle_image_generation = complete_image

        captcha_config = config._config.setdefault("captcha", {})
        original_captcha = dict(captcha_config)
        captcha_config["captcha_method"] = "extension"
        captcha_config["extension_transport_generation_retries"] = 3
        try:
            chunks = [
                chunk
                async for chunk in handler.handle_generation(
                    "gemini-3.1-flash-image-three-four",
                    "test prompt",
                )
            ]
        finally:
            captcha_config.clear()
            captcha_config.update(original_captcha)

        self.assertTrue(chunks)
        self.assertEqual(
            [call.args[0] for call in token_manager.ensure_project_exists.await_args_list],
            [1, 2],
        )
        load_balancer.record_extension_transport_failure.assert_awaited_once_with(1)
        load_balancer.release_pending.assert_any_await(
            1,
            for_image_generation=True,
        )
        self.assertEqual(
            load_balancer.select_token.await_args_list[1].kwargs["exclude_token_ids"],
            {1},
        )

    async def test_missing_flow_project_resets_pool_and_retries_same_account(self):
        token = SimpleNamespace(
            id=9,
            at="at-9",
            email="recovery@example.invalid",
            user_paygate_tier="PAYGATE_TIER_NOT_PAID",
            image_concurrency=-1,
        )
        missing = ExtensionCaptchaError(
            "Flow project is unavailable",
            code="extension_project_unavailable",
        )
        flow_client = SimpleNamespace(
            generate_image=AsyncMock(side_effect=[
                missing,
                (
                    {
                        "media": [{
                            "name": "media-9",
                            "image": {
                                "generatedImage": {
                                    "fifeUrl": "https://example.com/generated.jpg",
                                },
                            },
                        }],
                    },
                    "session-9",
                    {"generation_attempts": [{}]},
                ),
            ]),
            prefill_remote_browser_pool=AsyncMock(),
            clear_request_fingerprint=MagicMock(),
        )
        token_manager = SimpleNamespace(
            reset_project_pool=AsyncMock(return_value=4),
            ensure_project_exists=AsyncMock(return_value="project-new"),
        )
        load_balancer = SimpleNamespace(
            record_extension_transport_failure=AsyncMock(),
            release_pending=AsyncMock(),
            select_token=AsyncMock(),
        )
        handler = object.__new__(GenerationHandler)
        handler.flow_client = flow_client
        handler.load_balancer = load_balancer
        handler.token_manager = token_manager
        handler._update_request_log_progress = AsyncMock()

        generation_result = handler._create_generation_result()
        response_state = handler._create_response_state()
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
                    token,
                    "project-stale",
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
                )
            ]
        finally:
            cache_config.clear()
            cache_config.update(original_cache)
            captcha_config.clear()
            captcha_config.update(original_captcha)

        self.assertTrue(generation_result["success"])
        self.assertTrue(chunks)
        token_manager.reset_project_pool.assert_awaited_once_with(9)
        token_manager.ensure_project_exists.assert_awaited_once_with(9)
        self.assertEqual(
            [call.kwargs["project_id"] for call in flow_client.generate_image.await_args_list],
            ["project-stale", "project-new"],
        )
        load_balancer.select_token.assert_not_awaited()

    async def test_timed_out_route_skips_replacement_with_broken_project(self):
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
        third = SimpleNamespace(
            id=3,
            at="at-3",
            email="third@example.com",
            user_paygate_tier="PAYGATE_TIER_NOT_PAID",
            image_concurrency=-1,
        )
        timed_out = ExtensionCaptchaError(
            "Flow browser submit hard timeout",
            code="extension_flow_timeout",
        )
        flow_client = SimpleNamespace(
            generate_image=AsyncMock(side_effect=[
                timed_out,
                (
                    {
                        "media": [{
                            "name": "media-3",
                            "image": {
                                "generatedImage": {
                                    "fifeUrl": "https://example.com/generated.jpg",
                                },
                            },
                        }],
                    },
                    "session-3",
                    {"generation_attempts": [{}]},
                ),
            ]),
            prefill_remote_browser_pool=AsyncMock(),
            clear_request_fingerprint=MagicMock(),
        )
        load_balancer = SimpleNamespace(
            record_extension_transport_failure=AsyncMock(),
            release_pending=AsyncMock(),
            select_token=AsyncMock(side_effect=[second, third]),
        )
        token_manager = SimpleNamespace(
            ensure_project_exists=AsyncMock(side_effect=[
                ValueError("Failed to prepare project pool: HTTP Error 401"),
                "project-3",
            ]),
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
        self.assertIs(pending_state["token"], third)
        self.assertEqual(flow_client.generate_image.await_count, 2)
        self.assertEqual(
            [call.kwargs["token_id"] for call in flow_client.generate_image.await_args_list],
            [1, 3],
        )
        self.assertEqual(
            [call.args[0] for call in token_manager.ensure_project_exists.await_args_list],
            [2, 3],
        )
        self.assertEqual(
            [call.args[0] for call in load_balancer.record_extension_transport_failure.await_args_list],
            [1, 2],
        )
        self.assertEqual(
            [call.args[0] for call in load_balancer.release_pending.await_args_list],
            [1, 2],
        )
        self.assertEqual(
            [call.kwargs["exclude_token_ids"] for call in load_balancer.select_token.await_args_list],
            [{1}, {1, 2}],
        )
        self.assertTrue(all(
            call.kwargs["enforce_concurrency_filter"]
            for call in load_balancer.select_token.await_args_list
        ))
        flow_client.prefill_remote_browser_pool.assert_awaited_once_with(
            project_id="project-3",
            action="IMAGE_GENERATION",
            token_id=3,
        )


if __name__ == "__main__":
    unittest.main()
