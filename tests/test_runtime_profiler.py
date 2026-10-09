"""Independent timer must retain attribution during a blocked PS runspace."""
import json, subprocess, tempfile, unittest
from pathlib import Path
from test_probe import PWSH
ROOT=Path(__file__).resolve().parents[1]

@unittest.skipUnless(PWSH,'requires PowerShell')
class RuntimeProfilerTests(unittest.TestCase):
    def test_long_blocking_stage_has_full_exclusive_window_and_fault_fields_are_safe(self):
        with tempfile.TemporaryDirectory() as folder:
            f=Path(folder);code=f/'profile.ps1';output=f/'runtime-windows.jsonl'
            quote=lambda x:"'"+str(x).replace("'","''")+"'"
            code.write_text("Add-Type -TypeDefinition ([IO.File]::ReadAllText("+quote(ROOT/'service/runtime-profiler.cs')+"))\n"
                "$p=New-Object AIConnector.RuntimeProfiler("+quote(output)+")\n"
                "$p.Begin('poll-test','Poll','sample/1/run-1');$p.Push('state.save');$p.Push('canonical')\n"
                "[Threading.Thread]::Sleep(11200)\n"
                "$p.Pop();$p.Pop();$p.End();$p.Dispose()\n",encoding='utf-8-sig')
            r=subprocess.run([PWSH,'-NoProfile','-File',str(code)],capture_output=True,text=True,timeout=30)
            self.assertEqual(r.returncode,0,r.stderr)
            rows=[json.loads(x) for x in output.read_text().splitlines()]
            full=[r for r in rows if not r['partial']];self.assertGreaterEqual(len(full),1)
            for row in rows:
                self.assertAlmostEqual(sum(x['wall_ms'] for x in row['segments']),row['elapsed_ms'],delta=.02)
                self.assertGreaterEqual(row['cpu_ms'],0)
            work=sum(x['wall_ms'] for x in full[0]['segments'] if x['stage']=='canonical' and x['parent_stage']=='state.save')
            self.assertGreater(work,9800)
            # Window was persisted by the timer while the PS thread was asleep,
            # not reconstructed from an action end event.
            self.assertLess(full[0]['cpu_sample_max_ms'],3000)
