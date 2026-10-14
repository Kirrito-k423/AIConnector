"""Portable service bundle. Run on the target platform after npm ci. No secrets/state copied."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[1]
FILES=['Connector.ps1','connector.config.json','package.json','package-lock.json','CONTEXT.md','tools/benchmark_profile_workflow.mjs','tools/profile_contract.mjs','tools/validate_group_bridge.mjs','docs/ISSUE-14-FIX.md','docs/EXECUTION-0712.md','docs/evidence/profile-0711-macos.json',
       'docs/SERVER-CATALOG-0714.md','docs/FILE-TRANSFER-0715.md','docs/ISSUE-15-FIX.md','docs/SHARED-SCHEDULING-0716.md','tools/npu_health_gate.py','tools/enable_owned_transfer.mjs','tools/enable_owned_transfer.cmd',
       'Open-Windows-Dashboard.cmd','Install-Windows-Service.cmd','Prepare-Windows-Service.cmd',
       'Open-Mac-Dashboard.command','Install-Mac-Service.command','Upgrade-Windows.cmd','docs/SERVICE.md','docs/PI-INTEGRATION.md','docs/EXECUTION-ACCEPTANCE.md','docs/SERVER-SETUP.md','docs/PROTOCOL.md','docs/RELAY.md','docs/ISSUE-7-8-FIX.md','docs/ISSUE-9-FIX.md','docs/ISSUE-11-FIX.md','docs/ISSUE-13-FIX.md','docs/PARALLEL-OPERATIONS.md','docs/TRANSPORT-PERFORMANCE.md','docs/TRANSPORT-075.md','docs/TRANSPORT-076.md','docs/TRANSPORT-077.md','docs/TRANSPORT-078.md','docs/TRANSPORT-079.md','docs/POLL-AND-FLUSH-0710.md','docs/PROFILE-AND-MODEL-0711.md','docs/evidence/flush-0710-macos.json','tools/report_windows.py']

def build(output,node,pwsh=None,watch_home=None):
    system='windows' if os.name=='nt' else 'macos' if sys.platform=='darwin' else 'linux'
    arch=subprocess.check_output([str(node),'-p','process.arch'],text=True).strip()
    output.mkdir(parents=True,exist_ok=True)
    target=output/f'AIConnector-Service-{system}-{arch}.zip'
    records={}
    payload={name:ROOT/name for name in FILES}
    payload.update({p.relative_to(ROOT).as_posix():p for p in (ROOT/'service').rglob('*') if p.is_file()})
    if watch_home:
        companion=json.loads((watch_home/'version.json').read_text());pin=json.loads((ROOT/'service/watch-companion.json').read_text())
        if companion['revision']!=pin['revision']:raise ValueError('companion revision mismatch')
        if hashlib.sha256((watch_home/companion['binary']).read_bytes()).hexdigest()!=companion['binary_sha256']:raise ValueError('companion binary checksum mismatch')
        for p in watch_home.rglob('*'):
            if p.is_file() and not p.is_symlink():payload['watch-companion/'+p.relative_to(watch_home).as_posix()]=p
    for p in (ROOT/'node_modules').rglob('*'):
        if not p.is_file() or p.is_symlink():continue
        rel=p.relative_to(ROOT).as_posix();parts=rel.split('/')
        if '.bin' in parts or rel.endswith(('.map','.d.ts','.d.ts.map')):continue
        if '@esbuild' in parts:
            native=parts[parts.index('@esbuild')+1]
            if native!=('win32' if system=='windows' else 'darwin' if system=='macos' else 'linux')+'-'+arch:continue
        payload[rel]=p
    payload['runtime/node.exe' if os.name=='nt' else 'runtime/node']=node
    license=next((p for p in [node.parent/'LICENSE',node.parent.parent/'LICENSE',ROOT/'service/licenses/node-LICENSE'] if p.exists()),None)
    if not license:raise ValueError('Node distribution LICENSE missing')
    payload['runtime/node-LICENSE']=license
    if system=='macos':
        if not pwsh:raise ValueError('Mac portable delivery requires --pwsh-home')
        for p in pwsh.rglob('*'):
            if p.is_file() and not p.name.endswith(('.tar.gz','.zip')):payload['runtime/pwsh/'+p.relative_to(pwsh).as_posix()]=p
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6)as z:
        for name,src in sorted(payload.items()):
            data=src.read_bytes()
            if name in FILES or name.startswith('service/'):
                data=data.replace(b'\r\n',b'\n')
                if name=='Prepare-Windows-Service.cmd':
                    for marker,f in [('__SERVICE_CONNECTOR_SHA__','Connector.ps1'),('__SERVICE_INSTALL_SHA__','service/install-windows.ps1')]:
                        raw=(ROOT/f).read_bytes().replace(b'\r\n',b'\n');data=data.replace(marker.encode(),hashlib.sha256(raw).hexdigest().encode())
                if name.endswith('.cmd'):data=data.replace(b'\n',b'\r\n')
            records[name]=hashlib.sha256(data).hexdigest()
            info=zipfile.ZipInfo('AIConnector-Service/'+name,(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            executable=name.endswith('.command')or name in ['runtime/node','runtime/pwsh/pwsh']or bool(src.stat().st_mode&0o111)
            info.create_system=3;info.external_attr=(0o100755 if executable else 0o100644)<<16
            z.writestr(info,data)
        revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
        manifest=dict(schema='aiconnector.package.v1',version=json.loads((ROOT/'package.json').read_text())['version'],source_revision=revision,platform=system,arch=arch,
                      node=subprocess.check_output([str(node),'--version'],text=True).strip(),pi='0.87.1',sha256=records)
        z.writestr('AIConnector-Service/package-manifest.json',json.dumps(manifest,indent=2)+'\n')
    digest=hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n')
    print(json.dumps(dict(file=str(target),bytes=target.stat().st_size,sha256=digest)))
    return target

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,default=ROOT/'dist/service');p.add_argument('--node',type=Path,default=Path(shutil.which('node')));p.add_argument('--pwsh-home',type=Path);p.add_argument('--watch-home',type=Path)
    a=p.parse_args();build(a.output,a.node,a.pwsh_home,a.watch_home)
