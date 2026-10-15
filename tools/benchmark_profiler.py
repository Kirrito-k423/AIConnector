"""Bounded CPU/IO accounting audit; no Relay, secrets or live task state.
Runs on Mac pwsh or Windows powershell.exe. Baseline is a frozen source file.
"""
import argparse, hashlib, json, os, platform, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DRIVER=r'''
public interface IBench : System.IDisposable {
 void Begin(string op,string action,string key);void Push(string stage);void Pop();void End();
}
public sealed class Off : IBench {
 public void Begin(string o,string a,string k){}public void Push(string s){}public void Pop(){}public void End(){}public void Dispose(){}
}
public static class IoFault {
 public static System.Threading.ManualResetEvent Started=new System.Threading.ManualResetEvent(false);
 public static void Delay(){Started.Set();System.Threading.Thread.Sleep(250);}
}
public static class ProfilerBench {
 public static string Run(string mode,string kind,string file,int count) {
  var process=System.Diagnostics.Process.GetCurrentProcess();var total=System.Diagnostics.Stopwatch.StartNew();
  double before=process.TotalProcessorTime.TotalMilliseconds;
  IBench p=mode=="off"?(IBench)new Off():mode=="baseline"?(IBench)new Baseline.RuntimeProfiler(file):(IBench)new Candidate.RuntimeProfiler(file);
  double setup=total.Elapsed.TotalMilliseconds;uint result=1;
  var hot=System.Diagnostics.Stopwatch.StartNew();
  if(kind=="stages")p.Begin("bench","Poll","sample/1/run-1");
  for(int i=0;i<count;i++) {
   if(kind=="actions")p.Begin("bench"+i,"Status","sample/1/run-1");
   p.Push("runs.project");p.Push("canonical");
   for(int n=0;n<32;n++)result=unchecked(result*1664525u+1013904223u);
   p.Pop();p.Pop();if(kind=="actions")p.End();
  }
  if(kind=="stages")p.End();double hotMs=hot.Elapsed.TotalMilliseconds;
  p.Dispose();double elapsed=total.Elapsed.TotalMilliseconds,cpu=process.TotalProcessorTime.TotalMilliseconds-before;
  return "{\"mode\":\""+mode+"\",\"kind\":\""+kind+"\",\"count\":"+count+",\"setup_ms\":"+setup.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+",\"hot_ms\":"+hotMs.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+",\"total_ms\":"+elapsed.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+",\"cpu_ms\":"+cpu.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+",\"checksum\":"+result+"}";
 }
 public static double Stall(string mode,string file) {
  IoFault.Started.Reset();IBench p=mode=="baseline"?(IBench)new BaselineSlow.RuntimeProfiler(file):(IBench)new CandidateSlow.RuntimeProfiler(file);
  p.Begin("slow","Poll","sample/1/run-1");p.Push("http");p.Pop();
  var thread=new System.Threading.Thread(()=>p.End());thread.Start();
  if(!IoFault.Started.WaitOne(3000))throw new System.Exception("injected write did not start");
  var sw=System.Diagnostics.Stopwatch.StartNew();p.Push("canonical");p.Pop();double elapsed=sw.Elapsed.TotalMilliseconds;
  thread.Join();p.Dispose();return elapsed;
 }
}
'''

def run(baseline,output,powershell):
    current=ROOT/'service/runtime-profiler.cs';old=baseline.read_text(encoding='utf-8-sig');new=current.read_text()
    sources=[]
    for name,body,slow in [('Baseline',old,False),('Candidate',new,False),('BaselineSlow',old,True),('CandidateSlow',new,True)]:
        body=body.replace('namespace AIConnector','namespace '+name).replace('RuntimeProfiler : IDisposable','RuntimeProfiler : IBench')
        if slow:
            target='File.AppendAllText(file,text.ToString(),new UTF8Encoding(false));'
            assert target in body,'fault-injection anchor changed'
            body=body.replace(target,'IoFault.Delay(); '+target)
        sources.append(body)
    # Each source has file-scope using declarations; nested namespaces keep
    # the real profiler body intact while compiling one assembly under PS5.1.
    combined=DRIVER+'\n'+'\n'.join('namespace Wrapper'+str(i)+' {\n'+s+'\n}' for i,s in enumerate(sources))
    # Driver type references qualify the four wrapper namespaces.
    for i,name in enumerate(['Baseline','Candidate','BaselineSlow','CandidateSlow']):combined=combined.replace('new '+name+'.','new Wrapper'+str(i)+'.'+name+'.')
    quote=lambda s:"'"+str(s).replace("'","''")+"'"
    with tempfile.TemporaryDirectory(prefix='AIC profiler benchmark ') as temporary:
        folder=Path(temporary);code=folder/'bench.cs';code.write_text(combined,encoding='utf-8-sig');script=folder/'bench.ps1'
        script.write_text("$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition ([IO.File]::ReadAllText("+quote(code)+"))\n"
            "$rows=@();$root="+quote(folder)+"\n"
            "foreach($kind in @('stages','actions')) { $count=10000;if($kind -eq 'actions'){$count=100}\n"
            "for($pair=0;$pair -lt 7;$pair++) { $order=@('off','baseline','candidate');if($pair%2){$order=@('candidate','baseline','off')}\n"
            "foreach($mode in $order){$file=Join-Path $root ($kind+'-'+$mode+'-'+$pair+'.jsonl');$r=ConvertFrom-Json ([ProfilerBench]::Run($mode,$kind,$file,$count));$r|Add-Member pair $pair;$r|Add-Member warmup ($pair -eq 0);$r|Add-Member log_bytes 0;foreach($f in @($file,($file+'.1'))){if([IO.File]::Exists($f)){$r.log_bytes+=([IO.FileInfo]::new($f)).Length}};$rows+=,$r}}}\n"
            "$stalls=@();foreach($mode in @('baseline','candidate')){$stalls+=@{mode=$mode;blocked_ms=[ProfilerBench]::Stall($mode,(Join-Path $root ($mode+'-slow.jsonl')))}}\n"
            "ConvertTo-Json @{ps=$PSVersionTable.PSVersion.ToString();samples=$rows;slow_io=$stalls} -Depth 10 -Compress\n",encoding='utf-8-sig')
        result=subprocess.run([powershell,'-NoProfile','-File',str(script)],capture_output=True,text=True,timeout=180)
        if result.returncode:raise RuntimeError(result.stderr[-4000:])
        data=json.loads(result.stdout);data.update(platform=platform.platform(),processor=platform.machine(),cpu_count=os.cpu_count(),baseline_sha256=hashlib.sha256(baseline.read_bytes()).hexdigest(),candidate_sha256=hashlib.sha256(current.read_bytes()).hexdigest(),scope='Local compiled profiler overhead and injected 250 ms log IO; not a Windows intranet E2E benchmark. First pair is warmup; subsequent pairs alternate order.')
        for kind in ['stages','actions']:
            assert len({r['checksum'] for r in data['samples'] if r['kind']==kind})==1
        output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(data,indent=2)+'\n')
        print(json.dumps({'output':str(output),'samples':len(data['samples']),'slow_io':data['slow_io']}))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--baseline',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--powershell',default=os.environ.get('PWSH','powershell.exe' if os.name=='nt' else 'pwsh'));a=p.parse_args();run(a.baseline,a.output,a.powershell)
