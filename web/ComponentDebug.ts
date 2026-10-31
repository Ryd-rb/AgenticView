import {useEffect,useRef} from 'react';
import {debugEnvironment} from './DocumentActivity.js';
import type {Snapshot} from '../shared/protocol.js';

export type DebugViewport={zoom?:number;anchorX?:number;anchorY?:number;phase?:'begin'|'end'|'profile'};
type DebugNavigate=(id:string,mode:NonNullable<DebugCommand['mode']>|'viewport',viewport?:DebugViewport)=>{zoom:number;x:number;y:number;profileRestarted?:boolean}|void;
type Target={ref?:string;role?:string;name?:string;index?:number};
export type DebugCommand={operation:string;componentId?:string;target?:Target;includeText?:boolean;limit?:number;properties?:string[];mode?:'focus'|'maximize'|'canvas'|'fit';value?:string;key?:string;x?:number;y?:number;durationSeconds?:number;zoom?:number;steps?:number;intervalMs?:number;anchorX?:number;anchorY?:number;profileSeconds?:number;profileRestartCamera?:boolean};
type Job={id:string;sessionId:string;runId:string;claimToken:string;deadline:number;command:DebugCommand};
type Bridge={postMessage:(value:unknown)=>void;addEventListener:(name:string,listener:(event:{data:any})=>void)=>void;removeEventListener:(name:string,listener:(event:{data:any})=>void)=>void};
const desktop=()=>window as unknown as {agenticViewDesktop?:{debugging?:boolean;nativeDebugControl?:boolean};chrome?:{webview?:Bridge}};
const safeKinds=new Set(['chart','linked-workbench','execution-workbench','table','accordion','tabs','tree','stepper','bullet','markdown','metric','stat-grid','keyvalue','logs','code','diff','progress','bar-list','timeline','filetree','data-grid','action-panel']);
export const debugStyleProperties=['display','visibility','opacity','position','width','height','min-width','max-width','min-height','max-height','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','gap','row-gap','column-gap','font-size','font-family','font-weight','line-height','letter-spacing','color','background-color','border-width','border-radius','overflow','overflow-x','overflow-y','pointer-events','animation-duration','transition-duration','transform','z-index','contain','content-visibility','will-change','isolation','transform-style'];
const styleKeys=new Set(debugStyleProperties);
type TargetBinding={element:WeakRef<HTMLElement>;run:string;component:string;role:string;name:string};
const targetRefs=new Map<string,TargetBinding>(),elementRefs=new WeakMap<HTMLElement,string>();
function reference(root:HTMLElement,element:HTMLElement){
  const old=elementRefs.get(element),bound=old?targetRefs.get(old):undefined,current={run:root.dataset.debugRun??'',component:root.dataset.debugComponent??'',role:role(element),name:referenceName(element)};
  if(bound&&bound.run===current.run&&bound.component===current.component&&bound.role===current.role&&bound.name===current.name)return old!;
  const id='e'+crypto.randomUUID().replaceAll('-','');targetRefs.set(id,{element:new WeakRef(element),...current});elementRefs.set(element,id);
  if(targetRefs.size>2048)targetRefs.delete(targetRefs.keys().next().value!);return id;
}
const role=(element:HTMLElement)=>element.getAttribute('role')??({BUTTON:'button',INPUT:({checkbox:'checkbox',radio:'radio',number:'spinbutton',range:'slider'} as Record<string,string>)[element.getAttribute('type')??'']??'textbox',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button',A:'link'} as Record<string,string>)[element.tagName]??'';
const name=(element:HTMLElement)=>element.getAttribute('aria-label')??element.getAttribute('title')??element.textContent?.trim().slice(0,160)??'';
const referenceName=(element:HTMLElement)=>element.getAttribute('aria-label')??element.getAttribute('title')??(element.matches('button,summary,[role=button],[role=checkbox],[role=treeitem]')?name(element):element.tagName);
const rect=(element:HTMLElement)=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
function visible(element:HTMLElement){
 const bounds=element.getBoundingClientRect(),style=getComputedStyle(element);let left=Math.max(0,bounds.left),right=Math.min(innerWidth,bounds.right),top=Math.max(0,bounds.top),bottom=Math.min(innerHeight,bounds.bottom);
 if(style.visibility==='hidden'||style.display==='none'||element.closest('.render-boundary[data-render-active="false"]'))return false;
 for(let parent=element.parentElement;parent&&parent!==document.body;parent=parent.parentElement){const css=getComputedStyle(parent),r=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(css.overflowX)){left=Math.max(left,r.left);right=Math.min(right,r.right);}if(/auto|scroll|hidden|clip/.test(css.overflowY)){top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}}
 return right>left&&bottom>top;
}
function frame(signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{
 let id=0;const finish=(error?:Error)=>{clearTimeout(timeout);cancelAnimationFrame(id);signal?.removeEventListener('abort',abort);error?reject(error):resolve();},abort=()=>finish(new DOMException('Debugging stopped.','AbortError'));
 const timeout=setTimeout(()=>finish(new Error('No render opportunity before the diagnostic deadline.')),3000);if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});id=requestAnimationFrame(()=>finish());
});}
function delayForStep(ms:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('Debugging stopped.','AbortError'));};if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});}

