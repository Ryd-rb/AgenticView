using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

var endpoint = Environment.GetEnvironmentVariable("AV_URL") ?? "http://127.0.0.1:4317";
var ingestionKey = Environment.GetEnvironmentVariable("AV_INGEST_KEY") ?? throw new InvalidOperationException("Set AV_INGEST_KEY.");
using var http = new HttpClient { BaseAddress = new Uri(endpoint), Timeout = TimeSpan.FromSeconds(15) };
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", ingestionKey);
using var registration = await http.PostAsJsonAsync("/api/agents/register", new { requestId = Guid.NewGuid().ToString(), registrationKey = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)), agentId = "example-csharp", name = "Synthetic C# coding agent", role = "Example" });
registration.EnsureSuccessStatusCode();
var run = (await registration.Content.ReadFromJsonAsync<JsonObject>())!;
var runId = run["runId"]!.GetValue<string>();
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", run["runToken"]!.GetValue<string>());
using var published = await http.PostAsJsonAsync($"/api/agents/{runId}/publish", new { sequence = 1, operations = new object[] {
    new { op="upsert", component=new { id="plan",title="Plan",kind="markdown",data=new { text="## Synthetic plan\n- Implement reader\n- Validate results" } } },
    new { op="upsert", component=new { id="files",title="Modified files",kind="tree",data=new { nodes=new object[]{new{id="src",label="src"},new{id="reader",label="Reader.cs",parentId="src",detail="modified"}} } } },
    new { op="upsert", component=new { id="diff",title="Proposed change",kind="diff",data=new { language="csharp",before="return source.ToList();",after="return source.Where(IsRelevant).ToList();" } } }
} });
published.EnsureSuccessStatusCode();
Console.WriteLine("Synthetic coding view published. Press Enter to archive.");
Console.ReadLine();
using var archived = await http.PostAsJsonAsync($"/api/agents/{runId}/archive", new { });
archived.EnsureSuccessStatusCode();
