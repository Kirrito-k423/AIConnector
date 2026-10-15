"""Paired resident Flush on identical valid synthetic closed ledgers; no WAN/model/A5."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
import test_relay as relay
from test_resident import Resident
from test_probe import PWSH
from benchmark_resident import ledger_with_runs


def measure(baseline,counts,repeats):
    case=relay.RelayTests('test_handoff_creates_one_issue_one_release_and_persists_timeline');case.setUp()
    samples=[]
    try:
        case.complete_flow();base=case.read_state('mac-outer')
        with tempfile.TemporaryDirectory(prefix='aic-flush-baseline-') as folder:
            old=Path(folder)/'Connector.ps1';shutil.copyfile(baseline,old)
            (old.parent/'service').mkdir();shutil.copyfile(ROOT/'service/runtime-profiler.cs',old.parent/'service/runtime-profiler.cs')
            for count in counts:
                state=ledger_with_runs(base,count)
                for repeat in range(repeats):
                    # Alternate the ordering so warm host/cache conditions do not favor one variant.
                    order=['baseline','candidate'] if repeat%2==0 else ['candidate','baseline']
                    reference=None
                    for variant in order:
                        relay.legacy.ConnectorTests.write_state(case,'mac-outer',copy.deepcopy(state))
                        posts=len(case.ctx['posts']);gets=len(case.ctx['gets'])
                        runtime=Resident(case,'mac-outer',old if variant=='baseline' else ROOT/'Connector.ps1',timeout=120)
                        try:
                            expected=runtime.call('Status')  # Cold startup/projection is measured separately elsewhere.
                            if reference is None:reference=expected
                            assert expected==reference,'Variants disagree on the same ledger'
                            files=[case.folder/'mac-outer'/name for name in ['state.json','status.json','status.md']]
                            files+=list((case.folder/'mac-outer'/'inbox').glob('*.json'))
                            mtimes=[p.stat().st_mtime_ns for p in files]
                            began=time.perf_counter();actual=runtime.call('Flush');wall_ms=(time.perf_counter()-began)*1000
                            assert actual==expected and len(actual['runs'])==count
                            assert all(row['phase']=='receipt' for row in actual['runs'])
                            assert len(case.ctx['posts'])==posts and len(case.ctx['gets'])==gets,'No-op Flush performs network work'
                            # Ignore the first migration save during warmup; unchanged Flush must not rewrite state/projections.
                            assert all(p.stat().st_mtime_ns==before for p,before in zip(files,mtimes))
                            samples.append(dict(runs=count,events=count*5,repeat=repeat,variant=variant,wall_ms=wall_ms,changed_files=0,network_requests=0))
                        finally:runtime.close()
    finally:case.tearDown()
    return samples


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--runs',type=int,nargs='+',default=[1,40]);parser.add_argument('--repeats',type=int,default=3)
    args=parser.parse_args();assert args.repeats>=3 and all(0<n<=100 for n in args.runs)
    samples=measure(args.baseline.resolve(),args.runs,args.repeats);summary=[]
    for count in args.runs:
        medians={variant:statistics.median(s['wall_ms'] for s in samples if s['runs']==count and s['variant']==variant) for variant in ['baseline','candidate']}
        summary.append(dict(runs=count,**medians,reduction_percent=(1-medians['candidate']/medians['baseline'])*100))
    ps_version=subprocess.check_output([PWSH,'-NoLogo','-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()'],text=True).strip()
    result=dict(scope='Paired warmed resident no-op Flush, identical synthetic closed ledgers, unchanged output/files and zero network requests; not intranet/A5 E2E',windows=os.name=='nt',host=platform.platform(),arch=platform.machine(),powershell=ps_version,baseline_sha256=hashlib.sha256(args.baseline.read_bytes()).hexdigest(),candidate_sha256=hashlib.sha256((ROOT/'Connector.ps1').read_bytes()).hexdigest(),repeats=args.repeats,samples=samples,summary=summary)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='samples'}),flush=True)


if __name__=='__main__':main()
