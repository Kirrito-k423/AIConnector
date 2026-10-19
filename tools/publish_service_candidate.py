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
           f'{version} recovers stale GitHub starter upload placeholders that previously caused ASSET_CONFLICT. '
           'Cleanup requires durable local upload intent, the verified run and content-addressed name, a grace period, two observations and a fresh asset read. '
           'Completed assets are verified and reused; ambiguous DELETE responses reconcile before any reupload, and provider cooldowns remain enforced. '
           'Per-run HTTP upload timing is retained separately from polling and retry logs for concurrency analysis. '
           'Eight in-flight encrypted data parts remain the default. '
           f'Setup, live evidence and acceptance: https://github.com/{repo}/blob/{commit}/docs/TRANSFER-RECOVERY-0720.md\n\n'
           'CI fixture acceptance does not prove deployment or a successful retest through the actual intranet proxy.\n')
    with tempfile.NamedTemporaryFile(mode='w',suffix='.md') as f:
        f.write(notes);f.flush()
        # Never replace existing assets or releases silently; reruns fail visibly.
        subprocess.run(['gh','release','create',tag,str(package),str(package.with_suffix('.zip.sha256')),
            '--repo',repo,'--target',commit,'--prerelease','--latest=false','--title','AIConnector '+tag,'--notes-file',f.name],check=True)

if __name__=='__main__':main()
