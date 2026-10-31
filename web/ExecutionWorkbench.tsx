import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Plus, Search, Settings2, Check, X, ArrowUpRight } from 'lucide-react';
import { executionLanes, executionStatuses, formatQuantity, strategyForRow, visibleExecutionRows, type ExecutionData, type ExecutionRow, type ExecutionStyle } from '../shared/execution-workbench.js';
import type { Component } from '../shared/protocol.js';
import { domainFraction } from '../shared/native-extensions.js';

type Workbench = Extract<Component,{kind:'execution-workbench'}>;
type Colors = {accent:string;background:string;panel:string;text:string;muted:string;grid:string;bid:string;ask:string;strategy:string};
export const executionThemes: Record<'graphite'|'paper'|'terminal',Colors> = {
  graphite:{accent:'#9cbcff',background:'#101722',panel:'#172231',text:'#e5edf7',muted:'#a6b7cc',grid:'#314358',bid:'#74d4c8',ask:'#f5c17a',strategy:'#bd9df9'},
  paper:{accent:'#2157aa',background:'#f3f6fa',panel:'#ffffff',text:'#162638',muted:'#52677c',grid:'#c8d3df',bid:'#087c6f',ask:'#a75408',strategy:'#7651b1'},
  terminal:{accent:'#72e3bc',background:'#0b1413',panel:'#101f1c',text:'#d6f2e7',muted:'#98bbae',grid:'#294c40',bid:'#72e3bc',ask:'#e4ca78',strategy:'#b4a6eb'},
};
const defaultStatuses:Record<string,string>={created:'#b19be8',running:'#6eaeed',paused:'#d4b76d',completed:'#91adca',error:'#ea8997',pending:'#e7c17e',working:'#6eaee8','partially-filled':'#dcab60',filled:'#6bc7a4',cancelled:'#a3aec0',rejected:'#e78b98',open:'#72c6aa',closed:'#b39bdd',failed:'#ea8997'};
const lightStatuses:Record<string,string>={created:'#7651a6',running:'#2866ac',paused:'#80600f',completed:'#526b89',error:'#b02d42',pending:'#90630e',working:'#2866ac','partially-filled':'#94600c',filled:'#08785b',cancelled:'#606c7a',rejected:'#b02d42',open:'#08785b',closed:'#7651a6',failed:'#b02d42'};
const digits=(ticker:string)=>ticker.endsWith('/JPY')?3:5;
const pip=(ticker:string)=>ticker.endsWith('/JPY')?.01:.0001;
const exact=(time:number)=>new Date(time).toISOString().replace('T',' ').replace('.000Z',' UTC');
function clock(time:number,days=false){const date=new Date(time);return days?`${date.toISOString().slice(5,10)} ${date.toISOString().slice(11,16)}`:date.toISOString().slice(11,23);}
function duration(row:ExecutionRow,last:number){const value=(row.end??last)-row.start;if(value<0)return '—';return value<60000?`${(value/1000).toFixed(1)}s`:value<3600000?`${Math.round(value/60000)}m`:value<86400000?`${(value/3600000).toFixed(1)}h`:`${(value/86400000).toFixed(1)}d`;}
function Status({row,color}:{row:ExecutionRow;color:(row:ExecutionRow)=>string}){return <span className="execution-status" style={{color:color(row)}}><i aria-hidden="true"/>{row.status.replaceAll('-',' ')}</span>;}

