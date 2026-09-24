"""Live synthetic ZIP transfer on a hosted Windows runner, never an intranet claim."""
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
out = Path('zip-transfer-evidence').resolve()
out.mkdir(exist_ok=False)
config = json.loads((ROOT / 'probe.config.json').read_text())
config['channels'] = [c for c in config['channels'] if c['provider'] == 'github']
request = urllib.request.Request(
    'https://api.github.com/repos/Kirrito-k423/AIConnector/issues/2/comments?per_page=100',
    headers={'User-Agent': 'AIConnector-ZIP-validation',
             'Authorization': 'Bearer ' + os.environ['AICONNECTOR_GITHUB_TOKEN']})
with urllib.request.urlopen(request, timeout=60) as response:
    comments = json.load(response)
assert isinstance(comments, list) and len(comments) < 100, 'Need complete comment page'
mac = []
for comment in comments:
    match = re.match(r'AIConnector probe v1\n\n```json\n(.+?)\n```', comment['body'], re.S)
    if not match:
        continue
    packet = json.loads(match[1])
    if (packet.get('kind') == 'attachment' and packet.get('sender') == 'mac-outer'
            and packet.get('name', '').endswith('.zip')
            and packet.get('url', '').startswith(
                'https://github.com/Kirrito-k423/AIConnector/releases/download/probe-artifacts/')):
        mac.append(packet)
assert mac, 'No actual Mac-published ZIP to receive'
source = mac[-1]
config['downloads'] = [{'name': 'mac-live-zip', 'url': source['url'], 'sha256': source['sha256']}]
config_path = out / 'settings.json'
config_path.write_text(json.dumps(config), encoding='utf-8')
pwsh = os.environ.get('PWSH', 'powershell.exe')
base = [pwsh, '-NoLogo', '-NoProfile', '-File', str(ROOT / 'Probe.ps1'),
        '-Config', str(config_path), '-OutputDir', str(out), '-Node', 'windows-ci',
        '-Proxy', 'direct', '-TimeoutSeconds', '60']
for mode, extra in [('Scan', []), ('Write', ['-ResumeUploads', '-Peer', 'mac-outer', '-Session', 'zip-v015-ci'])]:
    with (out / (mode.lower() + '.log')).open('w', encoding='utf-8') as log:
        result = subprocess.run(base + ['-Mode', mode, *extra], stdout=log,
                                stderr=subprocess.STDOUT, timeout=360)
    assert result.returncode == 0, f'{mode} process failed; inspect evidence'
    reports = list(out.glob(f'windows-ci-{mode.lower()}-*.json'))
    assert len(reports) == 1
    report = json.loads(reports[0].read_text(encoding='utf-8'))
    assert report['platform'] == 'Win32NT' and report['powershell'].startswith('5.1.')
    rows = {r['test']: r for r in report['observations']}
    key = 'download/mac-live-zip' if mode == 'Scan' else 'github/release/result-128KiB.zip'
    assert rows[key]['status'] == 'EXACT_BYTES_VERIFIED', rows
    if mode == 'Write':
        uploaded = rows[key]['evidence']
summary = {'environment': 'GitHub-hosted Windows, not user intranet',
           'mac_to_windows_ci': {'url': source['url'], 'sha256': source['sha256']},
           'windows_ci_uploaded_zip': uploaded}
(out / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
print(json.dumps(summary, indent=2))
