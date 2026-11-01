import React,{useLayoutEffect,useState,type ComponentPropsWithRef,type ReactNode} from 'react';

type Props={[key:`data-${string}`]:string|number|boolean|undefined}&Omit<ComponentPropsWithRef<'details'>,'children'|'onToggle'>&{
 summary:ReactNode;
 summaryProps?:Omit<ComponentPropsWithRef<'summary'>,'children'>;
 children:()=>ReactNode;
 onToggle?:ComponentPropsWithRef<'details'>['onToggle'];
};
/** Defer body construction until observed native open or authored open=true.
 * The stable body position retains descendants through every later close. */
export function RetainedDetails({summary,summaryProps,children,open,onToggle,...props}:Props){
 const [visited,setVisited]=useState(open===true);
 const materialized=visited||open===true;
 // Latch controlled opening even if its next authored state is closed.
 useLayoutEffect(()=>{if(open===true)setVisited(true);},[open]);
 return <details {...props} open={open} data-retained-details="true" data-details-materialized={materialized?'true':'false'} onToggle={event=>{if(event.currentTarget.open)setVisited(true);onToggle?.(event);}}><summary {...summaryProps}>{summary}</summary>{materialized?children():null}</details>;
}
