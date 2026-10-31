import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {DataTable} from '../web/DataTable.tsx';

test('supplied tables honor configured page bounds, navigate rows and clamp when data shrinks',async()=>{
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),rows=Array.from({length:500},(_,i)=>({id:'row-'+i})),columns=[{key:'id',label:'ID'}];
 const render=async(pageSize?:number,count=rows.length)=>act(()=>root.render(createElement(DataTable,{data:{columns,rows:rows.slice(0,count),...(pageSize===undefined?{}:{pageSize})}})));
 const visible=()=>[...host.querySelectorAll('tbody tr')].map(row=>row.textContent);
 try{
  await render(5);assert.deepEqual(visible(),['row-0','row-1','row-2','row-3','row-4']);assert.match(host.querySelector('.pagination')!.textContent!,/1 \/ 100/);
  await act(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Next')!.click());assert.deepEqual(visible(),['row-5','row-6','row-7','row-8','row-9']);
  await render(200);assert.equal(visible().length,200);assert.equal(visible()[0],'row-200');
  await render(200,1);assert.deepEqual(visible(),['row-0']);assert.ok([...host.querySelectorAll('button')].every(button=>button.disabled));
  await act(()=>root.unmount());const next=createRoot(host);await act(()=>next.render(createElement(DataTable,{data:{columns,rows}})));assert.equal(visible().length,25,'omitted page size retains default');await act(()=>next.unmount());
 }finally{await act(()=>root.unmount());await dom.happyDOM.close();}
});
