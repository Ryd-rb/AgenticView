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
        JsonSerializer.Serialize(document.AbsolutePath) + "&&location.search===''){Object.defineProperty(window,'agenticViewDesktop',{value:Object.freeze({version:1,platform:'windows',popOut:true,windowIcons:true,debugging:true,nativeDebugControl:true,backgroundTesting:true,cardId:"+JsonSerializer.Serialize(cardId)+",focusCardId:"+JsonSerializer.Serialize(focusCardId)+"}),writable:false,configurable:false});}";

    public bool TryReadDebugClient(string source,string currentSource,string json,out NativeDebugRegistration registration)
    {
        registration=new("","",[]);if(!IsTrustedDocument(source)||!IsTrustedDocument(currentSource)||json.Length>65536)return false;
        try{using var doc=JsonDocument.Parse(json,new JsonDocumentOptions{MaxDepth=4});var root=doc.RootElement;
            if(root.ValueKind!=JsonValueKind.Object||root.EnumerateObject().Count()!=4||root.EnumerateObject().Select(x=>x.Name).Distinct().Count()!=4||root.EnumerateObject().Any(x=>x.Name is not("type" or "clientId" or "clientToken" or "cardIds"))||root.GetProperty("type").GetString()!="agenticview:debug-client")return false;
            var id=root.GetProperty("clientId").GetString();var proof=root.GetProperty("clientToken").GetString();if(!Guid.TryParseExact(id,"D",out _)||proof is null||proof.Length is <32 or >256||proof.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c is not('-' or '_')))return false;
            var ids=root.GetProperty("cardIds");if(ids.ValueKind!=JsonValueKind.Array||ids.GetArrayLength()>512)return false;var seen=new HashSet<string>();
            foreach(var item in ids.EnumerateArray()){if(item.ValueKind!=JsonValueKind.String||item.GetString() is not{} value||value.Length is <1 or >100||value.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c is not('_' or '.' or ':' or '-'))||value is "__proto__" or "prototype" or "constructor"||!seen.Add(value))return false;}
            registration=new(id!,proof,seen.ToArray());return true;
        }catch(Exception error)when(error is JsonException or InvalidOperationException or KeyNotFoundException){return false;}
    }
    public bool TryReadDebugStop(string source,string currentSource,string json,out string clientId)
    {
        clientId="";if(!IsTrustedDocument(source)||!IsTrustedDocument(currentSource)||json.Length>256)return false;
        try{using var doc=JsonDocument.Parse(json);var root=doc.RootElement;if(root.ValueKind!=JsonValueKind.Object||root.EnumerateObject().Count()!=2||root.GetProperty("type").GetString()!="agenticview:debug-client-stop"||!Guid.TryParseExact(root.GetProperty("clientId").GetString(),"D",out var id))return false;clientId=id.ToString();return true;}catch(Exception error)when(error is JsonException or InvalidOperationException or KeyNotFoundException){return false;}
    }

    public bool TryReadDiagnostic(string source,string currentSource,string json,out string id,out string operation,out int seconds)
    {
        id="";operation="";seconds=5;
        if(!IsTrustedDocument(source)||!IsTrustedDocument(currentSource)||json.Length>512)return false;
        try{
            using var message=JsonDocument.Parse(json,new JsonDocumentOptions{MaxDepth=3});var root=message.RootElement;
            if(root.ValueKind!=JsonValueKind.Object)return false;var fields=root.EnumerateObject().ToArray();
            if(fields.Length is <3 or >4||fields.Select(p=>p.Name).Distinct(StringComparer.Ordinal).Count()!=fields.Length||fields.Any(p=>p.Name is not ("type" or "requestId" or "operation" or "durationSeconds")))return false;
            if(!root.TryGetProperty("type",out var type)||type.GetString()!="agenticview:debug-native"||!root.TryGetProperty("requestId",out var request)||!Guid.TryParseExact(request.GetString(),"D",out _))return false;
            if(!root.TryGetProperty("operation",out var op)||op.GetString() is not ("metrics" or "profile" or "layers"))return false;
            if(root.TryGetProperty("durationSeconds",out var duration)&&(!duration.TryGetInt32(out seconds)||seconds is <1 or >30))return false;
            id=request.GetString()!;operation=op.GetString()!;return true;
        }catch(JsonException){return false;}catch(InvalidOperationException){return false;}
    }

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

    public bool TryReadWindowIcon(string source,string currentSource,string json,out string requestId,out WindowIconSpec? spec)
    {
        requestId="";spec=null;if(cardId is null||!IsTrustedDocument(source)||!IsTrustedDocument(currentSource)||json.Length>1024)return false;
        try{using var message=JsonDocument.Parse(json,new JsonDocumentOptions{MaxDepth=4});var root=message.RootElement;if(root.ValueKind!=JsonValueKind.Object||root.EnumerateObject().Count()!=4||root.EnumerateObject().Select(property=>property.Name).Distinct(StringComparer.Ordinal).Count()!=4||!root.TryGetProperty("type",out var type)||type.GetString()!="agenticview:window-icon"||!root.TryGetProperty("cardId",out var target)||target.GetString()!=cardId||!root.TryGetProperty("requestId",out var request)||!Guid.TryParseExact(request.GetString(),"D",out _)||!root.TryGetProperty("windowIcon",out var value))return false;spec=WindowIconSpec.Parse(value);requestId=request.GetString()!;return true;}catch(JsonException){return false;}catch(InvalidOperationException){return false;}catch(ArgumentException){return false;}
    }
}

public sealed record NativeDebugRegistration(string ClientId,string ClientToken,string[] CardIds);
