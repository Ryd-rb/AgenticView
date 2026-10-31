import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { fixture,secrets } from './server-fixture.ts';
import { linkedDataSchema,linkedStyleSchema,rootForRow,visibleLinkedRows,associationLanes,formatLinkedValue,type LinkedData,type LinkedRow } from '../shared/linked-workbench.ts';

const nonTrading=():LinkedData=>({
  title:'Build evidence',entities:[{id:'project',label:'Project',plural:'Projects'},{id:'job',label:'Job',color:'#aabbcc',dash:'dash'},{id:'artifact',label:'Artifact',marker:'square'},{id:'annotation',label:'Annotation'}],
  columns:[{key:'name',label:'Name',fields:['label']},{key:'size',label:'Size',fields:['bytes'],format:'number',scale:1000,decimals:0,smallDecimals:2,suffix:' kB',decimalsField:'precision'}],
  rows:[{id:'p',kind:'project',status:'investigating',time:1000,values:{owner:'Synthetic'}},{id:'j',parentId:'p',kind:'job',status:'awaiting-review',time:500,values:{bytes:-1500}},{id:'a',parentId:'j',kind:'artifact',time:300,values:{bytes:2000}},{id:'n',parentId:'a',kind:'annotation',status:'accepted',time:50,values:{comment:'needle',approved:true,optional:null}},{id:'other',kind:'project',time:1000,values:{}}],
  series:[{rowId:'p',tracks:[{id:'velocity',label:'Signed velocity',points:[{time:0,value:-3},{time:1,value:2},{time:2,value:-1}]}]}],
  associations:[{id:'job-output',from:'j',to:'a'},{id:'artifact-note',from:'a',to:'n'},{id:'unresolved',from:'j'}],
  selectedId:'n',style:{theme:'paper',kinds:{artifact:'#abcdef'},statuses:{accepted:'#123456'},tracks:{velocity:'#765432'}},
  simulations:[{id:'note',label:'Add note',parentKind:'artifact',kind:'annotation',status:'draft',parentStatus:'reviewing',allowedStatuses:['accepted','awaiting-review'],values:{comment:'local note'},copyFields:{bytes:'bytes'},parentValues:{reviewed:true},parentCopyFields:{lastNote:'comment'},timeOffsetMs:100,message:'Local observation only'}],
});
const cases:{name:string;data:unknown;valid:boolean}[]=[{name:'four-level nontrading model',data:nonTrading(),valid:true},{name:'empty observations',data:{entities:[{id:'node',label:''}],columns:[],rows:[],series:[],associations:[]},valid:true}];
function invalid(name:string,mutate:(value:LinkedData)=>void){const data=nonTrading();mutate(data);cases.push({name,data,valid:false});}
invalid('unknown kind',data=>{data.rows[0]!.kind='undefined-kind';});
invalid('duplicate entity',data=>{data.entities.push(data.entities[0]!);});invalid('duplicate column',data=>{data.columns.push(data.columns[0]!);});invalid('duplicate row',data=>{data.rows.push(data.rows[0]!);});
invalid('missing parent',data=>{data.rows[1]!.parentId='missing';});invalid('cycle',data=>{data.rows[0]!.parentId='n';});invalid('missing selected row',data=>{data.selectedId='missing';});
invalid('empty status',data=>{data.rows[0]!.status='';});invalid('control character identifier',data=>{data.rows[0]!.status='good\n';});
invalid('end without time',data=>{delete data.rows[0]!.time;data.rows[0]!.endTime=1001;});invalid('end before time',data=>{data.rows[0]!.endTime=999;});invalid('fractional instant',data=>{data.rows[0]!.time=.5;});
invalid('duplicate root series',data=>{data.series.push(data.series[0]!);});invalid('child series',data=>{data.series[0]!.rowId='j';});invalid('duplicate track',data=>{data.series[0]!.tracks.push(data.series[0]!.tracks[0]!);});invalid('non-increasing points',data=>{data.series[0]!.tracks[0]!.points[1]!.time=0;});
invalid('cross-root association',data=>{data.associations[0]!.to='other';});invalid('missing association source',data=>{data.associations[0]!.from='missing';});invalid('untimed association source',data=>{delete data.rows[1]!.time;});invalid('duplicate association',data=>{data.associations.push(data.associations[0]!);});
invalid('unknown simulation kind',data=>{data.simulations![0]!.kind='unknown';});invalid('duplicate simulation',data=>{data.simulations!.push(data.simulations![0]!);});invalid('simulation offset overflow',data=>{data.simulations![0]!.timeOffsetMs=86_400_001;});
invalid('scalar text overflow',data=>{data.rows[0]!.values.owner='x'.repeat(2001);});invalid('scalar record overflow',data=>{data.rows[0]!.values=Object.fromEntries(Array.from({length:65},(_,i)=>['key'+i,i]));});
invalid('raw reserved scalar key',data=>{data.rows[0]!.values=JSON.parse('{"__proto__":1}');});invalid('raw reserved color key',data=>{data.style!.kinds=JSON.parse('{"__proto__":"#123456"}');});invalid('raw reserved copy key',data=>{data.simulations![0]!.copyFields=JSON.parse('{"constructor":"owner"}');});
cases.push({name:'nested scalar forbidden',data:{...nonTrading(),rows:[{id:'node',kind:'project',values:{nested:{value:1}}}]},valid:false});
cases.push({name:'arbitrary script forbidden',data:{...nonTrading(),script:'not-supported'},valid:false});
cases.push({name:'unsafe scale',data:{...nonTrading(),columns:[{key:'field',label:'Field',scale:0}]},valid:false});
cases.push({name:'fractional column precision',data:{...nonTrading(),columns:[{key:'field',label:'Field',decimals:1.5}]},valid:false});