function PricePlot({root,selected,rows,points,color,select,manual}:{root:ExecutionRow;selected:ExecutionRow;rows:ExecutionRow[];points:ExecutionData['series'][number]['points'];color:(row:ExecutionRow)=>string;select:(row:ExecutionRow)=>void;manual:boolean}){
  const [lanePage,setLanePage]=useState(0),[width,setWidth]=useState(1120),frame=useRef<HTMLElement>(null);
  useEffect(()=>{const update=()=>{const value=frame.current?.clientWidth;if(value)setWidth(Math.max(640,Math.round(value)));};update();const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(update);if(frame.current)observer?.observe(frame.current);return()=>observer?.disconnect();},[]);
  useEffect(()=>setLanePage(0),[root.id]);
  const events=rows.filter(row=>row.strategyId===root.id).sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
  const selectedOrder=selected.kind==='order'?selected.id:selected.kind==='trade'?selected.parentId:undefined;
  const allLanes=executionLanes(rows,root.id), filtered=selectedOrder?allLanes.filter(lane=>lane.order.id===selectedOrder):allLanes;
  const pages=Math.max(1,Math.ceil(filtered.length/8)), current=Math.min(lanePage,pages-1),lanes=filtered.slice(current*8,current*8+8);
  const times=[...points.map(p=>p.time),...events.map(row=>row.start),...events.flatMap(row=>row.end?[row.end]:[])];
  const minTime=Math.min(root.start,...times),maxTime=Math.min(8_640_000_000_000_000,Math.max(minTime+1000,...times)),span=Math.max(1,maxTime-minTime);
  const x=(time:number)=>72+(time-minTime)/span*(width-120);
  const values=points.flatMap(point=>[point.bid,point.ask]);
  const low=values.length?Math.min(...values):root.bid,high=values.length?Math.max(...values):root.ask,pad=Math.max((high-low)*.15,pip(root.ticker)*2);
  const y=(value:number)=>202-domainFraction(value,Math.max(0,low-pad),Math.min(Number.MAX_VALUE,high+pad))*174;
  const shownEvents=[...new Map([...events.slice(0,99),selected,...lanes.flatMap(lane=>lane.trade?[lane.order,lane.trade]:[lane.order])].map(row=>[row.id,row])).values()];
  const quote=points.at(-1),precision=digits(root.ticker),days=span>=86400000;
  return <section ref={frame} className="execution-prices" aria-label="Linked price and execution chart" data-strategy-id={root.id} data-selected-id={selected.id}>
    <div className="execution-chart-heading"><strong>{root.ticker} <span>{root.id}</span></strong><span className="execution-quote"><b className="execution-bid">Bid {quote?.bid.toFixed(precision)??'—'}</b><b className="execution-ask">Ask {quote?.ask.toFixed(precision)??'—'}</b><span>{quote?((quote.ask-quote.bid)/pip(root.ticker)).toFixed(1):'—'} pips</span></span><span className="execution-window">{duration(root,maxTime)} · UTC</span></div>
    <div className="execution-chart-legend"><span><i className="execution-strategy-line"/>Strategy created</span><span><i className="execution-order-line"/>Order placed</span><span><i className="execution-trade-line"/>Trade / fill</span><span>Line color = current status · select an event below</span></div>
    <svg className="execution-price-plot" style={{height:238+lanes.length*30,minWidth:640}} viewBox={`0 0 ${width} ${238+lanes.length*30}`} role="group" aria-label={`${root.ticker} synthetic bid and ask prices with ${events.length} execution events`}>
      {Array.from({length:5},(_,index)=>{const value=low-pad+(high-low+pad*2)*index/4;return <g key={index}><line className="execution-chart-grid" x1="72" x2={width-48} y1={y(value)} y2={y(value)}/><text x="64" y={y(value)+4} textAnchor="end">{value.toFixed(precision)}</text></g>;})}
      {Array.from({length:6},(_,index)=>{const time=minTime+span*index/5;return <text key={index} x={x(time)} y="226" textAnchor="middle">{clock(time,days)}</text>;})}
      {points.length>0&&<><polyline className="execution-bid-curve" points={points.map(p=>`${x(p.time)},${y(p.bid)}`).join(' ')} fill="none" vectorEffect="non-scaling-stroke"/><polyline className="execution-ask-curve" points={points.map(p=>`${x(p.time)},${y(p.ask)}`).join(' ')} fill="none" vectorEffect="non-scaling-stroke"/></>}
      {shownEvents.map(row=><g key={row.id} className={`execution-event execution-event-${row.kind}`} data-event-id={row.id}><title>{row.kind} {row.id} · {row.status} · {exact(row.start)}</title><line x1={x(row.start)} x2={x(row.start)} y1="18" y2="204" stroke={color(row)} strokeWidth={row.id===selected.id?2.5:1.2} strokeDasharray={row.kind==='strategy'?undefined:row.kind==='order'?'6 4':'2 4'} opacity={row.id===selected.id?1:.65}/>{row.kind==='trade'?<circle cx={x(row.start)} cy="18" r="4" fill={color(row)}/>:<rect x={x(row.start)-3} y="14" width="6" height="8" fill={color(row)}/>}</g>)}
      {lanes.map(({order,trade,lane},index)=>{const y=256+index*30,end=trade?.start??order.end??maxTime;return <g key={lane} data-association-lane={lane} data-order-id={order.id} data-trade-id={trade?.id}>
        <line x1={x(order.start)} x2={x(order.start)} y1="204" y2={y} stroke={color(order)} opacity=".25" strokeDasharray="3 4"/>{trade&&<line x1={x(trade.start)} x2={x(trade.start)} y1="204" y2={y} stroke={color(trade)} opacity=".25" strokeDasharray="2 4"/>}
        <line x1={x(order.start)} x2={x(end)} y1={y} y2={y} stroke={color(order)} strokeWidth="3"/><rect x={x(order.start)-3} y={y-5} width="6" height="10" fill={color(order)}/>{trade&&<circle cx={x(trade.start)} cy={y} r="4" fill={color(trade)}/>}
      </g>;})}
    </svg>
    {!points.length&&<p className="execution-note">No price history supplied for this strategy.</p>}
    <div className="execution-associations" aria-label="Order and trade associations">
      <div className="execution-association-caption"><button disabled={!manual} onClick={()=>select(root)}><i style={{background:color(root)}}/>Created {clock(root.start,days)}</button><span>Separate lane per trade · order → fill · {filtered.length} associations</span>{pages>1&&<><button disabled={!manual||current===0} onClick={()=>setLanePage(current-1)}>Previous lanes</button><span>{current+1}/{pages}</span><button disabled={!manual||current+1===pages} onClick={()=>setLanePage(current+1)}>Next lanes</button></>}</div>
      {lanes.map(({order,trade,lane})=><div className="execution-association" key={`${order.id}:${trade?.id??'pending'}`} data-order-id={order.id} data-trade-id={trade?.id} data-lane={lane}>
        <button className="execution-order-label" disabled={!manual} aria-pressed={selected.id===order.id} onClick={()=>select(order)} title={`${order.id} · ${exact(order.start)}`}><span className="execution-kind">O</span>{order.id}<Status row={order} color={color}/></button>
        <div className="execution-association-track" aria-label={`${order.id} associated with ${trade?.id??'no fills yet'}`}><span className="execution-association-bar" style={{left:`${(order.start-minTime)/span*100}%`,width:`${Math.max(.25,((trade?.start??order.end??maxTime)-order.start)/span*100)}%`,background:color(order)}}/><i style={{left:`${(order.start-minTime)/span*100}%`,background:color(order)}}/>{trade&&<i style={{left:`${(trade.start-minTime)/span*100}%`,background:color(trade)}}/>}</div>
        {trade?<button className="execution-trade-label" disabled={!manual} aria-pressed={selected.id===trade.id} onClick={()=>select(trade)} title={`${trade.id} · ${exact(trade.start)}`}><span className="execution-kind">T</span>{trade.id}<Status row={trade} color={color}/><span>{clock(trade.start,days)}</span></button>:<span className="execution-no-fill">Awaiting fill</span>}
      </div>)}
      {!filtered.length&&<p className="execution-note">No orders on this strategy. Use Place demo order to add a simulated order.</p>}
    </div>
  </section>;
}

