"""Compare real Connector scripts against the same local Relay API fixture (no GitHub writes)."""
import argparse
import json
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tests'))
from test_relay import RelayAPI, RelayTests


def measure(script, history, delay_ms):
    case = RelayTests('test_one_delivery_does_not_read_unrelated_issue_comments')
    case.setUp()
    class DelayedAPI(RelayAPI):
        def do_GET(self):
            time.sleep(delay_ms/1000)
            super().do_GET()
    case.server.RequestHandlerClass = DelayedAPI
    original = case.command
    def command(*args):
        argv = original(*args)
        argv[argv.index('-File')+1] = str(script)
        return argv
    case.command = command
    def action(name):
        case.ctx['gets'].clear()
        started = time.monotonic()
        case.run_cli('mac-outer', name)
        return dict(gets=len(case.ctx['gets']), wall_ms=round((time.monotonic()-started)*1000, 2))
    try:
        case.seed_history(history)
        case.submit()
        delivery = action('Flush')
        action('Poll')
        steady_poll = action('Poll')
        return dict(delivery=delivery, steady_poll=steady_poll)
    finally:
        case.tearDown()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--candidate', type=Path, default=ROOT/'Connector.ps1')
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--delay-ms', type=int, default=25)
    p.add_argument('--repeats', type=int, default=3)
    a = p.parse_args()
    rows = []
    for history in [0, 16, 100]:
        for label, script in [('baseline', a.baseline), ('candidate', a.candidate)]:
            runs = [measure(script.resolve(), history, a.delay_ms) for _ in range(a.repeats)]
            row = dict(version=label, historical_issues=history, samples=runs)
            row['median'] = {stage:{metric:statistics.median(r[stage][metric] for r in runs)
                                   for metric in ['gets', 'wall_ms']} for stage in ['delivery', 'steady_poll']}
            rows.append(row)
            print(json.dumps({k:v for k,v in row.items() if k!='samples'}), flush=True)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(dict(scope='Synthetic local API; real PowerShell processes; no WAN or A5 speed claim',
        added_get_delay_ms=a.delay_ms, repeats=a.repeats, rows=rows), indent=2)+'\n')


if __name__ == '__main__':
    main()
