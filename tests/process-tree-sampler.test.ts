import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,readdirSync,cpSync,mkdirSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname,basename } from 'node:path';

test('passive process sampler verifies owned ancestry, additive provider roots, exit and identity rejection',{skip:process.platform!=='win32',timeout:50000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'agenticview-process-sampler-'));
  const pwsh=process.env.PWSH_EXE||'pwsh';
  const childScript=join(directory,'finite-child.cjs'),parentScript=join(directory,'finite-parent.cjs'),receipt=join(directory,'child-exited.txt'),childPidPath=join(directory,'child-pid.txt'),releasePath=join(directory,'release-fixture.txt');
  writeFileSync(childScript,"const fs=require('node:fs');const finish=reason=>{fs.writeFileSync(process.argv[2],reason);process.exit(0)};setInterval(()=>{if(fs.existsSync(process.argv[3]))finish('natural exit')},50);setTimeout(()=>finish('hard lifetime reached'),20000);");
  writeFileSync(parentScript,"const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[5]],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(process.argv[4],String(child.pid));const hard=setTimeout(()=>{},25000);child.on('exit',()=>clearTimeout(hard));child.unref();");
  const parent=spawn(process.execPath,[parentScript,childScript,receipt,childPidPath,releasePath],{windowsHide:true,stdio:'ignore'});
  const parentExit=once(parent,'exit');
  const manifest=join(directory,'roots.json'),manifestScript=join(directory,'manifest.ps1');
  writeFileSync(manifestScript,`param([int]$TargetPid,[string]$Destination,[int]$ProviderPid=0)
$ErrorActionPreference='Stop'
$roots=@();foreach($entry in @(@{Id=$TargetPid;Role='host'},@{Id=$ProviderPid;Role='provider'})){if(!$entry.Id){continue};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$entry.Id) -Property ProcessId,CreationDate,ExecutablePath;if(!$p){throw 'Owned fixture process missing'};$roots+=@{pid=[int]$p.ProcessId;executable=$p.ExecutablePath;creationUtc=$p.CreationDate.ToUniversalTime().ToString('o');role=$entry.Role}}
$temp=$Destination+'.next';@{schemaVersion=1;roots=$roots}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $temp;Move-Item -LiteralPath $temp -Destination $Destination -Force
`);
  const makeManifest=(root:number,provider=0)=>{const result=spawnSync(pwsh,['-NoProfile','-File',manifestScript,String(root),manifest,String(provider)],{windowsHide:true,encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);};
  let sampler:ReturnType<typeof spawn>|undefined;
  let completed=false;
  const retain=()=>{
    const destination=process.env.AV_PROCESS_SAMPLER_TEST_EVIDENCE;
    if(destination){mkdirSync(destination,{recursive:true});cpSync(directory,join(destination,basename(directory)),{recursive:true});}
  };
  try{
    for(let attempt=0;attempt<100&&!existsSync(childPidPath);attempt++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(parent.pid);const providerPid=Number(readFileSync(childPidPath,'utf8'));makeManifest(parent.pid);
    sampler=spawn(pwsh,['-NoProfile','-File',resolve('scripts/measure-process-tree.ps1'),'-ManifestPath',manifest,'-OutputDirectory',directory,'-DurationSeconds','9','-IntervalSeconds','1'],{windowsHide:true,stdio:'pipe'});
    let stdout='',stderr='';sampler.stdout!.on('data',chunk=>stdout+=chunk);sampler.stderr!.on('data',chunk=>stderr+=chunk);const samplerExit=once(sampler,'exit');
    // File creation is not a sample acknowledgment: the writer may not have appended
    // its first complete line yet. Read only newline-terminated records, with a deadline.
    const waitForSample=async(predicate:(sample:any)=>boolean,label:string)=>{
      const deadline=Date.now()+10000;let complete=0;
      while(Date.now()<deadline){
        const run=readdirSync(directory).find(name=>name.startsWith('process-tree-'));
        const path=run&&join(directory,run,'samples.jsonl');
        if(path&&existsSync(path)){
          const raw=readFileSync(path,'utf8'),end=raw.lastIndexOf('\n');
          const lines=end<0?[]:raw.slice(0,end).split('\n').filter(line=>line.trim());complete=lines.length;
          for(const line of lines){const sample=JSON.parse(line);if(predicate(sample))return sample;}
        }
        if(sampler!.exitCode!==null)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      writeFileSync(join(directory,'sample-wait-failure.json'),JSON.stringify({label,complete,exitCode:sampler!.exitCode,stdout,stderr},null,2));
      assert.fail(`No ${label} acknowledged within10seconds; completeSamples=${complete}; fixture retained at ${directory}`);
    };
    const first=await waitForSample(sample=>sample.processes.some((entry:any)=>entry.pid===providerPid),'owned-child sample');
    const observed=first.processes.find((entry:any)=>entry.pid===providerPid);assert.ok(observed);
    const updated=JSON.parse(readFileSync(manifest,'utf8'));updated.roots.push({pid:providerPid,executable:observed.executable,creationUtc:observed.creationUtc,role:'provider'});writeFileSync(manifest+'.next',JSON.stringify(updated));renameSync(manifest+'.next',manifest);
    await waitForSample(sample=>sample.roles.some((role:any)=>role.role==='provider'&&role.processCount>=1),'reloaded provider-root sample');
    // Release only after both identity/ancestry and reclassification were observed.
    // The fixture still exits itself, with independent20/25second hard lifetimes.
    writeFileSync(releasePath,'provider root acknowledged');
    const [code]=await samplerExit;
    writeFileSync(join(directory,'sampler-exit.json'),JSON.stringify({code,stdout,stderr},null,2));retain();
    assert.equal(code,0,`Fixture retained at ${directory}\n${stderr}${stdout}`);
    const output=JSON.parse(stdout.trim()),summary=JSON.parse(readFileSync(output.summaryPath,'utf8'));
    assert.equal(summary.status,'completed');assert.ok(summary.elapsedSeconds>=9&&summary.elapsedSeconds<15);assert.ok(summary.sampleCount>=3&&summary.sampleCount<=10);
    const samples=readFileSync(output.samplesPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    if(process.env.AV_PROCESS_SAMPLER_TEST_EVIDENCE)writeFileSync(join(process.env.AV_PROCESS_SAMPLER_TEST_EVIDENCE,'worker-process-sampler-smoke.json'),JSON.stringify({summary,samples,metadata:JSON.parse(readFileSync(summary.metadataPath,'utf8'))},null,2));
    assert.equal(samples.length,summary.sampleCount);assert.ok(samples.every(sample=>sample.processes.every((entry:any)=>[parent.pid,providerPid].includes(entry.pid)||(basename(entry.executable).toLowerCase()==='conhost.exe'&&[parent.pid,providerPid].includes(entry.parentPid)))),'Only owned fixture nodes and their Windows console descendants are measured');
    assert.ok(samples.some(sample=>sample.roles.find((role:any)=>role.role==='host').processCount>=2),'Live ancestry includes the owned child before manifest addition');
    assert.ok(samples.some(sample=>sample.roles.find((role:any)=>role.role==='provider').processCount>=1),'Reloaded explicit provider root is classified separately');
    assert.ok(samples.some(sample=>sample.roots.some((root:any)=>root.pid===parent.pid&&root.state==='not-observed-exited')),'Natural root exit is recorded truthfully');
    const measured=samples.flatMap(sample=>sample.roles).filter(role=>role.singleCorePercent!==null);
    assert.ok(measured.length>0);assert.ok(measured.every(role=>role.singleCorePercent>=0&&Math.abs(role.totalCorePercent*summary.logicalProcessors-role.singleCorePercent)<1e-7));
    assert.ok(summary.roles.find((role:any)=>role.role==='host').privateBytes.peak>0);
    assert.match(summary.memory,/double-count shared pages/);
    await parentExit;
    for(let attempt=0;attempt<100&&!existsSync(receipt);attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(readFileSync(receipt,'utf8'),'natural exit','Owned child exits naturally; sampler never terminates it');
    makeManifest(process.pid);const bad=JSON.parse(readFileSync(manifest,'utf8'));bad.roots[0].executable=join(directory,'not-the-process.exe');writeFileSync(manifest,JSON.stringify(bad));
    const rejected=spawnSync(pwsh,['-NoProfile','-File',resolve('scripts/measure-process-tree.ps1'),'-ManifestPath',manifest,'-OutputDirectory',directory,'-DurationSeconds','1','-IntervalSeconds','1'],{windowsHide:true,encoding:'utf8',timeout:5000});
    assert.equal(rejected.status,1,rejected.stderr);const rejectedSummary=JSON.parse(readFileSync(JSON.parse(rejected.stdout.trim()).summaryPath,'utf8'));
    assert.equal(rejectedSummary.status,'failed');assert.equal(rejectedSummary.sampleCount,0);assert.match(rejectedSummary.error,/mismatch/);
    completed=true;
  }finally{
    retain();
    // A failed assertion must never erase the diagnostic receipt or finite fixture.
    if(completed&&parent.exitCode!==null&&(!sampler||sampler.exitCode!==null)&&existsSync(receipt)){
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('agenticview-process-sampler-'));rmSync(directory,{recursive:true});
    }
  }
});
