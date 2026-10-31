using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

public sealed partial class ControlStore
{
    private const int DebugArchiveRawBytes=131072;
    private sealed record ArchivedDebug(string Id,string SessionId,string RunId,string RequestId,string Digest,string State,long Created,int RawBytes,string PayloadHash,byte[] Compressed);
    private void InitializeComponentDebugHistory()=>Execute("""
        CREATE TABLE IF NOT EXISTS debug_command_archives(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,raw_bytes INTEGER NOT NULL,payload_hash TEXT NOT NULL,payload BLOB NOT NULL,UNIQUE(session_id,request_id));
        CREATE INDEX IF NOT EXISTS debug_archive_session ON debug_command_archives(session_id);
        """);
    private ArchivedDebug? DebugArchive(string where,params object[] values)
    {
        // where is fixed source-only SQL supplied by the two lookup helpers below.
        using var command=Command("SELECT id,session_id,run_id,request_id,digest,state,created,raw_bytes,payload_hash,payload FROM debug_command_archives WHERE "+where,values);
        using var reader=command.ExecuteReader();if(!reader.Read())return null;
        var length=reader.GetBytes(9,0,null,0,0);if(length>DebugArchiveRawBytes+1024||length<1)throw DebugArchiveCorrupt();
        return new(reader.GetString(0),reader.GetString(1),reader.GetString(2),reader.GetString(3),reader.GetString(4),reader.GetString(5),reader.GetInt64(6),reader.GetInt32(7),reader.GetString(8),(byte[])reader.GetValue(9));
    }
    private static HubError DebugArchiveCorrupt()=>new(409,"Archived debug command is unavailable or corrupt; retry identity is retained. Inspect local archive integrity before continuing.");
    private static JsonObject DebugArchivePayload(ArchivedDebug archived)
    {
        if(archived.RawBytes<2||archived.RawBytes>DebugArchiveRawBytes)throw DebugArchiveCorrupt();
        try
        {
            using var input=new MemoryStream(archived.Compressed,false);using var gzip=new GZipStream(input,CompressionMode.Decompress);
            using var output=new MemoryStream();var buffer=new byte[8192];
            while(true){var read=gzip.Read(buffer,0,Math.Min(buffer.Length,DebugArchiveRawBytes+1-(int)output.Length));if(read==0)break;output.Write(buffer,0,read);if(output.Length>DebugArchiveRawBytes)throw DebugArchiveCorrupt();}
            var raw=output.ToArray();if(raw.Length!=archived.RawBytes||!Authentication.Equal(Convert.ToHexStringLower(SHA256.HashData(raw)),archived.PayloadHash))throw DebugArchiveCorrupt();
            var payload=JsonNode.Parse(raw,documentOptions:new JsonDocumentOptions{MaxDepth=48}) as JsonObject??throw DebugArchiveCorrupt();
            if(Text(payload,"id")!=archived.Id||Text(payload,"sessionId")!=archived.SessionId||Text(payload,"runId")!=archived.RunId||Text(payload,"state")!=archived.State||payload["createdAt"]?.GetValue<long>()!=archived.Created||archived.State is not ("succeeded" or "failed" or "cancelled" or "unknown"))throw DebugArchiveCorrupt();
            return payload;
        }
        catch(Exception error) when(error is InvalidDataException or IOException or JsonException or InvalidOperationException or FormatException){throw DebugArchiveCorrupt();}
    }
    private JsonObject? DebugFindCommand(string id,string? sessionId=null)
    {
        var live=sessionId is null?Scalar("SELECT payload FROM debug_commands WHERE id=$p0",id):Scalar("SELECT payload FROM debug_commands WHERE id=$p0 AND session_id=$p1",id,sessionId);
        if(live is string payload)return Parse(payload);
        var archived=sessionId is null?DebugArchive("id=$p0",id):DebugArchive("id=$p0 AND session_id=$p1",id,sessionId);
        return archived is null?null:DebugArchivePayload(archived);
    }
    private (string Digest,JsonObject Payload)? DebugFindRetry(string sessionId,string requestId)
    {
        using(var command=Command("SELECT digest,payload FROM debug_commands WHERE session_id=$p0 AND request_id=$p1",sessionId,requestId))
        using(var reader=command.ExecuteReader())if(reader.Read())return(reader.GetString(0),Parse(reader.GetString(1)));
        var archived=DebugArchive("session_id=$p0 AND request_id=$p1",sessionId,requestId);
        return archived is null?null:(archived.Digest,DebugArchivePayload(archived));
    }
    /// <summary>Operator-only local archival. Retry identities and full terminal
    /// payloads stay durable; no work is claimed, replayed or discarded.</summary>
    public JsonObject UiArchiveHistory(string operatorToken,int limit=64)
    {
        if(!Authentication.Equal(operatorToken,secrets.ViewerToken))throw new HubError(403,"Operator viewer credentials are required to archive debug history.");
        if(limit<1||limit>256)throw new HubError(400,"Archive limit must be an integer from1 to256 closed sessions.");
        lock(gate)return AtomicDispatch(()=>
        {
            var sessions=new List<(string Id,string RunId)>();
            using(var command=Command("""
                SELECT s.id,s.run_id FROM debug_sessions s WHERE json_extract(s.payload,'$.state')='closed'
                AND EXISTS(SELECT 1 FROM debug_commands c WHERE c.session_id=s.id AND c.state IN ('succeeded','failed','cancelled','unknown'))
                AND NOT EXISTS(SELECT 1 FROM debug_commands c WHERE c.session_id=s.id AND c.state NOT IN ('succeeded','failed','cancelled','unknown'))
                ORDER BY s.id LIMIT $p0
                """,limit))using(var reader=command.ExecuteReader())while(reader.Read())sessions.Add((reader.GetString(0),reader.GetString(1)));
            var count=0;long rawBytes=0,compressedBytes=0;
            foreach(var session in sessions)
            {
                // Keep only IDs in this bounded list; compress one payload at a time.
                var ids=new List<string>();using(var command=Command("SELECT id FROM debug_commands WHERE session_id=$p0 ORDER BY created,id",session.Id))using(var reader=command.ExecuteReader())while(reader.Read())ids.Add(reader.GetString(0));
                foreach(var id in ids)
                {
                    string request,digest,state,payload;long created;
                    using(var command=Command("SELECT request_id,digest,state,created,payload FROM debug_commands WHERE id=$p0 AND session_id=$p1",id,session.Id))using(var reader=command.ExecuteReader())
                    {if(!reader.Read())throw new HubError(409,"Debug history changed; no archive was committed.");request=reader.GetString(0);digest=reader.GetString(1);state=reader.GetString(2);created=reader.GetInt64(3);payload=reader.GetString(4);}
                    var raw=Encoding.UTF8.GetBytes(payload);if(raw.Length>DebugArchiveRawBytes)throw new HubError(413,"Debug history payload exceeds the bounded local archive size; no archive was committed.");
                    var job=Parse(payload);if(Text(job,"id")!=id||Text(job,"sessionId")!=session.Id||Text(job,"runId")!=session.RunId||Text(job,"state")!=state||job["createdAt"]?.GetValue<long>()!=created||state is not ("succeeded" or "failed" or "cancelled" or "unknown"))throw DebugArchiveCorrupt();
                    byte[] zipped;using(var output=new MemoryStream()){using(var gzip=new GZipStream(output,CompressionLevel.Fastest,true))gzip.Write(raw);zipped=output.ToArray();}
                    Execute("INSERT INTO debug_command_archives VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,$p7,$p8,$p9)",id,session.Id,session.RunId,request,digest,state,created,raw.Length,Convert.ToHexStringLower(SHA256.HashData(raw)),zipped);
                    Execute("DELETE FROM debug_commands WHERE id=$p0 AND session_id=$p1 AND state IN ('succeeded','failed','cancelled','unknown')",id,session.Id);
                    count++;rawBytes+=raw.Length;compressedBytes+=zipped.Length;
                }
            }
            return Json.Object(new{archivedSessions=sessions.Count,archivedCommands=count,activeCommands=Convert.ToInt64(Scalar("SELECT COUNT(*) FROM debug_commands")),archivedTotal=Convert.ToInt64(Scalar("SELECT COUNT(*) FROM debug_command_archives")),uncompressedBytes=rawBytes,compressedBytes,scope="Local gzip SQLite archive of terminal commands from closed debug sessions only. Active work unchanged; all retry identities/results retained; no execution or replay."});
        });
    }
}
