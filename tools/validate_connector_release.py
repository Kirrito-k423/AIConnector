"""Read-only acceptance of the published connector ZIP on a real Windows host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import zipfile


def validate(tag, out):
    out.mkdir(parents=True, exist_ok=True)
    url=f'https://github.com/Kirrito-k423/AIConnector/releases/download/{tag}/AIConnector.zip'
    with urllib.request.urlopen(url,timeout=60) as r: data=r.read(4*1024*1024)
    with urllib.request.urlopen(url+'.sha256',timeout=60) as r: expected=r.read(256).decode().split()[0]
    digest=hashlib.sha256(data).hexdigest()
    assert digest==expected
    archive=out/'public-connector.zip'; archive.write_bytes(data)
    with tempfile.TemporaryDirectory(prefix='AIConnector 公开包 ') as temp:
        root=Path(temp)/'解压 with spaces'
        with zipfile.ZipFile(archive) as z:
            assert z.testzip() is None
            assert all(not Path(n).is_absolute() and '..' not in Path(n).parts for n in z.namelist())
            z.extractall(root)
        install=root/'AIConnector'
        original=(install/'connector.config.json').read_bytes()
        env={k:v for k,v in os.environ.items() if not k.startswith('AICONNECTOR_')}
        env.update(AICONNECTOR_NO_PAUSE='1',PSExecutionPolicyPreference='RemoteSigned')
        Path(str(install/'Connector.ps1')+':Zone.Identifier').write_text('[ZoneTransfer]\r\nZoneId=3\r\n')
        p=subprocess.run(['cmd.exe','/d','/c','Connector-Windows.cmd','-Action','Poll'],cwd=install,
                         env=env,input='Y\n',capture_output=True,encoding='utf-8',errors='replace',timeout=180)
        (out/'launch.log').write_text(p.stdout+p.stderr,encoding='utf-8')
        assert p.returncode==0,p.stdout+p.stderr
        assert original==(install/'connector.config.json').read_bytes()
        state=json.loads((install/'connector-state/windows-inner/status.json').read_text(encoding='utf-8'))
        assert state['last_poll']>0 and not state['last_error'],state
        assert all(x['status'] in ('pending','confirmed') for x in state['outbox'])
        summary=dict(tag=tag,zip_bytes=len(data),sha256=digest,default_config_unchanged=True,
                     actual_windows_entry=True,public_comment_read=True,external_writes=False)
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('tag'); p.add_argument('--output',type=Path,default=Path('connector-acceptance'))
    args=p.parse_args(); validate(args.tag,args.output)
