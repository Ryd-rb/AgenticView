using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace AgenticView.Desktop;

// Read-only diagnostics for the trusted main document. No evaluation, input,
// arbitrary protocol method, filesystem path or screenshot crosses this bridge.
internal sealed class DesktopDiagnostics(string directory)
{
    private bool profiling;
    public async Task<JsonObject> Capture(CoreWebView2 core,string operation,int seconds)
    {
        if(operation=="metrics"){
            await core.CallDevToolsProtocolMethodAsync("Performance.enable","{}");
            var metrics=JsonNode.Parse(await core.CallDevToolsProtocolMethodAsync("Performance.getMetrics","{}"));
            var heap=JsonNode.Parse(await core.CallDevToolsProtocolMethodAsync("Runtime.getHeapUsage","{}"));
            var dom=JsonNode.Parse(await core.CallDevToolsProtocolMethodAsync("Memory.getDOMCounters","{}"));
            return new JsonObject{["runtime"]=core.Environment.BrowserVersionString,["metrics"]=metrics,["heap"]=heap,["dom"]=dom};
        }
        if(profiling)throw new InvalidOperationException("A profile is already active.");
        profiling=true;var started=false;
        try{
            await core.CallDevToolsProtocolMethodAsync("Profiler.enable","{}");
            await core.CallDevToolsProtocolMethodAsync("Profiler.setSamplingInterval","{\"interval\":1000}");
            await core.CallDevToolsProtocolMethodAsync("Profiler.start","{}");started=true;
            await Task.Delay(TimeSpan.FromSeconds(seconds));
            var raw=await core.CallDevToolsProtocolMethodAsync("Profiler.stop","{}");started=false;
            if(raw.Length>16_777_216)throw new InvalidOperationException("Profile exceeded its retained byte limit.");
            var profile=JsonNode.Parse(raw)!["profile"]!.AsObject();
            var nodes=profile["nodes"]!.AsArray().OfType<JsonObject>().ToDictionary(n=>n["id"]!.GetValue<int>());
            var samples=profile["samples"]!.AsArray();var deltas=profile["timeDeltas"]!.AsArray();
            var costs=new Dictionary<int,double>();
            for(var i=0;i<Math.Min(samples.Count,deltas.Count);i++){var node=samples[i]!.GetValue<int>();costs[node]=costs.GetValueOrDefault(node)+deltas[i]!.GetValue<double>();}
            var top=new JsonArray();foreach(var cost in costs.OrderByDescending(c=>c.Value).Take(80)){
                var frame=nodes[cost.Key]["callFrame"]!;var name=frame["functionName"]!.GetValue<string>();
                top.Add(new JsonObject{["function"]=name[..Math.Min(name.Length,160)],["line"]=frame["lineNumber"]!.GetValue<int>(),["column"]=frame["columnNumber"]!.GetValue<int>(),["sampledMs"]=cost.Value/1000});
            }
            var id=Guid.NewGuid().ToString("D");var root=Path.Combine(directory,"diagnostics");Directory.CreateDirectory(root);
            // At most 16 profiles per private window profile; fail closed rather than grow indefinitely.
            if(Directory.EnumerateFiles(root,"*.cpuprofile").Take(16).Count()>=16)throw new InvalidOperationException("Retained profile limit reached; archive diagnostic evidence before collecting more.");
            var bytes=System.Text.Encoding.UTF8.GetBytes(profile.ToJsonString());if(bytes.Length>16_777_216)throw new InvalidOperationException("Profile exceeded its retained byte limit.");await File.WriteAllBytesAsync(Path.Combine(root,id+".cpuprofile"),bytes);
            return new JsonObject{["artifactId"]=id,["sha256"]=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),["bytes"]=bytes.Length,["samples"]=samples.Count,["durationSeconds"]=seconds,["top"]=top,["scope"]="Renderer JavaScript samples; idle/GC included. Raw profile retained in the private native profile."};
        }finally{if(started){try{await core.CallDevToolsProtocolMethodAsync("Profiler.stop","{}");}catch(Exception){}}profiling=false;}
    }
}
