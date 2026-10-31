import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {debugEnvironment,updateNativeActivity} from '../web/DocumentActivity.ts';
import {debugJobAllowed,createDebugMeasurements} from '../web/ComponentDebug.ts';

test('finite background rendering retains physical visibility and exact session authority',async()=>{
 const dom=new Window();Object.assign(globalThis,{window:dom,document:dom.document});Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
 const session='a0000000-0000-4000-8000-000000000000',other='b0000000-0000-4000-8000-000000000000';
 try{
  updateNativeActivity({visible:false});assert.equal(debugEnvironment().renderActive,false);assert.equal(debugJobAllowed(session),false);
  updateNativeActivity({background:{active:true,sessionId:session,expiresAt:Date.now()+1000}});
  assert.equal(debugEnvironment().renderActive,true);assert.equal(debugEnvironment().physicalVisible,false);assert.equal(debugEnvironment().mode,'background-test');assert.equal(debugJobAllowed(session),true);assert.equal(debugJobAllowed(other),false);
  updateNativeActivity({visible:false});assert.equal(debugEnvironment().renderActive,true,'physical window state does not silently revoke an explicit test');
  updateNativeActivity({background:{active:false,sessionId:session}});assert.equal(debugEnvironment().renderActive,false);
  for(const expiresAt of [Date.now()-1,Date.now()+7_300_000,Infinity]){updateNativeActivity({background:{active:true,sessionId:session,expiresAt}});assert.equal(debugEnvironment().renderActive,false);}
  updateNativeActivity({background:{active:true,sessionId:'invalid',expiresAt:Date.now()+1000}});assert.equal(debugEnvironment().renderActive,false);
 }finally{await dom.happyDOM.close();}
});
