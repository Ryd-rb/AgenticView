using System.Diagnostics;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

// All mutations are made under Hub's gate. History and histograms stay bounded.
internal sealed class MonitoringState : IDisposable
{
    private sealed class Counter { public long Total, Previous; public double Rate; }
    private readonly Dictionary<string, Counter> agents = new(StringComparer.Ordinal), kinds = new(StringComparer.Ordinal);
    private readonly Queue<JsonObject> history = new();
    private readonly Process process = Process.GetCurrentProcess();
    private readonly long started = Stopwatch.GetTimestamp();
    private long sampled = Stopwatch.GetTimestamp(), batches, previousBatches, operations, previousOperations, bytes, previousBytes, duplicates, rejected;
    private readonly double[] latencyBounds = [.1, .25, .5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000, 2000, 5000, 10000, double.PositiveInfinity];
    private readonly long[] latencyCounts = new long[18], stages = new long[8];
    private readonly string[] stageNames = ["Gate wait", "Authorization", "Digest", "Copy state", "Validate / mutate", "Size budget", "SQLite commit", "Queue viewer patch"];
    private double previousCpu, cpu, batchRate, operationRate, byteRate, p95;
    private int viewers;
    public double UpdateRate => operationRate;
    public bool OpenViewer() { if (Interlocked.Increment(ref viewers) <= 16) return true; Interlocked.Decrement(ref viewers); return false; }
    public void CloseViewer() => Interlocked.Decrement(ref viewers);
    public void Duplicate() => duplicates++;
    public void Rejected() => rejected++;
    public void Remove(string id) => agents.Remove(id);
    private static void Add(Dictionary<string, Counter> counters, string key, long amount) { if (!counters.TryGetValue(key, out var counter)) counters[key] = counter = new Counter(); counter.Total += amount; }

    public void Accepted(string id, JsonArray ops, JsonObject view, JsonObject previous, int payloadBytes, long start, long entered, long authorized, long digested, long copied, long mutated, long budgeted, long committed, long queued)
    {
        batches++; operations += ops.Count; bytes += payloadBytes; Add(agents, id, ops.Count);
        foreach (var node in ops.OfType<JsonObject>())
        {
            var action = node["op"]!.GetValue<string>();
            var kind = action == "upsert" ? node["component"]!["kind"]!.GetValue<string>() : action == "append" ?
                (view["components"]?[node["componentId"]!.GetValue<string>()]?["kind"] ?? previous["components"]?[node["componentId"]!.GetValue<string>()]?["kind"])?.GetValue<string>() ?? "append" : "control";
            Add(kinds, kind, 1);
        }
        var ms = (queued - start) * 1000d / Stopwatch.Frequency;
        for (var i = 0; i < latencyBounds.Length; i++) if (ms <= latencyBounds[i]) { latencyCounts[i]++; break; }
        stages[0] += entered - start; stages[1] += authorized - entered; stages[2] += digested - authorized; stages[3] += copied - digested;
        stages[4] += mutated - copied; stages[5] += budgeted - mutated; stages[6] += committed - budgeted; stages[7] += queued - committed;
    }

    public void Sample(long time, int active, int stale)
    {
        var current = Stopwatch.GetTimestamp(); var seconds = Math.Max(.001, (current - sampled) / (double)Stopwatch.Frequency); sampled = current;
        batchRate = (batches - previousBatches) / seconds; operationRate = (operations - previousOperations) / seconds; byteRate = (bytes - previousBytes) / seconds;
        previousBatches = batches; previousOperations = operations; previousBytes = bytes;
        foreach (var c in agents.Values.Concat(kinds.Values)) { c.Rate = (c.Total - c.Previous) / seconds; c.Previous = c.Total; }
        var totalCpu = process.TotalProcessorTime.TotalSeconds; cpu = Math.Clamp((totalCpu - previousCpu) / seconds / Environment.ProcessorCount * 100, 0, 100); previousCpu = totalCpu;
        long seen = 0; p95 = 0; var target = Math.Ceiling(batches * .95);
        for (var i = 0; i < latencyCounts.Length; i++) { seen += latencyCounts[i]; if (target > 0 && seen >= target) { p95 = double.IsFinite(latencyBounds[i]) ? latencyBounds[i] : 10000; break; } }
        history.Enqueue(new JsonObject { ["time"] = time, ["active"] = active, ["stale"] = stale, ["updatesPerSecond"] = operationRate, ["batchesPerSecond"] = batchRate, ["bytesPerSecond"] = byteRate, ["cpuPercent"] = cpu });
        while (history.Count > 300) history.Dequeue();
    }

