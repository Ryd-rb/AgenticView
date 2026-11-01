import { useContext,useMemo,useState } from 'react';
import {NativeScrollBox} from './NativeScrollBox.js';
import {useNativeTableHeader} from './NativeTableHeader.js';
import type { Component } from '../shared/protocol.js';
import {NativePresentation} from './ComponentSettings.js';
import {RetainedColumnGap,useRetainedTableWindow} from './RetainedTableWindow.js';

const cell = (value: unknown) => typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—');
export function DataTable({ data }: { data: Extract<Component, { kind: 'table' }>['data'] }) {
  const [page, setPage] = useState(0), count = data.pageSize??25, pages = Math.max(1, Math.ceil(data.rows.length / count)), current = Math.min(page, pages - 1);
  const rows=useMemo(()=>data.rows.slice(current*count,(current+1)*count),[data.rows,current,count]),presentation=useContext(NativePresentation);
  const revision=useMemo(()=>JSON.stringify([rows,data.columns,current,presentation]),[rows,data.columns,current,presentation]);
  const windowed=useRetainedTableWindow({rowCount:rows.length,revision,enabled:rows.length>=16||data.columns.length>=8,horizontal:data.columns.length>=8});
  const header=useNativeTableHeader(windowed.viewportRef,windowed.tableRef);
  const spacer=(height:number)=><tr aria-hidden="true" data-table-window-spacer="true" style={{height,minHeight:0}}><td colSpan={data.columns.length} style={{height,minHeight:0,padding:0,border:0,lineHeight:0,fontSize:0,maxWidth:'none'}}/></tr>;
  return <><NativeScrollBox ref={windowed.viewportRef} className="table-scroll" role="region" aria-label="Table rows"><table ref={windowed.tableRef} style={windowed.tableStyle} data-native-table-header={header.marker} aria-rowcount={(data.totalRows??data.rows.length)+1} aria-colcount={data.columns.length} data-table-window-ready={windowed.ready?'true':undefined} data-table-window-retained={rows.length} data-table-window-layout={rows.filter((_,index)=>windowed.visible(index)).length} data-table-window-columns={data.columns.length} data-table-window-layout-columns={data.columns.filter((_,index)=>windowed.columns.visible(index)).length}>
    {windowed.ready&&<colgroup>{windowed.columnWidths.map((width,index)=><col key={index} style={{width}}/>)}</colgroup>}
    <thead style={header.style}><tr style={{height:windowed.headerHeight}}><RetainedColumnGap columns={windowed.columns} side="left" header height={windowed.headerHeight}/>{data.columns.map((c,index)=><th key={c.key} data-table-window-column={index} aria-colindex={index+1} style={{display:windowed.columns.visible(index)?undefined:'none'}}>{c.label}</th>)}<RetainedColumnGap columns={windowed.columns} side="right" header height={windowed.headerHeight}/></tr></thead>
    <tbody ref={windowed.bodyRef}>{windowed.ready&&windowed.topPixels>0&&spacer(windowed.topPixels)}{rows.map((r,i)=><tr key={i} data-table-window-row={i} aria-rowindex={current*count+i+2} style={{height:windowed.rowHeight(i),display:windowed.visible(i)?undefined:'none'}}>{windowed.visible(i)&&<><RetainedColumnGap columns={windowed.columns} side="left" height={windowed.rowHeight(i)}/>{data.columns.map((c,index)=>windowed.columns.visible(index)&&<td key={c.key} data-table-window-column={index} aria-colindex={index+1} style={{display:windowed.columns.visible(index)?undefined:'none'}}>{cell(r[c.key])}</td>)}<RetainedColumnGap columns={windowed.columns} side="right" height={windowed.rowHeight(i)}/></>}</tr>)}{windowed.ready&&windowed.bottomPixels>0&&spacer(windowed.bottomPixels)}</tbody>
  </table></NativeScrollBox><div className="pagination"><span>{data.totalRows ?? data.rows.length} rows</span><button disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {pages}</span><button disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>Next</button></div></>;
}
