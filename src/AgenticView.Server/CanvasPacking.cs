namespace AgenticView.Server;

public readonly record struct PackingRect(double X, double Y, double Width, double Height);
public readonly record struct PackingItem(string Id, double Width, double Height);
public readonly record struct PositionedPackingItem(string Id, double X, double Y, double Width, double Height, long Age, bool PreferExisting = true);

/// <summary>Bounded deterministic bin packing; stable arrivals preserve established positions.</summary>
public static class CanvasPacking
{
    private const double Gap = 16, Bound = 1e7;

    public static Dictionary<string, PackingRect> Pack(IReadOnlyList<PackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio = 1)
    {
        if (obstacles.Count > 2000) throw new HubError(400, "Too many fixed packing obstacles.");
        Validate(items, obstacles, aspectRatio);
        return PackCompact(items, obstacles, aspectRatio);
    }

    /// <summary>Preserve valid older positions on arrivals; explicit compaction repacks every movable item.</summary>
    public static Dictionary<string, PackingRect> PackStable(IReadOnlyList<PositionedPackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio = 1, bool compact = false)
    {
        if (obstacles.Count > 2000) throw new HubError(400, "Too many fixed packing obstacles.");
        var dimensions = items.Select(i => new PackingItem(i.Id, i.Width, i.Height)).ToArray();
        Validate(dimensions, obstacles, aspectRatio);
        foreach (var item in items)
            if (!double.IsFinite(item.X) || !double.IsFinite(item.Y) || Math.Abs(item.X) > Bound || Math.Abs(item.Y) > Bound)
                throw new HubError(400, "Existing packing positions must be finite and within canvas bounds.");
        if (compact) return PackCompact(dimensions, obstacles, aspectRatio, items.ToDictionary(i => i.Id, i => i.Age, StringComparer.Ordinal));
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

    private static Dictionary<string, PackingRect> PackCompact(IReadOnlyList<PackingItem> items, IReadOnlyList<PackingRect> obstacles, double aspectRatio, IReadOnlyDictionary<string,long>? ages = null)
    {
        if (items.Count == 0) return new(StringComparer.Ordinal);
        var ordered = items.OrderByDescending(i => Math.Max(i.Width,i.Height)).ThenByDescending(i => i.Width*i.Height).ThenBy(i => ages is null ? 0 : ages[i.Id]).ThenBy(i => i.Id,StringComparer.Ordinal).ToArray();
        var area = ordered.Sum(i => (i.Width+Gap)*(i.Height+Gap));
        var ratio = Math.Sqrt(aspectRatio);
        var side = Math.Max(Math.Sqrt(area),Math.Max(ordered.Max(i => i.Width)/ratio,ordered.Max(i => i.Height)*ratio));
        var fixedRects = obstacles.OrderBy(r=>r.X).ThenBy(r=>r.Y).ThenBy(r=>r.Width).ThenBy(r=>r.Height).ToArray();
        Dictionary<string,PackingRect>? best = null;
        (double Side,double Area,double Distance,double Width) bestScore = (double.PositiveInfinity,0,0,0);
        void Consider(Dictionary<string,PackingRect> candidate)
        {
            var left=candidate.Values.Min(r=>r.X);var top=candidate.Values.Min(r=>r.Y);
            var width=candidate.Values.Max(r=>r.X+r.Width)-left;var height=candidate.Values.Max(r=>r.Y+r.Height)-top;
            var score=(Math.Max(width/ratio,height*ratio),width*height,left*left+top*top,width);
            if(score.CompareTo(bestScore)<0){best=candidate;bestScore=score;}
        }
        // MaxRects fills holes between unequal cards. Trials and geometry work are bounded;
        // the shelf alternatives retain a predictable fallback for dense fixed obstacles.
        foreach(var scale in new[]{1.0,1.12,1.3,1.6,2.1,3.0})
        {
            var width=Math.Min(Bound,side*ratio*scale);var height=Math.Min(Bound,side/ratio*scale);
            var candidate=TryBin(ordered,fixedRects,width,height,ratio);
            if(candidate is not null){Consider(candidate);break;}
        }
        var idealWidth=Math.Sqrt(area)*ratio;var minimum=ordered.Max(i=>i.Width);
        foreach(var width in new[]{.75,.9,1,1.15,1.35,1.65,2.1}.Select(scale=>Math.Max(minimum,Math.Min(Bound,idealWidth*scale))).Distinct())
        {
            try{Consider(PackCore(ordered,fixedRects,aspectRatio,width,ages));}catch(HubError error) when(error.Status==409){ /* Another bounded width may clear the blocker. */ }
        }
        return best??throw new HubError(409,"No packing position within canvas bounds.");
    }

    private static Dictionary<string,PackingRect>? TryBin(IReadOnlyList<PackingItem> items,IReadOnlyList<PackingRect> obstacles,double width,double height,double ratio)
    {
        const int workLimit=2_000_000;
        var work=0;var free=new List<PackingRect>{new(0,0,width+Gap,height+Gap)};
        bool Contains(PackingRect outer,PackingRect inner)=>inner.X>=outer.X&&inner.Y>=outer.Y&&inner.X+inner.Width<=outer.X+outer.Width&&inner.Y+inner.Height<=outer.Y+outer.Height;
        bool Subtract(PackingRect used)
        {
            var next=new List<PackingRect>(free.Count+4);var added=new List<PackingRect>();
            foreach(var space in free)
            {
                if(++work>workLimit)return false;
                if(space.X>=used.X+used.Width||space.X+space.Width<=used.X||space.Y>=used.Y+used.Height||space.Y+space.Height<=used.Y){next.Add(space);continue;}
                if(used.X>space.X)added.Add(new(space.X,space.Y,used.X-space.X,space.Height));
                if(used.X+used.Width<space.X+space.Width)added.Add(new(used.X+used.Width,space.Y,space.X+space.Width-used.X-used.Width,space.Height));
                if(used.Y>space.Y)added.Add(new(space.X,space.Y,space.Width,used.Y-space.Y));
                if(used.Y+used.Height<space.Y+space.Height)added.Add(new(space.X,used.Y+used.Height,space.Width,space.Y+space.Height-used.Y-used.Height));
            }
            foreach(var rectangle in added)
            {
                var contained=false;
                for(var i=next.Count-1;i>=0;i--){if(++work>workLimit)return false;if(Contains(next[i],rectangle)){contained=true;break;}if(Contains(rectangle,next[i]))next.RemoveAt(i);}
                if(!contained&&rectangle.Width>0&&rectangle.Height>0)next.Add(rectangle);
            }
            free=next;return free.Count<=4096;
        }
        foreach(var obstacle in obstacles)if(!Subtract(new(obstacle.X,obstacle.Y,obstacle.Width+Gap,obstacle.Height+Gap)))return null;
        var result=new Dictionary<string,PackingRect>(StringComparer.Ordinal);
        var left=double.PositiveInfinity;var top=double.PositiveInfinity;var right=double.NegativeInfinity;var bottom=double.NegativeInfinity;
        foreach(var item in items)
        {
            var w=item.Width+Gap;var h=item.Height+Gap;PackingRect? chosen=null;
            (double Side,double Area,double Short,double Long,double Y,double X) score=(double.PositiveInfinity,0,0,0,0,0);
            foreach(var space in free)
            {
                if(++work>workLimit)return null;
                if(w>space.Width||h>space.Height)continue;
                var groupWidth=Math.Max(right,space.X+item.Width)-Math.Min(left,space.X);var groupHeight=Math.Max(bottom,space.Y+item.Height)-Math.Min(top,space.Y);
                var candidate=(Math.Max(groupWidth/ratio,groupHeight*ratio),groupWidth*groupHeight,Math.Min(space.Width-w,space.Height-h),Math.Max(space.Width-w,space.Height-h),space.Y,space.X);
                if(candidate.CompareTo(score)<0){chosen=space;score=candidate;}
            }
            if(chosen is not {} at)return null;
            result.Add(item.Id,new(at.X,at.Y,item.Width,item.Height));
            left=Math.Min(left,at.X);top=Math.Min(top,at.Y);right=Math.Max(right,at.X+item.Width);bottom=Math.Max(bottom,at.Y+item.Height);
            if(!Subtract(new(at.X,at.Y,w,h)))return null;
        }
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
