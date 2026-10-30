import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { measureContentSize, contentSizeTarget } from '../web/ContentSize.ts';

test('content fitting sees table width across scroll containers, includes real chrome and converges at the width limit',()=>{
 const dom=new Window(), card=dom.document.createElement('article') as unknown as HTMLElement;card.dataset.cardId='test';
 card.innerHTML='<div data-card-surface="test"><div class="card-content-scroll"><div class="agent-content-measure"><div class="component"><div class="control-grid"><table><tbody><tr><td>Content</td></tr></tbody></table></div></div></div></div></div>';
 const measure=card.querySelector<HTMLElement>('.agent-content-measure')!, viewport=card.querySelector<HTMLElement>('.card-content-scroll')!,wrapper=card.querySelector<HTMLElement>('.control-grid')!,table=card.querySelector<HTMLElement>('table')!;
 let current={width:480,height:420};
 Object.defineProperty(card,'offsetHeight',{get:()=>current.height});Object.defineProperty(viewport,'clientHeight',{get:()=>current.height-160});
 Object.defineProperty(measure,'offsetWidth',{get:()=>current.width-40});Object.defineProperty(measure,'scrollWidth',{get:()=>current.width-40});Object.defineProperty(measure,'offsetHeight',{get:()=>700});Object.defineProperty(measure,'scrollHeight',{get:()=>720});
 Object.defineProperty(wrapper,'clientWidth',{get:()=>current.width-68});Object.defineProperty(table,'offsetWidth',{get:()=>900});Object.defineProperty(table,'scrollWidth',{get:()=>900});
 current=contentSizeTarget(current,measureContentSize(measure));assert.deepEqual(current,{width:968,height:880});
 for(let i=0;i<8;i++)assert.deepEqual(contentSizeTarget(current,measureContentSize(measure)),current,'unchanged content must not keep growing');
 assert.equal(contentSizeTarget(current,{width:400,requiredWidth:100000,height:1000000,chromeHeight:160}).width,1600);assert.equal(contentSizeTarget(current,{width:400,requiredWidth:100000,height:1000000,chromeHeight:160}).height,100000);
 dom.happyDOM.close();
});

test('explicit editor fits grow in either direction while passive measurement may reduce height without reducing width',()=>{
 const current={width:700,height:800};
 assert.deepEqual(contentSizeTarget(current,{width:660,requiredWidth:900,height:1000,chromeHeight:160,explicit:true}),{width:940,height:1160});
 assert.deepEqual(contentSizeTarget(current,{width:660,requiredWidth:660,height:300,chromeHeight:160,explicit:true}),current);
 assert.deepEqual(contentSizeTarget(current,{width:660,requiredWidth:660,height:300,chromeHeight:160}),{width:700,height:460});
});
