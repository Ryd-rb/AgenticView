using System.Text.Json.Nodes;
using static AgenticView.Server.ComponentValidator;

namespace AgenticView.Server;
public static class CardDisplay
{
    public static void Layout(JsonObject value)
    {
        ComponentConfiguration.Keys(value,"mode","columns","minWidth","gap");
        if(value.ContainsKey("mode")) Choice(value,"mode",["auto","vertical","columns"]);
        if(value.ContainsKey("columns")) Number(value,"columns",1,8,true,true);
        if(value.ContainsKey("minWidth")) Number(value,"minWidth",200,1000,true,true);
        if(value.ContainsKey("gap")) Number(value,"gap",0,32,true,true);
    }
    public static void Validate(JsonObject value)
    {
        Budget(value);ComponentConfiguration.Keys(value,"chrome","componentLayout");
        if(value.ContainsKey("chrome")) ControlPresentation.Validate(Object(value["chrome"]));
        if(value.ContainsKey("componentLayout")) Layout(Object(value["componentLayout"]));
    }
}
