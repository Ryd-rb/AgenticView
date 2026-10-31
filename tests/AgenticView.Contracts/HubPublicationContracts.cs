using AgenticView.Server;
using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

static class HubPublicationContracts
{
 public static void Run()
 {
var directory=Path.Combine(Path.GetTempPath(),"agenticview-hub-publication-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
var secrets=new Secrets("synthetic-viewer-proof","synthetic-ingest-proof","synthetic-run-proof");var report=new JsonObject();
try{
using(var hub=new Hub(directory,secrets)){
 var registered=hub.Register(Json.Object(new{requestId="probe",registrationKey="synthetic-fast-publish-registration",agentId="probe",name="Synthetic probe"}));var id=registered["runId"]!.GetValue<string>();var token=registered["runToken"]!.GetValue<string>();long sequence=0;
 JsonObject Stats(string value)=>Json.Object(new{id="stats",kind="keyvalue",title="Stats "+value,data=new{items=new[]{new{key="count",value}}}});
 JsonObject Batch(params JsonObject[] components)=>new(){["sequence"]=++sequence,["operations"]=new JsonArray(components.Select(c=>{if(!c.ContainsKey("title"))c["title"]=c["id"]!.DeepClone();return (JsonNode)new JsonObject{["op"]="upsert",["component"]=c};}).ToArray())};
 hub.Publish(id,token,Batch(Stats("initial")));hub.Flush();
 JsonObject Measure(string operation){var allocations=new List<long>();var times=new List<double>();for(int i=0;i<12;i++){var input=operation=="publish"?Batch(Stats(i+" \u00e9\ud83d\ude00\"\n")):null;var before=GC.GetAllocatedBytesForCurrentThread();var start=Stopwatch.GetTimestamp();if(input is null)hub.Heartbeat(id,token);else hub.Publish(id,token,input);var elapsed=Stopwatch.GetElapsedTime(start).TotalMilliseconds;var allocated=GC.GetAllocatedBytesForCurrentThread()-before;hub.Flush();if(i>=2){allocations.Add(allocated);times.Add(elapsed);}}allocations.Sort();times.Sort();return Json.Object(new{samples=10,medianAllocatedBytes=allocations[5],medianMilliseconds=times[5]});}
 report["smallPublish"]=Measure("publish");report["smallHeartbeat"]=Measure("heartbeat");
 var heavy=Batch(Json.Object(new{id="grid",kind="table",data=new{columns=new[]{new{key="id",label="ID"},new{key="payload",label="Payload"}},rows=Enumerable.Range(0,1000).Select(i=>new{id=i,payload=new string('x',80)}).ToArray()}}),Json.Object(new{id="chart",kind="chart",data=new{series=new[]{new{id="series",name="Synthetic",points=Enumerable.Range(0,1500).Select(i=>new{x=i,y=(i%37)-18}).ToArray()}}}}));
 hub.Publish(id,token,heavy);hub.Flush();report["heavyPublish"]=Measure("publish");report["heavyHeartbeat"]=Measure("heartbeat");
 report["liveUtf8Bytes"]=Encoding.UTF8.GetByteCount(hub.GetRun(id)!.ToJsonString());report["checks"]=new JsonArray();
 void Check(bool condition,string message){if(!condition)throw new Exception(message);((JsonArray)report["checks"]!).Add(message);}
 void ExactBytes(){var field=typeof(Hub).GetField("totalBytes",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!;Check((long)field.GetValue(hub)! ==Encoding.UTF8.GetByteCount(hub.GetRun(id)!.ToJsonString()),"Exact UTF8 byte accounting");}
 // Enforce unrelated-source scaling on the candidate, with relative headroom for metadata.
 {Check(report["heavyPublish"]!["medianAllocatedBytes"]!.GetValue<long>()<=report["smallPublish"]!["medianAllocatedBytes"]!.GetValue<long>()+32768,"Publish allocation independent of unrelated retained data");Check(report["heavyHeartbeat"]!["medianAllocatedBytes"]!.GetValue<long>()<=report["smallHeartbeat"]!["medianAllocatedBytes"]!.GetValue<long>()+16384,"Heartbeat allocation independent of unrelated retained data");}
 JsonObject Owned(){var runs=(System.Collections.IDictionary)typeof(Hub).GetField("runs",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!.GetValue(hub)!;var run=runs[id]!;return (JsonObject)run.GetType().GetField("View")!.GetValue(run)!;}
 var unchanged=Owned()["components"]!["chart"];hub.Heartbeat(id,token);Check(ReferenceEquals(unchanged,Owned()["components"]!["chart"]),"Heartbeat preserves unchanged component ownership");
 JsonObject? lastPatch=null;hub.Patched+=value=>lastPatch=(JsonObject)value.DeepClone();hub.Flush();
 ExactBytes();var retry=Batch(Stats("unicode \ud83d\ude00 \u00e9 \n \""));hub.Publish(id,token,retry);var stable=hub.GetRun(id)!.ToJsonString();Check(hub.Publish(id,token,retry)["duplicate"]!.GetValue<bool>(),"Exact sequence retry accepted");Check(stable==hub.GetRun(id)!.ToJsonString(),"Retry preserves state");Check(ReferenceEquals(unchanged,Owned()["components"]!["chart"]),"Replacement preserves unrelated component ownership");hub.Flush();Check(lastPatch!["changes"]!.AsArray().Count==1&&lastPatch["changes"]![0]!["components"]!.AsArray().Count==1,"Replacement patch contains changed component only");ExactBytes();
 using(var db=new SqliteConnection("Data Source="+Path.Combine(directory,"agenticview.sqlite"))){db.Open();void Sql(string sql){using var c=db.CreateCommand();c.CommandText=sql;c.ExecuteNonQuery();}
 var failed=Batch(Stats("must rollback"));Sql("CREATE TRIGGER fail_component BEFORE UPDATE ON components BEGIN SELECT RAISE(ABORT,'synthetic component fault'); END");bool rejected=false;try{hub.Publish(id,token,failed);}catch(SqliteException){rejected=true;}Check(rejected,"Injected SQLite upsert failure exercised");Check(stable==hub.GetRun(id)!.ToJsonString(),"SQLite failure preserves canonical view");hub.Flush();Check(lastPatch!["changes"]!.AsArray().Count==0,"Failed replacement queues no patch");ExactBytes();Sql("DROP TRIGGER fail_component");hub.Publish(id,token,failed);ExactBytes();
 stable=hub.GetRun(id)!.ToJsonString();Sql("CREATE TRIGGER fail_heartbeat BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'synthetic heartbeat fault'); END");rejected=false;try{hub.Heartbeat(id,token);}catch(SqliteException){rejected=true;}Check(rejected,"Injected heartbeat fault exercised");Check(stable==hub.GetRun(id)!.ToJsonString(),"Failed heartbeat preserves canonical view");Sql("DROP TRIGGER fail_heartbeat");}
 var bad=Batch(new JsonObject{["id"]="stats",["kind"]="not-a-kind",["data"]=new JsonObject()});stable=hub.GetRun(id)!.ToJsonString();bool invalid=false;try{hub.Publish(id,token,bad);}catch(HubError){invalid=true;}Check(invalid&&stable==hub.GetRun(id)!.ToJsonString(),"Invalid replacement is atomic");sequence--;
 hub.Publish(id,token,Batch(Json.Object(new{id="stats",kind="logs",data=new{entries=new[]{new{message="receipt"}}}})));Check(hub.GetRun(id)!["components"]!["stats"]!["data"]!["entries"]![0]!["time"] is not null,"Replacement receipt timestamp retained");ExactBytes();
 hub.Publish(id,token,Batch(Json.Object(new{id="stats",kind="checklist",data=new{items=new[]{new{id="task",label="Task",status="pending"}}}})));Check(hub.GetRun(id)!["taskTimes"]!["stats"] is JsonArray,"Checklist timing generated");hub.Publish(id,token,Batch(Json.Object(new{id="stats",kind="checklist",data=new{items=new[]{new{id="task",label="Task",status="completed"}}}})));ExactBytes();
 var replacement=Batch(Stats("final"));hub.Publish(id,token,replacement);Check(hub.GetRun(id)!["taskTimes"]!["stats"] is null,"Non-task replacement clears prior timings");ExactBytes();
 using(var restarted=new Hub(directory,secrets)){Check(JsonNode.DeepEquals(hub.GetRun(id),restarted.GetRun(id)),"Restart agrees with committed state");Check(restarted.Publish(id,token,replacement)["duplicate"]!.GetValue<bool>(),"Restart exact retry retained");}
 var status=new JsonObject{["sequence"]=++sequence,["operations"]=new JsonArray(new JsonObject{["op"]="status",["status"]="completed"})};hub.Publish(id,token,status);var blocked=Batch(Stats("blocked"));invalid=false;try{hub.Publish(id,token,blocked);}catch(HubError){invalid=true;}Check(invalid,"Completed run still rejects replacement");
 // Actual near-limit component input, not reflected quota counters. Old small stats is replaced.
 var quotaRun=hub.Register(Json.Object(new{requestId="quota",registrationKey="synthetic-fast-publish-registration",agentId="quota",name="Quota"}));var qid=quotaRun["runId"]!.GetValue<string>();var qt=quotaRun["runToken"]!.GetValue<string>();
 JsonObject QuotaBatch(long n,params JsonObject[] items)=>new(){["sequence"]=n,["operations"]=new JsonArray(items.Select(c=>(JsonNode)new JsonObject{["op"]="upsert",["component"]=c}).ToArray())};
 JsonObject Large(string key,int size)=>new(){["id"]=key,["title"]="Large",["kind"]="json",["data"]=new JsonObject{["value"]=new string('x',size)}};
 hub.Publish(qid,qt,QuotaBatch(1,Large("bulk",2*1024*1024-12000),Stats("small")));var quotaBefore=hub.GetRun(qid)!.ToJsonString();invalid=false;try{hub.Publish(qid,qt,QuotaBatch(2,Large("stats",16000)));}catch(HubError){invalid=true;}Check(invalid&&quotaBefore==hub.GetRun(qid)!.ToJsonString(),"Exact run quota rejects atomic replacement");hub.Publish(qid,qt,QuotaBatch(2,Stats("accepted after quota refusal")));Check(hub.GetRun(qid)!["sequence"]!.GetValue<long>()==2,"Quota refusal preserves retry sequence");

}

}finally{SqliteConnection.ClearAllPools();Directory.Delete(directory,true);}

 }
}
