import {useComponentDebug} from './ComponentDebug.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { AgentContent } from './App.js';
import { Login } from './Login.js';
import { CardInteraction } from './CardInteraction.js';
import { applyLivePatch } from '../shared/live-state.js';
import { buildAgentTree, type AgentTree } from '../shared/agent-tree.js';
import type { Snapshot,Patch } from '../shared/protocol.js';
import { canSetWindowIcon, setWindowIcon } from './WindowControls.js';
import {RenderBoundary,useDocumentActivity} from './RenderActivity.js';
import {useMotionSettings} from './Motion.js';

export function StandaloneCard({cardId}:{cardId:string}){
  const documentActive=useDocumentActivity();
  const [authenticated,setAuthenticated]=useState<boolean|null>(null),[snapshot,setSnapshot]=useState<Snapshot>(),[error,setError]=useState(''),[online,setOnline]=useState(false);
  useMotionSettings(snapshot?.settings.reducedMotion??true);
  useEffect(()=>{const unauthorized=()=>setAuthenticated(false);window.addEventListener('agenticview:unauthorized',unauthorized);void fetch('/api/session',{credentials:'same-origin'}).then(r=>r.json()).then(value=>setAuthenticated(value.authenticated===true)).catch(()=>setAuthenticated(false));return()=>window.removeEventListener('agenticview:unauthorized',unauthorized);},[]);
  useEffect(()=>{if(!authenticated||!documentActive)return;let active=true;const events=new EventSource('/api/events');events.onopen=()=>setOnline(true);events.onerror=()=>setOnline(false);events.addEventListener('snapshot',event=>{if(active)setSnapshot(JSON.parse((event as MessageEvent).data));});events.addEventListener('patch',event=>{if(active)setSnapshot(current=>current?applyLivePatch(current,JSON.parse((event as MessageEvent).data) as Patch):current);});return()=>{active=false;events.close();};},[authenticated,documentActive]);
  const priorTree=useRef<AgentTree|undefined>(undefined);
  const agent=snapshot?.agents.find(agent=>agent.id===cardId),tree=useMemo(()=>{if(!snapshot)return;const next=buildAgentTree(snapshot.agents,priorTree.current);priorTree.current=next;return next;},[snapshot?.agents]);
  useEffect(()=>{if(agent)document.title=agent.name+' · AgenticView';},[agent?.name]);
  const icon=agent?.windowIcon??null,iconRevision=agent?.windowIconRevision??0;
  useEffect(()=>{if(!authenticated||!agent||!canSetWindowIcon())return;let active=true;void setWindowIcon(cardId,icon).then(async result=>{if(!active)return;const response=await fetch(`/api/agents/${encodeURIComponent(cardId)}/window-icon/report`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...result,expected:icon,revision:iconRevision})});if(!response.ok&&response.status!==409)throw new Error('Native icon acknowledgement could not be saved.');if(active)setError(result.state==='applied'?'':'The native window could not apply its configured icon. Configure it again to retry.');}).catch(()=>{if(active)setError('Window icon configuration could not be acknowledged. Reopen this window or configure the icon again.');});return()=>{active=false;};},[authenticated,cardId,!!agent,icon,iconRevision]);
  const debugSnapshot=useMemo(()=>{if(!snapshot)return undefined;const ids=new Set([cardId]);for(let depth=0;depth<12;depth++)for(const value of snapshot.agents)if(value.parentId&&ids.has(value.parentId))ids.add(value.id);return {...snapshot,agents:snapshot.agents.filter(value=>ids.has(value.id))};},[snapshot,cardId]);
  useComponentDebug(debugSnapshot??{revision:0,agents:[],settings:{staleSeconds:45,autoArchiveMinutes:5,archiveAfterCompletion:true,trustedEmbeds:false,reducedMotion:true},stats:{active:0,stale:0,archived:0,updates:0,updatesPerSecond:0}},authenticated===true&&documentActive,(id,mode)=>{if(mode==='viewport')throw new Error('Canvas viewport diagnostics require the canvas window.');if(!debugSnapshot?.agents.some(value=>value.id===id))throw new Error('This standalone window only displays its own card and descendants.');});
  if(authenticated===null)return <main className="standalone-card-shell"><p role="status">Connecting to this card…</p></main>;
  if(!authenticated)return <Login complete={()=>setAuthenticated(true)} signIn={async input=>{const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});if(!response.ok)throw new Error((await response.json()).error??'Sign-in failed');}}/>;
  return <main className="standalone-card-shell" data-standalone-card={cardId}><header className="standalone-card-heading"><Radio size={17}/><strong>{agent?.name??'AgenticView card'}</strong><span>Independent window · {online?'Connected':'Reconnecting'}</span></header>{error&&<p role="alert">{error}</p>}<div className="standalone-card-content">{agent&&snapshot?<RenderBoundary visible={documentActive}>{()=> <CardInteraction.Provider value={true}><AgentContent agent={agent} agents={snapshot.agents} settings={snapshot.settings} branch={tree?.nodes.get(cardId)}/></CardInteraction.Provider>}</RenderBoundary>:snapshot?<section><p>This card is archived or unavailable.</p><button onClick={()=>void fetch(`/api/archives/${encodeURIComponent(cardId)}/restore`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}).then(async response=>{if(!response.ok)throw new Error((await response.json()).error??'Card could not be restored');setError('');}).catch(error=>setError(error.message))}>Restore card</button></section>:<p role="status">Loading card…</p>}</div></main>;
}
