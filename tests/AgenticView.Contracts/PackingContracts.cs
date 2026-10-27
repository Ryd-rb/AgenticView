using AgenticView.Server;
using System.Diagnostics;

public static class PackingContracts
{
    public static void Run()
    {
        Check(CanvasPacking.Pack([], []).Count == 0, "Empty pack was not empty.");
        var items = Enumerable.Range(0, 80).Select(i => new PackingItem("card-" + i, 320 + i % 9 * 137, 240 + i % 7 * 190)).ToArray();
        var obstacles = new[] { new PackingRect(-300, -200, 640, 480), new PackingRect(700, 400, 1100, 900), new PackingRect(100000, -4000, 1600, 800), new PackingRect(-9000, 5000, 600, 800) };
        var original = obstacles.ToArray();
        var packed = CanvasPacking.Pack(items, obstacles);
        Verify(items, obstacles, packed);
        Check(obstacles.SequenceEqual(original), "Packing moved fixed obstacles.");
        var reversed = CanvasPacking.Pack(items.Reverse().ToArray(), obstacles.Reverse().ToArray());
        Check(packed.All(pair => reversed[pair.Key] == pair.Value), "Packing depends on input order.");
        var origin = CanvasPacking.Pack([new("one", 320, 320)], [new(-160, -160, 480, 480)]);
        Verify([new("one", 320, 320)], [new(-160, -160, 480, 480)], origin);
        Throws(() => CanvasPacking.Pack([new("one", 320, 320)], [new(-1e7, -1e7, 2e7 + 2000, 2e7 + 2000)]), 409);
        Throws(() => CanvasPacking.Pack([new("same", 320, 320), new("same", 320, 320)], []), 400);
        var many = Enumerable.Range(0, 1000).Select(i => new PackingItem("load-" + i, 320 + i % 11 * 120, 320 + i % 9 * 150)).ToArray();
        var watch = Stopwatch.StartNew(); var load = CanvasPacking.Pack(many, obstacles); watch.Stop();
        Verify(many, obstacles, load);
        Console.WriteLine($"Packing geometry: {many.Length} items, {obstacles.Length} obstacles, {watch.Elapsed.TotalMilliseconds:F2} ms (synthetic; no image capture).");
        var dense = Enumerable.Range(0, 1000).Select(i => new PackingRect(i % 25 * 1300 - 2600, i / 25 * 1100 - 2200, 600 + i % 3 * 250, 400 + i % 5 * 170)).ToArray();
        watch.Restart(); var obstructed = CanvasPacking.Pack(many, dense); watch.Stop(); Verify(many, dense, obstructed);
        Console.WriteLine($"Packing obstacles: {many.Length} items, {dense.Length} obstacles, {watch.Elapsed.TotalMilliseconds:F2} ms (synthetic).");
        Verify(items, obstacles, CanvasPacking.Pack(items, obstacles, 0.7));
    }

    private static void Verify(IReadOnlyList<PackingItem> items, IReadOnlyList<PackingRect> obstacles, Dictionary<string, PackingRect> packed)
    {
        Check(packed.Count == items.Count, "Packing omitted an item.");
        foreach (var item in items)
        {
            var rect = packed[item.Id];
            Check(rect.Width == item.Width && rect.Height == item.Height && double.IsFinite(rect.X) && double.IsFinite(rect.Y) && Math.Abs(rect.X) <= 1e7 && Math.Abs(rect.Y) <= 1e7, "Packing changed dimensions or exceeded bounds.");
            foreach (var obstacle in obstacles) Check(!Overlaps(rect, obstacle), "Packing intersects a fixed obstacle or its gap.");
        }
        var values = packed.Values.ToArray();
        for (var i = 0; i < values.Length; i++) for (var j = i + 1; j < values.Length; j++) Check(!Overlaps(values[i], values[j]), "Packed items overlap or lack the 16-unit gap.");
    }
    private static bool Overlaps(PackingRect a, PackingRect b) => a.X < b.X + b.Width + 16 && a.X + a.Width + 16 > b.X && a.Y < b.Y + b.Height + 16 && a.Y + a.Height + 16 > b.Y;
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static void Throws(Action action, int status) { try { action(); } catch (HubError error) when (error.Status == status) { return; } throw new Exception("Expected HubError " + status); }
}
