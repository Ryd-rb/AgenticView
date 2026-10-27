using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

public static class Demo
{
    public static JsonObject Seed(Hub hub)
    {
        var examples = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "demo.json")))!.AsArray();
        var credentials = new Dictionary<string, JsonObject>();
        foreach (var node in examples)
        {
            var example = node!.AsObject();
            var input = new JsonObject { ["requestId"] = Guid.NewGuid().ToString(), ["registrationKey"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), ["agentId"] = "demo-" + Guid.NewGuid(), ["name"] = example["name"]!.DeepClone(), ["role"] = example["role"]!.DeepClone(), ["context"] = "Synthetic demonstration. No external systems are accessed." };
            if (example["parent"] is JsonValue parent)
            {
                var ancestor = credentials[parent.GetValue<string>()]; input["parentId"] = ancestor["runId"]!.DeepClone(); input["parentToken"] = ancestor["runToken"]!.DeepClone();
            }
            var result = hub.Register(input); credentials[example["key"]!.GetValue<string>()] = result;
            var operations = new JsonArray();
            foreach (var component in example["components"]!.AsArray()) operations.Add(new JsonObject { ["op"] = "upsert", ["component"] = component!.DeepClone() });
            hub.Publish(result["runId"]!.GetValue<string>(), result["runToken"]!.GetValue<string>(), new JsonObject { ["sequence"] = 1, ["operations"] = operations });
        }
        return new JsonObject { ["synthetic"] = true, ["runIds"] = new JsonArray(credentials.Values.Select(c => c["runId"]!.DeepClone()).ToArray()) };
    }
}
