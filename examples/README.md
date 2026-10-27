# Integration examples

All examples publish synthetic data through HTTP. They execute no queries or
remote commands and require no third-party client libraries.

Set `AV_INGEST_KEY` privately and optionally `AV_URL`. Run one of:

```sh
dotnet run --project examples/csharp
python examples/python/agent.py
powershell -File examples/powershell/agent.ps1
```

They publish a view and wait for Enter before archiving it. A long-running tool
should send a heartbeat every 15 seconds. For network retry handling, retain the
same registration proof and exact publish batch/sequence until delivery is known.
The [TypeScript client](../clients/client.ts) implements sequencing, heartbeats,
and uncertain-delivery recovery; see the [protocol](../docs/protocol.md).
