import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';
import { cardAppearanceSchema, cardIconNames, windowIconSchema } from '../shared/card-style.ts';
import { registerSchema, operationSchema } from '../shared/protocol.ts';
import { applicationManifestSchema } from '../shared/application-manifest.ts';

const icon = {icon:'chart',color:'#74d4c8',background:'#101722'};
const register = (requestId:string) => ({requestId,registrationKey:'synthetic-window-icon-private-registration-proof',agentId:requestId,name:'Synthetic window metadata',icon:'bot'});
const authored = () => ({schemaVersion:1,id:'synthetic-window-template',version:'1.0.0',name:'Synthetic authored window',permanent:true,icon:'folder',windowIcon:icon,bindings:[],actions:[],components:[{id:'value',title:'Synthetic value',kind:'metric',data:{value:1}}]});
const invalidIcons:unknown[] = [
  {},[],42,'chart',{icon:null},{icon:'not-a-native-symbol'},{icon:'chart',color:null},{icon:'chart',background:null},
  {icon:'chart',color:'red'},{icon:'chart',color:'#12345'},{icon:'chart',color:'#123456\n'},{icon:'chart',background:'#1234567'},
  {icon:'chart',path:'C:\\private\\icon.ico'},{icon:'chart',url:'https://example.invalid/icon.ico'},{icon:'chart',script:'not-supported'},
  JSON.parse('{"icon":"chart","__proto__":{}}'),
];

test('logical window configuration schemas are strict, bounded and retain explicit reset',()=>{
  for(const name of cardIconNames)assert.deepEqual(windowIconSchema.parse({icon:name}),{icon:name});
  assert.deepEqual(cardAppearanceSchema.parse({windowIcon:icon}),{windowIcon:icon});
  assert.deepEqual(cardAppearanceSchema.parse({windowIcon:null}),{windowIcon:null});
  assert.deepEqual(operationSchema.parse({op:'style',windowIcon:null}),{op:'style',windowIcon:null});
  assert.deepEqual(registerSchema.parse({...register('window-schema'),windowIcon:icon}).windowIcon,icon);
  assert.ok(applicationManifestSchema.safeParse(authored()).success);
  assert.ok(applicationManifestSchema.safeParse({...authored(),windowIcon:null}).success);
  for(const value of invalidIcons){
    assert.equal(windowIconSchema.safeParse(value).success,false,JSON.stringify(value));
    assert.equal(cardAppearanceSchema.safeParse({windowIcon:value}).success,false);
    assert.equal(operationSchema.safeParse({op:'style',windowIcon:value}).success,false);
    assert.equal(registerSchema.safeParse({...register('invalid-window-schema'),windowIcon:value}).success,false);
    assert.equal(applicationManifestSchema.safeParse({...authored(),windowIcon:value}).success,false);
  }
  assert.equal(cardAppearanceSchema.safeParse({}).success,false);
});

test('native, browser and server logical icon catalogues agree without rendering',async()=>{
  const native=spawnSync('dotnet',['run','--project','tests/AgenticView.Desktop.Contracts','-c','Release','--no-restore','--','--window-icon-catalog'],{encoding:'utf8',timeout:60_000,maxBuffer:1024*1024});
  assert.equal(native.status,0,native.stderr||native.error?.message);
  const line=native.stdout.split(/\r?\n/).find(value=>value.startsWith('["status"'));
  assert.ok(line,native.stdout);assert.deepEqual(JSON.parse(line),[...cardIconNames]);
  const f=await fixture(),mcp=new Client({name:'synthetic-window-catalogue',version:'1'});
  try{
    await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));
    const result=await mcp.callTool({name:'component_catalog',arguments:{}});assert.ok(!result.isError,JSON.stringify(result));
    const catalog=result.structuredContent as {cardStyle:{icons:string[]};windowIcon:{icons:string[];fields:string[]}};
    assert.deepEqual(catalog.cardStyle.icons,[...cardIconNames]);assert.deepEqual(catalog.windowIcon.icons,[...cardIconNames]);assert.deepEqual(catalog.windowIcon.fields,['icon','color','background']);
  }finally{await mcp.close().catch(()=>{});await f.close();}
});

