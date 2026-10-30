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
        StableContracts();
        SquareCompactionContracts();
        var fractional=Enumerable.Range(0,17).Select(i=>new PackingItem("fractional-"+i,320.1+i*.2,240.1+i*.3)).ToArray();
        Verify(fractional,[],CanvasPacking.Pack(fractional,[]));
        var maximum=Enumerable.Range(0,2000).Select(i=>new PackingItem("maximum-"+i,320+i%11*120,320+i%9*150)).ToArray();
        var maximumObstacles=Enumerable.Range(0,2000).Select(i=>new PackingRect(i%40*1300-2600,i/40*1100-2200,600+i%3*250,400+i%5*170)).ToArray();
        watch.Restart();var maximumPacked=CanvasPacking.Pack(maximum,maximumObstacles);watch.Stop();Verify(maximum,maximumObstacles,maximumPacked);
        Console.WriteLine($"Maximum packing: {maximum.Length} items, {maximumObstacles.Length} obstacles, {watch.Elapsed.TotalMilliseconds:F2} ms (synthetic geometry).");
    }

    private static void SquareCompactionContracts()
    {
        // These fixtures exercise explicit Arrange all compaction only. Arrival
        // placement remains covered separately by the unchanged stable contracts.
        foreach (var (count, side) in new[] { (4, 480d), (9, 480d), (16, 320d) })
        {
            var items = Enumerable.Range(0, count).Select(i => new PackingItem("square-" + i, side, side)).ToArray();
            var positioned = PriorPositions(items);
            var packed = CanvasPacking.PackStable(positioned, [], compact: true);
            Verify(items, [], packed);
            var bounds = Bounds(packed.Values);
            var edgeCount = Math.Sqrt(count);
            var feasibleSide = edgeCount * side + (edgeCount - 1) * 16;
            Check(Math.Max(bounds.Width, bounds.Height) <= feasibleSide * 1.02, "Equal-square compaction missed a feasible near-square group.");
            Check(Math.Max(bounds.Width / bounds.Height, bounds.Height / bounds.Width) <= 1.05, "Default explicit compaction did not target a square group.");
            var reordered = CanvasPacking.PackStable(positioned.Reverse().ToArray(), [], compact: true);
            Check(packed.All(pair => reordered[pair.Key] == pair.Value), "Square compaction depends on input order.");
        }

        // A tall rectangle and two short ones have a known feasible 1296x976
        // arrangement. A row-only shelf wastes the space below its short neighbor.
        var holeFill = new[] { new PackingItem("tall", 640, 976), new PackingItem("short-a", 640, 480), new PackingItem("short-b", 640, 480) };
        AssertCompactEnvelope(holeFill, 1296, 976, "Mixed-height compaction left a reusable interior hole.");
        var mixedWidths = new[] { new PackingItem("wide", 1280, 320), new PackingItem("left", 624, 640), new PackingItem("right", 640, 640) };
        AssertCompactEnvelope(mixedWidths, 1280, 976, "Mixed-width compaction wasted a feasible rectangular grouping.");

        var squares = Enumerable.Range(0, 9).Select(i => new PackingItem("locked-case-" + i, 480, 480)).ToArray();
        var distant = new[] { new PackingRect(9_000_000, 8_000_000, 1600, 900), new PackingRect(-8_000_000, 9_000_000, 900, 1200), new PackingRect(7_000_000, -9_000_000, 600, 700), new PackingRect(-9_000_000, -8_000_000, 1200, 900) };
        var fixedBefore = distant.ToArray();
        var basePack = CanvasPacking.PackStable(PriorPositions(squares), [], compact: true);
        var withDistant = CanvasPacking.PackStable(PriorPositions(squares), distant, compact: true);
        Verify(squares, distant, withDistant);
        var baselineBounds = Bounds(basePack.Values); var distantBounds = Bounds(withDistant.Values);
        Check(distantBounds.Width <= baselineBounds.Width * 1.05 && distantBounds.Height <= baselineBounds.Height * 1.05, "Distant locked obstacles stretched the movable group.");
        Check(distant.SequenceEqual(fixedBefore), "Compaction changed a distant locked obstacle.");

        // Nearby fixed geometry must retain its full clearance while movable
        // cards can still make a compact group in the remaining free space.
        var nearby = new[] { new PackingRect(496, 0, 480, 480), new PackingRect(-496, 496, 480, 480) };
        var nearbyBefore = nearby.ToArray();
        var compactWithHoles = CanvasPacking.PackStable(PriorPositions(squares.Take(8).ToArray()), nearby, compact: true);
        Verify(squares.Take(8).ToArray(), nearby, compactWithHoles);
        Check(nearby.SequenceEqual(nearbyBefore), "Compaction moved a nearby fixed rectangle.");
        var reorderedObstacles = CanvasPacking.PackStable(PriorPositions(squares.Take(8).ToArray()).Reverse().ToArray(), nearby.Reverse().ToArray(), compact: true);
        Check(compactWithHoles.All(pair => reorderedObstacles[pair.Key] == pair.Value), "Compaction with fixed holes depends on input order.");

        var prior = PriorPositions(holeFill);
        var translated = prior.Select(item => item with { X = item.X - 4_000_000, Y = item.Y + 3_000_000 }).ToArray();
        var first = CanvasPacking.PackStable(prior, distant, compact: true);
        var second = CanvasPacking.PackStable(translated, distant, compact: true);
        VerifyStable(translated, distant, second);
        Check(first.All(pair => second[pair.Key] == pair.Value), "Explicit compaction retained previous far coordinates or removal holes.");

        var aspectItems = Enumerable.Range(0, 16).Select(i => new PackingItem("aspect-" + i, 320, 320)).ToArray();
        var aspectPositions = PriorPositions(aspectItems);
        var wide = CanvasPacking.PackStable(aspectPositions, [], aspectRatio: 4, compact: true);
        var portrait = CanvasPacking.PackStable(aspectPositions, [], aspectRatio: .25, compact: true);
        Verify(aspectItems, [], wide); Verify(aspectItems, [], portrait);
        var wideBounds = Bounds(wide.Values); var portraitBounds = Bounds(portrait.Values);
        Check(wideBounds.Width / wideBounds.Height >= 2.5, "Explicit wide aspect override was ignored.");
        Check(portraitBounds.Height / portraitBounds.Width >= 2.5, "Explicit portrait aspect override was ignored.");
        Console.WriteLine("Square-target compaction: equal squares, mixed dimensions/interior hole, locked obstacles, prior-position independence and aspect overrides (synthetic geometry only).");
    }

    private static PositionedPackingItem[] PriorPositions(IReadOnlyList<PackingItem> items) => items.Select((item, index) =>
        new PositionedPackingItem(item.Id, index % 5 * 100_000 - 200_000, index / 5 * 100_000 + 400_000, item.Width, item.Height, index + 1)).ToArray();

    private static PackingRect Bounds(IEnumerable<PackingRect> rectangles)
    {
        var values = rectangles.ToArray();
        var left = values.Min(rect => rect.X); var top = values.Min(rect => rect.Y);
        return new(left, top, values.Max(rect => rect.X + rect.Width) - left, values.Max(rect => rect.Y + rect.Height) - top);
    }

    private static void AssertCompactEnvelope(PackingItem[] items, double feasibleWidth, double feasibleHeight, string message)
    {
        var packed = CanvasPacking.PackStable(PriorPositions(items), [], compact: true);
        Verify(items, [], packed);
        var bounds = Bounds(packed.Values);
        Check(bounds.Width * bounds.Height <= feasibleWidth * feasibleHeight * 1.10 && Math.Max(bounds.Width, bounds.Height) <= Math.Max(feasibleWidth, feasibleHeight) * 1.10, message);
    }

    private static void StableContracts()
    {
        var older = new[] {
            new PositionedPackingItem("oldest", 0, 0, 480, 420, 1),
            new PositionedPackingItem("older", 992, 0, 480, 420, 2),
            new PositionedPackingItem("arrival", 0, 0, 480, 420, 3, false)
        };
        var stable = CanvasPacking.PackStable(older, []);
        Check(stable["oldest"] == new PackingRect(0, 0, 480, 420) && stable["older"] == new PackingRect(992, 0, 480, 420), "An arrival moved an older valid card.");
        Check(stable["arrival"] == new PackingRect(496, 0, 480, 420), "The arrival did not fill the existing side gap.");
        VerifyStable(older, [], stable);
        var compact = CanvasPacking.PackStable(older.Take(2).ToArray(), [], compact: true);
        Check(compact["oldest"].X == 0 && compact["oldest"].Y == 0 && compact["older"].X < 992, "Explicit compaction retained the removal hole.");
        VerifyStable(older.Take(2).ToArray(), [], compact);
        var collision = new[] {
            new PositionedPackingItem("newer", 0, 0, 700, 600, 20),
            new PositionedPackingItem("oldest", 0, 0, 800, 500, 10),
            new PositionedPackingItem("manual-size", 5000, -1000, 1234, 987, 30)
        };
        var fixedRects = new[] { new PackingRect(1000, 0, 400, 500), new PackingRect(-400, -400, 300, 300) };
        var original = fixedRects.ToArray();
        var repaired = CanvasPacking.PackStable(collision, fixedRects);
        Check(repaired["oldest"] == new PackingRect(0, 0, 800, 500), "Overlap repair did not preserve the oldest card.");
        Check(repaired["manual-size"] == new PackingRect(5000, -1000, 1234, 987), "Stable packing changed manual geometry.");
        VerifyStable(collision, fixedRects, repaired);
        Check(fixedRects.SequenceEqual(original), "Stable packing moved a fixed obstacle.");
        foreach (var shouldCompact in new[] { false, true })
        {
            var expected = CanvasPacking.PackStable(collision, fixedRects, compact: shouldCompact);
            var permuted = CanvasPacking.PackStable(collision.Reverse().ToArray(), fixedRects.Reverse().ToArray(), compact: shouldCompact);
            Check(expected.All(p => permuted[p.Key] == p.Value), "Stable packing depends on input order.");
            VerifyStable(collision, fixedRects, expected);
        }
        var ties = new[] { new PositionedPackingItem("b", 0, 0, 480, 420, 1), new PositionedPackingItem("a", 0, 0, 480, 420, 1) };
        Check(CanvasPacking.PackStable(ties, [])["a"] == new PackingRect(0, 0, 480, 420), "Equal-age overlap repair ignored deterministic ID ordering.");
        Check(CanvasPacking.PackStable([], []).Count == 0, "Empty stable pack was not empty.");
        Throws(() => CanvasPacking.PackStable([new("bad", double.NaN, 0, 480, 420, 1)], []), 400);
        Throws(() => CanvasPacking.PackStable([new("same", 0, 0, 480, 420, 1), new("same", 0, 0, 480, 420, 2)], []), 400);
        var many = Enumerable.Range(0, 1000).Select(i => new PackingItem("stable-load-" + i, 320 + i % 11 * 120, 320 + i % 9 * 150)).ToArray();
        var initial = CanvasPacking.Pack(many, fixedRects);
        var positioned = many.Select((item, i) => new PositionedPackingItem(item.Id, initial[item.Id].X, initial[item.Id].Y, item.Width, item.Height, i, i != many.Length - 1)).ToArray();
        var watch = Stopwatch.StartNew(); var arrivalLoad = CanvasPacking.PackStable(positioned, fixedRects); watch.Stop();
        VerifyStable(positioned, fixedRects, arrivalLoad);
        Check(positioned.Take(999).All(i => arrivalLoad[i.Id] == initial[i.Id]), "Large arrival pass moved an older valid card.");
        Console.WriteLine($"Stable packing arrival: {positioned.Length} items, {fixedRects.Length} obstacles, {watch.Elapsed.TotalMilliseconds:F2} ms (synthetic).");
        watch.Restart(); var compactLoad = CanvasPacking.PackStable(positioned, fixedRects, compact: true); watch.Stop();
        VerifyStable(positioned, fixedRects, compactLoad);
        Console.WriteLine($"Stable packing compaction: {positioned.Length} items, {fixedRects.Length} obstacles, {watch.Elapsed.TotalMilliseconds:F2} ms (synthetic).");
    }

    private static void VerifyStable(IReadOnlyList<PositionedPackingItem> items, IReadOnlyList<PackingRect> obstacles, Dictionary<string, PackingRect> packed) =>
        Verify(items.Select(i => new PackingItem(i.Id, i.Width, i.Height)).ToArray(), obstacles, packed);

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
