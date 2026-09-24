"""Windows-only public download -> clean extraction -> default launch acceptance.
No credentials, no config editing, no external writes. Keeps evidence under output.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
import zipfile

p = argparse.ArgumentParser()
p.add_argument("tag")
p.add_argument("--output", type=Path, default=Path("release-acceptance"))
a = p.parse_args()
if os.name != "nt":
    raise SystemExit("This acceptance check requires Windows")
if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", a.tag):
    raise SystemExit("Invalid release tag")
a.output.mkdir(parents=True, exist_ok=False)
base = f"https://github.com/Kirrito-k423/AIConnector/releases/download/{a.tag}/"
for name in ("AIConnector-Probe.zip", "AIConnector-Probe.zip.sha256"):
    request = urllib.request.Request(base + name, headers={"User-Agent": "AIConnector-release-acceptance"})
    with urllib.request.urlopen(request, timeout=40) as response:
        (a.output / name).write_bytes(response.read(4 * 1024 * 1024))
archive = a.output / "AIConnector-Probe.zip"
expected = (a.output / (archive.name + ".sha256")).read_text().split()[0]
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
assert actual == expected, "Downloaded release checksum mismatch"
with zipfile.ZipFile(archive) as z:
    assert set(z.namelist()) == {"AIConnector-Probe/" + name for name in ("Probe.ps1", "Run-Windows.cmd", "Run-Windows-Write.cmd", "Run-Windows-Resume.cmd", "probe.config.json", "README.md")}
    z.extractall(a.output / "全新解压 with spaces")
install = (a.output / "全新解压 with spaces/AIConnector-Probe").resolve()
Path(str(install / "Probe.ps1") + ":Zone.Identifier").write_text("[ZoneTransfer]\r\nZoneId=3\r\n")
config_before = (install / "probe.config.json").read_bytes()
env = {k: v for k, v in os.environ.items() if not k.startswith("AICONNECTOR_")}
env.update(AICONNECTOR_NO_PAUSE="1", PSExecutionPolicyPreference="RemoteSigned")
command = f'cmd.exe /d /s /c ""{install / "Run-Windows.cmd"}""'
run = subprocess.run(command, env=env, cwd=a.output.resolve(), input="Y\n", capture_output=True,
                     encoding="utf-8", errors="replace", timeout=240)
(a.output / "launch.log").write_text(run.stdout + run.stderr, encoding="utf-8")
assert run.returncode == 0, run.stdout + run.stderr
assert (install / "probe.config.json").read_bytes() == config_before, "Config was modified"
reports = list((install / "reports").glob("*.json"))
assert len(reports) == 1, "Expected exactly one consolidated report"
report = json.loads(reports[0].read_text(encoding="utf-8"))
assert report["completed"] and report["version"] == a.tag[1:]
assert report["platform"] == "Win32NT" and report["powershell"].startswith("5.1.")
assert not report["summary"]["peer_verified"]
rows = {r["test"]: r for r in report["observations"]}
assert rows["github/issue_read"]["status"] == "PASS", rows["github/issue_read"]
downloads = [r for r in report["observations"] if r["test"].startswith("download/")]
assert len(downloads) == 7
assert all(r["status"] == "EXACT_BYTES_VERIFIED" for r in downloads), downloads
assert len(list((install / "reports").glob("*.zip"))) == 1
print(json.dumps({"release": a.tag, "sha256": actual, "windows_powershell": report["powershell"],
                  "default_config_unchanged": True, "downloads_verified": len(downloads),
                  "github_issue_read": "PASS", "external_writes": 0}, indent=2))
