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
        if 'watch-companion/version.json' not in manifest['sha256']:raise ValueError('offline group controller missing')
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
           f'All required Windows service, recovery and paired Flush performance jobs passed before publication.\n\n'
           f'Validation: https://github.com/{repo}/actions/runs/{os.environ["GITHUB_RUN_ID"]}\n\n'
           f'{version} fixes Issues #20 and #21: new encrypted data parts use 768 KiB plaintext and stay below 1,000,000 ZIP bytes; historical 3 MiB parts remain readable. '
           'Capability publication leaves the background queue and gets a fair turn after 60 seconds or 12 foreground bypasses, alongside existing Poll fairness. Capabilities are captured on dispatch and freshness uses the confirmed generation timestamp. '
           'Previously sealed oversized parts remain immutable: use a new task revision and run ID (or new task ID) with a newly bound encrypted request to regenerate smaller parts; resending the same run or RetryRejected does not rechunk it. '
           'Age encryption, resume, ownership and shared-machine reservations remain included. '
           'The package retains the pinned offline simpleHtmlWatch controller, original configuration, data directory and unknown task/reservation state. '
           f'Setup and acceptance: https://github.com/{repo}/blob/{commit}/docs/TRANSFER-AND-CAPABILITIES-0717.md\n\n'
           'CI fixture acceptance does not prove deployment or a successful retest through the actual intranet proxy.\n')
    with tempfile.NamedTemporaryFile(mode='w',suffix='.md') as f:
        f.write(notes);f.flush()
        # Never replace existing assets or releases silently; reruns fail visibly.
        subprocess.run(['gh','release','create',tag,str(package),str(package.with_suffix('.zip.sha256')),
            '--repo',repo,'--target',commit,'--prerelease','--latest=false','--title','AIConnector '+tag,'--notes-file',f.name],check=True)

if __name__=='__main__':main()
