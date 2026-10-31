import { useMemo } from 'react';
import type { Component } from '../shared/protocol.js';
import { legacyExecutionToLinked, linkedStyleToLegacy } from '../shared/legacy-execution-adapter.js';
import { LinkedWorkbench } from './LinkedWorkbench.js';

/** Format compatibility; all interaction and rendering use the generic component. */
export function ExecutionWorkbench({component,runId,manual=true}:{component:Extract<Component,{kind:'execution-workbench'}>;runId:string;manual?:boolean}){
  const converted=useMemo(()=>({...component,kind:'linked-workbench' as const,data:legacyExecutionToLinked(component.data)}),[component]);
  return <LinkedWorkbench component={converted} originalComponent={component} mapStyle={linkedStyleToLegacy} editableKindIds={['strategy']} runId={runId} manual={manual}/>;
}
