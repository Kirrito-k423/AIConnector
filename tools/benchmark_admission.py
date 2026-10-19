"""Compare owned Claim admission using real resident PS and a delayed local Relay fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
import test_relay as relay
from test_resident import Resident


def measure(script,runs,delay):
    source_sha=hashlib.sha256(script.read_bytes()).hexdigest()
    c=relay.RelayTests('test_handoff_creates_one_issue_one_release_and_persists_timeline');c.setUp()
    runtime=None
    try:
        c.seed_history(16)
        keys=[]
        for i in range(runs):
            c.task['run_id']='bench-'+str(i);c.write_inputs();c.submit();c.poll('mac-outer')
            keys.append('smoke/1/bench-'+str(i))
        class DelayedAPI(relay.RelayAPI):
            def do_GET(self):time.sleep(delay);super().do_GET()
            def do_POST(self):time.sleep(delay);super().do_POST()
        c.server.RequestHandlerClass=DelayedAPI
        command=c.command
        def use_script(*args):
            result=command(*args);result[result.index('-File')+1]=str(script);return result
        c.command=use_script
        runtime=Resident(c,'windows-inner')
        c.ctx['gets'].clear();c.ctx['posts'].clear()
        start=time.perf_counter();snapshot=runtime.call('Poll');samples={}
        for _ in range(40):
            for row in snapshot['runs']:
                if row['key'] in keys and row['phase']=='accepted' and row['key'] not in samples:
                    value=runtime.call('Claim',key=row['key'],owner=hashlib.sha256(row['key'].encode()).hexdigest()[:48])
                    assert value['execute'] and not value['replayed']
                    samples[row['key']]=(time.perf_counter()-start)*1000
            if len(samples)==runs:break
            snapshot=runtime.call('Flush')
        assert len(samples)==runs,(samples,snapshot)
        at_admission=dict(gets=len(c.ctx['gets']),posts=len(c.ctx['posts']))
        for _ in range(40):
            snapshot=runtime.call('Flush')
            if all(row['phase']=='started' for row in snapshot['runs']):break
        assert all(row['phase']=='started' for row in snapshot['runs'])
        assert len(c.ctx['comments'])==3*runs
        assert hashlib.sha256(script.read_bytes()).hexdigest()==source_sha,'Source changed during measurement'
        return dict(scope='First receiver Poll dispatch to owner-bound Claim reply; excludes process cold start, Pi/model/SSH, WAN and resources.',
                    runs=runs,http_delay_seconds=delay,claim_reply_ms=samples,mean_claim_reply_ms=statistics.mean(samples.values()),
                    all_claimed_ms=max(samples.values()),at_admission=at_admission,total_gets=len(c.ctx['gets']),
                    total_posts=len(c.ctx['posts']),all_started_ms=(time.perf_counter()-start)*1000,
                    source_sha256=source_sha)
    finally:
        if runtime:runtime.close()
        c.tearDown()


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--baseline',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--runs',type=int,default=6)
    p.add_argument('--repeats',type=int,default=3);p.add_argument('--http-delay',type=float,default=.08)
    a=p.parse_args();assert 1<=a.runs<=8 and 1<=a.repeats<=5 and 0<=a.http_delay<=.3
    rows=[]
    # Alternate order across independent, identically generated fixtures.
    for repeat in range(a.repeats):
        for name,script in ([('baseline',a.baseline),('candidate',ROOT/'Connector.ps1')] if repeat%2==0 else [('candidate',ROOT/'Connector.ps1'),('baseline',a.baseline)]):
            row=dict(variant=name,repeat=repeat,**measure(script.resolve(),a.runs,a.http_delay));rows.append(row);print(json.dumps(row),flush=True)
            a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(dict(rows=rows),indent=2)+'\n')
