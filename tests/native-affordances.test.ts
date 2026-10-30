import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { componentSchema } from '../shared/protocol.ts';
import type { ControlMap } from '../shared/control-presentation.ts';
import { ComponentView } from '../web/Components.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';

const grid = (controls: ControlMap = {}, features: Record<string, boolean> = {}) => componentSchema.parse({ id: 'grid', title: 'Rows', kind: 'data-grid', data: { columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name', editable: true }], rows: [{ id: 'one', name: 'Example' }], keyColumn: 'id', editAction: 'edit', addAction: 'add', deleteAction: 'remove', historyAction: 'history', evaluateAction: 'evaluate', bulkAction: 'bulk', features }, configuration: { controls } });
const render = (component: ReturnType<typeof componentSchema.parse>, active = false) => renderToStaticMarkup(createElement(CardInteraction.Provider, { value: active }, createElement(ComponentView, { component, runId: 'synthetic', embeds: false })));

test('grid affordances hide groups and preserve configured feature ceilings', () => {
  const hidden = Object.fromEntries(['filter', 'refresh', 'add', 'edit', 'delete', 'history', 'evaluate', 'bulk', 'columns', 'pagination'].map(id => [id, { visible: false }])) as ControlMap;
  const html = render(grid(hidden));
  assert.doesNotMatch(html, /data-control="(?:filter|refresh|add|edit|delete|history|evaluate|bulk|columns|pagination)"/);
  assert.doesNotMatch(html, /aria-label="Filter rows"|aria-label="Select page"/); assert.match(html, /Example/);
  const shown = Object.fromEntries(Object.keys(hidden).map(id => [id, { visible: true }])) as ControlMap;
  const disabled = render(grid(shown, { filter: false, hideColumns: false, add: false, edit: false, delete: false, history: false, evaluate: false, bulk: false }));
  assert.doesNotMatch(disabled, /data-control="(?:filter|add|edit|delete|history|evaluate|bulk|columns)"/);
});

test('native grid buttons keep accessible literal labels and variant/placement metadata', () => {
  const html = render(grid({ edit: { label: '<script>Modify</script>', tooltip: 'Change this row', appearance: 'icon', variant: 'primary', placement: 'bottom-right' }, columns: { label: 'Fields', initiallyOpen: true }, pagination: { label: 'Rows' } }));
  assert.match(html, /aria-label="&lt;script&gt;Modify&lt;\/script&gt;"/); assert.match(html, /title="Change this row"/); assert.match(html, /data-control-variant="primary"/); assert.match(html, /data-control-placement="bottom-right"/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /aria-label="Fields"/); assert.match(html, /Rows: Previous page/); assert.match(html, /Rows: Next page/);
});

const chart = (controls: ControlMap, features = { dataTable: true, seriesToggle: true }) => componentSchema.parse({ id: 'chart', title: 'Data', kind: 'chart', data: { series: [{ name: 'Sample', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }], options: { features } }, configuration: { controls } });
test('chart legend and inspector presentation remain below feature and manual ceilings', () => {
  assert.doesNotMatch(render(chart({ legend: { visible: false }, dataTable: { visible: false } })), /data-control="legend"|data-control="dataTable"/);
  const disabled = render(chart({ dataTable: { visible: true, mode: 'panel' }, legend: { visible: true } }, { dataTable: false, seriesToggle: false }));
  assert.doesNotMatch(disabled, /data-control="dataTable"|aria-pressed=/);
  const panel = render(chart({ dataTable: { mode: 'panel', placement: 'header' }, legend: { appearance: 'icon' }, pagination: { visible: false } }));
  assert.match(panel, /class="chart-data"/); assert.doesNotMatch(panel, /data-control="pagination"|class="chart-data-toggle"/); assert.ok(panel.indexOf('class="chart-data"') < panel.indexOf('<svg class="chart'));
  const inactive = render(chart({ dataTable: { appearance: 'icon', label: 'Inspect' } })); assert.match(inactive, /disabled=""[^>]*aria-label="Inspect"/);
});

test('step and expansion presentation can remove interaction without hiding evidence or granting features', () => {
  const step = (feature: boolean, controls: ControlMap) => componentSchema.parse({ id: 'steps', title: 'Steps', kind: 'stepper', data: { features: { select: feature }, items: [{ id: 'one', label: 'Inspect', state: 'active', detail: 'Retained evidence' }] }, configuration: { controls } });
  const hidden = render(step(true, { stepSelect: { visible: false } })); assert.doesNotMatch(hidden, /data-control="stepSelect"/); assert.match(hidden, /Retained evidence/);
  assert.doesNotMatch(render(step(false, { stepSelect: { visible: true } })), /data-control="stepSelect"/);
  const accordion = componentSchema.parse({ id: 'notes', title: 'Notes', kind: 'accordion', data: { sections: [{ id: 'one', title: 'Evidence', text: 'Retained text' }] }, configuration: { controls: { expand: { visible: false } } } });
  const notes = render(accordion); assert.doesNotMatch(notes, /data-control="expand"/); assert.match(notes, /Retained text/);
});

test('native row save/cancel labels preserve full-row action envelopes and selection only disables controls', async () => {
  const { Window } = await import('happy-dom'), dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'HTMLInputElement', 'HTMLSelectElement'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch, calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):{}; calls.push({url,body});
    const value=url.endsWith('/invoke')?{id:'invocation',actionId:'edit',state:'succeeded',createdAt:1,result:{row:{id:'one',name:'Updated'}}}:{version:'synthetic-v1',actions:[{id:'edit',label:'Edit',kind:'edit'}]};
    return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const { act } = await import('react'), { createRoot } = await import('react-dom/client');
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),c=grid({save:{label:'Store row',appearance:'both'},cancel:{label:'Discard edit'},edit:{label:'Modify row'}}),settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  const draw=async(active:boolean)=>act(async()=>{root.render(createElement(CardInteraction.Provider,{value:active},createElement(ComponentView,{component:c,runId:'synthetic',embeds:false})));await settle();});
  try{
    await draw(true);await act(async()=>{host.querySelector<HTMLButtonElement>('[data-control="edit"]')!.click();await settle();});
    const field=host.querySelector<HTMLInputElement>('[aria-label="Name for one"]')!;assert.ok(field);assert.equal(host.querySelector('[data-control="cancel"]')!.textContent,'Discard edit');
    await act(async()=>{Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype,'value')!.set!.call(field,'Updated');field.dispatchEvent(new Event('input',{bubbles:true}));await settle();});
    await draw(false);assert.equal(host.querySelector<HTMLInputElement>('[aria-label="Name for one"]')!.value,'Updated');assert.equal(host.querySelector<HTMLButtonElement>('[data-control="save"]')!.disabled,true);
    await draw(true);await act(async()=>{host.querySelector<HTMLButtonElement>('[data-control="save"]')!.click();await settle();});
    const invocation=calls.find(call=>call.url.endsWith('/invoke'))!;assert.ok(invocation);assert.deepEqual((invocation.body.input as {row:unknown}).row,{id:'one',name:'Updated'});assert.equal((invocation.body.input as {componentId:unknown}).componentId,'grid');
  }finally{await act(()=>root.unmount());globalThis.fetch=originalFetch;await dom.happyDOM.close();}
});
