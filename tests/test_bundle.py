"""Exercise the ZIP users receive, not only scripts in the checkout."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile
from http.server import ThreadingHTTPServer

from test_probe import Handler, PWSH

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_bundle", ROOT / "tools/build_bundle.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="AIConnector package ")
        self.root = Path(self.tmp.name)
        self.archive = builder.build(self.root / "dist")
        with zipfile.ZipFile(self.archive) as z:
            z.extractall(self.root / "解压目录 with spaces")
        self.install = self.root / "解压目录 with spaces" / "AIConnector-Probe"
        Handler.comments = []
        Handler.requests = []
        Handler.corrupt_post = False
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        base = f"http://127.0.0.1:{self.server.server_port}"
        self.config = self.root / "local fixtures.json"
        self.config.write_text(json.dumps({"channels": [{
            "name": "fixture", "provider": "github", "website": base,
            "api_base": base + "/unauth", "read_repository": "test/probe", "read_issue": "1",
            "repository": "", "issue": ""
        }], "downloads": [
            {"name": "bad-url", "url": "file:///private/local"},
            {"name": "login-page", "url": base + "/login", "sha256": "0" * 64},
            {"name": "sample", "url": base + "/sample", "sha256": hashlib.sha256(b"AIConnector file\n").hexdigest()}
        ]}), encoding="utf-8")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def test_release_archive_contract_and_reproducibility(self):
        second = builder.build(self.root / "second")
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())
        script = (self.install / "Probe.ps1").read_bytes()
        cmd = (self.install / "Run-Windows.cmd").read_bytes()
        self.assertTrue(script.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"__PROBE_SHA256__", cmd)
        self.assertIn(hashlib.sha256(script).hexdigest().encode(), cmd)
        self.assertEqual(cmd.count(b"\n"), cmd.count(b"\r\n"))
        config = json.loads((self.install / "probe.config.json").read_text())
        self.assertTrue(all(c.get("read_repository") for c in config["channels"]))
        self.assertEqual({c["repository"] for c in config["channels"]}, {"Kirrito-k423/AIConnector", "shaojiemike/AIConnector-Probe"})
        self.assertEqual(len(config["downloads"]), 7)
        for row in config["downloads"]:
            data = (self.root / "dist" / row["name"]).read_bytes()
            self.assertEqual(row["sha256"], hashlib.sha256(data).hexdigest())
        with zipfile.ZipFile(self.root / "dist/sample-128KiB.zip") as z:
            self.assertIsNone(z.testzip())
            self.assertEqual(len(z.read("sample.bin")), 131072)

    def test_windows_checkout_line_endings_produce_identical_bundle(self):
        checkout = self.root / "windows checkout"
        checkout.mkdir()
        for name in ("Probe.ps1", "Run-Windows.cmd", "Run-Windows-Write.cmd", "Run-Windows-Resume.cmd", "probe.config.json", "README.md"):
            data = (ROOT / name).read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            (checkout / name).write_bytes(data)
        with patch.object(builder, "ROOT", checkout):
            windows_archive = builder.build(self.root / "windows build")
        self.assertEqual(self.archive.read_bytes(), windows_archive.read_bytes())

    def check_report(self, run):
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        out = self.install / "reports"
        reports = list(out.glob("*.json"))
        self.assertEqual(len(reports), 1, run.stdout + run.stderr)
        report = json.loads(reports[0].read_text(encoding="utf-8"))
        self.assertEqual(report["version"], builder.VERSION)
        self.assertTrue(report["completed"])
        self.assertFalse(report["summary"]["peer_verified"])
        statuses = {r["test"]: r["status"] for r in report["observations"]}
        self.assertEqual(statuses["fixture/api"], "NEEDS_TOKEN")
        self.assertEqual(statuses["fixture/issue_read"], "PASS")
        self.assertEqual(statuses["download/bad-url"], "INVALID_TARGET")
        self.assertEqual(statuses["download/login-page"], "HASH_MISMATCH")
        self.assertEqual(statuses["download/sample"], "EXACT_BYTES_VERIFIED")
        archive = next(out.glob("*.zip"))
        with zipfile.ZipFile(archive) as z:
            self.assertEqual(len(z.namelist()), 3)
            self.assertEqual(z.read(reports[0].name), reports[0].read_bytes())
            self.assertIn(b'charset="utf-8"', z.read(reports[0].with_suffix(".html").name))
        self.assertTrue(all(method == "GET" for method, *_ in Handler.requests))

    @unittest.skipUnless(PWSH, "requires PowerShell")
    def test_extracted_script_keeps_testing_after_auth_and_download_failures(self):
        run = subprocess.run([PWSH, "-NoLogo", "-NoProfile", "-File", str(self.install / "Probe.ps1"),
                              "-Config", str(self.config), "-Proxy", "direct"],
                             cwd=self.root, capture_output=True, encoding="utf-8", errors="replace", timeout=40)
        self.check_report(run)

    def launch(self, policy="RemoteSigned", answer="N\n", tamper=False):
        script = self.install / "Probe.ps1"
        if tamper:
            script.write_bytes(script.read_bytes() + b"\n# modified\n")
        Path(str(script) + ":Zone.Identifier").write_text("[ZoneTransfer]\r\nZoneId=3\r\n")
        env = dict(os.environ, AICONNECTOR_NO_PAUSE="1", PSExecutionPolicyPreference=policy)
        # Deliberately keep the caller outside the installation directory.
        line = f'""{self.install / "Run-Windows.cmd"}" -Config "{self.config}" -Proxy direct"'
        return subprocess.run("cmd.exe /d /s /c " + line, cwd=self.root, env=env,
                              input=answer, capture_output=True, encoding="utf-8", errors="replace", timeout=50)

    @unittest.skipUnless(os.name == "nt", "requires NTFS/Windows")
    def test_marked_release_launches_once_after_user_trust(self):
        run = self.launch(answer="Y\n")
        self.check_report(run)
        self.assertIn("Execution policy unchanged", run.stdout)
        self.assertFalse(Path(str(self.install / "Probe.ps1") + ":Zone.Identifier").exists())
        self.assertFalse((self.root / "reports").exists())

    @unittest.skipUnless(os.name == "nt", "requires NTFS/Windows")
    def test_declining_trust_never_runs_or_removes_mark(self):
        run = self.launch()
        self.assertEqual(run.returncode, 3, run.stdout + run.stderr)
        self.assertEqual(Handler.requests, [])
        self.assertTrue(Path(str(self.install / "Probe.ps1") + ":Zone.Identifier").exists())
        self.assertEqual(len(list((self.install / "reports").glob("startup-*.zip"))), 1)

    @unittest.skipUnless(os.name == "nt", "requires NTFS/Windows")
    def test_corrupt_package_never_unblocks_or_runs(self):
        run = self.launch(answer="Y\n", tamper=True)
        self.assertEqual(run.returncode, 4, run.stdout + run.stderr)
        self.assertIn("CHECKSUM_MISMATCH", run.stdout)
        self.assertEqual(Handler.requests, [])
        self.assertTrue(Path(str(self.install / "Probe.ps1") + ":Zone.Identifier").exists())

    @unittest.skipUnless(os.name == "nt", "requires Windows")
    def test_release_respects_all_signed_even_when_answer_is_yes(self):
        run = self.launch(policy="AllSigned", answer="Y\n")
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(Handler.requests, [])
        self.assertTrue(Path(str(self.install / "Probe.ps1") + ":Zone.Identifier").exists())
        self.assertNotIn("Download mark removed", run.stdout)
