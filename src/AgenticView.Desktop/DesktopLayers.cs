using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;

namespace AgenticView.Desktop;

// Fixed compositor metadata only. Never calls any LayerTree snapshot/picture API.
internal static class DesktopLayers
{
    private const string Scope="Compositor topology metadata: at most4096layers,24largest reason samples and32tiny candidates checked for exact canvas-camera-source class. Shared5second deadline including cleanup. No DOM content, attributes, URLs, images, pictures, snapshots, physical input or presentation timing returned. An empty sourceLayers collection leaves source composition state unknown.";
    private sealed class MetadataFailure(string reasonCode,string stage):Exception {internal string ReasonCode=>reasonCode;internal string Stage=>stage;}
    private sealed record LayerEvent(JsonArray? Layers,string? ReasonCode);
    private static bool NativeUnavailable(Exception error)=>error is COMException or InvalidOperationException or OperationCanceledException;
    private static JsonObject Unavailable(string reasonCode,string stage)=>new(){["available"]=false,["reasonCode"]=reasonCode,["stage"]=stage,["scope"]=Scope,["recovery"]="Use metrics to check renderer availability. Retry layers after the current operation completes; this result cannot establish layer-composition state."};
    private static bool LayerShape(JsonObject layer)
    {
        foreach(var key in new[]{"width","height"})if(layer[key] is not JsonValue value||!value.TryGetValue<double>(out var number)||!double.IsFinite(number)||number<0)return false;
        if(layer["drawsContent"] is not JsonValue draws||!draws.TryGetValue<bool>(out _))return false;
        if(layer["layerId"] is not JsonValue id||!id.TryGetValue<string>(out var text)||text.Length is <1 or >256)return false;
        if(layer["invisible"] is not null&&(layer["invisible"] is not JsonValue invisible||!invisible.TryGetValue<bool>(out _)))return false;
        if(layer["paintCount"] is not null&&(layer["paintCount"] is not JsonValue paint||!paint.TryGetValue<long>(out var paints)||paints<0))return false;
        if(layer["scrollRects"] is not null){if(layer["scrollRects"] is not JsonArray rects)return false;foreach(var node in rects.Take(256))if(node is not JsonObject rect||rect["type"] is not JsonValue type||!type.TryGetValue<string>(out _))return false;}
        return true;
    }
    public static async Task<JsonObject> Capture(CoreWebView2 core)
    {
        var watch=Stopwatch.StartNew();var stage="receiver";
        TimeSpan Remaining(bool cleanup=false,int maximumMs=1000){var ms=(cleanup?5000:4500)-watch.Elapsed.TotalMilliseconds;if(ms<=0)throw new TimeoutException("Layer metadata deadline expired.");return TimeSpan.FromMilliseconds(Math.Min(ms,cleanup?500:maximumMs));}
        async Task<string> Call(string method,string parameters,bool cleanup=false,int maximumMs=1000){var timeout=cleanup?TimeSpan.Zero:Remaining(false,maximumMs);try{var task=core.CallDevToolsProtocolMethodAsync(method,parameters);_ = task.ContinueWith(t=>{_ = t.Exception;},TaskContinuationOptions.OnlyOnFaulted|TaskContinuationOptions.ExecuteSynchronously);return await task.WaitAsync(cleanup?Remaining(true):timeout);}catch(Exception error)when(NativeUnavailable(error)){throw new MetadataFailure("native-unavailable",stage);}}
        static Dictionary<string,int> ScrollReasons(JsonObject layer){var reasons=new Dictionary<string,int>();if(layer["scrollRects"] is JsonArray rects)foreach(var rect in rects.Take(256)){var reason=rect?["type"]?.GetValue<string>();if(reason is "RepaintsOnScroll" or "TouchEventHandler" or "WheelEventHandler")reasons[reason]=reasons.GetValueOrDefault(reason)+1;}return reasons;}
        async Task<bool> Reasons(JsonObject layer,JsonObject item,string key){
            try{
                if(watch.ElapsedMilliseconds>=4500||layer["layerId"] is not JsonValue id)throw new InvalidOperationException();
                var raw=await Call("LayerTree.compositingReasons",new JsonObject{["layerId"]=id.DeepClone()}.ToJsonString());if(raw.Length>32768)throw new InvalidOperationException();
                var reasons=JsonNode.Parse(raw)?["compositingReasonIds"] as JsonArray??throw new InvalidOperationException();
                var values=reasons.OfType<JsonValue>().Select(value=>value.GetValue<string>()).Take(8).ToArray();
                if(values.Any(value=>value.Length==0||value.Any(character=>!char.IsAsciiLetterOrDigit(character)&&character is not('_' or '-'))))throw new InvalidOperationException();
                item[key]=new JsonArray(values.Select(value=>(JsonNode?)JsonValue.Create(value[..Math.Min(value.Length,80)])).ToArray());
                item["reasonIdsOmittedCount"]=Math.Max(0,reasons.Count-values.Length);item["reasonIdsTruncated"]=reasons.Count>values.Length||values.Any(value=>value.Length>80);return true;
            }catch(Exception error)when(error is MetadataFailure or JsonException or TimeoutException||NativeUnavailable(error)){item["reasonsUnavailable"]=true;return false;}
        }
        var first=new TaskCompletionSource<LayerEvent>(TaskCreationOptions.RunContinuationsAsynchronously);
        CoreWebView2DevToolsProtocolEventReceiver? receiver=null;var subscribed=false;
        void Changed(object? sender,CoreWebView2DevToolsProtocolEventReceivedEventArgs args)
        {
            try{
                if(args.SessionId.Length!=0)return;
                var raw=args.ParameterObjectAsJson;
                if(raw.Length>2_097_152){first.TrySetResult(new(null,"event-character-limit"));return;}
                var root=JsonNode.Parse(raw);
                if(root is not JsonObject obj){first.TrySetResult(new(null,"event-malformed"));return;}
                if(obj["layers"] is null){first.TrySetResult(new(null,"native-unavailable"));return;}
                first.TrySetResult(obj["layers"] is JsonArray layers?new(layers,null):new(null,"event-malformed"));
            }catch(JsonException){first.TrySetResult(new(null,"event-malformed"));}
            catch(ArgumentException){first.TrySetResult(new(null,"event-malformed"));}
            catch(Exception error)when(NativeUnavailable(error)){first.TrySetResult(new(null,"native-unavailable"));}
        }
        try{
            try{receiver=core.GetDevToolsProtocolEventReceiver("LayerTree.layerTreeDidChange");receiver.DevToolsProtocolEventReceived+=Changed;subscribed=true;}
            catch(Exception error)when(NativeUnavailable(error)){throw new MetadataFailure("native-unavailable",stage);}
            stage="enable";
            await Call("LayerTree.enable","{}",maximumMs:3000);
            stage="event";
            var received=await first.Task.WaitAsync(Remaining(maximumMs:3000));
            if(received.ReasonCode is not null)return Unavailable(received.ReasonCode,stage);
            var layers=received.Layers!;
            if(layers.Take(4096).Any(node=>node is not JsonObject layer||!LayerShape(layer)))return Unavailable("event-malformed",stage);
            stage="summary";
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
                }catch(Exception error)when(error is MetadataFailure or JsonException or TimeoutException||NativeUnavailable(error)){nodeUnavailable++;}
            }
            var sample=new JsonArray();var largestReasonsUnavailable=0;
            foreach(var layer in bounded.OrderByDescending(x=>x["drawsContent"]?.GetValue<bool>()==true).ThenByDescending(x=>(x["width"]?.GetValue<double>()??0)*(x["height"]?.GetValue<double>()??0)).Take(24)){
                var item=new JsonObject();foreach(var key in new[]{"width","height","paintCount","drawsContent","invisible"})if(layer[key] is not null)item[key]=layer[key]!.DeepClone();
                item["sticky"]=layer["stickyPositionConstraint"] is not null;
                if(!await Reasons(layer,item,"reasons"))largestReasonsUnavailable++;
                sample.Add(item);
            }
            return DesktopTimelineSummary.Bound(new JsonObject{["available"]=true,["layerCount"]=layers.Count,["sampledLayerCount"]=bounded.Length,["drawsContentCount"]=bounded.Count(x=>x["drawsContent"]?.GetValue<bool>()==true),["stickyCount"]=bounded.Count(x=>x["stickyPositionConstraint"] is not null),["scrollReasons"]=JsonSerializer.SerializeToNode(scrollReasons),["largestLayers"]=sample,["largestReasonsUnavailableCount"]=largestReasonsUnavailable,["sourceLayers"]=sources,["tinyCandidateCount"]=tiny.Length,["sourceCandidatesInspectedCount"]=inspected,["sourceCandidatesOmittedCount"]=Math.Max(0,tiny.Length-32),["sourceCandidatesUninspectedCount"]=uninspected,["sourceCandidatesNoBackendNodeCount"]=noBackendNode,["sourceNodeUnavailableCount"]=nodeUnavailable,["sourceReasonsUnavailableCount"]=sourceReasonsUnavailable,["deadlineReached"]=watch.ElapsedMilliseconds>=4500,["truncated"]=layers.Count>bounded.Length||tiny.Length>32||uninspected>0,["scope"]=Scope},40000,"largestLayers","sourceLayers");
        }catch(MetadataFailure error){return Unavailable(error.ReasonCode,error.Stage);}
        catch(TimeoutException){return Unavailable(stage=="event"?"event-deadline":"collection-deadline",stage);}
        finally{
            if(subscribed&&receiver is not null)try{receiver.DevToolsProtocolEventReceived-=Changed;}catch(Exception error)when(NativeUnavailable(error)){}
            try{await Call("LayerTree.disable","{}",true);}catch(Exception error)when(error is MetadataFailure or TimeoutException||NativeUnavailable(error)){}
        }
    }
}
