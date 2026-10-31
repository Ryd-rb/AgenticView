import { memo,useEffect,useMemo,useRef,useState } from 'react';
import { z } from 'zod';
import { chartDataSchema,type ChartData } from '../shared/native-extensions.js';
import { ChartView } from './ChartView.js';
import { useControls } from './ControlViews.js';
import { useElementActivity } from './RenderActivity.js';

const resultSchema=z.strictObject({series:chartDataSchema.shape.series,rawPoints:z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()});
const Plot=memo(ChartView);
export function SourceChart({data,runId,manual}:{data:ChartData;runId:string;manual:boolean}){
  const frame=useRef<HTMLDivElement>(null),visible=useElementActivity(frame),controls=useControls(runId,manual&&visible,visible);
  const [last,setLast]=useState<{data:ChartData;rawPoints?:number;count:number;receivedAt:number}>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const sourceKey=JSON.stringify(data.source),source=data.source;
  const fallback=useMemo(()=>{const {source:_,...value}=data;return value;},[data]);
  useEffect(()=>{setLast(undefined);setError('');},[sourceKey]);
  useEffect(()=>{
    if(!visible||!source||!controls.config)return;
    const action=controls.config.actions.find(action=>action.id===source.readAction);
    if(!action||action.kind!=='query'||action.confirmation){setError('Source charts require an available confirmation-free query action.');return;}
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined,deadline:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      try{
        const to=source.to??Date.now(),from=source.from??Math.max(0,to-(source.windowMs??60_000)),maxPoints=source.maxPoints??512;
        setError('');deadline=setTimeout(()=>controls.cancel(),15_000);
        const invocation=await controls.invoke(source.readAction,{from,to,maxPoints},'query',true);
        if(disposed)return;
        const result=resultSchema.parse(invocation.result??{});
        if(result.series.some(series=>series.points.length>maxPoints))throw new Error('Provider returned more than the requested point limit.');
        const next=chartDataSchema.parse({...fallback,series:result.series});
        setLast({data:next,rawPoints:result.rawPoints,count:result.series.reduce((count,series)=>count+series.points.length,0),receivedAt:Date.now()});
      }catch(failure){if(!disposed)setError(failure instanceof DOMException&&failure.name==='AbortError'?'Chart query was cancelled or exceeded its deadline.':failure instanceof Error?failure.message:'Chart query failed.');}
      finally{if(deadline!==undefined)clearTimeout(deadline);if(!disposed)timer=setTimeout(()=>void poll(),source.pollMs??1500);}
    };
    void poll();
    return()=>{disposed=true;if(timer!==undefined)clearTimeout(timer);if(deadline!==undefined)clearTimeout(deadline);controls.cancel();};
  },[visible,sourceKey,fallback,controls.config,controls.invoke,controls.cancel,refresh]);
  // A frozen plot retains local series/table inspection state while a query is pending or hidden.
  const shown=useRef<ChartData>(fallback);if(visible)shown.current=last?{...fallback,series:last.data.series}:fallback;
  return <div ref={frame} className="source-chart" data-source-state={!visible?'paused':error||controls.error?'error':last?'ready':controls.busy?'loading':'fallback'} data-source-received-at={last?.receivedAt} aria-busy={visible&&controls.busy}>
    <div className="control-toolbar"><span role="status">{!visible?'Chart queries paused':last?`${last.rawPoints===undefined?'Provider':last.rawPoints.toLocaleString('en-US')+' raw'} points · ${last.count.toLocaleString('en-US')} displayed`:controls.busy?'Loading chart query…':'Static chart fallback'}</span><button type="button" disabled={!manual||!visible||controls.busy} onClick={()=>setRefresh(value=>value+1)}>Refresh chart</button></div>
    {(error||controls.error)&&<p role="alert">{error||controls.error}</p>}
    <Plot data={shown.current} manual={manual} sampledByProvider={!!last}/>
  </div>;
}
