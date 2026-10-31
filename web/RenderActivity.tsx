import {createContext,useContext,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';

const Activity=createContext(true),Readers=createContext(true);
let nativeVisible=true,lastDocument:Document|undefined;
export function useDocumentActivity(){
  if(typeof document!=='undefined'&&lastDocument!==document){lastDocument=document;nativeVisible=true;}
  const [visible,setVisible]=useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden'&&nativeVisible);
  useEffect(()=>{const update=()=>setVisible(document.visibilityState!=='hidden'&&nativeVisible);const native=(event:Event)=>{nativeVisible=(event as CustomEvent).detail?.visible!==false;update();};document.addEventListener('visibilitychange',update);window.addEventListener('agenticview:native-visibility',native);update();return()=>{document.removeEventListener('visibilitychange',update);window.removeEventListener('agenticview:native-visibility',native);};},[]);
  return visible;
}
export function useRenderActivity(){return useContext(Activity);}
export function useElementActivity(ref:RefObject<HTMLElement|null>,initiallyVisible=true,observe=true,visibilityOnly=false){
  const inherited=useRenderActivity(),readers=useContext(Readers),documentActive=useDocumentActivity();
  const [intersects,setIntersects]=useState(()=>typeof IntersectionObserver==='undefined'||initiallyVisible);
  useLayoutEffect(()=>{const element=ref.current;if(!observe){setIntersects(true);return;}if(!element||typeof IntersectionObserver==='undefined')return;let alive=true;const observer=new IntersectionObserver(entries=>{if(alive){const entry=entries.at(-1);setIntersects(!!entry?.isIntersecting&&(entry.intersectionRatio===undefined||entry.intersectionRatio>0));}},{threshold:0});observer.observe(element);return()=>{alive=false;observer.disconnect();};},[ref,observe]);
  return inherited&&documentActive&&intersects&&(visibilityOnly||readers);
}
/** Retain the last committed subtree and local state, then consume the latest
 * source once visible. Revision refreshes an existing shell's authority/pose even
 * while inactive; nested boundaries still retain their heavy content independently. */
export function RenderBoundary({children,visible,updates=true,revision,kind='component',id}:{children:()=>ReactNode;visible?:boolean;updates?:boolean;revision?:string|number;kind?:'component'|'card';id?:string}){
  const element=useRef<HTMLDivElement>(null),cached=useRef<ReactNode>(null),cachedRevision=useRef(revision);
  const observed=useElementActivity(element,visible!==undefined,visible===undefined,true),inheritedReaders=useContext(Readers);
  const active=observed&&(visible??true);
  if(active&&(updates||cached.current===null)||cached.current!==null&&!Object.is(cachedRevision.current,revision)){cached.current=children();cachedRevision.current=revision;}

  return <div ref={element} className={`render-boundary render-boundary-${kind}`} data-render-id={id} data-render-active={active?'true':'false'} data-render-updates={active&&updates&&inheritedReaders?'true':'false'} style={visible!==undefined?{display:active||cached.current!==null?'contents':'none'}:active||cached.current!==null?undefined:{minHeight:8}}><Activity.Provider value={active}><Readers.Provider value={active&&updates&&inheritedReaders}>{cached.current}</Readers.Provider></Activity.Provider></div>;
}
