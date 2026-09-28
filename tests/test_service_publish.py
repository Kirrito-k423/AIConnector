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
    def test_only_matching_version_and_intact_tested_package_can_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);package=folder/'AIConnector-Service-windows-x64.zip';body=b'fixture source'
            manifest=dict(version='0.7.0',platform='windows',arch='x64',sha256={'service/test.mjs':hashlib.sha256(body).hexdigest()})
            with zipfile.ZipFile(package,'w') as z:
                z.writestr('AIConnector-Service/service/test.mjs',body)
                z.writestr('AIConnector-Service/package-manifest.json',json.dumps(manifest))
            checksum=package.with_suffix('.zip.sha256');checksum.write_text(hashlib.sha256(package.read_bytes()).hexdigest()+'  '+package.name)
            self.assertEqual(candidate.validate('v0.7.0-rc.1',folder,'0.7.0'),package)
            for tag in ['v0.6.5-rc.1','v0.7.0','v0.7.0-rc.1;echo']:
                with self.assertRaises(ValueError):candidate.validate(tag,folder,'0.7.0')
            checksum.write_text('0'*64)
            with self.assertRaises(ValueError):candidate.validate('v0.7.0-rc.1',folder,'0.7.0')

if __name__=='__main__':unittest.main()
