using AgenticView.Server;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

static class DebugHistoryContracts
{
 public static void Run(){
  var directory=Path.Combine(Path.GetTempPath(),"agenticview-debug-history-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
  var secrets=new Secrets("synthetic-operator-proof","synthetic-ingest-proof","synthetic-run-proof");var config=new RuntimeConfig(directory,"127.0.0.1",0,new Uri("http://127.0.0.1"),secrets,directory);var hub=new Hub(directory,secrets);var controls=new ControlStore(config,hub);var checks=new JsonArray();
  void Check(bool condition,string name){if(!condition)throw new Exception(name);checks.Add(name);}
  void Reject(Action action,int status){try{action();}catch(HubError error){if(error.Status==status){checks.Add("Rejected "+status);return;}throw;}throw new Exception("Expected refusal "+status);}
  string S(JsonObject value,string key)=>value[key]!.GetValue<string>();
  var run=hub.Register(Json.Object(new{requestId="a",registrationKey="synthetic-registration-proof-at-least32",agentId="a",name="A"}));var other=hub.Register(Json.Object(new{requestId="b",registrationKey="synthetic-registration-proof-at-least32",agentId="b",name="B"}));string id=S(run,"runId"),token=S(run,"runToken"),otherId=S(other,"runId"),otherToken=S(other,"runToken");var client=Guid.NewGuid().ToString();const string proof="synthetic-client-proof-at-least32characters";
  JsonObject Poll()=>controls.ComponentDebugPoll(Json.Object(new{clientId=client,clientToken=proof,cardIds=new[]{id,otherId},visible=true,platform="browser"}));
  JsonObject Command(string session,string request,string operation="metrics")=>controls.ComponentDebugCommand(id,token,session,request,Json.Object(new{operation}));
  using var inspection=new SqliteConnection("Data Source="+Path.Combine(directory,"controls.sqlite"));inspection.Open();
  object? Sql(string text){using var c=inspection.CreateCommand();c.CommandText=text;return c.ExecuteScalar();}
  try{
   Poll();var first=controls.ComponentDebugOpen(id,token,client,"lease-0");var session=S(first,"id");var success=Command(session,"success");var claimed=Poll()["jobs"]![0]!.AsObject();
   var completion=Json.Object(new{clientId=client,clientToken=proof,commandId=S(claimed,"id"),claimToken=S(claimed,"claimToken"),state="succeeded",result=new{bounded="synthetic"}});controls.ComponentDebugComplete(completion);
   var failed=Command(session,"failed");var failedClaim=Poll()["jobs"]![0]!.AsObject();controls.ComponentDebugComplete(Json.Object(new{clientId=client,clientToken=proof,commandId=S(failedClaim,"id"),claimToken=S(failedClaim,"claimToken"),state="failed",error="synthetic failure"}));
   // 256 terminal entries in first session, preserving unknown and cancelled outcomes.
   for(int i=0;i<252;i++)Command(session,"cancel-"+i);
   var unknown=Command(session,"unknown");var queued=Command(session,"queued");var claim=Poll()["jobs"]![0]!.AsObject(); // oldest queued becomes unknown on close
   controls.ComponentDebugClose(id,token,session);
   for(int group=1;group<8;group++){var lease=controls.ComponentDebugOpen(id,token,client,"lease-"+group);var leaseId=S(lease,"id");for(int i=0;i<(group==7?255:256);i++)Command(leaseId,"queued-"+i);controls.ComponentDebugClose(id,token,leaseId);}
   var held=controls.ComponentDebugOpen(otherId,otherToken,client,"held");var heldId=S(held,"id");controls.ComponentDebugCommand(otherId,otherToken,heldId,"running",Json.Object(new{operation="metrics"}));var running=Poll()["jobs"]![0]!.AsObject();
   Check(Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_commands"))==2048,"Actual API reaches global live2048 cap");
   Reject(()=>controls.ComponentDebugCommand(otherId,otherToken,heldId,"cap",Json.Object(new{operation="metrics"})),409);
   Reject(()=>controls.UiArchiveHistory("wrong-proof"),403);Check(Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_commands"))==2048,"Unauthorized archive did not move history");Reject(()=>controls.UiArchiveHistory(secrets.ViewerToken,0),400);Reject(()=>controls.UiArchiveHistory(secrets.ViewerToken,257),400);
   Reject(()=>controls.ComponentDebugCommand(otherId,otherToken,session,"success",Json.Object(new{operation="metrics"})),403);
   Sql("CREATE TRIGGER fail_archive BEFORE DELETE ON debug_commands BEGIN SELECT RAISE(ABORT,'synthetic archive failure'); END");bool atomicFailure=false;try{controls.UiArchiveHistory(secrets.ViewerToken);}catch(SqliteException){atomicFailure=true;}Check(atomicFailure&&Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_command_archives"))==0&&Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_commands"))==2048,"Archive transaction rolls back inserted archives and original deletions on failure");Sql("DROP TRIGGER fail_archive");
   var result=controls.UiArchiveHistory(secrets.ViewerToken);Check(result["archivedCommands"]!.GetValue<int>()==2047&&result["activeCommands"]!.GetValue<long>()==1,"Archive frees closed terminal history and preserves open running work");
   Check(Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_commands WHERE state='running'"))==1,"Running claim untouched");Check(controls.UiArchiveHistory(secrets.ViewerToken)["archivedCommands"]!.GetValue<int>()==0,"Repeated archive is idempotent");
   Check(S(Command(session,"success"),"id")==S(success,"id"),"Archived exact request retry returns same terminal command");Reject(()=>Command(session,"success","layers"),409);Reject(()=>controls.ComponentDebugCommand(otherId,otherToken,session,"success",Json.Object(new{operation="metrics"})),403);
   var read=controls.ComponentDebugResult(id,token,session,S(success,"id"));Check(S(read,"state")=="succeeded"&&read["result"]!["bounded"]!.GetValue<string>()=="synthetic","Archived result preserved");Check(!read.ContainsKey("claimToken")&&!read.ContainsKey("completionDigest"),"Archived public result strips private claims");Reject(()=>controls.ComponentDebugResult(otherId,otherToken,session,S(success,"id")),403);
   Check(controls.ComponentDebugComplete(completion)["acknowledged"]!.GetValue<bool>(),"Archived known late completion retry acknowledges");var conflict=(JsonObject)completion.DeepClone();conflict["result"]=new JsonObject{["changed"]=true};Reject(()=>controls.ComponentDebugComplete(conflict),409);
   Check(Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_command_archives WHERE state='unknown'"))==1,"Unknown outcome archived without replay");var lateUnknown=Json.Object(new{clientId=client,clientToken=proof,commandId=S(claim,"id"),claimToken=S(claim,"claimToken"),state="succeeded",result=new{}});Reject(()=>controls.ComponentDebugComplete(lateUnknown),409);
   var after=controls.ComponentDebugCommand(otherId,otherToken,heldId,"cap",Json.Object(new{operation="metrics"}));Check(S(after,"state")=="queued","Freed capacity accepts new command identity");Check(Poll()["jobs"]!.AsArray().Count==0,"Outstanding running operation never replayed");
   controls.ComponentDebugComplete(Json.Object(new{clientId=client,clientToken=proof,commandId=S(running,"id"),claimToken=S(running,"claimToken"),state="succeeded",result=new{}}));var pendingClaim=Poll()["jobs"]![0]!.AsObject();controls.ComponentDebugComplete(Json.Object(new{clientId=client,clientToken=proof,commandId=S(pendingClaim,"id"),claimToken=S(pendingClaim,"claimToken"),state="succeeded",result=new{}}));Check(controls.UiArchiveHistory(secrets.ViewerToken)["archivedCommands"]!.GetValue<int>()==0&&Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_commands"))==2,"Open-session terminal history remains live and untouched");
   controls.Dispose();hub.Dispose();
   using var restartedHub=new Hub(directory,secrets);using var restarted=new ControlStore(config,restartedHub);Check(S(restarted.ComponentDebugCommand(id,token,session,"success",Json.Object(new{operation="metrics"})),"id")==S(success,"id"),"Archived exact retry survives restart");Check(S(restarted.ComponentDebugResult(id,token,session,S(success,"id")),"state")=="succeeded","Archived result survives restart");Check(restarted.ComponentDebugComplete(completion)["acknowledged"]!.GetValue<bool>(),"Archived completion ACK survives restart");
   // A valid gzip stream with a mismatched raw bound/hash must fail closed too.
   var originalRaw=Convert.ToInt64(Sql("SELECT raw_bytes FROM debug_command_archives WHERE id='"+S(success,"id")+"'"));Sql("UPDATE debug_command_archives SET raw_bytes=131073 WHERE id='"+S(success,"id")+"'");Reject(()=>restarted.ComponentDebugResult(id,token,session,S(success,"id")),409);Sql("UPDATE debug_command_archives SET raw_bytes="+originalRaw+" WHERE id='"+S(success,"id")+"'");
   byte[] saved;using(var c=inspection.CreateCommand()){c.CommandText="SELECT payload FROM debug_command_archives WHERE id=$id";c.Parameters.AddWithValue("$id",S(success,"id"));saved=(byte[])c.ExecuteScalar()!;}
   using(var c=inspection.CreateCommand()){c.CommandText="UPDATE debug_command_archives SET payload=$payload WHERE id=$id";c.Parameters.AddWithValue("$payload",new byte[]{1,2,3});c.Parameters.AddWithValue("$id",S(success,"id"));c.ExecuteNonQuery();}
   Reject(()=>restarted.ComponentDebugResult(id,token,session,S(success,"id")),409);Reject(()=>restarted.ComponentDebugCommand(id,token,session,"success",Json.Object(new{operation="metrics"})),409);Check(Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_command_archives"))==2047,"Corruption preserves retry identities and records");
   using(var c=inspection.CreateCommand()){c.CommandText="UPDATE debug_command_archives SET payload=$payload WHERE id=$id";c.Parameters.AddWithValue("$payload",saved);c.Parameters.AddWithValue("$id",S(success,"id"));c.ExecuteNonQuery();}
   Check(S(restarted.ComponentDebugResult(id,token,session,S(success,"id")),"state")=="succeeded","Restored archive remains readable");
   using(var bytes=new MemoryStream()){using(var gzip=new System.IO.Compression.GZipStream(bytes,System.IO.Compression.CompressionLevel.Fastest,true))gzip.Write(new byte[131073]);using var c=inspection.CreateCommand();c.CommandText="UPDATE debug_command_archives SET raw_bytes=131072,payload=$payload WHERE id=$id";c.Parameters.AddWithValue("$payload",bytes.ToArray());c.Parameters.AddWithValue("$id",S(success,"id"));c.ExecuteNonQuery();}Reject(()=>restarted.ComponentDebugResult(id,token,session,S(success,"id")),409);Check(Convert.ToInt64(Sql("SELECT COUNT(*) FROM debug_command_archives"))==2047,"Inflation bound rejection retains archive identity");
  }finally{inspection.Dispose();controls.Dispose();hub.Dispose();SqliteConnection.ClearAllPools();Directory.Delete(directory,true);}
 }
}
