import {useEffect,useRef} from 'react';
import type {Snapshot} from '../shared/protocol.js';

type Target={role?:string;name?:string;index?:number};
export type DebugCommand={operation:string;componentId?:string;target?:Target;includeText?:boolean;limit?:number;properties?:string[];mode?:'focus'|'maximize'|'canvas'|'fit';value?:string;key?:string;x?:number;y?:number;durationSeconds?:number};
type Job={id:string;sessionId:string;runId:string;claimToken:string;deadline:number;command:DebugCommand};
type Bridge={postMessage:(value:unknown)=>void;addEventListener:(name:string,listener:(event:{data:any})=>void)=>void;removeEventListener:(name:string,listener:(event:{data:any})=>void)=>void};
const desktop=()=>window as unknown as {agenticViewDesktop?:{debugging?:boolean};chrome?:{webview?:Bridge}};
const safeKinds=new Set(['chart','linked-workbench','execution-workbench','table','accordion','tabs','tree','stepper','bullet','markdown','metric','stat-grid','keyvalue','logs','code','diff','progress','bar-list','timeline','filetree','data-grid','action-panel']);
export const debugStyleProperties=['display','visibility','opacity','position','width','height','min-width','max-width','min-height','max-height','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','gap','row-gap','column-gap','font-size','font-family','font-weight','line-height','letter-spacing','color','background-color','border-width','border-radius','overflow','overflow-x','overflow-y','pointer-events','animation-duration','transition-duration','transform','z-index'];
const styleKeys=new Set(debugStyleProperties);
const role=(element:HTMLElement)=>element.getAttribute('role')??({BUTTON:'button',INPUT:element.getAttribute('type')==='checkbox'?'checkbox':'textbox',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button',A:'link'} as Record<string,string>)[element.tagName]??'';
const name=(element:HTMLElement)=>element.getAttribute('aria-label')??element.getAttribute('title')??element.textContent?.trim().slice(0,160)??'';
const rect=(element:HTMLElement)=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
function visible(element:HTMLElement){
 const bounds=element.getBoundingClientRect(),style=getComputedStyle(element);let left=Math.max(0,bounds.left),right=Math.min(innerWidth,bounds.right),top=Math.max(0,bounds.top),bottom=Math.min(innerHeight,bounds.bottom);
 if(style.visibility==='hidden'||style.display==='none'||element.closest('.render-boundary[data-render-active="false"]'))return false;
 for(let parent=element.parentElement;parent&&parent!==document.body;parent=parent.parentElement){const css=getComputedStyle(parent),r=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(css.overflowX)){left=Math.max(left,r.left);right=Math.min(right,r.right);}if(/auto|scroll|hidden|clip/.test(css.overflowY)){top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}}
 return right>left&&bottom>top;
}
function frame(){return new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('No render opportunity before the diagnostic deadline.')),3000);requestAnimationFrame(()=>{clearTimeout(timeout);resolve();});});}
async function native(operation:string,durationSeconds?:number){const bridge=desktop().chrome?.webview;if(!bridge)return {available:false};return new Promise<any>((resolve,reject)=>{const requestId=crypto.randomUUID();const listener=(event:{data:any})=>{if(event.data?.type!=='agenticview:debug-native-result'||event.data.requestId!==requestId)return;clearTimeout(timeout);bridge.removeEventListener('message',listener);event.data.ok?resolve(event.data.result):reject(new Error(event.data.error??'Native diagnostics failed.'));};const timeout=setTimeout(()=>{bridge.removeEventListener('message',listener);reject(new Error('Native diagnostics deadline exceeded.'));},((durationSeconds??0)+10)*1000);bridge.addEventListener('message',listener);bridge.postMessage({type:'agenticview:debug-native',requestId,operation,...(durationSeconds?{durationSeconds}:{})});});}

