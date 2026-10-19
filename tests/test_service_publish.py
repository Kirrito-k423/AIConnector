import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec=importlib.util.spec_from_file_location('candidate',Path(__file__).resolve().parents[1]/'tools/publish_service_candidate.py')
candidate=importlib.util.module_from_spec(spec);spec.loader.exec_module(candidate)

class CandidateTests(unittest.TestCase):
    def write_package(self,folder,*,companion=True,tamper=False):
        package=folder/'AIConnector-Service-windows-x64.zip'
        members={'service/test.mjs':b'fixture source'}
        if companion:members['watch-companion/version.json']=b'{"fixture":true}'
        manifest=dict(version='0.7.0',platform='windows',arch='x64',sha256={name:hashlib.sha256(body).hexdigest()for name,body in members.items()})
        with zipfile.ZipFile(package,'w')as z:
            for name,body in members.items():z.writestr('AIConnector-Service/'+name,b'tampered source'if tamper and name=='service/test.mjs'else body)
            z.writestr('AIConnector-Service/package-manifest.json',json.dumps(manifest))
        package.with_suffix('.zip.sha256').write_text(hashlib.sha256(package.read_bytes()).hexdigest()+'  '+package.name)
        return package

    def test_only_matching_version_and_intact_tested_package_can_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);package=self.write_package(folder);checksum=package.with_suffix('.zip.sha256')
            self.assertEqual(candidate.validate('v0.7.0-rc.1',folder,'0.7.0'),package)
            for tag in ['v0.6.5-rc.1','v0.7.0','v0.7.0-rc.1;echo']:
                with self.assertRaises(ValueError):candidate.validate(tag,folder,'0.7.0')
            checksum.write_text('0'*64)
            with self.assertRaises(ValueError):candidate.validate('v0.7.0-rc.1',folder,'0.7.0')

    def test_missing_companion_is_rejected_with_a_valid_outer_checksum(self):
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp);self.write_package(folder,companion=False)
            with self.assertRaisesRegex(ValueError,'offline group controller missing'):candidate.validate('v0.7.0-rc.1',folder,'0.7.0')

    def test_tampered_member_is_rejected_with_a_valid_outer_checksum(self):
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp);self.write_package(folder,tamper=True)
            with self.assertRaisesRegex(ValueError,'package member checksum mismatch'):candidate.validate('v0.7.0-rc.1',folder,'0.7.0')

if __name__=='__main__':unittest.main()
