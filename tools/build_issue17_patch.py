"""Build the small, source-bound repair; never include config, vault or state."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_SHA = '7577a6b332702ff41292b9dabae20ae13da3e4224a0d4e9be013b9f977fc295a'
ORIGINAL_VARIANTS = [ORIGINAL_SHA,
    'e48151d75acd2482d685ad76ccaa4d34532b463923c129fefa0d2f945d1b6536',
    '17c2a95594caa83b2d136a1e36adb53a5e8f1cb98be6bac1e8a2407c39518587',
    '4a8fe118d772433bcb6fb367fd4093ddca904d73dcc3b2190aa62631b7ff1614']

def build(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    members = {
        'Repair-Issue17.cmd': (ROOT / 'tools/repair_issue17.cmd').read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'),
        'repair_issue17.mjs': (ROOT / 'tools/repair_issue17.mjs').read_bytes().replace(b'\r\n', b'\n'),
        'Connector.ps1': (ROOT / 'Connector.ps1').read_bytes().replace(b'\r\n', b'\n'),
        'README.md': (ROOT / 'docs/ISSUE-17-FIX.md').read_bytes().replace(b'\r\n', b'\n'),
    }
    members['repair-manifest.json'] = (json.dumps({
        'schema': 'aiconnector.connector-patch.v1', 'patch_id': 'issue17',
        'original_sha256': ORIGINAL_SHA,
        'original_sha256_variants': ORIGINAL_VARIANTS,
        'patched_sha256': hashlib.sha256(members['Connector.ps1']).hexdigest(),
    }, indent=2) + '\n').encode()
    output = destination / 'AIConnector-Issue17-Windows-Patch.zip'
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in members.items():
            item = zipfile.ZipInfo(name, (2026, 10, 14, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, content)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(members)
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(checksum + '  ' + output.name + '\n')
    print(json.dumps({'path': str(output), 'bytes': output.stat().st_size, 'sha256': checksum}))
    return output

if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'dist/issue17')
