using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AgenticView.Desktop;

internal static class PopOutLauncher
{
    private sealed record Receipt(int ProcessId,DateTime CreatedUtc,string Executable,string CardId,string Shortcut);
    public sealed record Result(int ProcessId,bool AlreadyOpen);
    public static Result Open(DesktopOptions owner,string cardId,string title)
    {
        CardWindowSpec.ValidateId(cardId);CardWindowSpec.ValidateName(title);
        var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgenticView","Cards",CardWindowSpec.Key(owner.Url,cardId));
        PlainPath(root);Directory.CreateDirectory(root);
        using var guard=new FileStream(Path.Combine(root,"launch.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var receiptPath=Path.Combine(root,"process.json");
        if(File.Exists(receiptPath)){
            var previous=JsonSerializer.Deserialize<Receipt>(File.ReadAllText(receiptPath));
            if(previous is not null){try{using var process=Process.GetProcessById(previous.ProcessId);if(!process.HasExited&&process.StartTime.ToUniversalTime()==previous.CreatedUtc&&string.Equals(process.MainModule?.FileName,previous.Executable,StringComparison.OrdinalIgnoreCase))return new(process.Id,true);}catch(ArgumentException){}catch(InvalidOperationException){}}
        }
        var source=Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
        var files=Files(source).Order(StringComparer.Ordinal).ToArray();
        var identity=string.Join('\n',files.Select(file=>Path.GetRelativePath(source,file)+":"+Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)))));
        var build=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..24].ToLowerInvariant();
        var app=Path.Combine(root,"app",build);PlainPath(app);
        foreach(var file in files){var target=Path.Combine(app,Path.GetRelativePath(source,file));PlainPath(target);Directory.CreateDirectory(Path.GetDirectoryName(target)!);if(File.Exists(target)){if(!SHA256.HashData(File.ReadAllBytes(file)).SequenceEqual(SHA256.HashData(File.ReadAllBytes(target))))throw new IOException("Existing card runtime differs from its retained source.");}else File.Copy(file,target);}
        var executable=Path.Combine(app,"AgenticView.Desktop.exe");if(!File.Exists(executable))throw new IOException("A published desktop runtime is required.");
        var options=owner with{DataDirectory=Path.Combine(root,"profile"),CardId=cardId,CardName=title,Windowed=true,Diagnose=false,OpenCard=false,FocusCardId=null};
        PlainPath(options.DataDirectory);Directory.CreateDirectory(options.DataDirectory);
        var iconPath=Path.Combine(root,"card.ico");PlainPath(iconPath);
        if(!File.Exists(iconPath)){using var icon=BrandIcon.Create();using var iconFile=new FileStream(iconPath,FileMode.CreateNew,FileAccess.Write,FileShare.Read);icon.Save(iconFile);}
        var shortcut=Path.Combine(root,"Open card.lnk");PlainPath(shortcut);
        WriteShortcut(shortcut,executable,options,iconPath);
        File.WriteAllText(Path.Combine(root,"definition.json"),JsonSerializer.Serialize(new{url=options.Url.AbsoluteUri,cardId,title,appId=CardWindowSpec.AppId(options.Url,cardId),shortcut,profile=options.DataDirectory,runtime=app}));
        var start=new ProcessStartInfo(executable){UseShellExecute=false,WorkingDirectory=app,CreateNoWindow=false,WindowStyle=ProcessWindowStyle.Normal};
        foreach(var name in new[]{"AV_INGEST_KEY","AV_INGEST_TOKEN","AV_RUN_TOKEN","AV_PARENT_TOKEN","OPENAI_API_KEY","ANTHROPIC_API_KEY"})start.Environment.Remove(name);
        foreach(var argument in CardWindowSpec.Arguments(options))start.ArgumentList.Add(argument);
        // A normal desktop process owns this process; it has no agent-job, cancellation or parent-close hook.
        using var child=Process.Start(start)??throw new IOException("Card process did not start.");
        File.WriteAllText(receiptPath,JsonSerializer.Serialize(new Receipt(child.Id,child.StartTime.ToUniversalTime(),executable,cardId,shortcut)));
        return new(child.Id,false);
    }
    private static void WriteShortcut(string path,string executable,DesktopOptions options,string iconPath)
    {
        var type=Type.GetTypeFromProgID("WScript.Shell")??throw new InvalidOperationException("Windows shortcut support is unavailable.");
        object? shell=null,shortcut=null;
        try{shell=Activator.CreateInstance(type)!;shortcut=type.InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,[path])!;var target=shortcut.GetType();void Set(string name,object value)=>target.InvokeMember(name,BindingFlags.SetProperty,null,shortcut,[value]);Set("TargetPath",executable);Set("Arguments",string.Join(' ',CardWindowSpec.RelaunchArguments(options).Select(CardWindowSpec.Quote)));Set("WorkingDirectory",Path.GetDirectoryName(executable)!);Set("Description",options.CardName??"AgenticView card");Set("IconLocation",iconPath+",0");target.InvokeMember("Save",BindingFlags.InvokeMethod,null,shortcut,null);}
        finally{if(shortcut is not null&&Marshal.IsComObject(shortcut))Marshal.FinalReleaseComObject(shortcut);if(shell is not null&&Marshal.IsComObject(shell))Marshal.FinalReleaseComObject(shell);}
        TaskbarIdentity.SetShortcutIdentity(path,CardWindowSpec.AppId(options.Url,options.CardId!));
    }
    private static IEnumerable<string> Files(string directory)
    {
        PlainPath(directory);foreach(var item in Directory.EnumerateFileSystemEntries(directory)){PlainPath(item);if(Directory.Exists(item)){foreach(var file in Files(item))yield return file;}else yield return item;}
    }
    private static void PlainPath(string path)
    {
        if(!Path.IsPathFullyQualified(path)||path.StartsWith("\\\\",StringComparison.Ordinal))throw new IOException("Card storage must be local.");
        for(var current=path;current is not null;current=Path.GetDirectoryName(current))if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new IOException("Card storage cannot follow links.");
    }
}
