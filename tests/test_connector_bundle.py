"""Validate the extracted delivery and actual Windows command wrappers."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from test_probe import ROOT, PWSH
from test_connector import TaskAPI
from test_relay import RelayAPI

spec=importlib.util.spec_from_file_location('build_connector',ROOT/'tools/build_connector.py')
builder=importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)


class ConnectorBundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='Connector package ')
        self.folder=Path(self.tmp.name)
        self.archive=builder.build(self.folder/'dist')
        with zipfile.ZipFile(self.archive) as z: z.extractall(self.folder/'中文 path')
        self.install=self.folder/'中文 path/AIConnector'

    def tearDown(self): self.tmp.cleanup()

    def test_reproducible_and_bound_to_script(self):
        second=builder.build(self.folder/'second')
        self.assertEqual(self.archive.read_bytes(),second.read_bytes())
        script=(self.install/'Connector.ps1').read_bytes()
        self.assertTrue(script.startswith(b'\xef\xbb\xbf'))
        cmd=(self.install/'Connector-Windows.cmd').read_bytes()
        self.assertIn(hashlib.sha256(script).hexdigest().encode(),cmd)
        self.assertNotIn(b'__CONNECTOR_SHA256__',cmd)
        self.assertEqual(cmd.count(b'\n'),cmd.count(b'\r\n'))
        with zipfile.ZipFile(self.archive) as z:
            self.assertEqual(z.getinfo('AIConnector/Start-Mac-Connector.command').external_attr >> 16,0o100755)
        checkout=self.folder/'windows-checkout'; checkout.mkdir()
        for name in builder.FILES:
            p=checkout/name; p.parent.mkdir(parents=True,exist_ok=True)
            p.write_bytes((ROOT/name).read_bytes().replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))
        with patch.object(builder,'ROOT',checkout): other=builder.build(self.folder/'windows-build')
        self.assertEqual(self.archive.read_bytes(),other.read_bytes())

    @unittest.skipUnless(PWSH,'requires PowerShell')
    def test_extracted_default_status(self):
        p=subprocess.run([PWSH,'-NoProfile','-File',str(self.install/'Connector.ps1')],cwd=self.folder,
                         capture_output=True,encoding='utf-8',timeout=20)
        self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        self.assertEqual(json.loads(p.stdout)['runs'],[])
        self.assertTrue((self.install/'connector-state-relay/windows-inner/state.json').exists())

    @unittest.skipUnless(os.name=='nt','requires actual Windows cmd and execution policies')
    def test_actual_windows_entry_watch_claim_complete_and_restart(self):
        self.check_windows_entry(False)

    @unittest.skipUnless(os.name=='nt','requires actual Windows cmd and execution policies')
    def test_actual_windows_relay_entry_watch_claim_complete_and_restart(self):
        self.check_windows_entry(True)

    def check_windows_entry(self, relay):
        server=ThreadingHTTPServer(('127.0.0.1',0),RelayAPI if relay else TaskAPI); server.daemon_threads=True
        base=f'http://127.0.0.1:{server.server_port}'
        server.ctx=dict(base=base,comments=[],posts=[],gets=[],assets={},release_assets=[],artifact_auth=[],
                        fail_page=0,get_rate=False,post_rate=False,reject=0,timeout_before=False,timeout_after=False,corrupt_asset=False)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            c=json.loads((self.install/('connector.config.json' if relay else 'examples/connector.legacy.config.json')).read_text())
            c.update(api_base=base,repository='test/tasks',issue='1',poll_seconds=1,write_interval_seconds=0,
                     artifact_prefixes=[base+'/assets/'],authors={'mac-outer':['mac-user'],'windows-inner':['win-user']})
            if relay:
                c.pop('issue')
                server.ctx.update(issues=[],releases={},provision_mode={},descriptor=dict(
                    schema='aiconnector.relay.v1',repository='test/tasks',namespace=c['namespace'],layout=c['layout'],
                    protocol='aiconnector.task.v1',max_artifact_bytes=5242879))
            (self.install/'connector.config.json').write_text(json.dumps(c))
            script=self.install/'Connector.ps1'
            Path(str(script)+':Zone.Identifier').write_text('[ZoneTransfer]\r\nZoneId=3\r\n')
            env=dict(os.environ,AICONNECTOR_NO_PAUSE='1',PSExecutionPolicyPreference='RemoteSigned',AICONNECTOR_GITHUB_TOKEN='WIN_TOKEN')
            def win(*args, input=''):
                p=subprocess.run(['cmd.exe','/d','/c',*args],cwd=self.install,env=env,input=input,
                                 capture_output=True,encoding='utf-8',errors='replace',timeout=30)
                self.assertEqual(p.returncode,0,p.stdout+p.stderr)
                return p.stdout
            # Same delivered starter; only bound the number of cycles for automated acceptance.
            win('Start-Windows-Connector.cmd','-Cycles','1','-Proxy','direct',input='Y\n')
            def mac(action,*args):
                p=subprocess.run(['powershell.exe','-NoProfile','-File',str(script),'-Node','mac-outer','-Action',action,
                                  '-Proxy','direct',*args],cwd=self.install,env=dict(env,AICONNECTOR_GITHUB_TOKEN='MAC_TOKEN'),
                                 capture_output=True,encoding='utf-8',errors='replace',timeout=30)
                self.assertEqual(p.returncode,0,p.stdout+p.stderr)
            mac('Submit','-File','examples/task.json'); mac('Poll')
            win('Start-Windows-Connector.cmd','-Cycles','1','-Proxy','direct')
            key='smoke/1/run-001'
            first=win('Connector-Windows.cmd','-Action','Claim','-Key',key)
            self.assertRegex(first,r'"execute"\s*:\s*true')
            second=win('Connector-Windows.cmd','-Action','Claim','-Key',key)
            self.assertRegex(second,r'"execute"\s*:\s*false')
            win('Connector-Windows.cmd','-Action','Complete','-Key',key,'-File','examples/result.json')
            win('Start-Windows-Connector.cmd','-Cycles','2','-Proxy','direct')
            mac('Poll'); win('Start-Windows-Connector.cmd','-Cycles','1','-Proxy','direct')
            status=json.loads((self.install/('connector-state-relay' if relay else 'connector-state')/'windows-inner/status.json').read_text(encoding='utf-8'))
            self.assertEqual(status['runs'][0]['phase'],'receipt')
            self.assertEqual(len(server.ctx['posts']),7 if relay else 5)
            # Tampering stops before any network or state action.
            script.write_bytes(script.read_bytes()+b'\n# modified\n')
            p=subprocess.run(['cmd.exe','/d','/c','Connector-Windows.cmd','-Action','Poll'],cwd=self.install,env=env,
                             capture_output=True,encoding='utf-8',errors='replace',timeout=30)
            self.assertNotEqual(p.returncode,0); self.assertIn('CHECKSUM_MISMATCH',p.stdout)
            self.assertEqual(len(server.ctx['posts']),7 if relay else 5)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    @unittest.skipUnless(os.name=='nt','requires Windows execution policies')
    def test_all_signed_is_not_bypassed(self):
        env=dict(os.environ,AICONNECTOR_NO_PAUSE='1',PSExecutionPolicyPreference='AllSigned')
        p=subprocess.run(['cmd.exe','/d','/c','Connector-Windows.cmd','-Action','Status'],cwd=self.install,env=env,
                         capture_output=True,encoding='utf-8',errors='replace',timeout=30)
        self.assertNotEqual(p.returncode,0)
        self.assertFalse((self.install/'connector-state-relay/windows-inner/state.json').exists())

if __name__=='__main__':unittest.main(verbosity=2)
