namespace AgenticView.Server;

public readonly record struct PackingRect(double X, double Y, double Width, double Height);
public readonly record struct PackingItem(string Id, double Width, double Height);

/// <summary>Deterministic shelf packing; fixed rectangles reserve space without being moved.</summary>
public static class CanvasPacking
{
    private const double Gap = 16, Bound = 1e7;

    public static Dictionary<string, PackingRect> Pack(IReadOnlyList<PackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio = 1.6)
    {
        if (items.Count > 2000 || obstacles.Count > 2000 || !double.IsFinite(aspectRatio) || aspectRatio <= 0)
            throw new HubError(400, "Invalid packing bounds or aspect ratio.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
            if (string.IsNullOrEmpty(item.Id) || !ids.Add(item.Id) || !Dimension(item.Width, 320) || !Dimension(item.Height, 240))
                throw new HubError(400, "Packing items require unique identifiers, widths from 320 to 1600 and heights from 240 to 1600.");
        foreach (var obstacle in obstacles)
            if (!double.IsFinite(obstacle.X) || !double.IsFinite(obstacle.Y) || !double.IsFinite(obstacle.Width) || !double.IsFinite(obstacle.Height) || obstacle.Width <= 0 || obstacle.Height <= 0 || Math.Abs(obstacle.X) > Bound || Math.Abs(obstacle.Y) > Bound || !double.IsFinite(obstacle.X + obstacle.Width) || !double.IsFinite(obstacle.Y + obstacle.Height))
                throw new HubError(400, "Packing obstacles require finite positive geometry within canvas bounds.");
        var result = new Dictionary<string, PackingRect>(StringComparer.Ordinal);
        if (items.Count == 0) return result;
        var ordered = items.OrderByDescending(i => i.Height).ThenByDescending(i => i.Width).ThenBy(i => i.Id, StringComparer.Ordinal).ToArray();
        var fixedRects = obstacles.OrderBy(r => r.X).ThenBy(r => r.Y).ThenBy(r => r.Width).ThenBy(r => r.Height).ToArray();
        var area = ordered.Sum(i => (i.Width + Gap) * (i.Height + Gap));
        var width = Math.Max(ordered.Max(i => i.Width), Math.Min(Bound, Math.Sqrt(area) * Math.Sqrt(aspectRatio)));
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

    private static bool Dimension(double value, double minimum) => double.IsFinite(value) && value >= minimum && value <= 1600;
}
