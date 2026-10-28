using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace AgenticView.Server;

/// <summary>Pull-only executor. Profiles and machine credentials stay on this machine.</summary>
public static class ConnectorWorker
{
    public static async Task Run(string path,bool once,CancellationToken cancellation)
    {
        var config=JsonNode.Parse(await File.ReadAllTextAsync(path,cancellation))!.AsObject();
        ComponentValidator.Budget(config); var id=ComponentValidator.Id(config,"id"); var url=new Uri(ComponentValidator.Text(config,"url",2048));
        if(url.Scheme is not ("http" or "https") || url.UserInfo.Length>0 || url.AbsolutePath!="/" || url.Query.Length>0 || url.Fragment.Length>0) throw new InvalidDataException("Connector URL must be an HTTP(S) origin.");
        var profiles=ComponentValidator.Object(config["handlers"]);
        var profileDirectory=Path.GetDirectoryName(Path.GetFullPath(path))!;
        foreach(var node in profiles) {
            var profile=ComponentValidator.Object(node.Value);
            foreach(var field in new[]{"path","database","workingDirectory"}) if(profile[field] is JsonValue value && value.TryGetValue<string>(out var text) && !Path.IsPathRooted(text)) profile[field]=Path.GetFullPath(Path.Combine(profileDirectory,text));
            if(Json.String(profile,"type")=="process" && profile["workingDirectory"] is null) profile["workingDirectory"]=profileDirectory;
        }
        using var client=new HttpClient { BaseAddress=url,Timeout=TimeSpan.FromSeconds(20) };
        var ingestionKey=Environment.GetEnvironmentVariable("AV_INGEST_KEY") ?? ComponentValidator.Text(config,"ingestionKey",256,true,32);
        var registration=await Post(client,"/api/connectors/register",ingestionKey,new JsonObject { ["id"]=id,["name"]=config["name"]?.DeepClone()??JsonValue.Create(id),["registrationKey"]=config["registrationKey"]?.DeepClone() },cancellation);
        var token=Json.String(registration.AsObject(),"token");
        Console.WriteLine("Connector registered; local handlers ready.");
        do {
            try {
                var jobs=(await Post(client,$"/api/connectors/{id}/poll",token,new JsonObject(),cancellation)).AsArray();
                foreach(var node in jobs) {
                    var job=node!.AsObject(); JsonObject completion;
                    using var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellation); deadline.CancelAfter(TimeSpan.FromSeconds(90));
                    try {
                        var handler=Json.String(job,"handler"); var profile=profiles[handler] as JsonObject ?? throw new InvalidOperationException("Handler is not configured on this connector.");
                        var result=await Execute(profile,job,deadline.Token);
                        completion=Json.Object(new {invocationId=Json.String(job,"id"),claimToken=Json.String(job,"claimToken"),state="succeeded",result});
                    } catch(Exception error) when(!cancellation.IsCancellationRequested) {
                        // Do not return process arguments, connection strings, stack traces or machine paths.
                        var message=error is ConnectorFailure ? error.Message : error is OperationCanceledException ? "Execution deadline expired; verify the target before retrying." : "Local handler failed. Inspect the private connector configuration and target.";
                        completion=Json.Object(new {invocationId=Json.String(job,"id"),claimToken=Json.String(job,"claimToken"),state="failed",error=message});
                    }
                    // Retry only acknowledgement. The command is never rerun after a lost HTTP response.
                    var acknowledged=false;
                    for(var attempt=0;attempt<3 && !acknowledged;attempt++) { try { await Post(client,$"/api/connectors/{id}/complete",token,completion,cancellation); acknowledged=true; } catch(HttpRequestException) when(attempt<2) { await Task.Delay(500,cancellation); } }
                }
            } catch(HttpRequestException) when(!once && !cancellation.IsCancellationRequested) { Console.Error.WriteLine("Hub unavailable; no new actions executed."); }
            if(!once) await Task.Delay(1000,cancellation);
        } while(!once && !cancellation.IsCancellationRequested);
    }
    private static async Task<JsonNode> Post(HttpClient client,string path,string token,JsonObject body,CancellationToken cancellation)
    {
        using var request=new HttpRequestMessage(HttpMethod.Post,path); request.Headers.Authorization=new("Bearer",token); request.Content=new StringContent(Json.Text(body),Encoding.UTF8,"application/json");
        using var response=await client.SendAsync(request,cancellation); response.EnsureSuccessStatusCode(); return JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellation))!;
    }
    public static Task<JsonObject> Execute(JsonObject profile,JsonObject job,CancellationToken cancellation) => Json.String(profile,"type") switch {
        "process" when (Json.String(profile,"kind").Length>0 ? Json.String(profile,"kind")==Json.String(job,"kind") : Json.String(job,"kind") is "command" or "custom")=>Process(profile,job,cancellation),
        "log-file" when Json.String(job,"kind")=="logs"=>ReadLog(profile,ComponentValidator.Object(job["input"]),cancellation),
        "sqlite-table" when Json.String(job,"kind")== (Json.String(profile,"operation") switch { "read"=>"query","edit"=>"edit","history"=>"history",_=>"" })=>Task.FromResult(Database(profile,job)),
        _=>throw new ConnectorFailure("Unsupported local handler type.")
    };
    private static string Value(JsonNode? value) => value is null ? "" : value.GetValueKind()==System.Text.Json.JsonValueKind.String ? value.GetValue<string>() : value.ToJsonString();
    private static async Task<JsonObject> Process(JsonObject profile,JsonObject job,CancellationToken cancellation)
    {
        var input=ComponentValidator.Object(job["input"]); var jsonInput=Json.String(profile,"input")=="json-stdin"; var jsonOutput=Json.String(profile,"output")=="json";
        var start=new ProcessStartInfo { FileName=ComponentValidator.Text(profile,"executable",2048),UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=jsonInput,CreateNoWindow=true };
        if(profile["workingDirectory"] is not null) start.WorkingDirectory=Json.String(profile,"workingDirectory");
        var arguments=ComponentValidator.Array(profile,"arguments",128).Select(n=>n!.GetValue<string>()).ToArray();
        var program=Path.GetFileNameWithoutExtension(start.FileName).ToLowerInvariant();
        var dynamic=arguments.Any(a=>a.StartsWith('{') && a.EndsWith('}'));
        if(dynamic) {
            bool Fixed(string value)=>!value.StartsWith('{') && value.Length>0;
            if(program is "cmd" or "command") throw new ConnectorFailure("Dynamic cmd input is executable shell source. Use a fixed script through a supported interpreter.");
            if(program is "pwsh" or "powershell") { var script=Array.FindIndex(arguments,a=>a.Equals("-File",StringComparison.OrdinalIgnoreCase)); if(script<0 || script+1>=arguments.Length || !Fixed(arguments[script+1]) || arguments.Take(script).Any(a=>!new[]{"-NoProfile","-NonInteractive","-NoLogo"}.Contains(a,StringComparer.OrdinalIgnoreCase))) throw new ConnectorFailure("PowerShell input requires a fixed -File script, never shell source."); }
            else if(program is "sh" or "bash" or "dash" or "zsh" or "ksh" or "python" or "python3" or "node" or "ruby" or "perl") {
                var script=Array.FindIndex(arguments,a=>!a.StartsWith('-'));
                if(script<0 || !Fixed(arguments[script]) || arguments.Take(script).Any(a=>a.StartsWith('-') && (a.Contains('c') || a.Contains('e')))) throw new ConnectorFailure("Interpreter input requires a fixed script file, never executable shell source.");
            }
        }
        var previous="";
        foreach(var source in arguments) {
            var argument=source;
            // Substitutions occupy a complete argument; never concatenate input into shell/program source.
            if(argument.StartsWith("{",StringComparison.Ordinal) && argument.EndsWith("}",StringComparison.Ordinal)) { if(new[]{"-c","/c","/k","-command","-encodedcommand","-e","--eval","-eval","-ec","-commandwithargs"}.Contains(previous,StringComparer.OrdinalIgnoreCase)) throw new ConnectorFailure("Input cannot be substituted as executable shell source. Use a fixed script file with data arguments."); var key=argument[1..^1]; if(!input.ContainsKey(key)) throw new ConnectorFailure("A configured process argument is missing."); argument=Value(input[key]); }
            start.ArgumentList.Add(argument);
            previous=argument;
        }
        using var process=System.Diagnostics.Process.Start(start) ?? throw new ConnectorFailure("Process could not start.");
        var outputLimit=jsonOutput?131072:32768;
        async Task<(string Text,long Characters)> Drain(StreamReader stream) { var buffer=new char[4096]; var output=new StringBuilder(); long count=0; int read; while((read=await stream.ReadAsync(buffer,cancellation))>0) { count+=read; if(output.Length<outputLimit) output.Append(buffer,0,Math.Min(read,outputLimit-output.Length)); } return(output.ToString(),count); }
        var stdout=Drain(process.StandardOutput); var stderr=Drain(process.StandardError);
        try { if(jsonInput) { await process.StandardInput.WriteAsync(Json.Text(input).AsMemory(),cancellation); process.StandardInput.Close(); } await process.WaitForExitAsync(cancellation); var a=await stdout; var b=await stderr; if(process.ExitCode!=0) throw new ConnectorFailure("Configured command returned a nonzero exit code. Inspect its private output or expose a separate diagnostic action."); if(jsonOutput) { if(a.Characters>outputLimit) throw new ConnectorFailure("Script JSON response exceeds its configured byte window."); var result=JsonNode.Parse(a.Text) as JsonObject ?? throw new ConnectorFailure("Script must return one JSON object."); ComponentValidator.Budget(result); if(Encoding.UTF8.GetByteCount(result.ToJsonString())>262144) throw new ConnectorFailure("Script JSON response exceeds its byte budget."); return result; } return Json.Object(new {exitCode=process.ExitCode,stdout=a.Text,stderr=b.Text,truncated=a.Characters>32768 || b.Characters>32768}); }
        finally { if(!process.HasExited) { process.Kill(entireProcessTree:true); await process.WaitForExitAsync(CancellationToken.None); } try { await Task.WhenAll(stdout,stderr); } catch(OperationCanceledException) { } }
    }
    public static async Task<JsonObject> ReadLog(JsonObject profile,JsonObject input,CancellationToken cancellation)
    {
        // UTF-8 file/UNC tail, bounded independently of source length. No whole-file read or regex execution.
        var path=ComponentValidator.Text(profile,"path",4096); var filter=ComponentValidator.Text(input,"filter",1000,false); var level=ComponentValidator.Text(input,"level",80,false);
        await using var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete,65536,FileOptions.Asynchronous|FileOptions.SequentialScan);
        var generation=File.GetCreationTimeUtc(file.SafeFileHandle).Ticks.ToString(CultureInfo.InvariantCulture); var length=file.Length; var cursor=ComponentValidator.Text(input,"cursor",300,false).Split(':');
        var maxBytes=profile.ContainsKey("maxReadBytes")?(int)ComponentValidator.Number(profile,"maxReadBytes",65536,16777216,true,true):1048576;
        var valid=cursor.Length==2 && cursor[0]==generation && long.TryParse(cursor[1],out var offsetValue) && offsetValue>=0 && offsetValue<=length;
        var offset=valid?long.Parse(cursor[1],CultureInfo.InvariantCulture):Math.Max(0,length-maxBytes); var reset=cursor.Length>1 && !valid;
        var skip=offset>0 && !valid; file.Seek(offset,SeekOrigin.Begin);
        var buffer=new byte[65536]; var line=new byte[2048]; var used=0; var overlong=false; var entries=new Queue<JsonObject>(501); var retainedBytes=0; long scanned=0,matched=0,lines=0,consumed=offset,lastBoundary=offset;
        void Emit() {
            if(skip) { skip=false; return; } lines++;
            var message=Encoding.UTF8.GetString(line,0,used).TrimEnd('\r'); if(overlong) message+=" … [line truncated]";
            var severity=message.Contains("fatal",StringComparison.OrdinalIgnoreCase)?"fatal":message.Contains("error",StringComparison.OrdinalIgnoreCase)?"error":message.Contains("warn",StringComparison.OrdinalIgnoreCase)?"warn":message.Contains("debug",StringComparison.OrdinalIgnoreCase)?"debug":message.Contains("trace",StringComparison.OrdinalIgnoreCase)?"trace":"info";
            if((filter.Length==0 || message.Contains(filter,StringComparison.OrdinalIgnoreCase)) && (level.Length==0 || severity==level)) { matched++; var entry=Json.Object(new{level=severity,message}); entries.Enqueue(entry); retainedBytes+=Encoding.UTF8.GetByteCount(Json.Text(entry)); while(entries.Count>500 || retainedBytes>196608) retainedBytes-=Encoding.UTF8.GetByteCount(Json.Text(entries.Dequeue())); }
        }
        while(scanned<maxBytes) {
            cancellation.ThrowIfCancellationRequested(); var read=await file.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length,maxBytes-scanned)),cancellation); if(read==0) break; scanned+=read;
            for(var i=0;i<read;i++) { consumed++; if(buffer[i]==10) { Emit(); used=0; overlong=false; lastBoundary=consumed; } else if(used<line.Length) line[used++]=buffer[i]; else overlong=true; }
        }
        // Preserve a short partial line for the next request. A pathological long line must still advance.
        if(overlong) { Emit(); lastBoundary=consumed; }
        var next=lastBoundary;
        return Json.Object(new {entries=entries.ToArray(),cursor=generation+":"+next,bytesRead=scanned,sourceBytes=length,linesRead=lines,dropped=Math.Max(0,matched-entries.Count),truncated=matched>500 || overlong,reset,behindBytes=Math.Max(0,length-next)});
    }
    private static string Identifier(JsonObject profile,string key) => Quote(ComponentValidator.Text(profile,key,100,true,1));
    private static string Quote(string name) => Regex.IsMatch(name,"^[a-zA-Z_][a-zA-Z0-9_]*$",RegexOptions.CultureInvariant|RegexOptions.NonBacktracking) ? "\""+name+"\"" : throw new ConnectorFailure("Local SQL identifier is invalid.");
    private static object DbValue(JsonNode? value) => value is null ? DBNull.Value : value.GetValueKind() switch { System.Text.Json.JsonValueKind.String=>value.GetValue<string>(), System.Text.Json.JsonValueKind.Number=>value.GetValue<double>(),System.Text.Json.JsonValueKind.True=>1L,System.Text.Json.JsonValueKind.False=>0L,_=>throw new ConnectorFailure("Database values must be scalar.") };
    private static JsonObject Row(SqliteDataReader reader) { var row=new JsonObject(); for(var i=0;i<reader.FieldCount;i++) { if(reader.IsDBNull(i)) { row[reader.GetName(i)]=null; continue; } if(reader.GetFieldType(i)==typeof(string)) { using var text=reader.GetTextReader(i); var buffer=new char[1025]; var count=text.ReadBlock(buffer,0,buffer.Length); row[reader.GetName(i)]=new string(buffer,0,Math.Min(count,1024))+(count>1024?" … [truncated]":""); } else { var value=reader.GetValue(i); row[reader.GetName(i)]=value is byte[]?JsonValue.Create("[binary]"):value is long integer && (integer>9007199254740991 || integer< -9007199254740991)?JsonValue.Create(integer.ToString(CultureInfo.InvariantCulture)):System.Text.Json.JsonSerializer.SerializeToNode(value); } } if(Encoding.UTF8.GetByteCount(row.ToJsonString())>131072) throw new ConnectorFailure("Row exceeds the snapshot byte budget. Expose fewer columns through a dedicated profile."); return row; }
    public static JsonObject Database(JsonObject profile,JsonObject job)
    {
        var input=ComponentValidator.Object(job["input"]); var operation=ComponentValidator.Text(profile,"operation",20); var table=Identifier(profile,"table"); var keyName=ComponentValidator.Text(profile,"keyColumn",100); var key=Quote(keyName); var versionName=ComponentValidator.Text(profile,"versionColumn",100); var version=Quote(versionName);
        var columns=ComponentValidator.Array(profile,"columns",64,1).Select(n=>n!.GetValue<string>()).ToArray(); foreach(var c in columns) Quote(c);
        if(!columns.Contains(keyName) || !columns.Contains(versionName)) throw new ConnectorFailure("Database profile must expose key and version columns.");
        using var db=new SqliteConnection(new SqliteConnectionStringBuilder {DataSource=ComponentValidator.Text(profile,"database",4096),Mode=SqliteOpenMode.ReadWrite}.ToString()); db.Open();
        using var command=db.CreateCommand(); command.CommandTimeout=10;
        var select=string.Join(',',columns.Select(Quote));
        if(operation=="read") {
            var limit=input.ContainsKey("limit")?(int)ComponentValidator.Number(input,"limit",1,200,true,true):50; var filter=ComponentValidator.Text(input,"filter",1000,false); var cursor=ComponentValidator.Text(input,"cursor",65536,false);
            var order=new List<(string Key,string Direction)>();
            if(input.ContainsKey("sort")) foreach(var node in ComponentValidator.Array(input,"sort",4)) { var sort=ComponentValidator.Object(node); var column=ComponentValidator.Id(sort,"key"); ComponentValidator.Choice(sort,"direction",["asc","desc"]); if(!columns.Contains(column) || order.Any(o=>o.Key==column)) throw new ConnectorFailure("Sort columns must be unique configured columns."); order.Add((column,Json.String(sort,"direction"))); }
            if(!order.Any(o=>o.Key==keyName)) order.Add((keyName,"asc"));
            JsonArray? after=null; if(cursor.Length>0) try { after=JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(cursor)))!.AsArray(); if(after.Count!=order.Count) throw new FormatException(); } catch { throw new ConnectorFailure("Invalid database cursor. Refresh the page."); }
            var seek=new List<string>();
            if(after is not null) for(var i=0;i<order.Count;i++) { var col=Quote(order[i].Key); var asc=order[i].Direction=="asc"; var compare=after[i] is null?(asc?$"{col} IS NOT NULL":"0"):asc?$"{col}>$seek{i}":$"({col}<$seek{i} OR {col} IS NULL)"; var prefix=string.Join(" AND ",Enumerable.Range(0,i).Select(j=>$"{Quote(order[j].Key)} IS $seek{j}")); seek.Add("("+(prefix.Length>0?prefix+" AND ":"")+compare+")"); command.Parameters.AddWithValue("$seek"+i,DbValue(after[i])); }
            command.CommandText=$"SELECT {select} FROM {table} WHERE ($filter='' OR {string.Join(" OR ",columns.Select(c=>$"instr(lower(CAST({Quote(c)} AS TEXT)),lower($filter))>0"))}) AND ({(seek.Count>0?string.Join(" OR ",seek):"1")}) ORDER BY {string.Join(',',order.Select(o=>Quote(o.Key)+" "+o.Direction))} LIMIT $limit";
            command.Parameters.AddWithValue("$filter",filter); command.Parameters.AddWithValue("$limit",limit+1);
            var rows=new JsonArray(); var bytes=0; var more=false; using(var reader=command.ExecuteReader()) while(reader.Read()) { var row=Row(reader); if(row[keyName] is JsonValue value && value.TryGetValue<string>(out var text) && text.EndsWith(" … [truncated]",StringComparison.Ordinal)) throw new ConnectorFailure("Row key exceeds the supported snapshot length."); var size=Encoding.UTF8.GetByteCount(Json.Text(row)); if(rows.Count>=limit || rows.Count>0 && bytes+size>196608) { more=true; break; } rows.Add(row); bytes+=size; }
            var last=rows.LastOrDefault(); var values=new JsonArray(order.Select(o=>last?[o.Key]?.DeepClone()).ToArray());
            if(more && values.Any(v=>v is JsonValue value && value.TryGetValue<string>(out var text) && text.EndsWith(" … [truncated]",StringComparison.Ordinal))) throw new ConnectorFailure("Sort value exceeds the supported snapshot length.");
            return Json.Object(new{rows,nextCursor=more?Convert.ToBase64String(Encoding.UTF8.GetBytes(values.ToJsonString())):null});
        }
        var historyTable=Identifier(profile,"historyTable");
        if(operation=="history") {
            command.CommandText="SELECT 1 FROM sqlite_master WHERE type='table' AND name=$p0"; command.Parameters.AddWithValue("$p0",Json.String(profile,"historyTable")); if(command.ExecuteScalar() is null) return Json.Object(new{rows=Array.Empty<object>()}); command.Parameters.Clear();
            var cursor=ComponentValidator.Text(input,"cursor",300,false); var offset=0; if(cursor.Length>0 && (!int.TryParse(cursor,out offset) || offset<0 || offset>1000000)) throw new ConnectorFailure("Invalid history cursor.");
            command.CommandText=$"SELECT invocation_id,at,before_json,after_json FROM {historyTable} WHERE row_id=$p0 ORDER BY at DESC,invocation_id DESC LIMIT 101 OFFSET $p1"; command.Parameters.AddWithValue("$p0",Value(input["rowId"])); command.Parameters.AddWithValue("$p1",offset); var rows=new JsonArray(); var bytes=0; var more=false;
            using(var reader=command.ExecuteReader()) while(reader.Read()) { var row=Json.Object(new{invocationId=reader.GetString(0),at=reader.GetInt64(1),before=JsonNode.Parse(reader.GetString(2)),after=JsonNode.Parse(reader.GetString(3))}); var size=Encoding.UTF8.GetByteCount(Json.Text(row)); if(rows.Count>=100 || rows.Count>0 && bytes+size>196608) { more=true; break; } rows.Add(row); bytes+=size; }
            return Json.Object(new{rows,nextCursor=more?(offset+rows.Count).ToString(CultureInfo.InvariantCulture):null});
        }
        if(operation!="edit") throw new ConnectorFailure("Unsupported database operation.");
        if(input.ContainsKey("operation") && Json.String(input,"operation")!="update") throw new ConnectorFailure("This optional SQLite profile supports updates only. Configure a generic script for other row actions.");
        var writable=ComponentValidator.Array(profile,"writableColumns",64,1).Select(n=>n!.GetValue<string>()).ToHashSet(); var changes=ComponentValidator.Object(input["changes"]);
        if(changes.Count==0 || changes.Any(p=>!writable.Contains(p.Key) || !columns.Contains(p.Key) || p.Key==keyName || p.Key==versionName)) throw new ConnectorFailure("A changed column is not writable.");
        foreach(var pair in changes) if(pair.Value is JsonValue scalar && scalar.TryGetValue<string>(out var value) && value.Length>1024) throw new ConnectorFailure("Edited values are limited to 1,024 characters. Use a dedicated handler for large values.");
        using var transaction=db.BeginTransaction(); command.Transaction=transaction;
        command.CommandText=$"CREATE TABLE IF NOT EXISTS {historyTable}(invocation_id TEXT PRIMARY KEY,row_id TEXT NOT NULL,at INTEGER NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL)"; command.ExecuteNonQuery();
        command.CommandText=$"SELECT after_json FROM {historyTable} WHERE invocation_id=$p0"; command.Parameters.AddWithValue("$p0",Json.String(job,"id")); var duplicate=command.ExecuteScalar() as string; command.Parameters.Clear();
        if(duplicate is not null) { transaction.Commit(); return Json.Object(new{row=JsonNode.Parse(duplicate),duplicate=true}); }
        command.CommandText=$"SELECT {select} FROM {table} WHERE {key}=$p0"; command.Parameters.AddWithValue("$p0",DbValue(input["rowId"])); JsonObject before; using(var reader=command.ExecuteReader()) { if(!reader.Read()) throw new ConnectorFailure("Row no longer exists."); before=Row(reader); } command.Parameters.Clear();
        if(before.Any(p=>p.Value is JsonValue value && value.TryGetValue<string>(out var text) && text.EndsWith(" … [truncated]",StringComparison.Ordinal))) throw new ConnectorFailure("Row exceeds the editable snapshot limit. Use a dedicated handler for large values.");
        if(input["expectedVersion"] is null || !JsonNode.DeepEquals(before[versionName],input["expectedVersion"])) throw new ConnectorFailure("Version conflict. Refresh the row before saving again.");
        var assignments=new List<string>(); var index=2;
        foreach(var pair in changes) { assignments.Add(Quote(pair.Key)+"=$p"+index); command.Parameters.AddWithValue("$p"+index++,DbValue(pair.Value)); }
        command.CommandText=$"UPDATE {table} SET {string.Join(',',assignments)},{version}={version}+1 WHERE {key}=$p0 AND {version}=$p1"; command.Parameters.AddWithValue("$p0",DbValue(input["rowId"])); command.Parameters.AddWithValue("$p1",DbValue(input["expectedVersion"])); if(command.ExecuteNonQuery()!=1) throw new ConnectorFailure("Version conflict. Refresh the row before saving again."); command.Parameters.Clear();
        command.CommandText=$"SELECT {select} FROM {table} WHERE {key}=$p0"; command.Parameters.AddWithValue("$p0",DbValue(input["rowId"])); JsonObject afterRow; using(var reader=command.ExecuteReader()) { reader.Read(); afterRow=Row(reader); } command.Parameters.Clear();
        command.CommandText=$"INSERT INTO {historyTable} VALUES($p0,$p1,$p2,$p3,$p4)"; command.Parameters.AddWithValue("$p0",Json.String(job,"id")); command.Parameters.AddWithValue("$p1",Value(input["rowId"])); command.Parameters.AddWithValue("$p2",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); command.Parameters.AddWithValue("$p3",Json.Text(before)); command.Parameters.AddWithValue("$p4",Json.Text(afterRow)); command.ExecuteNonQuery(); transaction.Commit();
        return Json.Object(new{row=afterRow});
    }
}
public sealed class ConnectorFailure(string message) : Exception(message);
