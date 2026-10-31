using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace AgenticView.Server;

[JsonConverter(typeof(JsonStringEnumConverter<UiGuideGoal>))]
public enum UiGuideGoal { start, create, style, data, debug, windows, templates }

/// <summary>Static onboarding only: no hub, credentials, I/O, or tool execution.</summary>
public static class UiGuide
{
    private static JsonObject Call(string tool,object arguments,string effect)=>Json.Object(new{tool,arguments,effect});
    private static JsonObject Publish(object component)=>Call("agent_publish",new{runId="<runId>",runToken="<runToken>",sequence=1,operations=new[]{new{op="upsert",component}}},"Writes a display component. Sequence1 is ONLY for a fresh run with no prior publish; otherwise use the retained last sequence+1. Full upserts replace the same component ID.");
    public static JsonObject Read(UiGuideGoal goal=UiGuideGoal.start)
    {
        if(!Enum.IsDefined(goal))throw new HubError(400,"Choose goal: start, create, style, data, debug, windows, templates.");
        var page=goal switch{
            UiGuideGoal.start=>Page("Choose one small next task",[],[
                "New monitoring card: create. Existing card appearance: style. Charts/grids/providers: data.",
                "Inspect/click safe native controls: debug. Windows icons/pop-outs: windows. Reuse an authored application: templates.",
                "MCP connection authentication is separate from card ownership. Registration returns private runId/runToken; a viewer/operator key grants broader authority only when explicitly supplied."],
                Call("ui_guide",new{goal="create"},"Read-only guidance"),[],["create","style","data","debug","windows","templates"]),
            UiGuideGoal.create=>Page("Create a card, then publish its plan",["Configured authenticated MCP connection","Your retained requestId and private random registrationKey (32+ characters); generate privately outside this guide"],[
                "Read component_catalog to choose a native component. Register once; retain the request identity/proof for exact retry.",
                "Save returned runId/runToken privately. Publish a Markdown plan FIRST. For child agents also pass parentId/parentToken; never invent them.",
                "Heartbeat every15seconds while working. Keep sequence/content exact on retry; archive your run when completed, after retaining evidence."],
                Call("component_catalog",new{},"Read-only schema discovery"),[
                    Call("agent_register",new{requestId="<requestId>",registrationKey="<registrationKey>",agentId="my-agent",name="My task"},"Creates/reuses your monitoring card; placeholders must be replaced"),
                    Publish(new{id="plan",kind="markdown",title="Current plan",data=new{text="- [ ] Complete the requested work\n- [ ] Validate and report"}}),
                    Call("agent_heartbeat",new{runId="<runId>",runToken="<runToken>"},"Updates your run liveness")],["style","data","debug"]),
            UiGuideGoal.style=>Page("Style a card or a native component",["The existing card's own runId/runToken; explicit operator authority is a separate workflow"],[
                "card_style changes header/window icons. card_display changes card controls and component layout without changing action permissions.",
                "Native component styling lives in component.configuration.presentation. Upsert the complete component, preserving its data and existing settings; do not replace a live component from a partial styling example.",
                "Use typed fields only: padding/margin/gap, controlPadding/cellPadding, rowHeight, fontSize and colors. Animation defaults to none. manualFields explicitly grants operator editing; origin labels and permission ceilings remain."],
                Call("component_catalog",new{},"Read-only presentation fields, limits and icon names"),[
                    Call("card_style",new{runId="<runId>",runToken="<runToken>",icon="chart"},"Changes header icon only"),
                    Call("card_display",new{runId="<runId>",runToken="<runToken>",display=new{componentLayout=new{mode="vertical",gap=0}}},"Sets vertical native component layout"),
                    Publish(new{id="example-style",kind="metric",title="Example metric",data=new{value=42},configuration=new{presentation=new{surface="plain",density="compact",padding=0,fontSize=14,animation="none"}}})],["create","windows"]),
            UiGuideGoal.data=>Page("Display supplied data or query a bounded provider",["Your runId/runToken","For provider data: an existing connector ID and allowlisted handler, supplied by its operator"],[
                "Small data: publish native metric/chart/table components. A chart point uses x/y, not a hardcoded business domain.",
                "Large history stays in the owning adapter. Configure a confirmation-free query with declared numeric from/to/maxPoints fields, then chart.data.source.readAction references that action. Keep series present (it may be empty).",
                "Bound chart queries to32..2048 points per series and grid pages to at most200rows. Filtering/sorting belongs in the provider. Hidden readers pause. Never place SQL, shell source, URLs or machine credentials in browser fields.",
                "card_configure replaces the action configuration: merge existing actions deliberately. Operational actions/confirmations use their typed workflow, not debugging clicks."],
                Call("component_catalog",new{},"Read-only chart/data-grid/source schemas"),[
                    Publish(new{id="readings",kind="chart",title="Readings",data=new{type="line",series=new[]{new{name="Reading",points=new[]{new{x=0,y=-1},new{x=1,y=2}}}}}}),
                    Call("card_configure",new{runId="<runId>",runToken="<runToken>",actions=new[]{new{id="read-series",label="Read series",kind="query",target="<connectorId>",handler="<allowedHandler>",fields=new[]{new{key="from",label="From UTC ms",type="number",required=true},new{key="to",label="To UTC ms",type="number",required=true},new{key="maxPoints",label="Point limit",type="number",required=true}}}}},"Configures one allowlisted read action; preserve/merge existing actions first")],["create","templates"]),
            UiGuideGoal.debug=>Page("Inspect and act with copyable next calls",["Your runId/runToken and a fresh visible viewer for that card; or explicit operatorToken via ui_open_card"],[
                "ui_open selects a viewer, maximizes your own card and inspects safe targets. Treat returned debugId as a private scoped capability.",
                "Follow nextCall. Pending: ui_wait with its debugId/commandId. To act, copy nextActionId into requestId and choose a target.ref plus its advertised allowedActions.",
                "click/type/press/scroll/focus use targetRef. type also value; press also key. zoom uses zoom; metrics/profile/layers need no target. ui_inspect refreshes stale refs.",
                "Retry identical action identity/content; never re-execute an unknown outcome under a new identity. ui_close finishes. No operational controls, scripts, selectors, screenshots or external computer automation."],
                Call("ui_open",new{runId="<runId>",runToken="<runToken>"},"Opens/reuses a five-minute debug lease and navigates/inspects your card"),[
                    Call("ui_action",new{debugId="<debugId>",requestId="<nextActionId>",action="click",targetRef="<inspectedRef>"},"Injects only an inspection-advertised safe native action"),
                    Call("ui_wait",new{debugId="<debugId>",commandId="<commandId>"},"Reads/waits for the existing command, never queues a replacement"),
                    Call("ui_close",new{debugId="<debugId>"},"Closes the debug lease; uncertain claimed work is not replayed")],["data","windows"]),
            UiGuideGoal.windows=>Page("Configure native window icons and understand pop-outs",["Your runId/runToken","Dedicated native desktop for pop-out windows and native icon receipts"],[
                "card_style.windowIcon configures a catalog pictograph and optional #RRGGBB colors; no file paths, images, URLs or scripts. Header icon and Windows icon are independent.",
                "Read card_window_icon_status after configuring. Configuration acknowledgement alone does not prove an open Windows process applied the icon.",
                "Open a card's independent window through its existing native pop-out control. There is no dedicated MCP pop-out tool in the current catalog; do not invent one or bypass native launch custody.",
                "resetWindowIcon:true restores the signal default. Authored templates can retain windowIcon for portable reuse."],
                Call("card_window_icon_status",new{runId="<runId>",runToken="<runToken>"},"Read-only configured icon and native acknowledgements"),[
                    Call("card_style",new{runId="<runId>",runToken="<runToken>",windowIcon=new{icon="chart",color="#74d4c8",background="#101722"}},"Changes configured Windows icon, preserving the header icon"),
                    Call("card_style",new{runId="<runId>",runToken="<runToken>",resetWindowIcon=true},"Resets the Windows icon; do not also supply windowIcon")],["style","templates"]),
            _=>Page("Save and reuse authored application templates",["Own runId/runToken to define/export; import uses retained requestId/private registrationKey","Installation connector IDs only for local logical binding resolution"],[
                "application_define saves an explicitly authored manifest and marks its card permanent. application_export returns that saved definition, not live telemetry/history.",
                "Keep schemaVersion1,id,version,name,permanent:true,bindings,actions,components. Use logical binding IDs in actions; keep credentials, machine paths and runtime binding values out of portable source.",
                "Write exported JSON to the creating project's versioned .agenticview.json file and review authored content for private data before publishing.",
                "application_import requires manifest,bindings,requestId,registrationKey. Supply actual connector IDs locally for logical bindings; exact retries reuse all inputs/proof. Import configures a permanent card but visible query monitors/trusted embeds may run when rendered."],
                Call("component_catalog",new{},"Read-only applicationSchema and component schemas"),[
                    Call("application_define",new{runId="<runId>",runToken="<runToken>",manifest=new{schemaVersion=1,id="notes-template",version="1.0.0",name="Notes",permanent=true,bindings=Array.Empty<object>(),actions=Array.Empty<object>(),components=new[]{new{id="notes",kind="markdown",title="Notes",data=new{text="Reusable authored notes"}}}}},"Saves authored definition and makes card permanent"),
                    Call("application_export",new{runId="<runId>",runToken="<runToken>"},"Read-only saved definition; write returned manifest to your repository")],["create","data","windows"])
        };
        page["goal"]=goal.ToString();page["readOnly"]=true;page["executesTools"]=false;
        page["placeholders"]="<...> values are references, NOT working credentials or IDs. Replace them with your own retained values before calling any example; never send them literally. This guide does not generate or retrieve secrets.";
        return page;
    }
    private static JsonObject Page(string title,string[] needed,string[] steps,JsonObject nextCall,JsonObject[] examples,string[] relatedGoals)=>Json.Object(new{title,needed,steps,nextCall,examples,relatedGoals});
}