/** Passive, bounded production timings. No image collection or trusted input generation. */
export function createDebugMeasurements(){
  const frames=new Float64Array(4096),longTasks:number[]=[],inputs:Record<string,unknown>[]=[],eventTimings:Record<string,unknown>[]=[];
  let offset=0,count=0,last=0,id=0,stopped=false;
  const tick=(now:number)=>{if(last&&document.visibilityState!=='hidden'){frames[offset++%frames.length]=now-last;count++;}last=now; if(!stopped)id=requestAnimationFrame(tick);};id=requestAnimationFrame(tick);
  const input=(event:Event)=>{const start=performance.now(),inputDelayMs=Math.max(0,start-event.timeStamp);requestAnimationFrame(()=>{const first=performance.now();requestAnimationFrame(()=>{inputs.push({type:event.type,trusted:event.isTrusted,inputDelayMs,eventToFirstFrameMs:first-start,eventToSecondFrameMs:performance.now()-start});if(inputs.length>256)inputs.shift();});});};
  document.addEventListener('click',input,true);document.addEventListener('keydown',input,true);
  const observers:PerformanceObserver[]=[];
  if(typeof PerformanceObserver!=='undefined')for(const type of ['longtask','event'])if(PerformanceObserver.supportedEntryTypes.includes(type)){
    const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()){if(type==='longtask'){longTasks.push(entry.duration);if(longTasks.length>256)longTasks.shift();}else{const e=entry as PerformanceEventTiming;eventTimings.push({type:e.name,durationMs:e.duration,inputDelayMs:e.processingStart-e.startTime,processingMs:e.processingEnd-e.processingStart,interactionId:e.interactionId});if(eventTimings.length>256)eventTimings.shift();}}});observer.observe({type,buffered:true,...(type==='event'?{durationThreshold:16}:{})} as PerformanceObserverInit);observers.push(observer);
  }
  return {snapshot:()=>{const sample=Array.from(frames.subarray(0,Math.min(count,frames.length))).sort((a,b)=>a-b);return {at:Date.now(),visible:document.visibilityState!=='hidden',frameSamples:sample.length,totalFrameSamples:count,frameP50Ms:sample[Math.floor(sample.length*.5)]??null,frameP95Ms:sample[Math.floor(sample.length*.95)]??null,frameMaxMs:sample.at(-1)??null,longTaskCount:longTasks.length,longTaskTotalMs:longTasks.reduce((a,b)=>a+b,0),longTaskMaxMs:Math.max(0,...longTasks),inputs:inputs.slice(-80),eventTimings:eventTimings.slice(-80),eventTimingSupported:typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes.includes('event'),domNodes:document.getElementsByTagName('*').length,components:document.querySelectorAll('[data-debug-component]').length,activeComponents:[...document.querySelectorAll('[data-debug-component]')].filter(e=>!e.closest('.render-boundary[data-render-active="false"]')).length,scope:'Frame opportunities and Event Timing (16ms threshold/8ms quantization); synthetic input is explicitly untrusted. No compositor/pixel/physical-input timing.'};},stop:()=>{stopped=true;cancelAnimationFrame(id);document.removeEventListener('click',input,true);document.removeEventListener('keydown',input,true);observers.forEach(observer=>observer.disconnect());}};
}

