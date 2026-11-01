import React,{useState} from 'react';
import type {Component} from '../shared/protocol.js';
import {useNativeRowMetrics} from './ComponentSettings.js';
import {NativeScrollBox} from './NativeScrollBox.js';
import {fixedRowWindow,type LogicalViewport} from './logicalScroll.js';
/** Same source entries and row metrics; only the native paint extent changes. */
export function LogicalLogs({entries}:{entries:Extract<Component,{kind:'logs'}>['data']['entries']}){
 const metrics=useNativeRowMetrics(30,9,2),row=metrics.height,height=210;
 const [viewport,setViewport]=useState<LogicalViewport>({y:0,height:entries.length*row,clientHeight:height});
 const range=fixedRowWindow(entries.length,row,viewport.y,viewport.clientHeight,3,Math.max(0,viewport.height-entries.length*row));
 if(!range)return null; // Row metrics/source count are trusted bounded native inputs.
 return <NativeScrollBox className="logs" style={{height}} virtualHeight={entries.length*row} onViewportChange={setViewport} tabIndex={0} aria-label={`${entries.length} log entries`}><div data-logical-paint-body="true" style={{height:range.paintHeight,position:'relative',overflow:'clip'}}><div style={{position:'absolute',top:range.top,left:0,right:0}}>{entries.slice(range.start,range.end).map((entry,index)=><div className={`log-row ${entry.level}`} style={{...metrics.style,height:row}} key={range.start+index} data-logical-row={range.start+index} title={entry.message}><time style={{lineHeight:metrics.style.lineHeight}}>{entry.time||'·'}</time><b style={{lineHeight:metrics.style.lineHeight}}>{entry.level}</b><span style={{lineHeight:metrics.style.lineHeight}}>{entry.message}</span></div>)}</div></div></NativeScrollBox>;
}
