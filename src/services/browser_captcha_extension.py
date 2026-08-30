import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from fastapi import WebSocket

from ..core.config import config
from ..core.logger import debug_logger


@dataclass
class ExtensionConnection:
    websocket: WebSocket
    route_key: str = ""
    client_label: str = ""
    fingerprint: Dict[str, str] = field(default_factory=dict)
    connected_at: float = field(default_factory=time.time)


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

    @classmethod
    async def get_instance(cls, db=None) -> "ExtensionCaptchaService":
        if cls._instance is None:
            async with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(db=db)
        elif db is not None and cls._instance.db is None:
            cls._instance.db = db
        return cls._instance

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        conn = ExtensionConnection(
            websocket=websocket,
            route_key=(websocket.query_params.get("route_key") or "").strip(),
            client_label=(websocket.query_params.get("client_label") or "").strip(),
        )
        self.active_connections.append(conn)
        debug_logger.log_info(
            f"[Extension Captcha] Client connected. Total: {len(self.active_connections)}, "
            f"route_key={conn.route_key or '-'}, label={conn.client_label or '-'}"
        )

    def disconnect(self, websocket: WebSocket):
        for conn in list(self.active_connections):
            if conn.websocket is websocket:
                self.active_connections.remove(conn)
                debug_logger.log_info(
                    f"[Extension Captcha] Client disconnected. Total: {len(self.active_connections)}, "
                    f"route_key={conn.route_key or '-'}, label={conn.client_label or '-'}"
                )
                return

    def _find_connection(self, websocket: WebSocket) -> Optional[ExtensionConnection]:
        for conn in self.active_connections:
            if conn.websocket is websocket:
                return conn
        return None

    def _select_connection(self, route_key: str) -> Optional[ExtensionConnection]:
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

    def _describe_routes(self) -> str:
        labels = []
        for conn in self.active_connections:
            label = conn.route_key or "(empty)"
            if conn.client_label:
                label = f"{label}:{conn.client_label}"
            labels.append(label)
        return ", ".join(labels)

    def describe_routes(self) -> str:
        return self._describe_routes()

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
                    registered_fingerprint = self._normalize_fingerprint(payload.get("fingerprint"))
                    if registered_fingerprint:
                        conn.fingerprint = registered_fingerprint
                    debug_logger.log_info(
                        f"[Extension Captcha] Client registered route_key={conn.route_key or '-'}, "
                        f"label={conn.client_label or '-'}, "
                        f"fingerprint={'yes' if conn.fingerprint.get('user_agent') else 'no'}"
                    )
                    await self._send_ack(
                        websocket,
                        {
                            "type": "register_ack",
                            "route_key": conn.route_key,
                            "client_label": conn.client_label,
                        },
                    )
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
            raise RuntimeError("Chrome Extension not connected or Google Labs tab not open.")

        route_key = await self._resolve_route_key(token_id)
        conn = self._select_connection(route_key)
        if conn is None:
            available = self._describe_routes() or "none"
            raise RuntimeError(
                f"No Chrome Extension connection matches token_id={token_id} route_key='{route_key}'. "
                f"Available route keys: {available}"
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
                raise RuntimeError(
                    f"Chrome Extension disconnected while waiting for route_key='{route_key}'. "
                    f"Available route keys: {available}"
                )

            return await self._dispatch_token_request(
                conn=conn,
                route_key=route_key,
                route_guard_key=route_guard_key,
                project_id=project_id,
                action=action,
                timeout=timeout,
            )

    async def get_session_token(self, token_id: Optional[int], timeout: int = 15) -> Optional[str]:
        """Read the current labs.google session cookie from the mapped profile."""
        if not self.active_connections:
            raise RuntimeError("Chrome Extension not connected")

        route_key = await self._resolve_route_key(token_id)
        conn = self._select_connection(route_key)
        if conn is None:
            raise RuntimeError(
                f"No Chrome Extension connection matches token_id={token_id} route_key='{route_key}'"
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
                }))
                result = await asyncio.wait_for(future, timeout=timeout)
                if result.get("status") == "success":
                    return str(result.get("session_token") or "").strip() or None
                debug_logger.log_warning(
                    f"[Extension Captcha] Session cookie request failed: {result.get('error')}"
                )
                return None
            except asyncio.TimeoutError:
                debug_logger.log_warning("[Extension Captcha] Session cookie request timed out")
                return None
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
                    return None
                fingerprint = self._normalize_fingerprint(result.get("fingerprint"))
                if fingerprint:
                    conn.fingerprint = fingerprint
                elif conn.fingerprint:
                    fingerprint = dict(conn.fingerprint)
                return {
                    "token": token,
                    "fingerprint": fingerprint,
                }

            error_msg = result.get("error")
            debug_logger.log_error(f"[Extension Captcha] Error from extension: {error_msg}")
            return None

        except asyncio.TimeoutError:
            debug_logger.log_error(f"[Extension Captcha] Timeout waiting for token (req_id: {req_id})")
            return None
        except Exception as e:
            debug_logger.log_error(f"[Extension Captcha] Communication error: {e}")
            return None
        finally:
            self.pending_requests.pop(req_id, None)

    async def report_flow_error(self, project_id: str, error_reason: str, error_message: str = ""):
        _ = project_id, error_message
        debug_logger.log_warning(f"[Extension Captcha] Flow error reported (ignoring): {error_reason}")
