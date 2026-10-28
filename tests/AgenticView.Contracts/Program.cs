using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using AgenticView.Server;
using Microsoft.Data.Sqlite;
using System.Diagnostics;

if (args.Contains("--layout-probe"))
{
    Run((hub, _) => { var watch=Stopwatch.StartNew(); for(var i=0;i<100;i++) hub.Register(Input("probe-"+i)); watch.Stop(); Console.WriteLine(new JsonObject { ["synthetic"]=true,["registrations"]=100,["elapsedMs"]=watch.Elapsed.TotalMilliseconds,["layoutMs"]=hub.RegistrationLayoutMilliseconds }.ToJsonString()); });
    return 0;
}

var cases = new (string Name, Action Test)[]
{
    ("efficient deterministic bin packing respects fixed obstacles", PackingContracts.Run),
    ("observed Markdown row times survive reorder, transitions, duplicates and recovery", () => Run((hub, directory) => {
        var a=Register(hub); var id=S(a,"runId"); long sequence=0;
        void Markdown(string text) => Publish(hub,a,Batch(++sequence,new{op="upsert",component=new{id="tasks",title="Tasks",kind="markdown",data=new{text}}}));
        JsonArray Rows() => hub.GetRun(id)!["taskTimes"]!["tasks"]!.AsArray();
        Markdown("- [ ] Alpha\n- [x] Beta\n- [ ] Repeat\n- [ ] Repeat\n```md\n- [ ] Fenced\n```\n~~~\n- [x] Hidden\n~~~\n- ```md\n    - [ ] Nested fenced\n    ```\n> ~~~\n> - [ ] Quoted fenced\n> ~~~");
        var first=(JsonArray)Rows().DeepClone(); Check(first.Count==4,"Fenced task rows were observed");
        Check(first[0]!["startedAt"] is not null && first[0]!["completedAt"] is null,"Unchecked observation lacks start");
        Check(first[1]!["completedAt"] is not null && first[1]!["startedAt"] is null,"Initially completed task fabricated start");
        Check(first[2]!["key"]!.ToJsonString()!=first[3]!["key"]!.ToJsonString(),"Duplicate labels share timing identity");
        Markdown("- [x] Beta\n- [ ] Alpha\n- [ ] Repeat\n- [ ] Repeat"); var reordered=Rows();
        Check(reordered[0]!["key"]!.ToJsonString()==first[1]!["key"]!.ToJsonString() && reordered[0]!["line"]!.GetValue<int>()==1,"Reorder lost stable key or current line");
        Check(reordered[0]!["completedAt"]!.ToJsonString()==first[1]!["completedAt"]!.ToJsonString() && reordered[1]!["startedAt"]!.ToJsonString()==first[0]!["startedAt"]!.ToJsonString(),"Reorder rewrote observed times");
        Markdown("- [x] Beta\n- [x] Alpha\n- [ ] Repeat\n- [ ] Repeat"); var complete=(JsonArray)Rows().DeepClone(); Check(complete[1]!["completedAt"] is not null && complete[1]!["startedAt"] is not null,"Completion lost start or finish");
        Markdown("- [x] Beta\n- [x] Alpha\n- [ ] Repeat\n- [ ] Repeat"); Check(JsonNode.DeepEquals(complete,Rows()),"Unchanged report reset row times");
        Markdown("- [x] Beta\n- [ ] Alpha\n- [ ] Repeat\n- [ ] Repeat"); var reopened=Rows()[1]!;
        Check(reopened["completedAt"] is null && reopened["startedAt"]!.ToJsonString()==reopened["updatedAt"]!.ToJsonString() && reopened["firstSeenAt"]!.ToJsonString()==first[0]!["firstSeenAt"]!.ToJsonString(),"Reopen did not create new observed interval");
        var before=hub.GetRun(id)!.ToJsonString(); Throws(()=>Publish(hub,a,Batch(sequence+1,new{op="upsert",component=new{id="tasks",title="Tasks",kind="markdown",data=new{text="- [x] Wrong"}}},new{op="unsupported"})),400); Check(hub.GetRun(id)!.ToJsonString()==before,"Rejected batch leaked task times");
        var retained=(JsonObject)hub.GetRun(id)!["taskTimes"]!.DeepClone(); hub.Archive(id); hub.Dispose(); using var restored=new Hub(directory,Keys()); restored.Restore(id); Check(JsonNode.DeepEquals(restored.GetRun(id)!["taskTimes"],retained),"Archive/recovery lost row history");
        restored.Publish(id,S(a,"runToken"),Batch(++sequence,new{op="upsert",component=new{id="tasks",title="Replacement",kind="metric",data=new{value=1}}})); Check(restored.GetRun(id)!["taskTimes"]!["tasks"] is null,"Non-Markdown replacement retained row metadata");
        restored.Publish(id,S(a,"runToken"),Batch(++sequence,new{op="upsert",component=new{id="tasks",title="Tasks",kind="markdown",data=new{text="- [ ] New"}}},new{op="remove",componentId="tasks"})); Check(restored.GetRun(id)!["taskTimes"]!.AsObject().Count==0,"Remove retained row metadata");
        restored.Publish(id,S(a,"runToken"),Batch(++sequence,new{op="upsert",component=new{id="tasks",title="Tasks",kind="markdown",data=new{text="- [ ] New"}}},new{op="clear"})); Check(restored.GetRun(id)!["taskTimes"]!.AsObject().Count==0,"Clear retained row metadata");
    })),
    ("receipt timestamps are atomic, durable and independent from heartbeat or cleanup", () => Run((hub, directory) => {
        var a=Register(hub); var id=S(a,"runId"); Check(hub.GetRun(id)!["completedAt"] is null,"Registration fabricated completion");
        JsonObject? patch=null; hub.Patched+=p=>patch=p;
        Publish(hub,a,Batch(1,new{op="upsert",component=new{id="logs",title="Logs",kind="logs",data=new{entries=new object[]{new{message="received"},new{message="supplied",time="owner-time"}}}}},new{op="context",text="Started"}));
        var first=hub.GetRun(id)!; var updated=first["updatedAt"]!.GetValue<long>();
        Check(updated==first["lastSeen"]!.GetValue<long>() && first["componentTimes"]!["logs"]!.GetValue<long>()==updated,"Receipt metadata diverged");
        Check(DateTimeOffset.TryParse(S((JsonObject)first["components"]!["logs"]!["data"]!["entries"]![0]!,"time"),out _),"Missing log time not assigned receipt ISO");
        Check(first["components"]!["logs"]!["data"]!["entries"]![1]!["time"]!.GetValue<string>()=="owner-time","Supplied entry time replaced");
        hub.Heartbeat(id,S(a,"runToken")); Check(hub.GetRun(id)!["updatedAt"]!.GetValue<long>()==updated,"Heartbeat reset content update time");
        var before=hub.GetRun(id)!.ToJsonString(); Throws(()=>Publish(hub,a,Batch(2,new{op="upsert",component=Metric()},new{op="status",status="completed"},new{op="unsupported"})),409);
        Check(hub.GetRun(id)!.ToJsonString()==before,"Rejected batch leaked timestamps or completion");
        Publish(hub,a,Batch(2,new{op="append",componentId="logs",items=new[]{new{message="appended"}}}));
        var appended=hub.GetRun(id)!; Check(appended["componentTimes"]!["logs"]!.GetValue<long>()==appended["updatedAt"]!.GetValue<long>(),"Append did not refresh component receipt");
        Check(appended["components"]!["logs"]!["data"]!["entries"]![2]!["time"] is not null,"Append missing receipt time");
        Publish(hub,a,Batch(3,new{op="remove",componentId="logs"},new{op="upsert",component=Metric()})); Check(hub.GetRun(id)!["componentTimes"]!["logs"] is null,"Remove retained obsolete component receipt");
        Publish(hub,a,Batch(4,new{op="clear"},new{op="upsert",component=Metric()},new{op="status",status="completed"}));
        var completed=hub.GetRun(id)!; var finished=completed["completedAt"]!.GetValue<long>(); Check(completed["componentTimes"]!.AsObject().Count==1,"Clear retained component times");
        hub.Flush(); Check(patch!["changes"]!.AsArray().Any(n=>n!["meta"]?["completedAt"]?.GetValue<long>()==finished),"Live patch omitted timestamps");
        var summary=hub.Archive(id); Check(summary["completedAt"]!.GetValue<long>()==finished,"Archive summary omitted completion");
        hub.Dispose(); using var reopened=new Hub(directory,Keys()); Check(reopened.ReadArchive(id)["completedAt"]!.GetValue<long>()==finished,"Archive lost completion");
        reopened.Publish(id,S(a,"runToken"),Batch(5,new{op="clear"})); var recovered=reopened.GetRun(id)!;
        Check(recovered["completedAt"]!.GetValue<long>()==finished && recovered["componentTimes"]!.AsObject().Count==0,"Cleanup recovery rewrote completion or retained obsolete component times");
    })),
    ("interaction leases preserve layout, isolate views and release without changing manual reservations", () => Run((hub, _) => {
        var a=Register(hub); hub.Flush(); var id=S(a,"runId"); var original=hub.GetRun(id)!["layout"]!.DeepClone();
        var admitted=hub.SetInteraction(id,Json.Object(new{active=true,leaseId="view-a"}));
        Check(admitted["active"]!.GetValue<bool>() && admitted["expiresAt"]!.GetValue<long>()>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),"Lease admission did not return expiry");
        Check(JsonNode.DeepEquals(original,hub.GetRun(id)!["layout"]),"Interaction admission changed geometry or automatic flag");
        Check(hub.PackLayout(Json.Object(new{mode="all"}))["arranged"]!.GetValue<int>()==0,"Packing ignored active interaction lease");
        hub.SetInteraction(id,Json.Object(new{active=true,leaseId="view-a"}));
        hub.SetInteraction(id,Json.Object(new{active=true,leaseId="view-b"}));
        hub.SetInteraction(id,Json.Object(new{active=false,leaseId="view-a"}));
        hub.SetInteraction(id,Json.Object(new{active=false,leaseId="view-a"}));
        Check(hub.PackLayout(Json.Object(new{mode="all"}))["arranged"]!.GetValue<int>()==0,"Releasing one view removed another view lease");
        var released=hub.SetInteraction(id,Json.Object(new{active=false,leaseId="view-b"})); Check(released["expiresAt"] is null,"Release retained expiry");
        Check(hub.PackLayout(Json.Object(new{mode="all"}))["arranged"]!.GetValue<int>()==1,"Released interactions still blocked Arrange all");
        var manual=hub.MarkManual(id); hub.SetInteraction(id,Json.Object(new{active=true,leaseId="view-a"})); hub.SetInteraction(id,Json.Object(new{active=false,leaseId="view-a"}));
        Check(hub.PackLayout(Json.Object(new{mode="all"}))["arranged"]!.GetValue<int>()==0,"Interaction release removed header manual reservation");
        hub.SetInteraction(id,Json.Object(new{active=true,leaseId="view-b"})); hub.SetLayout(id,manual);
        Check(hub.PackLayout(Json.Object(new{mode="all"}))["arranged"]!.GetValue<int>()==0,"Header release removed independent interaction lease");
        hub.SetInteraction(id,Json.Object(new{active=false,leaseId="view-b"}));
        Check(hub.PackLayout(Json.Object(new{mode="all"}))["arranged"]!.GetValue<int>()==1,"Independent releases did not restore packing");
        Throws(()=>hub.SetInteraction(id,Json.Object(new{active=true,leaseId=""})),400);
        Throws(()=>hub.SetInteraction(id,Json.Object(new{active=true,leaseId=new string('a',129)})),400);
        Throws(()=>hub.SetInteraction(id,Json.Object(new{active=true,leaseId="invalid lease"})),400);
        Throws(()=>hub.SetInteraction(id,Json.Object(new{active="yes",leaseId="view"})),400);
        Throws(()=>hub.SetInteraction("missing",Json.Object(new{active=true,leaseId="view"})),404);
    })),
    ("default packing includes all cards, preserves older positions, sizes and locks", () => Run((hub, directory) => {
        var a=Register(hub); var b=hub.Register(Input("b")); var c=hub.Register(Input("c")); hub.Flush();
        var manual=(JsonObject)hub.GetRun(S(a,"runId"))!["layout"]!.DeepClone(); manual["x"]=-1500; manual["y"]=-1500; manual["automatic"]=false; hub.SetLayout(S(a,"runId"),manual);
        var locked=(JsonObject)hub.GetRun(S(b,"runId"))!["layout"]!.DeepClone(); locked["locked"]=true; hub.SetLayout(S(b,"runId"),locked); hub.Flush();
        var kept=(JsonObject)hub.GetRun(S(a,"runId"))!["layout"]!; Check(kept["x"]!.ToJsonString()==manual["x"]!.ToJsonString() && kept["y"]!.ToJsonString()==manual["y"]!.ToJsonString(),"Stable packing moved an older card without a gap event");
        Check(kept["automatic"]!.GetValue<bool>(),"Default packing excluded a legacy/manual card");
        Check(JsonNode.DeepEquals(hub.GetRun(S(b,"runId"))!["layout"],locked),"Automatic packing moved a locked card");
        var beforeReservation=(JsonObject)hub.GetRun(S(c,"runId"))!["layout"]!.DeepClone(); var reserved=hub.MarkManual(S(c,"runId"));
        Check(!reserved["automatic"]!.GetValue<bool>() && reserved["x"]!.ToJsonString()==beforeReservation["x"]!.ToJsonString() && reserved["y"]!.ToJsonString()==beforeReservation["y"]!.ToJsonString(),"Manual reservation changed geometry");
        hub.Flush(); Check(JsonNode.DeepEquals(hub.GetRun(S(c,"runId"))!["layout"],reserved),"Packing moved a reserved gesture");
        Check(hub.PackLayout(Json.Object(new{mode="all"}))["arranged"]!.GetValue<int>()==1,"Explicit packing interrupted an active gesture");
        hub.SetLayout(S(c,"runId"),reserved);
        var packed=hub.PackLayout(Json.Object(new{mode="all",aspectRatio=1.6})); Check(packed["arranged"]!.GetValue<int>()==2,"Arrange all did not include manual unlocked cards");
        Check(hub.GetRun(S(a,"runId"))!["layout"]!["automatic"]!.GetValue<bool>(),"Arrange all did not resume automatic management");
        Check(JsonNode.DeepEquals(hub.GetRun(S(b,"runId"))!["layout"],locked),"Arrange all moved locked card");
        Throws(()=>hub.PackLayout(Json.Object(new{mode="all",aspectRatio=double.MaxValue})),400);
        var collision=(JsonObject)locked.DeepClone(); collision["locked"]=false; collision["automatic"]=false; collision["resolveOverlap"]=true;
        var accepted=hub.SetLayout(S(a,"runId"),collision); Check(accepted["x"]!.ToJsonString()!=locked["x"]!.ToJsonString() || accepted["y"]!.ToJsonString()!=locked["y"]!.ToJsonString(),"Concurrent drag overlap was not resolved");
        hub.Dispose(); using var reopened=new Hub(directory,Keys()); Check(JsonNode.DeepEquals(reopened.GetRun(S(a,"runId"))!["layout"],accepted),"Accepted layout was not durable");
    })),
    ("removals close gaps and old manual sizes remain unchanged", () => Run((hub, _) => {
        var a=Register(hub); var b=hub.Register(Input("b")); hub.Flush();
        var edited=(JsonObject)hub.GetRun(S(b,"runId"))!["layout"]!.DeepClone(); edited["x"]=5000; edited["height"]=600; edited["automatic"]=false; hub.SetLayout(S(b,"runId"),edited); hub.Flush();
        Check(hub.GetRun(S(b,"runId"))!["layout"]!["x"]!.GetValue<double>()<5000,"Default resize packing excluded a manual card");
        hub.Archive(S(a,"runId")); hub.Flush(); var remaining=(JsonObject)hub.GetRun(S(b,"runId"))!["layout"]!;
        Check(remaining["x"]!.GetValue<double>()==0 && remaining["y"]!.GetValue<double>()==0 && remaining["height"]!.GetValue<double>()==600,"Removal did not close gap or changed manual dimensions");
    })),
    ("registration identity, recovery proof and credential boundaries", () => Run((hub, _) => {
        var a = Register(hub); var retry = Register(hub); Check(a.ToJsonString() == retry.ToJsonString(), "Retry changed credentials");
        Throws(() => hub.Register(Input("a", "wrong-private-registration-key-long-enough")), 409);
        var id = S(a,"runId"); var forged = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Keys().IngestToken), Encoding.UTF8.GetBytes("run:"+id))).TrimEnd('=').Replace('+','-').Replace('/','_');
        Throws(() => hub.Heartbeat(id, forged), 403);
        var child = Input("child"); child["parentId"] = id; child["parentToken"] = S(a,"runToken"); hub.Register(child);
        child.Remove("parentToken"); Throws(() => hub.Register(child), 409);
    })),
    ("atomic mutation failures, exact retries and old-sequence conflicts", () => Run((hub, _) => {
        var a = Register(hub); var first = Batch(1, new { op="upsert", component=Metric() }); Publish(hub,a,first);
        Check(Publish(hub,a,first)["duplicate"]!.GetValue<bool>(), "Exact retry was not idempotent");
        Throws(() => Publish(hub,a,Batch(2,new {op="clear"},new {op="append",componentId="missing",items=new[]{1}})),400);
        Check(hub.GetRun(S(a,"runId"))!["components"]!["metric"] is not null,"Partial mutation escaped");
        Publish(hub,a,Batch(2,new {op="context",text="Second"}));
        Check(Publish(hub,a,first)["duplicate"]!.GetValue<bool>(),"Older exact retry rejected");
        Throws(() => Publish(hub,a,Batch(1,new {op="clear"})),409);
        Throws(() => Publish(hub,a,Batch(4,new {op="clear"})),409);
    })),
    ("bounded append reports trimming", () => Run((hub, _) => {
        var a=Register(hub); Publish(hub,a,Batch(1,new {op="upsert",component=new {id="logs",title="Synthetic",kind="logs",data=new {entries=Enumerable.Range(0,2000).Select(i=>new {message="Synthetic "+i,level="info"}).ToArray()}}}));
        var result=Publish(hub,a,Batch(2,new {op="append",componentId="logs",items=new[]{new {message="Latest",level="info"}}}));
        Check(result["trimmed"]!.GetValue<int>()==1,"Trim count missing");
        Check(hub.GetRun(S(a,"runId"))!["components"]!["logs"]!["data"]!["entries"]!.AsArray().Count==2000,"Retention bound failed");
    })),
    ("persistence preserves content, sequence and compressed archives", () => Run((hub, directory) => {
        var a=Register(hub); Publish(hub,a,Batch(1,new {op="upsert",component=new {id="text",title="Evidence",kind="markdown",data=new {text=string.Concat(Enumerable.Repeat("synthetic evidence ",2000))}}}));
        var summary=hub.Archive(S(a,"runId")); Check(summary["bytes"]!.GetValue<int>()<summary["rawBytes"]!.GetValue<int>()/3,"Archive compression ineffective");
        using var gzip=new GZipStream(new MemoryStream(hub.ArchiveBytes(S(a,"runId"))),CompressionMode.Decompress); Check(JsonNode.Parse(gzip)!["components"]!["text"] is not null,"Export lost view");
        hub.Dispose(); using var reopened=new Hub(directory,Keys()); Check(reopened.Archives().Count==1,"Archive not durable");
        Check(reopened.ReadArchive(S(a,"runId"))["components"]!["text"] is not null,"Archived evidence missing");
        reopened.AuthorizeArchive(S(a,"runId"),S(a,"runToken")); reopened.Archive(S(a,"runId"));
    })),
    ("archived publishes validate before recovery and restore full patches", () => Run((hub, _) => {
        var a=Register(hub); var id=S(a,"runId"); var first=Batch(1,new {op="upsert",component=Metric()}); Publish(hub,a,first); hub.Flush(); hub.Archive(id);
        Throws(()=>hub.Publish(id,"wrong",Batch(2,new {op="context",text="Resume"})),403);
        Throws(()=>Publish(hub,a,Batch(3,new {op="clear"})),409);
        Throws(()=>Publish(hub,a,Batch(2,new {op="clear"},new {op="append",componentId="missing",items=new[]{1}})),400);
        Check(hub.GetRun(id) is null && hub.Archives().Count==1,"Invalid write recovered archive");
        Check(hub.Heartbeat(id,S(a,"runToken"))["archived"]!.GetValue<bool>() && hub.GetRun(id) is null,"Heartbeat recovered archive");
        var credentials=Register(hub); Check(S(credentials,"runToken")==S(a,"runToken") && credentials["sequence"]!.GetValue<long>()==1 && hub.GetRun(id) is null,"Registration did not preserve archived identity");
        JsonObject? patch=null; hub.Patched+=value=>patch=value;
        var result=Publish(hub,a,Batch(2,new {op="context",text="Resume"})); hub.Flush();
        Check(result["restored"]!.GetValue<bool>() && hub.Archives().Count==0,"Publish did not restore archive");
        var change=patch!["changes"]!.AsArray().Single()!;
        Check(change["clear"]!.GetValue<bool>() && change["components"]!.AsArray().Count==1 && patch["removed"]!.AsArray().Count==0,"Recovery patch omitted retained components or removed restored card");
        Check(hub.GetRun(id)!["components"]!["metric"] is not null,"Recovery lost component");
    })),
    ("archive retry digests survive restart and repeated recovery", () => Run((hub, directory) => {
        var a=Register(hub); var id=S(a,"runId"); var first=Batch(1,new {op="upsert",component=Metric()}); Publish(hub,a,first); hub.Archive(id); hub.Dispose();
        using var reopened=new Hub(directory,Keys());
        Throws(()=>Publish(reopened,a,Batch(1,new {op="clear"})),409); Check(reopened.GetRun(id) is null,"Conflicting retry restored archive");
        Check(Publish(reopened,a,first)["duplicate"]!.GetValue<bool>(),"Archived exact retry rejected");
        Check(reopened.GetRun(id)!["components"]!["metric"] is not null,"Retry recovery lost view");
        reopened.Archive(id); reopened.Restore(id); reopened.Restore(id);
        Check(reopened.Archives().Count==0 && reopened.Snapshot()["stats"]!["archived"]!.GetValue<long>()==0,"Repeated recovery corrupted archive counter");
        Publish(reopened,a,Batch(2,new {op="context",text="After restart"})); reopened.Dispose();
        using var final=new Hub(directory,Keys()); Check(final.GetRun(id)!["sequence"]!.GetValue<long>()==2 && final.GetRun(id)!["components"]!["metric"] is not null,"Recovered state not durable");
    })),
    ("legacy archives recover without fabricated retry evidence", () => Run((hub, directory) => {
        var a=Register(hub); var id=S(a,"runId"); var first=Batch(1,new {op="upsert",component=Metric()}); Publish(hub,a,first); hub.Archive(id); hub.Dispose();
        using(var db=new SqliteConnection("Data Source="+Path.Combine(directory,"agenticview.sqlite"))) { db.Open(); using var command=db.CreateCommand(); command.CommandText="DROP TABLE archive_batches"; command.ExecuteNonQuery(); }
        using var reopened=new Hub(directory,Keys()); Throws(()=>Publish(reopened,a,first),409); Check(reopened.GetRun(id) is null,"Legacy duplicate mutated archive");
        Publish(reopened,a,Batch(2,new {op="context",text="Legacy recovery"})); Check(reopened.GetRun(id)!["components"]!["metric"] is not null,"Legacy archive lost content");
    })),
    ("manual recovery avoids occupied positions and reconnects children", () => Run((hub, _) => {
        var a=Register(hub); var id=S(a,"runId"); var saved=(JsonObject)hub.GetRun(id)!["layout"]!.DeepClone();
        var child=Input("child"); child["parentId"]=id; child["parentToken"]=S(a,"runToken"); var c=hub.Register(child); hub.Archive(id);
        var other=hub.Register(Input("other")); hub.SetLayout(S(other,"runId"),saved); var restored=hub.Restore(id);
        Check(S(hub.GetRun(S(c,"runId"))!,"parentId")==id,"Recovery lost child ancestry");
        Throws(()=>hub.SetLayout(id,saved),409); Check(restored["components"] is JsonObject,"Manual recovery lost component collection");
    })),
    ("completed runs permit cleanup and cannot resurrect", () => Run((hub, _) => {
        var a=Register(hub); Publish(hub,a,Batch(1,new {op="upsert",component=Metric()},new {op="status",status="completed"}));
        Throws(()=>Publish(hub,a,Batch(2,new {op="status",status="active"})),409); Publish(hub,a,Batch(2,new {op="clear"}));
        hub.Heartbeat(S(a,"runId"),S(a,"runToken")); Check(S(hub.GetRun(S(a,"runId"))!,"status")=="completed","Heartbeat resurrected completed run");
        hub.Archive(S(a,"runId")); hub.Restore(S(a,"runId")); Throws(()=>Publish(hub,a,Batch(3,new {op="status",status="active"})),409);
        Check(hub.Settings["autoArchiveMinutes"] is null && !hub.Settings["archiveAfterCompletion"]!.GetValue<bool>(),"Unexpected automatic cleanup");
    })),
    ("orphan promotion remains collision-free and preserves ancestry", () => Run((hub, _) => {
        var parent=Register(hub); var one=Input("one"); one["parentId"]=S(parent,"runId"); one["parentToken"]=S(parent,"runToken"); var a=hub.Register(one);
        var two=(JsonObject)one.DeepClone(); two["requestId"]="two"; two["agentId"]="two"; var b=hub.Register(two); hub.Archive(S(parent,"runId"));
        var first=hub.GetRun(S(a,"runId"))!; var second=hub.GetRun(S(b,"runId"))!;
        Check(S(first,"parentId")==S(parent,"runId"),"Ancestry lost"); Throws(()=>hub.SetLayout(S(b,"runId"),(JsonObject)first["layout"]!.DeepClone()),409);
        var layout=(JsonObject)second["layout"]!.DeepClone(); layout["locked"]=true; hub.SetLayout(S(b,"runId"),layout); layout["x"]=999999; Throws(()=>hub.SetLayout(S(b,"runId"),layout),409);
    })),
    ("tree cycles, reserved properties and unknown kinds are rejected", () => Run((hub, _) => {
        var a=Register(hub); Throws(()=>Publish(hub,a,Batch(1,new {op="upsert",component=new {id="tree",title="Bad",kind="tree",data=new {nodes=new[]{new{id="a",label="A",parentId="b"},new{id="b",label="B",parentId="a"}}}}})),400);
        Throws(()=>ComponentValidator.Validate(Json.Object(new {id="__proto__",title="Bad",kind="metric",data=new {value=1}})),400);
        Throws(()=>ComponentValidator.Validate(Json.Object(new {id="bad",title="Bad",kind="unknown",data=new {}})),400);
    })),
    ("coalesced patches preserve final content across remove and clear", () => Run((hub, _) => {
        var a=Register(hub); JsonObject? patch=null; hub.Patched+=value=>patch=value;
        Publish(hub,a,Batch(1,new {op="upsert",component=Metric()})); Publish(hub,a,Batch(2,new {op="clear"},new {op="upsert",component=new {id="new",title="New",kind="metric",data=new {value=2}}})); hub.Flush();
        var change=patch!["changes"]!.AsArray().Single()!; Check(change["clear"]!.GetValue<bool>(),"Clear signal missing");
        Check(change["components"]!.AsArray().Count==1 && change["components"]![0]!["id"]!.GetValue<string>()=="new","Coalescing resurrected removed component");
    }))
};
var failed=0;
foreach(var (name, action) in cases) { try { action(); Console.WriteLine("PASS "+name); } catch(Exception error) { failed++; Console.Error.WriteLine("FAIL "+name+": "+error); } }
Console.WriteLine($"{cases.Length-failed}/{cases.Length} C# contracts passed"); return failed==0?0:1;

