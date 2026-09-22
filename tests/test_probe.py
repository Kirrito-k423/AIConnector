"""Real PowerShell process + local fake HTTP; never posts to external services."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import struct
import tempfile
import threading
import time
import unittest
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
PWSH = os.environ.get("PWSH", shutil.which("pwsh") or "")


class Handler(BaseHTTPRequestHandler):
    comments = []
    requests = []
    corrupt_post = False

    def log_message(self, *_):
        pass

    def reply(self, value, status=200, raw=False, headers=None):
        body = value if raw else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html" if raw else "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        Handler.requests.append(("GET", self.path, self.headers.get("Authorization")))
        path = urlparse(self.path).path
        if path == "/html/user":
            return self.reply(b"<html>login or challenge</html>", raw=True)
        if path == "/unauth/user":
            return self.reply({"message": "authentication required"}, 401)
        if path == "/redirect/user":
            return self.reply({}, 302, headers={"Location": "/capture"})
        if path == "/limited/user":
            return self.reply({}, 429, headers={"Retry-After": "60"})
        if path == "/large/user":
            return self.reply(b"x" * (3 * 1024 * 1024), raw=True)
        if path == "/slow/user":
            time.sleep(2)
            return self.reply({"id": 1, "login": "probe"})
        if path.endswith("/user"):
            return self.reply({"id": 1, "login": "probe"})
        if path.endswith("/comments"):
            page = int(parse_qs(urlparse(self.path).query).get("page", ["1"])[0])
            return self.reply(Handler.comments[(page - 1) * 100:page * 100])
        if path == "/sample":
            return self.reply(b"AIConnector file\n", raw=True)
        return self.reply(b"<html>public page</html>", raw=True)

    def do_POST(self):
        Handler.requests.append(("POST", self.path, self.headers.get("Authorization")))
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        body = data["body"]
        if Handler.corrupt_post:
            body += "changed"
        comment = {"id": len(Handler.comments) + 1, "body": body}
        Handler.comments.append(comment)
        self.reply(comment, 201)


@unittest.skipUnless(PWSH, "set PWSH to the PowerShell executable")
class ProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = 0
        Handler.comments = []
        Handler.requests = []
        Handler.corrupt_post = False

    def tearDown(self):
        self.tmp.cleanup()

    def run_probe(self, mode="Scan", prefix="good", provider="gitcode", downloads=None,
                  token="FAKE+SECRET/&?", node="mac", peer="windows", extra=(), success=True):
        self.calls += 1
        config = self.root / "config.json"
        config.write_text(json.dumps({"channels": [{
            "name": "test", "provider": provider,
            "website": self.base + "/website", "api_base": self.base + "/" + prefix,
            "token_env": "AICONNECTOR_TEST_TOKEN", "repository": "test/probe", "issue": "1"
        }], "downloads": downloads or []}))
        out = self.root / str(self.calls)
        cmd = [PWSH, "-NoLogo", "-NoProfile", "-File", str(ROOT / "Probe.ps1"),
               "-Config", str(config), "-OutputDir", str(out), "-Mode", mode,
               "-Proxy", "direct", "-Node", node, "-Channel", "test",
               "-Session", "run1", "-Peer", peer, *extra]
        env = dict(os.environ, AICONNECTOR_TEST_TOKEN=token)
        run = subprocess.run(cmd, env=env, encoding="utf-8", errors="replace", capture_output=True, timeout=25)
        reports = list(out.glob("*.json"))
        self.assertEqual(len(reports), 1, run.stdout + run.stderr)
        if success:
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        else:
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        raw = reports[0].read_text(encoding="utf-8")
        if token:
            self.assertNotIn(token, raw + run.stdout + run.stderr)
            self.assertNotIn("access_token", raw)
        return json.loads(raw)

    @staticmethod
    def statuses(report):
        return {row["test"]: row["status"] for row in report["observations"]}

    def test_scan_empty_array_and_read_only(self):
        r = self.run_probe()
        self.assertEqual(self.statuses(r)["test/api"], "AUTH_API_VERIFIED")
        self.assertEqual(self.statuses(r)["test/issue_read"], "PASS")
        self.assertTrue(all(method == "GET" for method, *_ in Handler.requests))

    def test_html_not_valid_api(self):
        self.assertEqual(self.statuses(self.run_probe(prefix="html"))["test/api"], "UNEXPECTED_API_RESPONSE")

    def test_authentication_unknown_vs_rejected(self):
        self.assertEqual(self.statuses(self.run_probe(prefix="unauth", token=""))["test/api"], "NEEDS_TOKEN")
        self.assertEqual(self.statuses(self.run_probe(prefix="unauth"))["test/api"], "AUTH_REJECTED")

    def test_tokens_not_forwarded_on_redirect(self):
        self.assertEqual(self.statuses(self.run_probe(prefix="redirect"))["test/api"], "REDIRECT_BLOCKED")
        self.assertFalse(any("/capture" in path for _, path, _ in Handler.requests))

    def test_rate_limit_no_retry(self):
        r = self.run_probe(prefix="limited")
        self.assertEqual(self.statuses(r)["test/api"], "RATE_LIMITED")
        self.assertEqual(sum("/limited/user" in path for _, path, _ in Handler.requests), 1)
        api = next(x for x in r["observations"] if x["test"] == "test/api")
        self.assertEqual(api["evidence"]["retry_after"], "60")

    def test_body_limit(self):
        self.assertEqual(self.statuses(self.run_probe(prefix="large"))["test/api"], "BODY_LIMIT_EXCEEDED")

    def test_timeout_is_bounded(self):
        self.assertEqual(self.statuses(self.run_probe(prefix="slow", extra=("-TimeoutSeconds", "1")))["test/api"], "TIMEOUT")

    def test_download_hash_and_unverified(self):
        sha = hashlib.sha256(b"AIConnector file\n").hexdigest()
        ds = [{"name": "exact", "url": self.base + "/sample?sig=SECRET", "sha256": sha},
              {"name": "wrong", "url": self.base + "/sample", "sha256": "0" * 64},
              {"name": "unknown", "url": self.base + "/sample"}]
        r = self.run_probe(downloads=ds)
        s = self.statuses(r)
        self.assertEqual(s["download/exact"], "EXACT_BYTES_VERIFIED")
        self.assertEqual(s["download/wrong"], "HASH_MISMATCH")
        self.assertEqual(s["download/unknown"], "DOWNLOADED_UNVERIFIED")
        self.assertNotIn("SECRET", json.dumps(r))

    def test_roundtrip_repeat_and_reverse(self):
        self.run_probe("Send")
        self.assertEqual(self.statuses(self.run_probe("Verify"))["roundtrip"], "WAITING")
        self.run_probe("Send")
        self.assertEqual(len(Handler.comments), 1)
        self.run_probe("Receive", node="windows", peer="mac")
        self.run_probe("Receive", node="windows", peer="mac")
        self.assertEqual(len(Handler.comments), 2)
        self.assertEqual(self.statuses(self.run_probe("Verify"))["roundtrip"], "PEER_RECEIPT_VERIFIED")
        self.run_probe("Send", node="windows", peer="mac", extra=("-SizeBytes", "32768"))
        self.run_probe("Receive")
        r = self.run_probe("Verify", node="windows", peer="mac")
        self.assertEqual(self.statuses(r)["roundtrip"], "PEER_RECEIPT_VERIFIED")
        self.assertEqual(r["observations"][0]["evidence"]["payload_bytes"], 32768)

    def test_corrupted_sample_never_acknowledged(self):
        self.run_probe("Send")
        Handler.comments[0]["body"] = Handler.comments[0]["body"].replace("code / newline", "CODE / newline")
        r = self.run_probe("Receive", node="windows", peer="mac")
        self.assertEqual(self.statuses(r)["peer_receive"], "PAYLOAD_INVALID")
        self.assertEqual(len(Handler.comments), 1)

    def test_post_response_corruption_is_error(self):
        Handler.corrupt_post = True
        self.run_probe("Send", success=False)
        self.assertEqual(sum(m == "POST" for m, *_ in Handler.requests), 1)

    def test_github_header_auth(self):
        self.run_probe("Send", provider="github")
        posts = [r for r in Handler.requests if r[0] == "POST"]
        self.assertEqual(posts[0][2], "Bearer FAKE+SECRET/&?")
        self.assertNotIn("access_token", posts[0][1])

    def test_no_token_never_posts(self):
        self.run_probe("Send", token="", success=False)
        self.assertFalse(any(m == "POST" for m, *_ in Handler.requests))

    def test_pagination_limit_does_not_claim_success(self):
        Handler.comments = [{"id": i + 1, "body": "ordinary comment"} for i in range(100)]
        self.run_probe("Send", extra=("-MaxPages", "1"), success=False)
        self.assertFalse(any(m == "POST" for m, *_ in Handler.requests))

    def test_samples_hashes_and_sizes(self):
        self.run_probe("Samples")
        folder = self.root / "1" / "samples"
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest), 6)
        for row in manifest:
            data = (folder / row["name"]).read_bytes()
            self.assertEqual(len(data), row["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), row["sha256"])
        self.assertEqual((folder / "text-32768.txt").stat().st_size, 32768)
        png = (folder / "pixel.png").read_bytes()
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        offset = 8
        while offset < len(png):
            size = struct.unpack(">I", png[offset:offset + 4])[0]
            chunk = png[offset + 4:offset + 8 + size]
            crc = struct.unpack(">I", png[offset + 8 + size:offset + 12 + size])[0]
            self.assertEqual(zlib.crc32(chunk), crc)
            offset += size + 12

    def test_unexpected_error_cannot_echo_config_secret(self):
        config = self.root / "broken.json"
        config.write_text('{"secret": "DO_NOT_PRINT_ME", invalid}')
        out = self.root / "broken-report"
        run = subprocess.run([PWSH, "-NoLogo", "-NoProfile", "-File", str(ROOT / "Probe.ps1"),
                              "-Config", str(config), "-OutputDir", str(out)], encoding="utf-8", errors="replace", capture_output=True)
        self.assertEqual(run.returncode, 2)
        output = run.stdout + run.stderr + next(out.glob("*.json")).read_text(encoding="utf-8")
        self.assertNotIn("DO_NOT_PRINT_ME", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
