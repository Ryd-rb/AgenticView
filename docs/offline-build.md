# Offline Windows source build

The offline source bundle builds AgenticView on Windows x64 with the .NET 10 SDK
already installed. It includes the C# server sources, package lockfile, all locked
NuGet packages, and the prebuilt web monitor. The scripts support built-in Windows PowerShell 5.1 and PowerShell 7. The offline machine needs no Node.js,
npm, JavaScript build tools, or online package restore. Building changes to the web
monitor itself still requires a separate connected preparation environment.

On the preparation machine, build the current web monitor into `dist/web`, restore
the server and desktop host's locked packages into the local NuGet cache, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-offline.ps1
```

The packager reads `NUGET_PACKAGES` or the current user's standard NuGet cache.
Use `-NuGetPackages <cache-directory>` to select another existing cache. It never
downloads packages, overwrites an existing bundle, or copies credentials, local
databases, `.git`, `node_modules`, `bin`, or `obj`. Its explicit source allowlist
must be updated when additional server source files become necessary. Unexpected
links or missing build/package inputs stop packaging. Outputs and staging remain
under `.task/packages` for review; the script deletes nothing.

Copy the generated ZIP to the offline machine, extract it into a new directory,
open the built-in Windows PowerShell at that directory, and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-offline.ps1
dotnet app/AgenticView.Server.dll
```

The build verifies the bundle's relative SHA256 manifest, selects only the bundled
NuGet feed with cleared fallback sources, and performs a locked restore into a
new empty, short `av-…` directory under the current user's temporary directory.
Keeping package paths short avoids Windows path-length failures during assembly
resolution; a deeply nested bundle-local package cache can restore successfully
and still fail compilation. Pass `-CacheRoot <existing-short-local-directory>` if
the machine has an unusually long temporary directory. No Windows configuration
change or administrator access is required. The cache path is checked for links
and retained after either success or failure. Package auditing and online certificate
revocation checks are disabled for this offline operation. Publish uses
`--no-restore`, produces a framework-dependent server in `app`, and requires the
installed .NET 10 runtime supplied with the SDK. The monitor is served from that
application's `wwwroot`; no development server is needed.

On Windows the same build also publishes the optional fullscreen desktop host to
`app/desktop`. Its one additional locked package, Microsoft.Web.WebView2, is in the
feed. The Windows SDK supplies the desktop targeting/apphost packs. Running this
host requires the .NET 10 Windows Desktop Runtime and an existing Microsoft Edge
WebView2 Runtime; this bundle does not install either runtime. Pass `-ServerOnly`
to omit the desktop build. See [desktop setup](desktop.md) for launch and security.

An existing `app` directory is preserved and stops another build. Rename it or
extract a fresh bundle before rebuilding. Failed restore caches and partial
outputs are retained for diagnosis. A local `.offline-build/<build-id>.json` record
stores the SDK, temporary cache location, and build outcome. This machine-specific
diagnostic record is created after extraction and is outside the immutable bundle
manifest; it is not included by the packager. The script does not install the SDK, alter
machine configuration, or delete existing output.

`bundle-manifest.json` identifies every bundled source, web asset, configuration,
and package using relative paths and SHA256 hashes. It also records the repository
base commit and each package's locked NuGet content hash. NuGet's canonical content
hash can differ from the raw SHA512 of a signed package ZIP: preparation checks the
cache's canonical hash against the lockfile and the ZIP against its SHA512 sidecar.
The fresh locked offline restore independently enforces NuGet's content hashes.
The manifest detects accidental changes; it is not a publisher signature. No
machine paths, credentials, or operator identity are included in the manifest.