static Secrets Keys() => new("synthetic-viewer-not-a-real-secret-key", "synthetic-ingestion-not-a-real-secret", "synthetic-server-private-run-derivation-key");
static string S(JsonObject value,string key)=>value[key]!.GetValue<string>();
static void Check(bool value,string message) { if(!value) throw new Exception(message); }
static void Throws(Action action,int status) { try { action(); } catch(HubError error) when(error.Status==status) { return; } throw new Exception("Expected HubError "+status); }
static JsonObject Input(string id="a",string registrationKey="synthetic-private-recovery-key-for-tests")=>Json.Object(new {requestId=id,registrationKey,agentId=id,name="Synthetic "+id});
static JsonObject Register(Hub hub)=>hub.Register(Input());
static object Metric()=>new {id="metric",title="Rows",kind="metric",data=new {value=1}};
static JsonObject Batch(long sequence,params object[] operations)=>Json.Object(new {sequence,operations});
static JsonObject Publish(Hub hub,JsonObject run,JsonObject batch)=>hub.Publish(S(run,"runId"),S(run,"runToken"),batch);
static void Run(Action<Hub,string> action)
{
    var root=Path.GetFullPath(Path.GetTempPath()); var directory=Path.Combine(root,"agenticview-contract-"+Guid.NewGuid());
    try { using var hub=new Hub(directory,Keys()); action(hub,directory); }
    finally { SqliteConnection.ClearAllPools(); if(Path.GetDirectoryName(Path.GetFullPath(directory))!=root.TrimEnd(Path.DirectorySeparatorChar)) throw new Exception("Unsafe cleanup target"); if(Directory.Exists(directory)) Directory.Delete(directory,true); }
}
