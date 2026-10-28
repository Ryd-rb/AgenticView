using System.Text.Json.Nodes;
namespace AgenticView.Server;
public static class CardStyles
{
    public static readonly string[] Icons=["status","signal","bot","terminal","code","database","server","search","shield","flask","gamepad","git-branch","bug","activity","network","workflow","cpu","globe","file","folder","chart","layers","sparkles","wrench","rocket","clock","check","alert","book","zap"];
    public static void Validate(JsonObject style)=>ComponentValidator.Choice(style,"icon",Icons);
}
