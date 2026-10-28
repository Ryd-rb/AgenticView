using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using AgenticView.Server;
using Microsoft.Data.Sqlite;

static class ControlContracts
{
    public static IEnumerable<(string Name,Action Test)> Cases() => [
        ("permanent applications ignore automatic lifecycle cleanup",()=>WithDirectory(directory=>{
            var config=Config(directory); using var hub=new Hub(directory,config.Secrets); using var controls=new ControlStore(config,hub); var a=Register(hub);
            controls.Configure(S(a,"runId"),S(a,"runToken"),Json.Object(new{application=new{name="Permanent"},actions=Array.Empty<object>()}));
            hub.SetSettings(Json.Object(new{staleSeconds=15,autoArchiveMinutes=1,archiveAfterCompletion=true}));
            var field=typeof(Hub).GetField("runs",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!; var runs=(System.Collections.IDictionary)field.GetValue(hub)!; var run=runs[S(a,"runId")]!; var view=(JsonObject)run.GetType().GetField("View")!.GetValue(run)!; view["lastSeen"]=0L;
            hub.Tick(); Check(hub.GetRun(S(a,"runId")) is not null,"Permanent application was automatically archived");
            hub.Publish(S(a,"runId"),S(a,"runToken"),Json.Object(new{sequence=1,operations=new[]{new{op="status",status="completed"}}})); Check(hub.GetRun(S(a,"runId")) is not null,"Application completion archived it");
        })),
        ("expired action leases become unknown without replay and accept late acknowledgements",()=>WithDirectory(directory=>{
            var config=Config(directory); using var hub=new Hub(directory,config.Secrets); using var controls=new ControlStore(config,hub); var a=Register(hub); var id=S(a,"runId"); var token=S(a,"runToken");
            var definition=controls.Configure(id,token,Json.Object(new{actions=new[]{new{id="prompt",label="Prompt",kind="prompt",target="agent"}}}));
            var invoked=controls.Invoke(id,Json.Object(new{requestId="one",actionId="prompt",definitionVersion=S(definition,"version"),input=new{}})); var job=controls.Poll(id,token,true)[0]!.AsObject(); job["startedAt"]=0L;
            using(var db=new SqliteConnection("Data Source="+Path.Combine(directory,"controls.sqlite"))) { db.Open(); using var command=db.CreateCommand(); command.CommandText="UPDATE invocations SET payload=$p0 WHERE id=$p1"; command.Parameters.AddWithValue("$p0",job.ToJsonString()); command.Parameters.AddWithValue("$p1",S(job,"id")); command.ExecuteNonQuery(); }
            Check(S(controls.Invocation(id,S(invoked,"id")),"state")=="unknown","Expired claim did not become unknown"); Check(controls.Poll(id,token,true).Count==0,"Unknown action replayed");
            var ack=controls.Complete(id,token,true,Json.Object(new{invocationId=S(job,"id"),claimToken=S(job,"claimToken"),state="succeeded",result=new{reply="Late acknowledgement"}})); Check(S(ack,"state")=="succeeded","Late acknowledgement rejected");
        })),
        ("SQLite edits compare versions and commit complete row history atomically",()=>WithDirectory(directory=>{
            var path=Path.Combine(directory,"synthetic.sqlite"); using(var db=new SqliteConnection("Data Source="+path)) { db.Open(); using var command=db.CreateCommand(); command.CommandText="CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT,version INTEGER NOT NULL); INSERT INTO items VALUES(1,'Before',1),(2,'Second',1)"; command.ExecuteNonQuery(); }
            var profile=Json.Object(new{type="sqlite-table",database=path,table="items",keyColumn="id",versionColumn="version",columns=new[]{"id","label","version"},writableColumns=new[]{"label"},historyTable="av_history",operation="read"});
            profile["operation"]="history"; Check(ConnectorWorker.Database(profile,Job("history",new{rowId=1}))["rows"]!.AsArray().Count==0,"History before first edit should be empty"); profile["operation"]="read";
            var page=ConnectorWorker.Database(profile,Job("query",new{limit=1})); Check(page["rows"]!.AsArray().Count==1 && page["nextCursor"] is not null,"Read page unbounded");
            var next=ConnectorWorker.Database(profile,Job("query",new{limit=1,cursor=S(page,"nextCursor")})); Check(next["rows"]![0]!["id"]!.GetValue<long>()==2,"Keyset cursor repeated a row");
            var sort=new[]{new{key="label",direction="desc"}}; var sorted=ConnectorWorker.Database(profile,Job("query",new{limit=1,sort})); var sortedNext=ConnectorWorker.Database(profile,Job("query",new{limit=1,sort,cursor=S(sorted,"nextCursor")})); Check(sorted["rows"]![0]!["id"]!.GetValue<long>()==2 && sortedNext["rows"]![0]!["id"]!.GetValue<long>()==1,"Sorted keyset continuation lost order");
            profile["operation"]="edit"; var job=Job("edit",new{rowId=1,expectedVersion=1,changes=new{label="After"}}); var result=ConnectorWorker.Database(profile,job); Check(result["row"]!["label"]!.GetValue<string>()=="After" && result["row"]!["version"]!.GetValue<long>()==2,"Edit was not persisted");
            Check(ConnectorWorker.Database(profile,job)["duplicate"]!.GetValue<bool>(),"Database invocation replay duplicated an edit");
            var conflict=Job("edit",new{rowId=1,expectedVersion=1,changes=new{label="Stale"}}); Throws(()=>ConnectorWorker.Database(profile,conflict),"Version conflict");
            var injected=Job("edit",new{rowId=1,expectedVersion=2,changes=new Dictionary<string,object>{{"label; DROP TABLE items", "bad"}}}); Throws(()=>ConnectorWorker.Database(profile,injected),"not writable");
            profile["operation"]="history"; var history=ConnectorWorker.Database(profile,Job("history",new{rowId=1})); Check(history["rows"]!.AsArray().Count==1,"History contains rejected/duplicate writes"); var before=history["rows"]![0]!["before"]!; Check(before["label"]!.GetValue<string>()=="Before","Before image lost");
        })),
        ("gigabyte source logs seek a bounded tail, preserve cursors and cap output",()=>WithDirectory(directory=>{
            var result=LogProbe(directory); Check(result["sourceBytes"]!.GetValue<long>()>=1L<<30,"Source was not a gigabyte");
            Console.WriteLine("Control log probe: "+result.ToJsonString());
        })),
        ("connector rejects mismatched reader kinds and dynamic shell source",()=>{
            var profile=Json.Object(new{type="process",executable="dotnet",arguments=new[]{"-c","{source}"}});
            Throws(()=>ConnectorWorker.Execute(profile,Job("query",new{source="bad"}),CancellationToken.None).GetAwaiter().GetResult(),"Unsupported");
            Throws(()=>ConnectorWorker.Execute(profile,Job("command",new{source="bad"}),CancellationToken.None).GetAwaiter().GetResult(),"shell source");
            foreach(var executable in new[]{"bash","pwsh"}) { var combined=Json.Object(new{type="process",executable,arguments=new[]{"-lc","{source}"}}); Throws(()=>ConnectorWorker.Execute(combined,Job("command",new{source="bad"}),CancellationToken.None).GetAwaiter().GetResult(),"shell source"); }
        }),
        ("completed invocation envelopes enforce the full byte budget before persistence",()=>WithDirectory(directory=>{
            var config=Config(directory); using var hub=new Hub(directory,config.Secrets); using var controls=new ControlStore(config,hub); var a=Register(hub); var id=S(a,"runId"); var token=S(a,"runToken");
            var definition=controls.Configure(id,token,Json.Object(new{actions=new[]{new{id="payload",label="Payload",kind="custom",target="agent",fields=new[]{new{key="value",label="Value",type="json"}}}}}));
            var invoked=controls.Invoke(id,Json.Object(new{requestId="budget",actionId="payload",definitionVersion=S(definition,"version"),input=new{value=new string('a',100000)}})); var job=controls.Poll(id,token,true)[0]!.AsObject();
            try { controls.Complete(id,token,true,Json.Object(new{invocationId=S(job,"id"),claimToken=S(job,"claimToken"),state="succeeded",result=new{value=new string('b',450000)}})); throw new Exception("Merged result exceeded budget without rejection"); } catch(HubError error) when(error.Status==413) { }
            Check(S(controls.Invocation(id,S(invoked,"id")),"state")=="running","Oversized completion partially committed");
            controls.Complete(id,token,true,Json.Object(new{invocationId=S(job,"id"),claimToken=S(job,"claimToken"),state="succeeded",result=new{value="Bounded"}}));
        })),
        ("long text primary keys retain a usable database cursor",()=>WithDirectory(directory=>{
            var path=Path.Combine(directory,"keys.sqlite"); using(var db=new SqliteConnection("Data Source="+path)) { db.Open(); using var command=db.CreateCommand(); command.CommandText="CREATE TABLE items(id TEXT PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO items VALUES($a,1),($b,1)"; command.Parameters.AddWithValue("$a",new string('a',600)); command.Parameters.AddWithValue("$b",new string('b',600)); command.ExecuteNonQuery(); }
            var profile=Json.Object(new{type="sqlite-table",operation="read",database=path,table="items",keyColumn="id",versionColumn="version",columns=new[]{"id","version"}});
            var first=ConnectorWorker.Database(profile,Job("query",new{limit=1})); var second=ConnectorWorker.Database(profile,Job("query",new{limit=1,cursor=S(first,"nextCursor")})); Check(second["rows"]![0]!["id"]!.GetValue<string>()==new string('b',600),"Long key broke continuation");
        }))
    ];
    public static JsonObject LogProbe(string directory)
    {
        var path=Path.Combine(directory,"synthetic-large.log");
        using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.ReadWrite)) { file.SetLength(1L<<30); file.Position=file.Length; var text=Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0,4000).Select(i=>$"INFO synthetic row {i}\n"))+"ERROR evidence found\npartial"); file.Write(text); }
        var profile=Json.Object(new{type="log-file",path}); var watch=Stopwatch.StartNew(); var result=ConnectorWorker.ReadLog(profile,new JsonObject(),CancellationToken.None).GetAwaiter().GetResult(); watch.Stop();
        Check(result["bytesRead"]!.GetValue<long>()<=1048576,"Read grew with source size"); Check(result["entries"]!.AsArray().Count<=500,"Tail retained too many rows"); Check(Encoding.UTF8.GetByteCount(result.ToJsonString())<262144,"Tail response budget exceeded");
        var cursor=S(result,"cursor"); File.AppendAllText(path," line completes\nWARN appended\n"); var appended=ConnectorWorker.ReadLog(profile,Json.Object(new{cursor}),CancellationToken.None).GetAwaiter().GetResult(); Check(appended["entries"]!.AsArray().Count==2 && appended["entries"]![0]!["message"]!.GetValue<string>()=="partial line completes","Partial line cursor lost data");
        var filtered=ConnectorWorker.ReadLog(profile,Json.Object(new{filter="evidence",level="error"}),CancellationToken.None).GetAwaiter().GetResult(); Check(filtered["entries"]!.AsArray().Count==1,"Log source filter failed");
        return Json.Object(new{sourceBytes=result["sourceBytes"]!.DeepClone(),bytesRead=result["bytesRead"]!.DeepClone(),rows=result["entries"]!.AsArray().Count,elapsedMs=watch.Elapsed.TotalMilliseconds,scope="Local logical 1 GiB file, bounded tail seek; not network-share throughput or browser frame rate."});
    }
    private static RuntimeConfig Config(string dir)=>new(dir,"127.0.0.1",4317,new Uri("http://127.0.0.1:4317"),new Secrets("synthetic-viewer-token-for-controls-contracts","synthetic-ingest-token-for-controls-contracts","synthetic-server-private-secret-for-controls-contracts"),dir);
    private static JsonObject Register(Hub hub)=>hub.Register(Json.Object(new{requestId="app",registrationKey="synthetic-private-registration-proof",agentId="app",name="Synthetic app"}));
    private static JsonObject Job(string kind,object input)=>Json.Object(new{id=Guid.NewGuid().ToString(),kind,input});
    private static string S(JsonObject value,string key)=>Json.String(value,key);
    private static void Check(bool condition,string message) { if(!condition) throw new Exception(message); }
    private static void Throws(Action action,string expected) { try { action(); } catch(ConnectorFailure error) when(error.Message.Contains(expected,StringComparison.Ordinal)) { return; } throw new Exception("Expected local connector failure: "+expected); }
    private static void WithDirectory(Action<string> action) { var root=Path.GetFullPath(Path.GetTempPath()); var directory=Path.Combine(root,"agenticview-controls-"+Guid.NewGuid()); Directory.CreateDirectory(directory); try { action(directory); } finally { SqliteConnection.ClearAllPools(); if(Path.GetDirectoryName(Path.GetFullPath(directory))!=root.TrimEnd(Path.DirectorySeparatorChar) || (File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0) throw new Exception("Unsafe cleanup target"); Directory.Delete(directory,true); } }
}
