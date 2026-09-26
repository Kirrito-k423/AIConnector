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
FILES=['Connector.ps1','connector.config.json','package.json','package-lock.json','CONTEXT.md',
       'Open-Windows-Dashboard.cmd','Install-Windows-Service.cmd','Prepare-Windows-Service.cmd',
       'Open-Mac-Dashboard.command','Install-Mac-Service.command','docs/SERVICE.md','docs/PROTOCOL.md','docs/RELAY.md']

def build(output,node,pwsh=None):
    system='windows' if os.name=='nt' else 'macos' if sys.platform=='darwin' else 'linux'
    arch=subprocess.check_output([str(node),'-p','process.arch'],text=True).strip()
    output.mkdir(parents=True,exist_ok=True)
    target=output/f'AIConnector-Service-{system}-{arch}.zip'
    records={}
    payload={name:ROOT/name for name in FILES}
    payload.update({p.relative_to(ROOT).as_posix():p for p in (ROOT/'service').rglob('*') if p.is_file()})
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
            if p.is_file():payload['runtime/pwsh/'+p.relative_to(pwsh).as_posix()]=p
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
        manifest=dict(schema='aiconnector.package.v1',version='0.4.0',platform=system,arch=arch,
                      node=subprocess.check_output([str(node),'--version'],text=True).strip(),pi='0.87.1',sha256=records)
        z.writestr('AIConnector-Service/package-manifest.json',json.dumps(manifest,indent=2)+'\n')
    digest=hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n')
    print(json.dumps(dict(file=str(target),bytes=target.stat().st_size,sha256=digest)))
    return target

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,default=ROOT/'dist/service');p.add_argument('--node',type=Path,default=Path(shutil.which('node')));p.add_argument('--pwsh-home',type=Path)
    a=p.parse_args();build(a.output,a.node,a.pwsh_home)
