import {createContext,useContext,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';

const Activity=createContext(true),Readers=createContext(true);
import {useDocumentActivity} from './DocumentActivity.js';
export {useDocumentActivity} from './DocumentActivity.js';
export function useRenderActivity(){return useContext(Activity);}
export function useRenderUpdates(){const active=useRenderActivity(),readers=useContext(Readers),documentActive=useDocumentActivity();return active&&readers&&documentActive;}
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
