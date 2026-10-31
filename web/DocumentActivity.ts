import {useEffect,useState} from 'react';

let nativeVisible=true,lastDocument:Document|undefined,backgroundUntil=0,backgroundSession:string|undefined;
function reset(){if(typeof document!=='undefined'&&lastDocument!==document){lastDocument=document;nativeVisible=true;backgroundUntil=0;backgroundSession=undefined;}}
export function debugEnvironment(){
  reset();const background=backgroundUntil>Date.now();const physicalVisible=(typeof document==='undefined'||document.visibilityState!=='hidden')&&nativeVisible;
  return {mode:background?'background-test' as const:'visible-window' as const,physicalVisible,renderActive:background||physicalVisible,backgroundSession:background?backgroundSession:undefined,backgroundExpiresAt:background?backgroundUntil:undefined};
}
export function updateNativeActivity(detail:{visible?:boolean;background?:{active:boolean;sessionId?:string;expiresAt?:number}}){
  reset();if(typeof detail.visible==='boolean')nativeVisible=detail.visible;
  if(detail.background){const b=detail.background,expires=b.expiresAt??0;
    if(b.active&&/^[a-f0-9-]{36}$/i.test(b.sessionId??'')&&Number.isSafeInteger(expires)&&expires>Date.now()&&expires<=Date.now()+7_200_000){backgroundUntil=expires;backgroundSession=b.sessionId;}
    else{backgroundUntil=0;backgroundSession=undefined;}
  }
}
export function useDocumentActivity(){
  reset();const [visible,setVisible]=useState(()=>debugEnvironment().renderActive);
  useEffect(()=>{let timer:ReturnType<typeof setTimeout>|undefined;const update=()=>{clearTimeout(timer);setVisible(debugEnvironment().renderActive);if(backgroundUntil>Date.now())timer=setTimeout(update,Math.max(1,backgroundUntil-Date.now()+1));};
    const native=(event:Event)=>{updateNativeActivity((event as CustomEvent).detail??{});update();};
    document.addEventListener('visibilitychange',update);window.addEventListener('agenticview:native-visibility',native);update();
    return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',update);window.removeEventListener('agenticview:native-visibility',native);};
  },[]);return visible;
}