const chain=(length:number)=>({entities:[{id:'node',label:'Node'}],columns:[],series:[],associations:[],rows:Array.from({length},(_,i)=>({id:'n'+i,...(i?{parentId:'n'+(i-1)}:{}),kind:'node',values:{}}))});
cases.push({name:'sixteen-node path',data:chain(16),valid:true},{name:'seventeen-node path',data:chain(17),valid:false});
const roots=(count:number)=>({...chain(0),rows:Array.from({length:count},(_,i)=>({id:'n'+i,kind:'node',values:{}}))});
cases.push({name:'five hundred roots',data:roots(500),valid:true},{name:'root overflow',data:roots(501),valid:false});

test('generic model accepts nontrading data without domain parent, status, sign or time-order constraints',()=>{
  for(const item of cases)assert.equal(linkedDataSchema.safeParse(item.data).success,item.valid,item.name);
  const data=nonTrading();assert.deepEqual(linkedDataSchema.parse(data),data);assert.equal(rootForRow(data.rows,'n')?.id,'p');assert.equal(rootForRow(data.rows,'missing'),undefined);
  const bad=Object.create({inherited:1}) as Record<string,number>;bad.own=1;const inherited=nonTrading();inherited.rows[0]!.values=bad;assert.equal(linkedDataSchema.safeParse(inherited).success,false);
  const schema=z.toJSONSchema(linkedDataSchema,{io:'input'});assert.ok(JSON.stringify(schema).includes('additionalProperties'),'Raw record guards preserve the generated record schema');
});
test('filtering reveals all ancestors through four levels and keeps root paging and mounted rows bounded',()=>{
  const data=nonTrading(),closed=visibleLinkedRows(data.rows,new Set(),0,1);assert.equal(closed.totalRoots,2);assert.equal(closed.pages,2);assert.deepEqual(closed.rows.map(item=>item.row.id),['p']);
  assert.equal(visibleLinkedRows(data.rows,new Set(),100,1).page,1);
  const match=visibleLinkedRows(data.rows,new Set(),0,12,'needle');assert.deepEqual(match.rows.map(item=>[item.row.id,item.depth]),[['p',0],['j',1],['a',2],['n',3]]);
  const all=visibleLinkedRows(data.rows,new Set(data.rows.map(row=>row.id)),0,12);assert.equal(all.totalVisible,5);assert.equal(all.rows.length,5);
  const crowded=Array.from({length:300},(_,i)=>({id:'child'+i,parentId:'p',kind:'annotation',values:{}} as LinkedRow));assert.equal(visibleLinkedRows([data.rows[0]!,...crowded],new Set(['p']),0,25).rows.length,180);
});
test('generic association edges use distinct deterministic lanes and selected non-root ancestor scopes',()=>{
  const data=nonTrading(),lanes=associationLanes(data,'p');assert.equal(lanes.length,3);assert.equal(new Set(lanes.map(item=>item.lane)).size,3);assert.deepEqual(lanes.map(item=>item.association.id),['artifact-note','unresolved','job-output']);
  assert.deepEqual(associationLanes({...data,rows:[...data.rows].reverse(),associations:[...data.associations].reverse()},'p'),lanes);
  const scope=associationLanes(data,'p','n');assert.equal(scope.length,3,'Selected annotation retains associations of its artifact and job ancestors');assert.equal(associationLanes(data,'other').length,0);
});
test('generic formatters apply scale, supplied precision, suffixes, compact UTC and duration units',()=>{
  assert.equal(formatLinkedValue(500000,{key:'v',label:'V',format:'number',scale:1e6,decimals:0,smallDecimals:1,suffix:' units'}),'0.5 units');
  assert.equal(formatLinkedValue(12600000,{key:'v',label:'V',format:'number',scale:1e6,suffix:' units'}),'13 units');
  assert.equal(formatLinkedValue(-1.25,{key:'v',label:'V',format:'number',decimals:2}),'-1.25');assert.equal(formatLinkedValue(true,{key:'v',label:'V'}),'true');assert.equal(formatLinkedValue(null,{key:'v',label:'V'}),'—');
  assert.equal(formatLinkedValue(Date.UTC(2026,9,31,12,4,5),{key:'v',label:'V',format:'datetime'}),'10-31 12:04:05');
  for(const [value,expected] of [[500,'500ms'],[1500,'1.5s'],[90000,'1.5m'],[5400000,'1.5h'],[129600000,'1.5d']] as const)assert.equal(formatLinkedValue(value,{key:'v',label:'V',format:'duration'}),expected);
  assert.equal(linkedStyleSchema.safeParse({kinds:{custom:'#abcdef'},statuses:{custom:'#123456'},tracks:{custom:'#111111'}}).success,true);assert.equal(linkedStyleSchema.safeParse({bid:'#111111'}).success,false);
});
test('C# generic validation agrees with TypeScript acceptance and preserves logical data',async()=>{
  const wrapped=cases.map(item=>({id:'linked',title:'Linked',kind:'linked-workbench',data:item.data}));
  const result=spawnSync('dotnet',['tests/AgenticView.Contracts/bin/Release/net10.0/AgenticView.Contracts.dll','--native-validation-probe'],{input:JSON.stringify(wrapped),encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message);const line=result.stdout.split(/\r?\n/).find(line=>line.startsWith('[{"ok"'));assert.ok(line,result.stdout);const results=JSON.parse(line) as {ok:boolean;value?:unknown}[];
  for(const [i,item] of cases.entries()){
    let detail='';
    if(item.valid&&!results[i]!.ok){const f=await fixture();try{const registered=await(await f.call('/api/agents/register',secrets.ingestToken,{requestId:'linked-parity',registrationKey:'synthetic-linked-parity-private-registration',agentId:'linked-parity',name:'Synthetic parity'})).json();const response=await f.call(`/api/agents/${registered.runId}/publish`,registered.runToken,{sequence:1,operations:[{op:'upsert',component:wrapped[i]}]});detail=await response.text();}finally{await f.close();}}
    assert.equal(results[i]!.ok,item.valid,'C# '+item.name+' '+detail);if(item.valid)assert.deepEqual(results[i]!.value,wrapped[i],item.name);
  }
});
