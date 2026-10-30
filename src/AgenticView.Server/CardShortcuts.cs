using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static AgenticView.Server.ComponentValidator;

namespace AgenticView.Server;

public static class CardShortcuts
{
    private static readonly string[] ModifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];
    private static readonly string[] Keys = ["Enter", "Escape", "Space", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    public static string? NormalizeChord(string chord)
    {
        if (chord.Length is < 1 or > 80) return null;
        var parts = chord.Split('+').Select(part => part.Trim()).ToArray();
        if (parts.Any(part => part.Length == 0)) return null;
        var rawKey = parts[^1]; var key = Regex.IsMatch(rawKey, "^(?:[a-zA-Z0-9]|[fF](?:[1-9]|1[0-2]))$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking) ? rawKey.ToUpperInvariant() : Keys.FirstOrDefault(candidate => candidate.Equals(rawKey, StringComparison.OrdinalIgnoreCase));
        if (key is null) return null;
        var selected = new HashSet<string>(StringComparer.Ordinal);
        foreach (var token in parts[..^1])
        {
            var modifier = token.ToLowerInvariant() switch { "ctrl" or "control" => "Ctrl", "alt" or "option" => "Alt", "shift" => "Shift", "meta" or "cmd" or "command" => "Meta", _ => null };
            if (modifier is null || !selected.Add(modifier)) return null;
        }
        if (!selected.Contains("Ctrl") && !selected.Contains("Alt") && !selected.Contains("Meta") && !Regex.IsMatch(key, "^F\\d+$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking)) return null;
        return string.Join('+', ModifierOrder.Where(selected.Contains).Append(key));
    }
    /// <summary>Normalizes validated settings in place; targets may temporarily be offline.</summary>
    public static void Validate(JsonNode? node)
    {
        var items = node as JsonArray ?? throw new HubError(400, "cardShortcuts must be an array.");
        if (items.Count > 32) Fail("At most 32 card shortcuts are permitted.");
        var ids = new HashSet<string>(StringComparer.Ordinal); var chords = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in items)
        {
            var shortcut = Object(entry, "shortcut");
            if (shortcut.Any(pair => !new[] { "id", "label", "cardId", "chord", "mode" }.Contains(pair.Key, StringComparer.Ordinal))) Fail("Unknown card shortcut property.");
            if (!ids.Add(Id(shortcut, "id"))) Fail("Shortcut IDs must be unique."); Id(shortcut, "cardId");
            var label = Text(shortcut, "label", 160, true, 1).Trim(); if (label.Length == 0) Fail("Shortcut label must not be empty.");
            var chord = NormalizeChord(Text(shortcut, "chord", 80, true, 1)); if (chord is null) Fail("Use a supported card shortcut chord.");
            if (!chords.Add(chord!)) Fail("Shortcut chords must be unique.");
            Choice(shortcut, "mode", ["focus", "maximize"]); shortcut["label"] = label; shortcut["chord"] = chord;
        }
    }
}
