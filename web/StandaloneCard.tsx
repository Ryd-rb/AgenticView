import { useEffect, useMemo, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { AgentContent } from './App.js';
import { Login } from './Login.js';
import { CardInteraction } from './CardInteraction.js';
import { applyLivePatch } from '../shared/live-state.js';
import { buildAgentTree, type AgentTree } from '../shared/agent-tree.js';
import type { Snapshot,Patch } from '../shared/protocol.js';

export function StandaloneCard({cardId}:{cardId:string}){
  const [authenticated,setAuthenticated]=useState<boolean|null>(null),[snapshot,setSnapshot]=useState<Snapshot>(),[error,setError]=useState(''),[online,setOnline]=useState(false);
  useEffect(()=>{const unauthorized=()=>setAuthenticated(false);window.addEventListener('agenticview:unauthorized',unauthorized);void fetch('/api/session',{credentials:'same-origin'}).then(r=>r.json()).then(value=>setAuthenticated(value.authenticated===true)).catch(()=>setAuthenticated(false));return()=>window.removeEventListener('agenticview:unauthorized',unauthorized);},[]);
  useEffect(()=>{if(!authenticated)return;let active=true;const events=new EventSource('/api/events');events.onopen=()=>setOnline(true);events.onerror=()=>setOnline(false);events.addEventListener('snapshot',event=>{if(active)setSnapshot(JSON.parse((event as MessageEvent).data));});events.addEventListener('patch',event=>{if(active)setSnapshot(current=>current?applyLivePatch(current,JSON.parse((event as MessageEvent).data) as Patch):current);});return()=>{active=false;events.close();};},[authenticated]);
  const priorTree=useRef<AgentTree|undefined>(undefined);
  const agent=snapshot?.agents.find(agent=>agent.id===cardId),tree=useMemo(()=>{if(!snapshot)return;const next=buildAgentTree(snapshot.agents,priorTree.current);priorTree.current=next;return next;},[snapshot?.agents]);
  useEffect(()=>{if(agent)document.title=agent.name+' · AgenticView';},[agent?.name]);
  if(authenticated===null)return <main className="standalone-card-shell"><p role="status">Connecting to this card…</p></main>;
  if(!authenticated)return <Login complete={()=>setAuthenticated(true)} signIn={async input=>{const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});if(!response.ok)throw new Error((await response.json()).error??'Sign-in failed');}}/>;
  return <main className="standalone-card-shell" data-standalone-card={cardId}><header className="standalone-card-heading"><Radio size={17}/><strong>{agent?.name??'AgenticView card'}</strong><span>Independent window · {online?'Connected':'Reconnecting'}</span></header><div className="standalone-card-content">{agent&&snapshot?<CardInteraction.Provider value={true}><AgentContent agent={agent} agents={snapshot.agents} settings={snapshot.settings} branch={tree?.nodes.get(cardId)}/></CardInteraction.Provider>:snapshot?<section><p>This card is archived or unavailable.</p><button onClick={()=>void fetch(`/api/archives/${encodeURIComponent(cardId)}/restore`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}).then(async response=>{if(!response.ok)throw new Error((await response.json()).error??'Card could not be restored');setError('');}).catch(error=>setError(error.message))}>Restore card</button>{error&&<p role="alert">{error}</p>}</section>:<p role="status">Loading card…</p>}</div></main>;
}
