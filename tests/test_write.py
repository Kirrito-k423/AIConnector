"""Real PowerShell write workflow against local API fixtures; no external mutations."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse,parse_qs

from test_probe import PWSH,ROOT

class WriteHandler(BaseHTTPRequestHandler):
    comments={}
    assets={}
    uploads=[]
    requests=[]
    uncertain=False
    alter=False
    def log_message(self,*_):pass
    def reply(self,body,status=200,raw=False):
        data=body if raw else json.dumps(body).encode()
        self.send_response(status);self.send_header('Content-Type','application/octet-stream' if raw else 'application/json');self.send_header('Content-Length',str(len(data)));self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    def do_GET(self):
        path=urlparse(self.path).path
        WriteHandler.requests.append(('GET',path,self.headers.get('Authorization')))
        provider=path.split('/')[1]
        if path.endswith('/comments'):return self.reply(WriteHandler.comments.get(provider,[]))
        if path.endswith('/repos/test/probe'):return self.reply({'id':123})
        if path.startswith('/asset/'):
            url=f'http://127.0.0.1:{self.server.server_port}'+path
            # Uploaded files are unavailable anonymously until referenced by a comment.
            published=any(url in c['body'] for cs in WriteHandler.comments.values() for c in cs)
            if not published:return self.reply({},404)
            assert self.headers.get('Authorization') is None
            data=WriteHandler.assets[path]
            return self.reply(data+b'corrupt' if WriteHandler.alter else data,raw=True)
        return self.reply({'id':1,'login':'fixture'})
    def do_POST(self):
        path=urlparse(self.path).path;query=parse_qs(urlparse(self.path).query)
        data=self.rfile.read(int(self.headers['Content-Length']))
        WriteHandler.requests.append(('POST',path,self.headers.get('Authorization')))
        provider=path.split('/')[1]
        if path.endswith('/comments'):
            body=json.loads(data)['body'];cs=WriteHandler.comments.setdefault(provider,[])
            c={'id':len(cs)+1,'body':body};cs.append(c);return self.reply(c,201)
        if path.endswith('/user-attachments/assets'):
            name=query['name'][0]
            if name.endswith('.txt'):return self.reply({'message':'unsupported media'},422)
            assert self.headers.get('Authorization')=='Bearer FAKE_TOKEN'
        elif path.endswith('/img/upload'):
            payload=json.loads(data);name=payload['file_name'];data=base64.b64decode(payload['body'])
            assert query['access_token']==['FAKE_TOKEN']
        elif path.endswith('/file/upload'):
            mail=BytesParser(policy=default).parsebytes(b'Content-Type: '+self.headers['Content-Type'].encode()+b'\r\n\r\n'+data)
            parts=list(mail.iter_parts());assert len(parts)==1
            part=parts[0];name=part.get_filename();assert part.get_param('name',header='content-disposition')=='file'
            data=part.get_payload(decode=True);assert query['access_token']==['FAKE_TOKEN']
        else:return self.reply({},404)
        WriteHandler.uploads.append((provider,name,len(data),hashlib.sha256(data).hexdigest()))
        asset='/asset/'+str(len(WriteHandler.assets)+1)
        WriteHandler.assets[asset]=data
        url=f'http://127.0.0.1:{self.server.server_port}'+asset
        if WriteHandler.uncertain and name=='pixel.png':time.sleep(2)
        return self.reply({'url':url,'success':True,'full_path':url},201 if provider=='github' else 200)

@unittest.skipUnless(PWSH,'requires PowerShell')
class WriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        WriteHandler.comments={};WriteHandler.assets={};WriteHandler.uploads=[];WriteHandler.requests=[];WriteHandler.uncertain=False;WriteHandler.alter=False
        self.server=ThreadingHTTPServer(('127.0.0.1',0),WriteHandler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def run_write(self,providers=('github','gitcode'),token='FAKE_TOKEN',extra=()):
        config=self.root/'settings.json';out=self.root/'reports'
        config.write_text(json.dumps({'channels':[{'name':p,'provider':p,'website':self.base,'api_base':self.base+'/'+p,'asset_upload_base':self.base+'/'+p,'repository':'test/probe','issue':'1','token_env':'TEST_WRITE_TOKEN'} for p in providers]}))
        before=set(out.glob('*-write-*.json'))
        run=subprocess.run([PWSH,'-NoLogo','-NoProfile','-File',str(ROOT/'Probe.ps1'),'-Mode','Write','-Node','test-node','-Peer','peer','-Session','testwrite','-Config',str(config),'-OutputDir',str(out),'-Proxy','direct',*extra],env=dict(os.environ,TEST_WRITE_TOKEN=token),capture_output=True,text=True,errors='replace',timeout=90)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        created=set(out.glob('*-write-*.json'))-before;self.assertEqual(len(created),1,run.stdout+run.stderr)
        raw=created.pop().read_text(encoding='utf-8');self.assertNotIn('FAKE_TOKEN',raw+run.stdout+run.stderr)
        for f in out.glob('*.local.json'):self.assertNotIn('FAKE_TOKEN',f.read_text())
        report=json.loads(raw);self.assertTrue(report['completed']);return report
    def test_complete_matrix_and_repeat_does_not_reupload(self):
        r=self.run_write()
        rows={x['test']:x['status'] for x in r['observations']}
        for provider in ('github','gitcode'):
            for size in (1024,8192,32768):self.assertEqual(rows.get(f'{provider}/comment/{size}'),'COMMENT_BYTES_VERIFIED',r)
        self.assertEqual(rows['github/attachment/text-1024.txt'],'UPLOAD_REJECTED')
        self.assertEqual(rows['github/attachment/pixel.png'],'EXACT_BYTES_VERIFIED')
        self.assertEqual(rows['gitcode/attachment/result-128KiB.zip'],'EXACT_BYTES_VERIFIED')
        self.assertEqual(rows['gitcode/attachment/binary-1MiB.bin'],'EXACT_BYTES_VERIFIED')
        count=len(WriteHandler.uploads);comments=sum(map(len,WriteHandler.comments.values()))
        self.run_write()
        self.assertEqual(len(WriteHandler.uploads),count)
        self.assertEqual(sum(map(len,WriteHandler.comments.values())),comments)
    def test_missing_token_never_writes(self):
        r=self.run_write(token='')
        self.assertTrue(all(x['status']=='NEEDS_TOKEN' for x in r['observations']))
        self.assertEqual(WriteHandler.requests,[])
    def test_uncertain_upload_is_not_repeated(self):
        WriteHandler.uncertain=True
        r=self.run_write(providers=('github',),extra=('-TimeoutSeconds','1'))
        status={x['test']:x['status'] for x in r['observations']}
        self.assertEqual(status.get('github/attachment/pixel.png'),'WRITE_UNCERTAIN',r)
        before=sum(n=='pixel.png' for _,n,*_ in WriteHandler.uploads)
        self.run_write(providers=('github',),extra=('-TimeoutSeconds','1'))
        self.assertEqual(sum(n=='pixel.png' for _,n,*_ in WriteHandler.uploads),before)
    def test_download_corruption_is_not_success(self):
        WriteHandler.alter=True
        r=self.run_write(providers=('github',))
        status={x['test']:x['status'] for x in r['observations']}
        self.assertEqual(status.get('github/attachment/pixel.png'),'HASH_MISMATCH',r)

    @unittest.skipUnless(os.name == 'nt', 'requires Windows cmd and NTFS')
    def test_downloaded_write_entry_runs_complete_matrix_once(self):
        from test_bundle import builder
        archive = builder.build(self.root / 'dist')
        with zipfile.ZipFile(archive) as z:
            z.extractall(self.root / '写入测试 with spaces')
        install = self.root / '写入测试 with spaces' / 'AIConnector-Probe'
        config = install / 'probe.config.json'
        config.write_text(json.dumps({'channels': [
            {'name': p, 'provider': p, 'website': self.base,
             'api_base': self.base + '/' + p, 'asset_upload_base': self.base + '/' + p,
             'repository': 'test/probe', 'issue': '1', 'token_env': 'TEST_WRITE_TOKEN'}
            for p in ('github', 'gitcode')]}), encoding='utf-8')
        before_config = config.read_bytes()
        # Seed a real peer packet, so this tests the receive-and-ack branch too.
        session, sender, receiver = 'writecheck-v013', 'mac-outer', 'windows-inner'
        payload = '中文 sample\n'
        digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
        packet = {'schema': 'aiconnector.probe.v1', 'kind': 'sample',
                  'message_id': digest(f'{session}|{sender}|{receiver}|{len(payload.encode())}'),
                  'session': session, 'sender': sender, 'receiver': receiver,
                  'payload_bytes': len(payload.encode()), 'payload_sha256': digest(payload),
                  'payload': payload}
        body = 'AIConnector probe v1\n\n```json\n' + json.dumps(packet, ensure_ascii=False, separators=(',', ':')) + '\n```'
        WriteHandler.comments = {p: [{'id': 1, 'body': body}] for p in ('github', 'gitcode')}
        script = install / 'Probe.ps1'
        Path(str(script) + ':Zone.Identifier').write_text('[ZoneTransfer]\r\nZoneId=3\r\n')
        env = dict(os.environ, TEST_WRITE_TOKEN='FAKE_TOKEN', AICONNECTOR_NO_PAUSE='1',
                   PSExecutionPolicyPreference='RemoteSigned')
        line = f'cmd.exe /d /s /c ""{install / "Run-Windows-Write.cmd"}" -Proxy direct"'
        run = subprocess.run(line, cwd=self.root, env=env, input='Y\n', capture_output=True,
                             encoding='utf-8', errors='replace', timeout=90)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        reports = list((install / 'reports').glob('*-write-*.json'))
        self.assertEqual(len(reports), 1, run.stdout + run.stderr)
        report = json.loads(reports[0].read_text(encoding='utf-8'))
        self.assertEqual(report['mode'], 'Write')
        self.assertEqual(report['node'], 'windows-inner')
        self.assertTrue(report['completed'])
        rows = {r['test']: r for r in report['observations']}
        for p in ('github', 'gitcode'):
            self.assertEqual(rows[p + '/comment/32768']['status'], 'COMMENT_BYTES_VERIFIED', report)
            self.assertEqual(rows[p + '/attachment/pixel.png']['status'], 'EXACT_BYTES_VERIFIED', report)
            self.assertTrue(any('"kind":"receipt"' in c['body'] for c in WriteHandler.comments[p]), report)
        self.assertEqual(config.read_bytes(), before_config)
        self.assertFalse(Path(str(script) + ':Zone.Identifier').exists())
        self.assertNotIn('FAKE_TOKEN', reports[0].read_text() + run.stdout + run.stderr)
        with zipfile.ZipFile(reports[0].with_suffix('.zip')) as z:
            self.assertEqual(len(z.namelist()), 3)
            self.assertEqual(z.read(reports[0].name), reports[0].read_bytes())
