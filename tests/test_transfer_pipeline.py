"""Real Runner -> resident PowerShell -> delayed HTTP; no WAN or private files."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import threading
import time
import unittest
import zipfile
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

import test_relay as relay
from test_probe import PWSH
from test_resident import Resident

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(PWSH, 'requires PowerShell')
class TransferPipelineTests(unittest.TestCase):
    def setUp(self):
        self.c = relay.RelayTests('test_handoff_creates_one_issue_one_release_and_persists_timeline')
        self.c.setUp()
        original_command=self.c.command
        def command(*args):
            cmd=original_command(*args);cmd[cmd.index('-TimeoutSeconds')+1]='5'
            if os.environ.get('AIC_PIPELINE_ROOT'):
                cmd[cmd.index('-File')+1]=str(Path(os.environ['AIC_PIPELINE_ROOT'])/'Connector.ps1')
            return cmd
        self.c.command=command
        self.c.ready()
        self.c.run_cli('windows-inner', 'Claim', '-Key', self.c.key)
        if os.environ.get('AIC_WRITE_INTERVAL'):
            self.c.config['write_interval_seconds']=int(os.environ['AIC_WRITE_INTERVAL']);self.c.write_config()
        self.stats = dict(active=0, peak=0, posts=0)
        lock, stats = threading.Lock(), self.stats

        class SlowAPI(relay.RelayAPI):
            def do_POST(self):
                if not urlparse(self.path).path.endswith('/assets'):
                    return super().do_POST()
                with lock:
                    stats['active'] += 1
                    stats['peak'] = max(stats['peak'], stats['active'])
                    stats['posts'] += 1
                try:
                    time.sleep(1)
                    super().do_POST()
                finally:
                    with lock:
                        stats['active'] -= 1

        self.c.server.RequestHandlerClass = SlowAPI

    def part(self, label):
        file=self.c.folder/(label+'.zip')
        with zipfile.ZipFile(file,'w') as z:z.writestr('part.age',os.urandom(4096))
        return file

    def collect(self, runtime, file, ok=True):
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            value=runtime.call('TransferUpload',key=self.c.key,file=file,ok=ok)
            if not value.get('pending'):return value
            time.sleep(.05)
        self.fail('part did not finish')

    def tearDown(self):
        self.c.tearDown()

    def execute(self):
        c = self.c
        job = c.folder / 'delivery'
        parts = job / 'transfer-parts'
        parts.mkdir(parents=True)
        for i in range(4):
            with zipfile.ZipFile(parts / f'{i}.zip', 'w') as z:
                z.writestr('part.age', os.urandom(768*1024))
        (job/'result.json').write_text(json.dumps(c.result))
        with zipfile.ZipFile(job/'result.zip', 'w') as z:
            z.writestr('result.json', json.dumps(c.result))
        root = Path(os.environ.get('AIC_PIPELINE_ROOT', os.environ.get('AIC_SERVICE_ROOT', ROOT)))
        program = c.folder/'pipeline.mjs'
        program.write_text('''
import fs from 'node:fs';import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,dir,relay,powershell,key]=process.argv.slice(2);
const {Runner}=await import(pathToFileURL(path.join(root,'service/runner.mjs')));
const {Connector}=await import(pathToFileURL(path.join(root,'service/connector.mjs')));
const {save,sha}=await import(pathToFileURL(path.join(root,'service/common.mjs')));
const jobDir=path.join(dir,'delivery'),parts=fs.readdirSync(path.join(jobDir,'transfer-parts')).map(name=>{
 const file=path.join(jobDir,'transfer-parts',name),bytes=fs.readFileSync(file),hash=sha(bytes);fs.renameSync(file,path.join(jobDir,'transfer-parts',hash+'.zip'));return {name:hash+'.zip',sha256:hash,bytes:bytes.length};
});
save(path.join(jobDir,'result.json'),JSON.parse(fs.readFileSync(path.join(jobDir,'result.json'))));
save(path.join(jobDir,'transfer-state.json'),{key,state:'sealed',parts});save(path.join(jobDir,'worker.json'),{state:'ready'});
const config={dataDir:dir,stateDir:path.join(dir,'windows-inner'),node:'windows-inner',connectorConfig:relay,powershell,proxy:'direct',httpTimeoutSeconds:10,connector:JSON.parse(fs.readFileSync(relay)),runner:{enabled:true,profiles:{},agent:{},transferConcurrency:2}};
const connector=new Connector(config,{githubToken:'WIN_TOKEN'}),job={key,dir:jobDir,state:'running',resources:{keys:[],state:'released'}},ledger={jobs:{[key]:job}};
const runner=new Runner(config,connector,ledger,()=>{},{}),started=performance.now();
try{do{await runner.reconcile(job,{runs:[]});await runner.idle();if(job.state!=='submitted')await new Promise(r=>setTimeout(r,Math.max(100,(job.delivery_retry_at||0)-Date.now())));}while(job.state!=='submitted'&&performance.now()-started<55000);console.log(JSON.stringify({state:job.state,error:job.error||'',uploaded:job.transfer_delivery?.uploaded,total:job.transfer_delivery?.total,milliseconds:performance.now()-started}));}
finally{await connector.close();}
''')
        start_gets=len(c.ctx['gets'])
        result = subprocess.run([os.environ.get('AIC_NODE', 'node'), str(program), str(root), str(c.folder), str(c.config_path), PWSH, c.key], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout.strip().splitlines()[-1])
        value.update(self.stats)
        value['release_reads'] = sum('/releases/tags/' in p for p in c.ctx['gets'][start_gets:])
        value['asset_list_reads'] = sum(p.endswith('/assets') for p in c.ctx['gets'][start_gets:])
        print(json.dumps({'transfer_benchmark':value}), flush=True)
        return value

    def test_bounded_parallel_parts_share_one_state_owner_and_publish_result_last(self):
        value = self.execute()
        self.assertEqual(value['state'], 'submitted', value)
        self.assertEqual(value['uploaded'], 4)
        self.assertEqual(value['posts'], 5)
        self.assertEqual(value['peak'], int(os.environ.get('AIC_EXPECT_PEAK','2')), 'data POSTs are still serialized')
        self.assertTrue(self.c.ctx['release_assets'][-1]['name'].endswith(hashlib.sha256((self.c.folder/'delivery/result.zip').read_bytes()).hexdigest()+'.zip'))

    def test_control_progress_while_two_payloads_are_in_flight(self):
        c=self.c;files=[self.part(str(i)) for i in range(2)]
        with ResidentContext(c) as r:
            for file in files:self.assertTrue(r.call('TransferUpload',key=c.key,file=file)['pending'])
            started=time.monotonic();status=r.call('Status');elapsed=time.monotonic()-started
            self.assertLess(elapsed,.8,'control queue waited for the one-second upload')
            self.assertEqual(status['runs'][0]['key'],c.key)
            for file in files:self.assertIn('sha256',self.collect(r,file))
        self.assertEqual(self.stats['peak'],2)

    def test_eight_native_uploads_leave_room_for_control_http_and_bound_the_ninth(self):
        c=self.c;files=[self.part(str(i)) for i in range(9)]
        release=threading.Event();lock=threading.Lock();stats=self.stats
        original_command=c.command
        def command(*args):
            cmd=original_command(*args);cmd[cmd.index('-TimeoutSeconds')+1]='30';return cmd
        c.command=command
        class HeldAPI(relay.RelayAPI):
            def do_POST(self):
                if not urlparse(self.path).path.endswith('/assets'):return super().do_POST()
                with lock:
                    stats['active']+=1;stats['peak']=max(stats['peak'],stats['active']);stats['posts']+=1
                try:
                    release.wait(20)
                    super().do_POST()
                finally:
                    with lock:stats['active']-=1
        c.server.RequestHandlerClass=HeldAPI
        with ResidentContext(c) as r:
            try:
                for file in files[:8]:self.assertTrue(r.call('TransferUpload',key=c.key,file=file)['pending'])
                until=time.monotonic()+3
                while stats['active']<8 and time.monotonic()<until:time.sleep(.02)
                self.assertEqual(stats['active'],8)
                self.assertEqual(r.call('TransferUpload',key=c.key,file=files[8],ok=False)['code'],'UPLOAD_SLOTS_BUSY')
                before=len(c.ctx['gets']);started=time.monotonic();r.call('Poll');elapsed=time.monotonic()-started
                self.assertLess(elapsed,3,'eight data uploads consumed every control connection')
                self.assertGreater(len(c.ctx['gets']),before,'must exercise network control, not only local Status')
                self.assertEqual(stats['active'],8)
                print(json.dumps({'eight_uploads':{'peak':stats['peak'],'control_http_ms':elapsed*1000,'ninth':'UPLOAD_SLOTS_BUSY'}}),flush=True)
            finally:release.set()
            for file in files[:8]:self.assertIn('sha256',self.collect(r,file))
        self.assertEqual(stats['posts'],8)
        trace=c.folder/'windows-inner'/'transfer-timing'/(hashlib.sha256(c.key.encode()).hexdigest()+'.jsonl')
        events=[json.loads(line) for line in trace.read_text().splitlines()]
        self.assertEqual(sum(e['kind']=='transfer_part_started' for e in events),8)
        self.assertEqual(sum(e['kind']=='transfer_part_http_finished' for e in events),8)
        self.assertTrue(all(e['key']==c.key for e in events))

    def test_lost_upload_response_and_restart_reconcile_without_another_post(self):
        c=self.c;file=self.part('lost');c.ctx['provision_mode']['asset']='after'
        r=Resident(c,'windows-inner')
        try:
            self.assertTrue(r.call('TransferUpload',key=c.key,file=file)['pending'])
            until=time.monotonic()+5
            while not c.ctx['release_assets'] and time.monotonic()<until:time.sleep(.03)
            self.assertEqual(len(c.ctx['release_assets']),1)
        finally:r.close(kill=True)
        c.ctx['provision_mode']={}
        with ResidentContext(c) as resumed:
            result=self.collect(resumed,file)
            self.assertEqual(result['sha256'],hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(self.stats['posts'],1)

    def test_rate_limit_blocks_new_posts_but_allows_confirmed_sibling_collection(self):
        c=self.c;files=[self.part(str(i)) for i in range(3)]
        original=c.server.RequestHandlerClass
        class RateAPI(original):
            def do_POST(self):
                if urlparse(self.path).path.endswith('/assets') and not self.ctx.get('limited_once'):
                    self.ctx['limited_once']=True
                    self.rfile.read(int(self.headers['Content-Length']))
                    time.sleep(.5)
                    return self.reply({},429,{'Retry-After':'5'})
                super().do_POST()
        c.server.RequestHandlerClass=RateAPI
        with ResidentContext(c) as r:
            for file in files[:2]:self.assertTrue(r.call('TransferUpload',key=c.key,file=file)['pending'])
            time.sleep(1.3)
            self.assertEqual(r.call('TransferUpload',key=c.key,file=files[2],ok=False)['code'],'CHANNEL_COOLDOWN')
            self.assertEqual(r.call('TransferUpload',key=c.key,file=files[0],ok=False)['code'],'RATE_LIMITED')
            self.assertIn('sha256',self.collect(r,files[1]))
        self.assertEqual(len(c.ctx['release_assets']),1)

    def test_write_spacing_is_shared_with_concurrent_parts(self):
        c=self.c;c.config['write_interval_seconds']=3;c.write_config()
        first,second=self.part('first'),self.part('second')
        with ResidentContext(c) as r:
            self.assertTrue(r.call('TransferUpload',key=c.key,file=first)['pending'])
            error=r.call('TransferUpload',key=c.key,file=second,ok=False)
            self.assertEqual(error['code'],'WRITE_COOLDOWN')
            self.assertGreater(error['retry_at'],0)
            c.ctx['gets'].clear()
            self.assertEqual(r.call('TransferUpload',key=c.key,file=second,ok=False)['code'],'WRITE_COOLDOWN')
            self.assertEqual(c.ctx['gets'],[],'local pacing discarded valid metadata and repeated network reads')
            self.assertIn('sha256',self.collect(r,first))
        self.assertEqual(self.stats['posts'],1)

    def test_uncertain_unreceived_post_is_not_immediately_replayed(self):
        c=self.c;file=self.part('unknown');c.ctx['drop_delivery_once']={'result-asset':1}
        with ResidentContext(c) as r:
            self.assertTrue(r.call('TransferUpload',key=c.key,file=file)['pending'])
            time.sleep(1.3)
            failed=r.call('TransferUpload',key=c.key,file=file,ok=False)
            self.assertNotEqual(failed['code'],'UPLOAD_REJECTED')
        self.assertEqual(self.stats['posts'],1)
        with ResidentContext(c) as r:
            code=r.call('TransferUpload',key=c.key,file=file,ok=False)['code']
            self.assertIn(code,['REQUEST_COOLDOWN','UPLOAD_RECONCILE_PENDING'])
        self.assertEqual(self.stats['posts'],1)

    def test_cached_absence_losing_422_race_reads_fresh_inventory_and_verifies_bytes(self):
        c=self.c;first,second=self.part('first'),self.part('second')
        with ResidentContext(c) as r:
            self.collect(r,first)
            digest=hashlib.sha256(second.read_bytes()).hexdigest();name='result--windows-inner--'+digest+'.zip'
            release=next(iter(c.ctx['releases'].values()));url='/assets/'+release['tag_name']+'/'+name
            c.ctx['assets'][url]=second.read_bytes()
            c.ctx['release_assets'].append(dict(id=999,name=name,size=second.stat().st_size,release_id=release['id'],state='uploaded',browser_download_url=c.base+url))
            original=c.server.RequestHandlerClass
            class RaceAPI(original):
                def do_POST(self):
                    if parse_qs(urlparse(self.path).query).get('name')==[name]:
                        self.rfile.read(int(self.headers['Content-Length']));self.ctx['race_422']=True
                        return self.reply({},422)
                    super().do_POST()
            c.server.RequestHandlerClass=RaceAPI
            result=self.collect(r,second)
            self.assertEqual(result['sha256'],digest);self.assertTrue(c.ctx['race_422'])
            self.assertIn(url,c.ctx['gets']);self.assertEqual(len(c.ctx['release_assets']),2)

    def starter_fixture(self, age=300, owned=True, mode='normal'):
        c=self.c;file=self.part('starter');digest=hashlib.sha256(file.read_bytes()).hexdigest()
        name='result--windows-inner--'+digest+'.zip';release=next(iter(c.ctx['releases'].values()))
        url='/assets/'+release['tag_name']+'/'+name
        stamp=datetime.fromtimestamp(time.time()-age,timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        asset=dict(id=999,name=name,size=file.stat().st_size,state='starter',digest=None,
                   created_at=stamp,updated_at=stamp,release_id=release['id'],browser_download_url=c.base+url)
        c.ctx['release_assets'].append(asset);c.ctx['deletes']=[]
        if owned:
            state=c.read_state('windows-inner')
            state['uploads']['upload:'+c.key+':'+digest]=dict(status='uncertain',bytes=file.stat().st_size,
                name=name,manifest=None,http=502,attempts=1,last_attempt_at=int(time.time())-age)
            relay.legacy.ConnectorTests.write_state(c,'windows-inner',state)
        original=c.server.RequestHandlerClass
        class StarterAPI(original):
            def do_GET(self):
                if self.path=='/repos/test/tasks/releases/assets/999':
                    if mode=='completed':
                        asset.update(state='uploaded',digest='sha256:'+digest);self.ctx['assets'][url]=file.read_bytes()
                    return self.reply(asset if asset in self.ctx['release_assets'] else {},200 if asset in self.ctx['release_assets'] else 404)
                super().do_GET()
            def do_DELETE(self):
                self.ctx['deletes'].append(self.path)
                if mode=='rate':return self.reply({},429,{'Retry-After':'5'})
                if self.path!='/repos/test/tasks/releases/assets/999':return self.reply({},404)
                if asset in self.ctx['release_assets']:self.ctx['release_assets'].remove(asset)
                if mode=='lost':
                    self.close_connection=True;self.connection.close();return
                return self.reply({},204)
        c.server.RequestHandlerClass=StarterAPI
        return file,asset

    def test_stale_starter_recovers_original_part_after_restart_without_deleting_uploaded_sibling(self):
        c=self.c;file,asset=self.starter_fixture()
        sibling={**asset,'id':998,'name':'unrelated.zip','state':'uploaded','digest':'sha256:'+'1'*64}
        c.ctx['release_assets'].append(sibling)
        with ResidentContext(c) as r:
            error=r.call('TransferUpload',key=c.key,file=file,ok=False)
            self.assertEqual(error['code'],'UPLOAD_RECONCILE_PENDING')
            self.assertEqual(c.ctx['deletes'],[],'first observation must not delete')
        time.sleep(1.1)
        with ResidentContext(c) as r:
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'UPLOAD_RECONCILE_PENDING')
            self.assertEqual(c.ctx['deletes'],['/repos/test/tasks/releases/assets/999'])
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'UPLOAD_RECONCILE_PENDING')
            time.sleep(1.1)
            result=self.collect(r,file)
            self.assertEqual(result['sha256'],hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertIn(sibling,c.ctx['release_assets']);self.assertEqual(self.stats['posts'],1)

    def test_recent_starter_is_waited_for_and_never_deleted(self):
        file,asset=self.starter_fixture(age=0)
        with ResidentContext(self.c) as r:
            self.assertEqual(r.call('TransferUpload',key=self.c.key,file=file,ok=False)['code'],'UPLOAD_RECONCILE_PENDING')
        self.assertEqual(self.c.ctx['deletes'],[]);self.assertEqual(self.stats['posts'],0)

    def test_starter_without_persisted_local_upload_intent_is_not_deleted(self):
        file,asset=self.starter_fixture(owned=False)
        with ResidentContext(self.c) as r:
            self.assertEqual(r.call('TransferUpload',key=self.c.key,file=file,ok=False)['code'],'ASSET_CONFLICT')
        self.assertEqual(self.c.ctx['deletes'],[]);self.assertEqual(self.stats['posts'],0)

    def test_starter_completed_before_delete_is_verified_and_reused(self):
        c=self.c;file,asset=self.starter_fixture(mode='completed')
        with ResidentContext(c) as r:
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'UPLOAD_RECONCILE_PENDING')
            time.sleep(1.1)
            self.assertEqual(self.collect(r,file)['sha256'],hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(c.ctx['deletes'],[]);self.assertEqual(self.stats['posts'],0)

    def test_starter_cleanup_rate_limit_blocks_new_uploads(self):
        c=self.c;file,asset=self.starter_fixture(mode='rate')
        with ResidentContext(c) as r:
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'UPLOAD_RECONCILE_PENDING')
            time.sleep(1.1)
            error=r.call('TransferUpload',key=c.key,file=file,ok=False)
            self.assertEqual(error['code'],'RATE_LIMITED_429');self.assertGreater(error['retry_at'],time.time())
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'CHANNEL_COOLDOWN')
        self.assertIn(asset,c.ctx['release_assets']);self.assertEqual(self.stats['posts'],0)

    def test_starter_lost_delete_response_reconciles_absence_after_restart(self):
        c=self.c;file,asset=self.starter_fixture(mode='lost')
        with ResidentContext(c) as r:
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'UPLOAD_RECONCILE_PENDING')
            time.sleep(1.1)
            error=r.call('TransferUpload',key=c.key,file=file,ok=False)
            self.assertNotEqual(error['code'],'ASSET_CONFLICT')
        self.assertNotIn(asset,c.ctx['release_assets']);self.assertEqual(self.stats['posts'],0)
        time.sleep(5.1)
        with ResidentContext(c) as r:
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'UPLOAD_RECONCILE_PENDING')
            time.sleep(1.1)
            self.assertIn('sha256',self.collect(r,file))
        # HttpClient may replay an idempotent DELETE after a connection loss.
        self.assertEqual(set(c.ctx['deletes']),{'/repos/test/tasks/releases/assets/999'});self.assertEqual(self.stats['posts'],1)

    def test_uploaded_asset_with_wrong_digest_remains_a_conflict_without_cleanup(self):
        c=self.c;file,asset=self.starter_fixture()
        asset.update(state='uploaded',digest='sha256:'+'0'*64)
        with ResidentContext(c) as r:
            self.assertEqual(r.call('TransferUpload',key=c.key,file=file,ok=False)['code'],'ARTIFACT_HASH_MISMATCH')
        self.assertEqual(c.ctx['deletes'],[]);self.assertEqual(self.stats['posts'],0)
class ResidentContext:
    def __init__(self,case):self.case=case
    def __enter__(self):self.runtime=Resident(self.case,'windows-inner');return self.runtime
    def __exit__(self,*args):self.runtime.close()
