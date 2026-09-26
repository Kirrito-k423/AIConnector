"""Hash-verify and extract a clean package; run the actual two-node service acceptance from it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import zipfile

ROOT=Path(__file__).resolve().parents[1]

def validate(archive):
    with tempfile.TemporaryDirectory(prefix='AIConnector 安装包 ')as folder:
        dest=Path(folder)
        with zipfile.ZipFile(archive)as z:
            z.extractall(dest)
            if os.name!='nt':
                for entry in z.infolist():(dest/entry.filename).chmod((entry.external_attr>>16)&0o777)
        app=dest/'AIConnector-Service';manifest=json.loads((app/'package-manifest.json').read_text())
        for file,digest in manifest['sha256'].items():assert hashlib.sha256((app/file).read_bytes()).hexdigest()==digest,file
        node=app/'runtime'/('node.exe' if os.name=='nt' else 'node')
        pwsh='powershell.exe' if os.name=='nt' else str(app/'runtime/pwsh/pwsh')
        env=dict(os.environ,AIC_NODE=str(node),AIC_SERVICE_ROOT=str(app),PWSH=pwsh,PYTHONUTF8='1',AICONNECTOR_NO_PAUSE='1')
        # Run the integration suite against the delivered modules and pinned SDK,
        # including Windows System32 curl and real automatic context compaction.
        shutil.copytree(ROOT/'tests/service',app/'tests/service',ignore=shutil.ignore_patterns('__pycache__'))
        cases=sorted(str(p) for p in (app/'tests/service').glob('*.test.mjs'))
        subprocess.run([str(node),'--test','--test-concurrency=1',*cases],cwd=app,env=env,check=True)
        # Original source tests, delivered server/worker/Pi/runtime; no npm or installed Node used.
        subprocess.run([os.sys.executable,'-m','unittest','discover','-s',str(ROOT/'tests/service'),'-p','test_e2e.py','-v'],env=env,check=True)
        if os.name=='nt':
            script=app/'Connector.ps1';Path(str(script)+':Zone.Identifier').write_text('[ZoneTransfer]\nZoneId=3\n')
            env['PSExecutionPolicyPreference']='RemoteSigned'
            p=subprocess.run(['cmd.exe','/d','/c','Prepare-Windows-Service.cmd'],cwd=app,env=env,input='Y\n',text=True,capture_output=True)
            assert p.returncode==0,p.stdout+p.stderr
            assert not Path(str(script)+':Zone.Identifier').exists()
            script.write_bytes(script.read_bytes()+b'\n#tampered')
            p=subprocess.run(['cmd.exe','/d','/c','Prepare-Windows-Service.cmd'],cwd=app,env=env,text=True,capture_output=True)
            assert p.returncode!=0 and 'CHECKSUM_MISMATCH' in p.stdout,p.stdout+p.stderr
        print(json.dumps(dict(package=archive.name,bytes=archive.stat().st_size,sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),verified_files=len(manifest['sha256']),real_packaged_pi=True,real_windows=os.name=='nt',fixture_model=True)))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('archive',type=Path);validate(p.parse_args().archive)