function component(runId:string,id:string|undefined){const values=[...document.querySelectorAll<HTMLElement>('[data-debug-run]')].filter(e=>e.dataset.debugRun===runId);if(!id)return values;const found=values.find(e=>e.dataset.debugComponent===id);if(!found)throw new Error('Component is not mounted. Focus its card first.');return [found];}
function targets(root:HTMLElement){return [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,summary,[role=button],[role=checkbox],[role=treeitem],[tabindex]')].filter(e=>e.closest('[data-debug-component]')===root&&!e.closest('iframe'));
}
function target(root:HTMLElement,query?:Target){if(!query)return root;const matches=targets(root).filter(e=>(query.role===undefined||role(e)===query.role)&&(query.name===undefined||name(e)===query.name));if(query.index===undefined&&matches.length!==1)throw new Error(`Target is ${matches.length?'ambiguous':'unavailable'}; inspect and use a precise role/name/index.`);const element=matches[query.index??0];if(!element)throw new Error('Target index is unavailable.');return element;}
function safeInput(root:HTMLElement,element:HTMLElement,operation:string){
  if(!safeKinds.has(root.dataset.debugKind??'')||root.dataset.origin!=='native'||element.closest('.component-settings,.presentation-editor'))throw new Error('Synthetic input is limited to native local inspection controls.');
  if(root.dataset.debugKind==='action-panel'&&(!['input','focus'].includes(operation)||!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)))throw new Error('Only local field drafts may be changed; configured actions use the typed action API.');
  if(element instanceof HTMLInputElement&&['password','file','hidden','submit','reset','button','image'].includes(element.type))throw new Error('Sensitive inputs are excluded.');
  if(root.dataset.debugKind==='data-grid'||root.dataset.debugKind==='table'&&root.querySelector('.control-view')){
    const control=element.getAttribute('data-control'),readButton=(element instanceof HTMLButtonElement||element.tagName==='SUMMARY'&&element.closest('.grid-column-settings'))&&(['filter','refresh','pagination','columns'].includes(control??'')||element.classList.contains('control-sort')),readField=element instanceof HTMLInputElement&&(element.closest('.control-select-cell')!==null||element.closest('.grid-column-settings')!==null&&element.type==='checkbox'||element.closest('form.control-toolbar')!==null&&element.getAttribute('aria-label')==='Filter rows');if(!readButton&&!readField)throw new Error('Operational grid controls are excluded; use the configured typed action API.');
  }
  if(element instanceof HTMLAnchorElement||element.closest('form')&&element instanceof HTMLButtonElement&&element.type==='submit'&&!(element.dataset.control==='filter'&&element.closest('.control-view')&&['data-grid','table'].includes(root.dataset.debugKind??'')))throw new Error('Navigation links and submissions are excluded.');
  if((element as HTMLButtonElement).disabled||element.getAttribute('aria-disabled')==='true'||!visible(element))throw new Error('Target is disabled, clipped or inactive; navigate/scroll first.');
}
export async function executeDebugCommand(runId:string,command:DebugCommand,navigate:(id:string,mode:NonNullable<DebugCommand['mode']>)=>void,measurements:ReturnType<typeof createDebugMeasurements>){
  const start=performance.now();
  if(command.operation==='metrics')return {...measurements.snapshot(),native:await native('metrics')};
  if(command.operation==='profile')return native('profile',command.durationSeconds??5);
  if(command.operation==='navigate'){navigate(runId,command.mode??'focus');await frame();await frame();return {mode:command.mode,synthetic:true,dispatchToSecondFrameMs:performance.now()-start};}
  const roots=component(runId,command.componentId);
  if(command.operation==='inspect')return {components:roots.slice(0,command.limit??100).map(root=>({id:root.dataset.debugComponent,kind:root.dataset.debugKind,origin:root.dataset.origin,title:root.getAttribute('aria-label'),visible:visible(root),bounds:rect(root),nodes:root.getElementsByTagName('*').length,...(command.includeText?{text:(root.innerText??root.textContent??'').slice(0,2000)}:{}),targets:targets(root).slice(0,100).map((e,index,all)=>({index,role:role(e),name:name(e),target:{...(role(e)?{role:role(e)}:{}),name:name(e),index:all.slice(0,index).filter(value=>role(value)===role(e)&&name(value)===name(e)).length},visible:visible(e),disabled:!!(e as HTMLButtonElement).disabled,bounds:rect(e)}))})),truncated:roots.length>(command.limit??100)};
  const root=roots[0];if(!root)throw new Error('No component is mounted.');const element=target(root,command.target);
  if(command.operation==='styles'){const style=getComputedStyle(element),properties=command.properties??['display','width','height','font-size','line-height','padding','gap','overflow','color'];return {bounds:rect(element),styles:Object.fromEntries(properties.filter(key=>styleKeys.has(key)).map(key=>[key,style.getPropertyValue(key)]))};}
  safeInput(root,element,command.operation);
  switch(command.operation){
    case 'focus':element.focus();break;
    case 'click':element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));break;
    case 'doubleClick':element.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));break;
    case 'input':{
      if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement))throw new Error('Target is not a supported field.');
      const prototype=element instanceof HTMLInputElement?HTMLInputElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;
      if(element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type)){if(command.value!=='true'&&command.value!=='false')throw new Error('Use true/false for checkbox input.');if(element.type==='radio'&&command.value==='false')throw new Error('A radio group changes by selecting another option.');if(element.checked!==(command.value==='true'))element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}
      else Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(element,command.value??'');
      element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));break;
    }
    case 'key':{const key=command.key==='Space'?' ':command.key;for(const type of ['keydown','keyup'])element.dispatchEvent(new KeyboardEvent(type,{key,bubbles:true,cancelable:true}));break;}
    case 'scroll':{const viewport=command.target?element:[root,...root.querySelectorAll<HTMLElement>('*')].find(e=>e.scrollHeight>e.clientHeight+1&&/auto|scroll/.test(getComputedStyle(e).overflowY))??element;viewport.scrollBy({left:command.x??0,top:command.y??0,behavior:'instant'});break;}
    default:throw new Error('Unsupported diagnostic operation.');
  }
  const dispatched=performance.now();await frame();const first=performance.now();await frame();return {synthetic:true,trusted:false,dispatchMs:dispatched-start,dispatchToFirstFrameMs:first-start,dispatchToSecondFrameMs:performance.now()-start,bounds:rect(element),scroll:{x:element.scrollLeft,y:element.scrollTop},focused:document.activeElement===element,scope:'Synthetic DOM event/handler and render opportunities; no OS input/default keyboard behavior is generated.'};
}

