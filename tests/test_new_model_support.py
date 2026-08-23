import types
import unittest
from unittest.mock import AsyncMock

from src.core.model_resolver import resolve_model_name
from src.services.flow_client import FlowClient
from src.services.generation_handler import MODEL_CONFIG


class NewModelCatalogTests(unittest.TestCase):
    def test_nano_banana_2_lite_variants_use_harbor_seal(self):
        expected_aspects = {
            "gemini-3.1-flash-image-lite-landscape": "IMAGE_ASPECT_RATIO_LANDSCAPE",
            "gemini-3.1-flash-image-lite-portrait": "IMAGE_ASPECT_RATIO_PORTRAIT",
            "gemini-3.1-flash-image-lite-square": "IMAGE_ASPECT_RATIO_SQUARE",
            "gemini-3.1-flash-image-lite-four-three": "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE",
            "gemini-3.1-flash-image-lite-three-four": "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR",
        }

        for model_name, aspect_ratio in expected_aspects.items():
            with self.subTest(model_name=model_name):
                config = MODEL_CONFIG[model_name]
                self.assertEqual(config["type"], "image")
                self.assertEqual(config["model_name"], "HARBOR_SEAL")
                self.assertEqual(config["aspect_ratio"], aspect_ratio)

    def test_nano_banana_2_lite_alias_resolves_generation_config(self):
        request = types.SimpleNamespace(
            generationConfig=types.SimpleNamespace(aspectRatio="1:1")
        )

        resolved = resolve_model_name(
            "nano-banana-2-lite",
            request=request,
            model_config=MODEL_CONFIG,
        )

        self.assertEqual(resolved, "gemini-3.1-flash-image-lite-square")

    def test_omni_flash_alias_resolves_portrait_variant(self):
        request = types.SimpleNamespace(
            generationConfig=types.SimpleNamespace(aspectRatio="portrait")
        )

        resolved = resolve_model_name(
            "omni-flash",
            request=request,
            model_config=MODEL_CONFIG,
        )

        self.assertEqual(resolved, "omni-flash-portrait")

    def test_omni_flash_variants_use_captured_upstream_values(self):
        expected_aspects = {
            "omni-flash-landscape": "VIDEO_ASPECT_RATIO_LANDSCAPE",
            "omni-flash-portrait": "VIDEO_ASPECT_RATIO_PORTRAIT",
        }

        for model_name, aspect_ratio in expected_aspects.items():
            with self.subTest(model_name=model_name):
                config = MODEL_CONFIG[model_name]
                self.assertEqual(config["type"], "video")
                self.assertEqual(config["video_type"], "omni")
                self.assertEqual(config["model_key"], "abra_t2v_8s")
                self.assertEqual(config["aspect_ratio"], aspect_ratio)
                self.assertEqual(
                    config["output_resolution"],
                    "VIDEO_RESOLUTION_720P",
                )
                self.assertTrue(config["use_v2_model_config"])
                self.assertFalse(config["allow_tier_upgrade"])


class OmniFlashPayloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_text_generation_matches_captured_v2_payload(self):
        client = FlowClient(proxy_manager=None)
        client._acquire_video_launch_gate = AsyncMock(return_value=(True, None, None))
        client._release_video_launch_gate = AsyncMock()
        client._get_recaptcha_token = AsyncMock(
            return_value=("recaptcha-token", "browser-1")
        )
        client._notify_browser_captcha_request_finished = AsyncMock()
        captured = {}

        async def fake_make_request(method, url, json_data, use_at, at_token, **kwargs):
            captured["url"] = url
            captured["json_data"] = json_data
            return {"operations": [{"operation": {"name": "task-omni"}}]}

        client._make_request = AsyncMock(side_effect=fake_make_request)

        await client.generate_video_text(
            at="at-token",
            project_id="project-1",
            prompt="고양이",
            model_key="abra_t2v_8s",
            aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
            output_resolution="VIDEO_RESOLUTION_720P",
            use_v2_model_config=True,
            user_paygate_tier="PAYGATE_TIER_NOT_PAID",
        )

        payload = captured["json_data"]
        request = payload["requests"][0]
        self.assertTrue(payload["useV2ModelConfig"])
        self.assertEqual(request["videoModelKey"], "abra_t2v_8s")
        self.assertEqual(request["outputSpec"]["resolution"], "VIDEO_RESOLUTION_720P")
        self.assertEqual(
            request["textInput"]["structuredPrompt"]["parts"][0]["text"],
            "고양이",
        )
        self.assertEqual(
            payload["mediaGenerationContext"]["audioFailurePreference"],
            "BLOCK_SILENCED_VIDEOS",
        )


if __name__ == "__main__":
    unittest.main()
