"""Download the published public service ZIP, verify its checksum and exercise that exact package."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import sys
import urllib.request
from validate_service_bundle import validate

ROOT=Path(__file__).resolve().parents[1]

def main(tag):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?',tag):raise ValueError('Invalid release tag')
    name='AIConnector-Service-'+('windows-x64' if os.name=='nt' else 'macos-arm64')+'.zip'
    out=ROOT/'reports'/'service-release'/tag;out.mkdir(parents=True,exist_ok=True)
    base=f'https://github.com/Kirrito-k423/AIConnector/releases/download/{tag}/'
    checksum=urllib.request.urlopen(base+name+'.sha256',timeout=60).read(256).decode().split()[0]
    assert re.fullmatch('[0-9a-f]{64}',checksum)
    archive=out/name
    h=hashlib.sha256();total=0
    with urllib.request.urlopen(base+name,timeout=120)as response, archive.open('wb')as file:
        while data:=response.read(1024*1024):
            total+=len(data);assert total<512*1024*1024
            h.update(data);file.write(data)
    assert h.hexdigest()==checksum,'Public package checksum mismatch'
    validate(archive)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('tag');main(p.parse_args().tag)