export function useComponentDebug(snapshot:Snapshot,enabled:boolean,navigate:(id:string,mode:NonNullable<DebugCommand['mode']>)=>void){
  const current=useRef({snapshot,navigate});current.current={snapshot,navigate};
  useEffect(()=>{
    if(!enabled||!desktop().agenticViewDesktop?.debugging)return;
    const clientId=crypto.randomUUID(),clientToken=crypto.randomUUID()+crypto.randomUUID(),controller=new AbortController();let stopped=false,measurements:ReturnType<typeof createDebugMeasurements>|undefined,banner:HTMLDivElement|undefined;
    const post=async(path:string,body:unknown)=>{const response=await fetch('/api/debug/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});if(!response.ok)throw new Error('Component debug transport failed ('+response.status+').');return response.json();};
    const identity={clientId,clientToken};
    const stop=()=>{stopped=true;controller.abort();measurements?.stop();banner?.remove();void fetch('/api/debug/disconnect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(identity),keepalive:true}).catch(()=>{});};
    const run=async()=>{while(!stopped){try{
      const response=await post('poll',{...identity,cardIds:current.current.snapshot.agents.slice(0,512).map(agent=>agent.id),visible:document.visibilityState!=='hidden',platform:'desktop'});
      if(response.sessions?.length){measurements??=createDebugMeasurements();if(!banner){banner=document.createElement('div');banner.className='component-debug-banner';banner.setAttribute('role','status');const label=document.createElement('span');label.textContent='Component debugging · synthetic input';const button=document.createElement('button');button.textContent='Stop debugging';button.onclick=stop;banner.append(label,button);document.body.append(banner);}}
      else {measurements?.stop();measurements=undefined;banner?.remove();banner=undefined;}
      for(const job of (response.jobs??[]) as Job[]){let state='succeeded',result:unknown,error:string|undefined;try{if(Date.now()>job.deadline||document.visibilityState==='hidden')throw new Error('Debug command expired or window is hidden.');measurements??=createDebugMeasurements();result=await executeDebugCommand(job.runId,job.command,current.current.navigate,measurements);if(result&&typeof result==='object'){const bounded=result as {components?:unknown[];truncated?:boolean};while(new TextEncoder().encode(JSON.stringify(bounded)).length>60000&&bounded.components?.length){bounded.components.pop();bounded.truncated=true;}if(new TextEncoder().encode(JSON.stringify(bounded)).length>60000)throw new Error('Diagnostic result exceeded its 60KiB client budget.');}}catch(failure){state='failed';error=(failure instanceof Error?failure.message:'Component diagnostic failed.').slice(0,1000);}await post('complete',{...identity,commandId:job.id,claimToken:job.claimToken,state,...(result?{result}:{}),...(error?{error}:{})});}
      if(!stopped)await new Promise(resolve=>setTimeout(resolve,response.pollMs??250));
    }catch{if(!stopped)await new Promise(resolve=>setTimeout(resolve,2000));}}};void run();return stop;
  },[enabled]);
}
