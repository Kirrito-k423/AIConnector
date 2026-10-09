"""Render returned Windows diagnostics as an exclusive ten-second ledger.
Usage: python report_windows.py delivery-diagnostics.zip --output windows.csv
No network/service access. Connector and Pi are separate process lanes.
"""
import argparse,csv,json,zipfile
from pathlib import Path

def report(source,output):
    if source.suffix=='.zip':
        with zipfile.ZipFile(source) as z:
            if z.testzip():raise ValueError('ZIP CRC mismatch')
            data=json.loads(z.read('delivery-diagnostics.json'))
    else:data=json.loads(source.read_text(encoding='utf-8-sig'))
    if data.get('schema') not in ('aiconnector.diagnostics.v1','aiconnector.delivery-diagnostics.v1'):raise ValueError('unexpected diagnostics schema')
    windows=data.get('windows',[])
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=['source','pid','window_start','window_end','elapsed_ms','cpu_ms','cpu_sample_max_ms','partial','accounted_ms','unaccounted_ms','stages','operations'])
        writer.writeheader()
        for w in windows:
            accounted=sum(s['wall_ms'] for s in w['segments']);phases={}
            for s in w['segments']:
                name=(s.get('parent_stage','')+' / ' if s.get('parent_stage') else '')+s['stage']
                phases[name]=phases.get(name,0)+s['wall_ms']
            writer.writerow({**{n:w.get(n) for n in ['source','pid','window_start','window_end','elapsed_ms','cpu_ms','cpu_sample_max_ms','partial']},
                'accounted_ms':round(accounted,3),'unaccounted_ms':round(w['elapsed_ms']-accounted,3),
                'stages':'; '.join(f'{k}: {v:.3f} ms' for k,v in sorted(phases.items(),key=lambda x:-x[1])),
                'operations':'; '.join(sorted({s.get('action','')+':'+s.get('operation_id','') for s in w['segments']}))})
    return len(windows)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    print(json.dumps({'windows':report(a.source,a.output),'output':str(a.output)}))
