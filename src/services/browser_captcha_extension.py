import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional
from urllib.parse import urlparse

from fastapi import WebSocket

from ..core.config import config
from ..core.logger import debug_logger


class ExtensionCaptchaError(RuntimeError):
    """Actionable extension-captcha failure that must not be flattened to None."""

    def __init__(self, message: str, code: str = "extension_captcha_failed"):
        super().__init__(message)
        self.code = code
        self.http_status = 503


@dataclass
class ExtensionConnection:
    websocket: WebSocket
    route_key: str = ""
    client_label: str = ""
    extension_version: str = ""
    fingerprint: Dict[str, str] = field(default_factory=dict)
    connected_at: float = field(default_factory=time.time)
    notified_route_key: str = ""


class ExtensionCaptchaService:
    _instance: Optional["ExtensionCaptchaService"] = None
    _lock = asyncio.Lock()

    def __init__(self, db=None):
        self.db = db
        self.active_connections: list[ExtensionConnection] = []
        self.pending_requests: dict[str, tuple[asyncio.Future, WebSocket]] = {}
        # A Chrome profile represents one Google account. Serialize requests
        # per route and space them out so a burst cannot open many hidden Flow
        # tabs for the same account at once.
        self._route_locks: dict[str, asyncio.Lock] = {}
        self._route_last_dispatch_at: dict[str, float] = {}
        self._global_dispatch_lock = asyncio.Lock()
        self._global_last_dispatch_at = 0.0
        self._disabled_route_keys: set[str] = set()
        self._route_connected_callback: Optional[Callable[[str], Awaitable[None]]] = None

    @classmethod
    async def get_instance(cls, db=None) -> "ExtensionCaptchaService":
        if cls._instance is None:
            async with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(db=db)
        elif db is not None and cls._instance.db is None:
            cls._instance.db = db
        return cls._instance

    async def connect(self, websocket: WebSocket) -> bool:
        await websocket.accept()
        conn = ExtensionConnection(
            websocket=websocket,
            route_key=(websocket.query_params.get("route_key") or "").strip(),
            client_label=(websocket.query_params.get("client_label") or "").strip(),
        )
        self.active_connections.append(conn)
        await self._replace_duplicate_route_connections(conn)
        debug_logger.log_info(
            f"[Extension Captcha] Client connected. Total: {len(self.active_connections)}, "
            f"route_key={conn.route_key or '-'}, label={conn.client_label or '-'}"
        )
        await self._send_connection_state(conn)
        if not self.is_route_enabled(conn.route_key):
            await self._close_connection(websocket)
            return False
        self._notify_route_connected(conn)
        return True

    def disconnect(self, websocket: WebSocket):
        for conn in list(self.active_connections):
            if conn.websocket is websocket:
                self.active_connections.remove(conn)
                debug_logger.log_info(
                    f"[Extension Captcha] Client disconnected. Total: {len(self.active_connections)}, "
                    f"route_key={conn.route_key or '-'}, label={conn.client_label or '-'}"
                )
                for req_id, (future, owner_websocket) in list(self.pending_requests.items()):
                    if owner_websocket is websocket:
                        self.pending_requests.pop(req_id, None)
                        if not future.done():
                            future.set_exception(RuntimeError("Chrome Extension disconnected"))
                return

    def _find_connection(self, websocket: WebSocket) -> Optional[ExtensionConnection]:
        for conn in self.active_connections:
            if conn.websocket is websocket:
                return conn
        return None

    async def _close_connection(self, websocket: WebSocket, *, code: int = 4001) -> None:
        try:
            await websocket.close(code=code)
        except Exception:
            # The extension may close immediately after receiving the state,
            # so cleanup must not depend on which side wins that race.
            pass
        finally:
            self.disconnect(websocket)

    async def _replace_duplicate_route_connections(self, current: ExtensionConnection) -> None:
        """Keep only the newest WebSocket for one Chrome/account route."""
        route_key = str(current.route_key or "").strip()
        if not route_key:
            return
        duplicates = [
            conn for conn in list(self.active_connections)
            if conn is not current and conn.route_key == route_key
        ]
        for duplicate in duplicates:
            debug_logger.log_warning(
                f"[Extension Captcha] Replacing duplicate connection for route_key={route_key}"
            )
            await self._close_connection(duplicate.websocket, code=4002)

    def _select_raw_connection(self, route_key: str) -> Optional[ExtensionConnection]:
        normalized_key = (route_key or "").strip()
        if normalized_key:
            for conn in self.active_connections:
                if conn.route_key == normalized_key:
                    return conn
            return None
        # Empty token routes are only allowed to use an empty extension route.
        # A keyed route such as "9223" belongs to a specific browser/account
        # and must never be borrowed by another token just because it is the
        # only extension online.
        for conn in self.active_connections:
            if not conn.route_key:
                return conn
        return None

    def _select_connection(self, route_key: str) -> Optional[ExtensionConnection]:
        normalized_key = (route_key or "").strip()
        if normalized_key and normalized_key in self._disabled_route_keys:
            return None
        return self._select_raw_connection(normalized_key)

    def configure_route_states(self, tokens: Iterable[Any]) -> None:
        """Load persisted manual browser switches before extensions reconnect."""
        self._disabled_route_keys = {
            str(getattr(token, "extension_route_key", "") or "").strip()
            for token in tokens
            if not bool(getattr(token, "browser_enabled", True))
            and str(getattr(token, "extension_route_key", "") or "").strip()
        }

    def set_route_connected_callback(
        self,
        callback: Optional[Callable[[str], Awaitable[None]]],
    ) -> None:
        self._route_connected_callback = callback

    def is_route_enabled(self, route_key: str) -> bool:
        normalized_key = str(route_key or "").strip()
        return not normalized_key or normalized_key not in self._disabled_route_keys

    async def set_route_enabled(self, route_key: str, enabled: bool) -> None:
        normalized_key = str(route_key or "").strip()
        if not normalized_key:
            return
        if enabled:
            self._disabled_route_keys.discard(normalized_key)
        else:
            self._disabled_route_keys.add(normalized_key)

        matching_connections = [
            conn for conn in list(self.active_connections)
            if conn.route_key == normalized_key
        ]
        for conn in matching_connections:
            await self._send_connection_state(conn)
            if enabled:
                self._notify_route_connected(conn, force=True)
            else:
                await self._close_connection(conn.websocket)

    async def _send_connection_state(self, conn: ExtensionConnection) -> None:
        await self._send_ack(
            conn.websocket,
            {
                "type": "connection_state",
                "route_key": conn.route_key,
                "enabled": self.is_route_enabled(conn.route_key),
            },
        )

    def _notify_route_connected(self, conn: ExtensionConnection, *, force: bool = False) -> None:
        route_key = str(conn.route_key or "").strip()
        callback = self._route_connected_callback
        if not route_key or callback is None or not self.is_route_enabled(route_key):
            return
        if not force and conn.notified_route_key == route_key:
            return
        conn.notified_route_key = route_key

        async def runner() -> None:
            try:
                await callback(route_key)
            except Exception as e:
                debug_logger.log_warning(
                    f"[Extension Captcha] Route connect callback failed for {route_key}: {e}"
                )

        asyncio.create_task(runner())

    def _describe_routes(self) -> str:
        labels = []
        for conn in self.active_connections:
            if not self.is_route_enabled(conn.route_key):
                continue
            label = conn.route_key or "(empty)"
            if conn.client_label:
                label = f"{label}:{conn.client_label}"
            labels.append(label)
        return ", ".join(labels)

    @staticmethod
    def _supports_browser_submit(extension_version: str) -> bool:
        try:
            version_parts = tuple(
                int(part) for part in str(extension_version or "").split(".")[:3]
            )
        except (TypeError, ValueError):
            return False
        return (version_parts + (0, 0, 0))[:3] >= (1, 2, 0)

    @staticmethod
    def _supports_browser_auth_capture(extension_version: str) -> bool:
        try:
            version_parts = tuple(
                int(part) for part in str(extension_version or "").split(".")[:3]
            )
        except (TypeError, ValueError):
            return False
        return (version_parts + (0, 0, 0))[:3] >= (1, 3, 0)

    @staticmethod
    def _supports_browser_cookie_auth(extension_version: str) -> bool:
        try:
            version_parts = tuple(
                int(part) for part in str(extension_version or "").split(".")[:3]
            )
        except (TypeError, ValueError):
            return False
        return (version_parts + (0, 0, 0))[:3] >= (1, 3, 3)

    @staticmethod
    def _supports_current_sid_auth(extension_version: str) -> bool:
        try:
            version_parts = tuple(
                int(part) for part in str(extension_version or "").split(".")[:3]
            )
        except (TypeError, ValueError):
            return False
        return (version_parts + (0, 0, 0))[:3] >= (1, 3, 8)

    @staticmethod
    def _supports_current_flow_ui(extension_version: str) -> bool:
        try:
            version_parts = tuple(
                int(part) for part in str(extension_version or "").split(".")[:3]
            )
        except (TypeError, ValueError):
            return False
        return (version_parts + (0, 0, 0))[:3] >= (1, 3, 11)

    @classmethod
    def _browser_auth_was_accepted(
        cls,
        extension_version: str,
        result: Dict[str, Any],
        browser_auth_status: int,
    ) -> bool:
        if bool(result.get("browser_auth_valid")):
            return True
        # The current Flow frontend no longer issues the old GET /v1/credits
        # shape. With its current public API key, an authenticated SID request
        # reaches request validation and returns 400; missing or rejected SID
        # authentication returns 401. Treat only that narrow transition as a
        # successful session-auth probe.
        return (
            cls._supports_current_sid_auth(extension_version)
            and bool(result.get("observed_api_key"))
            and browser_auth_status == 400
        )

    def describe_routes(self) -> str:
        return self._describe_routes()

    def get_runtime_status(self) -> Dict[str, Any]:
        """Return non-sensitive connection data for the admin configuration UI."""
        routes = [
            {
                "route_key": conn.route_key,
                "client_label": conn.client_label,
                "connected_at": conn.connected_at,
            }
            for conn in self.active_connections
        ]
        return {
            "connected": bool(routes),
            "connection_count": len(routes),
            "routes": routes,
        }

    @staticmethod
    def _normalize_fingerprint(value: Any) -> Dict[str, str]:
        if not isinstance(value, dict):
            return {}

        limits = {
            "user_agent": 512,
            "language": 64,
            "accept_language": 256,
            "sec_ch_ua": 512,
            "sec_ch_ua_mobile": 8,
            "sec_ch_ua_platform": 64,
        }
        normalized: Dict[str, str] = {}
        for key, limit in limits.items():
            raw = value.get(key)
            if raw is None:
                continue
            text = str(raw).strip()
            if text:
                normalized[key] = text[:limit]
        return normalized

    async def _send_ack(self, websocket: WebSocket, payload: Dict[str, Any]):
        try:
            await websocket.send_text(json.dumps(payload))
        except Exception:
            pass

    async def _resolve_route_key(self, token_id: Optional[int]) -> str:
        if not token_id or not self.db:
            return ""
        try:
            token = await self.db.get_token(token_id)
            if token and token.extension_route_key:
                return token.extension_route_key.strip()
        except Exception as e:
            debug_logger.log_warning(f"[Extension Captcha] Failed to resolve route key for token {token_id}: {e}")
        return ""

    def _has_connection_for_route_key(self, route_key: str) -> bool:
        return self._select_connection(route_key) is not None

    def has_connection_for_route_key(self, route_key: str) -> bool:
        """Expose a read-only route health check for admin/health reporting."""
        return self._has_connection_for_route_key(route_key)

    async def has_connection_for_token(self, token_id: Optional[int]) -> tuple[bool, str]:
        route_key = await self._resolve_route_key(token_id)
        return self._has_connection_for_route_key(route_key), route_key

    async def handle_message(self, websocket: WebSocket, data: str):
        try:
            payload = json.loads(data)
            message_type = payload.get("type")

            if message_type == "register":
                conn = self._find_connection(websocket)
                if conn:
                    conn.route_key = (payload.get("route_key") or conn.route_key or "").strip()
                    conn.client_label = (payload.get("client_label") or conn.client_label or "").strip()
                    conn.extension_version = str(
                        payload.get("extension_version") or conn.extension_version or ""
                    ).strip()[:32]
                    registered_fingerprint = self._normalize_fingerprint(payload.get("fingerprint"))
                    if registered_fingerprint:
                        conn.fingerprint = registered_fingerprint
                    await self._replace_duplicate_route_connections(conn)
                    debug_logger.log_info(
                        f"[Extension Captcha] Client registered route_key={conn.route_key or '-'}, "
                        f"label={conn.client_label or '-'}, "
                        f"version={conn.extension_version or 'legacy'}, "
                        f"fingerprint={'yes' if conn.fingerprint.get('user_agent') else 'no'}"
                    )
                    await self._send_ack(
                        websocket,
                        {
                            "type": "register_ack",
                            "route_key": conn.route_key,
                            "client_label": conn.client_label,
                            "extension_version": conn.extension_version,
                            "browser_enabled": self.is_route_enabled(conn.route_key),
                        },
                    )
                    await self._send_connection_state(conn)
                    if not self.is_route_enabled(conn.route_key):
                        await self._close_connection(websocket)
                        return
                    self._notify_route_connected(conn)
                return

            req_id = payload.get("req_id")
            if req_id and req_id in self.pending_requests:
                future, owner_websocket = self.pending_requests[req_id]
                if websocket is not owner_websocket:
                    debug_logger.log_warning(f"[Extension Captcha] Ignoring response from non-owner connection: {req_id}")
                    return
                if not future.done():
                    future.set_result(payload)
        except Exception as e:
            debug_logger.log_error(f"[Extension Captcha] Error handling message: {e}")

    async def get_token(
        self,
        project_id: str,
        action: str = "IMAGE_GENERATION",
        timeout: int = 20,
        token_id: Optional[int] = None,
    ) -> Optional[str]:
        bundle = await self.get_token_bundle(
            project_id,
            action,
            timeout=timeout,
            token_id=token_id,
        )
        if not isinstance(bundle, dict):
            return None
        return str(bundle.get("token") or "").strip() or None

    async def get_token_bundle(
        self,
        project_id: str,
        action: str = "IMAGE_GENERATION",
        timeout: int = 20,
        token_id: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        if not self.active_connections:
            debug_logger.log_warning("[Extension Captcha] No active extension connections available.")
            raise ExtensionCaptchaError(
                "Chrome extension is not connected. Open a Google Labs tab and check the extension connection URL/API key.",
                code="extension_not_connected",
            )

        route_key = await self._resolve_route_key(token_id)
        conn = self._select_connection(route_key)
        if conn is None:
            available = self._describe_routes() or "none"
            raise ExtensionCaptchaError(
                f"No Chrome Extension connection matches token_id={token_id} route_key='{route_key}'. "
                f"Available route keys: {available}",
                code="extension_route_mismatch",
            )
        route_guard_key = route_key or "(empty)"
        route_lock = self._route_locks.setdefault(route_guard_key, asyncio.Lock())

        async with route_lock:
            min_interval = config.extension_route_min_interval_seconds
            last_dispatch_at = self._route_last_dispatch_at.get(route_guard_key, 0.0)
            wait_seconds = max(0.0, min_interval - (time.monotonic() - last_dispatch_at))
            if wait_seconds > 0:
                debug_logger.log_info(
                    f"[Extension Captcha] Throttling route_key={route_key or '-'} "
                    f"for {wait_seconds:.2f}s"
                )
                await asyncio.sleep(wait_seconds)

            # The browser may have disconnected while this request waited for
            # the previous request on the same route to finish.
            conn = self._select_connection(route_key)
            if conn is None:
                available = self._describe_routes() or "none"
                raise ExtensionCaptchaError(
                    f"Chrome Extension disconnected while waiting for route_key='{route_key}'. "
                    f"Available route keys: {available}",
                    code="extension_disconnected",
                )

            return await self._dispatch_token_request(
                conn=conn,
                route_key=route_key,
                route_guard_key=route_guard_key,
                project_id=project_id,
                action=action,
                timeout=timeout,
            )

    async def get_browser_credentials(
        self,
        token_id: Optional[int],
        *,
        project_id: str = "",
        timeout: int = 20,
    ) -> Dict[str, Any]:
        """Read current Flow auth, with the legacy Labs session as a fallback."""
        if not self.active_connections:
            raise RuntimeError("Chrome Extension not connected")

        route_key = await self._resolve_route_key(token_id)
        conn = self._select_connection(route_key)
        if conn is None:
            raise RuntimeError(
                f"No Chrome Extension connection matches token_id={token_id} route_key='{route_key}'"
            )

        normalized_project_id = str(project_id or "").strip()
        if normalized_project_id and not self._supports_browser_auth_capture(conn.extension_version):
            try:
                # During a rolling extension update, preserve the old behavior:
                # opening Flow can still rotate the legacy Labs session cookie.
                await self.get_token_bundle(
                    normalized_project_id,
                    action="IMAGE_GENERATION",
                    timeout=min(30, max(10, timeout)),
                    token_id=token_id,
                )
            except Exception as e:
                debug_logger.log_warning(
                    f"[Extension Captcha] Legacy auth warmup failed for route_key={route_key}: {e}"
                )

        route_guard_key = route_key or "(empty)"
        route_lock = self._route_locks.setdefault(route_guard_key, asyncio.Lock())
        async with route_lock:
            conn = self._select_connection(route_key)
            if conn is None:
                raise RuntimeError(f"Chrome Extension disconnected for route_key='{route_key}'")
            req_id = f"req_{uuid.uuid4().hex}"
            future = asyncio.get_running_loop().create_future()
            self.pending_requests[req_id] = (future, conn.websocket)
            try:
                async with self._global_dispatch_lock:
                    global_interval = config.extension_global_min_interval_seconds
                    wait_seconds = max(
                        0.0,
                        global_interval - (time.monotonic() - self._global_last_dispatch_at),
                    )
                    if wait_seconds > 0:
                        await asyncio.sleep(wait_seconds)
                    self._global_last_dispatch_at = time.monotonic()

                await conn.websocket.send_text(json.dumps({
                    "type": "get_session_cookie",
                    "req_id": req_id,
                    "route_key": route_key,
                    "project_id": normalized_project_id,
                }))
                result = await asyncio.wait_for(future, timeout=timeout)
                if result.get("status") == "success":
                    session_token = str(result.get("session_token") or "").strip()
                    access_token = str(result.get("access_token") or "").strip()
                    if (
                        not access_token
                        or len(access_token) > 4096
                        or re.fullmatch(r"[A-Za-z0-9._~+/\-]+=*", access_token) is None
                    ):
                        access_token = ""
                    try:
                        browser_auth_status = int(result.get("browser_auth_status") or 0)
                    except (TypeError, ValueError):
                        browser_auth_status = 0
                    browser_auth_valid = self._browser_auth_was_accepted(
                        conn.extension_version,
                        result,
                        browser_auth_status,
                    )
                    try:
                        credits = int(result.get("credits")) if result.get("credits") is not None else None
                    except (TypeError, ValueError):
                        credits = None
                    user_paygate_tier = str(result.get("user_paygate_tier") or "").strip()[:128]
                    return {
                        "session_token": session_token,
                        "access_token": access_token,
                        "access_token_captured_at": result.get("access_token_captured_at"),
                        "extension_version": conn.extension_version,
                        "browser_auth_valid": browser_auth_valid,
                        "browser_auth_status": browser_auth_status,
                        "observed_auth_scheme": str(
                            result.get("observed_auth_scheme") or "none"
                        ).strip()[:32],
                        "observed_auth_at": result.get("observed_auth_at"),
                        "observed_api_key": bool(result.get("observed_api_key")),
                        "credits": credits,
                        "user_paygate_tier": user_paygate_tier,
                    }
                debug_logger.log_warning(
                    "[Extension Captcha] Browser credential request failed: "
                    f"{result.get('error')}; "
                    f"browser_status={result.get('browser_auth_status') or 0}, "
                    f"observed_scheme={str(result.get('observed_auth_scheme') or 'none')[:32]}"
                )
                try:
                    browser_auth_status = int(result.get("browser_auth_status") or 0)
                except (TypeError, ValueError):
                    browser_auth_status = 0
                return {
                    "extension_version": conn.extension_version,
                    "browser_auth_valid": self._browser_auth_was_accepted(
                        conn.extension_version,
                        result,
                        browser_auth_status,
                    ),
                    "browser_auth_status": browser_auth_status,
                    "observed_auth_scheme": str(
                        result.get("observed_auth_scheme") or "none"
                    ).strip()[:32],
                    "observed_auth_at": result.get("observed_auth_at"),
                    "observed_api_key": bool(result.get("observed_api_key")),
                    "browser_auth_error": str(
                        result.get("error") or "browser credential request failed"
                    ).strip()[:240],
                }
            except asyncio.TimeoutError:
                debug_logger.log_warning("[Extension Captcha] Browser credential request timed out")
                return {
                    "extension_version": conn.extension_version,
                    "browser_auth_valid": False,
                    "browser_auth_status": 0,
                    "observed_auth_scheme": "none",
                    "browser_auth_error": "browser credential request timed out",
                }
            finally:
                self.pending_requests.pop(req_id, None)

    async def get_session_token(self, token_id: Optional[int], timeout: int = 15) -> Optional[str]:
        """Read the legacy labs.google session cookie from the mapped profile."""
        credentials = await self.get_browser_credentials(token_id, timeout=timeout)
        return str(credentials.get("session_token") or "").strip() or None

    async def submit_flow_request(
        self,
        *,
        project_id: str,
        action: str,
        token_id: Optional[int],
        url: str,
        at_token: str,
        json_data: Dict[str, Any],
        timeout: int,
    ) -> Dict[str, Any]:
        """Solve and submit one Flow request inside the mapped Chrome profile.

        reCAPTCHA Enterprise evaluates more than the token itself. Keeping the
        solve and the API fetch in the same real Flow page preserves the Chrome
        network stack, cookies, origin, IP, and client hints as one context.
        """
        parsed_url = urlparse(str(url or ""))
        if (
            parsed_url.scheme.lower() != "https"
            or parsed_url.netloc.lower() != "aisandbox-pa.googleapis.com"
            or not parsed_url.path.startswith("/v1/")
        ):
            raise ValueError("Extension Flow submit only allows the Google Flow v1 API")
        if not isinstance(json_data, dict):
            raise ValueError("Extension Flow submit requires a JSON object body")

        route_key = await self._resolve_route_key(token_id)
        conn = self._select_connection(route_key)
        if conn is None:
            available = self._describe_routes() or "none"
            raise RuntimeError(
                f"No Chrome Extension connection matches token_id={token_id} route_key='{route_key}'. "
                f"Available route keys: {available}"
            )
        if not self._supports_browser_submit(conn.extension_version):
            raise RuntimeError(
                f"Chrome Extension route_key='{route_key}' must be reloaded "
                f"(connected version: {conn.extension_version or 'legacy'}, required: 1.2.0+)"
            )
        if (
            str(action or "").strip().upper() == "IMAGE_GENERATION"
            and not self._supports_current_flow_ui(conn.extension_version)
        ):
            raise ExtensionCaptchaError(
                f"Chrome Extension route_key='{route_key}' must be reloaded "
                f"(connected version: {conn.extension_version or 'legacy'}, required: 1.3.11+)",
                code="extension_reload_required",
            )
        if (
            not str(at_token or "").strip()
            and not self._supports_browser_cookie_auth(conn.extension_version)
        ):
            raise ValueError(
                "Extension Flow submit requires an access token or extension version 1.3.3+"
            )

        route_guard_key = route_key or "(empty)"
        route_lock = self._route_locks.setdefault(route_guard_key, asyncio.Lock())
        async with route_lock:
            min_interval = config.extension_route_min_interval_seconds
            last_dispatch_at = self._route_last_dispatch_at.get(route_guard_key, 0.0)
            wait_seconds = max(0.0, min_interval - (time.monotonic() - last_dispatch_at))
            if wait_seconds > 0:
                debug_logger.log_info(
                    f"[Extension Captcha] Throttling browser submit route_key={route_key or '-'} "
                    f"for {wait_seconds:.2f}s"
                )
                await asyncio.sleep(wait_seconds)

            conn = self._select_connection(route_key)
            if conn is None:
                raise RuntimeError(f"Chrome Extension disconnected for route_key='{route_key}'")
            if not self._supports_browser_submit(conn.extension_version):
                raise RuntimeError(
                    f"Chrome Extension route_key='{route_key}' must be reloaded "
                    f"(connected version: {conn.extension_version or 'legacy'}, required: 1.2.0+)"
                )
            if (
                str(action or "").strip().upper() == "IMAGE_GENERATION"
                and not self._supports_current_flow_ui(conn.extension_version)
            ):
                raise ExtensionCaptchaError(
                    f"Chrome Extension route_key='{route_key}' must be reloaded "
                    f"(connected version: {conn.extension_version or 'legacy'}, required: 1.3.11+)",
                    code="extension_reload_required",
                )

            req_id = f"req_{uuid.uuid4().hex}"
            future = asyncio.get_running_loop().create_future()
            self.pending_requests[req_id] = (future, conn.websocket)
            try:
                async with self._global_dispatch_lock:
                    global_interval = config.extension_global_min_interval_seconds
                    global_wait = max(
                        0.0,
                        global_interval - (time.monotonic() - self._global_last_dispatch_at),
                    )
                    if global_wait > 0:
                        await asyncio.sleep(global_wait)
                    self._global_last_dispatch_at = time.monotonic()

                request_data = {
                    "type": "submit_flow_request",
                    "req_id": req_id,
                    "route_key": route_key,
                    "project_id": str(project_id or "").strip(),
                    "action": str(action or "IMAGE_GENERATION").strip(),
                    "url": url,
                    "access_token": at_token,
                    "body": json_data,
                    "timeout_ms": max(5000, int(timeout * 1000)),
                }
                debug_logger.log_info(
                    f"[Extension Captcha] Dispatching browser Flow submit via "
                    f"route_key={route_key or '-'}, project_id={project_id}, action={action}"
                )
                self._route_last_dispatch_at[route_guard_key] = time.monotonic()
                await conn.websocket.send_text(json.dumps(request_data))
                result = await asyncio.wait_for(
                    future,
                    timeout=max(60, int(timeout) + 45),
                )

                if result.get("status") != "success":
                    error_message = str(result.get("error") or "Chrome extension Flow submit failed")
                    raise RuntimeError(error_message)

                fingerprint = self._normalize_fingerprint(result.get("fingerprint"))
                if fingerprint:
                    conn.fingerprint = fingerprint
                elif conn.fingerprint:
                    fingerprint = dict(conn.fingerprint)

                try:
                    http_status = int(result.get("http_status") or 0)
                except (TypeError, ValueError):
                    http_status = 0
                if http_status <= 0:
                    raise RuntimeError("Chrome extension returned an invalid Flow HTTP status")

                return {
                    "status": http_status,
                    "text": str(result.get("response_text") or ""),
                    "headers": result.get("response_headers") or {},
                    "fingerprint": fingerprint,
                }
            except asyncio.TimeoutError as exc:
                raise RuntimeError("Chrome extension Flow submit timed out") from exc
            finally:
                self.pending_requests.pop(req_id, None)

    async def _dispatch_token_request(
        self,
        *,
        conn: ExtensionConnection,
        route_key: str,
        route_guard_key: str,
        project_id: str,
        action: str,
        timeout: int,
    ) -> Optional[Dict[str, Any]]:
        """Dispatch one request while the caller holds the per-route lock."""

        req_id = f"req_{uuid.uuid4().hex}"
        future = asyncio.get_running_loop().create_future()
        self.pending_requests[req_id] = (future, conn.websocket)

        request_data = {
            "type": "get_token",
            "req_id": req_id,
            "action": action,
            "project_id": project_id,
            "route_key": route_key,
        }

        try:
            async with self._global_dispatch_lock:
                global_interval = config.extension_global_min_interval_seconds
                global_wait = max(
                    0.0,
                    global_interval - (time.monotonic() - self._global_last_dispatch_at),
                )
                if global_wait > 0:
                    debug_logger.log_info(
                        f"[Extension Captcha] Smoothing global dispatch for {global_wait:.2f}s"
                    )
                    await asyncio.sleep(global_wait)
                self._global_last_dispatch_at = time.monotonic()

            debug_logger.log_info(
                f"[Extension Captcha] Dispatching token request via route_key={route_key or '-'}, "
                f"label={conn.client_label or '-'}, project_id={project_id}, action={action}"
            )
            self._route_last_dispatch_at[route_guard_key] = time.monotonic()
            await conn.websocket.send_text(json.dumps(request_data))
            result = await asyncio.wait_for(future, timeout=timeout)

            if result.get("status") == "success":
                token = str(result.get("token") or "").strip()
                if not token:
                    raise ExtensionCaptchaError(
                        "Chrome extension reported success but returned an empty reCAPTCHA token.",
                        code="extension_empty_token",
                    )
                fingerprint = self._normalize_fingerprint(result.get("fingerprint"))
                if fingerprint:
                    conn.fingerprint = fingerprint
                elif conn.fingerprint:
                    fingerprint = dict(conn.fingerprint)
                return {
                    "token": token,
                    "fingerprint": fingerprint,
                }

            error_msg = str(result.get("error") or "unknown extension error").strip()
            debug_logger.log_error(f"[Extension Captcha] Error from extension: {error_msg}")
            raise ExtensionCaptchaError(
                f"Chrome extension failed to obtain a reCAPTCHA token: {error_msg}",
                code="extension_token_failed",
            )

        except asyncio.TimeoutError:
            debug_logger.log_error(f"[Extension Captcha] Timeout waiting for token (req_id: {req_id})")
            raise ExtensionCaptchaError(
                f"Timed out after {timeout}s waiting for the Chrome extension to return a reCAPTCHA token.",
                code="extension_token_timeout",
            )
        except ExtensionCaptchaError:
            raise
        except Exception as e:
            debug_logger.log_error(f"[Extension Captcha] Communication error: {e}")
            raise ExtensionCaptchaError(
                f"Chrome extension communication failed: {e}",
                code="extension_communication_failed",
            ) from e
        finally:
            self.pending_requests.pop(req_id, None)

    async def report_flow_error(self, project_id: str, error_reason: str, error_message: str = ""):
        _ = project_id, error_message
        debug_logger.log_warning(f"[Extension Captcha] Flow error reported (ignoring): {error_reason}")
