import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window, HTMLElement as HappyElement } from 'happy-dom';
import { cardDisplaySchema } from '../shared/card-display.ts';
import { AgentContent } from '../web/App.tsx';
import { CardActions, CardHeading } from '../web/CardChrome.tsx';
import { CardSurface } from '../web/CardSurface.tsx';
import { componentLayoutStyle } from '../web/ComponentLayout.tsx';
import { applyLivePatch } from '../shared/live-state.ts';
import type { AgentView, Snapshot } from '../shared/protocol.ts';

const settings={staleSeconds:45,autoArchiveMinutes:null,archiveAfterCompletion:false,trustedEmbeds:false,reducedMotion:true};
const agent:AgentView={id:'card',agentId:'synthetic',name:'Example',role:'Worker',context:'Context',parentId:null,createdAt:1,lastSeen:1,status:'active',sequence:0,layout:{x:0,y:0,width:900,height:600,z:1,locked:false},components:{
 first:{id:'first',kind:'metric',title:'First metric',data:{value:1}},
 table:{id:'table',kind:'table',title:'Wide table',data:{columns:[{key:'a',label:'A'}],rows:[{a:1}]}},
 plan:{id:'plan',kind:'markdown',title:'Current task plan',data:{text:'- [ ] Work'}}
}};
test('responsive support layout shares width, wide views span rows and plans remain first',async()=>{
 const dom=new Window();try{
  dom.document.body.innerHTML=renderToStaticMarkup(createElement(AgentContent,{agent,agents:[agent],settings}));
  const grid=dom.document.querySelector<HappyElement>('[aria-label="Supporting components"]')!;
  assert.equal(grid.dataset.layout,'auto');assert.match(grid.style.gridTemplateColumns,/auto-fit/);assert.match(grid.style.gridTemplateColumns,/200px/);
  assert.equal(grid.children.length,2);assert.equal(grid.querySelector('[data-layout-wide]')?.textContent?.includes('Wide table'),true);
  assert.ok(dom.document.body.innerHTML.indexOf('Current task plan')<dom.document.body.innerHTML.indexOf('Context'));
  assert.ok(!grid.textContent!.includes('Current task plan'));
  assert.equal(componentLayoutStyle({mode:'vertical'}).gridTemplateColumns,'minmax(0,1fr)');
  assert.equal(componentLayoutStyle({mode:'columns',columns:3,gap:0}).gridTemplateColumns,'repeat(3,minmax(0,1fr))');
 }finally{await dom.happyDOM.close();}
});
test('card controls hide, move, relabel and keep accessible icon-only buttons',async()=>{
 const dom=new Window();try{
  const chrome={fit:{visible:false},archive:{label:'Retain later',tooltip:'Archive this example',appearance:'icon' as const,placement:'footer' as const,variant:'primary' as const}};
  const actions=[{id:'fit' as const,label:'Fit',icon:'F',run:()=>{}},{id:'archive' as const,label:'Archive',icon:'A',run:()=>{}}];
  const render=(slot:'header'|'footer')=>renderToStaticMarkup(createElement(CardActions,{controls:chrome,actions,slot}));
  assert.doesNotMatch(render('header'),/<button/);dom.document.body.innerHTML=render('footer');
  const button=dom.document.querySelector('button')!;assert.equal(button.getAttribute('aria-label'),'Retain later');assert.equal(button.title,'Archive this example');assert.equal(button.textContent,'A');
  const heading=renderToStaticMarkup(createElement(CardHeading,{agent:{...agent,chrome:{title:{visible:false},role:{visible:false}}},origin:'Built-in component'}));
  assert.match(heading,/Built-in component/);assert.doesNotMatch(heading,/>Example</);
 }finally{await dom.happyDOM.close();}
});
test('navigation presentation and content padding stay identical across activation',()=>{
 const render=(active:boolean,hidden=false)=>renderToStaticMarkup(createElement(CardSurface,{id:'synthetic',active,children:createElement('p',null,'Content'),chrome:hidden?{navigation:{visible:false}}:{navigation:{placement:'bottom-left'},zoomIn:{visible:false},deactivate:{label:'Done',appearance:'text'}},deactivate:()=>{},canvasOwnsPointer:()=>false,forceCanvas:()=>false}));
 for(const active of [false,true]){const html=render(active);assert.match(html,/data-control-placement="bottom-left"/);assert.match(html,/padding-bottom:46px/);assert.match(html,/aria-label="Done"/);assert.doesNotMatch(html,/data-control="zoomIn"/);assert.doesNotMatch(render(active,true),/role="toolbar"/);}
});
test('display validation rejects executable options and live metadata retains unchanged display identities',()=>{
 for(const bad of [{chrome:{unknown:{visible:false}}},{chrome:{fit:{style:'color:red'}}},{componentLayout:{mode:'masonry'}},{componentLayout:{columns:9}},{componentLayout:{gap:-1}},{componentLayout:{minWidth:100}}])assert.equal(cardDisplaySchema.safeParse(bad).success,false);
 const current={...agent,chrome:{fit:{visible:false}},componentLayout:{mode:'auto' as const,minWidth:320}};
 const old:Snapshot={revision:0,agents:[current],settings,stats:{active:1,stale:0,archived:0,updates:0,updatesPerSecond:0}};
 const {components:_,...meta}=structuredClone(current);
 const next=applyLivePatch(old,{revision:1,changes:[{id:agent.id,meta}],removed:[],stats:old.stats});
 assert.equal(next.agents[0],current);assert.equal(next.agents[0]!.chrome,current.chrome);assert.equal(next.agents[0]!.componentLayout,current.componentLayout);
});

test('inline composition keeps small tables content-sized while task plans remain first',async()=>{
 const dom=new Window();try{
  dom.document.body.innerHTML=renderToStaticMarkup(createElement(AgentContent,{agent:{...agent,componentLayout:{mode:'inline',gap:4}},agents:[agent],settings}));
  const support=dom.document.querySelector('[aria-label="Supporting components"]')!;
  assert.equal(support.getAttribute('data-layout'),'inline');
  assert.equal(support.querySelectorAll('[data-layout-wide]').length,0);
  const sections=[...dom.document.querySelectorAll('.component')];
  assert.equal(sections[0]!.querySelector('.component-title')!.textContent,'Current task plan');
 }finally{await dom.happyDOM.close();}
});
