import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Minus, Square, X } from 'lucide-react';

type WindowState = 'fullscreen' | 'normal' | 'minimized' | 'maximized';
type Bridge = { postMessage: (message: unknown) => void; addEventListener: (event: 'message', callback: (event: { data: unknown }) => void) => void; removeEventListener: (event: 'message', callback: (event: { data: unknown }) => void) => void };
function desktop() { return (typeof window==='undefined'?{}:window) as unknown as { agenticViewDesktop?: { version: number; popOut?:boolean; cardId?:string; focusCardId?:string }; chrome?: { webview?: Bridge } }; }
export function desktopCardId(){const id=desktop().agenticViewDesktop?.cardId;return id&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)?id:null;}
export function desktopFocusCardId(){const id=desktop().agenticViewDesktop?.focusCardId;return id&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)?id:null;}
export function canPopOut(){return desktop().agenticViewDesktop?.version===1&&desktop().agenticViewDesktop?.popOut===true&&!!desktop().chrome?.webview;}
export function popOutCard(cardId:string,title:string):Promise<void>{
  const bridge=desktop().chrome?.webview;
  if(!canPopOut()||!bridge)return Promise.reject(new Error('Pop out is available in the dedicated Windows app.'));
  return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();const stop=()=>{clearTimeout(timer);bridge.removeEventListener('message',changed);};const changed=(event:{data:unknown})=>{const value=event.data as {type?:string;requestId?:string;ok?:boolean;message?:string};if(value?.type!=='agenticview:popout-result'||value.requestId!==requestId)return;stop();if(value.ok)resolve();else reject(new Error(value.message??'The independent window did not open.'));};const timer=setTimeout(()=>{stop();reject(new Error('Window launch was not acknowledged. Check the taskbar before trying again.'));},15000);bridge.addEventListener('message',changed);try{bridge.postMessage({type:'agenticview:popout',requestId,cardId,title:title.slice(0,160)});}catch(error){stop();reject(error);}});
}
export function windowCommand(action: 'minimize' | 'maximize' | 'close' | 'drag' | 'fullscreen') {
  if (desktop().agenticViewDesktop?.version === 1) desktop().chrome?.webview?.postMessage({ type: 'agenticview:window', action });
}
export function WindowControls() {
  const [enabled, setEnabled] = useState(false), [state, setState] = useState<WindowState>(desktopCardId()?'normal':'fullscreen');
  useEffect(() => {
    const bridge = desktop().chrome?.webview; if (!bridge || desktop().agenticViewDesktop?.version !== 1) return;
    setEnabled(true); document.documentElement.classList.add('desktop-host');
    const changed = (event: { data: unknown }) => { const message = event.data as { type?: string; state?: WindowState }; if (message?.type === 'agenticview:window-state' && ['fullscreen', 'normal', 'minimized', 'maximized'].includes(message.state ?? '')) setState(message.state!); };
    bridge.addEventListener('message', changed);
    return () => { bridge.removeEventListener('message', changed); document.documentElement.classList.remove('desktop-host'); };
  }, []);
  if (!enabled) return null;
  const restored = state === 'normal';
  return createPortal(<div className="window-controls" role="toolbar" aria-label="Window controls"><button title="Minimize" aria-label="Minimize window" onClick={() => windowCommand('minimize')}><Minus size={15} /></button><button title={restored ? 'Maximize' : 'Restore window'} aria-label={restored ? 'Maximize window' : 'Restore window'} onClick={() => windowCommand('maximize')}>{restored ? <Square size={13} /> : <Copy size={13} />}</button><button className="window-close" title="Close window" aria-label="Close window" onClick={() => windowCommand('close')}><X size={16} /></button></div>, document.body);
}
