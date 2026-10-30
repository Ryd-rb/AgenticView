using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace AgenticView.Server;

public sealed class Hub : IDisposable
{
    private const int MaxRunBytes = 2 * 1024 * 1024;
    private const long MaxLiveBytes = 128L * 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly object gate = new();
    private readonly SqliteConnection db;
    private readonly Secrets secrets;
    private readonly Dictionary<string, SqliteCommand> commands = new();
    private readonly string?[] componentUpsertSql = new string?[65];
    private readonly Dictionary<string, Run> runs = new();
    private readonly Dictionary<string, Pending> pending = new();
    private readonly HashSet<string> removed = [];
    private readonly HashSet<string> freshLayouts = [];
    private readonly Dictionary<string, long> manualReservations = new();
    private readonly Dictionary<(string RunId, string LeaseId), long> interactionReservations = new();
    private JsonObject settings;
    private long revision, updates, totalBytes, archiveCount;
    private double rate;
    private bool settingsDirty, disposed, packingDirty;
    private double packingAspectRatio = 1.6;
    private SqliteTransaction? transaction;
    private long registrationLayoutTicks;
    private int nextSlot;
    private readonly MonitoringState monitoring = new();
    public JsonObject Monitoring() { lock (gate) return monitoring.Snapshot(runs.Values.Select(r => r.View), totalBytes, archiveCount); }
    public bool OpenViewer() => monitoring.OpenViewer();
    public void CloseViewer() => monitoring.CloseViewer();
    public double RegistrationLayoutMilliseconds { get { lock (gate) return registrationLayoutTicks * 1000.0 / Stopwatch.Frequency; } }
    private sealed class Run(JsonObject view, string tokenHash, long bytes)
    { public JsonObject View = view; public string TokenHash = tokenHash; public long Bytes = bytes; }
    private sealed class Pending(JsonObject meta)
    { public JsonObject Meta = meta; public Dictionary<string, JsonObject> Components = new(); public HashSet<string> Removed = []; public bool Clear; }
    public event Action<JsonObject>? Patched;
    public long Revision { get { lock (gate) return revision; } }
    public JsonObject Settings { get { lock (gate) return Clone(settings); } }