async function native(operation:string,durationSeconds?:number,onStarted?:()=>void){const bridge=desktop().chrome?.webview;if(!bridge)return {available:false};return new Promise<any>((resolve,reject)=>{const requestId=crypto.randomUUID();let started=false;const listener=(event:{data:any})=>{if(event.data?.type==='agenticview:debug-native-started'&&event.data.requestId===requestId){if(!started){started=true;onStarted?.();}return;}if(event.data?.type!=='agenticview:debug-native-result'||event.data.requestId!==requestId)return;clearTimeout(timeout);bridge.removeEventListener('message',listener);event.data.ok?resolve(event.data.result):reject(new Error(event.data.error??'Native diagnostics failed.'));};const timeout=setTimeout(()=>{bridge.removeEventListener('message',listener);reject(new Error('Native diagnostics deadline exceeded.'));},((durationSeconds??0)+35)*1000);bridge.addEventListener('message',listener);bridge.postMessage({type:'agenticview:debug-native',requestId,operation,...(durationSeconds?{durationSeconds}:{})});});}

/** Passive, bounded production timings. No image collection or trusted input generation. */
export function createDebugMeasurements(){
  const frames=new Float64Array(4096),longTasks:number[]=[],inputs:Record<string,unknown>[]=[],eventTimings:Record<string,unknown>[]=[];
  let offset=0,count=0,last=0,id=0,stopped=false;
  const tick=(now:number)=>{if(last&&debugEnvironment().renderActive){frames[offset++%frames.length]=now-last;count++;}last=now; if(!stopped)id=requestAnimationFrame(tick);};id=requestAnimationFrame(tick);
  const input=(event:Event)=>{const start=performance.now(),inputDelayMs=Math.max(0,start-event.timeStamp);requestAnimationFrame(()=>{const first=performance.now();requestAnimationFrame(()=>{inputs.push({type:event.type,trusted:event.isTrusted,inputDelayMs,eventToFirstFrameMs:first-start,eventToSecondFrameMs:performance.now()-start});if(inputs.length>256)inputs.shift();});});};
  document.addEventListener('click',input,true);document.addEventListener('keydown',input,true);
  const observers:PerformanceObserver[]=[];
  if(typeof PerformanceObserver!=='undefined')for(const type of ['longtask','event'])if(PerformanceObserver.supportedEntryTypes.includes(type)){
    const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()){if(type==='longtask'){longTasks.push(entry.duration);if(longTasks.length>256)longTasks.shift();}else{const e=entry as PerformanceEventTiming;eventTimings.push({type:e.name,durationMs:e.duration,inputDelayMs:e.processingStart-e.startTime,processingMs:e.processingEnd-e.processingStart,interactionId:e.interactionId});if(eventTimings.length>256)eventTimings.shift();}}});observer.observe({type,buffered:true,...(type==='event'?{durationThreshold:16}:{})} as PerformanceObserverInit);observers.push(observer);
  }
  return {snapshot:()=>{const sample=Array.from(frames.subarray(0,Math.min(count,frames.length))).sort((a,b)=>a-b),cards=[...document.querySelectorAll<HTMLElement>('.world-card.agent-card')].slice(0,512),visibilitySupported=cards.every(card=>typeof card.checkVisibility==='function');return {cameraTransforms:['.world','.world-y','.world-scale'].map(selector=>{const e=document.querySelector<HTMLElement>(selector);return e?{layer:selector,matrix:getComputedStyle(e).transform,timelines:(typeof e.getAnimations==='function'?e.getAnimations():[]).slice(0,3).map(a=>({state:a.playState,rate:a.playbackRate,time:typeof a.currentTime==='number'?a.currentTime:a.currentTime?.toString()??null}))}:null;}),residentCards:cards.length,paintEligibleCards:visibilitySupported?cards.filter(card=>card.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true})).length:null,at:Date.now(),visible:debugEnvironment().physicalVisible,environment:debugEnvironment(),viewport:{width:innerWidth,height:innerHeight},frameSamples:sample.length,totalFrameSamples:count,frameP50Ms:sample[Math.floor(sample.length*.5)]??null,frameP95Ms:sample[Math.floor(sample.length*.95)]??null,frameMaxMs:sample.at(-1)??null,longTaskCount:longTasks.length,longTaskTotalMs:longTasks.reduce((a,b)=>a+b,0),longTaskMaxMs:Math.max(0,...longTasks),inputs:inputs.slice(-80),eventTimings:eventTimings.slice(-80),eventTimingSupported:typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes.includes('event'),domNodes:document.getElementsByTagName('*').length,components:document.querySelectorAll('[data-debug-component]').length,activeComponents:[...document.querySelectorAll('[data-debug-component]')].filter(e=>!e.closest('.render-boundary[data-render-active="false"]')).length,updatingComponents:[...document.querySelectorAll('[data-debug-component]')].filter(e=>!e.closest('.render-boundary[data-render-updates="false"]')).length,scope:'Frame opportunities and Event Timing (16ms threshold/8ms quantization); synthetic input is explicitly untrusted. No compositor/pixel/physical-input timing.'};},stop:()=>{stopped=true;cancelAnimationFrame(id);document.removeEventListener('click',input,true);document.removeEventListener('keydown',input,true);observers.forEach(observer=>observer.disconnect());}};
}

