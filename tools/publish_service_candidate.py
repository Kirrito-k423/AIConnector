"""Publish the exact tested Windows artifact from the candidate workflow."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

def validate(tag, folder, version):
    if not re.fullmatch(r'v'+re.escape(version)+r'-rc\.[1-9][0-9]*', tag):
        raise ValueError('candidate tag must match the checked out package version')
    package=folder/'AIConnector-Service-windows-x64.zip'
    digest=hashlib.sha256(package.read_bytes()).hexdigest()
    if package.with_suffix('.zip.sha256').read_text().split()[0]!=digest:
        raise ValueError('package checksum mismatch')
    with zipfile.ZipFile(package) as z:
        manifest=json.loads(z.read('AIConnector-Service/package-manifest.json'))
        if manifest['version']!=version or manifest['platform']!='windows' or manifest['arch']!='x64':
            raise ValueError('package identity mismatch')
        for name, expected in manifest['sha256'].items():
            if hashlib.sha256(z.read('AIConnector-Service/'+name)).hexdigest()!=expected:
                raise ValueError('package member checksum mismatch')
    return package

def main():
    tag,folder=sys.argv[1],Path(sys.argv[2])
    version=json.loads(Path('package.json').read_text())['version']
    package=validate(tag,folder,version)
    repo=os.environ['GITHUB_REPOSITORY'];commit=os.environ['GITHUB_SHA']
    if not re.fullmatch(r'[0-9a-f]{40}',commit):raise ValueError('full source SHA required')
    def gh(*args):return subprocess.run(['gh',*args],capture_output=True,text=True,check=True).stdout
    try:
        ref=json.loads(gh('api',f'repos/{repo}/git/ref/tags/{tag}'))['object']
    except subprocess.CalledProcessError as e:
        if '404' not in e.stderr:raise
        ref=None
    if ref:
        if ref['type']=='tag':ref=json.loads(gh('api',f'repos/{repo}/git/tags/'+ref['sha']))['object']
        if ref['type']!='commit' or ref['sha']!=commit:raise ValueError('tag belongs to another source revision')
    notes=(f'Windows candidate built from `{commit}` and verified after fresh extraction. '
           f'All three Windows service workflow jobs passed before publication.\n\n'
           f'Validation: https://github.com/{repo}/actions/runs/{os.environ["GITHUB_RUN_ID"]}\n\n'
           '0.7.5 reuses a resident PowerShell transport, HTTP connections and unchanged snapshots, and drains up to four ready events within a bounded batch. '
           'A freshly uploaded result ZIP can be announced before sender public redownload; Mac still downloads and verifies the artifact before receipt. Ambiguous uploads and existing assets still require sender content reconciliation. '
           'Owner-bound Claim recovery, machine reservations, durable write pacing and ten-second polling are preserved. Upgrade both endpoints using the existing config and state. '
           f'Details and Windows acceptance: https://github.com/{repo}/blob/{commit}/docs/TRANSPORT-075.md\n\n'
           'Fixture acceptance does not claim verification of the intranet proxy or A5 hardware.\n')
    with tempfile.NamedTemporaryFile(mode='w',suffix='.md') as f:
        f.write(notes);f.flush()
        # Never replace existing assets or releases silently; reruns fail visibly.
        subprocess.run(['gh','release','create',tag,str(package),str(package.with_suffix('.zip.sha256')),
            '--repo',repo,'--target',commit,'--prerelease','--latest=false','--title','AIConnector '+tag,'--notes-file',f.name],check=True)

if __name__=='__main__':main()
