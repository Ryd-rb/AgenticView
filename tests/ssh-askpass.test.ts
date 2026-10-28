import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,cpSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fixture,secrets} from './server-fixture.ts';
let dir:string,probe:string,binary:string;
before(()=>{
 dir=mkdtempSync(join(tmpdir(),'agenticview-askpass-'));const empty=join(dir,'empty');mkdirSync(empty);const project=join(dir,'Probe.csproj');
 writeFileSync(project,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>');
 writeFileSync(join(dir,'Program.cs'),`using System.Diagnostics;using System.Reflection;
if(args.FirstOrDefault()=="probe"){
 var assembly=Assembly.LoadFrom(args[1]);var start=new ProcessStartInfo {UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};
 await using var bridge=(IAsyncDisposable)Activator.CreateInstance(assembly.GetType("AgenticView.Server.SshAskpass")!,start,"synthetic-pipe-password")!;
 if(start.Environment.Values.Any(v=>v=="synthetic-pipe-password"))return 5;
 start.FileName=start.Environment["SSH_ASKPASS"]!;start.ArgumentList.Add(args.Length>2?args[2]:"Synthetic account password:");
 using var child=Process.Start(start)!;var stdout=child.StandardOutput.ReadToEndAsync();var stderr=child.StandardError.ReadToEndAsync();await child.WaitForExitAsync();Console.Write(await stdout);Console.Error.Write(await stderr);return child.ExitCode;
}
if(Environment.GetEnvironmentVariable("SYNTHETIC_SSH_MODE")=="bridge"){
var start=new ProcessStartInfo("dotnet"){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory,"AgenticView.Server.dll"));start.ArgumentList.Add("--session-stdio");start.ArgumentList.Add(Environment.GetEnvironmentVariable("SYNTHETIC_BRIDGE_PROFILE")!);
using var child=Process.Start(start)!;var input=Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream);var output=child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());var error=child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());await child.WaitForExitAsync();await Task.WhenAll(output,error);return child.ExitCode;}
if(Environment.GetEnvironmentVariable("SYNTHETIC_SSH_MODE")=="timeout"){Console.Error.WriteLine("ssh: connect to host synthetic port 22: Connection timed out");return 255;}
var helper=new ProcessStartInfo(Environment.GetEnvironmentVariable("SSH_ASKPASS")!){UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};helper.ArgumentList.Add("Synthetic account password:");
using(var child=Process.Start(helper)!){var password=await child.StandardOutput.ReadToEndAsync();await child.WaitForExitAsync();if(child.ExitCode!=0)return 6;Console.WriteLine("Diagnostic secret: "+password.Trim());}
Console.Error.WriteLine("synthetic@stage.example.invalid: Permission denied (password).");return 255;
`);
 for(const args of [['restore',project,'--source',empty,'--ignore-failed-sources','--nologo'],['build',project,'-c','Release','--no-restore','--nologo']]){const r=spawnSync('dotnet',args,{windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:2000000});assert.equal(r.status,0,r.stdout+r.stderr);}
 const output=join(dir,'bin','Release','net10.0');cpSync(dirname(resolve(process.env.AV_TEST_SERVER||'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll')),output,{recursive:true});
 probe=join(output,process.platform==='win32'?'Probe.exe':'Probe');binary=join(output,'AgenticView.Server.dll');
});
test('connector SSH envelope launches the real stdio bridge with exact scoped environment keys',async()=>{
 const f=await fixture();let worker:ReturnType<typeof spawn>|undefined;try{
  const script=join(f.dir,'agent.cjs');writeFileSync(script,`let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',async()=>{console.log(JSON.stringify({type:'session',id:'synthetic-ssh-native'}));const r=await fetch(process.env.AV_URL+'/api/sessions/'+process.env.AV_SESSION_ID+'/publish',{method:'POST',headers:{Authorization:'Bearer '+process.env.AV_SESSION_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({requestId:'bridge-plan',operations:[{op:'upsert',component:{id:'session-plan',title:'Current task list',kind:'markdown',data:{text:'- [x] Exact scoped environment verified'}}}]})});console.log(JSON.stringify({type:'output',format:'markdown',text:r.ok?'BRIDGE_REPORT_ACK':'REPORT_FAILED'}));process.exitCode=r.ok?0:1;});`);
  const remoteProfile=join(f.dir,'remote-profile.json');writeFileSync(remoteProfile,JSON.stringify({type:'agent-session',provider:'custom',executable:process.execPath,workingDirectory:f.dir,arguments:[script],resumeArguments:[script]}));
  await f.call('/api/ssh/machines',secrets.viewerToken,{id:'local-bridge',label:'Synthetic bridge',host:'bridge.example.invalid',connectorId:'bridge-worker',authentication:'agent'},'PUT');
  const a=await(await f.call('/api/agents/register',secrets.ingestToken,{requestId:'bridge-launcher',registrationKey:'synthetic-bridge-registration-proof-private',agentId:'bridge-launcher',name:'Bridge launcher'})).json();await f.call(`/api/agents/${a.runId}/controls`,a.runToken,{actions:[{id:'launch',label:'Bridge',kind:'session',target:'bridge-worker',handler:'bridge',fields:[]}]},'PUT');
  const s=await(await f.call('/api/sessions/draft',secrets.viewerToken,{requestId:'bridge-draft',launcherRunId:a.runId,actionId:'launch'})).json();
  const path=join(f.dir,'worker.json');writeFileSync(path,JSON.stringify({id:'bridge-worker',name:'Bridge worker',url:f.url,ingestionKey:secrets.ingestToken,registrationKey:'synthetic-bridge-registration-proof-private',handlers:{bridge:{type:'agent-session',provider:'custom',transport:'ssh',sshExecutable:probe,sshHost:'bridge.example.invalid',machineId:'local-bridge',remoteCommand:['fixed'],maxTurnSeconds:15}}}));
  worker=spawn('dotnet',[binary,'--connector',path],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,SYNTHETIC_SSH_MODE:'bridge',SYNTHETIC_BRIDGE_PROFILE:remoteProfile}});worker.stdout!.on('data',()=>{});worker.stderr!.on('data',()=>{});await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'bridge-start',operation:'start',prompt:'Verify SSH scope'});
  let record:any;const end=Date.now()+15000;while(Date.now()<end){record=await(await f.call(`/api/sessions/${s.id}`,secrets.viewerToken)).json();if(record.state==='completed'||record.state==='error')break;await new Promise(r=>setTimeout(r,100));}assert.equal(record.state,'completed',JSON.stringify(record));assert.equal(record.nativeSessionId,'synthetic-ssh-native');const output=await(await f.call(`/api/sessions/${s.id}/output`,secrets.viewerToken)).text();assert.match(output,/BRIDGE_REPORT_ACK/);
 }finally{if(worker&&worker.exitCode===null){const ended=once(worker,'exit');worker.kill();await ended;}await f.close();}
});
after(()=>{if(!dir)return;if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('agenticview-askpass-')||lstatSync(dir).isSymbolicLink())throw Error('Unsafe askpass cleanup');rmSync(dir,{recursive:true});});
test('password askpass uses the same-user pipe and refuses host-trust prompts without credentials in environment',()=>{
 const success=spawnSync(probe,['probe',binary],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(success.status,0,success.stderr);assert.equal(success.stdout.trim(),'synthetic-pipe-password');
 const trust=spawnSync(probe,['probe',binary,'Are you sure you want to continue connecting?'],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(trust.status,1);assert.equal(trust.stdout,'');
});
for(const mode of ['auth','timeout'])test(`SSH ${mode} invalidates only confirmed rejected authentication and redacts diagnostics`,async()=>{
 const f=await fixture();let worker:ReturnType<typeof spawn>|undefined;
 try{
  const machine=await(await f.call('/api/ssh/machines',secrets.viewerToken,{id:'stage',label:'Synthetic machine',host:'stage.example.invalid',connectorId:'ssh-worker',username:'synthetic',password:'synthetic-pipe-password'},'PUT')).json();assert.ok(machine.credentialId);
  const a=await(await f.call('/api/agents/register',secrets.ingestToken,{requestId:'ssh-launcher',registrationKey:'synthetic-ssh-registration-proof-private',agentId:'ssh-launcher',name:'Synthetic SSH launcher'})).json();
  await f.call(`/api/agents/${a.runId}/controls`,a.runToken,{actions:[{id:'launch',label:'Synthetic SSH',kind:'session',target:'ssh-worker',handler:'ssh',fields:[]}]},'PUT');
  const s=await(await f.call('/api/sessions/draft',secrets.viewerToken,{requestId:'ssh-draft',launcherRunId:a.runId,actionId:'launch'})).json();
  const path=join(f.dir,'worker.json');writeFileSync(path,JSON.stringify({id:'ssh-worker',name:'Synthetic SSH worker',url:f.url,ingestionKey:secrets.ingestToken,registrationKey:'synthetic-ssh-registration-proof-private',handlers:{ssh:{type:'agent-session',provider:'custom',transport:'ssh',sshExecutable:probe,sshHost:'stage.example.invalid',machineId:'stage',remoteCommand:['synthetic-fixed-remote-command'],maxTurnSeconds:15}}}));
  worker=spawn('dotnet',[binary,'--connector',path],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,SYNTHETIC_SSH_MODE:mode}});let logs='';worker.stdout!.on('data',()=>{});worker.stderr!.on('data',v=>logs+=v);
  await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'ssh-start',operation:'start',prompt:'Synthetic SSH authentication test'});
  let state:any;const end=Date.now()+20000;while(Date.now()<end){state=await(await f.call(`/api/sessions/${s.id}`,secrets.viewerToken)).json();if(state.state==='error')break;await new Promise(r=>setTimeout(r,100));}assert.equal(state.state,'error',JSON.stringify(state)+' '+logs);
  const saved=await(await f.call('/api/ssh/machines',secrets.viewerToken)).json();assert.equal(saved.machines[0].valid,mode!=='auth');
  if(mode==='auth'){assert.equal(state.recoveryCount,0);assert.match(state.message,/credentials/);}
  const output=await(await f.call(`/api/sessions/${s.id}/output`,secrets.viewerToken)).text();assert.ok(!output.includes('synthetic-pipe-password'));assert.ok(!logs.includes('synthetic-pipe-password'));
 }finally{if(worker&&worker.exitCode===null){const exit=once(worker,'exit');worker.kill();await exit;}await f.close();}
});
