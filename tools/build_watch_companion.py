"""Build the pinned optional SHW update; copy no config, credentials or task state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
def build(source,output):
    pin=json.loads((ROOT/'service/watch-companion.json').read_text())
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
    if revision!=pin['revision']:raise ValueError('companion source revision mismatch')
    # Avoid building a dirty source tree whose bytes are not identified by the pin.
    if subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=source,text=True).strip():raise ValueError('companion source is modified')
    output.mkdir(parents=True,exist_ok=True)
    binary=output/('simpleHtmlWatch.exe' if os.name=='nt' else 'simpleHtmlWatch')
    subprocess.run(['go','build','-trimpath','-ldflags',f'-s -w -X main.version={pin["version"]}','-o',str(binary.resolve()),'.'],cwd=source,env=dict(os.environ,CGO_ENABLED='0'),check=True)
    for name in ['README.md','LICENSE','AI-START-HERE.md']:
        shutil.copy2(source/name,output/name)
    for name in ['atomic-group-reservations.md','service-lifecycle.md','task-controller.md']:
        (output/'docs').mkdir(exist_ok=True);shutil.copy2(source/'docs'/name,output/'docs'/name)
    shutil.copytree(source/'skills/cluster-task-controller',output/'skills/cluster-task-controller',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    goroot=Path(subprocess.check_output(['go','env','GOROOT'],text=True).strip())
    license_file=next(p for p in [goroot/'LICENSE',goroot.parent/'LICENSE'] if p.is_file())
    shutil.copy2(license_file,output/'Go-LICENSE')
    for module in ['golang.org/x/crypto','golang.org/x/sys']:
        directory=Path(subprocess.check_output(['go','list','-m','-f','{{.Dir}}',module],cwd=source,text=True).strip())
        shutil.copy2(directory/'LICENSE',output/(module.rsplit('/',1)[1]+'-LICENSE'))
    (output/'version.json').write_text(json.dumps({**pin,'platform':sys.platform,'binary':binary.name,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest()},indent=2)+'\n')
    print(json.dumps({'companion':str(output),'source':revision,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();build(a.source,a.output)
