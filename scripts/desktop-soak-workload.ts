import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {forexLinkedExample} from './forex-example.ts';
import {componentSchema} from '../shared/protocol.ts';

// API-only synthetic workload setup and producer. Contains no browser controller.
const manifestPath=resolve(process.argv[2]??'');
const operation=process.argv[3]??'prepare';
const config=JSON.parse(readFileSync(manifestPath,'utf8'));
const output=resolve(config.output);mkdirSync(output,{recursive:true});
const credentials=JSON.parse(readFileSync(config.credentials,'utf8'));
async function api(path:string,token:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const response=await fetch(config.url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const result=await response.json();if(!response.ok)throw new Error(`${path} returned ${response.status}: ${result.error}`);return result;
}
if(operation==='prepare'){
 const cards:any[]=[];
 const settings=(await api('/api/snapshot',credentials.viewerToken)).settings;
 await api('/api/settings',credentials.viewerToken,{...settings,reducedMotion:true,autoArchiveMinutes:null,archiveAfterCompletion:false},'PUT');
 const linked=forexLinkedExample(50); // Authored example only; native renderer remains domain-neutral.
 for(let index=0;index<100;index++){
  const registration=await api('/api/agents/register',credentials.ingestToken,{requestId:'desktop-soak-card-'+index,registrationKey:config.proof+'-'+index,agentId:'synthetic-'+index,name:`Synthetic workstation ${index+1}`,role:'Sustained performance test',context:'Synthetic data only. No trading actions, remote accounts or real orders.'});
  const id=registration.runId,token=registration.runToken;
  await api(`/api/agents/${id}/display`,token,{componentLayout:{mode:'columns',columns:3,minWidth:280,gap:6}},'PUT');
  await api(`/api/agents/${id}/layout`,credentials.viewerToken,{x:index%10*1420,y:Math.floor(index/10)*1100,width:1380,height:1040,z:index,locked:true,sizing:'fixed'},'PATCH');
  await api(`/api/agents/${id}/controls`,token,{actions:[{id:'range',label:'Read synthetic range',kind:'query',target:'soak-provider',handler:`range-${index}`,fields:[{key:'from',label:'From',type:'number',required:true},{key:'to',label:'To',type:'number',required:true},{key:'maxPoints',label:'Point cap',type:'number',required:true,min:32,max:2048}]},{id:'rows',label:'Read synthetic rows',kind:'query',target:'soak-provider',handler:'rows'}]},'PUT');
  const presentation={surface:'plain',density:'compact',padding:3,gap:3,fontSize:12,animation:'none',maxHeight:260};
  const make=(component:any)=>componentSchema.parse({...component,configuration:{presentation}});
  const components=[
   make({id:'plan',title:'Current plan',kind:'markdown',data:{text:'- [ ] Inspect synthetic observations\n- [ ] Track bounded live history'}}),
   make({id:'live',title:'Provider-backed hour window',kind:'chart',data:{type:'line',series:[],source:{readAction:'range',windowMs:3600000,maxPoints:512,pollMs:1000},options:{legend:true,features:{dataTable:true,seriesToggle:true}}}}),
   make({id:'chart',title:'Resident numeric series',kind:'chart',data:{type:'line',series:Array.from({length:3},(_,series)=>({name:`Series ${series+1}`,id:'series-'+series,points:Array.from({length:1024},(_,i)=>({x:i,y:Math.sin(i*.03+series)+index}))})),options:{legend:true,features:{dataTable:true,seriesToggle:true}}}}),
   make({id:'table',title:'Heavy supplied grid',kind:'table',data:{columns:Array.from({length:8},(_,i)=>({key:'value'+i,label:'Value '+i})),rows:Array.from({length:1000},(_,row)=>Object.fromEntries(Array.from({length:8},(_,col)=>['value'+col,index*10000+row*8+col]))),pageSize:20}}),
   make({id:'rows',title:'Paged raw history',kind:'data-grid',data:{readAction:'rows',columns:[{key:'stream',label:'Stream'},{key:'timestamp',label:'Time'},{key:'sequence',label:'Sequence'},{key:'value',label:'Value',type:'number'}],pageSize:100}}),
   make({id:'linked',title:'Hierarchical linked observations',kind:'linked-workbench',data:linked}),
   make({id:'logs',title:'Virtualized log history',kind:'logs',data:{entries:Array.from({length:1000},(_,i)=>({level:'info',time:'12:00:00',message:`Synthetic ${index}:${i}`}))}}),
   make({id:'stats',title:'Live measurements',kind:'stat-grid',data:{items:Array.from({length:16},(_,i)=>({label:'Measure '+i,value:index+i}))}}),
   make({id:'context',title:'Local fields',kind:'keyvalue',data:{items:Array.from({length:16},(_,i)=>({key:'Field '+i,value:'Synthetic '+index+':'+i}))}}),
  ];
  const batch={sequence:Number(registration.sequence)+1,operations:components.map(component=>({op:'upsert',component}))};
  if(Buffer.byteLength(JSON.stringify(batch))>1_048_576)throw new Error('Synthetic card exceeds the unchanged HTTP budget.');
  const ack=await api(`/api/agents/${id}/publish`,token,batch);
  cards.push({id,runToken:token,sequence:ack.sequence,index});
  writeFileSync(join(output,'cards-private.json'),JSON.stringify(cards));
 }
 writeFileSync(join(output,'workload.json'),JSON.stringify({cards:100,components:900,residentChartPoints:307200,gridRows:100000,logEntries:100000,linkedRows:linked.rows.length*100,linkedPoints:linked.series.reduce((n,s)=>n+s.tracks.reduce((n,t)=>n+t.points.length,0),0)*100,targetPointsPerHour:3600000,rawStreams:100,providerPointCap:512,gridPageRows:100,synthetic:true}));
 console.log('Prepared 100 isolated synthetic cards with 900 components.');
}else if(operation==='publish'){
 const duration=Number(config.durationSeconds);if(!Number.isInteger(duration)||duration<1||duration>7200)throw new Error('Finite duration required.');
 if(config.startAtUtcMs&&Date.now()<config.startAtUtcMs)await new Promise(resolve=>setTimeout(resolve,config.startAtUtcMs-Date.now()));
 const cards=JSON.parse(readFileSync(join(output,'cards-private.json'),'utf8'));const start=performance.now();let rounds=0,failures=0,accepted=0;const latencies:number[]=[];
 while(performance.now()-start<duration*1000){const roundStart=performance.now();rounds++;
  for(const card of cards){const body={sequence:card.sequence+1,operations:[{op:'upsert',component:{id:'stats',title:'Live measurements',kind:'stat-grid',configuration:{presentation:{surface:'plain',density:'compact',padding:3,gap:3,fontSize:12,animation:'none',maxHeight:260}},data:{items:Array.from({length:16},(_,i)=>({label:'Measure '+i,value:rounds*1000+card.index*16+i}))}}}]};const at=performance.now();
   try{const ack=await api(`/api/agents/${card.id}/publish`,card.runToken,body);card.sequence=ack.sequence;accepted++;latencies.push(performance.now()-at);if(latencies.length>72000)latencies.shift();}catch(error){failures++;throw error;}
  }
  writeFileSync(join(output,'cards-private.json'),JSON.stringify(cards));writeFileSync(join(output,'publisher-progress.json'),JSON.stringify({rounds,accepted,failures,elapsedSeconds:(performance.now()-start)/1000,lastRoundMs:performance.now()-roundStart}));
  const delay=Math.min(duration*1000-(performance.now()-start),Math.max(0,5000-(performance.now()-roundStart)));if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
 }
 latencies.sort((a,b)=>a-b);writeFileSync(join(output,'publisher-result.json'),JSON.stringify({rounds,accepted,failures,durationSeconds:(performance.now()-start)/1000,p50Ms:latencies[Math.floor(latencies.length*.5)],p95Ms:latencies[Math.floor(latencies.length*.95)],maxMs:latencies.at(-1)}));
}else throw new Error('Supported operations: prepare, publish.');
