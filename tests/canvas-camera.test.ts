import test from 'node:test';
import assert from 'node:assert/strict';
import {CanvasCamera} from '../web/CanvasCamera.ts';

function surface(){const animations:any[]=[];const element={style:{transform:''},animate:(frames:Keyframe[])=>{let writes=0,time:any=null;const animation={frames,playbackRate:1,cancelled:false,get writes(){return writes;},get currentTime(){return time;},set currentTime(value:any){time=value;writes++;},cancel(){this.cancelled=true;}};animations.push(animation);return animation;}};return {element:element as unknown as HTMLElement,animations};}
function value(entry:ReturnType<typeof surface>){const animation=entry.animations.at(-1),from=Number(String(animation.frames[0].transform).match(/\(([-\d.]+)/)![1]),to=Number(String(animation.frames[1].transform).match(/\(([-\d.]+)/)![1]);return from+(to-from)*animation.currentTime/1000;}
test('manual canvas timelines follow the requested affine pose exactly and never play forward',()=>{
 const x=surface(),y=surface(),scale=surface(),camera=new CanvasCamera(x.element,y.element,scale.element);
 for(const pose of [{x:72,y:86,zoom:1},{x:-555.25,y:731.125,zoom:.00001},{x:1e8,y:-1e8,zoom:16}]){
  camera.draw(pose);assert.ok(Math.abs(value(x)-pose.x)<1e-6);assert.ok(Math.abs(value(y)-pose.y)<1e-6);assert.ok(Math.abs(value(scale)-pose.zoom)<1e-8);
  for(const s of [x,y,scale])assert.equal(s.animations.at(-1).playbackRate,0);
  const writes=[x,y,scale].map(s=>s.animations.at(-1).writes);camera.draw(pose);assert.deepEqual([x,y,scale].map(s=>s.animations.at(-1).writes),writes);
 }
 assert.ok(x.animations[0].cancelled);assert.equal(camera.uses(x.element,y.element,scale.element),true);camera.dispose();for(const s of [x,y,scale])assert.ok(s.animations.at(-1).cancelled);
});
test('canvas pose has an immediate CSS fallback without Web Animations',()=>{
 const surfaces=Array.from({length:3},()=>({style:{transform:''}} as unknown as HTMLElement)),camera=new CanvasCamera(...surfaces as [HTMLElement,HTMLElement,HTMLElement]);camera.draw({x:-12,y:45,zoom:.125});assert.deepEqual(surfaces.map(s=>s.style.transform),['translateX(-12px)','translateY(45px)','scale(0.125)']);camera.dispose();
});

test('resident camera frames do not retain another promise reaction on every input',()=>{
 let reactions=0;const surfaces=Array.from({length:3},()=>({style:{transform:''},animate:()=>({playbackRate:1,currentTime:null,cancel(){},finished:{catch(){reactions++;}},ready:{catch(){reactions++;}}})} as unknown as HTMLElement));
 const camera=new CanvasCamera(...surfaces as [HTMLElement,HTMLElement,HTMLElement]);
 for(let i=0;i<1000;i++)camera.draw({x:i,y:-i,zoom:1});
 assert.equal(reactions,6);camera.dispose();
});
