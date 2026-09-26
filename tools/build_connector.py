"""Build the actual PS5.1/PS7 connector delivery, without external dependencies."""
import argparse
import hashlib
import io
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.3.0'
FILES = ['Connector.ps1', 'connector.config.json', 'Connector-Windows.cmd',
         'Start-Windows-Connector.cmd', 'Start-Mac-Connector.command',
         'docs/CONNECTOR.md', 'docs/PROTOCOL.md', 'CONTEXT.md',
         'examples/task.json', 'examples/result.json', 'examples/connector.legacy.config.json',
         'docs/RELAY.md']


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    files = {name: (ROOT/name).read_bytes().replace(b'\r\n', b'\n') for name in FILES}
    script = files['Connector.ps1']
    if not script.startswith(b'\xef\xbb\xbf'):
        raise ValueError('PS5.1 requires UTF-8 BOM')
    files['Connector-Windows.cmd'] = files['Connector-Windows.cmd'].replace(
        b'__CONNECTOR_SHA256__', hashlib.sha256(script).hexdigest().encode())
    for name in files:
        if name.endswith('.cmd'): files[name] = files[name].replace(b'\n', b'\r\n')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as archive:
        for name, data in sorted(files.items()):
            item = zipfile.ZipInfo('AIConnector/'+name, (2026, 1, 1, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.create_system = 3
            item.external_attr = (0o100755 if name.endswith('.command') else 0o100644) << 16
            archive.writestr(item, data)
    path = output/'AIConnector.zip'
    path.write_bytes(out.getvalue())
    digest = hashlib.sha256(out.getvalue()).hexdigest()
    (output/'AIConnector.zip.sha256').write_bytes(f'{digest}  AIConnector.zip\n'.encode())
    print(f'{path}\n{path.stat().st_size} bytes\nSHA-256 {digest}')
    return path


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, default=ROOT/'dist/connector')
    build(p.parse_args().output)
