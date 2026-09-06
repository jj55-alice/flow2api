"""Runtime Korean localization for the upstream-owned static admin pages.

The upstream project keeps its UI in large, self-contained HTML files.  Editing
those files for every translated label makes routine upstream rebases conflict
heavy, so the local fork injects one isolated locale layer at response time.
"""

from pathlib import Path
from typing import Mapping

from fastapi.responses import FileResponse, HTMLResponse, Response


_LOCALE_SCRIPT_PATH = Path(__file__).parent.parent.parent / "static" / "i18n" / "ko.js"


def localized_static_page_response(
    file_path: Path,
    *,
    headers: Mapping[str, str],
) -> Response:
    """Return an upstream HTML page with the Korean locale layer injected.

    A missing locale asset must never take the admin UI down; in that case the
    untouched upstream page is served as a safe fallback.
    """

    try:
        html = file_path.read_text(encoding="utf-8")
        locale_script = _LOCALE_SCRIPT_PATH.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return FileResponse(str(file_path), headers=dict(headers))

    marker = "<!-- flow2api-ko-locale -->"
    if marker not in html:
        injected = f"{marker}<script>\n{locale_script}\n</script>"
        if "</head>" in html:
            html = html.replace("</head>", f"{injected}\n</head>", 1)
        else:
            html = f"{injected}\n{html}"

    html = html.replace('lang="zh-CN"', 'lang="ko"', 1)
    return HTMLResponse(content=html, headers=dict(headers))
