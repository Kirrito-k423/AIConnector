"""Real PS 5.1/7 processes: durable task handoff, failures and package entrypoints."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor

from test_probe import ROOT, PWSH


def sha(data):
    return hashlib.sha256(data).hexdigest()


class TaskAPI(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def reply(self, value, status=200, headers=None):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass

    @property
    def ctx(self): return self.server.ctx

    def do_GET(self):
        u = urlparse(self.path)
        self.ctx['gets'].append(u.path)
        if u.path.endswith('/comments'):
            page = int(parse_qs(u.query).get('page', ['1'])[0])
            if page == self.ctx['fail_page']: return self.reply({}, 503)
            if self.ctx['get_rate']:
                return self.reply({}, 429, {'Retry-After': '120'})
            rows = self.ctx['comments']
            return self.reply(rows[(page-1)*100:page*100])
        if '/releases/tags/' in u.path:
            return self.reply({'id': 7, 'draft': False, 'upload_url': self.ctx['base'] + '/repos/test/tasks/releases/7/assets{?name,label}'})
        if u.path.endswith('/releases/7/assets'):
            return self.reply(self.ctx['release_assets'])
        if u.path.startswith('/assets/'):
            self.ctx['artifact_auth'].append(self.headers.get('Authorization'))
            data = self.ctx['assets'].get(u.path)
            if data is None: return self.reply({}, 404)
            return self.reply(data + b'CORRUPT' if self.ctx['corrupt_asset'] else data)
        return self.reply({}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        raw = self.rfile.read(int(self.headers['Content-Length']))
        self.ctx['posts'].append(u.path)
        if self.ctx['post_rate']:
            if self.ctx['post_rate'] != 'always': self.ctx['post_rate'] = False
            return self.reply({}, 429, {'Retry-After': '2'})
        if self.ctx['reject']:
            return self.reply({'message': 'MUST_NOT_LOG_TOKEN'}, self.ctx['reject'])
        if self.ctx['timeout_before']:
            time.sleep(1.5)
            return self.reply({}, 503)
        if u.path.endswith('/comments'):
            login = 'mac-user' if 'MAC_TOKEN' in (self.headers.get('Authorization') or u.query) else 'win-user'
            row = {'id': len(self.ctx['comments'])+1, 'body': json.loads(raw)['body'], 'user': {'login': login}}
            self.ctx['comments'].append(row)
        else:
            name = parse_qs(u.query)['name'][0]
            path = '/assets/' + name
            self.ctx['assets'][path] = raw
            row = {'id': len(self.ctx['release_assets'])+1, 'name': name, 'size': len(raw), 'state': 'uploaded', 'browser_download_url': self.ctx['base']+path}
            self.ctx['release_assets'].append(row)
        if self.ctx['timeout_after']:
            time.sleep(1.5)
        return self.reply(row, 201)


@unittest.skipUnless(PWSH, 'set PWSH to PowerShell executable')
class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='AIConnector task ')
        self.folder = Path(self.tmp.name)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), TaskAPI)
        self.server.daemon_threads = True
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.ctx = dict(base=self.base, comments=[], posts=[], gets=[], assets={}, release_assets=[],
                        artifact_auth=[], fail_page=0, get_rate=False, post_rate=False,
                        reject=0, timeout_before=False, timeout_after=False, corrupt_asset=False)
        self.server.ctx = self.ctx
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = json.loads((ROOT/'examples/connector.legacy.config.json').read_text())
        self.config.update(api_base=self.base, repository='test/tasks', issue='1', poll_seconds=1,
                           write_interval_seconds=0, artifact_prefixes=[self.base+'/assets/'],
                           authors={'mac-outer': ['mac-user'], 'windows-inner': ['win-user']})
        self.config_path = self.folder/'connector config.json'
        self.write_config()
        self.task = json.loads((ROOT/'examples/task.json').read_text())
        self.result = json.loads((ROOT/'examples/result.json').read_text())
        self.taskfile = self.folder/'task.json'
        self.resultfile = self.folder/'result.json'
        self.write_inputs()
        self.key = 'smoke/1/run-001'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.tmp.cleanup()

    def write_config(self): self.config_path.write_text(json.dumps(self.config))
    def write_inputs(self):
        self.taskfile.write_text(json.dumps(self.task, ensure_ascii=False), encoding='utf-8')
        self.resultfile.write_text(json.dumps(self.result, ensure_ascii=False), encoding='utf-8')

    def command(self, node, action, *args):
        return [PWSH, '-NoLogo', '-NoProfile', '-File', str(ROOT/'Connector.ps1'), '-Node', node,
                '-Action', action, '-Config', str(self.config_path), '-StateDir', str(self.folder/node),
                '-Proxy', 'direct', '-TimeoutSeconds', '1', *map(str, args)]

    def run_cli(self, node, action, *args, ok=True):
        env = dict(os.environ, AICONNECTOR_GITHUB_TOKEN='MAC_TOKEN' if node == 'mac-outer' else 'WIN_TOKEN')
        p = subprocess.run(self.command(node, action, *args), capture_output=True, encoding='utf-8', errors='replace', env=env, timeout=30)
        if ok: self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
        else: self.assertNotEqual(p.returncode, 0, p.stdout+p.stderr)
        lines = [json.loads(x) for x in p.stdout.splitlines() if x.startswith('{')]
        self.assertTrue(lines, p.stdout+p.stderr)
        return lines[-1]

    def read_state(self, node):
        p = json.loads((self.folder/node/'state.json').read_text())
        data = base64.b64decode(p['data_base64'])
        self.assertEqual(sha(data), p['sha256'])
        return json.loads(data)

    def submit(self): return self.run_cli('mac-outer', 'Submit', '-File', self.taskfile)
    def poll(self, node): return self.run_cli(node, 'Poll')
    def ready(self):
        self.submit(); self.poll('mac-outer'); self.poll('windows-inner')
    def complete_flow(self):
        self.ready()
        self.assertTrue(self.run_cli('windows-inner', 'Claim', '-Key', self.key)['execute'])
        self.poll('windows-inner')
        self.run_cli('windows-inner', 'Complete', '-Key', self.key, '-File', self.resultfile)
        self.poll('windows-inner'); self.poll('mac-outer'); self.poll('windows-inner')

    def test_full_handoff_restarts_and_duplicate_claim(self):
        self.complete_flow()
        self.assertEqual(len(self.ctx['posts']), 5)
        for node in ('mac-outer', 'windows-inner'):
            status = self.poll(node)
            self.assertEqual(status['runs'][0]['phase'], 'receipt')
            self.assertTrue((self.folder/node/'status.md').exists())
        self.assertFalse(self.run_cli('windows-inner', 'Claim', '-Key', self.key)['execute'])
        self.assertEqual(len(self.ctx['posts']), 5)
        for node in ('mac-outer', 'windows-inner'):
            self.assertNotIn('TOKEN', json.dumps(self.read_state(node)))

    def test_metric_names_matching_dictionary_properties_are_preserved(self):
        self.result['metrics']={'Keys':3,'Values':[1,2],'Count':4,'nested':{'keys':'original','values':5}}
        self.write_inputs(); self.complete_flow()
        status=self.run_cli('mac-outer','Status')
        self.assertEqual(status['runs'][0]['result']['metrics'],self.result['metrics'])

    def test_result_artifact_download_required_before_receipt(self):
        z = io.BytesIO()
        with zipfile.ZipFile(z, 'w') as f: f.writestr('result.txt', 'synthetic')
        data = z.getvalue(); self.ctx['assets']['/assets/result.zip'] = data
        self.result['artifacts'] = [dict(name='result.zip', bytes=len(data), sha256=sha(data), url=self.base+'/assets/result.zip')]
        self.write_inputs(); self.ready()
        self.run_cli('windows-inner', 'Claim', '-Key', self.key); self.poll('windows-inner')
        self.run_cli('windows-inner', 'Complete', '-Key', self.key, '-File', self.resultfile); self.poll('windows-inner')
        self.ctx['corrupt_asset'] = True
        status = self.poll('mac-outer')
        self.assertEqual(status['runs'][0]['phase'], 'result')
        self.assertEqual(status['runs'][0]['error'], 'ARTIFACT_HASH_MISMATCH')
        self.assertEqual(len(self.ctx['posts']), 4)
        self.ctx['corrupt_asset'] = False
        self.assertEqual(self.poll('mac-outer')['runs'][0]['phase'], 'receipt')
        self.assertTrue(all(x is None for x in self.ctx['artifact_auth']))

    def test_task_artifact_required_before_acceptance_and_claim(self):
        data = b'zip-bytes-for-hash-check'
        self.ctx['assets']['/assets/task.zip'] = data
        self.task['artifacts'] = [dict(name='task.zip', bytes=len(data), sha256=sha(data), url=self.base+'/assets/task.zip')]
        self.write_inputs(); self.submit(); self.poll('mac-outer')
        self.ctx['corrupt_asset'] = True
        self.assertEqual(self.poll('windows-inner')['runs'][0]['phase'], 'task')
        self.assertEqual(self.run_cli('windows-inner','Claim','-Key',self.key,ok=False)['code'],'RUN_NOT_READY')
        self.ctx['corrupt_asset'] = False
        self.assertEqual(self.poll('windows-inner')['runs'][0]['phase'], 'accepted')

    def test_unknown_post_does_not_repeat_and_readback_recovers(self):
        self.submit(); self.ctx['timeout_after'] = True
        status = self.poll('mac-outer')
        self.assertEqual(status['outbox'][0]['status'], 'confirmed')
        self.ctx['timeout_after'] = False
        self.poll('mac-outer'); self.assertEqual(len(self.ctx['posts']), 1)

    def test_lost_write_not_found_stays_uncertain(self):
        self.submit(); self.ctx['timeout_before'] = True
        self.assertEqual(self.poll('mac-outer')['outbox'][0]['status'], 'uncertain')
        self.ctx['timeout_before'] = False
        self.poll('mac-outer'); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['posts']), 1)

    def test_rate_limit_survives_restart_and_recovers(self):
        self.submit(); self.ctx['post_rate'] = True
        first = self.poll('mac-outer')
        self.assertEqual(first['outbox'][0]['status'], 'rate_limited')
        self.poll('mac-outer'); self.assertEqual(len(self.ctx['posts']), 1)
        time.sleep(3.1)
        self.assertEqual(self.poll('mac-outer')['outbox'][0]['status'], 'confirmed')
        self.assertEqual(len(self.ctx['posts']), 2)
        self.assertEqual(len(self.ctx['comments']), 1)

    def test_repeated_write_rate_limit_keeps_backoff_across_successful_reads(self):
        self.submit(); self.ctx['post_rate']='always'
        self.poll('mac-outer')
        self.assertEqual(self.read_state('mac-outer')['failures'],1)
        time.sleep(3.1)
        self.poll('mac-outer')
        self.assertEqual(self.read_state('mac-outer')['failures'],2)
        self.assertEqual(len(self.ctx['posts']),2)

    def test_wire_digest_is_independent_of_powershell_json_reader(self):
        self.complete_flow()
        for comment in self.ctx['comments']:
            e=json.loads(re.search(r'```json\n(.*?)\n```',comment['body'],re.S).group(1))
            identifier=e.pop('event_id')
            self.assertEqual(identifier,sha(json.dumps(e,sort_keys=True,separators=(',',':')).encode()))
            raw=base64.b64decode(e['payload_b64'])
            self.assertEqual(e['payload_sha256'],sha(raw))
            if e['kind']=='task':
                self.assertEqual(json.loads(raw)['title'],self.task['title'])
                self.assertIn('synthetic-v1',comment['body'])
                self.assertIn(self.task['objective'],comment['body'])

    def test_read_limit_blocks_network_after_restart(self):
        self.ctx['get_rate'] = True
        self.run_cli('windows-inner','Poll',ok=False)
        count = len(self.ctx['gets']); self.poll('windows-inner')
        self.assertEqual(count, len(self.ctx['gets']))

    def test_rejected_write_is_not_retried(self):
        self.submit(); self.ctx['reject'] = 422
        self.assertEqual(self.poll('mac-outer')['outbox'][0]['status'], 'rejected')
        self.ctx['reject'] = 0; self.poll('mac-outer')
        self.assertEqual(len(self.ctx['posts']), 1)

    def test_explicit_retry_only_for_known_rejection(self):
        event = self.submit()['event_id']; self.ctx['reject'] = 401
        self.poll('mac-outer'); self.ctx['reject'] = 0
        self.run_cli('mac-outer', 'RetryRejected', '-Key', event)
        self.assertEqual(self.poll('mac-outer')['outbox'][0]['status'], 'confirmed')
        self.assertEqual(self.run_cli('mac-outer','RetryRejected','-Key',event,ok=False)['code'],'ONLY_REJECTED_WRITES_CAN_BE_REQUEUED')
        self.assertEqual(len(self.ctx['posts']),2)

    def test_failed_result_is_received_without_claiming_success(self):
        self.result['outcome']='failed'; self.result['exit_code']=2
        self.write_inputs(); self.complete_flow()
        status=self.run_cli('mac-outer','Status')
        self.assertEqual(status['runs'][0]['phase'],'receipt')
        self.assertEqual(status['runs'][0]['result']['outcome'],'failed')

    def test_changed_revision_creates_independent_run(self):
        self.complete_flow()
        self.task['revision']=2; self.task['objective']='second revision'; self.write_inputs()
        self.submit(); self.poll('mac-outer'); self.poll('windows-inner')
        status=self.run_cli('windows-inner','Status')
        phases={r['key']:r['phase'] for r in status['runs']}
        self.assertEqual(phases, {'smoke/1/run-001':'receipt','smoke/2/run-001':'accepted'})
        self.assertTrue(self.run_cli('windows-inner','Claim','-Key','smoke/2/run-001')['execute'])

    def test_corrupt_store_is_preserved_and_never_reset(self):
        self.ready(); self.run_cli('windows-inner','Claim','-Key',self.key)
        path = self.folder/'windows-inner/state.json'
        path.write_text('{broken')
        self.assertEqual(self.run_cli('windows-inner','Status',ok=False)['code'], 'STATE_CORRUPT')
        self.assertEqual(path.read_text(), '{broken')

    def test_store_binds_channel_configuration(self):
        self.submit(); previous = (self.folder/'mac-outer/state.json').read_bytes()
        self.config['namespace'] = 'other'; self.write_config()
        self.assertEqual(self.run_cli('mac-outer','Status',ok=False)['code'], 'STATE_CONFIG_MISMATCH')
        self.assertEqual(previous, (self.folder/'mac-outer/state.json').read_bytes())

    def test_run_and_result_are_immutable(self):
        first = self.submit(); self.assertEqual(first['event_id'],self.submit()['event_id'])
        self.task['objective'] = 'changed'; self.write_inputs()
        self.assertEqual(self.run_cli('mac-outer','Submit','-File',self.taskfile,ok=False)['code'], 'RUN_IS_IMMUTABLE')
        self.poll('mac-outer'); self.poll('windows-inner'); self.run_cli('windows-inner','Claim','-Key',self.key)
        self.run_cli('windows-inner','Complete','-Key',self.key,'-File',self.resultfile)
        self.result['summary']='changed'; self.write_inputs()
        self.assertEqual(self.run_cli('windows-inner','Complete','-Key',self.key,'-File',self.resultfile,ok=False)['code'],'RESULT_IS_IMMUTABLE')

    def test_revision_content_cannot_change_by_renaming_run(self):
        self.submit(); self.poll('mac-outer')
        self.task['run_id']='run-002'; self.write_inputs()
        self.submit()  # A deliberate repeat with identical experiment content is valid.
        self.task['run_id']='run-003'; self.task['objective']='different experiment'; self.write_inputs()
        self.assertEqual(self.run_cli('mac-outer','Submit','-File',self.taskfile,ok=False)['code'],'REVISION_IS_IMMUTABLE')
        # A conflicting revision arriving from a fresh coordinator state is also stopped at the receiver.
        (self.folder/'mac-outer').rename(self.folder/'previous-coordinator')
        self.submit(); self.poll('mac-outer')
        status=self.poll('windows-inner')
        self.assertTrue(all(r['phase']=='conflict' for r in status['runs']))
        self.assertEqual(len(self.ctx['posts']),2)

    def test_unauthorized_and_edited_comments_cannot_start_work(self):
        self.submit(); self.poll('mac-outer')
        self.ctx['comments'][0]['user']['login']='outsider'
        self.assertEqual(self.poll('windows-inner')['runs'], [])
        self.ctx['comments'][0]['user']['login']='mac-user'
        self.poll('windows-inner')
        self.ctx['comments'][0]['body']+='\nchanged'
        self.assertEqual(self.poll('windows-inner')['runs'][0]['phase'],'conflict')
        self.assertEqual(self.run_cli('windows-inner','Claim','-Key',self.key,ok=False)['code'],'RUN_CONFLICT')

    def test_duplicate_and_out_of_order_events(self):
        self.complete_flow(); self.ctx['comments'].reverse()
        extra=copy.deepcopy(self.ctx['comments'][-1]); extra['id']=99; self.ctx['comments'].append(extra)
        # Reconstruct in a fresh directory from deliberately reversed remote events.
        (self.folder/'windows-inner').rename(self.folder/'previous-worker-state')
        self.assertEqual(self.poll('windows-inner')['runs'][0]['phase'],'receipt')
        self.assertEqual(len(self.ctx['posts']),5)
        self.assertEqual(self.run_cli('windows-inner','Claim','-Key',self.key,ok=False)['code'],'RUN_NOT_READY')

    def test_pagination_failure_imports_no_partial_task(self):
        self.submit(); self.poll('mac-outer')
        self.ctx['comments'] += [{'id':n,'body':'human note','user':{'login':'outsider'}} for n in range(2,101)]
        self.ctx['fail_page']=2
        self.assertEqual(self.run_cli('windows-inner','Poll',ok=False)['code'],'HTTP_ERROR_503')
        self.assertEqual(self.read_state('windows-inner')['events'],{})

    def test_revision_mismatch_blocks_receipt(self):
        self.result['actual_revision']='wrong-revision'; self.write_inputs(); self.complete_flow()
        status=self.run_cli('mac-outer','Status')
        self.assertEqual(status['runs'][0]['phase'],'result')
        self.assertEqual(status['runs'][0]['error'],'RESULT_REVISION_MISMATCH')
        self.assertEqual(len(self.ctx['posts']),4)

    def test_disallowed_artifact_url_is_rejected_before_network(self):
        self.task['artifacts']=[dict(name='input.zip',bytes=100,sha256='0'*64,url='https://untrusted.invalid/file.zip')]
        self.write_inputs()
        self.assertEqual(self.run_cli('mac-outer','Submit','-File',self.taskfile,ok=False)['code'],'ARTIFACT_HOST_NOT_ALLOWED')
        self.assertEqual(self.ctx['gets'],[])

    def test_upload_zip_timeout_recovery_and_dedup(self):
        path=self.folder/'实际结果 result.zip'
        with zipfile.ZipFile(path,'w') as z:z.writestr('sample.txt','small local result')
        self.ctx['timeout_after']=True
        self.run_cli('windows-inner','Upload','-File',path,ok=False)
        # Failure backoff persists; advance only this simulated clock gate, preserving checksum.
        state=self.read_state('windows-inner'); state['next_poll']=0
        b=json.dumps(state,separators=(',',':')).encode()
        (self.folder/'windows-inner/state.json').write_text(json.dumps(dict(schema='aiconnector.store.v1',sha256=sha(b),data_base64=base64.b64encode(b).decode())))
        self.ctx['timeout_after']=False
        manifest=self.run_cli('windows-inner','Upload','-File',path)
        self.assertEqual(manifest['sha256'],sha(path.read_bytes()))
        self.assertEqual(manifest,self.run_cli('windows-inner','Upload','-File',path))
        self.assertEqual(len(self.ctx['posts']),1)

    def test_competing_claims_only_one_execution_permission(self):
        self.ready()
        def claim():
            return subprocess.run(self.command('windows-inner','Claim','-Key',self.key),capture_output=True,env=dict(os.environ,AICONNECTOR_GITHUB_TOKEN='WIN_TOKEN'),encoding='utf-8',timeout=20)
        with ThreadPoolExecutor(max_workers=2) as pool: responses=list(pool.map(lambda _:claim(),range(2)))
        values=[json.loads(p.stdout.strip().splitlines()[-1]) for p in responses]
        self.assertEqual(sum(v.get('execute') is True for v in values),1,values)
        self.assertFalse(self.run_cli('windows-inner','Claim','-Key',self.key)['execute'])

    def test_watch_polls_with_persistent_state(self):
        self.submit(); self.poll('mac-outer')
        self.run_cli('windows-inner','Watch','-Cycles','2')
        self.assertEqual(len(self.ctx['posts']),2)
        self.assertEqual(self.run_cli('windows-inner','Status')['runs'][0]['phase'],'accepted')

    def test_gitcode_comment_adapter(self):
        self.config['provider']='gitcode'; self.write_config()
        self.complete_flow(); self.assertEqual(len(self.ctx['posts']),5)


if __name__ == '__main__': unittest.main(verbosity=2)
