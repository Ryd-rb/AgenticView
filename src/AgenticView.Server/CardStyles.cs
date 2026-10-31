using System.Text.Json.Nodes;
namespace AgenticView.Server;
public static class CardStyles
{
    public static readonly string[] Icons=["status","signal","bot","terminal","code","database","server","search","shield","flask","gamepad","git-branch","bug","activity","network","workflow","cpu","globe","file","folder","chart","layers","sparkles","wrench","rocket","clock","check","alert","book","zap","lock","unlock","play","pause","power","plus","minus","save","trash","settings","refresh","copy","download","upload","eye","eye-off","send","user","menu","close"];
    public static void Validate(JsonObject style)
    {
        if(!style.ContainsKey("icon")&&!style.ContainsKey("windowIcon"))ComponentValidator.Fail("Supply a header icon or window icon.");
        if(style.ContainsKey("icon"))ComponentValidator.Choice(style,"icon",Icons);
        if(style.ContainsKey("windowIcon")&&style["windowIcon"] is not null){
            var value=ComponentValidator.Object(style["windowIcon"]);ComponentConfiguration.Keys(value,"icon","color","background");ComponentValidator.Choice(value,"icon",Icons);
            foreach(var key in new[]{"color","background"})if(value.ContainsKey(key)){var color=ComponentValidator.Text(value,key,7,true,7);if(color[0]!='#'||color.Skip(1).Any(character=>!char.IsAsciiHexDigit(character)))ComponentValidator.Fail("Use a six-digit hex icon color.");}
        }
    }
    public static void Apply(JsonObject view,JsonObject style){foreach(var key in new[]{"icon","windowIcon"})if(style.ContainsKey(key))view[key]=style[key]?.DeepClone();}
}
