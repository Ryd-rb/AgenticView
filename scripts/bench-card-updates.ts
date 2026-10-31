import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Session} from 'node:inspector';
import {act,createElement,Profiler} from 'react';
import {Window} from 'happy-dom';
import {pathToFileURL} from 'node:url';
import {buildAgentTree} from '../shared/agent-tree.ts';
import {applyLivePatch} from '../shared/live-state.ts';
import {forexLinkedExample} from './forex-example.ts';
import type {AgentView,Component,Patch,Snapshot} from '../shared/protocol.ts';

const output=resolve(process.env.AV_BENCH_DIR??'.task/card-update-bench'),scenario=process.env.AV_BENCH_SCENARIO??'viewport',rounds=Number(process.env.AV_BENCH_ROUNDS??8);
const source=resolve(process.env.AV_BENCH_SOURCE??'.');
const sourceHashes=Object.fromEntries(['web/App.tsx','web/Components.tsx','web/ChartView.tsx','web/RenderActivity.tsx','web/ComponentSettings.tsx','shared/native-extensions.ts'].filter(file=>existsSync(join(source,file))).map(file=>[file,createHash('sha256').update(readFileSync(join(source,file))).digest('hex')]));
if(!['viewport','overview','nested'].includes(scenario)||!Number.isInteger(rounds)||rounds<2||rounds>20)throw new Error('Use a bounded supported workload.');
mkdirSync(output,{recursive:true});
const dom=new Window({url:'http://localhost/',settings:{disableIframePageLoading:true,enableJavaScriptEvaluation:false}});
for(const key of ['window','document','HTMLElement','Element','Node','Event','CustomEvent','MouseEvent','KeyboardEvent','HTMLInputElement','HTMLSelectElement','DOMRect'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,innerWidth:1440,innerHeight:1000,requestAnimationFrame:(callback:FrameRequestCallback)=>setImmediate(()=>callback(performance.now())),cancelAnimationFrame:(id:ReturnType<typeof setImmediate>)=>clearImmediate(id),addEventListener:dom.addEventListener.bind(dom),removeEventListener:dom.removeEventListener.bind(dom),dispatchEvent:dom.dispatchEvent.bind(dom)});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.navigator});
Object.defineProperty(dom.document,'visibilityState',{configurable:true,value:'visible'});
class Resize{observe(){}unobserve(){}disconnect(){}}
class Intersection{constructor(private callback:IntersectionObserverCallback){}observe(target:Element){const child=target.closest('[data-child-card-id]'),id=target.getAttribute('data-render-id')??child?.getAttribute('data-child-card-id'),visible=!id||Number(id.split('-').at(-1))<4;queueMicrotask(()=>this.callback([{target,isIntersecting:visible,intersectionRatio:visible?1:0}] as IntersectionObserverEntry[],this as unknown as IntersectionObserver));}unobserve(){}disconnect(){}}
Object.assign(globalThis,{ResizeObserver:Resize,IntersectionObserver:Intersection});
class Events extends dom.EventTarget{static current:Events;onopen:unknown;onerror:unknown;constructor(_url:string){super();Events.current=this;}close(){}send(type:string,value:unknown){this.dispatchEvent(new dom.MessageEvent(type,{data:typeof value==='string'?value:JSON.stringify(value)}));}}
Object.assign(globalThis,{EventSource:Events,fetch:async(input:string,init?:RequestInit)=>new Response(JSON.stringify(input==='/api/session'?{authenticated:true}:init?.body?JSON.parse(String(init.body)):{}),{headers:{'Content-Type':'application/json'}})});
const linked=forexLinkedExample(12),basePoints=Array.from({length:512},(_,i)=>({x:i,y:Math.sin(i*.1)*10+i*.01}));
function components(index:number):Record<string,Component>{return {
 plan:{id:'plan',kind:'markdown',title:'Current plan',data:{text:'- [ ] Track synthetic observations\n- [ ] Inspect bounded data'}},
 chart:{id:'chart',kind:'chart',title:'Heavy numeric series',data:{type:'line',series:Array.from({length:3},(_,series)=>({id:'series-'+series,name:'Series '+series,points:basePoints.map(point=>({...point,y:point.y+series+index}))})),options:{markers:false}}},
 linked:{id:'linked',kind:'linked-workbench',title:'Linked observations',data:linked},
 table:{id:'table',kind:'table',title:'Supplied grid',data:{columns:Array.from({length:6},(_,column)=>({key:'v'+column,label:'Value '+column})),rows:Array.from({length:500},(_,row)=>Object.fromEntries(Array.from({length:6},(_,column)=>['v'+column,index*10000+row*10+column]))),pageSize:20}},
 logs:{id:'logs',kind:'logs',title:'Bounded log',data:{entries:Array.from({length:500},(_,row)=>({level:'info' as const,message:`Synthetic observation ${index}:${row}`,time:'12:00:00'}))}},
 stats:{id:'stats',kind:'stat-grid',title:'Metrics',data:{items:Array.from({length:12},(_,i)=>({label:'Measure '+i,value:index+i}))}},
 metric:{id:'metric',kind:'metric',title:'Sequence',data:{value:0}},
 fields:{id:'fields',kind:'keyvalue',title:'Context',data:{items:Array.from({length:12},(_,i)=>({key:'Field '+i,value:`Synthetic ${index}:${i}`}))}},
};}
const {App,AgentContent}=await import(pathToFileURL(resolve(process.env.AV_BENCH_SOURCE??'.','web/App.tsx')).href);
const settings={staleSeconds:45,autoArchiveMinutes:null,archiveAfterCompletion:false,trustedEmbeds:false,reducedMotion:true};
const agents:AgentView[]=Array.from({length:100},(_,i)=>({id:'card-'+i,agentId:'synthetic-'+i,name:'Synthetic heavy card '+i,role:'Benchmark',context:'',parentId:scenario==='nested'?'parent':null,createdAt:1,lastSeen:1,status:'active',sequence:1,layout:{x:i%10*740,y:Math.floor(i/10)*800,width:700,height:760,z:i,locked:true,sizing:'fixed'},components:components(i)}));
const parent:AgentView={...agents[0]!,id:'parent',parentId:null,components:{},layout:{x:0,y:0,width:1400,height:960,z:0,locked:true,sizing:'fixed'}};
let snapshot:Snapshot={revision:1,agents:scenario==='nested'?[parent,...agents]:agents,settings,stats:{active:100,stale:0,archived:0,updates:0,updatesPerSecond:0}};
const host=document.createElement('div');document.body.append(host);const {createRoot}=await import('react-dom/client'),root=createRoot(host),samples:number[]=[],commits:{duration:number;phase:string}[]=[];
const onRender=(_id:string,phase:string,duration:number)=>commits.push({phase,duration});
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
function view(){if(scenario!=='nested')return createElement(App);const tree=buildAgentTree(snapshot.agents);return createElement(AgentContent,{agent:snapshot.agents[0]!,agents:snapshot.agents,settings,branch:tree.nodes.get('parent')});}
function patchFor(sequence:number):Patch{return {revision:sequence+1,removed:[],stats:{...snapshot.stats,updates:sequence*100,updatesPerSecond:100},changes:agents.map((agent,index)=>({id:agent.id,components:[{id:'chart',kind:'chart',title:'Heavy numeric series',data:{type:'line',series:Array.from({length:3},(_,series)=>({id:'series-'+series,name:'Series '+series,points:basePoints.map(point=>({...point,y:point.y+series+index+sequence*.01}))})),options:{markers:false}}},{id:'metric',kind:'metric',title:'Sequence',data:{value:sequence}}]}))};}
async function update(sequence:number,wire=JSON.stringify(patchFor(sequence))){await act(async()=>{if(scenario==='nested'){snapshot=applyLivePatch(snapshot,JSON.parse(wire));root.render(createElement(Profiler,{id:'cards',onRender},view()));}else Events.current.send('patch',wire);await settle();});}
const memoryBefore=process.memoryUsage();const inspector=new Session();inspector.connect();const command=(method:string,params?:object)=>new Promise<any>((resolve,reject)=>inspector.post(method as never,params as never,(error,result)=>error?reject(error):resolve(result)));
try{
 const start=performance.now();await act(async()=>{root.render(createElement(Profiler,{id:'cards',onRender},view()));await settle();});if(scenario!=='nested')await act(async()=>{Events.current.send('snapshot',snapshot);await settle();});
 if(scenario==='overview')await act(async()=>{const fit=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')==='Fit all cards'||button.title==='Fit all cards');if(!fit)throw new Error('Fit-all control unavailable: '+JSON.stringify([...host.querySelectorAll('button')].slice(0,30).map(button=>[button.getAttribute('aria-label'),button.textContent]))); fit.click();await settle();if(host.querySelectorAll('[data-card-id]').length!==100||host.querySelectorAll('.card-overview').length)throw new Error('Overview must retain all100fullcard views');});
 const startupMs=performance.now()-start;await update(1);const wires=Array.from({length:rounds},(_,i)=>JSON.stringify(patchFor(i+2)));commits.length=0;await command('Profiler.enable');await command('Profiler.start');
 for(let sequence=2;sequence<rounds+2;sequence++){const start=performance.now();await update(sequence,wires[sequence-2]);samples.push(performance.now()-start);}
 const profile=await command('Profiler.stop');writeFileSync(join(output,scenario+'.cpuprofile'),JSON.stringify(profile.profile));
 const sorted=[...samples].sort((a,b)=>a-b),result={synthetic:true,runtime:process.version,sourceHashes,scenario,cards:100,componentsPerCard:8,totalComponents:800,gridRows:50000,chartPoints:153600,linkedRows:7700,linkedPoints:28800,logEntries:50000,measuredRounds:rounds,warmupExcluded:true,startupMs,updateP50Ms:sorted[Math.floor(sorted.length*.5)],updateP95Ms:sorted[Math.floor(sorted.length*.95)],totalUpdateMs:samples.reduce((a,b)=>a+b,0),reactCommits:commits.length,reactDurationMs:commits.reduce((a,b)=>a+b.duration,0),mountedWorldCards:host.querySelectorAll('[data-card-id]').length,mountedChildCards:host.querySelectorAll('[data-child-card-id]').length,mountedComponents:host.querySelectorAll('.component').length,activeComponents:[...host.querySelectorAll('.component')].filter(node=>!node.closest('.render-boundary[data-render-active="false"]')).length,overviewCards:host.querySelectorAll('.card-overview').length,domNodes:host.querySelectorAll('*').length,heapDeltaBytes:process.memoryUsage().heapUsed-memoryBefore.heapUsed,wireSerializationExcluded:true,limitations:'Node24/happy-dom React workload with controlled visibility and no browser layout, paint, GPU, real input or WPF/WinForms/DevExpress comparison. Memory includes GC timing; not a leak measurement.'};
 writeFileSync(join(output,scenario+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{inspector.disconnect();await act(async()=>root.unmount());await dom.happyDOM.close();}
