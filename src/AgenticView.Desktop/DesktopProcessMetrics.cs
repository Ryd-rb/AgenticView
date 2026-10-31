using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace AgenticView.Desktop;

// A diagnostic snapshot, not a process ownership or termination mechanism.
internal static class DesktopProcessMetrics
{
    internal static JsonObject Capture(CoreWebView2 core)
    {
        var rows=new JsonArray();var vanished=0;var inaccessible=0;int? reported=null;int? omitted=null;
        string? sdkUnavailable=null;
        void Read(int pid,string kind)
        {
            var row=new JsonObject{["pid"]=pid,["kind"]=kind};
            try{
                using var process=Process.GetProcessById(pid);process.Refresh();
                var memory=process.PrivateMemorySize64;var working=process.WorkingSet64;var cpu=process.TotalProcessorTime.TotalMilliseconds;
                if(process.HasExited){vanished++;row["state"]="vanished";}
                else{row["state"]="available";row["privateBytes"]=memory;row["workingSetBytes"]=working;row["cpuTotalMs"]=cpu;}
            }catch(ArgumentException){vanished++;row["state"]="vanished";}
            catch(InvalidOperationException){vanished++;row["state"]="vanished";}
            catch(Win32Exception){inaccessible++;row["state"]="unavailable";}
            catch(NotSupportedException){inaccessible++;row["state"]="unavailable";}
            rows.Add(row);
        }
        Read(Environment.ProcessId,"Host");
        try{
            // SDK scope is all processes sharing this environment's user-data folder,
            // excluding crashpad. Never enumerate arbitrary machine processes.
            var infos=core.Environment.GetProcessInfos();reported=infos.Count;
            var selected=infos.Where(info=>info.ProcessId!=Environment.ProcessId)
                .OrderBy(info=>info.Kind.ToString(),StringComparer.Ordinal).ThenBy(info=>info.ProcessId).Take(32).ToArray();
            omitted=Math.Max(0,infos.Count(info=>info.ProcessId!=Environment.ProcessId)-selected.Length);
            foreach(var info in selected)Read(info.ProcessId,info.Kind.ToString());
        }catch(Exception error) when(error is InvalidOperationException or System.Runtime.InteropServices.COMException){sdkUnavailable="WebView2 process list unavailable.";}
        return new JsonObject{
            ["sampledAtUtc"]=DateTimeOffset.UtcNow.ToString("O"),["logicalProcessorCount"]=Environment.ProcessorCount,["logicalProcessorCountScope"]="Processors available to this host process (Environment.ProcessorCount).",
            ["sdkReportedCount"]=reported,["omittedCount"]=omitted,["vanishedCount"]=vanished,["inaccessibleCount"]=inaccessible,
            ["processes"]=rows,["sdkUnavailable"]=sdkUnavailable,
            ["scope"]="Host plus at most 32 SDK-reported processes sharing the WebView2 user-data folder; crashpad excluded. Non-atomic read-only snapshot. cpuTotalMs is cumulative CPU across all threads since each process started, not interval utilization; divide CPU deltas by elapsed time and logicalProcessorCount for total-capacity utilization. Working sets include shared pages and must not be interpreted as unique resident memory. Unavailable counters are omitted, never substituted with zero."
        };
    }
}
