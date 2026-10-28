import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const sourceBinary = resolve(process.env.AV_TEST_SERVER || 'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll');
let directory: string, adapter: string, binary: string, serial = 0;
const scoped = { AV_URL: 'http://127.0.0.1:4317', AV_SESSION_ID: 'synthetic-session', AV_RUN_ID: 'synthetic-run', AV_SESSION_TOKEN: 'synthetic-session-only-token' };
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'agenticview-ssh-')); const emptySource = join(directory, 'empty-nuget'); mkdirSync(emptySource);
  const snapshot = join(directory, 'server'); cpSync(dirname(sourceBinary), snapshot, { recursive: true }); binary = join(snapshot, basename(sourceBinary));
  const project = join(directory, 'SyntheticSsh.csproj');
  writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>');
  writeFileSync(join(directory, 'Program.cs'), `using System.Diagnostics;using System.Reflection;using System.Text.Json;using System.Text.Json.Nodes;
if(args.Length>=3 && args[0] is "inspect" or "launch") {
 try {
  var assembly=Assembly.LoadFrom(args[1]);var method=assembly.GetType("AgenticView.Server.SessionSsh")!.GetMethod("BuildStart")!;
  var info=(ProcessStartInfo)method.Invoke(null,new object[]{JsonNode.Parse(File.ReadAllText(args[2]))!.AsObject()})!;
  if(args[0]=="inspect") {Console.WriteLine(JsonSerializer.Serialize(new {info.FileName,argv=info.ArgumentList.ToArray(),info.UseShellExecute,info.CreateNoWindow,info.RedirectStandardInput,info.RedirectStandardOutput,info.RedirectStandardError}));return 0;}
  using var child=Process.Start(info)!;var stdout=child.StandardOutput.ReadToEndAsync();var stderr=child.StandardError.ReadToEndAsync();
  await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream);child.StandardInput.Close();await child.WaitForExitAsync();Console.Write(await stdout);Console.Error.Write(await stderr);return child.ExitCode;
 } catch(Exception error) {Console.Error.WriteLine(error.InnerException?.Message??error.Message);return 2;}
}
var line=Console.ReadLine();Console.WriteLine(JsonSerializer.Serialize(new {argv=args,envelope=JsonNode.Parse(line??"{}")}));return 0;
`);
  for (const args of [['restore', project, '--source', emptySource, '--ignore-failed-sources', '--nologo'], ['build', project, '-c', 'Release', '--no-restore', '--nologo']]) {
    const result = spawnSync('dotnet', args, { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000 }); assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  adapter = join(directory, 'bin', 'Release', 'net10.0', process.platform === 'win32' ? 'SyntheticSsh.exe' : 'SyntheticSsh');
});
after(() => {
  if (!directory) return;
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('agenticview-ssh-') || lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe SSH test cleanup target');
  rmSync(directory, { recursive: true });
});
function profileFile(value: object) { const path = join(directory, `profile-${++serial}.json`); writeFileSync(path, JSON.stringify(value)); return path; }
function ssh(extra: object = {}) { return { type: 'agent-session', transport: 'ssh', provider: 'custom', sshHost: 'synthetic-private-alias', sshExecutable: adapter, remoteCommand: ['dotnet', '/private/Agentic View.dll', '--session-stdio', "/private/agent's profile.json"], ...extra }; }
function inspect(profile: object) {
  const path = profileFile(profile), result = spawnSync(adapter, ['inspect', binary, path], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1_000_000 });
  return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : undefined };
}
function localProfile(mode = 'finish') {
  const script = join(directory, `provider-${++serial}.cjs`);
  writeFileSync(script, `let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{const resume=process.argv[2]==='resume';console.log(JSON.stringify({type:'session',id:resume?process.argv[3]:'synthetic-native-new'}));console.log(JSON.stringify({type:'evidence',prompt,argv:process.argv.slice(2),environment:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase().startsWith('AV_'))),kept:process.env.SYNTHETIC_PROVIDER_SETTING,pid:process.pid}));console.error('synthetic raw stderr');${mode === 'hold' ? "const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({type:'descendant',pid:child.pid}));setInterval(()=>console.log('synthetic pulse'),100);" : ''}});`);
  return { type: 'agent-session', provider: 'custom', executable: process.execPath, workingDirectory: '.', arguments: [script, 'start'], resumeArguments: [script, 'resume', '{sessionId}'], environment: { AV_INGEST_KEY: 'synthetic-profile-global-ingest', AV_PROFILE_PRIVATE: 'synthetic-profile-value', SYNTHETIC_PROVIDER_SETTING: 'retained-local-provider-setting' } };
}
function bridge(profile: object, initial: object) {
  const child = spawn('dotnet', [binary, '--session-stdio', profileFile(profile)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AV_INGEST_KEY: 'synthetic-inherited-global-ingest', AV_PRIVATE_GLOBAL: 'synthetic-inherited-private-value' } });
  child.stdin.on('error', () => {});
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 1_000_000) child.kill(); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-10_000); });
  child.stdin.write(JSON.stringify(initial) + '\n');
  const safety = setTimeout(() => child.kill(), 27_000);
  const finished = once(child, 'exit').then(([code, signal]) => { clearTimeout(safety); return { code, signal, stdout, stderr }; });
  const rows = () => stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const waitFor = async (type: string) => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const row = rows().find(row => row.type === type); if (row) return row; if (child.exitCode !== null) break; await new Promise(done => setTimeout(done, 25)); } throw new Error(`No synthetic ${type} output: ${stderr}`); };
  const close = async () => { if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); const stop = setTimeout(() => child.kill(), 4000); try { await finished; } finally { clearTimeout(stop); } } };
  return { child, finished, rows, waitFor, close };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('SSH start quotes every fixed POSIX/PowerShell argument and keeps prompt/session credentials off argv', async () => {
  const fixed = ['dotnet', '/private/Agentic View.dll', '--session-stdio', "/private/agent's profile.json", '', '$(do-not-execute);`literal`'];
  const posix = inspect(ssh({ remoteCommand: fixed, sshPort: 2222 })); assert.equal(posix.status, 0, posix.stderr);
  assert.deepEqual(posix.value.argv, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', '2222', '--', 'synthetic-private-alias', "printf '%s\\n' '{\"agenticviewSshAuthenticated\":true}'; "+fixed.map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(' ')]);
  for (const flag of ['RedirectStandardInput', 'RedirectStandardOutput', 'RedirectStandardError', 'CreateNoWindow']) assert.equal(posix.value[flag], true); assert.equal(posix.value.UseShellExecute, false);
  const powershell = inspect(ssh({ remoteShell: 'powershell', remoteCommand: fixed, credentialEnabled: true, sshUsername: 'synthetic.user' })); assert.equal(powershell.status, 0, powershell.stderr);
  assert.deepEqual(powershell.value.argv.slice(0, 11), ['-T', '-o', 'BatchMode=no', '-o', 'ConnectTimeout=10', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-l', 'synthetic.user']);
  assert.equal(powershell.value.argv.at(-1), 'Write-Output \'{"agenticviewSshAuthenticated":true}\'; & ' + fixed.map(value => "'" + value.replaceAll("'", "''") + "'").join(' ')); assert.equal(powershell.value.argv.some((value: string) => /StrictHostKeyChecking|UserKnownHostsFile/.test(value)), false);
  const envelope = { prompt: 'synthetic private prompt; $(must stay data)', nativeSessionId: 'native-private-identity', environment: scoped };
  const result = spawnSync(adapter, ['launch', binary, profileFile(ssh())], { windowsHide: true, encoding: 'utf8', input: JSON.stringify(envelope) + '\n', timeout: 5000, maxBuffer: 1_000_000 }); assert.equal(result.status, 0, result.stderr); const capture = JSON.parse(result.stdout); assert.deepEqual(capture.envelope, envelope);
  for (const value of [envelope.prompt, envelope.nativeSessionId, scoped.AV_SESSION_TOKEN, 'synthetic password not passed to BuildStart']) assert.equal(JSON.stringify(capture.argv).includes(value), false);
});

test('SSH transport rejects host/options, shell and username injection before process launch', () => {
  for (const patch of [{ sshHost: '-oProxyCommand=bad' }, { sshHost: 'user@host' }, { sshHost: 'host name' }, { sshHost: 'host;bad' }, { sshUsername: 'name -o bad' }, { sshUsername: 'name;bad' }, { sshPort: 0 }, { sshPort: 65536 }, { remoteShell: 'cmd' }, { remoteCommand: [] }, { remoteCommand: ['dotnet', 'bad\0argument'] }]) {
    const result = inspect(ssh(patch)); assert.equal(result.status, 2, `accepted invalid SSH profile: ${JSON.stringify(patch)}`);
  }
});

test('remote stdio forwards raw provider output/native resume and strips global AV credentials', { timeout: 15_000 }, async () => {
  for (const nativeSessionId of [null, 'synthetic-existing-native']) {
    const session = bridge(localProfile(), { prompt: 'Exact synthetic prompt\nsecond line', nativeSessionId, environment: scoped });
    const heartbeat = setInterval(() => session.child.stdin.write('{"heartbeat":true}\n'), 5000);
    try {
      const evidence = await session.waitFor('evidence'); assert.equal(evidence.prompt, 'Exact synthetic prompt\nsecond line'); assert.deepEqual(evidence.environment, scoped); assert.equal(evidence.kept, 'retained-local-provider-setting'); assert.deepEqual(evidence.argv, nativeSessionId ? ['resume', nativeSessionId] : ['start']);
      const done = await session.finished; assert.equal(done.code, 0, done.stderr); assert.match(done.stderr, /synthetic raw stderr/); assert.equal(session.rows().find(row => row.type === 'session').id, nativeSessionId ?? 'synthetic-native-new'); assert.equal(done.stdout.includes('synthetic-inherited-global-ingest'), false); assert.equal(done.stdout.includes('synthetic-profile-global-ingest'), false);
    } finally { clearInterval(heartbeat); await session.close(); }
  }
});

test('remote EOF kills only the owned provider and its descendant; invalid envelopes never start it', { timeout: 15_000 }, async () => {
  const session = bridge(localProfile('hold'), { prompt: 'Synthetic held session', environment: scoped });
  try {
    const evidence = await session.waitFor('evidence'), descendant = await session.waitFor('descendant'); assert.equal(alive(evidence.pid), true); assert.equal(alive(descendant.pid), true);
    session.child.stdin.end(); const done = await session.finished; assert.notEqual(done.code, 0); assert.equal(alive(evidence.pid), false); assert.equal(alive(descendant.pid), false);
  } finally { await session.close(); }
  for (const initial of [{ prompt: 'Synthetic', environment: { ...scoped, AV_INGEST_KEY: 'must-not-enter-remote-session' } }, { prompt: 'Synthetic', environment: { ...scoped, AV_URL: 'http://user:password@127.0.0.1/' } }]) {
    const invalid = bridge(localProfile(), initial);
    try { const done = await invalid.finished; assert.equal(done.code, 2); assert.equal(invalid.rows().length, 0); assert.equal(done.stderr.includes('must-not-enter-remote-session'), false); assert.equal(done.stderr.includes('password@'), false); } finally { await invalid.close(); }
  }
  const nested = bridge({ ...localProfile(), transport: 'ssh' }, { prompt: 'Synthetic', environment: scoped });
  try { assert.equal((await nested.finished).code, 2); assert.equal(nested.rows().length, 0); } finally { await nested.close(); }
  const oversized = bridge(localProfile(), { prompt: 'x'.repeat(1_048_576), environment: scoped });
  try { assert.equal((await oversized.finished).code, 2); assert.equal(oversized.rows().length, 0); } finally { await oversized.close(); }
});

test('a disconnected stdout receiver stops the owned remote provider without waiting for its heartbeat lease', { timeout: 10_000 }, async () => {
  const session = bridge(localProfile('hold'), { prompt: 'Synthetic disconnected output', environment: scoped });
  const heartbeat = setInterval(() => session.child.stdin.write('{"heartbeat":true}\n'), 5000);
  let fallback: ReturnType<typeof setTimeout> | undefined, forced = false;
  try { const evidence = await session.waitFor('evidence'); await session.waitFor('descendant'); session.child.stdout.destroy(); fallback = setTimeout(() => { forced = true; session.child.stdin.end(); }, 4000); const done = await session.finished; assert.equal(forced, false, 'stdout loss itself must stop the provider'); assert.notEqual(done.code, 0); assert.equal(alive(evidence.pid), false); }
  finally { clearInterval(heartbeat); if (fallback) clearTimeout(fallback); await session.close(); }
});

test('a live SSH input without heartbeat is stopped after the fixed bounded lease', { timeout: 30_000 }, async () => {
  const session = bridge(localProfile('hold'), { prompt: 'Synthetic heartbeat expiry', environment: scoped });
  try { const evidence = await session.waitFor('evidence'), descendant = await session.waitFor('descendant'); const done = await session.finished; assert.notEqual(done.code, 0); assert.equal(alive(evidence.pid), false); assert.equal(alive(descendant.pid), false); }
  finally { await session.close(); }
});
