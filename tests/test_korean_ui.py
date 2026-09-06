from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.responses import FileResponse, HTMLResponse

from src.core import korean_ui


class KoreanUITests(unittest.TestCase):
    def test_localized_page_injects_locale_without_editing_source(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            page = Path(tmp_dir) / "page.html"
            original = '<!doctype html><html lang="zh-CN"><head><title>登录 - Flow2API</title></head><body>登录</body></html>'
            page.write_text(original, encoding="utf-8")

            response = korean_ui.localized_static_page_response(
                page,
                headers={"Cache-Control": "no-store"},
            )

            self.assertIsInstance(response, HTMLResponse)
            body = response.body.decode("utf-8")
            self.assertIn('<html lang="ko">', body)
            self.assertIn("<!-- flow2api-ko-locale -->", body)
            self.assertIn("window.Flow2APIKorean", body)
            self.assertEqual(page.read_text(encoding="utf-8"), original)
            self.assertEqual(response.headers["cache-control"], "no-store")

    def test_localized_page_falls_back_when_locale_asset_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            page = Path(tmp_dir) / "page.html"
            page.write_text("<html><body>upstream</body></html>", encoding="utf-8")

            with patch.object(korean_ui, "_LOCALE_SCRIPT_PATH", Path(tmp_dir) / "missing.js"):
                response = korean_ui.localized_static_page_response(page, headers={})

            self.assertIsInstance(response, FileResponse)


if __name__ == "__main__":
    unittest.main()
