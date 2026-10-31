<#
.SYNOPSIS
Passive, bounded Windows process-tree resource sampling. Does not drive UI or attach a debugger.
.DESCRIPTION
Manifest: {"schemaVersion":1,"roots":[{"pid":123,"executable":"C:\\app.exe",
"creationUtc":"2026-10-31T12:00:00.0000000Z","role":"host"}]}. Roles: host/server/provider.
Use Win32_Process.CreationDate.ToUniversalTime().ToString('o') when authoring identities.
Creation times compare at millisecond precision. Root additions are supported; replacements/removals fail closed.
CPU is interval CPU seconds / elapsed seconds: singleCorePercent can exceed 100; totalCorePercent
divides by logical processors. Summed working sets double-count shared pages. This is not rendering,
click latency, GPU, allocation, or stack profiling. Very short processes between snapshots are missed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidateRange(1,7200)][int]$DurationSeconds=3600,
    [ValidateRange(1,60)][int]$IntervalSeconds=5
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'This passive sampler requires Windows CIM process counters.'}

function Read-Manifest {
    $item=Get-Item -LiteralPath $ManifestPath
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536){throw 'Root manifest must be a regular file no larger than 64KiB.'}
    $raw=[IO.File]::ReadAllText($item.FullName)
    $document=[Text.Json.JsonDocument]::Parse($raw)
    try {
        # ConvertFrom-Json silently accepts duplicate keys; reject them before conversion.
        $objects=[Collections.Generic.List[Text.Json.JsonElement]]::new();$objects.Add($document.RootElement)
        for($i=0;$i -lt $objects.Count;$i++){
            $element=$objects[$i]
            if($element.ValueKind -eq [Text.Json.JsonValueKind]::Object){
                $keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                foreach($property in $element.EnumerateObject()){
                    if(-not $keys.Add($property.Name)){throw 'Duplicate manifest object key.'}
                    if($property.Value.ValueKind -in @([Text.Json.JsonValueKind]::Object,[Text.Json.JsonValueKind]::Array)){$objects.Add($property.Value)}
                }
            }elseif($element.ValueKind -eq [Text.Json.JsonValueKind]::Array){foreach($child in $element.EnumerateArray()){if($child.ValueKind -eq [Text.Json.JsonValueKind]::Object){$objects.Add($child)}}}
        }
    }finally{$document.Dispose()}
    $value=ConvertFrom-Json -InputObject $raw -AsHashtable -DateKind String
    if($value -isnot [Collections.IDictionary] -or $value.Count -ne 2 -or -not $value.Contains('schemaVersion') -or ($value.schemaVersion -isnot [long] -and $value.schemaVersion -isnot [int]) -or $value.schemaVersion -ne 1 -or -not $value.Contains('roots') -or $value.roots -isnot [array] -or $value.roots.Count -lt 1 -or $value.roots.Count -gt 32){throw 'Invalid root manifest schema.'}
    $seen=[Collections.Generic.HashSet[int]]::new()
    foreach($root in $value.roots){
        if($root -isnot [Collections.IDictionary] -or $root.Count -ne 4 -or @($root.Keys|Where-Object{$_ -notin @('pid','executable','creationUtc','role')}).Count){throw 'Invalid root identity keys.'}
        if($root.pid -isnot [long] -and $root.pid -isnot [int]){throw 'Root pid must be an integer.'}
        if($root.pid -lt 1 -or $root.pid -gt [int]::MaxValue -or -not $seen.Add([int]$root.pid)){throw 'Invalid or duplicate root pid.'}
        if($root.executable -isnot [string] -or $root.executable.Length -gt 32768 -or -not [IO.Path]::IsPathFullyQualified($root.executable)){throw 'Root executable must be an absolute file path.'}
        if($root.role -notin @('host','server','provider')){throw 'Root role must be host, server or provider.'}
        if($root.creationUtc -isnot [string] -or $root.creationUtc -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$'){throw 'Root creationUtc must be an ISO UTC timestamp ending Z.'}
        $birth=[DateTimeOffset]::Parse($root.creationUtc,[Globalization.CultureInfo]::InvariantCulture)
        $root.creationMilliseconds=[long][Math]::Floor($birth.UtcTicks/10000)
        $root.executable=[IO.Path]::GetFullPath($root.executable)
    }
    return ,$value.roots
}
function Identity($process){return ([string]$process.ProcessId)+':'+([string]([long][Math]::Floor($process.CreationDate.ToUniversalTime().Ticks/10000)))}
function Matches($process,$root){return (Identity $process) -eq ([string]$root.pid+':'+[string]$root.creationMilliseconds) -and [StringComparer]::OrdinalIgnoreCase.Equals([string]$process.ExecutablePath,$root.executable)}
function Write-Json($path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))}
function Quantiles($values){
    $sorted=@($values|Sort-Object)
    if(-not $sorted.Count){return @{count=0;p50=$null;p95=$null;peak=$null}}
    return @{count=$sorted.Count;p50=$sorted[[Math]::Max(0,[Math]::Ceiling($sorted.Count*.5)-1)];p95=$sorted[[Math]::Max(0,[Math]::Ceiling($sorted.Count*.95)-1)];peak=$sorted[-1]}
}

