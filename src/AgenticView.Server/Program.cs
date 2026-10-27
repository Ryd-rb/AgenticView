using AgenticView.Server;

var config = RuntimeConfig.Load();
if (args.Contains("--keys"))
{
    Console.WriteLine($"Viewer key (dashboard access):\n{config.Secrets.ViewerToken}\n\nIngestion key (registration only):\n{config.Secrets.IngestToken}\n\nKeep both keys private. Never distribute the server's runSecret.");
    return;
}
var app = AppHost.Build(args, config);
Console.WriteLine($"AgenticView · C# / .NET 10 · {config.PublicUrl.GetLeftPart(UriPartial.Authority)}");
Console.WriteLine("Use --keys with the same AV_DATA_DIR to obtain installation access keys.");
await app.RunAsync();
