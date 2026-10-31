import {createContext,useContext,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';

const Activity=createContext(true);
let nativeVisible=true,lastDocument:Document|undefined;
export function useDocumentActivity(){
  if(typeof document!=='undefined'&&lastDocument!==document){lastDocument=document;nativeVisible=true;}
  const [visible,setVisible]=useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden'&&nativeVisible);
  useEffect(()=>{const update=()=>setVisible(document.visibilityState!=='hidden'&&nativeVisible);const native=(event:Event)=>{nativeVisible=(event as CustomEvent).detail?.visible!==false;update();};document.addEventListener('visibilitychange',update);window.addEventListener('agenticview:native-visibility',native);update();return()=>{document.removeEventListener('visibilitychange',update);window.removeEventListener('agenticview:native-visibility',native);};},[]);
  return visible;
}
export function useRenderActivity(){return useContext(Activity);}
export function useElementActivity(ref:RefObject<HTMLElement|null>,initiallyVisible=true,observe=true){
  const inherited=useRenderActivity(),documentActive=useDocumentActivity();
  const [intersects,setIntersects]=useState(()=>typeof IntersectionObserver==='undefined'||initiallyVisible);
  useLayoutEffect(()=>{const element=ref.current;if(!observe){setIntersects(true);return;}if(!element||typeof IntersectionObserver==='undefined')return;let alive=true;const observer=new IntersectionObserver(entries=>{if(alive){const entry=entries.at(-1);setIntersects(!!entry?.isIntersecting&&(entry.intersectionRatio===undefined||entry.intersectionRatio>0));}},{threshold:0});observer.observe(element);return()=>{alive=false;observer.disconnect();};},[ref,observe]);
  return inherited&&documentActive&&intersects;
}
/** Retain the last committed subtree and local state, then consume the latest
 * source once visible. Background readers observe Activity=false immediately. */
export function RenderBoundary({children,visible,kind='component',id}:{children:()=>ReactNode;visible?:boolean;kind?:'component'|'card';id?:string}){
  const element=useRef<HTMLDivElement>(null),cached=useRef<ReactNode>(null),height=useRef(8);
  const observed=useElementActivity(element,visible!==undefined,visible===undefined);
  const active=observed&&(visible??true);
  if(active)cached.current=children();
  useLayoutEffect(()=>{if(!active||!element.current||visible!==undefined)return;const box=element.current;const update=()=>{const next=box.getBoundingClientRect().height;if(next>0)height.current=next;};update();const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(update);observer?.observe(box);return()=>observer?.disconnect();},[active,visible]);
  return <div ref={element} className={`render-boundary render-boundary-${kind}`} data-render-id={id} data-render-active={active?'true':'false'} style={visible!==undefined?{display:active?'contents':'none'}:active?undefined:{contentVisibility:'hidden',containIntrinsicSize:`auto ${height.current}px`,minHeight:height.current,pointerEvents:'none'}}><Activity.Provider value={active}>{cached.current}</Activity.Provider></div>;
}
