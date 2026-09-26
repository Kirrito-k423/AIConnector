"""Maintainer opt-in synthetic public handoff; both nodes run locally, no NPU or SSH."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def validate(pwsh, out):
    out.mkdir(parents=True, exist_ok=True)
    run = 'run-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
    key = 'relay-layout-smoke/1/'+run
    config = json.loads((ROOT/'connector.config.json').read_text())
    assert config['repository'] == 'Kirrito-k423/AIConnector-Relay'
    token = subprocess.check_output(['gh','auth','token'], text=True).strip()
    env = dict(os.environ, AICONNECTOR_GITHUB_TOKEN=token)
    proxy = os.environ.get('HTTPS_PROXY', 'system')
    log = []

    def call(node, action, *args):
        p = subprocess.run([pwsh,'-NoProfile','-File',str(ROOT/'Connector.ps1'),'-Node',node,
                            '-Action',action,'-StateDir',str(out/node),'-Proxy',proxy,*map(str,args)],
                           env=env,capture_output=True,text=True,timeout=180)
        lines = [json.loads(x) for x in p.stdout.splitlines() if x.startswith('{')]
        assert lines, 'Connector returned no JSON'
        value = lines[-1]
        log.append(dict(node=node,action=action,exit_code=p.returncode,value=value))
        (out/'actions.json').write_text(json.dumps(log,ensure_ascii=False,indent=2))
        if p.returncode: raise RuntimeError(json.dumps(value))
        return value

    def until(node, phase):
        for _ in range(8):
            status = call(node,'Poll')
            match = next((r for r in status['runs'] if r['key']==key),None)
            if match and match['phase']==phase: return match
            time.sleep(4)
        raise RuntimeError('Phase not reached: '+phase)

    archive=out/'synthetic.zip'
    with zipfile.ZipFile(archive,'w') as z:
        z.writestr(zipfile.ZipInfo('README.txt',(2026,1,1,0,0,0)), b'AIConnector relay layout synthetic fixture. No private data, SSH or NPU.\n')
    artifact=call('mac-outer','Upload','-Key',key,'-File',archive)
    task=dict(task_id='relay-layout-smoke',revision=1,run_id=run,title='专用 Relay 布局合成验收',
              objective='验证独立任务 Issue、运行 Release、ZIP 和五阶段交接；两端均为本机进程，不访问 SSH/NPU。',
              code=dict(repository='local-synthetic',revision='relay-layout-v1'),environment=dict(target='mac-local-two-nodes'),
              invocation=dict(entry='synthetic-transport-check',arguments=[]),acceptance=['五阶段事件、双向 ZIP 校验、重启后不重复领取。'],artifacts=[artifact])
    taskfile=out/'task.json'; taskfile.write_text(json.dumps(task,ensure_ascii=False))
    call('mac-outer','Submit','-File',taskfile); until('mac-outer','task'); until('windows-inner','accepted')
    assert call('windows-inner','Claim','-Key',key)['execute'] is True
    result_zip=out/'result.zip'
    with zipfile.ZipFile(result_zip,'w') as z:
        z.writestr(zipfile.ZipInfo('result.json',(2026,1,1,0,0,0)), b'{"synthetic":true,"npu":false,"result":"transport fixture completed"}\n')
    result_artifact=call('windows-inner','Upload','-Key',key,'-File',result_zip)
    assert result_artifact['sha256']==hashlib.sha256(result_zip.read_bytes()).hexdigest()
    assert artifact['sha256']!=result_artifact['sha256']
    result=dict(outcome='succeeded',exit_code=0,actual_revision='relay-layout-v1',
                summary='合成通道验收：输入 ZIP 已接收，输出 ZIP 已上传。没有运行 NPU 实验。',
                metrics=dict(synthetic=True,real_npu=False),artifacts=[result_artifact])
    resultfile=out/'result.json'; resultfile.write_text(json.dumps(result,ensure_ascii=False))
    call('windows-inner','Complete','-Key',key,'-File',resultfile)
    until('windows-inner','result'); completed=until('mac-outer','receipt'); until('windows-inner','receipt')
    assert call('windows-inner','Claim','-Key',key)['execute'] is False
    summary=dict(key=key,issue=completed['issue_url'],release=completed['release_url'],
                 phase=completed['phase'],timeline=completed['timeline'],input_zip_bytes=archive.stat().st_size,
                 result_zip_bytes=result_zip.stat().st_size,distinct_input_and_result=True,
                 actual_github_write_readback=True,two_processes_same_mac=True,user_intranet=False,npu=False)
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--write-synthetic',action='store_true',required=True)
    p.add_argument('--pwsh',default=os.environ.get('PWSH','pwsh'))
    p.add_argument('--output',type=Path,default=ROOT/'reports/relay-live')
    args=p.parse_args();validate(args.pwsh,args.output)
