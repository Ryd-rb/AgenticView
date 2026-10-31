import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

// This exercises only AgenticView's authenticated component debug API. No
// browser/OS automation, external selectors, screenshot or script evaluation.
const config=JSON.parse(readFileSync(resolve(process.argv[2]??''),'utf8'));
if(!Number.isInteger(config.durationSeconds)||config.durationSeconds<1||config.durationSeconds>7200)throw new Error('Finite duration required.');
const cards=JSON.parse(readFileSync(join(config.output,'cards-private.json'),'utf8'));
const credentials=JSON.parse(readFileSync(config.credentials,'utf8'));
const client=new Client({name:'native-desktop-soak',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',config.url),{requestInit:{headers:{Authorization:`Bearer ${credentials.ingestToken}`}}}));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function tool(name:string,args:Record<string,unknown>){const response=await client.callTool({name,arguments:args});if(response.isError)throw new Error('Debug MCP rejected '+name+': '+JSON.stringify(response.content).slice(0,300));return response.structuredContent as any;}
const leases=new Map<string,string>();let serial=0,failures=0,clicks=0,steps=0,consecutiveFailures=0;const latencies:number[]=[];
const readyDeadline=performance.now()+60000;let ready=false;while(performance.now()<readyDeadline){const clients=await tool('component_debug_clients',{runId:cards[0].id,runToken:cards[0].runToken});if(clients.clients.some((value:any)=>value.visible&&value.platform==='desktop')){ready=true;break;}await sleep(1000);}if(!ready)throw new Error('No visible native component debug client became ready within60seconds.');
if(config.startAtUtcMs&&Date.now()<config.startAtUtcMs)await sleep(config.startAtUtcMs-Date.now());
const start=performance.now(),startedUtc=Date.now();
const publicArgs=(card:any)=>({runId:card.id,runToken:card.runToken});
async function lease(card:any){if(leases.has(card.id))return leases.get(card.id)!;const clients=await tool('component_debug_clients',publicArgs(card));const target=clients.clients.filter((value:any)=>value.visible&&value.platform==='desktop').sort((a:any,b:any)=>b.lastSeen-a.lastSeen)[0];if(!target)throw new Error('No visible native debug client advertises this synthetic run.');const opened=await tool('component_debug_open',{...publicArgs(card),clientId:target.clientId,requestId:'soak-'+startedUtc+'-'+card.index,durationSeconds:Math.min(7200,config.durationSeconds+120)});leases.set(card.id,opened.id);return opened.id;}
async function command(card:any,value:unknown){const before=performance.now(),sessionId=await lease(card),requestId='command-'+startedUtc+'-'+(++serial);const queued=await tool('component_debug_command',{...publicArgs(card),sessionId,requestId,command:value});const deadline=performance.now()+95000;let result=queued;
 while(['queued','running'].includes(result.state)&&performance.now()<deadline){await sleep(250);result=await tool('component_debug_result',{...publicArgs(card),sessionId,commandId:queued.id});}
 const record={at:Date.now(),elapsedSeconds:(performance.now()-start)/1000,cardIndex:card.index,operation:(value as any).operation,requestId,state:result.state,roundTripMs:performance.now()-before,result:result.result,error:result.error,server:{createdAt:result.createdAt,claimedAt:result.claimedAt,finishedAt:result.finishedAt}};
 appendFileSync(join(config.output,'debug-events.jsonl'),JSON.stringify(record)+'\n');
 if(result.state!=='succeeded')throw new Error('Diagnostic command did not succeed: '+String(result.state)+' '+String(result.error??''));
 return result.result;
}
try{
 writeFileSync(join(config.output,'debug-start.json'),JSON.stringify({startedUtc,durationSeconds:config.durationSeconds,source:'Native component MCP API; synthetic untrusted DOM input; no physical input'}));
 while(performance.now()-start<config.durationSeconds*1000){const iteration=performance.now(),card=cards[steps%cards.length];
  try{
   if(steps%10===9)await command(card,{operation:'navigate',mode:'fit'});
   await command(card,{operation:'navigate',mode:'maximize'});
   const clicked=await command(card,{operation:'click',componentId:'chart',target:{role:'button',name:steps%2?'Series 2':'Series 1'}});clicks++;latencies.push(clicked.dispatchToSecondFrameMs);
   if(steps%3===0)await command(card,{operation:'metrics'});
   if(steps%10===0)await command(card,{operation:'inspect',limit:12});
   if(steps===1||steps===Math.floor(config.durationSeconds/20))await command(card,{operation:'profile',durationSeconds:15});
   consecutiveFailures=0;
  }catch(error){failures++;consecutiveFailures++;appendFileSync(join(config.output,'debug-errors.jsonl'),JSON.stringify({at:Date.now(),step:steps,error:error instanceof Error?error.message:'Diagnostic failure'})+'\n');if(consecutiveFailures>=5)throw new Error('Five consecutive component diagnostic failures; stop the bounded pass.');}
  steps++;writeFileSync(join(config.output,'debug-progress.json'),JSON.stringify({steps,clicks,commands:serial,failures,elapsedSeconds:(performance.now()-start)/1000}));
  const delay=Math.min(config.durationSeconds*1000-(performance.now()-start),Math.max(0,10000-(performance.now()-iteration)));if(delay>0)await sleep(delay);
 }
}finally{
 for(const card of cards){const sessionId=leases.get(card.id);if(sessionId)await tool('component_debug_close',{...publicArgs(card),sessionId}).catch(()=>{});}
 latencies.sort((a,b)=>a-b);writeFileSync(join(config.output,'debug-result.json'),JSON.stringify({startedUtc,endedUtc:Date.now(),durationSeconds:(performance.now()-start)/1000,steps,clicks,commands:serial,failures,clickP50Ms:latencies[Math.floor(latencies.length*.5)]??null,clickP95Ms:latencies[Math.floor(latencies.length*.95)]??null,clickMaxMs:latencies.at(-1)??null,scope:'MCP synthetic click dispatch through two native renderer frame opportunities, excluding MCP transport. No physical-input or compositor presentation measurement.'},null,2));await client.close();
}
if(failures)process.exitCode=1;
