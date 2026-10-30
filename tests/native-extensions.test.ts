import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chartDataSchema, stepperComponentSchema, bulletComponentSchema, accordionComponentSchema, matchesChartCondition, domainFraction, formatNativeNumber } from '../shared/native-extensions.ts';
import { ChartView } from '../web/ChartView.tsx';
import { AdditionalView } from '../web/AdditionalViews.tsx';
import { ComponentView } from '../web/Components.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';
import { componentSchema } from '../shared/protocol.ts';

const chart = (overrides: Record<string, unknown> = {}) => chartDataSchema.parse({ type: 'line', series: [{ id: 'sample', name: 'Latency', points: [{ x: 0, y: 10 }, { x: 1, y: 40 }, { x: 2, y: 80 }] }], ...overrides });
const renderChart = (data: ReturnType<typeof chart>, manual = true) => renderToStaticMarkup(createElement(ChartView, { data, manual }));

test('chart legacy payloads remain compatible and typed options reject executable or invalid fields', () => {
  assert.equal(chartDataSchema.parse({ series: [] }).type, 'line');
  for (const options of [
    { xAxis: { min: 2, max: 1 } }, { yAxis: { ticks: 100 } }, { yAxis: { format: { decimals: 9 } } },
    { annotations: [{ id: 'a', axis: 'y', value: 5, end: 4 }] }, { labelWhen: { operator: 'between', value: 1 } },
    { features: { shell: true } }, { css: 'background:url(secret)' }, { annotations: [{ id: 'a', axis: 'y', value: 2, color: 'url(secret)' }] },
  ]) assert.equal(chartDataSchema.safeParse({ series: [], options }).success, false);
  assert.equal(chartDataSchema.safeParse({ series: [{ name: 'A', color: '#abcdef', points: [] }] }).success, true);
  assert.equal(chartDataSchema.safeParse({ series: [{ id: 'same', name: 'A', points: [] }, { id: 'same', name: 'B', points: [] }] }).success, false);
  assert.equal(chartDataSchema.safeParse({ series: [{ name: 'Category', points: [{ x: 'first', y: 1 }] }], options: { xAxis: { min: 0 } } }).success, false);
  assert.equal(chartDataSchema.safeParse({ series: [{ name: 'Category', points: [{ x: 'first', y: 1 }] }], options: { annotations: [{ id: 'a', axis: 'x', value: 0 }] } }).success, false);
});

test('chart renders axes, annotations, conditional labels and tooltips with producer text escaped', () => {
  const data = chart({ options: { xAxis: { label: 'Elapsed' }, yAxis: { label: 'Duration', min: 0, max: 100, format: { suffix: ' ms' } }, labels: true, labelWhen: { operator: 'gte', value: 80 }, tooltipWhen: { operator: 'between', value: 30, upper: 50 }, annotations: [{ id: 'budget', axis: 'y', value: 50, label: '<script>budget</script>' }] } });
  const html = renderChart(data);
  assert.match(html, /Elapsed/); assert.match(html, /Duration/); assert.match(html, /&lt;script&gt;budget&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/<title>/g) ?? []).length, 1); assert.match(html, /Latency: 1, 40 ms/); assert.match(html, />80 ms<\/text>/);
  assert.doesNotMatch(html, />10 ms<\/text>/);
});

test('chart ceilings suppress viewer features and never unhide agent-hidden series', () => {
  const data = chart({ series: [{ name: 'Visible', points: [{ x: 0, y: 1 }] }, { name: 'Private display', hidden: true, points: [{ x: 0, y: 5 }] }], options: { features: { seriesToggle: true, dataTable: true } } });
  const html = renderChart(data);
  assert.match(html, /aria-pressed="true"/); assert.match(html, /disabled="" aria-pressed="false"/); assert.match(html, /Show chart data/);
  const staticHtml = renderChart(data, false); assert.equal((staticHtml.match(/<button/g)??[]).length,3); assert.equal((staticHtml.match(/disabled=""/g)??[]).length,3); assert.doesNotMatch(staticHtml, /data-series="1:Private display"/);
});

