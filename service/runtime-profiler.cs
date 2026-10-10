// Exclusive wall-time accounting in the resident PowerShell process. The timer
// runs outside the PS runspace, including while a cmdlet/HTTP/pipe is blocked.
// Never touches the protocol ledger; no URLs, paths, payloads or credentials.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
namespace AIConnector {
    public sealed class RuntimeProfiler : IDisposable {
        readonly object gate = new object();
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly Process process = Process.GetCurrentProcess();
        readonly DateTime origin = DateTime.UtcNow;
        readonly string file;
        readonly string session = Guid.NewGuid().ToString("N");
        readonly Stack<string> stages = new Stack<string>();
        readonly Dictionary<string,double> parts = new Dictionary<string,double>();
        readonly object writeGate = new object();
        readonly SortedDictionary<long,Window> pending = new SortedDictionary<long,Window>();
        readonly AutoResetEvent wake = new AutoResetEvent(false);
        readonly Thread writer;
        readonly int pid;
        long dropped;
        bool stopping;
        sealed class Window {
            public long bucket;
            public double elapsed, cpu, sampleMax;
            public bool partial;
            public Dictionary<string,double> parts;
        }
        Timer timer;
        string operation = "", action = "idle", key = "";
        double last = 0, cpuLast, cpu = 0, sampleMax = 0;
        long bucket = 0;
        bool disposed;
        public RuntimeProfiler(string output) {
            file = output;
            pid = process.Id;
            cpuLast = process.TotalProcessorTime.TotalMilliseconds;
            writer = new Thread(WriteLoop); writer.IsBackground = true; writer.Start();
            timer = new Timer(Sample, null, 1000, 1000);
        }
        static string Safe(string value, string pattern) {
            return value != null && Regex.IsMatch(value, pattern) ? value : "";
        }
        string Identity() { return operation+"\t"+action+"\t"+key+"\t"+(stages.Count>0?stages.Peek():action=="idle"?"idle":"control.other")+"\t"+(stages.Count>1?stages.ToArray()[1]:""); }
        void Account() {
            double now = clock.Elapsed.TotalMilliseconds;
            double currentCpu = process.TotalProcessorTime.TotalMilliseconds;
            double length = now-last, deltaCpu = Math.Max(0,currentCpu-cpuLast);
            string identity = Identity();
            while (now > last) {
                double end = Math.Min(now,(bucket+1)*10000.0);
                double elapsed = end-last;
                string slot = identity;
                if (!parts.ContainsKey(slot) && parts.Count >= 255) slot="\tother\t\ttelemetry.overflow\t";
                if (!parts.ContainsKey(slot)) parts[slot]=0;
                parts[slot]+=elapsed;
                cpu+=length>0?deltaCpu*elapsed/length:0;
                sampleMax=Math.Max(sampleMax,length);
                last=end;
                if (last >= (bucket+1)*10000.0) {
                    Emit(10000,false); bucket++; parts.Clear(); cpu=0; sampleMax=0;
                }
            }
            cpuLast=currentCpu;
        }
        static string N(double v) { return v.ToString("0.###",CultureInfo.InvariantCulture); }
        static string Time(DateTime v) { return v.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture); }
        void Emit(double elapsed, bool partial) {
            // Snapshot only while holding the accounting lock. Disk access and
            // JSON formatting run on one persistent writer, never this lock.
            var row = new Window { bucket=bucket, elapsed=elapsed, cpu=cpu,
                sampleMax=sampleMax, partial=partial, parts=new Dictionary<string,double>(parts) };
            lock(writeGate) {
                if(!pending.ContainsKey(row.bucket) && pending.Count>=16) {
                    var oldest=pending.Keys.GetEnumerator();oldest.MoveNext();long first=oldest.Current;oldest.Dispose();
                    pending.Remove(first);Interlocked.Increment(ref dropped);
                }
                // Newer partial/full samples supersede the same queued window.
                pending[row.bucket]=row;
            }
            wake.Set();
        }
        void WriteLoop() {
            while(true) {
                Window row=null;
                lock(writeGate) {
                    if(pending.Count>0) {
                        var oldest=pending.GetEnumerator();oldest.MoveNext();var entry=oldest.Current;oldest.Dispose();
                        row=entry.Value;pending.Remove(entry.Key);
                    } else if(stopping) return;
                }
                if(row==null) { wake.WaitOne(1000);continue; }
                Write(row);
            }
        }
        void Write(Window row) {
            try {
                var text = new StringBuilder();
                text.Append("{\"schema\":\"aiconnector.runtime-window.v1\",\"source\":\"connector\",\"session\":\"").Append(session);
                text.Append("\",\"pid\":").Append(pid).Append(",\"window\":").Append(row.bucket);
                text.Append(",\"window_start\":\"").Append(Time(origin.AddMilliseconds(row.bucket*10000.0)));
                text.Append("\",\"window_end\":\"").Append(Time(origin.AddMilliseconds(row.bucket*10000.0+row.elapsed)));
                text.Append("\",\"elapsed_ms\":").Append(N(row.elapsed)).Append(",\"cpu_ms\":").Append(N(row.cpu));
                text.Append(",\"cpu_sample_max_ms\":").Append(N(row.sampleMax)).Append(",\"partial\":").Append(row.partial?"true":"false");
                text.Append(",\"dropped_windows\":").Append(Interlocked.Read(ref dropped));
                text.Append(",\"segments\":["); bool first=true;
                foreach(var item in row.parts) {
                    string[] fields=item.Key.Split('\t');
                    if(!first)text.Append(',');first=false;
                    text.Append("{\"operation_id\":\"").Append(fields[0]).Append("\",\"action\":\"").Append(fields[1]);
                    text.Append("\",\"key\":\"").Append(fields[2]).Append("\",\"stage\":\"").Append(fields[3]);
                    text.Append("\",\"parent_stage\":\"").Append(fields[4]).Append("\",\"wall_ms\":").Append(N(item.Value)).Append('}');
                }
                text.Append("]}\n");
                if(File.Exists(file) && new FileInfo(file).Length>=2097152) {
                    if(File.Exists(file+".1"))File.Delete(file+".1"); File.Move(file,file+".1");
                }
                File.AppendAllText(file,text.ToString(),new UTF8Encoding(false));
            } catch { Interlocked.Increment(ref dropped); } // No execution decision depends on logs.
        }
        void Sample(object state) { lock(gate) { if(!disposed)try { Account(); } catch { } } }
        public void Begin(string op, string kind, string run) { lock(gate) {
            Account(); operation=Safe(op,@"^[a-zA-Z0-9_-]{1,96}$");
            action=Safe(kind,@"^[a-zA-Z0-9_.-]{1,80}$");
            key=Safe(run,@"^[a-z0-9][a-z0-9_-]{0,63}/[1-9][0-9]{0,9}/[a-z0-9][a-z0-9_-]{0,63}$"); stages.Clear();
        } }
        public void Push(string stage) { lock(gate) { Account(); stages.Push(Safe(stage,@"^[a-zA-Z0-9_.-]{1,80}$")); } }
        public void Pop() { lock(gate) { Account(); if(stages.Count>0)stages.Pop(); } }
        public void End() { lock(gate) { Account(); double elapsed=last-bucket*10000.0; if(elapsed>0)Emit(elapsed,true); operation="";action="idle";key="";stages.Clear(); } }
        public void Dispose() {
            lock(gate) {
                if(disposed)return;
                try { Account(); double elapsed=last-bucket*10000.0; if(elapsed>0)Emit(elapsed,true); } catch { }
                disposed=true; timer.Dispose(); process.Dispose();
            }
            lock(writeGate) { stopping=true; } wake.Set();
            // Only process shutdown drains; normal actions never wait on IO.
            if(writer.Join(1000))wake.Dispose();
        }
    }
}
