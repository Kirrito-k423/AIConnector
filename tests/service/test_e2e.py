"""Actual Node daemons, PS transport, Pi SDK and CPU process, with controlled relay/model APIs."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import test_relay as relay
from test_probe import ROOT, PWSH

NODE=os.environ.get('AIC_NODE') or shutil.which('node')
SERVICE_ROOT=Path(os.environ.get('AIC_SERVICE_ROOT',ROOT))
def port():
    with socket.socket() as s: s.bind(('127.0.0.1',0));return s.getsockname()[1]

class API(relay.RelayAPI):
    def do_GET(self):
        if self.ctx.get('offline'): return self.reply({},503)
        super().do_GET()
    def do_POST(self):
        if self.ctx.get('offline'):
            self.rfile.read(int(self.headers.get('Content-Length','0')))
            return self.reply({},429,{'Retry-After':'2'})
        super().do_POST()

class Model(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append(data)
        if self.server.pause: self.server.release.wait(40)
        results=[m for m in data['messages'] if m['role']=='tool']
        tool='run_experiment' if not results else 'submit_summary' if len(results)==1 else None
        args=dict(summary='实际 CPU sum=50005000。Pi 使用本地受控模型 API；未使用真实商业模型或 NPU。',metrics=dict(sum=50005000,fixture_model=True,npu=False)) if tool=='submit_summary' else {}
        base=dict(id='fixture',object='chat.completion.chunk',created=1,model=data['model'])
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        def send(delta,finish=None):
            self.wfile.write(('data: '+json.dumps(dict(base,choices=[dict(index=0,delta=delta,finish_reason=finish)]))+'\n\n').encode())
        try:
            send(dict(role='assistant'))
            if tool:
                send(dict(tool_calls=[dict(index=0,id='call-'+str(len(results)),type='function',function=dict(name=tool,arguments=json.dumps(args)))]));send({},'tool_calls')
            else:send(dict(content='完成'));send({},'stop')
            self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass

@unittest.skipUnless(PWSH and NODE,'requires PowerShell and Node')
class ServiceTests(unittest.TestCase):
    def setUp(self):
        relay.RelayTests.setUp(self)
        self.server.RequestHandlerClass=API
        self.model=ThreadingHTTPServer(('127.0.0.1',0),Model);self.model.daemon_threads=True
        self.model.calls=[];self.model.pause=False;self.model.release=threading.Event()
        self.mt=threading.Thread(target=self.model.serve_forever,daemon=True);self.mt.start()
        self.configs={};self.processes={};self.logs={};self.tokens={}
        for node in ['mac-outer','windows-inner']:
            c=dict(schema='aiconnector.service.v1',node=node,port=port(),connectorConfig=str(self.config_path),dataDir=str(self.folder/('service-'+node)),powershell=PWSH,proxy='direct',httpTimeoutSeconds=2,
              runner=dict(enabled=node=='windows-inner',timeoutSeconds=60,maxTurns=6,model=dict(api='openai-completions',baseUrl=f'http://127.0.0.1:{self.model.server_port}/v1',id='fixture',compat=dict(supportsDeveloperRole=False)),profiles={'local-smoke':dict(kind='builtin-smoke',repository='aiconnector-builtin',entry='smoke',outputs=['metrics.json'])}))
            path=self.folder/(node+'.local.json');path.write_text(json.dumps(c));self.configs[node]=(path,c)
        self.task.update(task_id='pi-smoke',code=dict(repository='aiconnector-builtin',revision='builtin-smoke-v1'),environment=dict(target='local-smoke'),invocation=dict(entry='smoke',arguments=[]))
        self.key='pi-smoke/1/run-001'
    write_config=relay.RelayTests.write_config
    write_inputs=relay.RelayTests.write_inputs

    def tearDown(self):
        self.model.release.set()
        for n in self.processes:self.stop(n)
        for log in self.logs.values():log.close()
        self.model.shutdown();self.model.server_close();self.mt.join()
        relay.RelayTests.tearDown(self)

    def launch(self,node):
        path,c=self.configs[node]
        self.logs[node]=open(self.folder/(node+'.log'),'ab')
        self.processes[node]=subprocess.Popen([NODE,str(SERVICE_ROOT/'service/cli.mjs'),'start','--config',str(path)],stdout=self.logs[node],stderr=subprocess.STDOUT,env=dict(os.environ,AICONNECTOR_GITHUB_TOKEN='MAC_TOKEN' if node=='mac-outer' else 'WIN_TOKEN',AICONNECTOR_AI_API_KEY='LOCAL_FIXTURE_KEY'))
        auth=Path(c['dataDir'])/'dashboard.token'
        self.until(lambda:auth.exists(),10);self.tokens[node]=auth.read_text()
        self.until(lambda:self.get(node),20)
    def stop(self,node):
        p=self.processes[node]
        if p.poll() is None:
            p.kill();p.wait(15)
        if node in self.logs:self.logs[node].close()
    def get(self,node,path='/api/status',data=None,token=None,headers=None):
        c=self.configs[node][1]
        request=urllib.request.Request(f'http://127.0.0.1:{c["port"]}{path}',data=json.dumps(data).encode() if data is not None else None,headers=dict(Authorization='Bearer '+(token or self.tokens[node]),**({'Content-Type':'application/json'} if data is not None else {}),**(headers or {})))
        try:
            with urllib.request.urlopen(request,timeout=3) as r:return json.load(r)
        except (ConnectionError,urllib.error.URLError) as e:
            if isinstance(e,urllib.error.HTTPError):
                e.msg=e.read().decode();e.close();raise
            return None
    def until(self,fn,seconds=100):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            value=fn()
            if value:return value
            time.sleep(.3)
        logs={n:(self.folder/(n+'.log')).read_text(errors='replace')[-3000:] for n in self.logs}
        states={n:self.get(n) for n,p in self.processes.items() if p.poll() is None}
        self.fail('Timeout: '+json.dumps(dict(logs=logs,states=states,api_gets=self.ctx['gets'][-20:],api_posts=self.ctx['posts'][-20:]),ensure_ascii=False))
    def phase(self,node,phase):
        s=self.get(node)
        return s and next((r for r in s['channel']['runs'] if r['key']==self.key and r['phase']==phase),None)
    def job(self,state=None):
        s=self.get('windows-inner');return s and next((j for j in s['jobs'] if j['key']==self.key and (state is None or j['state']==state)),None)
    def publish(self):
        data={'task':self.task}
        z=io.BytesIO()
        with zipfile.ZipFile(z,'w')as archive:archive.writestr('input.txt','public synthetic input')
        data['zipBase64']=base64.b64encode(z.getvalue()).decode()
        r=self.get('mac-outer','/api/tasks',data);self.assertEqual(r['key'],self.key)
        return data
    def test_full_loop_input_zip_dashboard_and_restart_after_receipt(self):
        self.launch('mac-outer');self.launch('windows-inner');data=self.publish()
        row=self.until(lambda:self.phase('mac-outer','receipt'))
        self.assertEqual(row['result']['outcome'],'succeeded');self.assertTrue(row['result']['execution']['started_at'])
        self.assertEqual(len(row['timeline']),5);self.assertEqual(len(self.model.calls),3)
        assets=self.ctx['assets'];self.assertEqual(len(assets),2)
        result=next(b for p,b in assets.items() if '/result--' in p)
        self.assertLess(len(result),5242880)
        with zipfile.ZipFile(io.BytesIO(result))as z:self.assertEqual(json.loads(z.read('metrics.json'))['sum'],50005000)
        self.until(lambda:self.job('confirmed'))
        self.stop('windows-inner');self.launch('windows-inner')
        self.get('mac-outer','/api/tasks',data);time.sleep(3)
        self.assertEqual(len(self.model.calls),3);self.assertEqual(len(self.ctx['comments']),5)
        self.assertTrue(all(self.phase('mac-outer','receipt')['timeline'][i]['published_at'].endswith('Z') for i in range(5)))
    def test_service_restart_during_pi_and_transport_outage_resumes_delivery(self):
        self.model.pause=True
        self.launch('mac-outer');self.launch('windows-inner');self.publish()
        self.until(lambda:len(self.model.calls)>0)
        self.ctx['offline']=True
        self.stop('windows-inner');self.launch('windows-inner')
        self.model.pause=False;self.model.release.set()
        self.until(lambda:(self.job() or {}).get('worker',{}).get('state')=='ready')
        self.assertEqual(len(self.model.calls),3)
        self.ctx['offline']=False
        self.until(lambda:self.phase('mac-outer','receipt'),130)
        self.assertEqual(len(self.model.calls),3);self.assertEqual(len(self.ctx['comments']),5)
    def test_worker_crash_keeps_unknown_and_does_not_reexecute(self):
        self.model.pause=True
        self.launch('mac-outer');self.launch('windows-inner');self.publish()
        self.until(lambda:len(self.model.calls)>0)
        job=self.until(lambda:self.job() if (self.job()or{}).get('worker')else None)
        pid=job['worker']['pid'];os.kill(pid,9)
        self.model.pause=False;self.model.release.set()
        self.until(lambda:self.job('unknown'))
        self.stop('windows-inner');self.launch('windows-inner');time.sleep(3)
        self.assertEqual(len(self.model.calls),1);self.assertEqual(self.job()['state'],'unknown')
        with self.assertRaises(urllib.error.HTTPError):self.get('windows-inner','/api/resolve-unknown',dict(key=self.key,remoteChecked=False))
        self.get('windows-inner','/api/resolve-unknown',dict(key=self.key,remoteChecked=True))
        row=self.until(lambda:self.phase('mac-outer','receipt'))
        self.assertEqual(row['result']['outcome'],'blocked');self.assertEqual(len(self.model.calls),1)
    def test_http_authorization_origin_host_and_profile_refusal(self):
        self.launch('mac-outer');self.launch('windows-inner')
        for kwargs in [dict(token='bad'),dict(headers={'Origin':'https://malicious.invalid'}),dict(headers={'Host':'malicious.invalid'})]:
            with self.assertRaises(urllib.error.HTTPError)as error:self.get('mac-outer',**kwargs)
            self.assertEqual(error.exception.code,403)
            error.exception.close()
        self.task['environment']['target']='unapproved';self.publish();self.until(lambda:self.phase('windows-inner','accepted'))
        self.until(lambda:self.get('windows-inner')['service']['runner_error']=='PROFILE_NOT_ALLOWED')
        self.assertEqual(len(self.model.calls),0);self.assertEqual(self.get('windows-inner')['jobs'],[])

    @unittest.skipUnless(os.name=='nt' or sys.platform=='darwin','native user service')
    def test_native_login_service_restarts_after_process_failure(self):
        node='windows-inner' if os.name=='nt' else 'mac-outer';path,c=self.configs[node]
        # This test creates only a temporary, uniquely named per-user service.
        def cli(action):
            return subprocess.run([NODE,str(SERVICE_ROOT/'service/cli.mjs'),action,'--config',str(path)],capture_output=True,encoding='utf-8',timeout=30)
        info=Path(c['dataDir'])/'service-info.json'
        try:
            r=cli('install');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
            self.until(lambda:info.exists(),35)
            first=json.loads(info.read_text())['pid'];self.tokens[node]=(Path(c['dataDir'])/'dashboard.token').read_text()
            self.until(lambda:self.get(node),20)
            os.kill(first,9)
            try:self.until(lambda:json.loads(info.read_text())['pid']!=first,140)
            except AssertionError as e:
                details={}
                log=Path(c['dataDir'])/'service.log'
                if log.exists():details['service_log']=log.read_text(errors='replace')[-3000:]
                if os.name=='nt':
                    name='AIConnector-'+hashlib.sha256(c['dataDir'].encode()).hexdigest()[:12]
                    details['task']=subprocess.run(['powershell.exe','-NoProfile','-Command',f"$env:PSModulePath=$PSHOME+'\\Modules'; Get-ScheduledTaskInfo -TaskName '{name}' | ConvertTo-Json"],capture_output=True,text=True,timeout=20).stdout
                raise AssertionError(str(e)+' NATIVE_DIAGNOSTICS: '+json.dumps(details))
            self.until(lambda:self.get(node),20)
        finally:
            cli('uninstall')
            if info.exists():cli('stop')

    @unittest.skipUnless(os.name=='nt' and 'AIC_SERVICE_ROOT' in os.environ,'real Windows package launcher')
    def test_windows_cmd_starts_bundled_runtime_without_node_on_path(self):
        node='windows-inner';path,c=self.configs[node];info=Path(c['dataDir'])/'service-info.json'
        env=dict(os.environ,AICONNECTOR_NO_PAUSE='1')
        # The actual .cmd must choose its bundled node.exe.
        for key in list(env):
            if key.lower()=='path':del env[key]
        env['PATH']=os.environ['SystemRoot']+'\\System32;'+os.environ['SystemRoot']+'\\System32\\WindowsPowerShell\\v1.0'
        try:
            p=subprocess.run(['cmd.exe','/d','/c','Open-Windows-Dashboard.cmd','--no-browser','--config',str(path)],cwd=SERVICE_ROOT,env=env,capture_output=True,encoding='utf-8',timeout=30)
            self.assertEqual(p.returncode,0,p.stdout+p.stderr);self.until(lambda:info.exists(),15)
            self.tokens[node]=(Path(c['dataDir'])/'dashboard.token').read_text();self.until(lambda:self.get(node),15)
        finally:
            if info.exists():subprocess.run([NODE,str(SERVICE_ROOT/'service/cli.mjs'),'stop','--config',str(path)],capture_output=True,timeout=30)

if __name__=='__main__':unittest.main()
