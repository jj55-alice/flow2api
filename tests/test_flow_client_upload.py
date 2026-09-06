import unittest
from unittest.mock import AsyncMock, patch

from src.services.flow_client import FlowClient


JPEG_BYTES = b"\xff\xd8\xff" + b"0" * 16


class FlowClientUploadImageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.config_patcher = patch("src.services.flow_client.config")
        self.config = self.config_patcher.start()
        self.addCleanup(self.config_patcher.stop)
        self.config.flow_labs_base_url = "https://labs.google/fx/api"
        self.config.flow_api_base_url = "https://aisandbox-pa.googleapis.com/v1"
        self.config.flow_timeout = 120
        self.config.flow_max_retries = 1
        self.config.captcha_method = "yescaptcha"

    async def test_project_scoped_upload_uses_new_endpoint_with_project_id(self):
        client = FlowClient(proxy_manager=None)

        request_calls = []

        async def fake_make_request(**kwargs):
            request_calls.append(kwargs)
            return {
                "media": {
                    "name": "new-media-id",
                }
            }

        client._make_request = AsyncMock(side_effect=fake_make_request)

        media_id = await client.upload_image(
            at="test-at",
            image_bytes=JPEG_BYTES,
            aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
            project_id="project-123",
        )

        self.assertEqual(media_id, "new-media-id")
        self.assertEqual(len(request_calls), 1)
        self.assertTrue(request_calls[0]["url"].endswith("/flow/uploadImage"))
        self.assertEqual(
            request_calls[0]["json_data"]["clientContext"]["projectId"],
            "project-123",
        )
        self.assertIn("sessionId", request_calls[0]["json_data"]["clientContext"])
        self.assertNotIn(
            "recaptchaContext",
            request_calls[0]["json_data"]["clientContext"],
        )

    async def test_project_scoped_upload_accepts_media_list_response(self):
        client = FlowClient(proxy_manager=None)

        request_calls = []

        async def fake_make_request(**kwargs):
            request_calls.append(kwargs)
            return {
                "media": [
                    {
                        "name": "new-media-id",
                        "projectId": "project-123",
                    }
                ]
            }

        client._make_request = AsyncMock(side_effect=fake_make_request)

        media_id = await client.upload_image(
            at="test-at",
            image_bytes=JPEG_BYTES,
            aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
            project_id="project-123",
        )

        self.assertEqual(media_id, "new-media-id")
        self.assertEqual(len(request_calls), 1)
        self.assertTrue(request_calls[0]["url"].endswith("/flow/uploadImage"))

    async def test_project_scoped_upload_does_not_fallback_to_legacy_endpoint(self):
        client = FlowClient(proxy_manager=None)

        request_calls = []

        async def fake_make_request(**kwargs):
            request_calls.append(kwargs)
            if kwargs["url"].endswith("/flow/uploadImage"):
                raise RuntimeError("HTTP 500: upstream failed")
            self.fail("带 project_id 的上传不应回退到 legacy 接口")

        client._make_request = AsyncMock(side_effect=fake_make_request)

        with self.assertRaisesRegex(RuntimeError, "legacy :uploadUserImage fallback is disabled"):
            await client.upload_image(
                at="test-at",
                image_bytes=JPEG_BYTES,
                aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
                project_id="project-123",
            )

        self.assertEqual(len(request_calls), 1)
        self.assertEqual(
            request_calls[0]["json_data"]["clientContext"]["projectId"],
            "project-123",
        )

    async def test_upload_without_project_id_keeps_legacy_fallback(self):
        client = FlowClient(proxy_manager=None)

        request_calls = []

        async def fake_make_request(**kwargs):
            request_calls.append(kwargs)
            if kwargs["url"].endswith("/flow/uploadImage"):
                raise RuntimeError("HTTP 500: upstream failed")
            if kwargs["url"].endswith(":uploadUserImage"):
                return {
                    "mediaGenerationId": {
                        "mediaGenerationId": "legacy-media-id",
                    }
                }
            self.fail(f"Unexpected url: {kwargs['url']}")

        client._make_request = AsyncMock(side_effect=fake_make_request)

        media_id = await client.upload_image(
            at="test-at",
            image_bytes=JPEG_BYTES,
            aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
            project_id=None,
        )

        self.assertEqual(media_id, "legacy-media-id")
        self.assertEqual(len(request_calls), 2)
        self.assertNotIn(
            "projectId",
            request_calls[1]["json_data"]["clientContext"],
        )

    async def test_extension_upload_runs_in_mapped_profile_with_upload_action(self):
        client = FlowClient(proxy_manager=None)
        service = AsyncMock()
        service.submit_flow_request.return_value = {
            "status": 200,
            "text": '{"media":{"name":"extension-media-id"}}',
            "headers": {"content-type": "application/json"},
            "fingerprint": {"user_agent": "Chrome/151"},
        }
        client._make_request = AsyncMock()
        self.config.captcha_method = "extension"

        with patch(
            "src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance",
            new=AsyncMock(return_value=service),
        ):
            media_id = await client.upload_image(
                at="test-at",
                image_bytes=JPEG_BYTES,
                project_id="project-123",
                token_id=17,
            )

        self.assertEqual(media_id, "extension-media-id")
        client._make_request.assert_not_awaited()
        submit = service.submit_flow_request.await_args.kwargs
        self.assertEqual(submit["action"], "UPLOAD_IMAGE")
        self.assertEqual(submit["project_id"], "project-123")
        self.assertEqual(submit["token_id"], 17)
        self.assertEqual(
            submit["json_data"]["clientContext"]["recaptchaContext"]["token"],
            "__FLOW2API_EXTENSION_BROWSER_SUBMIT__",
        )
        self.assertEqual(client.get_request_fingerprint()["user_agent"], "Chrome/151")

    async def test_extension_generation_carries_uploaded_file_name_for_ui_picker(self):
        client = FlowClient(proxy_manager=None)
        client._remember_uploaded_media_file_name(
            "uploaded-media-id",
            "flow2api_upload_123.jpg",
        )
        client._make_image_generation_request = AsyncMock(return_value={"media": []})
        self.config.captcha_method = "extension"

        await client.generate_image(
            at="test-at",
            project_id="project-123",
            prompt="use my reference",
            model_name="NARWHAL",
            aspect_ratio="IMAGE_ASPECT_RATIO_SQUARE",
            image_inputs=[{
                "name": "uploaded-media-id",
                "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE",
            }],
            token_id=17,
        )

        submitted = client._make_image_generation_request.await_args.kwargs["json_data"]
        self.assertEqual(
            submitted["__flow2apiUiContext"]["inputFileNames"],
            ["flow2api_upload_123.jpg"],
        )


if __name__ == "__main__":
    unittest.main()
