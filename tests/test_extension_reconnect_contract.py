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
            (1, 2, 3),
        )

    def test_manifest_allows_current_flow_host(self):
        manifest = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text())

        self.assertIn("https://flow.google.com/*", manifest["host_permissions"])
        self.assertIn(
            "https://flow.google.com/*",
            manifest["content_scripts"][0]["matches"],
        )

        background = (REPO_ROOT / "extension" / "background.js").read_text()
        self.assertIn('const FLOW_ROOT_URL = "https://flow.google.com"', background)
        self.assertIn('"https://flow.google.com/*"', background)
        self.assertIn("buildFlowPageUrl(projectId)", background)

    def test_worker_reconnects_on_chrome_start_and_alarm(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertIn("chrome.runtime.onStartup.addListener", background)
        self.assertIn("chrome.alarms.onAlarm.addListener", background)
        self.assertIn("periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES", background)
        self.assertIn("if (connectPromise) return connectPromise", background)
        self.assertIn("handleGetSessionCookie(data, socket)", background)
        self.assertIn("sendSocketMessage(payload, socket = ws)", background)
        self.assertIn("connectWS();", background)


if __name__ == "__main__":
    unittest.main()