function component(runId:string,id:string|undefined){const values=[...document.querySelectorAll<HTMLElement>('[data-debug-run]')].filter(e=>e.dataset.debugRun===runId);if(!id)return values;const found=values.find(e=>e.dataset.debugComponent===id);if(!found)throw new Error('Component is not mounted. Focus its card first.');return [found];}
function targets(root:HTMLElement){return [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,summary,[role=button],[role=checkbox],[role=treeitem],[role=radio],[role=slider],[tabindex],.table-scroll,.control-grid,.linked-grid-shell,.logs,.control-log')].filter(e=>e.closest('[data-debug-component]')===root&&!e.closest('iframe'));
}
function target(root:HTMLElement,query?:Target){if(!query)return root;
 if(query.ref){const binding=targetRefs.get(query.ref),element=binding?.element.deref();if(!binding||!element||!element.isConnected||!root.contains(element)||element.closest('[data-debug-component]')!==root||binding.run!==root.dataset.debugRun||binding.component!==root.dataset.debugComponent||binding.role!==role(element)||binding.name!==referenceName(element))throw new Error('Target reference is stale or belongs to another component; call ui_inspect and use a returned targetRef.');return element;}
const matches=targets(root).filter(e=>(query.role===undefined||role(e)===query.role)&&(query.name===undefined||name(e)===query.name));if(query.index===undefined&&matches.length!==1)throw new Error(`Target is ${matches.length?'ambiguous':'unavailable'}; inspect and use a precise role/name/index.`);const element=matches[query.index??0];if(!element)throw new Error('Target index is unavailable.');return element;}
function safeInput(root:HTMLElement,element:HTMLElement,operation:string){
  if(element.closest('.card-surface[data-preview=true]'))throw new Error('Focus or maximize this card before interacting with its retained view.');
  if(!safeKinds.has(root.dataset.debugKind??'')||root.dataset.origin!=='native'||element.closest('.component-settings,.presentation-editor'))throw new Error('Synthetic input is limited to native local inspection controls.');
  if(root.dataset.debugKind==='action-panel'&&(!['input','focus'].includes(operation)||!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)))throw new Error('Only local field drafts may be changed; configured actions use the typed action API.');
  if(element instanceof HTMLInputElement&&['password','file','hidden','submit','reset','button','image'].includes(element.type))throw new Error('Sensitive inputs are excluded.');
  if(root.dataset.debugKind==='data-grid'||root.dataset.debugKind==='table'&&root.querySelector('.control-view')){
    const control=element.getAttribute('data-control'),readButton=(element instanceof HTMLButtonElement||element.tagName==='SUMMARY'&&element.closest('.grid-column-settings'))&&(['filter','refresh','pagination','columns'].includes(control??'')||element.classList.contains('control-sort')),readField=element instanceof HTMLInputElement&&(element.closest('.control-select-cell')!==null||element.closest('.grid-column-settings')!==null&&element.type==='checkbox'||element.closest('form.control-toolbar')!==null&&element.getAttribute('aria-label')==='Filter rows');const readScroll=operation==='scroll'&&(element===root||element.matches('.control-grid,.table-scroll,.linked-grid-shell,.logs,.control-log'));if(!readButton&&!readField&&!readScroll)throw new Error('Operational grid controls are excluded; use the configured typed action API.');
  }
  if(element instanceof HTMLAnchorElement||element.closest('form')&&element instanceof HTMLButtonElement&&element.type==='submit'&&!(element.dataset.control==='filter'&&element.closest('.control-view')&&['data-grid','table'].includes(root.dataset.debugKind??'')))throw new Error('Navigation links and submissions are excluded.');
  if((element as HTMLButtonElement).disabled||element.getAttribute('aria-disabled')==='true'||!visible(element))throw new Error('Target is disabled, clipped or inactive; navigate/scroll first.');
}
function fieldInfo(root:HTMLElement,element:HTMLElement,actions:string[]){
 if(!actions.includes('input'))return undefined;
 if(element instanceof HTMLSelectElement)return {type:'select',options:[...element.options].slice(0,40).map(o=>({value:o.value.slice(0,160),label:(o.label||o.text||'').slice(0,160),disabled:o.disabled})),optionsTruncated:element.options.length>40};
 if(element instanceof HTMLInputElement)return {type:element.type,...(['checkbox','radio'].includes(element.type)?{checked:element.checked}:{}),...Object.fromEntries(['min','max','step','placeholder'].filter(k=>element.hasAttribute(k)).map(k=>[k,element.getAttribute(k)!.slice(0,160)]))};
 return {type:'textarea'};
}
function allowedActions(root:HTMLElement,element:HTMLElement){
 const actions:string[]=[];
 for(const operation of ['click','doubleClick','focus','input','key','scroll'])try{
  safeInput(root,element,operation);
  const field=element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement;
  if(operation==='input'&&!field)continue;
  if(['click','doubleClick','key'].includes(operation)&&!element.matches('button,input,select,textarea,summary,[role=button],[role=checkbox],[role=treeitem],[role=radio],[role=slider],[tabindex]'))continue;
  if(operation==='focus'&&!element.matches('button,input,select,textarea,summary,[tabindex]'))continue;
  if(operation==='scroll'){const style=getComputedStyle(element);if(!(element.scrollHeight>element.clientHeight+1&&/auto|scroll/.test(style.overflowY)||element.scrollWidth>element.clientWidth+1&&/auto|scroll/.test(style.overflowX)))continue;}
  actions.push(operation);
 }catch{/* Discovery must never dispatch input or expose denied operational actions. */}
 return actions;
}
export async function executeDebugCommand(runId:string,command:DebugCommand,navigate:DebugNavigate,measurements:ReturnType<typeof createDebugMeasurements>,signal?:AbortSignal){
  const start=performance.now();
  if(command.operation==='metrics')return {...measurements.snapshot(),native:await native('metrics')};
  if(command.operation==='layers')return native('layers');
  if(command.operation==='profile')return native('profile',command.durationSeconds??5);
  if(command.operation==='viewport'){
    const initial=navigate(runId,'viewport',{phase:'begin'});if(!initial)throw new Error('This view does not expose a canvas viewport.');
    const steps=command.steps??60,interval=command.intervalMs??16,frames:number[]=[],settleFrameMs:number[]=[];let previous=performance.now();
    let profileError:unknown,profileRestartedCamera=false;const capture=command.profileSeconds?native('profile',command.profileSeconds,command.profileRestartCamera?()=>{if(!signal?.aborted){profileRestartedCamera=navigate(runId,'viewport',{phase:'profile'})?.profileRestarted===true;}}:undefined).catch(error=>{profileError=error;return undefined;}):undefined;
    try{for(let index=1;index<=steps;index++){if(signal?.aborted)throw new DOMException('Debugging stopped.','AbortError');const delay=start+index*interval-performance.now();if(delay>0)await delayForStep(delay,signal);if(signal?.aborted)throw new DOMException('Debugging stopped.','AbortError');navigate(runId,'viewport',{zoom:initial.zoom*Math.pow(command.zoom!/initial.zoom,index/steps),anchorX:command.anchorX,anchorY:command.anchorY});await frame(signal);const now=performance.now();frames.push(now-previous);previous=now;}}
    finally{navigate(runId,'viewport',{phase:'end'});let settled=performance.now();for(let index=0;index<4&&!signal?.aborted;index++){await frame(signal);const now=performance.now();settleFrameMs.push(now-settled);settled=now;}if(capture&&!signal?.aborted)await capture.catch(()=>undefined);}
    const profile=capture?await capture:undefined;if(profileError)throw profileError;const stepFrameMs=frames.slice();frames.sort((a,b)=>a-b);return {synthetic:true,steps,stepFrameMs,settleFrameMs,profileRestartedCamera,profileRestartRequested:command.profileRestartCamera===true,firstStepMs:stepFrameMs[0],lastStepMs:stepFrameMs.at(-1),stepFrameP99Ms:frames[Math.floor(frames.length*.99)],elapsedMs:performance.now()-start,stepFrameP50Ms:frames[Math.floor(frames.length*.5)],stepFrameP95Ms:frames[Math.floor(frames.length*.95)],stepFrameMaxMs:frames.at(-1),camera:navigate(runId,'viewport'),profile};
  }
  if(command.operation==='navigate'){navigate(runId,command.mode??'focus');await frame(signal);await frame(signal);return {mode:command.mode,synthetic:true,dispatchToSecondFrameMs:performance.now()-start};}
  const roots=component(runId,command.componentId);
  if(command.operation==='inspect'){
    const components:any[]=[],encoder=new TextEncoder();let bytes=0,targetBudget=100,textBudget=8000,truncated=roots.length>(command.limit??100);
    for(const root of roots.slice(0,command.limit??100)){
      const text=command.includeText?(root.innerText??root.textContent??'').slice(0,Math.min(2000,textBudget)):undefined;textBudget-=text?.length??0;
      const item={id:root.dataset.debugComponent,kind:root.dataset.debugKind,origin:root.dataset.origin,title:root.getAttribute('aria-label'),visible:visible(root),bounds:rect(root),nodes:root.getElementsByTagName('*').length,...(text!==undefined?{text}:{}),targets:[] as any[]};
      const size=encoder.encode(JSON.stringify(item)).length;if(bytes+size>58000){truncated=true;break;}bytes+=size;
      const candidates=targets(root);for(const [index,e] of candidates.slice(0,Math.min(100,targetBudget)).entries()){
        const actions=allowedActions(root,e),entry={index,role:role(e),name:name(e),target:{ref:reference(root,e)},actions,field:fieldInfo(root,e,actions),visible:visible(e),disabled:!!(e as HTMLButtonElement).disabled,bounds:rect(e)};
        const size=encoder.encode(JSON.stringify(entry)).length;if(bytes+size>58000){truncated=true;break;}bytes+=size;item.targets.push(entry);targetBudget--;
      }
      if(item.targets.length<candidates.length)truncated=true;components.push(item);
    }
    return {components,truncated,...(truncated?{hint:'Inspect one componentId to see more targets or dropdown choices.'}:{})};
  }

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
  const dispatched=performance.now();await frame(signal);const first=performance.now();await frame(signal);return {synthetic:true,trusted:false,dispatchMs:dispatched-start,dispatchToFirstFrameMs:first-start,dispatchToSecondFrameMs:performance.now()-start,bounds:rect(element),scroll:{x:element.scrollLeft,y:element.scrollTop},focused:document.activeElement===element,scope:'Synthetic DOM event/handler and render opportunities; no OS input/default keyboard behavior is generated.'};
}