test('integrated native components retain their controls and only gate interaction on activation', () => {
  const component = componentSchema.parse({ id: 'chart', title: 'Chart', kind: 'chart', data: chart({ options: { features: { dataTable: true, seriesToggle: true } } }) });
  const render = (active: boolean) => renderToStaticMarkup(createElement(CardInteraction.Provider, { value: active }, createElement(ComponentView, { component, runId: 'synthetic', embeds: false })));
  const inactive = render(false); assert.match(inactive,/Show chart data/); assert.match(inactive,/aria-pressed/); assert.match(inactive,/Built-in/); assert.equal((inactive.match(/<button/g)??[]).length,(render(true).match(/<button/g)??[]).length); assert.match(inactive,/disabled=""/);
  const active = render(true); assert.match(active, /Show chart data/); assert.match(active, /aria-pressed/);
});

test('typed additional views bound data and reject invalid references, ranges and duplicate sections', () => {
  assert.equal(stepperComponentSchema.safeParse({ id: 's', title: '', kind: 'stepper', data: { selectedId: 'missing', items: [] } }).success, false);
  assert.equal(bulletComponentSchema.safeParse({ id: 'b', title: '', kind: 'bullet', data: { value: 1, ranges: [{ id: 'a', end: 30, label: 'A' }, { id: 'b', end: 20, label: 'B' }] } }).success, false);
  assert.equal(accordionComponentSchema.safeParse({ id: 'a', title: '', kind: 'accordion', data: { multiple: false, sections: [{ id: 'one', title: 'A', text: '', open: true }, { id: 'two', title: 'B', text: '', open: true }] } }).success, false);
  assert.equal(accordionComponentSchema.safeParse({ id: 'a', title: '', kind: 'accordion', data: { sections: Array.from({ length: 101 }, (_, i) => ({ id: 'section-' + i, title: '', text: '' })) } }).success, false);
});

test('additional views expose process states, reported targets and safe text without requests', () => {
  const stepper = stepperComponentSchema.parse({ id: 'steps', title: 'Work', kind: 'stepper', data: { items: [{ id: 'one', label: 'Inspect', state: 'completed' }, { id: 'two', label: 'Implement', state: 'active', detail: '<script>literal</script>' }] } });
  const steps = renderToStaticMarkup(createElement(AdditionalView, { component: stepper }));
  assert.match(steps, /1 of 2 steps completed/); assert.match(steps, /aria-current="step"/); assert.match(steps, /&lt;script&gt;/); assert.doesNotMatch(steps, /<script>/);
  const bullet = bulletComponentSchema.parse({ id: 'bullet', title: 'Capacity', kind: 'bullet', data: { value: 125, target: 80, ranges: [{ id: 'ok', end: 70, label: 'Expected', tone: 'success' }, { id: 'high', end: 100, label: 'High', tone: 'warning' }] } });
  const target = renderToStaticMarkup(createElement(AdditionalView, { component: bullet }));
  assert.match(target, /role="meter"/); assert.match(target, /aria-valuenow="100"/); assert.match(target, /aria-valuetext="125 ; target 80"/); assert.match(target, /outside the displayed range/);
  const accordion = accordionComponentSchema.parse({ id: 'notes', title: 'Notes', kind: 'accordion', data: { features: { expand: false }, sections: [{ id: 'note', title: 'Evidence', text: '<img src=untrusted>' }] } });
  const notes = renderToStaticMarkup(createElement(AdditionalView, { component: accordion }));
  assert.match(notes, /&lt;img src=untrusted&gt;/); assert.doesNotMatch(notes, /<img|<button|<iframe|<script/);
});

