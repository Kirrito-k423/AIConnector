"""Deterministic, dependency-free release bundle and synthetic download fixtures."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.1.4"
RELEASE = f"https://github.com/Kirrito-k423/AIConnector/releases/download/v{VERSION}/"


def make_zip(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 0
            archive.writestr(info, data)
    return out.getvalue()


def fixtures():
    prefix = "AIConnector 合成测试数据 / 中文 / newline\n".encode()
    binary = b"".join(hashlib.sha256(f"AIConnector-{n}".encode()).digest() for n in range(32768))
    return {
        "sample-1KiB.txt": prefix + b"x" * (1024 - len(prefix)),
        "sample-32KiB.txt": prefix + b"x" * (32768 - len(prefix)),
        "sample.json": '{"synthetic":true,"note":"中文","latency_us":12.5}\n'.encode(),
        "sample.csv": b"rank,latency_us\n0,12.5\n1,13.5\n",
        "sample.png": base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwaDgAAAJUAXHIMWMAAAAAAElFTkSuQmCC"),
        "sample-1MiB.bin": binary,
        "sample-128KiB.zip": make_zip({"sample.bin": binary[:131072]}),
    }


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    samples = fixtures()
    config = json.loads((ROOT / "probe.config.json").read_text())
    for row in config["downloads"]:
        name = row["name"]
        if row["url"] != RELEASE + name or row["sha256"] != hashlib.sha256(samples[name]).hexdigest():
            raise ValueError("Preset does not match release fixture: " + name)
    if len(config["downloads"]) != len(samples):
        raise ValueError("Every release fixture must be in the default scan")
    files = {name: (ROOT / name).read_bytes() for name in ("Probe.ps1", "Run-Windows.cmd", "Run-Windows-Write.cmd", "probe.config.json", "README.md")}
    for name in ("Probe.ps1", "probe.config.json", "README.md"):
        files[name] = files[name].replace(b"\r\n", b"\n")
    if not files["Probe.ps1"].startswith(b"\xef\xbb\xbf"):
        raise ValueError("Probe.ps1 requires UTF-8 BOM for Windows PowerShell 5.1")
    # Normalize regardless of checkout platform, and bind launcher to exact script.
    cmd = files["Run-Windows.cmd"].decode("ascii").replace("\r\n", "\n")
    cmd = cmd.replace("__PROBE_SHA256__", hashlib.sha256(files["Probe.ps1"]).hexdigest())
    files["Run-Windows.cmd"] = cmd.replace("\n", "\r\n").encode("ascii")
    files["Run-Windows-Write.cmd"] = files["Run-Windows-Write.cmd"].replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    bundle = make_zip({"AIConnector-Probe/" + name: data for name, data in files.items()})
    archive = output / "AIConnector-Probe.zip"
    archive.write_bytes(bundle)
    checksum = hashlib.sha256(bundle).hexdigest()
    (output / (archive.name + ".sha256")).write_bytes(f"{checksum}  {archive.name}\n".encode("ascii"))
    for name, data in samples.items():
        (output / name).write_bytes(data)
    print(f"{archive}\n{len(bundle)} bytes\nSHA-256 {checksum}")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    build(parser.parse_args().output)
