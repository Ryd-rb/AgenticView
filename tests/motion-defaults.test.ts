import test from 'node:test';
import assert from 'node:assert/strict';
import { act,createElement } from 'react';
import { Window } from 'happy-dom';
import { settingsSchema,componentSchema } from '../shared/protocol.ts';
import { presentationStyle } from '../web/ComponentSettings.tsx';
import { ComponentView } from '../web/Components.tsx';
import { useMotionSettings } from '../web/Motion.ts';
import { fixture,secrets } from './server-fixture.ts';

test('new installation motion defaults are quiet and explicit opt-in survives restart',async()=>{
  assert.equal(settingsSchema.parse({}).reducedMotion,true);
  let f=await fixture();const directory=f.dir;try{
    const before=await(await f.call('/api/snapshot',secrets.viewerToken)).json();assert.equal(before.settings.reducedMotion,true);
    const changed=await f.call('/api/settings',secrets.viewerToken,{...before.settings,reducedMotion:false},'PUT');assert.equal(changed.status,200);assert.equal((await changed.json()).reducedMotion,false);
    await f.close(false);f=await fixture(directory);assert.equal((await(await f.call('/api/snapshot',secrets.viewerToken)).json()).settings.reducedMotion,false);
  }finally{await f.close(true);}
});

test('component motion requires explicit subtle opt-in and installation opt-in remains reversible',async()=>{
  const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const previous=globalThis.IntersectionObserver;Object.defineProperty(globalThis,'IntersectionObserver',{configurable:true,value:undefined});
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  function Display({reduced,animation}:{reduced:boolean;animation?:'none'|'subtle'}){useMotionSettings(reduced);const component=componentSchema.parse({id:'motion',kind:'metric',title:'Motion metadata',data:{value:1},configuration:{presentation:animation?{animation,animationDurationMs:0}:{}}});return createElement(ComponentView,{component,runId:'synthetic',embeds:false});}
  try{
    await act(async()=>{root.render(createElement(Display,{reduced:true}));await settle();});assert.ok(document.documentElement.classList.contains('reduced-motion'));assert.ok(!document.documentElement.classList.contains('motion-enabled'));assert.equal(host.querySelector('.component')!.getAttribute('data-component-animation'),'none');assert.equal((presentationStyle({}) as Record<string,unknown>)['--component-motion-duration'],'0ms');
    await act(async()=>{root.render(createElement(Display,{reduced:false,animation:'subtle'}));await settle();});assert.ok(document.documentElement.classList.contains('motion-enabled'));assert.equal(host.querySelector('.component')!.getAttribute('data-component-animation'),'subtle');assert.equal(host.querySelector<HTMLElement>('.component-configured')!.style.getPropertyValue('--component-motion-duration'),'0ms');
    await act(async()=>{root.render(createElement(Display,{reduced:true,animation:'subtle'}));await settle();});assert.ok(!document.documentElement.classList.contains('motion-enabled'));assert.ok(document.documentElement.classList.contains('reduced-motion'));
  }finally{await act(async()=>root.unmount());assert.ok(!document.documentElement.classList.contains('motion-enabled'));Object.defineProperty(globalThis,'IntersectionObserver',{configurable:true,value:previous});await dom.happyDOM.close();}
});
