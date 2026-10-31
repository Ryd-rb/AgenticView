using System.Text.Json;

namespace AgenticView.Desktop;

public sealed class BridgePolicy(Uri document, string? cardId = null, string? focusCardId = null)
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
        JsonSerializer.Serialize(document.AbsolutePath) + "&&location.search===''){Object.defineProperty(window,'agenticViewDesktop',{value:Object.freeze({version:1,platform:'windows',popOut:true,cardId:"+JsonSerializer.Serialize(cardId)+",focusCardId:"+JsonSerializer.Serialize(focusCardId)+"}),writable:false,configurable:false});}";

    public bool TryReadPopOut(string source,string currentSource,string json,out string requestId,out string targetId,out string title)
    {
        requestId="";targetId="";title="";
        if(!IsTrustedDocument(source)||!IsTrustedDocument(currentSource)||json.Length>1024)return false;
        try{
            using var message=JsonDocument.Parse(json,new JsonDocumentOptions{MaxDepth=3});var root=message.RootElement;
            if(root.ValueKind!=JsonValueKind.Object||root.EnumerateObject().Count()!=4||!root.TryGetProperty("type",out var type)||type.GetString()!="agenticview:popout"||!root.TryGetProperty("requestId",out var request)||request.ValueKind!=JsonValueKind.String||!Guid.TryParseExact(request.GetString(),"D",out _)||!root.TryGetProperty("cardId",out var id)||id.ValueKind!=JsonValueKind.String||!root.TryGetProperty("title",out var name)||name.ValueKind!=JsonValueKind.String)return false;
            requestId=request.GetString()!;targetId=CardWindowSpec.ValidateId(id.GetString()!);title=CardWindowSpec.ValidateName(name.GetString()!);return true;
        }catch(JsonException){return false;}catch(InvalidOperationException){return false;}catch(ArgumentException){return false;}
    }

    public bool TryReadInputTrace(string source, string currentSource, string json, out string trace)
    {
        trace = "";
        if (!IsTrustedDocument(source) || !IsTrustedDocument(currentSource) || json.Length > 2048) return false;
        try
        {
            using var message = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 3 }); var root = message.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 3 ||
                !root.TryGetProperty("type", out var type) || type.GetString() != "agenticview:input-trace" ||
                !root.TryGetProperty("phase", out var phase) || phase.ValueKind != JsonValueKind.String ||
                phase.GetString() is not ("pointer" or "down" or "move" or "route" or "clear" or "navigation" or "blur" or "inactive" or "unmount" or "geometry") ||
                !root.TryGetProperty("values", out var values) || values.ValueKind != JsonValueKind.Array || values.GetArrayLength() > 32) return false;
            foreach (var value in values.EnumerateArray()) if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number) || Math.Abs(number) > 1e12) return false;
            trace = root.GetRawText(); return true;
        }
        catch (JsonException) { return false; }
        catch (InvalidOperationException) { return false; }
    }
}