    public Hub(string directory, Secrets secrets)
    {
        this.secrets = secrets; Directory.CreateDirectory(directory);
        db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(directory, "agenticview.sqlite"), Mode = SqliteOpenMode.ReadWriteCreate }.ToString()); db.Open();
        using (var command = db.CreateCommand())
        {
            command.CommandText = """
                PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,request_id TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,token_hash TEXT NOT NULL,last_digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS components(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,id));
                CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,request_hash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batches(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
                CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,summary TEXT NOT NULL,payload BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS archive_batches(run_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
                CREATE INDEX IF NOT EXISTS requests_run_id ON requests(run_id);
                CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS session_bindings(identity TEXT PRIMARY KEY,run_id TEXT NOT NULL,proof_hash TEXT NOT NULL,parent_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS layout_policy(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,aspect REAL NOT NULL);
                """;
            command.ExecuteNonQuery();
        }
        settings = NormalizeSettings(Parse(Scalar("SELECT payload FROM settings WHERE id=1") as string ?? "{}"));
        var stored = new List<(string Id, string Payload, string Token)>();
        using (var reader = Command("SELECT id,payload,token_hash FROM runs").ExecuteReader()) while (reader.Read()) stored.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        foreach (var row in stored)
        {
            var view = Parse(row.Payload); var components = new JsonObject();
            using (var reader = Command("SELECT id,payload FROM components WHERE run_id=$p0", row.Id).ExecuteReader()) while (reader.Read()) { var component = Parse(reader.GetString(1)); ComponentValidator.Validate(component); components[reader.GetString(0)] = component; }
            view["components"] = components; var bytes = Size(view); runs[row.Id] = new Run(view, row.Token, bytes); totalBytes += bytes;
        }
        archiveCount = Convert.ToInt64(Scalar("SELECT COUNT(*) FROM archives"));
        // Migrate old layouts once, then retain the operator's chosen footprint across restarts.
        packingDirty = Scalar("SELECT version FROM layout_policy WHERE id=1") is null;
        packingAspectRatio = Convert.ToDouble(Scalar("SELECT aspect FROM layout_policy WHERE id=1") ?? 1.6, System.Globalization.CultureInfo.InvariantCulture);
    }
    private static JsonObject Clone(JsonObject value) => (JsonObject)value.DeepClone();
    private static JsonObject Parse(string value) => JsonNode.Parse(value, documentOptions: new JsonDocumentOptions { MaxDepth = 64 }) as JsonObject ?? throw new InvalidDataException("Expected stored JSON object.");
    private static string Serialize(JsonNode node) => node.ToJsonString(Json);
    private static long Size(JsonNode node) => Encoding.UTF8.GetByteCount(Serialize(node));
    private static string String(JsonObject obj, string key) => obj[key]?.GetValue<string>() ?? "";
    private static long Integer(JsonObject obj, string key) => obj[key]?.GetValue<long>() ?? 0;
    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static bool Equal(string left, string right) => CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(left)), SHA256.HashData(Encoding.UTF8.GetBytes(right)));
    private string Token(string id) => Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secrets.RunSecret), Encoding.UTF8.GetBytes("run:" + id))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static JsonNode? Canonical(JsonNode? node) => node switch { JsonObject obj => new JsonObject(obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, Canonical(p.Value)))), JsonArray array => new JsonArray(array.Select(Canonical).ToArray()), _ => node?.DeepClone() };
    private static string Digest(JsonObject obj) => Digest(obj, out _);
    private static string Digest(JsonObject obj, out int bytes) { var encoded = JsonSerializer.SerializeToUtf8Bytes(Canonical(obj), Json); bytes = encoded.Length; return Convert.ToHexStringLower(SHA256.HashData(encoded)); }
    private static JsonObject Metadata(JsonObject view) => new(view.Where(pair => pair.Key != "components").Select(pair => KeyValuePair.Create(pair.Key, pair.Value?.DeepClone())));
    private static void ReceiptTimes(JsonArray entries, string receipt)
    {
        foreach (var entry in entries.OfType<JsonObject>()) if (!entry.ContainsKey("time")) entry["time"] = receipt;
    }
    private static JsonArray ObserveTasks(string text, JsonArray? previous, long now)
    {
        var old = previous?.OfType<JsonObject>().ToDictionary(row => String(row, "key"), StringComparer.Ordinal) ?? new Dictionary<string, JsonObject>();
        var rows = new JsonArray(); var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
        char fence = '\0'; var fenceLength = 0; var listContext = false; var line = 0;
        foreach (var source in text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            line++;
            var content = Regex.Replace(source, @"^(?:[ ]{0,3}>[ \t]?)+", "");
            var delimiter = Regex.Match(content, @"^([ \t]*)(?:([-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$", RegexOptions.CultureInvariant);
            if (delimiter.Success && (delimiter.Groups[1].Value.Replace("\t", "    ").Length < 4 || listContext || delimiter.Groups[2].Success))
            {
                var mark = delimiter.Groups[3].Value; var tail = delimiter.Groups[4].Value;
                if (fence != '\0') { if (mark[0] == fence && mark.Length >= fenceLength && string.IsNullOrWhiteSpace(tail)) fence = '\0'; }
                else if (mark[0] != '`' || !tail.Contains('`')) { fence = mark[0]; fenceLength = mark.Length; if (delimiter.Groups[2].Success) listContext = true; }
                continue;
            }
            if (fence != '\0') continue;
            var marker = Regex.Match(content, @"^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](?:[ \t]+(.*)|$)", RegexOptions.CultureInvariant);
            if (!marker.Success) { if (content.Length > 0 && !char.IsWhiteSpace(content[0]) && !Regex.IsMatch(content, @"^(?:[-*+]|\d+[.)])[ \t]+")) listContext = false; else if (Regex.IsMatch(content, @"^[ ]{0,3}(?:[-*+]|\d+[.)])[ \t]+")) listContext = true; continue; }
            var indent = marker.Groups[1].Value.Replace("\t", "    ").Length;
            // Deep indentation is ambiguous with Markdown code blocks; leave it untimed.
            if (indent >= 4) continue;
            listContext = true;
            if (rows.Count >= 1024) throw new HubError(413, "A Markdown component can contain at most 1024 observed task rows.");
            var normalized = Regex.Replace(marker.Groups[3].Value.Normalize(NormalizationForm.FormKC).Trim(), @"\s+", " ").ToLowerInvariant();
            var hash = Hash(normalized); occurrences.TryGetValue(hash, out var occurrence); occurrences[hash] = ++occurrence;
            var key = hash + ":" + occurrence; var completed = marker.Groups[2].Value != " ";
            var row = old.TryGetValue(key, out var before) ? Clone(before) : new JsonObject { ["key"] = key, ["firstSeenAt"] = now, ["updatedAt"] = now };
            row["line"] = line;
            if (before is null) { if (completed) row["completedAt"] = now; else row["startedAt"] = now; }
            else if (completed != row.ContainsKey("completedAt")) { row["updatedAt"] = now; if (completed) row["completedAt"] = now; else { row.Remove("completedAt"); row["startedAt"] = now; } }
            rows.Add(row);
        }
        return rows;
    }
    private static JsonArray ObserveChecklist(JsonArray items, JsonArray? previous, JsonArray? previousItems, long now)
    {
        var old = previous?.OfType<JsonObject>().ToDictionary(row => String(row, "key"), StringComparer.Ordinal) ?? new Dictionary<string, JsonObject>();
        var priorItems = previousItems?.OfType<JsonObject>().ToDictionary(item => String(item, "id"), StringComparer.Ordinal) ?? new Dictionary<string, JsonObject>();
        var rows = new JsonArray(); var line = 0;
        foreach (var item in items.OfType<JsonObject>())
        {
            var id = String(item, "id"); var key = "checklist:" + id; var completed = String(item, "status") == "completed";
            var row = old.TryGetValue(key, out var before) ? Clone(before) : new JsonObject { ["key"] = key, ["firstSeenAt"] = now, ["updatedAt"] = now };
            row["line"] = ++line;
            if (before is null) { if (completed) row["completedAt"] = now; else row["startedAt"] = now; }
            else
            {
                if (!priorItems.TryGetValue(id, out var prior) || !JsonNode.DeepEquals(prior, item)) row["updatedAt"] = now;
                if (completed != row.ContainsKey("completedAt")) { if (completed) row["completedAt"] = now; else { row.Remove("completedAt"); row["startedAt"] = now; } }
            }
            rows.Add(row);
        }
        return rows;
    }
    private SqliteCommand Command(string sql, params object?[] values)
    {
        if (!commands.TryGetValue(sql, out var command)) { command = db.CreateCommand(); command.CommandText = sql; for (var i = 0; i < values.Length; i++) command.Parameters.AddWithValue("$p" + i, values[i] ?? DBNull.Value); command.Prepare(); commands[sql] = command; }
        else for (var i = 0; i < values.Length; i++) command.Parameters[i].Value = values[i] ?? DBNull.Value;
        command.Transaction = transaction; return command;
    }
    private object? Scalar(string sql, params object?[] values) => Command(sql, values).ExecuteScalar();
    private void Execute(string sql, params object?[] values) => Command(sql, values).ExecuteNonQuery();
    private void UpsertComponents(string runId, JsonObject components, IEnumerable<string> touched)
    {
        var changed = touched.Select(id => components[id]).OfType<JsonObject>().ToArray(); if (changed.Length == 0) return;
        var values = new object?[1 + changed.Length * 2]; values[0] = runId;
        for (var i = 0; i < changed.Length; i++) { values[1 + i * 2] = String(changed[i], "id"); values[2 + i * 2] = Serialize(changed[i]); }
        var sql = componentUpsertSql[changed.Length] ??= "INSERT INTO components VALUES " + string.Join(',', Enumerable.Range(0, changed.Length).Select(i => $"($p0,$p{1 + i * 2},$p{2 + i * 2})")) + " ON CONFLICT(run_id,id) DO UPDATE SET payload=excluded.payload";
        Execute(sql, values);
    }
    private void Transaction(Action action)
    {
        using var current = db.BeginTransaction(); transaction = current;
        try { action(); current.Commit(); } catch { current.Rollback(); throw; } finally { transaction = null; }
    }
    private Run Authorize(string id, string token)
    {
        if (!runs.TryGetValue(id, out var run) || !Equal(run.TokenHash, Hash(token))) throw new HubError(403, "Invalid run credentials or unavailable run."); return run;
    }
    public void AuthorizeArchive(string id, string token)
    {
        lock (gate) { if ((!runs.ContainsKey(id) && Scalar("SELECT id FROM archives WHERE id=$p0", id) is null) || !Equal(token, Token(id))) throw new HubError(403, "Invalid run credentials or unavailable run."); }
    }
    public JsonObject? GetRun(string id) { lock (gate) return runs.TryGetValue(id, out var run) ? Clone(run.View) : null; }
    internal string OwnedToken(string id) { lock (gate) { if (!runs.ContainsKey(id)) throw new HubError(404, "Card unavailable. Restore it first."); return Token(id); } }
    public JsonObject Cards(int offset, int limit)
    {
        lock (gate) { if (offset < 0 || limit is < 1 or > 100) throw new HubError(400, "Use a bounded card page (1..100)."); return new JsonObject { ["total"] = runs.Count, ["offset"] = offset, ["cards"] = new JsonArray(runs.Values.OrderBy(r => Integer(r.View, "createdAt")).ThenBy(r => String(r.View, "id"), StringComparer.Ordinal).Skip(offset).Take(limit).Select(r => (JsonNode)CardSummary(r.View)).ToArray()) }; }
    }
    private static JsonObject CardSummary(JsonObject view)
    {
        // Component/task timing arrays can approach the full per-card budget. List pages contain only bounded summaries.
        var result = new JsonObject { ["permanent"] = view["application"] is not null };
        foreach (var key in new[] { "id", "agentId", "name", "role", "status", "parentId", "createdAt", "lastSeen", "updatedAt", "completedAt", "sequence", "layout", "icon", "managedSessionId", "orphanComponentId", "sessionId", "sessionProvider" })
            if (view.TryGetPropertyValue(key, out var value)) result[key] = value?.DeepClone();
        return result;
    }
    public JsonObject Rename(string id, string name)
    {
        ComponentValidator.Text(AgenticView.Server.Json.Object(new { name }), "name", 160, true, 1);
        lock (gate) { var run = Authorize(id, OwnedToken(id)); var view = Clone(run.View); view["name"] = name; SaveView(run, view); Queue(view); revision++; return Metadata(view); }
    }
    public JsonObject Orphan(JsonObject input)
    {
        var component = Clone(ComponentValidator.Object(input["component"])); ComponentValidator.Validate(component);
        lock (gate)
        {
            // Registration proof protects retries; an orphan has no agent parent or inbox authority.
            var proof = ComponentValidator.Text(input, "registrationKey", 256, true, 32);
            var registration = Register(AgenticView.Server.Json.Object(new { requestId = ComponentValidator.Id(input, "requestId"), registrationKey = Hash(proof + ":" + Digest(component)), agentId = "standalone-component", name = String(component, "title"), role = "Component" }));
            var id = String(registration, "runId"); var run = runs.TryGetValue(id, out var live) ? live : null;
            if (run is null) { Restore(id); run = runs[id]; }
            if (run.View["orphanComponentId"] is not null)
            {
                if (!JsonNode.DeepEquals(run.View["components"]?[String(component, "id")], component)) throw new HubError(409, "Standalone creation retry changed content. Use view_configure to edit it.");
                return Metadata(run.View);
            }
            PublishNext(id, Token(id), new JsonArray(AgenticView.Server.Json.Object(new { op = "upsert", component })));
            var view = Clone(run.View); view["orphanComponentId"] = String(component, "id"); view["application"] = AgenticView.Server.Json.Object(new { name = String(component, "title"), description = "Standalone component" });
            SaveView(run, view); Queue(view); revision++; return Metadata(view);
        }
    }
    public JsonObject ConfigureComponent(string id, string componentId, JsonObject input)
    {
        lock(gate) {
            if(!runs.TryGetValue(id,out var run)) throw new HubError(404,"Live card unavailable.");
            if(String(run.View,"status") is "completed" or "error") throw new HubError(409,"Completed cards are read-only.");
            var current=run.View["components"]?[componentId] as JsonObject ?? throw new HubError(404,"Component unavailable.");
            var candidate=ComponentConfiguration.Apply(current,input);
            // Operator edits have their own compare-and-swap and must not consume the producer sequence.
            var view=Clone(run.View);var now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            view["components"]![componentId]=candidate; view["updatedAt"]=now;
            var times=view["componentTimes"] as JsonObject ?? new JsonObject();if(view["componentTimes"] is null)view["componentTimes"]=times;times[componentId]=now;
            var tasks=view["taskTimes"] as JsonObject ?? new JsonObject();if(view["taskTimes"] is null)view["taskTimes"]=tasks;
            if(String(candidate,"kind")=="markdown") tasks[componentId]=ObserveTasks(String((JsonObject)candidate["data"]!,"text"),tasks[componentId] as JsonArray,now);
            if(String(candidate,"kind")=="checklist") tasks[componentId]=ObserveChecklist((JsonArray)candidate["data"]!["items"]!,tasks[componentId] as JsonArray,current["data"]?["items"] as JsonArray,now);
            var bytes=Size(view);if(bytes>MaxRunBytes||totalBytes-run.Bytes+bytes>MaxLiveBytes)throw new HubError(413,"Live data budget exceeded.");
            Transaction(()=>{Execute("UPDATE runs SET payload=$p0 WHERE id=$p1",Serialize(Metadata(view)),id);UpsertComponents(id,(JsonObject)view["components"]!,new[]{componentId});});
            totalBytes+=bytes-run.Bytes;run.Bytes=bytes;run.View=view;
            QueueBatch(view,new JsonArray(new JsonObject{["op"]="upsert",["component"]=candidate.DeepClone()}));revision++;
            return new JsonObject{["component"]=candidate.DeepClone(),["sequence"]=Integer(view,"sequence")};
        }
    }
    public JsonObject SetCardDisplay(string id,string token,JsonObject display)
    {
        CardDisplay.Validate(display);
        lock(gate) {
            if(!runs.ContainsKey(id)){AuthorizeArchive(id,token);Restore(id);}var run=Authorize(id,token);
            var view=Clone(run.View);foreach(var pair in display)view[pair.Key]=pair.Value?.DeepClone();SaveView(run,view);Queue(view);revision++;
            var result=new JsonObject();foreach(var key in new[]{"chrome","componentLayout"})if(view.ContainsKey(key))result[key]=view[key]?.DeepClone();return result;
        }
    }
    public JsonObject SetCardStyle(string id,string token,JsonObject style)
    {
        CardStyles.Validate(style); lock(gate) { if(!runs.ContainsKey(id)){AuthorizeArchive(id,token);Restore(id);} var run=Authorize(id,token); var view=Clone(run.View); view["icon"]=style["icon"]!.DeepClone(); SaveView(run,view); Queue(view); revision++; return new JsonObject{["icon"]=String(view,"icon")}; }
    }
    public void VerifyRun(string id, string token) { lock (gate) Authorize(id, token); }
    public JsonObject MakeApplication(string id, string token, JsonObject application)
    {
        lock (gate) { var run = Authorize(id, token); var view = Clone(run.View); view["application"] = application.DeepClone(); view["name"] = application["name"]!.DeepClone(); view["role"] = "Application"; view["status"] = "active"; view.Remove("completedAt"); SaveView(run, view); Queue(view); revision++; return Metadata(view); }
    }
    public void SetApplicationSize(string id,string token,JsonObject size)
    {
        lock(gate) { var run=Authorize(id,token); var view=Clone(run.View); var layout=Clone((JsonObject)view["layout"]!); layout["width"]=size["width"]!.DeepClone(); layout["height"]=size["height"]!.DeepClone(); layout["sizing"]=size["sizing"]!.DeepClone(); view["layout"]=FreePosition(layout,EffectiveRoots().Where(r=>String(r.View,"id")!=id).Select(r=>(JsonObject)r.View["layout"]!).ToList()); SaveView(run,view); Queue(view); packingDirty=true; revision++; }
    }
    public void MarkManagedSession(string id, string token, string sessionId)
    {
        lock (gate) { if (!runs.ContainsKey(id)) { AuthorizeArchive(id, token); Restore(id); } var run = Authorize(id, token); if (String(run.View, "managedSessionId") == sessionId) return; var view = Clone(run.View); view["managedSessionId"] = sessionId; SaveView(run, view); Queue(view); revision++; }
    }
    public JsonObject Register(JsonObject raw)
    {
        lock (gate)
        {
            ComponentValidator.Budget(raw);
            var request = ComponentValidator.Id(raw, "requestId"); var agentId = ComponentValidator.Id(raw, "agentId");
            var registrationKey = ComponentValidator.Text(raw, "registrationKey", 256, true, 32); var name = ComponentValidator.Text(raw, "name", 160, true, 1);
            var role = raw.ContainsKey("role") ? ComponentValidator.Text(raw, "role", 160) : "Agent";
            var context = ComponentValidator.Text(raw, "context", 8192, false); var parent = ComponentValidator.Id(raw, "parentId", false); var proof = ComponentValidator.Text(raw, "parentToken", 256, false);
            var registration = new JsonObject { ["requestId"] = request, ["registrationKey"] = registrationKey, ["agentId"] = agentId, ["name"] = name, ["role"] = role, ["context"] = context };
            var sessionId = ComponentValidator.Text(raw, "sessionId", 256, false);
            var sessionProvider = ComponentValidator.Text(raw, "sessionProvider", 80, false);
            if (sessionId.Length > 0 && sessionProvider.Length == 0) throw new HubError(400, "sessionProvider is required with a native sessionId.");
            if (sessionProvider.Length > 0 && sessionId.Length == 0) throw new HubError(400, "sessionId is required with sessionProvider.");
            var identity = sessionId.Length == 0 ? "" : Digest(AgenticView.Server.Json.Object(new { sessionProvider, sessionId }));
            if (identity.Length > 0) { registration["sessionId"] = sessionId; registration["sessionProvider"] = sessionProvider; }
            if(raw.ContainsKey("icon")) { CardStyles.Validate(raw); registration["icon"]=raw["icon"]!.DeepClone(); }
            if (raw.ContainsKey("parentId")) registration["parentId"] = parent; if (raw.ContainsKey("parentToken")) registration["parentToken"] = proof;
            var display=new JsonObject();foreach(var key in new[]{"chrome","componentLayout"})if(raw.ContainsKey(key))display[key]=raw[key]?.DeepClone();CardDisplay.Validate(display);foreach(var pair in display)registration[pair.Key]=pair.Value?.DeepClone();
            var hash = Digest(registration);
            using (var reader = Command("SELECT run_id,request_hash FROM requests WHERE request_id=$p0", request).ExecuteReader())
                if (reader.Read()) { var existingId = reader.GetString(0); if (!Equal(reader.GetString(1), hash)) throw new HubError(409, "Registration ID was already used with different content or proof."); return Registration(existingId, runs.TryGetValue(existingId, out var existing) ? existing.View : ReadArchive(existingId)); }
            if (parent.Length > 0) Authorize(parent, proof);
            if (identity.Length > 0)
            {
                string? boundId = null, boundProof = null, boundParent = null;
                using (var reader = Command("SELECT run_id,proof_hash,parent_id FROM session_bindings WHERE identity=$p0", identity).ExecuteReader())
                    if (reader.Read()) { boundId = reader.GetString(0); boundProof = reader.GetString(1); boundParent = reader.GetString(2); }
                if (boundId is not null)
                {
                    if (!Equal(boundProof!, Hash(registrationKey)) || boundParent != parent) throw new HubError(409, "Native session belongs to another registration proof or parent.");
                    if (!runs.ContainsKey(boundId)) Restore(boundId);
                    SetSessionStatus(boundId, Token(boundId), "active");
                    var boundView = runs[boundId].View;
                    Execute("INSERT INTO requests VALUES($p0,$p1,$p2)", request, boundId, hash);
                    return Registration(boundId, boundView);
                }
            }
            if (runs.Count >= 2000 || totalBytes >= MaxLiveBytes) throw new HubError(429, "Live capacity reached. Archive completed runs first.");
            var id = Guid.NewGuid().ToString(); var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var layoutStart = Stopwatch.GetTimestamp();
            var initial = new JsonObject { ["x"] = 0, ["y"] = 0, ["width"] = 480, ["height"] = 420, ["locked"] = false, ["z"] = 1, ["sizing"] = "content", ["automatic"] = true };
            var layout = parent.Length > 0 ? initial : InitialPosition(initial, EffectiveRoots().Select(r => (JsonObject)r.View["layout"]!).ToList());
            registrationLayoutTicks += Stopwatch.GetTimestamp() - layoutStart;
            var view = new JsonObject { ["id"] = id, ["agentId"] = agentId, ["name"] = name, ["role"] = role, ["context"] = context, ["parentId"] = parent.Length > 0 ? parent : null, ["createdAt"] = now, ["lastSeen"] = now, ["status"] = "active", ["sequence"] = 0L, ["components"] = new JsonObject(), ["layout"] = layout };
            if(registration.ContainsKey("icon")) view["icon"]=registration["icon"]!.DeepClone();
            foreach(var key in new[]{"chrome","componentLayout"})if(registration.ContainsKey(key))view[key]=registration[key]?.DeepClone();
            if (identity.Length > 0) { view["sessionId"] = sessionId; view["sessionProvider"] = sessionProvider; }
            var bytes = Size(view); if (totalBytes + bytes > MaxLiveBytes) throw new HubError(429, "Live capacity reached.");
            var run = new Run(view, Hash(Token(id)), bytes);
            Transaction(() => { Execute("INSERT INTO runs VALUES($p0,$p1,$p2,$p3,$p4,$p5)", id, Serialize(Metadata(view)), request, hash, run.TokenHash, ""); Execute("INSERT INTO requests VALUES($p0,$p1,$p2)", request, id, hash); if (identity.Length > 0) Execute("INSERT INTO session_bindings VALUES($p0,$p1,$p2,$p3)", identity, id, Hash(registrationKey), parent); });
            runs[id] = run; totalBytes += bytes; Queue(view); freshLayouts.Add(id); packingDirty = true; revision++; return Registration(id, view);
        }
    }
    private JsonObject Registration(string id, JsonObject view) => new() { ["runId"] = id, ["runToken"] = Token(id), ["heartbeatSeconds"] = 15, ["sequence"] = Integer(view, "sequence") };
    public JsonObject Publish(string id, string token, JsonObject raw)
    {
        var start = Stopwatch.GetTimestamp();
        try { return PublishCore(id, token, raw, start); }
        catch { lock (gate) monitoring.Rejected(); throw; }
    }
    public JsonObject PublishNext(string id,string token,JsonArray operations)
    {
        lock(gate) { if(!runs.ContainsKey(id)) { AuthorizeArchive(id,token); Restore(id); } var run=Authorize(id,token); return Publish(id,token,new JsonObject { ["sequence"]=Integer(run.View,"sequence")+1,["operations"]=operations }); }
    }
    public void SetSessionStatus(string id,string token,string status)
    {
        lock(gate) { if(!runs.ContainsKey(id)) { AuthorizeArchive(id,token); Restore(id); } var run=Authorize(id,token); var view=Clone(run.View); if(String(view,"status")==status) return; view["status"]=status; var now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); view["updatedAt"]=now; view["lastSeen"]=now; if(status=="completed") view["completedAt"]=now; else if(status=="active") view.Remove("completedAt"); SaveView(run,view); Queue(view); revision++; }
    }
    private JsonObject PublishCore(string id, string token, JsonObject raw, long start)
    {
        lock (gate)
        {
            var entered = Stopwatch.GetTimestamp();
            ComponentValidator.Budget(raw); var recovering = !runs.ContainsKey(id);
            Run run;
            if (recovering) { AuthorizeArchive(id, token); var archived = ReadArchive(id); run = new Run(archived, Hash(token), Size(archived)); }
            else run = Authorize(id, token);
            var sequence = (long)ComponentValidator.Number(raw, "sequence", 1, 9007199254740991, true, true);
            var operations = ComponentValidator.Array(raw, "operations", 256, 1); var authorized = Stopwatch.GetTimestamp(); var hash = Digest(raw, out var payloadBytes); var digested = Stopwatch.GetTimestamp();
            if (run.View["orphanComponentId"] is JsonValue standalone)
            {
                var componentId = standalone.GetValue<string>();
                foreach (var node in operations)
                {
                    var op = ComponentValidator.Object(node); var kind = String(op, "op");
                    if (kind is "clear" or "remove" || kind == "upsert" && String(ComponentValidator.Object(op["component"]), "id") != componentId || kind == "append" && String(op, "componentId") != componentId)
                        throw new HubError(400, "A standalone card contains its designated component only. Edit that component or archive the card.");
                }
            }
            if (sequence <= Integer(run.View, "sequence"))
            {
                var previous = Scalar(recovering ? "SELECT digest FROM archive_batches WHERE run_id=$p0 AND sequence=$p1" : "SELECT digest FROM batches WHERE run_id=$p0 AND sequence=$p1", id, sequence) as string;
                if (previous is not null && Equal(previous, hash)) { if (recovering) Restore(id); monitoring.Duplicate(); return new JsonObject { ["sequence"] = Integer(run.View, "sequence"), ["duplicate"] = true, ["trimmed"] = 0, ["restored"] = recovering }; }
                throw new HubError(409, "Sequence was already used or is outside the retry window. No new content accepted.");
            }
            if (sequence != Integer(run.View, "sequence") + 1) throw new HubError(409, $"Expected sequence {Integer(run.View, "sequence") + 1}.");
            var received = DateTimeOffset.UtcNow; var now = received.ToUnixTimeMilliseconds(); var receipt = received.ToString("O");
            var view = Clone(run.View); view["lastSeen"] = now; view["updatedAt"] = now; view["sequence"] = sequence; if (String(view, "status") == "stale") view["status"] = "active";
            var componentTimes = view["componentTimes"] as JsonObject ?? new JsonObject(); if (view["componentTimes"] is null) view["componentTimes"] = componentTimes;
            var taskTimes = view["taskTimes"] as JsonObject ?? new JsonObject(); if (view["taskTimes"] is null) view["taskTimes"] = taskTimes;
            var touched = new HashSet<string>(); var trimmed = 0; var copied = Stopwatch.GetTimestamp();
            foreach (var n in operations)
            {
                var op = ComponentValidator.Object(n); var action = ComponentValidator.Text(op, "op", 32);
                if (String(view, "status") is "completed" or "error" && action is not ("remove" or "clear")) throw new HubError(409, "Completed runs only accept cleanup or archive operations.");
                var components = (JsonObject)view["components"]!;
                switch (action)
                {
                    case "upsert": var component = Clone(ComponentValidator.Object(op["component"])); ComponentValidator.Validate(component, checkBudget: false); var cid = String(component, "id"); if (String(component, "kind") is "logs" or "timeline") ReceiptTimes((JsonArray)component["data"]![String(component, "kind") == "logs" ? "entries" : "events"]!, receipt); if (String(component, "kind") is "markdown" or "checklist") { var tasks = String(component, "kind") == "markdown" ? ObserveTasks(String((JsonObject)component["data"]!, "text"), taskTimes[cid] as JsonArray, now) : ObserveChecklist((JsonArray)component["data"]!["items"]!, taskTimes[cid] as JsonArray, components[cid] is JsonObject prior && String(prior, "kind") == "checklist" ? prior["data"]?["items"] as JsonArray : null, now); if (tasks.Count > 0) taskTimes[cid] = tasks; else taskTimes.Remove(cid); } else taskTimes.Remove(cid); components[cid] = component; componentTimes[cid] = now; touched.Add(cid); break;
                    case "remove": var removedId = ComponentValidator.Id(op, "componentId"); components.Remove(removedId); componentTimes.Remove(removedId); taskTimes.Remove(removedId); break;
                    case "clear": view["components"] = new JsonObject(); componentTimes.Clear(); taskTimes.Clear(); break;
                    case "context": view["context"] = ComponentValidator.Text(op, "text", 8192); break;
                    case "style": CardStyles.Validate(op); view["icon"]=op["icon"]!.DeepClone(); break;
                    case "status": ComponentValidator.Choice(op, "status", ["active", "completed", "error"]); view["status"] = String(op, "status"); if (String(view, "status") == "completed" && view["completedAt"] is null) view["completedAt"] = now; break;
                    case "append":
                        var appendId = ComponentValidator.Id(op, "componentId"); var items = ComponentValidator.Array(op, "items", 512, 1);
                        if (components[appendId] is not JsonObject previous || String(previous, "kind") is not ("logs" or "timeline" or "table")) throw new HubError(400, "Append requires existing logs, timeline, or table.");
                        var field = String(previous, "kind") == "logs" ? "entries" : String(previous, "kind") == "timeline" ? "events" : "rows"; var limit = field == "events" ? 1000 : 2000;
                        var data = (JsonObject)previous["data"]!; var appended = new JsonArray(items.Select(x => x?.DeepClone()).ToArray()); if (field is "entries" or "events") ReceiptTimes(appended, receipt);
                        var all = ((JsonArray)data[field]!).Select(x => x?.DeepClone()).Concat(appended.Select(x => x?.DeepClone())).ToList(); trimmed += Math.Max(0, all.Count - limit);
                        data[field] = new JsonArray(all.TakeLast(limit).ToArray()); ComponentValidator.Validate(previous); componentTimes[appendId] = now; touched.Add(appendId); break;
                    default: throw new HubError(400, "Unsupported mutation operation.");
                }
            }
            var mutated = Stopwatch.GetTimestamp();
            if (((JsonObject)view["components"]!).Count > 64) throw new HubError(413, "A run can contain at most 64 components.");
            if (recovering) PrepareRestore(view);
            var bytes = Size(view); if (bytes > MaxRunBytes || totalBytes - (recovering ? 0 : run.Bytes) + bytes > MaxLiveBytes) throw new HubError(413, "Live data budget exceeded.");
            var budgeted = Stopwatch.GetTimestamp();
            Transaction(() =>
            {
                if (recovering) PersistRestore(view, run.TokenHash);
                Execute("UPDATE runs SET payload=$p0,last_digest=$p1 WHERE id=$p2", Serialize(Metadata(view)), hash, id);
                Execute("INSERT INTO batches VALUES($p0,$p1,$p2)", id, sequence, hash); Execute("DELETE FROM batches WHERE run_id=$p0 AND sequence<$p1", id, sequence - 255);
                if (!recovering)
                {
                    foreach (var n in operations) { var op = (JsonObject)n!; if (String(op, "op") == "clear") Execute("DELETE FROM components WHERE run_id=$p0", id); if (String(op, "op") == "remove") Execute("DELETE FROM components WHERE run_id=$p0 AND id=$p1", id, String(op, "componentId")); }
                    UpsertComponents(id, (JsonObject)view["components"]!, touched);
                }
            });
            var committed = Stopwatch.GetTimestamp(); var previousView = run.View;
            if (recovering) AcceptRestore(run, view);
            else { totalBytes += bytes - run.Bytes; run.Bytes = bytes; run.View = view; QueueBatch(view, operations); }
            revision++; updates += operations.Count;
            monitoring.Accepted(id, operations, view, previousView, payloadBytes, start, entered, authorized, digested, copied, mutated, budgeted, committed, Stopwatch.GetTimestamp());
            return new JsonObject { ["sequence"] = sequence, ["duplicate"] = false, ["trimmed"] = trimmed, ["restored"] = recovering };
        }
    }
    public JsonObject Heartbeat(string id, string token)
    {
        lock (gate) { if (!runs.ContainsKey(id)) { AuthorizeArchive(id, token); var archived = ReadArchive(id); return new JsonObject { ["lastSeen"] = Integer(archived, "lastSeen"), ["sequence"] = Integer(archived, "sequence"), ["archived"] = true }; } var run = Authorize(id, token); var view = Clone(run.View); var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); view["lastSeen"] = now; if (String(view, "status") == "stale") view["status"] = "active"; SaveView(run, view); Queue(view); revision++; return new JsonObject { ["lastSeen"] = now, ["sequence"] = Integer(view, "sequence") }; }
    }
    private void SaveView(Run run, JsonObject view) { var bytes = Size(view); if (bytes > MaxRunBytes || totalBytes - run.Bytes + bytes > MaxLiveBytes) throw new HubError(413, "Live data budget exceeded."); Execute("UPDATE runs SET payload=$p0 WHERE id=$p1", Serialize(Metadata(view)), String(view, "id")); totalBytes += bytes - run.Bytes; run.Bytes = bytes; run.View = view; }
    private IEnumerable<Run> EffectiveRoots() => runs.Values.Where(r => r.View["parentId"] is null || !runs.ContainsKey(String(r.View, "parentId")));
    public JsonObject SetInteraction(string id, JsonObject input)
    {
        lock (gate)
        {
            if (!runs.ContainsKey(id)) throw new HubError(404, "Run unavailable.");
            if (input["active"] is not JsonValue flag || !flag.TryGetValue<bool>(out var active)) throw new HubError(400, "active must be a boolean.");
            if (input["leaseId"] is not JsonValue lease || !lease.TryGetValue<string>(out var leaseId) || leaseId.Length is < 1 or > 128 || leaseId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('_' or '-' or ':' or '.'))) throw new HubError(400, "leaseId must contain 1-128 ASCII letters, digits, underscores, hyphens, colons or periods.");
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            foreach (var key in interactionReservations.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray()) interactionReservations.Remove(key);
            var keyForLease = (id, leaseId);
            long? expiresAt = null;
            if (active)
            {
                if (!interactionReservations.ContainsKey(keyForLease) && interactionReservations.Keys.Count(key => key.RunId == id) >= 64) throw new HubError(429, "Too many interaction leases for this run.");
                expiresAt = now + 30_000; interactionReservations[keyForLease] = expiresAt.Value;
            }
            else interactionReservations.Remove(keyForLease);
            packingDirty = true;
            return new JsonObject { ["active"] = active, ["leaseId"] = leaseId, ["expiresAt"] = expiresAt };
        }
    }
    public JsonObject MarkManual(string id)
    {
        lock (gate)
        {
            if (!runs.TryGetValue(id, out var run)) throw new HubError(404, "Run unavailable.");
            var view = Clone(run.View); var layout = (JsonObject)view["layout"]!; layout["automatic"] = false;
            SaveView(run, view); Queue(view); manualReservations[id] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000; packingDirty = true; revision++; return Clone(layout);
        }
    }
    public JsonObject SetLayout(string id, JsonObject raw)
    {
        lock (gate)
        {
            if (!runs.TryGetValue(id, out var run)) throw new HubError(404, "Run unavailable."); var layout = Clone(raw);
            ComponentValidator.Number(layout, "x", -1e7, 1e7); ComponentValidator.Number(layout, "y", -1e7, 1e7); ComponentValidator.Number(layout, "width", 320, 1600); ComponentValidator.Number(layout, "height", 240, String(layout, "sizing") == "content" ? 100000 : 1600); ComponentValidator.Number(layout, "z", 0, 1e9, true, true);
            if (!layout.ContainsKey("locked")) throw new HubError(400, "locked is required."); ComponentValidator.Boolean(layout, "locked"); ComponentValidator.Choice(layout, "sizing", ["content", "fixed"], "fixed");
            layout = new JsonObject { ["x"] = N(layout, "x"), ["y"] = N(layout, "y"), ["width"] = N(layout, "width"), ["height"] = N(layout, "height"), ["z"] = (long)N(layout, "z"), ["locked"] = layout["locked"]!.GetValue<bool>(), ["sizing"] = String(layout, "sizing"), ["automatic"] = ComponentValidator.Boolean(layout, "automatic") };
            var current = (JsonObject)run.View["layout"]!;
            if (current["locked"]!.GetValue<bool>() && (N(layout, "x") != N(current, "x") || N(layout, "y") != N(current, "y"))) throw new HubError(409, "Unlock the card before moving it.");
            var obstacles = EffectiveRoots().Where(other => other != run).Select(other => (JsonObject)other.View["layout"]!).ToList();
            if ((run.View["parentId"] is null || !runs.ContainsKey(String(run.View, "parentId"))) && obstacles.Any(other => Overlaps(layout, other)))
            {
                if (!ComponentValidator.Boolean(raw, "resolveOverlap") || current["locked"]!.GetValue<bool>() || layout["locked"]!.GetValue<bool>()) throw new HubError(409, "Cards cannot overlap.");
                layout = FreePosition(layout, obstacles);
            }
            var view = Clone(run.View); view["layout"] = layout; SaveView(run, view); Queue(view); manualReservations.Remove(id); freshLayouts.Remove(id); packingDirty = true; revision++; return Clone(layout);
        }
    }
    private static JsonObject NormalizeSettings(JsonObject raw)
    {
        var stale = raw.ContainsKey("staleSeconds") ? (int)ComponentValidator.Number(raw, "staleSeconds", 15, 86400, true, true) : 45;
        int? archive = !raw.ContainsKey("autoArchiveMinutes") ? 5 : raw["autoArchiveMinutes"] is null ? null : (int)ComponentValidator.Number(raw, "autoArchiveMinutes", 1, 525600, true, true);
        var shortcuts=raw["cardShortcuts"]?.DeepClone(); if(raw.ContainsKey("cardShortcuts")) CardShortcuts.Validate(shortcuts);
        return new JsonObject { ["cardShortcuts"]=shortcuts??new JsonArray(), ["staleSeconds"] = stale, ["autoArchiveMinutes"] = archive, ["archiveAfterCompletion"] = ComponentValidator.Boolean(raw, "archiveAfterCompletion", true), ["trustedEmbeds"] = ComponentValidator.Boolean(raw, "trustedEmbeds", true), ["reducedMotion"] = ComponentValidator.Boolean(raw, "reducedMotion") };
    }
    public JsonObject SetSettings(JsonObject raw) { lock (gate) { var next = NormalizeSettings(raw); Execute("INSERT INTO settings VALUES(1,$p0) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", Serialize(next)); settings = next; settingsDirty = true; revision++; return Clone(next); } }
    public JsonObject Archive(string id)
    {
        lock (gate)
        {
            if (!runs.TryGetValue(id, out var run)) { var existing = Scalar("SELECT summary FROM archives WHERE id=$p0", id) as string; return existing is not null ? Parse(existing) : throw new HubError(404, "Run unavailable."); }
            var raw = Encoding.UTF8.GetBytes(Serialize(run.View)); using var output = new MemoryStream(); using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, true)) gzip.Write(raw); var compressed = output.ToArray();
            var summary = new JsonObject { ["id"] = id, ["name"] = String(run.View, "name"), ["agentId"] = String(run.View, "agentId"), ["role"] = String(run.View, "role"), ["parentId"] = run.View["parentId"]?.DeepClone(), ["status"] = String(run.View, "status"), ["archivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["bytes"] = compressed.Length, ["rawBytes"] = raw.Length };
            foreach (var field in new[] { "createdAt", "updatedAt", "completedAt" }) if (run.View[field] is { } timestamp) summary[field] = timestamp.DeepClone();
            var obstacles = EffectiveRoots().Where(r => r != run).Select(r => (JsonObject)r.View["layout"]!).ToList();
            var promoted = new List<(Run Run, JsonObject View)>();
            foreach (var child in runs.Values.Where(r => String(r.View, "parentId") == id)) { var view = Clone(child.View); var layout = InitialPosition((JsonObject)view["layout"]!, obstacles); view["layout"] = layout; obstacles.Add(layout); promoted.Add((child, view)); }
            if (promoted.Any(child => Size(child.View) > MaxRunBytes) || totalBytes - run.Bytes + promoted.Sum(child => Size(child.View) - child.Run.Bytes) > MaxLiveBytes) throw new HubError(413, "Promoted child layout exceeds the live data budget.");
            Transaction(() => { Execute("INSERT INTO archives VALUES($p0,$p1,$p2)", id, Serialize(summary), compressed); Execute("INSERT INTO archive_batches SELECT run_id,sequence,digest FROM batches WHERE run_id=$p0", id); Execute("DELETE FROM runs WHERE id=$p0", id); foreach (var child in promoted) Execute("UPDATE runs SET payload=$p0 WHERE id=$p1", Serialize(Metadata(child.View)), String(child.View, "id")); });
            foreach (var child in promoted) { totalBytes += Size(child.View) - child.Run.Bytes; child.Run.Bytes = Size(child.View); child.Run.View = child.View; Queue(child.View); }
            runs.Remove(id); monitoring.Remove(id); totalBytes -= run.Bytes; archiveCount++; pending.Remove(id); removed.Add(id); manualReservations.Remove(id); foreach (var key in interactionReservations.Keys.Where(key => key.RunId == id).ToArray()) interactionReservations.Remove(key); freshLayouts.Remove(id); packingDirty = true; revision++; return summary;
        }
    }
    // Recovery keeps the same identity and credentials; only placement may change to avoid live cards.
    private void PrepareRestore(JsonObject view)
    {
        if (runs.Count >= 2000) throw new HubError(429, "Live capacity reached. Archive completed runs first.");
        var id = String(view, "id");
        if (view["parentId"] is null || !runs.ContainsKey(String(view, "parentId")))
            view["layout"] = FreePosition((JsonObject)view["layout"]!, EffectiveRoots().Where(r => String(r.View, "parentId") != id).Select(r => (JsonObject)r.View["layout"]!).ToList());
        if (Size(view) > MaxRunBytes || totalBytes + Size(view) > MaxLiveBytes) throw new HubError(413, "Live data budget exceeded.");
    }
    private void PersistRestore(JsonObject view, string tokenHash)
    {
        var id = String(view, "id");
        var count = Command("INSERT INTO runs SELECT $p0,$p1,request_id,request_hash,$p2,'' FROM requests WHERE run_id=$p0 ORDER BY rowid LIMIT 1", id, Serialize(Metadata(view)), tokenHash).ExecuteNonQuery();
        if (count != 1) throw new HubError(409, "Registration evidence is unavailable; archive retained.");
        foreach (var pair in (JsonObject)view["components"]!) Execute("INSERT INTO components VALUES($p0,$p1,$p2)", id, pair.Key, Serialize(pair.Value!));
        Execute("INSERT INTO batches SELECT run_id,sequence,digest FROM archive_batches WHERE run_id=$p0", id);
        Execute("DELETE FROM archives WHERE id=$p0", id);
    }
    private void AcceptRestore(Run run, JsonObject view)
    {
        var id = String(view, "id"); run.View = view; run.Bytes = Size(view); runs[id] = run; totalBytes += run.Bytes; archiveCount--;
        removed.Remove(id); pending.Remove(id); freshLayouts.Add(id); packingDirty = true; Queue(view); var patch = pending[id]; patch.Clear = true;
        foreach (var pair in (JsonObject)view["components"]!) patch.Components[pair.Key] = Clone((JsonObject)pair.Value!);
    }
    public JsonObject Restore(string id)
    {
        lock (gate)
        {
            if (runs.TryGetValue(id, out var existing)) return Clone(existing.View);
            var view = ReadArchive(id); PrepareRestore(view); view["lastSeen"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); view["restoredAt"] = view["lastSeen"]!.DeepClone(); if (String(view, "status") == "stale") view["status"] = "active";
            var run = new Run(view, Hash(Token(id)), 0); Transaction(() => PersistRestore(view, run.TokenHash)); AcceptRestore(run, view); revision++; return Clone(view);
        }
    }
    public JsonArray Archives(int offset = 0, int limit = 1000)
    {
        lock (gate) { if (offset < 0 || limit is < 1 or > 1000) throw new HubError(400, "Invalid archive page."); var result = new JsonArray(); using var reader = Command("SELECT summary FROM archives ORDER BY rowid DESC LIMIT $p0 OFFSET $p1", limit, offset).ExecuteReader(); while (reader.Read()) result.Add(Parse(reader.GetString(0))); return result; }
    }
    public byte[] ArchiveBytes(string id) { lock (gate) return Scalar("SELECT payload FROM archives WHERE id=$p0", id) as byte[] ?? throw new HubError(404, "Archive not found."); }
    public JsonObject ReadArchive(string id)
    {
        lock (gate) { using var input = new MemoryStream(ArchiveBytes(id)); using var gzip = new GZipStream(input, CompressionMode.Decompress); using var output = new MemoryStream(); var buffer = new byte[8192]; int read; while ((read = gzip.Read(buffer)) > 0) { if (output.Length + read > MaxRunBytes) throw new HubError(413, "Archive exceeds the decompression budget."); output.Write(buffer, 0, read); } return Parse(Encoding.UTF8.GetString(output.ToArray())); }
    }
    private JsonObject Stats() => new() { ["active"] = runs.Values.Count(r => String(r.View, "status") == "active"), ["stale"] = runs.Values.Count(r => String(r.View, "status") == "stale"), ["archived"] = archiveCount, ["updates"] = updates, ["updatesPerSecond"] = rate };
    public JsonObject PackLayout(JsonObject request)
    {
        lock (gate)
        {
            ComponentValidator.Choice(request, "mode", ["all", "automatic"], "all");
            var aspect = request.ContainsKey("aspectRatio") ? ComponentValidator.Number(request, "aspectRatio", .3, 4) : packingAspectRatio;
            var result = PackCards(String(request, "mode") == "all", aspect); packingAspectRatio = aspect; packingDirty = false; freshLayouts.Clear(); return result;
        }
    }
    private JsonObject PackCards(bool all, double aspect)
    {
        var roots = EffectiveRoots().ToArray();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var interactingRuns = interactionReservations.Where(pair => pair.Value > now).Select(pair => pair.Key.RunId).ToHashSet();
        bool Movable(Run run) { var layout = (JsonObject)run.View["layout"]!; var id = String(run.View, "id"); return (all || freshLayouts.Contains(id)) && !ComponentValidator.Boolean(layout, "locked") && !manualReservations.ContainsKey(id) && !interactingRuns.Contains(id); }
        var movable = roots.Where(Movable).ToArray(); var fixedCards = roots.Where(r => !Movable(r)).ToArray();
        var packed = CanvasPacking.PackStable(movable.Select(r => { var l = (JsonObject)r.View["layout"]!; var id = String(r.View, "id"); return new PositionedPackingItem(id, N(l, "x"), N(l, "y"), N(l, "width"), N(l, "height"), Integer(r.View, "createdAt"), !freshLayouts.Contains(id)); }).ToArray(), fixedCards.Select(r => { var l = (JsonObject)r.View["layout"]!; return new PackingRect(N(l, "x"), N(l, "y"), N(l, "width"), N(l, "height")); }).ToArray(), aspect, all);
        var changed = new List<(Run Run, JsonObject View, long Bytes)>();
        foreach (var run in movable)
        {
            var position = packed[String(run.View, "id")]; var current = (JsonObject)run.View["layout"]!;
            if (N(current, "x") == position.X && N(current, "y") == position.Y && ComponentValidator.Boolean(current, "automatic")) continue;
            var view = Clone(run.View); var layout = (JsonObject)view["layout"]!; layout["x"] = position.X; layout["y"] = position.Y; layout["automatic"] = true;
            changed.Add((run, view, Size(view)));
        }
        if (changed.Any(c => c.Bytes > MaxRunBytes) || totalBytes + changed.Sum(c => c.Bytes - c.Run.Bytes) > MaxLiveBytes) throw new HubError(413, "Packed layouts exceed the live data budget.");
        Transaction(() => { foreach (var c in changed) Execute("UPDATE runs SET payload=$p0 WHERE id=$p1", Serialize(Metadata(c.View)), String(c.View, "id")); Execute("INSERT INTO layout_policy VALUES(1,1,$p0) ON CONFLICT(id) DO UPDATE SET version=excluded.version,aspect=excluded.aspect", aspect); });
        if (changed.Count > 0)
        {
            foreach (var c in changed) { totalBytes += c.Bytes - c.Run.Bytes; c.Run.Bytes = c.Bytes; c.Run.View = c.View; Queue(c.View); } revision++;
        }
        return new JsonObject { ["arranged"] = movable.Length, ["changed"] = changed.Count, ["fixed"] = fixedCards.Length };
    }
    public JsonObject Snapshot() { lock (gate) return new JsonObject { ["revision"] = revision, ["agents"] = new JsonArray(runs.Values.Select(r => (JsonNode)Clone(r.View)).ToArray()), ["settings"] = Clone(settings), ["stats"] = Stats() }; }
    private void Queue(JsonObject view, JsonObject? op = null)
    {
        QueueOperation(QueueMetadata(view), view, op);
    }
    private Pending QueueMetadata(JsonObject view)
    {
        var id = String(view, "id"); var meta = Metadata(view);
        if (!pending.TryGetValue(id, out var p)) pending[id] = p = new Pending(meta); else p.Meta = meta;
        return p;
    }
    private void QueueBatch(JsonObject view, JsonArray operations)
    {
        var p = QueueMetadata(view); foreach (var op in operations.OfType<JsonObject>()) QueueOperation(p, view, op);
    }
    private static void QueueOperation(Pending p, JsonObject view, JsonObject? op)
    {
        var action = op is null ? "" : String(op, "op");
        if (action == "clear") { p.Clear = true; p.Components.Clear(); p.Removed.Clear(); }
        if (action == "remove") { var cid = String(op!, "componentId"); p.Components.Remove(cid); p.Removed.Add(cid); }
        var changed = action == "upsert" ? String((JsonObject)op!["component"]!, "id") : action == "append" ? String(op!, "componentId") : "";
        if (changed.Length > 0 && view["components"]![changed] is JsonObject component) { p.Components[changed] = Clone(component); p.Removed.Remove(changed); }
    }
    public void Flush()
    {
        JsonObject patch; lock (gate)
        {
            if (disposed) return;
            if (packingDirty) { packingDirty = false; try { PackCards(false, packingAspectRatio); freshLayouts.Clear(); } catch { Console.Error.WriteLine("Automatic arrangement failed; existing layouts retained."); } }
            patch = new JsonObject { ["revision"] = revision, ["changes"] = new JsonArray(pending.Select(pair => (JsonNode)new JsonObject { ["id"] = pair.Key, ["meta"] = Clone(pair.Value.Meta), ["components"] = new JsonArray(pair.Value.Components.Values.Select(c => (JsonNode)Clone(c)).ToArray()), ["removeComponents"] = new JsonArray(pair.Value.Removed.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()), ["clear"] = pair.Value.Clear }).ToArray()), ["removed"] = new JsonArray(removed.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()), ["stats"] = Stats() };
            if (settingsDirty) patch["settings"] = Clone(settings); pending.Clear(); removed.Clear(); settingsDirty = false;
        }
        Patched?.Invoke(patch);
    }
    public void Tick()
    {
        lock (gate)
        {
            if (disposed) return; var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            foreach (var id in manualReservations.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray()) { manualReservations.Remove(id); packingDirty = true; }
            foreach (var key in interactionReservations.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray()) { interactionReservations.Remove(key); packingDirty = true; }
            foreach (var run in runs.Values.ToArray())
            {
                if (run.View["application"] is not null && run.View["managedSessionId"] is null) continue;
                var inactive = now - Integer(run.View, "lastSeen");
                if (String(run.View, "status") == "active" && inactive >= N(settings, "staleSeconds") * 1000) { var view = Clone(run.View); view["status"] = "stale"; SaveView(run, view); Queue(view); revision++; }
                var completed = String(run.View, "status") == "completed";
                var age = now - Math.Max(Integer(run.View, "completedAt"), Integer(run.View, "restoredAt"));
                var delay = settings["autoArchiveMinutes"] is null ? double.PositiveInfinity : N(settings, "autoArchiveMinutes") * 60000;
                var eligible = settings["archiveAfterCompletion"]!.GetValue<bool>() && completed && age >= delay;
                if (settings["autoArchiveMinutes"] is not null && eligible && !interactionReservations.Any(pair => pair.Key.RunId == String(run.View, "id") && pair.Value > now))
                    try { Archive(String(run.View, "id")); } catch { Console.Error.WriteLine("Automatic archive failed; live state remains retained."); }
            }
            monitoring.Sample(now, runs.Values.Count(r => String(r.View, "status") == "active"), runs.Values.Count(r => String(r.View, "status") == "stale")); rate = monitoring.UpdateRate;
        }
    }
    private static double N(JsonObject obj, string key) => double.Parse(obj[key]!.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture);
    private JsonObject InitialPosition(JsonObject rectangle, List<JsonObject> obstacles)
    {
        // Parse each obstacle once; registration is independent of drag path solving.
        var bounds = obstacles.Select(o => (X: N(o, "x"), Y: N(o, "y"), W: N(o, "width"), H: N(o, "height"))).ToArray();
        var width = N(rectangle, "width"); var height = N(rectangle, "height");
        for (var attempt = 0; attempt < 100_000; attempt++)
        {
            var slot = nextSlot++; var x = slot % 8 * 512.0; var y = slot / 8 * 452.0;
            if (Math.Abs(x) > 1e7 || Math.Abs(y) > 1e7) break;
            if (bounds.Any(o => x < o.X + o.W + 16 && x + width + 16 > o.X && y < o.Y + o.H + 16 && y + height + 16 > o.Y)) continue;
            var result = Clone(rectangle); result["x"] = x; result["y"] = y; return result;
        }
        throw new HubError(429, "No free card position within the layout budget.");
    }
    private static bool Overlaps(JsonObject a, JsonObject b, int gap = 16) => N(a, "x") < N(b, "x") + N(b, "width") + gap && N(a, "x") + N(a, "width") + gap > N(b, "x") && N(a, "y") < N(b, "y") + N(b, "height") + gap && N(a, "y") + N(a, "height") + gap > N(b, "y");
    private static JsonObject FreePosition(JsonObject rectangle, List<JsonObject> obstacles)
    {
        var result = Clone(rectangle); if (!obstacles.Any(o => Overlaps(result, o))) return result;
        var x = N(result, "x"); var y = N(result, "y"); var width = N(result, "width"); var height = N(result, "height");
        var nearby = obstacles.OrderBy(o => Math.Abs(N(o, "x") - x) + Math.Abs(N(o, "y") - y)).Take(48).ToArray();
        var xs = new[] { x }.Concat(nearby.SelectMany(o => new[] { N(o, "x") - width - 16, N(o, "x") + N(o, "width") + 16 }));
        var ys = new[] { y }.Concat(nearby.SelectMany(o => new[] { N(o, "y") - height - 16, N(o, "y") + N(o, "height") + 16 })).ToArray();
        JsonObject? best = null; var distance = double.PositiveInfinity;
        foreach (var cx in xs) foreach (var cy in ys) { var d = (cx - x) * (cx - x) + (cy - y) * (cy - y); if (d >= distance || Math.Abs(cx) > 1e7 || Math.Abs(cy) > 1e7) continue; result["x"] = cx; result["y"] = cy; if (!obstacles.Any(o => Overlaps(result, o))) { best = Clone(result); distance = d; } }
        if (best is not null) return best;
        result["x"] = obstacles.Max(o => N(o, "x") + N(o, "width")) + 16; result["y"] = y;
        if (Math.Abs(N(result, "x")) > 1e7) throw new HubError(409, "No free layout position within canvas bounds."); return result;
    }
    public void Dispose() { lock (gate) { if (disposed) return; disposed = true; foreach (var command in commands.Values) command.Dispose(); commands.Clear(); db.Dispose(); monitoring.Dispose(); } }
}
