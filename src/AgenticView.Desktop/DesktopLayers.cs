using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace AgenticView.Desktop;

// Fixed compositor metadata only. Never calls any LayerTree snapshot/picture API.
internal static class DesktopLayers
{
    public static async Task<JsonObject> Capture(CoreWebView2 core)
    {
        var watch=Stopwatch.StartNew();
        TimeSpan Remaining(bool cleanup=false,int maximumMs=1000){var ms=(cleanup?5000:4500)-watch.Elapsed.TotalMilliseconds;if(ms<=0)throw new TimeoutException("Layer metadata deadline expired.");return TimeSpan.FromMilliseconds(Math.Min(ms,cleanup?500:maximumMs));}
        async Task<string> Call(string method,string parameters,bool cleanup=false,int maximumMs=1000){var timeout=cleanup?TimeSpan.Zero:Remaining(false,maximumMs);var task=core.CallDevToolsProtocolMethodAsync(method,parameters);_ = task.ContinueWith(t=>{_ = t.Exception;},TaskContinuationOptions.OnlyOnFaulted|TaskContinuationOptions.ExecuteSynchronously);return await task.WaitAsync(cleanup?Remaining(true):timeout);}
        static Dictionary<string,int> ScrollReasons(JsonObject layer){var reasons=new Dictionary<string,int>();if(layer["scrollRects"] is JsonArray rects)foreach(var rect in rects.Take(256)){var reason=rect?["type"]?.GetValue<string>();if(reason is "RepaintsOnScroll" or "TouchEventHandler" or "WheelEventHandler")reasons[reason]=reasons.GetValueOrDefault(reason)+1;}return reasons;}
        async Task<bool> Reasons(JsonObject layer,JsonObject item,string key){
            try{
                if(watch.ElapsedMilliseconds>=4500||layer["layerId"] is not JsonValue id)throw new InvalidOperationException();
                var raw=await Call("LayerTree.compositingReasons",new JsonObject{["layerId"]=id.DeepClone()}.ToJsonString());if(raw.Length>32768)throw new InvalidOperationException();
                var reasons=JsonNode.Parse(raw)?["compositingReasonIds"] as JsonArray??throw new InvalidOperationException();
                var values=reasons.OfType<JsonValue>().Select(value=>value.GetValue<string>()).Take(8).ToArray();
                item[key]=new JsonArray(values.Select(value=>(JsonNode?)JsonValue.Create(value[..Math.Min(value.Length,80)])).ToArray());
                item["reasonIdsOmittedCount"]=Math.Max(0,reasons.Count-values.Length);item["reasonIdsTruncated"]=reasons.Count>values.Length||values.Any(value=>value.Length>80);return true;
            }catch(Exception){item["reasonsUnavailable"]=true;return false;}
        }
        var first=new TaskCompletionSource<JsonArray>(TaskCreationOptions.RunContinuationsAsynchronously);
        var receiver=core.GetDevToolsProtocolEventReceiver("LayerTree.layerTreeDidChange");
        void Changed(object? sender,CoreWebView2DevToolsProtocolEventReceivedEventArgs args)
        {
            if(args.SessionId.Length!=0)return;
            try{if(args.ParameterObjectAsJson.Length>2_097_152)throw new InvalidOperationException();var root=JsonNode.Parse(args.ParameterObjectAsJson);if(root?["layers"] is JsonArray layers)first.TrySetResult(layers);}
            catch(Exception error) when(error is JsonException or InvalidOperationException){first.TrySetException(new InvalidOperationException("Layer metadata exceeded its bound or was malformed."));}
        }
        receiver.DevToolsProtocolEventReceived+=Changed;
        try{
            await Call("LayerTree.enable","{}",maximumMs:3000);
            var layers=await first.Task.WaitAsync(Remaining(maximumMs:3000));
            var bounded=layers.OfType<JsonObject>().Take(4096).ToArray();
            var scrollReasons=new Dictionary<string,int>();
            foreach(var layer in bounded)foreach(var reason in ScrollReasons(layer)){
                scrollReasons[reason.Key]=scrollReasons.GetValueOrDefault(reason.Key)+reason.Value;
            }
            var tiny=bounded.Where(layer=>(layer["width"]?.GetValue<double>()??double.PositiveInfinity)<=8||(layer["height"]?.GetValue<double>()??double.PositiveInfinity)<=8).ToArray();
            var sources=new JsonArray();var inspected=0;var nodeUnavailable=0;var noBackendNode=0;var uninspected=0;var sourceReasonsUnavailable=0;
            foreach(var layer in tiny.Take(32)){
                if(watch.ElapsedMilliseconds>=4500){uninspected++;continue;}
                if(layer["backendNodeId"] is not JsonValue backend||!backend.TryGetValue<int>(out var backendId)||backendId<=0){noBackendNode++;continue;}
                try{
                    inspected++;
                    // Fixed shallow metadata lookup. Attributes are consumed only to
                    // match this one app-owned class and never leave this method.
                    var raw=await Call("DOM.describeNode",new JsonObject{["backendNodeId"]=backendId,["depth"]=0,["pierce"]=false}.ToJsonString());
                    if(raw.Length>65536)throw new InvalidOperationException();
                    var attributes=JsonNode.Parse(raw)?["node"]?["attributes"] as JsonArray;
                    if(attributes is null)continue;
                    if(attributes.Count>512)throw new InvalidOperationException();
                    var match=false;
                    for(var i=0;i+1<Math.Min(attributes.Count,512);i+=2)if(attributes[i]?.GetValue<string>()=="class"){
                        match=(attributes[i+1]?.GetValue<string>()??"").Split([' ','\t','\r','\n','\f'],StringSplitOptions.RemoveEmptyEntries).Contains("canvas-camera-source",StringComparer.Ordinal);break;
                    }
                    if(!match)continue;
                    var source=new JsonObject();foreach(var key in new[]{"width","height","drawsContent"})if(layer[key] is not null)source[key]=layer[key]!.DeepClone();
                    for(var i=0;i+1<attributes.Count;i+=2)if(attributes[i]?.GetValue<string>()=="data-camera-axis"&&attributes[i+1]?.GetValue<string>() is "x" or "y" or "scale")source["axis"]=attributes[i+1]!.DeepClone();
                    source["scrollReasons"]=JsonSerializer.SerializeToNode(ScrollReasons(layer));
                    source["scrollRectsOmittedCount"]=Math.Max(0,(layer["scrollRects"] as JsonArray)?.Count-256??0);
                    if(!await Reasons(layer,source,"compositingReasonIds"))sourceReasonsUnavailable++;
                    sources.Add(source);
                }catch(Exception){nodeUnavailable++;}
            }
            var sample=new JsonArray();var largestReasonsUnavailable=0;
            foreach(var layer in bounded.OrderByDescending(x=>x["drawsContent"]?.GetValue<bool>()==true).ThenByDescending(x=>(x["width"]?.GetValue<double>()??0)*(x["height"]?.GetValue<double>()??0)).Take(24)){
                var item=new JsonObject();foreach(var key in new[]{"width","height","paintCount","drawsContent","invisible"})if(layer[key] is not null)item[key]=layer[key]!.DeepClone();
                item["sticky"]=layer["stickyPositionConstraint"] is not null;
                if(!await Reasons(layer,item,"reasons"))largestReasonsUnavailable++;
                sample.Add(item);
            }
            return DesktopTimelineSummary.Bound(new JsonObject{["available"]=true,["layerCount"]=layers.Count,["sampledLayerCount"]=bounded.Length,["drawsContentCount"]=bounded.Count(x=>x["drawsContent"]?.GetValue<bool>()==true),["stickyCount"]=bounded.Count(x=>x["stickyPositionConstraint"] is not null),["scrollReasons"]=JsonSerializer.SerializeToNode(scrollReasons),["largestLayers"]=sample,["largestReasonsUnavailableCount"]=largestReasonsUnavailable,["sourceLayers"]=sources,["tinyCandidateCount"]=tiny.Length,["sourceCandidatesInspectedCount"]=inspected,["sourceCandidatesOmittedCount"]=Math.Max(0,tiny.Length-32),["sourceCandidatesUninspectedCount"]=uninspected,["sourceCandidatesNoBackendNodeCount"]=noBackendNode,["sourceNodeUnavailableCount"]=nodeUnavailable,["sourceReasonsUnavailableCount"]=sourceReasonsUnavailable,["deadlineReached"]=watch.ElapsedMilliseconds>=4500,["truncated"]=layers.Count>bounded.Length||tiny.Length>32||uninspected>0,["scope"]="Compositor topology metadata: at most4096layers,24largest reason samples and32tiny candidates checked for exact canvas-camera-source class. Shared5second deadline including cleanup. No DOM content, attributes, URLs, images, pictures, snapshots, physical input or presentation timing returned. An empty sourceLayers collection leaves source composition state unknown."},40000,"largestLayers","sourceLayers");
        }finally{receiver.DevToolsProtocolEventReceived-=Changed;try{await Call("LayerTree.disable","{}",true);}catch(Exception){}}
    }
}
