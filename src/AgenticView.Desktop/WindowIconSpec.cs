using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace AgenticView.Desktop;

public sealed record WindowIconSpec(
    [property:JsonPropertyName("icon")] string Icon,
    [property:JsonPropertyName("color"),JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)] string? Color=null,
    [property:JsonPropertyName("background"),JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)] string? Background=null)
{
    public static readonly string[] Icons=["status","signal","bot","terminal","code","database","server","search","shield","flask","gamepad","git-branch","bug","activity","network","workflow","cpu","globe","file","folder","chart","layers","sparkles","wrench","rocket","clock","check","alert","book","zap","lock","unlock","play","pause","power","plus","minus","save","trash","settings","refresh","copy","download","upload","eye","eye-off","send","user","menu","close"];

    public static WindowIconSpec? Parse(JsonElement value)
    {
        if(value.ValueKind==JsonValueKind.Null)return null;
        if(value.ValueKind!=JsonValueKind.Object)throw new ArgumentException("Window icon must be a native icon configuration.");
        string? icon=null,color=null,background=null;var seen=new HashSet<string>(StringComparer.Ordinal);
        foreach(var property in value.EnumerateObject())
        {
            if(!seen.Add(property.Name)||property.Name is not ("icon" or "color" or "background")||property.Value.ValueKind!=JsonValueKind.String)throw new ArgumentException("Window icon properties must be unique, supported strings.");
            var text=property.Value.GetString()!;
            if(property.Name=="icon") {if(!Icons.Contains(text,StringComparer.Ordinal))throw new ArgumentException("Unknown native window icon.");icon=text;}
            else
            {
                if(text.Length!=7||!Regex.IsMatch(text,"^#[0-9a-fA-F]{6}$",RegexOptions.CultureInvariant|RegexOptions.NonBacktracking))throw new ArgumentException("Window icon colors must use six-digit hex values.");
                if(property.Name=="color")color=text.ToLowerInvariant();else background=text.ToLowerInvariant();
            }
        }
        return icon is null?throw new ArgumentException("Window icon identifier is required."):new(icon,color,background);
    }

    /// <summary>Fingerprint of logical configuration only; independent of rendering or machine paths.</summary>
    public static string Key(WindowIconSpec? spec)
    {
        if(spec is null)return "default";
        var normalized=Parse(JsonSerializer.SerializeToElement(spec))!;
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized.Icon+"\n"+(normalized.Color??"")+"\n"+(normalized.Background??"")))).ToLowerInvariant();
    }
}
