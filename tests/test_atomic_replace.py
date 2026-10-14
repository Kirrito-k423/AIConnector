"""Exercise the real PowerShell atomic writer with native I/O fault injection."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_probe import PWSH, ROOT


@unittest.skipUnless(PWSH, 'requires PowerShell')
class AtomicReplaceTests(unittest.TestCase):
    def run_case(self, failures, native_code):
        with tempfile.TemporaryDirectory(prefix='AIC atomic fixture ') as directory:
            target = Path(directory) / 'state.json'
            target.write_text('original', encoding='utf8')
            script = Path(directory) / 'case.ps1'
            script.write_text(r'''param($Source,$Target,[int]$Failures,[int]$Code)
$ErrorActionPreference='Stop'
$script:Utf8=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
public static class AtomicFixtureFile {
    public static int Attempts;
    public static int Failures;
    public static int Code;
    public static void Replace(string source, string target, string backup) {
        Attempts++;
        if (Attempts <= Failures) throw new IOException("fixture", unchecked((int)0x80070000) | Code);
        File.Replace(source, target, backup);
    }
}
'@
[AtomicFixtureFile]::Failures=$Failures
[AtomicFixtureFile]::Code=$Code
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
foreach($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {
    if($function.Name -in @('Atomic-Work','Replace-AtomicFile')) {
        Invoke-Expression ($function.Extent.Text.Replace('[IO.File]::Replace(', '[AtomicFixtureFile]::Replace('))
    }
}
$succeeded=$false
try { Atomic-Work $Target 'replacement'; $succeeded=$true } catch { }
@{succeeded=$succeeded; attempts=[AtomicFixtureFile]::Attempts; content=[IO.File]::ReadAllText($Target); temporary_files=@(Get-ChildItem ([IO.Path]::GetDirectoryName($Target)) -Filter '*.tmp').Count} | ConvertTo-Json -Compress
''', encoding='utf-8-sig')
            run = subprocess.run([PWSH, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(script),
                                  str(ROOT / 'Connector.ps1'), str(target), str(failures), str(native_code)],
                                 capture_output=True, text=True, encoding='utf8', timeout=15)
            self.assertEqual(run.returncode, 0, run.stderr)
            return json.loads(run.stdout.strip())

    def test_temporary_sharing_violation_retries_the_same_atomic_replacement(self):
        result = self.run_case(1, 32)
        self.assertTrue(result['succeeded'], result)
        self.assertEqual(result['attempts'], 2)
        self.assertEqual(result['content'], 'replacement')
        self.assertEqual(result['temporary_files'], 0)

    def test_persistent_sharing_violation_is_bounded_and_preserves_the_original(self):
        result = self.run_case(100, 32)
        self.assertFalse(result['succeeded'])
        self.assertEqual(result['attempts'], 8)
        self.assertEqual(result['content'], 'original')
        self.assertEqual(result['temporary_files'], 0)

    def test_other_io_errors_are_not_retried(self):
        result = self.run_case(100, 112)
        self.assertFalse(result['succeeded'])
        self.assertEqual(result['attempts'], 1)
        self.assertEqual(result['content'], 'original')
        self.assertEqual(result['temporary_files'], 0)
