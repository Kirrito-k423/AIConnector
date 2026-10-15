"""Compare cold CLI and resident transport on identical valid synthetic ledgers."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
import test_relay as relay
from test_resident import Resident


def canonical(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()


def ledger_with_runs(base,count):
    state=copy.deepcopy(base);state['events']={};state['comments']={};state['outbox']={};state['routes']={}
    original={e['kind']:e for e in base['events'].values()}
    sources={s['event_id']:s for s in base['comments'].values()}
    for i in range(count):
        task='history-'+str(i);parent=''
        state['routes'][task]={**next(iter(base['routes'].values())),'task_id':task,'number':str(i+1)}
        for kind in ['task','accepted','started','result','receipt']:
            e=copy.deepcopy(original[kind]);old=e.pop('event_id');e.update(task_id=task,parent=parent)
            e['event_id']=hashlib.sha256(canonical(e)).hexdigest();parent=e['event_id'];state['events'][parent]=e
            source=copy.deepcopy(sources[old]);source['event_id']=parent
            state['comments'][str(i*5+len(state['comments'])+1)]=source
    return state


def measure(baseline,count,repeats):
    c=relay.RelayTests('test_handoff_creates_one_issue_one_release_and_persists_timeline');c.setUp()
    try:
        c.complete_flow();base=c.read_state('mac-outer');state=ledger_with_runs(base,count)
        rows=[]
        for variant in ['cold_baseline','resident_candidate']:
            relay.legacy.ConnectorTests.write_state(c,'mac-outer',state)
            if variant=='resident_candidate':
                started=time.perf_counter();resident=Resident(c,'mac-outer');startup_ms=(time.perf_counter()-started)*1000
                call=lambda:resident.call('Status')
            else:
                resident=None;startup_ms=None
                def call():
                    command=c.command('mac-outer','Status');command[command.index('-File')+1]=str(baseline)
                    p=subprocess.run(command,capture_output=True,text=True,encoding='utf-8',timeout=120)
                    if p.returncode:raise RuntimeError(p.stdout)
                    return json.loads(p.stdout.splitlines()[-1])
            try:
                call()  # Exclude initial projection population; measure stable history.
                files=[c.folder/'mac-outer'/name for name in ['state.json','status.json','status.md']]
                files+=list((c.folder/'mac-outer'/'inbox').glob('*.json'))
                samples=[]
                for _ in range(repeats):
                    times=[p.stat().st_mtime_ns for p in files];started=time.perf_counter();value=call();elapsed=(time.perf_counter()-started)*1000
                    assert len(value['runs'])==count and all(r['phase']=='receipt' for r in value['runs'])
                    samples.append(dict(wall_ms=elapsed,changed_files=sum(p.stat().st_mtime_ns!=old for p,old in zip(files,times))))
                rows.append(dict(variant=variant,runs=count,events=count*5,startup_ms=startup_ms,samples=samples,
                    median_ms=statistics.median(s['wall_ms'] for s in samples),median_changed_files=statistics.median(s['changed_files'] for s in samples)))
            finally:
                if resident:resident.close()
        return rows
    finally:c.tearDown()


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--baseline',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--repeats',type=int,default=5);p.add_argument('--runs',type=int,nargs='+',default=[1,39,100])
    a=p.parse_args();rows=[]
    for count in a.runs:
        measured=measure(a.baseline.resolve(),count,a.repeats);rows+=measured
        for row in measured: print(json.dumps({k:v for k,v in row.items() if k!='samples'}),flush=True)
        a.output.parent.mkdir(parents=True,exist_ok=True)
        a.output.write_text(json.dumps(dict(scope='Real PS on Mac, valid synthetic completed ledgers; no WAN/model/A5 latency claim',repeats=a.repeats,rows=rows),indent=2)+'\n')
