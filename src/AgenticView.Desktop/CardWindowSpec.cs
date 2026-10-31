using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AgenticView.Desktop;

public static class CardWindowSpec
{
    public static string ValidateId(string value)
    {
        if (value.Length is < 1 or > 100 || value.Any(char.IsControl) || value is "__proto__" or "prototype" or "constructor" || !Regex.IsMatch(value,"^[a-zA-Z0-9_.:-]+$",RegexOptions.CultureInvariant|RegexOptions.NonBacktracking)) throw new ArgumentException("Use a bounded card identifier.");
        return value;
    }
    public static string ValidateName(string value)
    {
        if(string.IsNullOrWhiteSpace(value)||value.Length>160||value.Any(char.IsControl)) throw new ArgumentException("Use a bounded card name without control characters.");
        return value;
    }
    public static string Key(Uri url,string cardId) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url.AbsoluteUri+"\n"+ValidateId(cardId))))[..24].ToLowerInvariant();
    public static string AppId(Uri url,string cardId) => "AgenticView.Card."+Key(url,cardId);
    public static string TaskbarName(string value) => "AgenticView · "+ValidateName(value);
    public static string Quote(string value)
    {
        var output=new StringBuilder("\"");var slashes=0;
        foreach(var character in value){if(character=='\\'){slashes++;continue;}if(character=='\"'){output.Append('\\',slashes*2+1).Append(character);}else{output.Append('\\',slashes).Append(character);}slashes=0;}
        return output.Append('\\',slashes*2).Append('"').ToString();
    }
    public static string[] Arguments(DesktopOptions options)
    {
        var result=new List<string>{"--url",options.Url.AbsoluteUri,"--data-dir",options.DataDirectory};
        if(options.CardId is not null){result.AddRange(["--card-id",ValidateId(options.CardId),"--card-name",ValidateName(options.CardName??"AgenticView card")]);}
        if(options.Windowed)result.Add("--windowed");
        if(options.FocusCardId is not null)result.AddRange(["--focus-card",ValidateId(options.FocusCardId)]);
        if(options.ViewerKeyFile is not null)result.AddRange(["--viewer-key-file",options.ViewerKeyFile]);
        return result.ToArray();
    }
    // Saved private-profile cookies bootstrap relaunches. Never retain a task-workspace key-file dependency.
    public static string[] RelaunchArguments(DesktopOptions options) => Arguments(options.CardId is not null?options with{ViewerKeyFile=null}:options);
    public static string Command(string executable,DesktopOptions options) => Quote(executable)+" "+string.Join(' ',RelaunchArguments(options).Select(Quote));
}