test('numeric helpers handle extreme finite domains and literal formats', () => {
  assert.equal(domainFraction(0, -Number.MAX_VALUE, Number.MAX_VALUE), .5);
  assert.equal(domainFraction(Number.MAX_VALUE, 0, 100), 1);
  assert.equal(domainFraction(-Number.MAX_VALUE, 0, 100), 0);
  assert.equal(formatNativeNumber(.125, { style: 'percent', decimals: 1 }), '12.5%');
  assert.equal(matchesChartCondition(3, { operator: 'between', value: 2, upper: 4 }), true);
  assert.equal(matchesChartCondition(5, { operator: 'lt', value: 4 }), false);
  const extreme = renderChart(chart({ series: [{ name: 'Bounds', points: [{ x: -Number.MAX_VALUE, y: -Number.MAX_VALUE }, { x: Number.MAX_VALUE, y: Number.MAX_VALUE }] }] }));
  assert.doesNotMatch(extreme, /NaN|Infinity/);
});

test('viewer interactions preserve source, bound inspection rows and recover selected state after updates', async () => {
  const { Window } = await import('happy-dom'), dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { act } = await import('react'), { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    const data = chart({ series: [{ id: 'data', name: 'Samples', points: Array.from({ length: 80 }, (_, i) => ({ x: i, y: i })) }], options: { features: { seriesToggle: true, dataTable: true } } }), original = JSON.stringify(data);
    await act(() => root.render(createElement(ChartView, { data })));
    const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
    await act(() => button('Show chart data').click()); assert.equal(host.querySelectorAll('tbody tr').length, 25);
    await act(() => button('Next').click()); assert.match(host.querySelector('.pagination')!.textContent!, /2 \/ 4/);
    await act(() => root.render(createElement(ChartView, { data: chart({ options: data.options }) }))); assert.equal(host.querySelectorAll('tbody tr').length, 3); assert.match(host.querySelector('.pagination')!.textContent!, /1 \/ 1/);
    await act(() => host.querySelector<HTMLButtonElement>('.chart-legend button')!.click()); assert.equal(host.querySelectorAll('[data-series]').length, 0);
    await act(() => root.render(createElement(ChartView, { data: chart({ options: data.options }), manual: false }))); assert.equal(host.querySelectorAll('[data-series]').length, 0); assert.ok([...host.querySelectorAll('button')].every(button=>button.disabled));
    assert.equal(JSON.stringify(data), original);
    const stepper = (items = ['one', 'two']) => stepperComponentSchema.parse({ id: 's', title: '', kind: 'stepper', data: { features: { select: true }, items: items.map(id => ({ id, label: id, state: 'pending', detail: id + ' detail' })) } });
    await act(() => root.render(createElement(AdditionalView, { component: stepper() })));
    await act(() => host.querySelectorAll<HTMLButtonElement>('li button')[1].click()); assert.match(host.querySelector('[role=region]')!.textContent!, /two detail/);
    await act(()=>root.render(createElement(AdditionalView,{component:stepper(),manual:false})));assert.match(host.querySelector('[role=region]')!.textContent!,/two detail/);assert.ok([...host.querySelectorAll('li button')].every(button=>(button as HTMLButtonElement).disabled));
    await act(() => root.render(createElement(AdditionalView, { component: stepper(['one']) }))); assert.match(host.querySelector('[role=region]')!.textContent!, /one detail/);
    const accordion = accordionComponentSchema.parse({ id: 'a', title: '', kind: 'accordion', data: { multiple: false, sections: [{ id: 'one', title: 'First', text: 'first content', open: true }, { id: 'two', title: 'Second', text: 'second content' }] } });
    await act(() => root.render(createElement(AdditionalView, { component: accordion })));
    await act(() => host.querySelectorAll<HTMLButtonElement>('h4 button')[1].click()); assert.equal(host.querySelectorAll('[aria-expanded=true]').length, 1); assert.equal(host.querySelectorAll('[role=region]').length, 1); assert.match(host.textContent!, /second content/); assert.doesNotMatch(host.textContent!, /first content/);
    await act(()=>root.render(createElement(AdditionalView,{component:accordion,manual:false})));assert.match(host.textContent!,/second content/);assert.doesNotMatch(host.textContent!,/first content/);assert.equal(host.querySelectorAll('h4 button').length,2);
  } finally { await act(() => root.unmount()); await dom.happyDOM.close(); }
});
