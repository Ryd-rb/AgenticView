using System.Text.Json;

namespace AgenticView.Desktop;

public sealed class BridgePolicy(Uri document)
{
    public bool IsTrustedDocument(string source) => Uri.TryCreate(source, UriKind.Absolute, out var candidate) &&
        candidate.Scheme == document.Scheme && candidate.IdnHost == document.IdnHost && candidate.Port == document.Port &&
        candidate.AbsolutePath == document.AbsolutePath && candidate.UserInfo.Length == 0 && candidate.Query.Length == 0;

    // CoreWebView2.WebMessageReceived is the main-frame event. Frame events are deliberately never subscribed.
    public bool TryReadAction(string source, string currentSource, string json, out string action)
    {
        action = "";
        if (!IsTrustedDocument(source) || !IsTrustedDocument(currentSource) || json.Length > 256) return false;
        try
        {
            using var message = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 3 });
            var root = message.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
                !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "agenticview:window" ||
                !root.TryGetProperty("action", out var command) || command.ValueKind != JsonValueKind.String) return false;
            var value = command.GetString();
            if (value is not ("minimize" or "maximize" or "close" or "drag" or "fullscreen")) return false;
            action = value;
            return true;
        }
        catch (JsonException) { return false; }
    }

    public string InitializationScript => "if(window===window.top&&location.origin===" +
        JsonSerializer.Serialize(document.GetLeftPart(UriPartial.Authority)) + "&&location.pathname===" +
        JsonSerializer.Serialize(document.AbsolutePath) + "&&location.search===''){Object.defineProperty(window,'agenticViewDesktop',{value:Object.freeze({version:1,platform:'windows'}),writable:false,configurable:false});}";
}
