import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,createRef,useEffect,useState} from 'react';
import {Window} from 'happy-dom';
import {RetainedDetails} from '../web/RetainedDetails.tsx';

async function fixture(){
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','HTMLInputElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),ref=createRef<HTMLDetailsElement>();let calls=0,mounts=0,unmounts=0,toggles=0,opened:boolean[]=[],label='first';
 function Body({label}:{label:string}){const [draft,setDraft]=useState('original');useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return createElement('div',null,createElement('span',{'data-source':true},label),createElement('input',{'aria-label':'Draft',value:draft,onInput:(e:any)=>setDraft(e.currentTarget.value)}));}
 async function render(open?:boolean,version='first',callback?:()=>void){label=version;await act(async()=>root.render(createElement(RetainedDetails,{ref,summary:'Settings',summaryProps:{'aria-label':'Editor settings'},className:'authored',title:'Author title',open,'data-authored':'retained',onToggle:event=>{toggles++;opened.push(event.currentTarget.open);callback?.();},children:()=>{calls++;return createElement(Body,{label});}})));}
 async function toggle(open:boolean){await act(async()=>{ref.current!.open=open;ref.current!.dispatchEvent(new Event('toggle'));});}
 return{dom,host,ref,render,toggle,get calls(){return calls;},get mounts(){return mounts;},get unmounts(){return unmounts;},get toggles(){return toggles;},opened,close:async()=>{await act(async()=>root.unmount());assert.equal(ref.current,null);await dom.happyDOM.close();}};
}
test('never constructs closed bodies; native first open latches one subtree, preserving drafts and ref across close/reopen and latest props',async()=>{
 const f=await fixture();try{await f.render();const node=f.ref.current!;assert.equal(f.calls,0);assert.equal(f.mounts,0);assert.equal(node.dataset.detailsMaterialized,'false');assert.equal(node.dataset.retainedDetails,'true');assert.equal(node.className,'authored');assert.equal(node.title,'Author title');assert.equal(node.dataset.authored,'retained');assert.equal(node.querySelector('summary')!.getAttribute('aria-label'),'Editor settings');
 await f.render(undefined,'latest before open');assert.equal(f.calls,0);await f.toggle(true);assert.equal(f.mounts,1);assert.equal(node.dataset.detailsMaterialized,'true');assert.equal(node.querySelector('[data-source]')!.textContent,'latest before open');const input=node.querySelector<HTMLInputElement>('input')!;
 await act(async()=>{input.focus();input.value='retained draft';input.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(document.activeElement,input);
 await f.toggle(false);await f.render(undefined,'updated while closed');assert.equal(node.querySelector('input'),input);assert.equal(input.value,'retained draft');assert.equal(node.querySelector('[data-source]')!.textContent,'updated while closed');await f.toggle(true);assert.equal(f.ref.current,node);assert.equal(node.querySelector('input'),input);assert.equal(f.mounts,1);assert.equal(f.unmounts,0);assert.ok(f.toggles>=3);assert.ok(f.opened.includes(true)&&f.opened.includes(false));
 }finally{await f.close();}assert.equal(f.unmounts,1);
});
test('initial and later controlled open construct immediately and remain mounted when controlled closed',async()=>{
 for(const initial of [true,false]){const f=await fixture();try{await f.render(initial);assert.equal(f.mounts,initial?1:0);if(!initial){await f.render(false,'still closed');assert.equal(f.calls,0);await f.render(true,'controlled open');}const input=f.ref.current!.querySelector('input');assert.ok(input);assert.equal(f.mounts,1);await f.render(false,'controlled closed update');assert.equal(f.ref.current!.open,false);assert.equal(f.ref.current!.querySelector('input'),input);assert.equal(f.mounts,1);assert.equal(f.ref.current!.dataset.detailsMaterialized,'true');}finally{await f.close();}}
});
test('consumer toggle callback retains control and internal markers cannot be spoofed by authored attrs',async()=>{
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);let notifications=0,calls=0;
 function Controlled(){const [open,setOpen]=useState(false);return createElement(RetainedDetails,{open,summary:'Controlled','data-retained-details':'spoof','data-details-materialized':'spoof',onToggle:e=>{notifications++;setOpen(e.currentTarget.open);},children:()=>{calls++;return createElement('input',{'aria-label':'Controlled body'});}});}
 try{await act(async()=>root.render(createElement(Controlled)));const details=host.querySelector('details')!;assert.equal(calls,0);assert.equal(details.dataset.retainedDetails,'true');assert.equal(details.dataset.detailsMaterialized,'false');await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});assert.ok(notifications>=1);assert.ok(calls>0);assert.equal(details.open,true);assert.equal(details.dataset.detailsMaterialized,'true');}finally{await act(async()=>root.unmount());await dom.happyDOM.close();}
});
