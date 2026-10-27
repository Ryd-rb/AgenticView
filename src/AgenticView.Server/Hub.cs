using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using System.Diagnostics;

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
    private readonly Dictionary<string, Run> runs = new();
    private readonly Dictionary<string, Pending> pending = new();
    private readonly HashSet<string> removed = [];
    private readonly HashSet<string> freshLayouts = [];
    private readonly Dictionary<string, long> manualReservations = new();
    private JsonObject settings;
    private long revision, updates, previousUpdates, totalBytes, archiveCount;
    private double rate;
    private bool settingsDirty, disposed, packingDirty;
    private bool compactPacking;
    private double packingAspectRatio = 1.6;
    private SqliteTransaction? transaction;
    private long registrationLayoutTicks;
    private int nextSlot;
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
        packingDirty = Scalar("SELECT version FROM layout_policy WHERE id=1") is null; compactPacking = packingDirty;
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
    private static string Digest(JsonObject obj) => Hash(Serialize(Canonical(obj)!));
    private static JsonObject Metadata(JsonObject view) => new(view.Where(pair => pair.Key != "components").Select(pair => KeyValuePair.Create(pair.Key, pair.Value?.DeepClone())));
    private SqliteCommand Command(string sql, params object?[] values)
    {
        if (!commands.TryGetValue(sql, out var command)) { command = db.CreateCommand(); command.CommandText = sql; for (var i = 0; i < values.Length; i++) command.Parameters.AddWithValue("$p" + i, values[i] ?? DBNull.Value); command.Prepare(); commands[sql] = command; }
        else for (var i = 0; i < values.Length; i++) command.Parameters[i].Value = values[i] ?? DBNull.Value;
        command.Transaction = transaction; return command;
    }
    private object? Scalar(string sql, params object?[] values) => Command(sql, values).ExecuteScalar();
    private void Execute(string sql, params object?[] values) => Command(sql, values).ExecuteNonQuery();
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
            if (raw.ContainsKey("parentId")) registration["parentId"] = parent; if (raw.ContainsKey("parentToken")) registration["parentToken"] = proof;
            var hash = Digest(registration);
            using (var reader = Command("SELECT run_id,request_hash FROM requests WHERE request_id=$p0", request).ExecuteReader())
                if (reader.Read()) { var existingId = reader.GetString(0); if (!Equal(reader.GetString(1), hash)) throw new HubError(409, "Registration ID was already used with different content or proof."); return Registration(existingId, runs.TryGetValue(existingId, out var existing) ? existing.View : ReadArchive(existingId)); }
            if (parent.Length > 0) Authorize(parent, proof);
            if (runs.Count >= 2000 || totalBytes >= MaxLiveBytes) throw new HubError(429, "Live capacity reached. Archive completed runs first.");
            var id = Guid.NewGuid().ToString(); var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var layoutStart = Stopwatch.GetTimestamp();
            var initial = new JsonObject { ["x"] = 0, ["y"] = 0, ["width"] = 480, ["height"] = 420, ["locked"] = false, ["z"] = 1, ["sizing"] = "fixed", ["automatic"] = true };
            var layout = parent.Length > 0 ? initial : InitialPosition(initial, EffectiveRoots().Select(r => (JsonObject)r.View["layout"]!).ToList());
            registrationLayoutTicks += Stopwatch.GetTimestamp() - layoutStart;
            var view = new JsonObject { ["id"] = id, ["agentId"] = agentId, ["name"] = name, ["role"] = role, ["context"] = context, ["parentId"] = parent.Length > 0 ? parent : null, ["createdAt"] = now, ["lastSeen"] = now, ["status"] = "active", ["sequence"] = 0L, ["components"] = new JsonObject(), ["layout"] = layout };
            var bytes = Size(view); if (totalBytes + bytes > MaxLiveBytes) throw new HubError(429, "Live capacity reached.");
            var run = new Run(view, Hash(Token(id)), bytes);
            Transaction(() => { Execute("INSERT INTO runs VALUES($p0,$p1,$p2,$p3,$p4,$p5)", id, Serialize(Metadata(view)), request, hash, run.TokenHash, ""); Execute("INSERT INTO requests VALUES($p0,$p1,$p2)", request, id, hash); });
            runs[id] = run; totalBytes += bytes; Queue(view); freshLayouts.Add(id); packingDirty = true; revision++; return Registration(id, view);
        }
    }
    private JsonObject Registration(string id, JsonObject view) => new() { ["runId"] = id, ["runToken"] = Token(id), ["heartbeatSeconds"] = 15, ["sequence"] = Integer(view, "sequence") };
    public JsonObject Publish(string id, string token, JsonObject raw)
    {
        lock (gate)
        {
            ComponentValidator.Budget(raw); var recovering = !runs.ContainsKey(id);
            Run run;
            if (recovering) { AuthorizeArchive(id, token); var archived = ReadArchive(id); run = new Run(archived, Hash(token), Size(archived)); }
            else run = Authorize(id, token);
            var sequence = (long)ComponentValidator.Number(raw, "sequence", 1, 9007199254740991, true, true);
            var operations = ComponentValidator.Array(raw, "operations", 256, 1); var hash = Digest(raw);
            if (sequence <= Integer(run.View, "sequence"))
            {
                var previous = Scalar(recovering ? "SELECT digest FROM archive_batches WHERE run_id=$p0 AND sequence=$p1" : "SELECT digest FROM batches WHERE run_id=$p0 AND sequence=$p1", id, sequence) as string;
                if (previous is not null && Equal(previous, hash)) { if (recovering) Restore(id); return new JsonObject { ["sequence"] = Integer(run.View, "sequence"), ["duplicate"] = true, ["trimmed"] = 0, ["restored"] = recovering }; }
                throw new HubError(409, "Sequence was already used or is outside the retry window. No new content accepted.");
            }
            if (sequence != Integer(run.View, "sequence") + 1) throw new HubError(409, $"Expected sequence {Integer(run.View, "sequence") + 1}.");
            var view = Clone(run.View); view["lastSeen"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); view["sequence"] = sequence; if (String(view, "status") == "stale") view["status"] = "active";
            var touched = new HashSet<string>(); var trimmed = 0;
            foreach (var n in operations)
            {
                var op = ComponentValidator.Object(n); var action = ComponentValidator.Text(op, "op", 32);
                if (String(view, "status") is "completed" or "error" && action is not ("remove" or "clear")) throw new HubError(409, "Completed runs only accept cleanup or archive operations.");
                var components = (JsonObject)view["components"]!;
                switch (action)
                {
                    case "upsert": var component = Clone(ComponentValidator.Object(op["component"])); ComponentValidator.Validate(component); var cid = String(component, "id"); components[cid] = component; touched.Add(cid); break;
                    case "remove": components.Remove(ComponentValidator.Id(op, "componentId")); break;
                    case "clear": view["components"] = new JsonObject(); break;
                    case "context": view["context"] = ComponentValidator.Text(op, "text", 8192); break;
                    case "status": ComponentValidator.Choice(op, "status", ["active", "completed", "error"]); view["status"] = String(op, "status"); break;
                    case "append":
                        var appendId = ComponentValidator.Id(op, "componentId"); var items = ComponentValidator.Array(op, "items", 512, 1);
                        if (components[appendId] is not JsonObject previous || String(previous, "kind") is not ("logs" or "timeline" or "table")) throw new HubError(400, "Append requires existing logs, timeline, or table.");
                        var field = String(previous, "kind") == "logs" ? "entries" : String(previous, "kind") == "timeline" ? "events" : "rows"; var limit = field == "events" ? 1000 : 2000;
                        var data = (JsonObject)previous["data"]!; var all = ((JsonArray)data[field]!).Select(x => x?.DeepClone()).Concat(items.Select(x => x?.DeepClone())).ToList(); trimmed += Math.Max(0, all.Count - limit);
                        data[field] = new JsonArray(all.TakeLast(limit).ToArray()); ComponentValidator.Validate(previous); touched.Add(appendId); break;
                    default: throw new HubError(400, "Unsupported mutation operation.");
                }
            }
            if (((JsonObject)view["components"]!).Count > 64) throw new HubError(413, "A run can contain at most 64 components.");
            if (recovering) PrepareRestore(view);
            var bytes = Size(view); if (bytes > MaxRunBytes || totalBytes - (recovering ? 0 : run.Bytes) + bytes > MaxLiveBytes) throw new HubError(413, "Live data budget exceeded.");
            Transaction(() =>
            {
                if (recovering) PersistRestore(view, run.TokenHash);
                Execute("UPDATE runs SET payload=$p0,last_digest=$p1 WHERE id=$p2", Serialize(Metadata(view)), hash, id);
                Execute("INSERT INTO batches VALUES($p0,$p1,$p2)", id, sequence, hash); Execute("DELETE FROM batches WHERE run_id=$p0 AND sequence<$p1", id, sequence - 255);
                if (!recovering)
                {
                    foreach (var n in operations) { var op = (JsonObject)n!; if (String(op, "op") == "clear") Execute("DELETE FROM components WHERE run_id=$p0", id); if (String(op, "op") == "remove") Execute("DELETE FROM components WHERE run_id=$p0 AND id=$p1", id, String(op, "componentId")); }
                    foreach (var cid in touched) if (view["components"]![cid] is JsonObject component) Execute("INSERT INTO components VALUES($p0,$p1,$p2) ON CONFLICT(run_id,id) DO UPDATE SET payload=excluded.payload", id, cid, Serialize(component));
                }
            });
            if (recovering) AcceptRestore(run, view);
            else { totalBytes += bytes - run.Bytes; run.Bytes = bytes; run.View = view; foreach (var op in operations) Queue(view, (JsonObject)op!); }
            revision++; updates += operations.Count;
            if (settings["archiveAfterCompletion"]!.GetValue<bool>() && String(view, "status") is "completed" or "error")
                try { Archive(id); } catch { Console.Error.WriteLine("Automatic archive failed; accepted live state remains retained."); }
            return new JsonObject { ["sequence"] = sequence, ["duplicate"] = false, ["trimmed"] = trimmed, ["restored"] = recovering };
        }
    }
    public JsonObject Heartbeat(string id, string token)
    {
        lock (gate) { if (!runs.ContainsKey(id)) { AuthorizeArchive(id, token); var archived = ReadArchive(id); return new JsonObject { ["lastSeen"] = Integer(archived, "lastSeen"), ["sequence"] = Integer(archived, "sequence"), ["archived"] = true }; } var run = Authorize(id, token); var view = Clone(run.View); var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); view["lastSeen"] = now; if (String(view, "status") == "stale") view["status"] = "active"; SaveView(run, view); Queue(view); revision++; return new JsonObject { ["lastSeen"] = now, ["sequence"] = Integer(view, "sequence") }; }
    }
    private void SaveView(Run run, JsonObject view) { var bytes = Size(view); if (bytes > MaxRunBytes || totalBytes - run.Bytes + bytes > MaxLiveBytes) throw new HubError(413, "Live data budget exceeded."); Execute("UPDATE runs SET payload=$p0 WHERE id=$p1", Serialize(Metadata(view)), String(view, "id")); totalBytes += bytes - run.Bytes; run.Bytes = bytes; run.View = view; }
    private IEnumerable<Run> EffectiveRoots() => runs.Values.Where(r => r.View["parentId"] is null || !runs.ContainsKey(String(r.View, "parentId")));
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
            ComponentValidator.Number(layout, "x", -1e7, 1e7); ComponentValidator.Number(layout, "y", -1e7, 1e7); ComponentValidator.Number(layout, "width", 320, 1600); ComponentValidator.Number(layout, "height", 240, 1600); ComponentValidator.Number(layout, "z", 0, 1e9, true, true);
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
            var dimensionsChanged = N(current, "width") != N(layout, "width") || N(current, "height") != N(layout, "height");
            var view = Clone(run.View); view["layout"] = layout; SaveView(run, view); Queue(view); manualReservations.Remove(id); freshLayouts.Remove(id); packingDirty = true; compactPacking |= dimensionsChanged; revision++; return Clone(layout);
        }
    }
    private static JsonObject NormalizeSettings(JsonObject raw)
    {
        var stale = raw.ContainsKey("staleSeconds") ? (int)ComponentValidator.Number(raw, "staleSeconds", 15, 86400, true, true) : 45;
        int? archive = raw["autoArchiveMinutes"] is null ? null : (int)ComponentValidator.Number(raw, "autoArchiveMinutes", 1, 525600, true, true);
        return new JsonObject { ["staleSeconds"] = stale, ["autoArchiveMinutes"] = archive, ["archiveAfterCompletion"] = ComponentValidator.Boolean(raw, "archiveAfterCompletion"), ["trustedEmbeds"] = ComponentValidator.Boolean(raw, "trustedEmbeds", true), ["reducedMotion"] = ComponentValidator.Boolean(raw, "reducedMotion") };
    }
    public JsonObject SetSettings(JsonObject raw) { lock (gate) { var next = NormalizeSettings(raw); Execute("INSERT INTO settings VALUES(1,$p0) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", Serialize(next)); settings = next; settingsDirty = true; revision++; return Clone(next); } }
    public JsonObject Archive(string id)
    {
        lock (gate)
        {
            if (!runs.TryGetValue(id, out var run)) { var existing = Scalar("SELECT summary FROM archives WHERE id=$p0", id) as string; return existing is not null ? Parse(existing) : throw new HubError(404, "Run unavailable."); }
            var raw = Encoding.UTF8.GetBytes(Serialize(run.View)); using var output = new MemoryStream(); using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, true)) gzip.Write(raw); var compressed = output.ToArray();
            var summary = new JsonObject { ["id"] = id, ["name"] = String(run.View, "name"), ["agentId"] = String(run.View, "agentId"), ["role"] = String(run.View, "role"), ["parentId"] = run.View["parentId"]?.DeepClone(), ["status"] = String(run.View, "status"), ["archivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["bytes"] = compressed.Length, ["rawBytes"] = raw.Length };
            var obstacles = EffectiveRoots().Where(r => r != run).Select(r => (JsonObject)r.View["layout"]!).ToList();
            var promoted = new List<(Run Run, JsonObject View)>();
            foreach (var child in runs.Values.Where(r => String(r.View, "parentId") == id)) { var view = Clone(child.View); var layout = InitialPosition((JsonObject)view["layout"]!, obstacles); view["layout"] = layout; obstacles.Add(layout); promoted.Add((child, view)); }
            if (promoted.Any(child => Size(child.View) > MaxRunBytes) || totalBytes - run.Bytes + promoted.Sum(child => Size(child.View) - child.Run.Bytes) > MaxLiveBytes) throw new HubError(413, "Promoted child layout exceeds the live data budget.");
            Transaction(() => { Execute("INSERT INTO archives VALUES($p0,$p1,$p2)", id, Serialize(summary), compressed); Execute("INSERT INTO archive_batches SELECT run_id,sequence,digest FROM batches WHERE run_id=$p0", id); Execute("DELETE FROM runs WHERE id=$p0", id); foreach (var child in promoted) Execute("UPDATE runs SET payload=$p0 WHERE id=$p1", Serialize(Metadata(child.View)), String(child.View, "id")); });
            foreach (var child in promoted) { totalBytes += Size(child.View) - child.Run.Bytes; child.Run.Bytes = Size(child.View); child.Run.View = child.View; Queue(child.View); }
            runs.Remove(id); totalBytes -= run.Bytes; archiveCount++; pending.Remove(id); removed.Add(id); manualReservations.Remove(id); freshLayouts.Remove(id); packingDirty = true; compactPacking = true; revision++; return summary;
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
        var count = Command("INSERT INTO runs SELECT $p0,$p1,request_id,request_hash,$p2,'' FROM requests WHERE run_id=$p0", id, Serialize(Metadata(view)), tokenHash).ExecuteNonQuery();
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
            var view = ReadArchive(id); PrepareRestore(view); view["lastSeen"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); if (String(view, "status") == "stale") view["status"] = "active";
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
            var result = PackCards(String(request, "mode") == "all" || compactPacking, aspect); packingAspectRatio = aspect; packingDirty = false; compactPacking = false; freshLayouts.Clear(); return result;
        }
    }
    private JsonObject PackCards(bool all, double aspect)
    {
        var roots = EffectiveRoots().ToArray();
        bool Movable(Run run) { var layout = (JsonObject)run.View["layout"]!; return !ComponentValidator.Boolean(layout, "locked") && !manualReservations.ContainsKey(String(run.View, "id")); }
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
        var id = String(view, "id"); if (!pending.TryGetValue(id, out var p)) pending[id] = p = new Pending(Metadata(view)); p.Meta = Metadata(view);
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
            if (packingDirty) { packingDirty = false; try { PackCards(compactPacking, packingAspectRatio); freshLayouts.Clear(); compactPacking = false; } catch { Console.Error.WriteLine("Automatic arrangement failed; existing layouts retained."); } }
            patch = new JsonObject { ["revision"] = revision, ["changes"] = new JsonArray(pending.Select(pair => (JsonNode)new JsonObject { ["id"] = pair.Key, ["meta"] = Clone(pair.Value.Meta), ["components"] = new JsonArray(pair.Value.Components.Values.Select(c => (JsonNode)Clone(c)).ToArray()), ["removeComponents"] = new JsonArray(pair.Value.Removed.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()), ["clear"] = pair.Value.Clear }).ToArray()), ["removed"] = new JsonArray(removed.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()), ["stats"] = Stats() };
            if (settingsDirty) patch["settings"] = Clone(settings); pending.Clear(); removed.Clear(); settingsDirty = false;
        }
        Patched?.Invoke(patch);
    }
    public void Tick()
    {
        lock (gate)
        {
            if (disposed) return; rate = updates - previousUpdates; previousUpdates = updates; var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            foreach (var id in manualReservations.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray()) { manualReservations.Remove(id); packingDirty = true; }
            foreach (var run in runs.Values.ToArray())
            {
                var inactive = now - Integer(run.View, "lastSeen");
                if (String(run.View, "status") == "active" && inactive >= N(settings, "staleSeconds") * 1000) { var view = Clone(run.View); view["status"] = "stale"; SaveView(run, view); Queue(view); revision++; }
                if (settings["autoArchiveMinutes"] is not null && inactive >= N(settings, "autoArchiveMinutes") * 60000)
                    try { Archive(String(run.View, "id")); } catch { Console.Error.WriteLine("Automatic archive failed; live state remains retained."); }
            }
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
    public void Dispose() { lock (gate) { if (disposed) return; disposed = true; foreach (var command in commands.Values) command.Dispose(); commands.Clear(); db.Dispose(); } }
}
