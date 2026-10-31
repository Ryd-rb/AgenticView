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
    private static readonly HashSet<string> EventNames=["Paint","PrePaint","UpdateLayerTree","Layerize","Commit","DrawFrame","CompositeLayers","Layout","UpdateLayoutTree","RecalculateStyles","FunctionCall","RunTask"];
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
            // separately by Profiler; only the fixed invalidation metadata category is added.
            await core.CallDevToolsProtocolMethodAsync("Tracing.start","""
                {"transferMode":"ReturnAsStream","streamFormat":"json","streamCompression":"none","traceConfig":{"recordMode":"recordUntilFull","traceBufferSizeInKb":32768,"enableSampling":false,"enableSystrace":false,"includedCategories":["devtools.timeline","disabled-by-default-devtools.timeline.invalidationTracking"]}}
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
    internal static JsonObject Summarize(ReadOnlyMemory<byte> trace)
    {
        using var document=JsonDocument.Parse(trace);
        if(document.RootElement.ValueKind!=JsonValueKind.Object||!document.RootElement.TryGetProperty("traceEvents",out var events)||events.ValueKind!=JsonValueKind.Array)throw new InvalidOperationException("Invalid timeline JSON.");
        var invalidations=new Dictionary<string,int>();var costs=new Dictionary<string,(int Count,double Total,double Max)>();var count=0;var matched=0;var truncated=false;
        foreach(var item in events.EnumerateArray()){
            count++;
            if(item.ValueKind==JsonValueKind.Object&&item.TryGetProperty("name",out var invalidationName)&&invalidationName.ValueKind==JsonValueKind.String&&invalidationName.GetString() is string tracking&&tracking.EndsWith("InvalidationTracking",StringComparison.Ordinal)){
                var reason=tracking;if(item.TryGetProperty("args",out var args)&&args.TryGetProperty("data",out var data)&&data.TryGetProperty("reason",out var why)&&why.ValueKind==JsonValueKind.String)reason+=": "+why.GetString();reason=reason[..Math.Min(reason.Length,240)];if(invalidations.ContainsKey(reason)||invalidations.Count<128)invalidations[reason]=invalidations.GetValueOrDefault(reason)+1;
            }
            if(item.ValueKind!=JsonValueKind.Object||!item.TryGetProperty("ph",out var phase)||phase.ValueKind!=JsonValueKind.String||phase.GetString()!="X"||!item.TryGetProperty("name",out var nameValue)||nameValue.ValueKind!=JsonValueKind.String)continue;
            var name=nameValue.GetString()!;
            if(name.Length>160||!(EventNames.Contains(name)||name.StartsWith("AX",StringComparison.Ordinal)||name.Contains("accessibility",StringComparison.OrdinalIgnoreCase)))continue;
            if(!item.TryGetProperty("dur",out var duration)||duration.ValueKind!=JsonValueKind.Number||!duration.TryGetDouble(out var microseconds)||!double.IsFinite(microseconds)||microseconds<0||microseconds>86_400_000_000)continue;
            matched++;
            if(!costs.ContainsKey(name)&&costs.Count>=128){truncated=true;continue;}
            var old=costs.GetValueOrDefault(name);costs[name]=(old.Count+1,old.Total+microseconds/1000,Math.Max(old.Max,microseconds/1000));
        }
        var top=new JsonArray();foreach(var item in costs.OrderByDescending(pair=>pair.Value.Total).Take(50))top.Add(new JsonObject{["name"]=item.Key,["count"]=item.Value.Count,["totalMs"]=item.Value.Total,["maxMs"]=item.Value.Max});
        return new JsonObject{["categories"]=new JsonArray("devtools.timeline","disabled-by-default-devtools.timeline.invalidationTracking"),["invalidationReasons"]=JsonSerializer.SerializeToNode(invalidations),["eventCount"]=count,["matchedCompleteEvents"]=matched,["top"]=top,["truncated"]=truncated||costs.Count>50,["scope"]="Known named complete (X) timeline events only, across captured processes/threads. Inclusive durations overlap; do not add totals. Absent events are not proof of zero cost. No screenshots/snapshots, physical input or compositor presentation measurement."};
    }
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
