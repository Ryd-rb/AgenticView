using System.Runtime.InteropServices;

namespace AgenticView.Desktop;

/// <summary>Window-scoped taskbar grouping and relaunch properties, owned by the desktop host.</summary>
internal static class TaskbarIdentity
{
    private static readonly Guid AppUserModel = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    private static readonly uint[] PropertyIds = [2, 4, 3, 5];

    public static void SetProcessIdentity(string appId)
    {
        ValidateAppId(appId);
        Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID(appId));
    }

    public static void SetShortcutIdentity(string shortcutPath, string appId)
    {
        ValidateAppId(appId);
        if (string.IsNullOrWhiteSpace(shortcutPath) || shortcutPath.Contains('\0'))
            throw new ArgumentException("A shortcut path is required.", nameof(shortcutPath));
        var iid = typeof(IPropertyStore).GUID;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, 2, ref iid, out var store)); // GPS_READWRITE
        try
        {
            Set(store, 5, appId);
            // File-backed stores require Commit, unlike the HWND property store.
            Marshal.ThrowExceptionForHR(store.Commit());
        }
        finally { Marshal.FinalReleaseComObject(store); }
    }

    public static void Apply(IntPtr hwnd, string appId, string relaunchCommand, string displayName, string iconPath)
    {
        ValidateAppId(appId);
        foreach (var value in new[] { relaunchCommand, displayName, iconPath })
            if (string.IsNullOrWhiteSpace(value) || value.Contains('\0')) throw new ArgumentException("Taskbar relaunch properties must contain nonempty text.");
        var store = Store(hwnd);
        try
        {
            // Setting ID notifies the taskbar: relaunch metadata must already be present.
            Set(store, 2, relaunchCommand);
            Set(store, 4, displayName);
            Set(store, 3, iconPath);
            Set(store, 5, appId);
        }
        catch
        {
            try { ClearStore(store); } catch { /* Preserve the original failure after attempting all cleanup. */ }
            throw;
        }
        finally { Marshal.FinalReleaseComObject(store); }
    }

    public static void Clear(IntPtr hwnd)
    {
        var store = Store(hwnd);
        try { ClearStore(store); }
        finally { Marshal.FinalReleaseComObject(store); }
    }

    private static IPropertyStore Store(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) throw new ArgumentException("A live window handle is required.", nameof(hwnd));
        var iid = typeof(IPropertyStore).GUID;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(hwnd, ref iid, out var store));
        return store;
    }

    private static void Set(IPropertyStore store, uint propertyId, string value)
    {
        var key = new PropertyKey(AppUserModel, propertyId);
        var variant = new PropVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(value) }; // VT_LPWSTR
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref variant)); }
        finally { Marshal.FreeCoTaskMem(variant.Pointer); }
    }

    private static void ClearStore(IPropertyStore store)
    {
        var firstFailure = 0;
        foreach (var id in PropertyIds)
        {
            var key = new PropertyKey(AppUserModel, id);
            var empty = new PropVariant(); // VT_EMPTY releases the window-owned property resources.
            var result = store.SetValue(ref key, ref empty);
            if (result < 0 && firstFailure == 0) firstFailure = result;
        }
        // Window property stores apply SetValue immediately; Commit is unnecessary.
        Marshal.ThrowExceptionForHR(firstFailure);
    }

    private static void ValidateAppId(string appId)
    {
        if (string.IsNullOrWhiteSpace(appId) || appId.Length > 128 || appId.Any(char.IsWhiteSpace) || appId.Contains('\0'))
            throw new ArgumentException("Taskbar application identity must be at most 128 characters without whitespace.", nameof(appId));
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey(Guid formatId, uint propertyId)
    {
        public Guid FormatId = formatId;
        public uint PropertyId = propertyId;
    }

    // Windows x64 PROPVARIANT has an eight-byte header and a sixteen-byte union.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [DllImport("shell32.dll", ExactSpelling = true)]
    private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SHGetPropertyStoreFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr bindContext, uint flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string appId);
}