$runDirectory=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ('process-tree-'+[guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($runDirectory)
$samplesPath=Join-Path $runDirectory 'samples.jsonl';$summaryPath=Join-Path $runDirectory 'summary.json'
$started=[DateTimeOffset]::UtcNow;$watch=[Diagnostics.Stopwatch]::StartNew();$logicalProcessors=0
$metadata=@{schemaVersion=1;startedUtc=$started.ToString('o');durationSeconds=$DurationSeconds;intervalSeconds=$IntervalSeconds;logicalProcessors=$logicalProcessors;pid=$PID;powerShell=$PSVersionTable.PSVersion.ToString();scriptSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();cpu='Delta kernel+user CPU seconds; singleCorePercent=100*CPU/wall; totalCorePercent=singleCorePercent/logicalProcessors';memory='PrivatePageCount bytes; WorkingSetSize sum may double-count shared pages';limitations=@('Polling can miss processes born and exited between samples','CPU for exited processes after their last snapshot is unavailable','Newly discovered existing processes require a CPU baseline','No rendering/click/GPU/frame-rate measurements');manifestPath=[IO.Path]::GetFullPath($ManifestPath)}
Write-Json (Join-Path $runDirectory 'metadata.json') $metadata
$knownRoots=@{};$tracked=@{};$previous=@{};$observations=[Collections.Generic.List[object]]::new();$failure=$null;$maxSamples=[Math]::Ceiling($DurationSeconds/$IntervalSeconds)+1
$writer=[IO.StreamWriter]::new($samplesPath,$false,[Text.UTF8Encoding]::new($false));$writer.AutoFlush=$true
try {
    $logicalProcessors=[int](Get-CimInstance -ClassName Win32_ComputerSystem -Property NumberOfLogicalProcessors -OperationTimeoutSec 10).NumberOfLogicalProcessors
    if($logicalProcessors -lt 1){throw 'Cannot verify total system logical processor count.'}
    $metadata.logicalProcessors=$logicalProcessors;Write-Json (Join-Path $runDirectory 'metadata.json') $metadata
    for($sampleIndex=0;$sampleIndex -lt $maxSamples;$sampleIndex++){
        $due=[Math]::Min($DurationSeconds,$sampleIndex*$IntervalSeconds)
        $wait=$due-$watch.Elapsed.TotalSeconds
        if($wait -gt 0){Start-Sleep -Milliseconds ([int][Math]::Ceiling($wait*1000))}
        $sampleWatch=[Diagnostics.Stopwatch]::StartNew();$errors=[Collections.Generic.List[string]]::new()
        $roots=Read-Manifest
        foreach($old in @($knownRoots.Values)){
            if(-not @($roots|Where-Object{$_.pid -eq $old.pid}).Count){throw 'Previously accepted root was removed from the manifest.'}
        }
        foreach($root in $roots){
            if($knownRoots.ContainsKey([int]$root.pid)){
                $old=$knownRoots[[int]$root.pid]
                if($old.creationMilliseconds -ne $root.creationMilliseconds -or $old.role -ne $root.role -or -not [StringComparer]::OrdinalIgnoreCase.Equals($old.executable,$root.executable)){throw 'Previously accepted root identity/role changed.'}
            }
        }
        # Do not retrieve CommandLine, environment, credentials or unrelated process payloads.
        $snapshot=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,KernelModeTime,UserModeTime,PrivatePageCount,WorkingSetSize -OperationTimeoutSec 10)
        $byPid=@{};foreach($process in $snapshot){$byPid[[int]$process.ProcessId]=$process}
        $owned=@{};$rootStates=@()
        foreach($root in $roots){
            $process=$byPid[[int]$root.pid]
            if($null -eq $process){
                if(-not $knownRoots.ContainsKey([int]$root.pid)){throw 'New root is not running; cannot verify its identity.'}
                $rootStates+=@{pid=$root.pid;role=$root.role;state='not-observed-exited'};continue
            }
            if($null -eq $process.CreationDate -or -not (Matches $process $root)){throw 'Root executable or creation time mismatch; sampling stopped without adopting the replacement.'}
            $knownRoots[[int]$root.pid]=$root;$owned[[int]$root.pid]=@{process=$process;rootPid=[int]$root.pid;role=$root.role}
            $rootStates+=@{pid=$root.pid;role=$root.role;state='verified'}
        }
        # Keep a previously verified descendant after its parent exits, but never adopt a reused PID.
        foreach($process in $snapshot){
            if($null -eq $process.CreationDate -or -not $process.ExecutablePath){continue}
            $identity=Identity $process
            if(-not $owned.ContainsKey([int]$process.ProcessId) -and $tracked.ContainsKey($identity)){
                $old=$tracked[$identity]
                if([StringComparer]::OrdinalIgnoreCase.Equals($old.executable,[string]$process.ExecutablePath)){$owned[[int]$process.ProcessId]=@{process=$process;rootPid=$old.rootPid;role=$old.role}}
            }
        }
        # Resolve parents before children; explicit roots take precedence over inherited roles.
        $ordered=@($snapshot|Where-Object{$null -ne $_.CreationDate}|Sort-Object CreationDate)
        for($depth=0;$depth -lt 64;$depth++){
            $added=0
            foreach($process in $ordered){
                $id=[int]$process.ProcessId
                if($owned.ContainsKey($id) -or -not $process.ExecutablePath){continue}
                $parent=$owned[[int]$process.ParentProcessId]
                if($null -eq $parent -or $parent.process.CreationDate -gt $process.CreationDate){continue}
                $owned[$id]=@{process=$process;rootPid=$parent.rootPid;role=$parent.role};$added++
            }
            if(-not $added){break}
        }
        # A newly added explicit root can reclassify descendants previously inherited from another root.
        for($depth=0;$depth -lt 64;$depth++){
            $changed=0
            foreach($entry in $owned.Values){
                if($knownRoots.ContainsKey([int]$entry.process.ProcessId)){continue}
                $parent=$owned[[int]$entry.process.ParentProcessId]
                if($null -ne $parent -and $parent.process.CreationDate -le $entry.process.CreationDate -and ($entry.role -ne $parent.role -or $entry.rootPid -ne $parent.rootPid)){$entry.role=$parent.role;$entry.rootPid=$parent.rootPid;$changed++}
            }
            if(-not $changed){break}
        }
        if($owned.Count -gt 4096){throw 'Owned process cap exceeded (4096); refusing unbounded telemetry.'}
        $elapsed=$watch.Elapsed.TotalSeconds;$cpuInterval=if($observations.Count){$elapsed-$observations[-1].elapsedSeconds}else{$null}
        $groups=@{};foreach($role in @('host','server','provider')){$groups[$role]=@{role=$role;processCount=0;cpuSeconds=0.0;cpuMeasuredProcesses=0;unobservedExitedProcesses=0;privateBytes=[long]0;workingSetBytes=[long]0;singleCorePercent=$null;totalCorePercent=$null}}
        $details=@();$current=@{}
        foreach($entry in @($owned.Values|Sort-Object {$_.process.ProcessId})){
            $process=$entry.process;$identity=Identity $process;$cpu=([double]$process.KernelModeTime+[double]$process.UserModeTime)/10000000
            $group=$groups[$entry.role];$group.processCount++;$group.privateBytes+=[long]$process.PrivatePageCount;$group.workingSetBytes+=[long]$process.WorkingSetSize
            $delta=$null
            if($previous.ContainsKey($identity)){
                $delta=$cpu-$previous[$identity]
                if($delta -lt 0){$errors.Add('Owned process CPU counter decreased; interval omitted.');$delta=$null}
            }elseif($null -ne $cpuInterval -and ($process.CreationDate.ToUniversalTime()-$started.UtcDateTime).TotalSeconds -ge $observations[-1].elapsedSeconds){$delta=$cpu}
            if($null -ne $delta){$group.cpuSeconds+=$delta;$group.cpuMeasuredProcesses++}
            $current[$identity]=$cpu;$tracked[$identity]=@{rootPid=$entry.rootPid;role=$entry.role;executable=[string]$process.ExecutablePath}
            $details+=@{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;rootPid=$entry.rootPid;role=$entry.role;executable=[string]$process.ExecutablePath;creationUtc=$process.CreationDate.ToUniversalTime().ToString('o');cpuSeconds=$cpu;cpuDeltaSeconds=$delta;privateBytes=[long]$process.PrivatePageCount;workingSetBytes=[long]$process.WorkingSetSize}
        }
        foreach($identity in $previous.Keys){if(-not $current.ContainsKey($identity)){$groups[$tracked[$identity].role].unobservedExitedProcesses++}}
        foreach($group in $groups.Values){if($null -ne $cpuInterval -and $cpuInterval -gt 0 -and $group.cpuMeasuredProcesses -eq $group.processCount -and $group.unobservedExitedProcesses -eq 0){$group.singleCorePercent=100*$group.cpuSeconds/$cpuInterval;$group.totalCorePercent=$group.singleCorePercent/$logicalProcessors}}
        # Keep process identity state bounded to the currently observed owned processes.
        $liveTracked=@{};foreach($identity in $current.Keys){$liveTracked[$identity]=$tracked[$identity]};$tracked=$liveTracked;$previous=$current
        $sample=@{index=$sampleIndex;utc=[DateTimeOffset]::UtcNow.ToString('o');elapsedSeconds=$elapsed;cpuIntervalSeconds=$cpuInterval;sampleDurationMs=$sampleWatch.Elapsed.TotalMilliseconds;roots=$rootStates;roles=@($groups.Values|Sort-Object role);processes=$details;errors=@($errors)}
        $line=$sample|ConvertTo-Json -Depth 12 -Compress
        if([Text.Encoding]::UTF8.GetByteCount($line) -gt 4194304 -or $writer.BaseStream.Position -gt 268435456){throw 'Bounded sample/output byte cap reached; partial evidence retained.'}
        $writer.WriteLine($line)
        $observations.Add(@{elapsedSeconds=$elapsed;roles=$sample.roles})
        if($elapsed -ge $DurationSeconds){break}
    }
}catch{
    $failure=$_.Exception.Message
    $writer.WriteLine((@{type='error';utc=[DateTimeOffset]::UtcNow.ToString('o');elapsedSeconds=$watch.Elapsed.TotalSeconds;error=$failure}|ConvertTo-Json -Compress))
}finally{$writer.Dispose()}
$roleSummaries=@()
foreach($role in @('host','server','provider')){
    $values=@($observations|ForEach-Object{$_.roles|Where-Object{$_.role -eq $role}})
    $roleSummaries+=@{role=$role;singleCorePercent=(Quantiles @($values|Where-Object{$null -ne $_.singleCorePercent}|ForEach-Object{$_.singleCorePercent}));totalCorePercent=(Quantiles @($values|Where-Object{$null -ne $_.totalCorePercent}|ForEach-Object{$_.totalCorePercent}));privateBytes=(Quantiles @($values|ForEach-Object{$_.privateBytes}));workingSetBytes=(Quantiles @($values|ForEach-Object{$_.workingSetBytes}));peakProcessCount=if($values.Count){($values.processCount|Measure-Object -Maximum).Maximum}else{0}}
}
$summary=@{schemaVersion=1;status=if($failure){'failed'}else{'completed'};startedUtc=$started.ToString('o');endedUtc=[DateTimeOffset]::UtcNow.ToString('o');elapsedSeconds=$watch.Elapsed.TotalSeconds;sampleCount=$observations.Count;maxSamples=$maxSamples;logicalProcessors=$logicalProcessors;roles=$roleSummaries;error=$failure;quantiles='Nearest-rank over samples; no warmup exclusion. CPU excludes first baseline and unavailable deltas.';limitations=$metadata.limitations;memory=$metadata.memory;samplesPath=$samplesPath;metadataPath=(Join-Path $runDirectory 'metadata.json')}
Write-Json $summaryPath $summary
@{status=$summary.status;summaryPath=$summaryPath;samplesPath=$samplesPath;sampleCount=$observations.Count}|ConvertTo-Json -Compress
if($failure){exit 1}
