using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace AgenticView.Desktop;

// Fixed read-only native timeline diagnostics. No caller-controlled CDP method,
// category, stream, filename, URL, script, screenshot or snapshot is accepted.
internal sealed class DesktopTimeline(CoreWebView2 core) : IAsyncDisposable
{
    private const int ByteLimit=67_108_864;
    private readonly TaskCompletionSource<(string Stream,bool DataLoss)> completion=new(TaskCreationOptions.RunContinuationsAsynchronously);
    private CoreWebView2DevToolsProtocolEventReceiver? receiver;
    private bool started,ended,disposed;
    private string? stream,unavailable;
    private void OnComplete(object? sender,CoreWebView2DevToolsProtocolEventReceivedEventArgs e)
    {
        try{
            if(e.SessionId.Length!=0)return;
            using var document=JsonDocument.Parse(e.ParameterObjectAsJson);
            var value=document.RootElement;
            if(!value.TryGetProperty("stream",out var handle)||handle.ValueKind!=JsonValueKind.String||handle.GetString() is not {Length:>0 and <=256} text){completion.TrySetException(new InvalidOperationException("Timeline stream was not returned."));return;}
            stream=text;
            if(!value.TryGetProperty("dataLossOccurred",out var loss)||loss.ValueKind is not (JsonValueKind.True or JsonValueKind.False)){completion.TrySetException(new InvalidOperationException("Timeline completion omitted data-loss status."));return;}
            completion.TrySetResult((text,loss.GetBoolean()));
        }catch(Exception error) when(error is JsonException or InvalidOperationException){completion.TrySetException(new InvalidOperationException("Invalid timeline completion."));}
    }
    public async Task Start()
    {
        try{
            receiver=core.GetDevToolsProtocolEventReceiver("Tracing.tracingComplete");receiver.DevToolsProtocolEventReceived+=OnComplete;
            // Only this positive category filter is enabled. Sampling is provided
            // separately by Profiler; fixed cc/blink events identify compositor
            // execution and full rebuilds without enabling picture/snapshot data.
            await core.CallDevToolsProtocolMethodAsync("Tracing.start","""
                {"transferMode":"ReturnAsStream","streamFormat":"json","streamCompression":"none","traceConfig":{"recordMode":"recordUntilFull","traceBufferSizeInKb":32768,"enableSampling":false,"enableSystrace":false,"includedCategories":["devtools.timeline","disabled-by-default-devtools.timeline.invalidationTracking","cc","blink"]}}
                """);
            started=true;
        }catch(Exception){unavailable="Native timeline tracing is unavailable or already in use.";Detach();}
    }
    public async Task<JsonObject> Finish(string directory,string id)
    {
        if(!started)return new JsonObject{["timelineUnavailable"]=unavailable??"Native timeline did not start."};
        try{
            await End();
            var captured=await completion.Task.WaitAsync(TimeSpan.FromSeconds(10));stream=captured.Stream;
            using var output=new MemoryStream();var readDeadline=Stopwatch.StartNew();
            for(var reads=0;reads<1024;reads++){
                if(readDeadline.Elapsed.TotalSeconds>=10)throw new TimeoutException("Timeline read deadline elapsed.");
                var remaining=TimeSpan.FromSeconds(10)-readDeadline.Elapsed;
                var raw=await core.CallDevToolsProtocolMethodAsync("IO.read",JsonSerializer.Serialize(new{handle=stream,size=65536})).WaitAsync(remaining);
                if(raw.Length>262144)throw new InvalidOperationException("Timeline chunk exceeds its bound.");
                using var chunk=JsonDocument.Parse(raw);var value=chunk.RootElement;
                var text=value.GetProperty("data").GetString()??throw new InvalidOperationException("Timeline chunk is not text.");
                var bytes=value.TryGetProperty("base64Encoded",out var encoded)&&encoded.ValueKind==JsonValueKind.True?Convert.FromBase64String(text):Encoding.UTF8.GetBytes(text);
                if(bytes.Length>65536||output.Length+bytes.Length>ByteLimit)throw new InvalidOperationException("Timeline exceeds its 64MiB byte cap.");
                await output.WriteAsync(bytes);
                if(value.GetProperty("eof").GetBoolean()){
                    var trace=output.ToArray();var summary=Summarize(trace);
                    if(!Guid.TryParseExact(id,"D",out _))throw new InvalidOperationException("Invalid timeline artifact identity.");
                    if(Directory.EnumerateFiles(directory,"*.timeline.json").Take(16).Count()>=16)throw new InvalidOperationException("Timeline artifact limit reached.");
                    await File.WriteAllBytesAsync(Path.Combine(directory,id+".timeline.json"),trace);
                    summary["artifactId"]=id;summary["sha256"]=Convert.ToHexStringLower(SHA256.HashData(trace));summary["bytes"]=trace.Length;summary["dataLossOccurred"]=captured.DataLoss;
                    return new JsonObject{["timeline"]=summary};
                }
            }
            throw new InvalidOperationException("Timeline chunk count cap reached.");
        }catch(Exception){return new JsonObject{["timelineUnavailable"]="Native timeline unavailable, incomplete, or exceeded its time/byte/artifact bound. CPU profile remains available."};}
        finally{await DisposeAsync();}
    }
    internal static JsonObject Summarize(ReadOnlyMemory<byte> trace)=>DesktopTimelineSummary.Summarize(trace);
    private async Task End(){if(!started||ended)return;await core.CallDevToolsProtocolMethodAsync("Tracing.end","{}").WaitAsync(TimeSpan.FromSeconds(10));ended=true;}
    private void Detach(){if(receiver is not null){receiver.DevToolsProtocolEventReceived-=OnComplete;receiver=null;}}
    public async ValueTask DisposeAsync()
    {
        if(disposed)return;disposed=true;
        try{if(started&&!ended){try{await End();}catch(Exception){}}}
        finally{
            try{
                // End may produce its stream during cleanup after CPU capture fails.
                if(started&&stream is null){try{var captured=await completion.Task.WaitAsync(TimeSpan.FromSeconds(10));stream=captured.Stream;}catch(Exception){}}
                if(stream is not null){var handle=stream;stream=null;try{await core.CallDevToolsProtocolMethodAsync("IO.close",JsonSerializer.Serialize(new{handle})).WaitAsync(TimeSpan.FromSeconds(5));}catch(Exception){}}
            }finally{Detach();}
        }
    }
}
