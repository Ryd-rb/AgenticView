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
            await core.CallDevToolsProtocolMethodAsync("LayerTree.enable","{}").WaitAsync(TimeSpan.FromSeconds(3));
            var layers=await first.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var bounded=layers.OfType<JsonObject>().Take(4096).ToArray();
            var scrollReasons=new Dictionary<string,int>();
            foreach(var layer in bounded)if(layer["scrollRects"] is JsonArray rects)foreach(var rect in rects.Take(256)){
                var reason=rect?["type"]?.GetValue<string>();if(reason is "RepaintsOnScroll" or "TouchEventHandler" or "WheelEventHandler")scrollReasons[reason]=scrollReasons.GetValueOrDefault(reason)+1;
            }
            var sample=new JsonArray();var watch=Stopwatch.StartNew();
            foreach(var layer in bounded.OrderByDescending(x=>x["drawsContent"]?.GetValue<bool>()==true).ThenByDescending(x=>(x["width"]?.GetValue<double>()??0)*(x["height"]?.GetValue<double>()??0)).Take(24)){
                var item=new JsonObject();foreach(var key in new[]{"width","height","paintCount","drawsContent","invisible"})if(layer[key] is not null)item[key]=layer[key]!.DeepClone();
                item["sticky"]=layer["stickyPositionConstraint"] is not null;
                if(watch.Elapsed.TotalSeconds<3&&layer["layerId"] is JsonValue id){
                    try{var raw=await core.CallDevToolsProtocolMethodAsync("LayerTree.compositingReasons",new JsonObject{["layerId"]=id.DeepClone()}.ToJsonString()).WaitAsync(TimeSpan.FromSeconds(1));if(raw.Length>32768)throw new InvalidOperationException();var reasons=JsonNode.Parse(raw)?["compositingReasonIds"] as JsonArray;item["reasons"]=new JsonArray((reasons??[]).OfType<JsonValue>().Select(value=>value.GetValue<string>()).Take(8).Select(value=>(JsonNode?)JsonValue.Create(value[..Math.Min(value.Length,80)])).ToArray());}
                    catch(Exception){item["reasonsUnavailable"]=true;}
                }
                sample.Add(item);
            }
            return new JsonObject{["available"]=true,["layerCount"]=layers.Count,["sampledLayerCount"]=bounded.Length,["drawsContentCount"]=bounded.Count(x=>x["drawsContent"]?.GetValue<bool>()==true),["stickyCount"]=bounded.Count(x=>x["stickyPositionConstraint"] is not null),["scrollReasons"]=JsonSerializer.SerializeToNode(scrollReasons),["largestLayers"]=sample,["truncated"]=layers.Count>bounded.Length,["scope"]="Compositor topology metadata, at most4096layers and24reason samples. No images, pictures, snapshots, physical input or presentation timing."};
        }finally{receiver.DevToolsProtocolEventReceived-=Changed;try{await core.CallDevToolsProtocolMethodAsync("LayerTree.disable","{}").WaitAsync(TimeSpan.FromSeconds(2));}catch(Exception){}}
    }
}
