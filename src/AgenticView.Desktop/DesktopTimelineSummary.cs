using System.Text.Json;
using System.Text.Json.Nodes;
namespace AgenticView.Desktop;

internal static class DesktopTimelineSummary
{
    private static readonly HashSet<string> EventNames=["Paint","PrePaint","UpdateLayerTree","Layerize","Commit","DrawFrame","CompositeLayers","Layout","UpdateLayoutTree","RecalculateStyles","FunctionCall","RunTask","PaintArtifactCompositor::Update","AnimationHost::TickAnimations","AnimationHost::NeedsTickAnimations"];
    internal static JsonObject Summarize(ReadOnlyMemory<byte> trace)
    {
        using var document=JsonDocument.Parse(trace);
        if(document.RootElement.ValueKind!=JsonValueKind.Object||!document.RootElement.TryGetProperty("traceEvents",out var events)||events.ValueKind!=JsonValueKind.Array)throw new InvalidOperationException("Invalid timeline JSON.");
        var compositorStarts=new Dictionary<string,int>();var compositorTruncated=false;
        var animationTracks=new Dictionary<string,string>();var animationDecisions=new List<(string Track,uint Bits)>();var decisionTruncated=false;var invalidations=new Dictionary<string,int>();var costs=new Dictionary<string,(int Count,double Total,double Max,int CpuCount,double CpuTotal,double CpuMax)>();var count=0;var matched=0;var truncated=false;
        foreach(var item in events.EnumerateArray()){
            count++;
            if(item.ValueKind==JsonValueKind.Object&&item.TryGetProperty("name",out var ccName)&&ccName.ValueKind==JsonValueKind.String&&ccName.GetString()=="KeyframeModel"&&item.TryGetProperty("ph",out var ccPhase)&&ccPhase.ValueKind==JsonValueKind.String&&ccPhase.GetString()=="b"&&item.TryGetProperty("args",out var ccArgs)&&ccArgs.ValueKind==JsonValueKind.Object&&ccArgs.TryGetProperty("Name",out var ccLabel)&&ccLabel.ValueKind==JsonValueKind.String&&ccLabel.GetString() is string ccModel&&ccModel.Length<=160){if(compositorStarts.ContainsKey(ccModel)||compositorStarts.Count<64)compositorStarts[ccModel]=compositorStarts.GetValueOrDefault(ccModel)+1;else compositorTruncated=true;}
            if(item.ValueKind==JsonValueKind.Object&&item.TryGetProperty("name",out var animationName)&&animationName.ValueKind==JsonValueKind.String&&animationName.GetString()=="Animation"&&item.TryGetProperty("args",out var animationArgs)&&animationArgs.ValueKind==JsonValueKind.Object&&animationArgs.TryGetProperty("data",out var animationData)&&animationData.ValueKind==JsonValueKind.Object){
                var track=item.TryGetProperty("id2",out var trackId)?trackId.GetRawText():item.TryGetProperty("id",out trackId)?trackId.GetRawText():"";
                if(track.Length>0&&track.Length<256){
                    if(item.TryGetProperty("pid",out var processId))track=processId.GetRawText()+":"+track;
                    var label=animationData.TryGetProperty("name",out var cameraName)&&cameraName.ValueKind==JsonValueKind.String?cameraName.GetString():null;
                    if(label is not("canvas-camera-x" or "canvas-camera-y" or "canvas-camera-scale")&&animationData.TryGetProperty("nodeName",out var cameraNode)&&cameraNode.ValueKind==JsonValueKind.String)label=cameraNode.GetString() switch{"DIV class='world'"=>"canvas-camera-x","DIV class='world-y'"=>"canvas-camera-y","DIV class='world-scale'"=>"canvas-camera-scale",_=>null};
                    if(label is "canvas-camera-x" or "canvas-camera-y" or "canvas-camera-scale"&&animationTracks.Count<128)animationTracks[track]=label;
                    if(animationData.TryGetProperty("compositeFailed",out var failed)&&failed.ValueKind==JsonValueKind.Number&&failed.TryGetUInt32(out var bits)){if(animationDecisions.Count<512)animationDecisions.Add((track,bits));else decisionTruncated=true;}
                }
            }
            if(item.ValueKind==JsonValueKind.Object&&item.TryGetProperty("name",out var invalidationName)&&invalidationName.ValueKind==JsonValueKind.String&&invalidationName.GetString() is string tracking&&tracking.EndsWith("InvalidationTracking",StringComparison.Ordinal)){
                var reason=tracking;if(item.TryGetProperty("args",out var args)&&args.ValueKind==JsonValueKind.Object&&args.TryGetProperty("data",out var data)&&data.ValueKind==JsonValueKind.Object&&data.TryGetProperty("reason",out var why)&&why.ValueKind==JsonValueKind.String)reason+=": "+why.GetString();reason=reason[..Math.Min(reason.Length,240)];if(invalidations.ContainsKey(reason)||invalidations.Count<128)invalidations[reason]=invalidations.GetValueOrDefault(reason)+1;
            }
            if(item.ValueKind!=JsonValueKind.Object||!item.TryGetProperty("ph",out var phase)||phase.ValueKind!=JsonValueKind.String||phase.GetString()!="X"||!item.TryGetProperty("name",out var nameValue)||nameValue.ValueKind!=JsonValueKind.String)continue;
            var name=nameValue.GetString()!;
            if(name.Length>160||!(EventNames.Contains(name)||name.StartsWith("AX",StringComparison.Ordinal)||name.Contains("accessibility",StringComparison.OrdinalIgnoreCase)))continue;
            if(!item.TryGetProperty("dur",out var duration)||duration.ValueKind!=JsonValueKind.Number||!duration.TryGetDouble(out var microseconds)||!double.IsFinite(microseconds)||microseconds<0||microseconds>86_400_000_000)continue;
            matched++;
            if(!costs.ContainsKey(name)&&costs.Count>=128){truncated=true;continue;}
            var hasCpu=item.TryGetProperty("tdur",out var cpu)&&cpu.ValueKind==JsonValueKind.Number&&cpu.TryGetDouble(out var cpuMicroseconds)&&double.IsFinite(cpuMicroseconds)&&cpuMicroseconds>=0&&cpuMicroseconds<=86_400_000_000;
            var cpuMs=hasCpu?cpu.GetDouble()/1000:0;var old=costs.GetValueOrDefault(name);costs[name]=(old.Count+1,old.Total+microseconds/1000,Math.Max(old.Max,microseconds/1000),old.CpuCount+(hasCpu?1:0),old.CpuTotal+cpuMs,Math.Max(old.CpuMax,cpuMs));
        }
        var failures=new JsonArray();foreach(var group in animationDecisions.Where(x=>animationTracks.ContainsKey(x.Track)).GroupBy(x=>(Name:animationTracks[x.Track],x.Bits)))failures.Add(new JsonObject{["animation"]=group.Key.Name,["reasonBits"]=group.Key.Bits,["count"]=group.Count()});
        var top=new JsonArray();foreach(var item in costs.OrderByDescending(pair=>pair.Value.Total).Take(50))top.Add(new JsonObject{["name"]=item.Key,["count"]=item.Value.Count,["totalMs"]=item.Value.Total,["maxMs"]=item.Value.Max,["cpuSamples"]=item.Value.CpuCount,["cpuTotalMs"]=item.Value.CpuCount>0?JsonValue.Create(item.Value.CpuTotal):null,["cpuMaxMs"]=item.Value.CpuCount>0?JsonValue.Create(item.Value.CpuMax):null});
        var result=new JsonObject{["categories"]=new JsonArray("devtools.timeline","disabled-by-default-devtools.timeline.invalidationTracking","cc","blink"),["invalidationReasons"]=JsonSerializer.SerializeToNode(invalidations),["controllingCompositorModelStarts"]=JsonSerializer.SerializeToNode(compositorStarts),["controllingTransformStarts"]=compositorStarts.Where(x=>x.Key.Split('-').ElementAtOrDefault(1)=="0").Sum(x=>x.Value),["compositorStartsTruncated"]=compositorTruncated,["compositorModelScope"]="cc KeyframeModel begin records controlling impl models entering RUNNING across captured processes; names are curve/property/group, not JS animation IDs. Associate with the acknowledged restart window; no automatic camera attribution.",["cameraAnimationTracks"]=animationTracks.Count,["cameraAnimationDecisions"]=failures,["animationDecisionsTruncated"]=decisionTruncated,["animationDecisionScope"]="Failure reason bitsets only for observed named camera tracks. Missing decisions do not prove compositor execution; recreate camera after acknowledged native profile start to observe eligibility.",["eventCount"]=count,["matchedCompleteEvents"]=matched,["top"]=top,["truncated"]=truncated||costs.Count>50,["scope"]="Known named complete (X) timeline events only, across captured processes/threads. Inclusive durations overlap; do not add totals. totalMs/maxMs are wall time; cpuTotalMs/cpuMaxMs cover only events carrying thread CPU tdur (cpuSamples), otherwise null. Absent events are not proof of zero cost. No screenshots/snapshots, physical input or compositor presentation measurement."};
        return Bound(result,24000,"invalidationReasons","controllingCompositorModelStarts","cameraAnimationDecisions","top");
    }
    // Budget the actual serialized UTF-8, including JSON escaping. Raw private
    // artifacts retain all records; only the returned summary loses tail rows.
    internal static JsonObject Bound(JsonObject result,int byteLimit,params string[] collections)
    {
        var omitted=new JsonObject();
        foreach(var field in collections){
            while(System.Text.Encoding.UTF8.GetByteCount(result.ToJsonString())>byteLimit){
                var collection=result[field];
                if(collection is JsonArray {Count:>0} array)array.RemoveAt(array.Count-1);
                else if(collection is JsonObject {Count:>0} map)map.Remove(map.Last().Key);
                else break;
                omitted[field]=(omitted[field]?.GetValue<int>()??0)+1;
                result["summaryTruncated"]=true;
                if(omitted.Parent is null)result["summaryOmittedEntries"]=omitted;
            }
        }
        if(System.Text.Encoding.UTF8.GetByteCount(result.ToJsonString())>byteLimit)throw new InvalidOperationException("Diagnostic metadata exceeded its summary byte budget.");
        return result;
    }
}
