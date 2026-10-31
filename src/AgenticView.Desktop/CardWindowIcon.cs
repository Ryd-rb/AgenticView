using System.Runtime.InteropServices;
using System.Text.Json;

namespace AgenticView.Desktop;

internal static class CardWindowIcon
{
    private static string ManagedRoot(DesktopOptions options)=>Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AgenticView","Cards",CardWindowSpec.Key(options.Url,options.CardId!));
    private static bool IsManagedProfile(DesktopOptions options)=>options.CardId is not null&&string.Equals(Path.GetFullPath(options.DataDirectory),Path.Combine(ManagedRoot(options),"profile"),StringComparison.OrdinalIgnoreCase);
    private static string OwnedRoot(DesktopOptions options)
    {
        if(options.CardId is null)throw new InvalidOperationException("A card window is required.");
        var root=ManagedRoot(options);
        PopOutLauncher.PlainPath(root);PopOutLauncher.PlainPath(options.DataDirectory);
        if(!string.Equals(Path.GetFullPath(options.DataDirectory),Path.Combine(root,"profile"),StringComparison.OrdinalIgnoreCase))throw new IOException("Window profile is not owned card storage.");
        var definition=Path.Combine(root,"definition.json");PopOutLauncher.PlainPath(definition);
        if(new FileInfo(definition).Length>8192)throw new IOException("Invalid card definition.");
        using var json=JsonDocument.Parse(File.ReadAllText(definition));var value=json.RootElement;
        if(value.GetProperty("cardId").GetString()!=options.CardId||value.GetProperty("url").GetString()!=options.Url.AbsoluteUri||!string.Equals(value.GetProperty("profile").GetString(),options.DataDirectory,StringComparison.OrdinalIgnoreCase))throw new IOException("Card storage identity differs.");
        return root;
    }

    public static WindowIconSpec? Load(DesktopOptions options)
    {
        if(!IsManagedProfile(options))return null;
        var path=Path.Combine(OwnedRoot(options),"window-icon.json");PopOutLauncher.PlainPath(path);
        if(!File.Exists(path))return null;
        if(new FileInfo(path).Length>1024)throw new IOException("Invalid retained window icon.");
        using var json=JsonDocument.Parse(File.ReadAllText(path));return WindowIconSpec.Parse(json.RootElement);
    }

    public static void Persist(DesktopOptions options,WindowIconSpec? spec,Icon icon)
    {
        // Direct CLI windows retain their existing custom-profile behavior. Their
        // hub metadata reapplies at navigation; only --open-card owns durable links.
        if(!IsManagedProfile(options))return;
        var root=OwnedRoot(options);var iconPath=Path.Combine(root,"card.ico");var config=Path.Combine(root,"window-icon.json");var shortcut=Path.Combine(root,"Open card.lnk");
        foreach(var path in new[]{iconPath,config,shortcut,iconPath+".tmp",config+".tmp"})PopOutLauncher.PlainPath(path);
        using(var stream=new FileStream(iconPath+".tmp",FileMode.Create,FileAccess.Write,FileShare.None))icon.Save(stream);
        File.Move(iconPath+".tmp",iconPath,true);
        File.WriteAllText(config+".tmp",JsonSerializer.Serialize(spec));File.Move(config+".tmp",config,true);
        PopOutLauncher.WriteShortcut(shortcut,Environment.ProcessPath!,options,iconPath);
        SHChangeNotify(0x00002000,0x0005,shortcut,IntPtr.Zero);
        SHChangeNotify(0x00002000,0x0005,iconPath,IntPtr.Zero);
    }

    public static void ApplyIdentity(nint handle,DesktopOptions options)
    {
        if(!IsManagedProfile(options)){TaskbarIdentity.Apply(handle,CardWindowSpec.AppId(options.Url,options.CardId!),CardWindowSpec.Command(Environment.ProcessPath!,options),options.CardName??"AgenticView card",Environment.ProcessPath!+",0");return;}
        var root=OwnedRoot(options);var shortcut=Path.Combine(root,"Open card.lnk");var icon=Path.Combine(root,"card.ico");
        PopOutLauncher.PlainPath(shortcut);PopOutLauncher.PlainPath(icon);
        TaskbarIdentity.Apply(handle,CardWindowSpec.AppId(options.Url,options.CardId!),CardWindowSpec.Quote(shortcut),options.CardName??"AgenticView card",icon+",0");
    }

    [DllImport("shell32.dll",CharSet=CharSet.Unicode)]
    private static extern void SHChangeNotify(uint eventId,uint flags,string item,nint other);
}
