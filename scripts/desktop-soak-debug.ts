import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

// Authenticated component diagnostics only: no external UI controller, selectors,
// screenshot collection, operational actions or agent-supplied script evaluation.
const config=JSON.parse(readFileSync(resolve(process.argv[2]??''),'utf8'));
if(!Number.isInteger(config.durationSeconds)||config.durationSeconds<1||config.durationSeconds>7200)throw new Error('Finite duration required.');
if(config.startAtUtcMs!==undefined&&(!Number.isSafeInteger(config.startAtUtcMs)||config.startAtUtcMs<0))throw new Error('Invalid common UTC start.');
const cards=JSON.parse(readFileSync(join(config.output,'cards-private.json'),'utf8'));
if(!Array.isArray(cards)||cards.length<1||cards.length>512)throw new Error('A bounded private card manifest is required.');
if(cards.some(card=>!Number.isSafeInteger(card.index)||card.index<0)||new Set(cards.map(card=>card.index)).size!==cards.length)throw new Error('Card indices must be unique nonnegative integers.');
const credentials=JSON.parse(readFileSync(config.credentials,'utf8'));
const nativeState=JSON.parse(readFileSync(resolve('.task/desktop/session.json'),'utf8'));
const nativeCreatedUtcMs=Date.parse(nativeState.CreatedUtc);
if(!Number.isFinite(nativeCreatedUtcMs)||!Number.isInteger(nativeState.ProcessId)||nativeState.ProcessId<1)throw new Error('Current native desktop identity is unavailable.');
const client=new Client({name:'native-desktop-soak',version:'1'});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
class RejectedCommand extends Error{}
class UncertainCommand extends Error{}
class CommonDeadline extends Error{}
let stopAt=config.startAtUtcMs===undefined?Infinity:performance.now()+Math.max(0,config.startAtUtcMs+config.durationSeconds*1000-Date.now());
async function tool(name:string,args:Record<string,unknown>,cleanup=false){
 const remaining=cleanup?2000:stopAt-performance.now();if(remaining<=0)throw new CommonDeadline('Common measurement deadline reached.');
 const response=await client.callTool({name,arguments:args},{timeout:Math.max(1,Math.min(30000,remaining))});
 if(response.isError)throw new RejectedCommand('Debug MCP rejected '+name+': '+JSON.stringify(response.content).slice(0,300));return response.structuredContent as any;
}
function verifyNativeIdentity(){
 const current=JSON.parse(readFileSync(resolve('.task/desktop/session.json'),'utf8'));
 if(current.ProcessId!==nativeState.ProcessId||Date.parse(current.CreatedUtc)!==nativeCreatedUtcMs)throw new UncertainCommand('Native desktop identity changed; do not reuse leases or replay uncertain work.');
}
function freshClients(values:any[]){verifyNativeIdentity();
 return values.filter(value=>value.visible&&value.platform==='desktop'&&Number.isFinite(value.lastSeen)&&value.lastSeen>=nativeCreatedUtcMs).sort((a,b)=>b.lastSeen-a.lastSeen);
}
const leases=new Map<string,string>(),clickedCards=new Set<number>();let serial=0,failures=0,clicks=0,steps=0,consecutiveFailures=0,profileCaptures=0,zoomGestures=0,earlyProfiled=false,midProfiled=false;
const latencies:number[]=[];let startedUtc=config.startAtUtcMs??Date.now(),start=performance.now(),measurementEndedUtc=startedUtc,joinedUtc:number|undefined,stopReason='deadline';
const publicArgs=(card:any)=>({runId:card.id,runToken:card.runToken});
async function lease(card:any){
 if(leases.has(card.id))return leases.get(card.id)!;
 const target=freshClients((await tool('component_debug_clients',publicArgs(card))).clients)[0];if(!target)throw new Error('No current visible native debug client advertises this synthetic run.');
 const opened=await tool('component_debug_open',{...publicArgs(card),clientId:target.clientId,requestId:'soak-'+startedUtc+'-'+card.index,durationSeconds:Math.min(7200,config.durationSeconds+120)});leases.set(card.id,opened.id);return opened.id;
}
async function command(card:any,value:Record<string,unknown>){
 verifyNativeIdentity();
 // Leave the full native claim budget for a dense viewport gesture. The input
 // driver may idle near the common end; ingestion and passive sampling continue.
 const reserve=value.operation==='viewport'?95000:10000;
 if(stopAt-performance.now()<reserve)throw new CommonDeadline('Common measurement deadline reached.');
 const before=performance.now(),sessionId=await lease(card),requestId='command-'+startedUtc+'-'+(++serial);let queued:any,result:any;
 // Persist identity before sending. A lost queue/claim result is never replaced by a new request.
 appendFileSync(join(config.output,'debug-requests.jsonl'),JSON.stringify({at:Date.now(),cardIndex:card.index,sessionId,requestId,command:value})+'\n');
 try{
  queued=await tool('component_debug_command',{...publicArgs(card),sessionId,requestId,command:value});result=queued;
  const deadline=Math.min(stopAt,performance.now()+95000);
  while(['queued','running'].includes(result.state)&&performance.now()<deadline){await sleep(Math.min(250,Math.max(0,deadline-performance.now())));if(performance.now()>=deadline)break;result=await tool('component_debug_result',{...publicArgs(card),sessionId,commandId:queued.id});}
 }catch(error){
  if(error instanceof RejectedCommand)throw error;
  appendFileSync(join(config.output,'debug-events.jsonl'),JSON.stringify({at:Date.now(),elapsedSeconds:(performance.now()-start)/1000,cardIndex:card.index,operation:value.operation,requestId,sessionId,commandId:queued?.id,state:'unknown',receiptUncertain:true,command:value,error:'MCP transport or deadline uncertainty; command is not replayed.'})+'\n');
  throw new UncertainCommand('Debug command outcome is uncertain; stop without replay.');
 }
 const record={at:Date.now(),elapsedSeconds:(performance.now()-start)/1000,cardIndex:card.index,operation:value.operation,requestId,sessionId,commandId:queued.id,command:value,state:result.state,roundTripMs:performance.now()-before,result:result.result,error:result.error,server:{createdAt:result.createdAt,claimedAt:result.claimedAt,finishedAt:result.finishedAt}};
 appendFileSync(join(config.output,'debug-events.jsonl'),JSON.stringify(record)+'\n');
 if(['unknown','queued','running'].includes(result.state))throw new UncertainCommand('Diagnostic receipt '+result.state+'; stop without replay.');
 if(result.state!=='succeeded')throw new Error('Diagnostic command did not succeed: '+String(result.state)+' '+String(result.error??''));
 return result.result;
}
try{
 await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',config.url),{requestInit:{headers:{Authorization:`Bearer ${credentials.ingestToken}`}}}));
 const commonEndUtc=config.startAtUtcMs===undefined?Infinity:config.startAtUtcMs+config.durationSeconds*1000;
 const readyDeadline=Math.min(performance.now()+60000,performance.now()+Math.max(0,commonEndUtc-Date.now()));let ready=false;
 while(performance.now()<readyDeadline){if(freshClients((await tool('component_debug_clients',publicArgs(cards[0]))).clients).length){ready=true;break;}await sleep(1000);}
 if(!ready)throw new Error('No current visible native component debug client became ready within the bounded start window.');
 if(config.startAtUtcMs&&Date.now()<config.startAtUtcMs)await sleep(config.startAtUtcMs-Date.now());
 joinedUtc=Date.now();startedUtc=config.startAtUtcMs??joinedUtc;start=performance.now()-(Date.now()-startedUtc);stopAt=start+config.durationSeconds*1000;
 writeFileSync(join(config.output,'debug-start.json'),JSON.stringify({startedUtc,joinedUtc,lateJoinMs:Math.max(0,joinedUtc-startedUtc),deadlineUtc:startedUtc+config.durationSeconds*1000,durationSeconds:config.durationSeconds,nativeProcessId:nativeState.ProcessId,nativeCreatedUtcMs,source:'Native component MCP API; synthetic untrusted DOM input; no physical input'}));
 while(performance.now()<stopAt){const iteration=performance.now(),card=cards[steps%cards.length];
  try{
   if(steps%10===0){
    await command(card,{operation:'navigate',mode:'fit'});
    const elapsed=(performance.now()-start)/1000,phase=!earlyProfiled?'early':!midProfiled&&elapsed>=config.durationSeconds/2?'mid':undefined;
    if(phase==='early')earlyProfiled=true;if(phase==='mid')midProfiled=true;
    for(const zoom of [1,.04]){
     const capture=!!phase&&profileCaptures<4&&stopAt-performance.now()>=15000;if(capture)profileCaptures++;
     await command(card,{operation:'viewport',zoom,steps:90,intervalMs:16,anchorX:.5,anchorY:.5,...(capture?{profileSeconds:5}:{})});zoomGestures++;
    }
   }
   // Far retained views stay painted; explicit activation/maximization makes input targets eligible.
   await command(card,{operation:'navigate',mode:'maximize'});
   const clicked=await command(card,{operation:'click',componentId:'chart',target:{role:'button',name:steps%2?'Series 2':'Series 1'}});clicks++;clickedCards.add(card.index);latencies.push(clicked.dispatchToSecondFrameMs);
   if(steps%3===0)await command(card,{operation:'metrics'});
   if(steps%10===0)await command(card,{operation:'inspect',limit:12});
   consecutiveFailures=0;
  }catch(error){
   if(error instanceof CommonDeadline){const remaining=stopAt-performance.now();if(remaining>0)await sleep(remaining);break;}
   failures++;consecutiveFailures++;appendFileSync(join(config.output,'debug-errors.jsonl'),JSON.stringify({at:Date.now(),step:steps,error:error instanceof Error?error.message:'Diagnostic failure'})+'\n');
   if(error instanceof UncertainCommand||consecutiveFailures>=5)throw error;
  }
  steps++;writeFileSync(join(config.output,'debug-progress.json'),JSON.stringify({steps,clicks,commands:serial,failures,zoomGestures,profileCaptures,uniqueCardsClicked:clickedCards.size,elapsedSeconds:(performance.now()-start)/1000}));
  const delay=Math.min(stopAt-performance.now(),Math.max(0,10000-(performance.now()-iteration)));if(delay>0)await sleep(delay);
 }
}catch(error){stopReason=error instanceof Error?error.message:'Diagnostic failure';throw error;}
finally{
 measurementEndedUtc=Date.now();
 // Lease close cancels queued work and makes claimed outcomes unknown. It does not kill the desktop.
 for(let index=0;index<cards.length;index+=8)await Promise.all(cards.slice(index,index+8).map(async(card:any)=>{const sessionId=leases.get(card.id);if(sessionId)await tool('component_debug_close',{...publicArgs(card),sessionId},true).catch(()=>{});}));
 latencies.sort((a,b)=>a-b);writeFileSync(join(config.output,'debug-result.json'),JSON.stringify({startedUtc,joinedUtc,lateJoinMs:joinedUtc===undefined?null:Math.max(0,joinedUtc-startedUtc),activeDurationSeconds:joinedUtc===undefined?0:Math.max(0,(measurementEndedUtc-joinedUtc)/1000),measurementEndedUtc,endedUtc:Date.now(),durationSeconds:Math.max(0,(measurementEndedUtc-startedUtc)/1000),deadlineUtc:startedUtc+config.durationSeconds*1000,stopReason,steps,clicks,commands:serial,failures,zoomGestures,profileCaptures,uniqueCardsClicked:clickedCards.size,allCardsClicked:clickedCards.size===cards.length,missingCardIndices:cards.filter((card:any)=>!clickedCards.has(card.index)).map((card:any)=>card.index),clickP50Ms:latencies[Math.floor(latencies.length*.5)]??null,clickP95Ms:latencies[Math.floor(latencies.length*.95)]??null,clickMaxMs:latencies.at(-1)??null,scope:'MCP synthetic click dispatch through two native renderer frame opportunities, excluding MCP transport. Viewport gestures every10steps; at most4five-second CPU/timeline captures. No physical-input or compositor presentation measurement.'},null,2));await client.close();
}
if(failures)process.exitCode=1;