    public JsonObject Snapshot(IEnumerable<JsonObject> live, long liveBytes, long archives)
    {
        var views = live.ToArray(); var inventory = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var v in views) foreach (var c in ((JsonObject)v["components"]!).Select(pair => pair.Value).OfType<JsonObject>()) { var kind = c["kind"]!.GetValue<string>(); inventory[kind] = inventory.GetValueOrDefault(kind) + 1; }
        var stageTotal = stages.Sum();
        return new JsonObject
        {
            ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["uptimeSeconds"] = (Stopwatch.GetTimestamp() - started) / (double)Stopwatch.Frequency,
            ["active"] = views.Count(v => v["status"]!.GetValue<string>() == "active"), ["stale"] = views.Count(v => v["status"]!.GetValue<string>() == "stale"), ["completed"] = views.Count(v => v["status"]!.GetValue<string>() == "completed"), ["errors"] = views.Count(v => v["status"]!.GetValue<string>() == "error"),
            ["liveAgents"] = views.Length, ["archived"] = archives, ["components"] = inventory.Values.Sum(), ["viewerStreams"] = Volatile.Read(ref viewers), ["liveBytes"] = liveBytes,
            ["acceptedBatches"] = batches, ["acceptedOperations"] = operations, ["acceptedPayloadBytes"] = bytes, ["duplicateBatches"] = duplicates, ["rejectedPublishes"] = rejected,
            ["updatesPerSecond"] = operationRate, ["batchesPerSecond"] = batchRate, ["bytesPerSecond"] = byteRate, ["publishP95Ms"] = p95,
            ["cpuPercent"] = cpu, ["workingSetBytes"] = Environment.WorkingSet, ["managedHeapBytes"] = GC.GetTotalMemory(false),
            ["history"] = new JsonArray(history.Select(h => (JsonNode)h.DeepClone()).ToArray()),
            ["kinds"] = new JsonArray(kinds.Keys.Union(inventory.Keys).OrderBy(k => k, StringComparer.Ordinal).Select(k => (JsonNode)new JsonObject { ["kind"] = k, ["components"] = inventory.GetValueOrDefault(k), ["operations"] = kinds.GetValueOrDefault(k)?.Total ?? 0, ["updatesPerSecond"] = kinds.GetValueOrDefault(k)?.Rate ?? 0 }).ToArray()),
            ["agents"] = new JsonArray(views.OrderByDescending(v => agents.GetValueOrDefault(v["id"]!.GetValue<string>())?.Rate ?? 0).ThenBy(v => v["createdAt"]!.GetValue<long>()).Take(100).Select(v => (JsonNode)new JsonObject { ["id"] = v["id"]!.DeepClone(), ["name"] = v["name"]!.DeepClone(), ["status"] = v["status"]!.DeepClone(), ["lastSeen"] = v["lastSeen"]!.DeepClone(), ["components"] = ((JsonObject)v["components"]!).Count, ["operations"] = agents.GetValueOrDefault(v["id"]!.GetValue<string>())?.Total ?? 0, ["updatesPerSecond"] = agents.GetValueOrDefault(v["id"]!.GetValue<string>())?.Rate ?? 0 }).ToArray()),
            ["stages"] = new JsonArray(stages.Select((ticks, i) => (JsonNode)new JsonObject { ["name"] = stageNames[i], ["totalMilliseconds"] = ticks * 1000d / Stopwatch.Frequency, ["meanMilliseconds"] = batches == 0 ? 0 : ticks * 1000d / Stopwatch.Frequency / batches, ["share"] = stageTotal == 0 ? 0 : ticks * 100d / stageTotal }).ToArray())
        };
    }
    public void Dispose() => process.Dispose();
}
