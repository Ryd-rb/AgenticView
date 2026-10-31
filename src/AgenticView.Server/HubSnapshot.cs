using System.Buffers;
using System.Text.Json;

namespace AgenticView.Server;

public sealed partial class Hub
{
    /// <summary>Serialize one consistent snapshot while holding the state gate.
    /// Own only the resulting UTF8 buffer, without cloning all retained data.</summary>
    public ReadOnlyMemory<byte> SnapshotUtf8()
    {
        lock (gate)
        {
            var buffer = new ArrayBufferWriter<byte>();
            using var writer = new Utf8JsonWriter(buffer);
            writer.WriteStartObject();
            writer.WriteNumber("revision", revision);
            writer.WriteStartArray("agents");
            foreach (var run in runs.Values) run.View.WriteTo(writer, Json);
            writer.WriteEndArray();
            writer.WritePropertyName("settings"); settings.WriteTo(writer, Json);
            writer.WritePropertyName("stats"); Stats().WriteTo(writer, Json);
            writer.WriteEndObject();
            writer.Flush();
            return buffer.WrittenMemory;
        }
    }
}
