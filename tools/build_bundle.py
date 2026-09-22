"""Build a small Windows-ready source bundle using only Python's standard library."""
import hashlib
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
out = root / "dist"
out.mkdir(exist_ok=True)
archive = out / "AIConnector-Probe.zip"
files = ("Probe.ps1", "Run-Windows.cmd", "probe.config.json", "README.md")
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for name in files:
        data = (root / name).read_bytes()
        if name == "Probe.ps1" and not data.startswith(b"\xef\xbb\xbf"):
            raise ValueError("Probe.ps1 must have a UTF-8 BOM for Windows PowerShell 5.1")
        info = zipfile.ZipInfo("AIConnector-Probe/" + name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(info, data)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(out / "AIConnector-Probe.zip.sha256").write_text(f"{checksum}  {archive.name}\n")
print(f"{archive}\n{archive.stat().st_size} bytes\nSHA-256 {checksum}")
