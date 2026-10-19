"""Protocol JSON must preserve timestamp strings, not coerce them to dates."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from test_probe import ROOT, PWSH


@unittest.skipUnless(PWSH, 'requires PowerShell')
class JsonRoundtripTests(unittest.TestCase):
    def test_protocol_metrics_preserve_nested_timestamp_strings_exactly(self):
        value = {'metrics': {'session_end': '2026-09-27T11:25:50.600Z',
                             'nested': ['2026-09-27T19:25:50.600+08:00',
                                        {'fraction': '2026-09-27T11:25:50.1234567Z',
                                         'date_only': '2026-09-27',
                                         'no_zone': '2026-09-27T11:25:50',
                                         'escaped': 'line\n"quoted"', 'empty': [],
                                         'null': None, 'bool': False, 'number': 12.25}]}}
        with tempfile.TemporaryDirectory(prefix='aic-json-') as folder:
            folder = Path(folder)
            data = folder / 'input.json'
            data.write_text(json.dumps(value), encoding='utf8')
            script = folder / 'roundtrip.ps1'
            script.write_text('''param($Source,$InputFile,$Mode)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$null,[ref]$null)
foreach($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {
    . ([ScriptBlock]::Create($fn.Extent.Text))
}
$text=[IO.File]::ReadAllText($InputFile)
if ($Mode -eq 'fallback') {
    if ($PSVersionTable.PSVersion.Major -lt 6) { 'SKIP_FALLBACK'; exit 0 }
    Json (Parse-WithoutDates $text)
} else { Json (Parse $text) }
''', encoding='utf8')
            for mode in ('normal', 'fallback'):
                with self.subTest(mode=mode):
                    result = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(script),
                                             str(ROOT / 'Connector.ps1'), str(data), mode],
                                            text=True, encoding='utf8', capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    if result.stdout.strip() == 'SKIP_FALLBACK':
                        continue
                    self.assertEqual(json.loads(result.stdout), value)


if __name__ == '__main__':
    unittest.main()
