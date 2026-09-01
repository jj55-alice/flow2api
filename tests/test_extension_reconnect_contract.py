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
            (1, 2, 1),
        )

    def test_worker_reconnects_on_chrome_start_and_alarm(self):
        background = (REPO_ROOT / "extension" / "background.js").read_text()

        self.assertIn("chrome.runtime.onStartup.addListener", background)
        self.assertIn("chrome.alarms.onAlarm.addListener", background)
        self.assertIn("periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES", background)
        self.assertIn("connectWS();", background)


if __name__ == "__main__":
    unittest.main()