export function debugJobAllowed(sessionId:string){const environment=debugEnvironment();return environment.backgroundSession?environment.backgroundSession===sessionId:environment.physicalVisible;}
export function useComponentDebug(snapshot:Snapshot,enabled:boolean,navigate:DebugNavigate){
  const current=useRef({snapshot,navigate});current.current={snapshot,navigate};
  const register=useRef<(()=>void)|undefined>(undefined),cardIds=snapshot.agents.slice(0,512).map(agent=>agent.id).join('|');
  useEffect(()=>{register.current?.();},[cardIds]);
  useEffect(()=>{
    if(!enabled||!desktop().agenticViewDesktop?.debugging)return;
    const bridge=desktop().chrome?.webview,nativeControl=desktop().agenticViewDesktop?.nativeDebugControl===true&&!!bridge;
    const clientId=crypto.randomUUID(),clientToken=crypto.randomUUID()+crypto.randomUUID(),controller=new AbortController();let stopped=false,measurements:ReturnType<typeof createDebugMeasurements>|undefined,banner:HTMLDivElement|undefined,pipeline=Promise.resolve(),commandController:AbortController|undefined,commandSession:string|undefined;
    const post=async(path:string,body:unknown)=>{const response=await fetch('/api/debug/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});if(!response.ok)throw new Error('Component debug transport failed ('+response.status+').');return response.json();};
    const identity={clientId,clientToken};
    const release=()=>{measurements?.stop();measurements=undefined;banner?.remove();banner=undefined;};
    const stop=()=>{if(stopped)return;stopped=true;controller.abort();commandController?.abort();release();register.current=undefined;bridge?.removeEventListener('message',changed);if(nativeControl)bridge!.postMessage({type:'agenticview:debug-client-stop',clientId});void fetch('/api/debug/disconnect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(identity),keepalive:true}).catch(()=>{});};
    const consume=async(response:any)=>{
      if(stopped)return;
      if(response.sessions?.length&&debugEnvironment().renderActive){measurements??=createDebugMeasurements();if(!banner){banner=document.createElement('div');banner.className='component-debug-banner';banner.setAttribute('role','status');const label=document.createElement('span');label.textContent=debugEnvironment().backgroundSession?'Background test · offscreen · synthetic input':'Component debugging · synthetic input';const button=document.createElement('button');button.textContent='Stop debugging';button.onclick=stop;banner.append(label,button);document.body.append(banner);}}
      else release();
      for(const job of (response.jobs??[]) as Job[]){if(stopped)return;let state='succeeded',result:unknown,error:string|undefined;try{
        if(Date.now()>job.deadline||!debugJobAllowed(job.sessionId))throw new Error('Debug command expired or rendering is inactive for this session.');
        measurements??=createDebugMeasurements();commandController=new AbortController();commandSession=job.sessionId;result=await executeDebugCommand(job.runId,job.command,current.current.navigate,measurements,commandController.signal);
        if(result&&typeof result==='object'){const bounded=result as {components?:unknown[];truncated?:boolean};while(new TextEncoder().encode(JSON.stringify(bounded)).length>60000&&bounded.components?.length){bounded.components.pop();bounded.truncated=true;}if(new TextEncoder().encode(JSON.stringify(bounded)).length>60000)throw new Error('Diagnostic result exceeded its 60KiB client budget.');}
      }catch(failure){state='failed';error=(failure instanceof Error?failure.message:'Component diagnostic failed.').slice(0,1000);}
      commandController=undefined;commandSession=undefined;await post('complete',{...identity,commandId:job.id,claimToken:job.claimToken,state,...(result?{result}:{}),...(error?{error}:{})});}
    };
    const changed=(event:{data:any})=>{
      if(event.data?.type==='agenticview:debug-ready')register.current?.();
      if(event.data?.type==='agenticview:debug-background'&&(!event.data.active||commandSession&&event.data.sessionId!==commandSession)){commandController?.abort();release();}
      if(event.data?.type==='agenticview:debug-poll'&&event.data.clientId===clientId){if(commandSession&&!event.data.response?.sessions?.some((s:any)=>s.id===commandSession))commandController?.abort();pipeline=pipeline.then(()=>consume(event.data.response)).catch(()=>{});}
    };
    const run=async()=>{while(!stopped){try{const response=await post('poll',{...identity,cardIds:current.current.snapshot.agents.slice(0,512).map(agent=>agent.id),visible:debugEnvironment().physicalVisible,platform:'desktop'});await consume(response);if(!stopped)await new Promise(resolve=>setTimeout(resolve,response.pollMs??250));}catch{if(!stopped)await new Promise(resolve=>setTimeout(resolve,2000));}}};
    if(nativeControl){bridge!.addEventListener('message',changed);register.current=()=>{if(!stopped)bridge!.postMessage({type:'agenticview:debug-client',...identity,cardIds:current.current.snapshot.agents.slice(0,512).map(agent=>agent.id)});};register.current();}else void run();
    return stop;
  },[enabled]);
}
