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
           f'All required Windows service, recovery and paired Flush performance jobs passed before publication.\n\n'
           f'Validation: https://github.com/{repo}/actions/runs/{os.environ["GITHUB_RUN_ID"]}\n\n'
           '0.7.10 allows overdue Poll to enter the serial queue during other runs\' start/delivery and active Flush. Repeated Poll requests share one queued or executing request. At a request boundary, a Poll waiting ten seconds or bypassed by four foreground dispatches gets a turn; active requests are never interrupted. '
           'Local state persistence serializes the ledger once instead of recursively canonicalizing every field. Exact-byte SHA-256, atomic durable writes and unchanged projections are preserved; protocol/event/artifact hashes are unchanged. Per-receipt diagnostics, persisted retry budgets and safe closed outbox compaction remain in place. Ten-second samples remain local and never create periodic network writes. '
           'No active HTTP/SSH is preempted or replayed. Owner-bound recovery, machine reservations, durable write pacing and receiver hash validation are preserved. '
           'Upgrade both endpoints using existing config and state. No quantified intranet performance improvement is claimed. '
           f'Details and Windows acceptance: https://github.com/{repo}/blob/{commit}/docs/POLL-AND-FLUSH-0710.md\n\n'
           'Fixture acceptance does not claim verification of the intranet proxy or A5 hardware.\n')
    with tempfile.NamedTemporaryFile(mode='w',suffix='.md') as f:
        f.write(notes);f.flush()
        # Never replace existing assets or releases silently; reruns fail visibly.
        subprocess.run(['gh','release','create',tag,str(package),str(package.with_suffix('.zip.sha256')),
            '--repo',repo,'--target',commit,'--prerelease','--latest=false','--title','AIConnector '+tag,'--notes-file',f.name],check=True)

if __name__=='__main__':main()
