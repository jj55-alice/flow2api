import json
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class ExtensionReconnectContractTests(unittest.TestCase):
    def test_manifest_enables_alarm_wakeup(self):
        manifest = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text())

        self.assertIn("alarms", manifest["permissions"])
        self.assertGreaterEqual(
            tuple(int(part) for part in manifest["version"].split(".")),
            (1, 3, 13),
        )

    def test_manifest_allows_current_flow_host(self):
        manifest = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text())

        self.assertIn("https://flow.google.com/*", manifest["host_permissions"])
        self.assertIn("https://flow-content.google/*", manifest["host_permissions"])
        self.assertIn("https://lh3.google.com/*", manifest["host_permissions"])
        self.assertIn("https://*.googleusercontent.com/*", manifest["host_permissions"])
        self.assertIn(
            "https://flow.google.com/*",
            manifest["content_scripts"][0]["matches"],
        )

        background = (REPO_ROOT / "extension" / "background.js").read_text()
        self.assertIn('const FLOW_ROOT_URL = "https://flow.google.com"', background)
        self.assertIn('"https://flow.google.com/*"', background)
        self.assertIn("buildFlowPageUrl(projectId)", background)

    def test_current_flow_auth_is_captured_without_persisting_to_local_storage(self):
        manifest = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text())
        capture_script = (REPO_ROOT / "extension" / "auth_capture.js").read_text()
        bridge_script = (REPO_ROOT / "extension" / "auth_bridge.js").read_text()
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertTrue(any(
            script.get("world") == "MAIN"
            and script.get("run_at") == "document_start"
            and "auth_capture.js" in script.get("js", [])
            for script in manifest["content_scripts"]
        ))
        self.assertIn("aisandbox-pa.googleapis.com", capture_script)
        self.assertIn("flow_access_token", bridge_script)
        self.assertIn("chrome.storage.session", background)
        self.assertNotIn("chrome.storage.local.set", background)
        self.assertIn("webRequest", manifest["permissions"])
        self.assertIn(
            "https://aisandbox-pa.googleapis.com/*",
            manifest["host_permissions"],
        )
        self.assertIn("chrome.webRequest.onBeforeSendHeaders", background)
        self.assertIn('"requestHeaders", "extraHeaders"', background)
        self.assertIn("waitForRecentFlowRequestAuthorization", background)
        self.assertIn("flow_request_authorization", capture_script)
        self.assertIn("flow_request_authorization", bridge_script)
        self.assertIn("rememberFlowRequestAuthorization", background)
        self.assertIn("ignoredFlowAuthorizationTabIds", background)
        self.assertNotIn("ignoreFlowAuthorizationCaptureUntil", background)
        self.assertNotIn("[FLOW_REQUEST_AUTH_STORAGE_KEY]: null", background)
        self.assertIn('headers["x-goog-api-key"]', background)
        self.assertIn("readFlowPageAuthContext", background)
        self.assertIn("globals.K21R3e", background)
        self.assertIn('sha1Hex(`${value} ${origin}`)', background)
        self.assertNotIn('sha1Hex(`${timestamp} ${value} ${origin}`)', background)
        self.assertIn("chrome.storage.session", background)
        self.assertNotIn("startsWith(\"ya29.\")", background)
        self.assertNotIn("ya29\\.", capture_script)
        self.assertIn("OAuth bearer tokens are opaque", background)
        self.assertNotIn("accounts.google.com/o/oauth2", background)
        self.assertNotIn("FLOW_OAUTH_CLIENT_ID", background)

    def test_worker_reconnects_on_chrome_start_and_alarm(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertIn("chrome.runtime.onStartup.addListener", background)
        self.assertIn("chrome.alarms.onAlarm.addListener", background)
        self.assertIn("periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES", background)
        self.assertIn("if (connectPromise) return connectPromise", background)
        self.assertIn("handleGetSessionCookie(data, socket)", background)
        self.assertIn("sendSocketMessage(payload, socket = ws)", background)
        self.assertIn("connectWS();", background)

    def test_session_refresh_is_not_blocked_by_generation_queue(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertIn("let generationRequestQueue = Promise.resolve()", background)
        self.assertIn("let credentialRequestQueue = Promise.resolve()", background)
        self.assertIn(
            "credentialRequestQueue = credentialRequestQueue.then(() => handleGetSessionCookie(data, socket))",
            background,
        )
        self.assertIn(
            "generationRequestQueue = generationRequestQueue.then(() => handleSubmitFlowRequest(data, socket))",
            background,
        )

    def test_current_flow_image_generation_uses_ui_transport(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertIn("submitImageThroughCurrentFlowUi", background)
        self.assertIn("/flowMedia:batchGenerateImages$", background)
        self.assertIn(".settings-trigger-button", background)
        self.assertIn("Nano Banana 2 Lite", background)
        self.assertIn("flow-add-menu-popover-content", background)
        self.assertIn("inputUploads", background)
        self.assertIn("Flow native upload", background)
        self.assertIn("HTMLInputElement.prototype.click", background)
        self.assertIn('parsed.pathname.startsWith("/asb/")', background)
        self.assertIn('parsed.hostname === "flow-content.google"', background)
        self.assertIn('parsed.searchParams.get("name")', background)
        self.assertIn("embedCurrentFlowImages", background)
        self.assertIn("encodedImage", background)
        self.assertIn("Math.max(180000, timeoutMs)", background)
        self.assertIn("__flow2apiUiContext", background)
        self.assertIn("delete body.__flow2apiUiContext", background)
        self.assertIn("flow_google_ui", background)

    def test_current_flow_submit_reports_liveness_to_the_server(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()
        bridge = (REPO_ROOT / "extension" / "auth_bridge.js").read_text()

        self.assertIn('type: "flow_submit_progress"', background)
        self.assertIn("__FLOW2API_BROWSER_SUBMIT_PROGRESS__", background)
        self.assertIn("FLOW_PROGRESS_POLL_INTERVAL_MS", background)
        self.assertIn("FLOW_SUBMIT_HARD_TIMEOUT_PADDING_MS", background)
        self.assertIn('source: "flow2api-submit-progress"', background)
        self.assertIn("activeFlowSubmitBridges", background)
        self.assertIn("forwardFlowSubmitProgress(message, sender)", background)
        self.assertIn('type: "flow_submit_progress_bridge"', bridge)
        self.assertIn("event.source !== window", bridge)
        self.assertIn("event.origin !== location.origin", bridge)

    def test_user_action_tab_is_revealed_and_preserved(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertIn("flowUiNeedsUserAction(responseText)", background)
        self.assertIn("chrome.tabs.update(newTabId, { active: true })", background)
        self.assertIn("newTabId && !preserveTabForUserAction", background)
        self.assertIn("projectUnavailable", background)

    def test_native_upload_does_not_require_duplicate_detail_preview_image(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertNotIn("uploaded product image detail preview", background)


if __name__ == "__main__":
    unittest.main()
