using System;
using System.Diagnostics;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace AIConnector {
    // Only network I/O runs asynchronously. PowerShell remains the sole owner
    // of grants, upload intents, rate limits and durable confirmation state.
    public sealed class UploadHttp {
        private readonly Stopwatch watch = Stopwatch.StartNew();
        public Task<HttpResponseMessage> Task { get; private set; }
        public long ElapsedMilliseconds { get { return watch.ElapsedMilliseconds; } }
        public UploadHttp(HttpClient client, HttpRequestMessage request, CancellationToken token) {
            Task = Send(client, request, token);
        }
        private async Task<HttpResponseMessage> Send(HttpClient client, HttpRequestMessage request, CancellationToken token) {
            try { return await client.SendAsync(request, HttpCompletionOption.ResponseContentRead, token).ConfigureAwait(false); }
            finally { watch.Stop(); }
        }
    }
}
