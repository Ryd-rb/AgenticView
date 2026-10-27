import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Minus, Square, X } from 'lucide-react';

type WindowState = 'fullscreen' | 'normal' | 'minimized' | 'maximized';
type Bridge = { postMessage: (message: unknown) => void; addEventListener: (event: 'message', callback: (event: { data: unknown }) => void) => void; removeEventListener: (event: 'message', callback: (event: { data: unknown }) => void) => void };
function desktop() { return window as unknown as { agenticViewDesktop?: { version: number }; chrome?: { webview?: Bridge } }; }
export function windowCommand(action: 'minimize' | 'maximize' | 'close' | 'drag' | 'fullscreen') {
  if (desktop().agenticViewDesktop?.version === 1) desktop().chrome?.webview?.postMessage({ type: 'agenticview:window', action });
}
export function WindowControls() {
  const [enabled, setEnabled] = useState(false), [state, setState] = useState<WindowState>('fullscreen');
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
