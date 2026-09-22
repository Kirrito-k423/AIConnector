"""Exercise actual cmd.exe and Windows PowerShell signing-policy rejection."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "nt", "requires real Windows execution policy and NTFS streams")
class WindowsLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="AIConnector test ")
        self.folder = Path(self.temp.name)
        shutil.copyfile(ROOT / "Run-Windows.cmd", self.folder / "Run-Windows.cmd")
        self.script = self.folder / "Probe.ps1"

    def tearDown(self):
        self.temp.cleanup()

    def run_launcher(self, policy="RemoteSigned", args=()):
        env = dict(os.environ, AICONNECTOR_NO_PAUSE="1", PSExecutionPolicyPreference=policy)
        run = subprocess.run(["cmd.exe", "/d", "/c", "Run-Windows.cmd", *args],
                             cwd=self.folder, env=env, capture_output=True,
                             encoding="utf-8", errors="replace", timeout=30)
        logs = list((self.folder / "reports").glob("startup-*.txt"))
        self.assertEqual(len(logs), 1, run.stdout + run.stderr)
        return run, logs[0].read_bytes()

    def test_marked_unsigned_script_is_rejected_and_diagnosed(self):
        self.script.write_text("Write-Output 'PROBE_EXECUTED'; exit 0", encoding="utf-8-sig")
        Path(str(self.script) + ":Zone.Identifier").write_text("[ZoneTransfer]\r\nZoneId=3\r\n")
        run, log = self.run_launcher()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn(b"EffectivePolicy: RemoteSigned", log)
        self.assertIn(b"ZoneId=3", log)
        self.assertIn(b"Signature: NotSigned", log)
        self.assertNotIn(b"PROBE_EXECUTED", log)
        self.assertNotIn("Probe command completed", run.stdout)
        self.assertIn("Probe command FAILED", run.stdout)
        self.assertIn("ZoneId=3", Path(str(self.script) + ":Zone.Identifier").read_text())

    def test_script_error_exit_code_survives_diagnostics(self):
        self.script.write_text("Write-Output 'STUB_FAILURE'; exit 7", encoding="utf-8-sig")
        run, log = self.run_launcher()
        self.assertEqual(run.returncode, 7)
        self.assertIn(b"STUB_FAILURE", log)
        self.assertIn(b"ProbeExitCode: 7", log)
        self.assertNotIn("Probe command completed", run.stdout)

    def test_success_is_not_classified_as_failure(self):
        self.script.write_text("Write-Output 'STUB_SUCCESS'; exit 0", encoding="utf-8-sig")
        run, log = self.run_launcher()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn(b"STUB_SUCCESS", log)
        self.assertIn("Probe command completed", run.stdout)
        self.assertNotIn("Probe command FAILED", run.stdout)

    def test_diagnose_only_never_runs_probe(self):
        self.script.write_text("Write-Output 'PROBE_EXECUTED'; exit 8", encoding="utf-8-sig")
        run, log = self.run_launcher(args=("--diagnose",))
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn(b"AIConnector startup diagnostics", log)
        self.assertNotIn(b"PROBE_EXECUTED", log)

    def test_all_signed_remains_enforced(self):
        self.script.write_text("Write-Output 'PROBE_EXECUTED'; exit 0", encoding="utf-8-sig")
        run, log = self.run_launcher(policy="AllSigned")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn(b"EffectivePolicy: AllSigned", log)
        self.assertNotIn(b"PROBE_EXECUTED", log)


if __name__ == "__main__":
    unittest.main(verbosity=2)