export function ExecutionWorkbench({component,runId,manual=true}:{component:Workbench;runId:string;manual?:boolean}){
  const {data}=component;
  const instance=`execution-${useId().replace(/[^a-zA-Z0-9_-]/g,'')}`;
  const first=data.rows.find(row=>row.kind==='strategy'),firstOrder=data.rows.find(row=>row.parentId===first?.id);
  const [selectedId,setSelectedId]=useState(data.selectedId??first?.id),[expanded,setExpanded]=useState(()=>new Set([first?.id,firstOrder?.id].filter((id):id is string=>!!id)));
  const [page,setPage]=useState(0),[filter,setFilter]=useState(''),[localStyle,setLocalStyle]=useState<ExecutionStyle|undefined>(),[saved,setSaved]=useState(''),[saving,setSaving]=useState(false);
  const [added,setAdded]=useState<ExecutionRow[]>([]),[patches,setPatches]=useState<Map<string,ExecutionRow>>(()=>new Map()),[demoNote,setDemoNote]=useState('');
  const sourceKey=useMemo(()=>JSON.stringify(data.rows),[data.rows]),[overlaySource,setOverlaySource]=useState(sourceKey);
  useEffect(()=>{if(sourceKey!==overlaySource){setAdded([]);setPatches(new Map());setDemoNote('');setOverlaySource(sourceKey);}setExpanded(previous=>new Set([...previous].filter(id=>data.rows.some(row=>row.id===id))));},[sourceKey]);
  const request=useRef<AbortController|undefined>(undefined);
  useEffect(()=>{setLocalStyle(undefined);setSaved('');},[data.style]);
  useEffect(()=>()=>request.current?.abort(),[]);
  const rows=useMemo(()=>sourceKey===overlaySource?[...data.rows.map(row=>patches.get(row.id)??row),...added.map(row=>patches.get(row.id)??row)]:data.rows,[data.rows,added,patches,sourceKey,overlaySource]);
  const selected=rows.find(row=>row.id===selectedId)??rows.find(row=>row.id===data.selectedId)??rows[0];
  const root=selected?strategyForRow(rows,selected.id):undefined;
  const visible=useMemo(()=>visibleExecutionRows(rows,expanded,page,data.pageSize??12,filter),[rows,expanded,page,data.pageSize,filter]);
  const effectiveExpanded=useMemo(()=>new Set(visible.rows.flatMap((item,index)=>(visible.rows[index+1]?.depth??0)>item.depth?[item.row.id]:[])),[visible]);
  const style=localStyle??data.style??{},theme=style.theme??'graphite',colors={...executionThemes[theme],...style};
  const color=(row:ExecutionRow)=>style.statuses?.[row.status]??(theme==='paper'?lightStatuses:defaultStatuses)[row.status]??colors.accent;
  const css=Object.fromEntries(Object.entries(executionThemes[theme]).map(([key,value])=>[`--execution-${key}`,style[key as keyof Colors]??value])) as CSSProperties;
  Object.assign(css,{'--execution-row':`${style.rowHeight??28}px`,'--execution-font':`${style.fontSize??12}px`});
  const points=data.series.find(series=>series.strategyId===root?.id)?.points??[];
  const last=points.at(-1)?.time??root?.start??0;
  const counts=useMemo(()=>({strategy:rows.filter(r=>r.kind==='strategy').length,order:rows.filter(r=>r.kind==='order').length,trade:rows.filter(r=>r.kind==='trade').length}),[rows]);
  const children=useMemo(()=>new Set(rows.flatMap(row=>row.parentId?[row.parentId]:[])),[rows]);
  function select(row:ExecutionRow){setSelectedId(row.id);setExpanded(previous=>{const next=new Set(previous);next.add(row.strategyId);if(row.parentId)next.add(row.parentId);return next;});}
  function inspect(row:ExecutionRow){select(row);if(children.has(row.id))setExpanded(previous=>{const next=new Set(previous);if(expanded.has(row.id))next.delete(row.id);else next.add(row.id);return next;});}
  function keyboard(event:KeyboardEvent<HTMLTableRowElement>,row:ExecutionRow){
    if(!manual||event.target!==event.currentTarget)return;
    const index=visible.rows.findIndex(item=>item.row.id===row.id);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();const next=visible.rows[event.key==='Home'?0:event.key==='End'?visible.rows.length-1:Math.max(0,Math.min(visible.rows.length-1,index+(event.key==='ArrowDown'?1:-1)))]?.row;if(next){select(next);requestAnimationFrame(()=>document.getElementById(`${instance}-row-${next.id}`)?.focus());}
    }else if(event.key==='ArrowRight'){event.preventDefault();setExpanded(previous=>new Set([...previous,row.id]));}
    else if(event.key==='ArrowLeft'){event.preventDefault();setExpanded(previous=>{const next=new Set(previous);next.delete(row.id);return next;});}
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();inspect(row);}
  }
  function place(){if(!manual||!data.demo||!root||rows.length>=4000||added.length>=32)return;const id=`demo-order-${crypto.randomUUID()}`;const order:ExecutionRow={...root,id,parentId:root.id,kind:'order',status:'working',start:Math.max(root.start,last),end:undefined,filledQuantity:0,filledPrice:undefined,error:undefined};setAdded(previous=>[...previous,order]);select(order);setDemoNote('Demo order placed locally. No broker request was sent.');}
  function fill(){if(!manual||!data.demo||!selected||selected.kind!=='order'||selected.filledQuantity>=selected.quantity||rows.length>=4000||added.length>=32)return;const time=Math.min(8_640_000_000_000_000,Math.max(selected.start,last)+1000),quantity=selected.quantity-selected.filledQuantity,price=selected.side==='buy'?selected.ask:selected.bid;
    const trade:ExecutionRow={...selected,id:`demo-trade-${crypto.randomUUID()}`,parentId:selected.id,kind:'trade',status:'open',quantity,filledQuantity:quantity,filledPrice:price,start:time,end:undefined,error:undefined};
    setPatches(previous=>new Map(previous).set(selected.id,{...selected,status:'filled',filledQuantity:selected.quantity,filledPrice:price,end:time}));setAdded(previous=>[...previous,trade]);select(trade);setDemoNote('Demo fill recorded locally. Source telemetry is unchanged.');}
  async function saveStyle(){if(!manual||!localStyle||saving||!component.configuration?.manualFields?.includes('data.style'))return;setSaving(true);setSaved('');try{const controller=new AbortController();request.current=controller;const response=await fetch(`/api/agents/${encodeURIComponent(runId)}/components/${encodeURIComponent(component.id)}/configure`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected:component,changes:{'data.style':localStyle}}),signal:controller.signal});if(response.status===401)window.dispatchEvent(new Event('agenticview:unauthorized'));const result=await response.json();if(!response.ok)throw new Error(result.error??'Style was not saved');setSaved('Style saved to this card');}catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))setSaved(error instanceof Error?error.message:'Style was not saved');}finally{setSaving(false);}}
  return <div className={`execution-workbench execution-theme-${theme}`} data-theme={theme} style={css}>
    <div className="execution-summary"><strong>FX / EXECUTION</strong><span><b>{counts.strategy}</b> strategies</span><span><b>{counts.order}</b> orders</span><span><b>{counts.trade}</b> trades</span><span className="execution-demo-label">{data.demo?'SYNTHETIC · LOCAL SIMULATION':'OBSERVATION'}</span></div>
    <div className="execution-toolbar"><label className="execution-search"><Search size={14}/><input aria-label="Find strategies, orders or trades" placeholder="Ticker, strategy, order, status or error…" value={filter} disabled={!manual} onChange={event=>{setFilter(event.target.value);setPage(0);}}/></label><button disabled={!manual} onClick={()=>setExpanded(new Set())}>Collapse all</button><span className="execution-toolbar-spacer"/>{data.demo&&<><button className="execution-primary" disabled={!manual||!root||rows.length>=4000||added.length>=32} onClick={place}><Plus size={13}/>Place demo order</button><button disabled={!manual||selected?.kind!=='order'||selected.filledQuantity>=selected.quantity||rows.length>=4000||added.length>=32} onClick={fill}><Check size={13}/>Simulate fill</button></>}
      <details className="execution-style"><summary><Settings2 size={13}/>Style</summary><div className="execution-style-editor"><label>Theme<select aria-label="Execution theme" disabled={!manual} value={theme} onChange={event=>setLocalStyle({theme:event.target.value as ExecutionStyle['theme'],rowHeight:style.rowHeight,fontSize:style.fontSize})}>{Object.keys(executionThemes).map(name=><option key={name}>{name}</option>)}</select></label>{(['accent','background','panel','text','muted','grid','bid','ask','strategy'] as const).map(key=><label key={key}>{key}<input aria-label={`Execution color ${key}`} type="color" disabled={!manual} value={colors[key]} onChange={event=>setLocalStyle({...style,[key]:event.target.value})}/></label>)}<details><summary>Status colors</summary>{executionStatuses.map(status=><label key={status}>{status}<input aria-label={`Status color ${status}`} type="color" disabled={!manual} value={style.statuses?.[status]??(theme==='paper'?lightStatuses:defaultStatuses)[status]} onChange={event=>setLocalStyle({...style,statuses:{...style.statuses,[status]:event.target.value}})}/></label>)}</details><label>Row height<input type="number" min="28" max="40" disabled={!manual} value={style.rowHeight??28} aria-label="Execution row height" onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=28&&value<=40)setLocalStyle({...style,rowHeight:value});}}/></label><label>Text size<input type="number" min="11" max="16" disabled={!manual} value={style.fontSize??12} aria-label="Execution font size" onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=11&&value<=16)setLocalStyle({...style,fontSize:value});}}/></label>{component.configuration?.manualFields?.includes('data.style')&&<button disabled={!manual||!localStyle||saving} onClick={()=>void saveStyle()}>Save style to this card</button>}<button disabled={!manual} onClick={()=>{setLocalStyle(undefined);setSaved('');}}>Reset preview</button>{saved&&<p role="status">{saved}</p>}</div></details>
    </div>
    <div className="execution-grid-shell"><table role="treegrid" aria-label="Strategies, orders and trades" aria-colcount={13} aria-rowcount={visible.totalVisible+1}><thead><tr><th>Strategy / order / trade</th><th>Ticker</th><th>Side</th><th>Type</th><th>Quantity</th><th>Status</th><th>Bid / ask</th><th>Pips</th><th>Start UTC</th><th>End UTC / duration</th><th>Filled qty</th><th>Filled price</th><th>Error</th></tr></thead><tbody>
      {visible.rows.map(({row,depth},index)=><tr id={`${instance}-row-${row.id}`} key={row.id} role="row" aria-level={depth+1} aria-selected={selected?.id===row.id} aria-expanded={children.has(row.id)?effectiveExpanded.has(row.id):undefined} aria-rowindex={index+2} tabIndex={manual&&(selected?.id===row.id||index===0&&!visible.rows.some(item=>item.row.id===selected?.id))?0:-1} data-kind={row.kind} onKeyDown={event=>keyboard(event,row)} onClick={()=>{if(manual)inspect(row);}}>
        <td><div className="execution-entity" style={{paddingLeft:depth*16}}>{children.has(row.id)?<button tabIndex={-1} disabled={!manual} aria-label={`${effectiveExpanded.has(row.id)?'Collapse':'Expand'} ${row.kind} ${row.id}`} aria-expanded={effectiveExpanded.has(row.id)} onClick={event=>{event.stopPropagation();inspect(row);}}>{effectiveExpanded.has(row.id)?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>:<span className="execution-leaf"/>}<span className={`execution-kind execution-kind-${row.kind}`} title={row.kind}>{row.kind[0].toUpperCase()}</span><button className="execution-id" tabIndex={-1} disabled={!manual} aria-label={`Select ${row.kind} ${row.id}`} title={`${row.id} · Strategy ${row.strategyId}`} onClick={event=>{event.stopPropagation();inspect(row);}}>{row.id}</button></div></td>
        <td>{row.ticker}</td><td className={`execution-side-${row.side}`}>{row.side.toUpperCase()}</td><td>{row.orderType==='stop-loss'?'Stop loss':'Limit'}</td><td title={row.quantity.toLocaleString('en-US')+' units'}>{formatQuantity(row.quantity)}</td><td><Status row={row} color={color}/></td><td className="execution-quote-cell"><span>{row.bid.toFixed(digits(row.ticker))}</span><span>{row.ask.toFixed(digits(row.ticker))}</span></td><td>{((row.ask-row.bid)/pip(row.ticker)).toFixed(1)}</td><td title={exact(row.start)}>{clock(row.start,true)}<small>{clock(row.start).slice(6)} </small></td><td title={row.end?exact(row.end):'No observed end'}>{row.end?clock(row.end,true):'Running'}<small>{duration(row,last)}</small></td><td title={row.filledQuantity.toLocaleString('en-US')+' units'}>{formatQuantity(row.filledQuantity)}</td><td>{row.filledPrice?.toFixed(digits(row.ticker))??'—'}</td><td className="execution-error" title={row.error}>{row.error||'—'}</td>
      </tr>)}
      {!visible.rows.length&&<tr><td colSpan={13}>No matching strategies, orders or trades.</td></tr>}
    </tbody></table></div>
    <div className="execution-pagination"><span>{visible.totalStrategies} / {counts.strategy} strategies · {visible.rows.length} rows shown · click a strategy or order to expand</span><span className="execution-toolbar-spacer"/><button disabled={!manual||visible.page===0} onClick={()=>setPage(visible.page-1)}>Previous</button><span>{visible.page+1} / {visible.pages}</span><button disabled={!manual||visible.page+1>=visible.pages} onClick={()=>setPage(visible.page+1)}>Next</button></div>
    {selected&&root&&<><div className="execution-selection"><button disabled={!manual} onClick={()=>select(root)}>{root.ticker} / {root.id}</button>{selected.kind!=='strategy'&&<><ChevronRight size={12}/><span>{selected.kind}: {selected.id}</span></>}<Status row={selected} color={color}/>{selected.error&&<span className="execution-error">{selected.error}</span>}</div><PricePlot root={root} selected={selected} rows={rows} points={points} color={row=>row.kind==='strategy'?colors.strategy:color(row)} select={select} manual={manual}/></>}
    {demoNote&&<p className="execution-note" role="status">{demoNote}</p>}
    {!data.rows.length&&<p className="execution-note">No strategies supplied.</p>}
  </div>;
}
