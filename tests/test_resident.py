"""Real resident PS transport: process reuse, persistence, ZIP barriers, no WAN writes."""
import contextlib
import json
import os
import queue
import subprocess
import threading
import unittest
from urllib.parse import urlparse

from test_probe import PWSH
import test_relay as relay


class Resident:
    def __init__(self, case, node):
        self.node = node
        self.process = subprocess.Popen(case.command(node, 'Serve'), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding='utf-8', env=dict(os.environ))
        self.lines = queue.Queue()
        def read():
            for line in self.process.stdout:
                if line.startswith('{'): self.lines.put(json.loads(line))
            self.lines.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.count = 0
        ready = self.lines.get(timeout=15)
        assert ready and ready.get('ready') is True, ready

    def call(self, action, key='', file='', owner='', ok=True):
        self.count += 1
        op = str(self.count)
        self.process.stdin.write(json.dumps(dict(action=action, operation_id=op, key=key,
            file=str(file), claim_owner=owner, token='MAC_TOKEN' if self.node=='mac-outer' else 'WIN_TOKEN'))+'\n')
        self.process.stdin.flush()
        reply = self.lines.get(timeout=30)
        assert reply and reply['id'] == op, reply
        assert reply['ok'] is ok, reply
        return reply['value'] if ok else reply['error']

    def close(self, kill=False):
        if self.process.poll() is None:
            if kill: self.process.kill()
            else: self.process.stdin.close()
            self.process.wait(timeout=15)
        self.reader.join(timeout=2)
        if not self.process.stdin.closed: self.process.stdin.close()
        self.process.stdout.close();self.process.stderr.close()


@unittest.skipUnless(PWSH, 'requires PowerShell')
class ResidentTests(unittest.TestCase):
    def setUp(self):
        self.case = relay.RelayTests('test_handoff_creates_one_issue_one_release_and_persists_timeline')
        self.case.setUp()

    def tearDown(self): self.case.tearDown()

    @contextlib.contextmanager
    def runtime(self, node):
        runtime = Resident(self.case, node)
        try: yield runtime
        finally: runtime.close()

    def test_unchanged_projection_is_not_rewritten_and_cli_cannot_race_resident(self):
        c=self.case;c.ready()
        with self.runtime('windows-inner') as r:
            first=r.call('Status')
            files=[c.folder/'windows-inner'/name for name in ['state.json','status.json','status.md']]
            files += list((c.folder/'windows-inner'/'inbox').glob('*.json'))
            times=[p.stat().st_mtime_ns for p in files]
            self.assertEqual(r.call('Status'),first)
            self.assertEqual([p.stat().st_mtime_ns for p in files],times)
            self.assertEqual(c.run_cli('windows-inner','Status',ok=False)['code'],'STATE_BUSY')
            self.assertEqual(r.call('Watch',ok=False)['code'],'INVALID_TRANSPORT_ACTION')
            self.assertEqual(r.call('Status')['runs'][0]['phase'],'accepted')
        self.assertEqual(c.run_cli('windows-inner','Status')['runs'][0]['phase'],'accepted')

    def test_owned_claim_survives_resident_crash_without_new_identity(self):
        c=self.case;c.ready();owner='a'*48
        r=Resident(c,'windows-inner')
        try: first=r.call('Claim',key=c.key,owner=owner)
        finally: r.close(kill=True)
        with self.runtime('windows-inner') as r:
            again=r.call('Claim',key=c.key,owner=owner)
            self.assertTrue(again['execute']);self.assertTrue(again['replayed'])
            self.assertEqual(first['claim_event_id'],again['claim_event_id'])
            self.assertFalse(r.call('Claim',key=c.key,owner='b'*48)['execute'])

    def test_fresh_result_posts_before_public_download_but_corrupt_result_never_receipted(self):
        c=self.case;c.ready();c.run_cli('windows-inner','Claim','-Key',c.key)
        class FaultAPI(relay.RelayAPI):
            def do_GET(self):
                if urlparse(self.path).path.startswith('/assets/') and self.ctx.get('asset_fault'):
                    self.ctx['gets'].append(urlparse(self.path).path)
                    return self.reply(b'corrupt')
                super().do_GET()
        c.server.RequestHandlerClass=FaultAPI;c.ctx['asset_fault']=True
        path=c.zip_path()
        with self.runtime('windows-inner') as r:
            manifest=r.call('Upload',key=c.key,file=path)
            self.assertFalse(any(p.startswith('/assets/') for p in c.ctx['gets']))
            c.result['artifacts']=[manifest];c.write_inputs()
            r.call('Complete',key=c.key,file=c.resultfile);r.call('Flush')
        s=c.poll('mac-outer')
        self.assertEqual(s['runs'][0]['phase'],'result')
        self.assertEqual(s['runs'][0]['error'],'ARTIFACT_HASH_MISMATCH')
        self.assertFalse(any('"kind":"receipt"' in row['body'] for row in c.ctx['comments']))
        c.ctx['asset_fault']=False;c.clear_cooldown('mac-outer')
        self.assertEqual(c.poll('mac-outer')['runs'][0]['phase'],'receipt')

    def test_existing_result_asset_still_requires_sender_hash_validation(self):
        c=self.case;c.ready();c.run_cli('windows-inner','Claim','-Key',c.key)
        path=c.zip_path();manifest=c.run_cli('windows-inner','Upload','-Key',c.key,'-File',path)
        # Force reconciliation of an existing asset rather than a confirmed cache.
        state=c.read_state('windows-inner');row=next(iter(state['uploads'].values()))
        row['status']='uncertain'
        if row.get('recovery'): row['recovery']['last_absent_at']=1
        relay.legacy.ConnectorTests.write_state(c,'windows-inner',state)
        c.ctx['assets'][urlparse(manifest['url']).path]=b'x'*manifest['bytes']
        posts=len(c.ctx['posts'])
        with self.runtime('windows-inner') as r:
            self.assertEqual(r.call('Upload',key=c.key,file=path,ok=False)['code'],'ARTIFACT_HASH_MISMATCH')
        self.assertEqual(len(c.ctx['posts']),posts)

    def test_flush_drains_ready_messages_with_a_bound_and_keeps_run_identity(self):
        c=self.case;c.ready()
        before=len(c.ctx['comments'])
        with self.runtime('mac-outer') as r:
            for n in range(6):
                c.task['run_id']='batch-'+str(n);c.write_inputs();r.call('Submit',file=c.taskfile)
            first=r.call('Flush')
            sent=len(c.ctx['comments'])-before
            self.assertGreater(sent,1);self.assertLessEqual(sent,4)
            self.assertEqual(sum(i['status']=='confirmed' for i in first['outbox']),sent+1)
            r.call('Flush');r.call('Flush')
        self.assertEqual(len(c.ctx['comments'])-before,6)
        self.assertEqual(len(set(i['body'] for i in c.ctx['comments'])),len(c.ctx['comments']))


if __name__=='__main__': unittest.main()
