namespace AgenticView.Server;

public readonly record struct PackingRect(double X, double Y, double Width, double Height);
public readonly record struct PackingItem(string Id, double Width, double Height);
public readonly record struct PositionedPackingItem(string Id, double X, double Y, double Width, double Height, long Age, bool PreferExisting = true);

/// <summary>Deterministic shelf packing; fixed rectangles reserve space without being moved.</summary>
public static class CanvasPacking
{
    private const double Gap = 16, Bound = 1e7;

    public static Dictionary<string, PackingRect> Pack(IReadOnlyList<PackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio = 1.6)
    {
        if (obstacles.Count > 2000) throw new HubError(400, "Too many fixed packing obstacles.");
        return PackCore(items, obstacles, aspectRatio);
    }

    /// <summary>Preserve valid older positions on arrivals; explicit compaction repacks every movable item.</summary>
    public static Dictionary<string, PackingRect> PackStable(IReadOnlyList<PositionedPackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio = 1.6, bool compact = false)
    {
        if (obstacles.Count > 2000) throw new HubError(400, "Too many fixed packing obstacles.");
        var dimensions = items.Select(i => new PackingItem(i.Id, i.Width, i.Height)).ToArray();
        Validate(dimensions, obstacles, aspectRatio);
        foreach (var item in items)
            if (!double.IsFinite(item.X) || !double.IsFinite(item.Y) || Math.Abs(item.X) > Bound || Math.Abs(item.Y) > Bound)
                throw new HubError(400, "Existing packing positions must be finite and within canvas bounds.");
        var result = new Dictionary<string, PackingRect>(StringComparer.Ordinal);
        var fixedRects = new List<PackingRect>(obstacles);
        var pending = new List<PackingItem>();
        var ages = items.ToDictionary(i => i.Id, i => i.Age, StringComparer.Ordinal);
        foreach (var item in items.OrderBy(i => i.Age).ThenBy(i => i.Id, StringComparer.Ordinal))
        {
            var existing = new PackingRect(item.X, item.Y, item.Width, item.Height);
            if (!compact && item.PreferExisting && !fixedRects.Any(r => Overlaps(existing, r)))
            {
                result.Add(item.Id, existing);
                fixedRects.Add(existing);
            }
            else pending.Add(new(item.Id, item.Width, item.Height));
        }
        if (pending.Count == 0) return result;
        // Include preserved cards in the area budget: sizing from only the arrival collapses the
        // shelf to one card wide and needlessly sends it below every older card.
        var area = dimensions.Sum(i => (i.Width + Gap) * (i.Height + Gap));
        var width = Math.Max(dimensions.Max(i => i.Width), Math.Min(Bound, Math.Sqrt(area) * Math.Sqrt(aspectRatio)));
        // Existing/fixed footprints expose interior horizontal gaps, even when the ideal area
        // width is narrower. Ignore unbounded right edges; the bounded search handles blockers.
        foreach (var rect in fixedRects)
            if (rect.X + rect.Width > 0 && rect.X + rect.Width <= Bound) width = Math.Max(width, rect.X + rect.Width);
        foreach (var pair in PackCore(pending, fixedRects, aspectRatio, width, ages)) result.Add(pair.Key, pair.Value);
        return result;
    }

    private static void Validate(IReadOnlyList<PackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio)
    {
        if (items.Count > 2000 || obstacles.Count > 4000 || !double.IsFinite(aspectRatio) || aspectRatio <= 0)
            throw new HubError(400, "Invalid packing bounds or aspect ratio.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
            if (string.IsNullOrEmpty(item.Id) || !ids.Add(item.Id) || !Dimension(item.Width, 320, 1600) || !Dimension(item.Height, 240, 100000))
                throw new HubError(400, "Packing items require unique identifiers, widths from 320 to 1600 and heights from 240 to 100000.");
        foreach (var obstacle in obstacles)
            if (!double.IsFinite(obstacle.X) || !double.IsFinite(obstacle.Y) || !double.IsFinite(obstacle.Width) || !double.IsFinite(obstacle.Height) || obstacle.Width <= 0 || obstacle.Height <= 0 || Math.Abs(obstacle.X) > Bound || Math.Abs(obstacle.Y) > Bound || !double.IsFinite(obstacle.X + obstacle.Width) || !double.IsFinite(obstacle.Y + obstacle.Height))
                throw new HubError(400, "Packing obstacles require finite positive geometry within canvas bounds.");
    }

    private static Dictionary<string, PackingRect> PackCore(IReadOnlyList<PackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio, double? shelfWidth = null, IReadOnlyDictionary<string, long>? ages = null)
    {
        Validate(items, obstacles, aspectRatio);
        var result = new Dictionary<string, PackingRect>(StringComparer.Ordinal);
        if (items.Count == 0) return result;
        var ordered = items.OrderByDescending(i => i.Height).ThenByDescending(i => i.Width).ThenBy(i => ages is null ? 0 : ages[i.Id]).ThenBy(i => i.Id, StringComparer.Ordinal).ToArray();
        var fixedRects = obstacles.OrderBy(r => r.X).ThenBy(r => r.Y).ThenBy(r => r.Width).ThenBy(r => r.Height).ToArray();
        var area = ordered.Sum(i => (i.Width + Gap) * (i.Height + Gap));
        var width = shelfWidth ?? Math.Max(ordered.Max(i => i.Width), Math.Min(Bound, Math.Sqrt(area) * Math.Sqrt(aspectRatio)));
        var index = 0; var y = 0.0;
        // Every iteration places an item or passes an obstacle's lower edge: at most n+m shelves.
        for (var pass = 0; index < ordered.Length && pass <= ordered.Length + fixedRects.Length; pass++)
        {
            var height = ordered[index].Height;
            if (y > Bound) throw new HubError(409, "No packing position within canvas bounds.");
            var spans = new List<(double Start, double End)>(); var start = 0.0; var nextEdge = double.PositiveInfinity;
            foreach (var obstacle in fixedRects)
            {
                if (obstacle.X - Gap >= width) break;
                if (obstacle.X + obstacle.Width + Gap <= 0 || y >= obstacle.Y + obstacle.Height + Gap || y + height + Gap <= obstacle.Y) continue;
                nextEdge = Math.Min(nextEdge, obstacle.Y + obstacle.Height + Gap);
                var left = Math.Max(0, obstacle.X - Gap); var right = Math.Min(width, obstacle.X + obstacle.Width + Gap);
                if (left > start) spans.Add((start, left));
                start = Math.Max(start, right);
            }
            if (start < width) spans.Add((start, width));
            var before = index;
            foreach (var span in spans)
            {
                var x = span.Start;
                while (index < ordered.Length && x + ordered[index].Width <= span.End)
                {
                    var item = ordered[index++]; result.Add(item.Id, new PackingRect(x, y, item.Width, item.Height)); x += item.Width + Gap;
                }
                if (index == ordered.Length) break;
            }
            if (index > before) y += height + Gap;
            else if (double.IsFinite(nextEdge) && nextEdge > y) y = nextEdge;
            else throw new HubError(409, "No packing position within canvas bounds.");
        }
        if (index != ordered.Length) throw new HubError(409, "Packing search budget exhausted.");
        return result;
    }

    private static bool Dimension(double value, double minimum, double maximum) => double.IsFinite(value) && value >= minimum && value <= maximum;
    private static bool Overlaps(PackingRect a, PackingRect b) => a.X < b.X + b.Width + Gap && a.X + a.Width + Gap > b.X && a.Y < b.Y + b.Height + Gap && a.Y + a.Height + Gap > b.Y;
}