test('scoped HTTP/MCP window settings preserve header icons and require viewer-native acknowledgements',async()=>{
  const f=await fixture(),mcp=new Client({name:'synthetic-window-controls',version:'1'});
  try{
    const a=await(await f.call('/api/agents/register',secrets.ingestToken,register('window-a'))).json();
    const b=await(await f.call('/api/agents/register',secrets.ingestToken,register('window-b'))).json();
    const credentials={runId:a.runId,runToken:a.runToken},path=`/api/agents/${a.runId}/style`,reportPath=`/api/agents/${a.runId}/window-icon/report`;
    const snapshot=async()=>{const response=await f.call('/api/snapshot',secrets.viewerToken);assert.equal(response.status,200);return (await response.json()).agents.find((agent:{id:string})=>agent.id===a.runId);};
    const initial=await snapshot();
    for(const token of ['',secrets.ingestToken,secrets.viewerToken,b.runToken])assert.ok([401,403].includes((await f.call(path,token,{windowIcon:icon},'PUT')).status));
    assert.equal((await f.call(path,a.runToken,{windowIcon:icon},'PUT')).status,200);
    const configured=await snapshot();assert.deepEqual(configured.windowIcon,icon);assert.equal(configured.icon,'bot');assert.equal(configured.windowIconRevision,1);assert.deepEqual(configured.layout,initial.layout);assert.deepEqual(configured.components,initial.components);assert.equal(configured.sequence,initial.sequence);
    for(const value of invalidIcons)assert.equal((await f.call(path,a.runToken,{windowIcon:value},'PUT')).status,400,JSON.stringify(value));
    assert.deepEqual((await snapshot()).windowIcon,icon,'Rejected metadata must not alter configuration');
    await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));
    const styled=await mcp.callTool({name:'card_style',arguments:{...credentials,icon:'terminal'}});assert.ok(!styled.isError,JSON.stringify(styled));
    const headerOnly=await snapshot();assert.equal(headerOnly.icon,'terminal');assert.deepEqual(headerOnly.windowIcon,icon);assert.equal(headerOnly.windowIconRevision,1);
    const denied=await mcp.callTool({name:'card_style',arguments:{...credentials,runToken:b.runToken,windowIcon:icon}});assert.equal(denied.isError,true);
    const status=async()=>{const response=await mcp.callTool({name:'card_window_icon_status',arguments:credentials});assert.ok(!response.isError,JSON.stringify(response));return response.structuredContent as {windowIcon:unknown;revision:number;windows:{windowId:string;processId:number;state:string;version:string;revision:number;observedAt:number}[]};};
    assert.deepEqual(await status(),{windowIcon:icon,revision:1,windows:[]},'Configuration is distinct from native application');
    const otherStatus=await mcp.callTool({name:'card_window_icon_status',arguments:{...credentials,runToken:b.runToken}});assert.equal(otherStatus.isError,true);
    const report={expected:icon,revision:1,windowId:'00000000-0000-4000-8000-000000000001',processId:123,state:'applied',version:'a'.repeat(64)};
    for(const token of ['',secrets.ingestToken,a.runToken,b.runToken])assert.equal((await f.call(reportPath,token,report)).status,401,'Run/report credentials must not impersonate a native viewer');
    assert.equal((await f.call(reportPath,secrets.viewerToken,report,'POST',{Origin:'https://other.example'})).status,403);
    const login=await f.call('/api/login','',{token:secrets.viewerToken,remember:true});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
    const accepted=await f.call(reportPath,'',report,'POST',{Cookie:cookie});assert.equal(accepted.status,200,await accepted.clone().text());
    const numericSpelling=await fetch(f.url+reportPath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(report).replace('"revision":1','"revision":1e0')});assert.equal(numericSpelling.status,200,'Whole JSON numbers accept equivalent exponent spelling');
    const native=await status();assert.equal(native.windows.length,1);assert.equal(native.windows[0]!.state,'applied');assert.equal(native.windows[0]!.revision,1);assert.ok(Number.isFinite(native.windows[0]!.observedAt));
    const observed=await snapshot();assert.equal(observed.windowIconReports.length,1);assert.equal(observed.windowIconReports[0].windowId,report.windowId);assert.equal(observed.windowIconRevision,1);
    assert.equal((await f.call(reportPath,secrets.viewerToken,{...report,state:'failed'})).status,200);assert.equal((await status()).windows.length,1,'Updates replace the same native window receipt');
    for(let i=2;i<=10;i++)assert.equal((await f.call(reportPath,secrets.viewerToken,{...report,windowId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`})).status,200);
    assert.equal((await status()).windows.length,8,'Native report history remains bounded independently of updates');
    for(const invalid of [{...report,revision:-1},{...report,revision:1.5},{...report,processId:0},{...report,state:'queued'},{...report,version:'C:\\private\\icon.ico'},{...report,windowId:'not-a-guid'},{...report,path:'private'}])assert.equal((await f.call(reportPath,secrets.viewerToken,invalid)).status,400);
    const updated=await mcp.callTool({name:'card_style',arguments:{...credentials,windowIcon:{icon:'layers'}}});assert.ok(!updated.isError,JSON.stringify(updated));
    assert.equal((await f.call(reportPath,secrets.viewerToken,report)).status,409,'Old native acknowledgement cannot certify a newer icon');
    assert.equal((await f.call(reportPath,secrets.viewerToken,{...report,expected:{icon:'layers'}})).status,409,'Matching value does not bypass stale revision');
    const conflict=await mcp.callTool({name:'card_style',arguments:{...credentials,windowIcon:icon,resetWindowIcon:true}});assert.equal(conflict.isError,true);
    const reset=await mcp.callTool({name:'card_style',arguments:{...credentials,resetWindowIcon:true}});assert.ok(!reset.isError,JSON.stringify(reset));
    const resetStatus=await status();assert.equal(resetStatus.windowIcon,null);assert.equal(resetStatus.revision,3);assert.equal((await snapshot()).icon,'terminal');
    assert.equal((await f.call(reportPath,secrets.viewerToken,{...report,expected:null,revision:3,version:'default'})).status,200);
    assert.ok(!JSON.stringify(await status()).includes(a.runToken),'Native status must not expose producer credentials');
    const operatorDenied=await mcp.callTool({name:'view_configure',arguments:{operatorToken:secrets.ingestToken,operation:'style',input:{cardId:a.runId,style:{windowIcon:icon}}}});assert.equal(operatorDenied.isError,true);
    const operator=await mcp.callTool({name:'view_configure',arguments:{operatorToken:secrets.viewerToken,operation:'style',input:{cardId:a.runId,style:{windowIcon:icon}}}});assert.ok(!operator.isError,JSON.stringify(operator));
    assert.deepEqual((await snapshot()).windowIcon,icon);assert.equal((await snapshot()).icon,'terminal');
  }finally{await mcp.close().catch(()=>{});await f.close();}
});

test('portable window icon definitions roundtrip independently of live receipts and persist across restart',async()=>{
  let f=await fixture();const directory=f.dir;
  try{
    const manifest=authored(),response=await f.call('/api/applications/import',secrets.ingestToken,{manifest,bindings:{},requestId:'portable-window',registrationKey:'synthetic-portable-window-private-proof'});assert.equal(response.status,200,await response.clone().text());
    const imported=await response.json(),path=`/api/agents/${imported.runId}/style`;
    let exported=await(await f.call(`/api/applications/${imported.runId}/export`,secrets.viewerToken)).json();assert.deepEqual(exported.windowIcon,icon);assert.equal(exported.icon,'folder');assert.ok(applicationManifestSchema.safeParse(exported).success);
    assert.equal((await f.call(path,imported.runToken,{windowIcon:{icon:'terminal'}},'PUT')).status,200);
    exported=await(await f.call(`/api/agents/${imported.runId}/application`,imported.runToken)).json();assert.deepEqual(exported.windowIcon,icon,'Export retains authored settings rather than runtime icon changes');assert.equal(exported.windowIconReports,undefined);assert.equal(exported.runToken,undefined);
    const reset={...manifest,version:'1.1.0',windowIcon:null};assert.equal((await f.call(`/api/agents/${imported.runId}/application`,imported.runToken,reset,'PUT')).status,200);
    await f.close(false);f=await fixture(directory);
    exported=await(await f.call(`/api/applications/${imported.runId}/export`,secrets.viewerToken)).json();assert.equal(exported.windowIcon,null);assert.equal(exported.icon,'folder');assert.equal(exported.version,'1.1.0');
    const live=(await(await f.call('/api/snapshot',secrets.viewerToken)).json()).agents.find((agent:{id:string})=>agent.id===imported.runId);assert.equal(live.windowIcon,null);assert.equal(live.icon,'folder');
    const invalid={...manifest,windowIcon:{icon:'chart',url:'https://example.invalid/icon.ico'}};assert.equal((await f.call('/api/applications/import',secrets.ingestToken,{manifest:invalid,bindings:{},requestId:'invalid-window-template',registrationKey:'synthetic-invalid-window-template-proof'})).status,400);
  }finally{await f.close(true);}
});
