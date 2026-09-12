import unittest
from src.services.browser_captcha_extension import ExtensionCaptchaError, ExtensionCaptchaService


class ImageResultVersionTests(unittest.TestCase):
    def test_old_image_workers_are_blocked_before_dispatch(self):
        for version in ('', 'invalid', '1.3.20', '1.3.21'):
            with self.subTest(version=version):
                with self.assertRaises(ExtensionCaptchaError) as caught:
                    ExtensionCaptchaService._require_image_ui_version(version)
                self.assertEqual(caught.exception.code, 'extension_reload_required')

    def test_validating_workers_are_accepted(self):
        for version in ('1.3.22', '1.4.0', '2.0.0'):
            ExtensionCaptchaService._require_image_ui_version(version)

    def test_video_worker_requirement_is_unchanged(self):
        ExtensionCaptchaService._require_video_ui_version('1.3.21')
