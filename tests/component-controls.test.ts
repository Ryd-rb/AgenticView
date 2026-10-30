import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { control, controlIds, controlMapSchema, controlPresentationSchema, type ControlMap } from '../shared/control-presentation.ts';
import { componentSchema, type Component } from '../shared/protocol.ts';
import { ComponentView } from '../web/Components.tsx';
import { ComponentSettings } from '../web/ComponentSettings.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';
import { z } from 'zod';

const component = (controls: ControlMap = {}, manualFields: string[] = ['data.unit']) => componentSchema.parse({ id: 'metric', title: 'Duration', kind: 'metric', data: { value: 42, unit: 'ms' }, configuration: { controls, manualFields } });
const render = (c: Component) => renderToStaticMarkup(createElement(ComponentView, { component: c, runId: 'synthetic', embeds: false, updatedAt: 1000 }));

test('presentation catalog is bounded and strict, with no executable CSS or arbitrary identifiers', () => {
  assert.equal(new Set(controlIds).size, controlIds.length);
  assert.equal(controlMapSchema.safeParse(Object.fromEntries(controlIds.map(id => [id, {}]))).success, true);
  for (const invalid of [{ unknown: {} }, { configure: { script: 'x' } }, { configure: { placement: 'anywhere' } }, { configure: { mode: 'iframe' } }, { configure: { visible: 'false' } }, { configure: null }, JSON.parse('{"__proto__":{}}')]) assert.equal(controlMapSchema.safeParse(invalid).success, false);
  assert.equal(controlPresentationSchema.safeParse({ label: 'x'.repeat(161) }).success, false);
  assert.equal(controlPresentationSchema.safeParse({ tooltip: 'x'.repeat(2001) }).success, false);
  const schema=z.toJSONSchema(controlMapSchema,{io:'input'});
  assert.equal(schema.additionalProperties,false); assert.equal(Object.keys(schema.properties??{}).length,controlIds.length);
  const source: ControlMap = { configure: { visible: false, label: 'Inspect' } }, defaults = { visible: true, tooltip: 'Default' };
  assert.deepEqual(control(source, 'configure', defaults), { visible: false, label: 'Inspect', tooltip: 'Default' });
  assert.deepEqual(defaults, { visible: true, tooltip: 'Default' }); assert.deepEqual(source.configure, { visible: false, label: 'Inspect' });
});

test('configure presentation cannot create editing permission and can hide an enabled control', () => {
  const absent = render(component({ configure: { visible: true, mode: 'panel' } }, []));
  assert.doesNotMatch(absent, /data-control="configure"|control-presentation-slot/);
  const hidden = render(component({ configure: { visible: false } }));
  assert.doesNotMatch(hidden, /data-control="configure"/); assert.match(hidden, /42/);
  const shown = render(component()); assert.match(shown, /Configure component/); assert.match(shown, /disabled=""/);
});

test('settings presentation supports accessible icons, literal labels, primary controls and initial disclosure state', () => {
  const html = render(component({ configure: { label: '<script>Configure</script>', tooltip: 'Inspect the literal settings', appearance: 'icon', variant: 'primary', initiallyOpen: true } }));
  assert.match(html, /aria-label="&lt;script&gt;Configure&lt;\/script&gt;"/); assert.match(html, /title="Inspect the literal settings"/); assert.match(html, /data-control-variant="primary"/); assert.match(html, /data-control="configure"[^>]*open=""/); assert.doesNotMatch(html, /<script>/);
  const panel = render(component({ configure: { mode: 'panel', appearance: 'both', label: 'Edit display' }, save: { label: 'Apply display', tooltip: 'Save this component', appearance: 'icon' } }));
  assert.match(panel, /component-settings-panel/); assert.match(panel, /aria-label="Edit display"/); assert.match(panel, /aria-label="Apply display"/); assert.match(panel, /title="Save this component"/);
});

test('header and footer placement move settings without losing persistent native/custom origin labels', () => {
  const above = render(component({ configure: { placement: 'top-right', mode: 'panel' } }));
  assert.ok(above.indexOf('data-control="configure"') < above.indexOf('component-configured')); assert.match(above, /data-control-placement="top-right"/);
  const below = render(component({ configure: { placement: 'bottom-left' } }));
  assert.ok(below.indexOf('data-control="configure"') > below.indexOf('component-configured'));
  const hiddenHeader = render(component({ header: { visible: false }, footer: { visible: false } }));
  assert.doesNotMatch(hiddenHeader, /data-control="header"|data-control="configure"/); assert.match(hiddenHeader, /component-origin native/); assert.match(hiddenHeader, /Built-in/);
  const custom = componentSchema.parse({ id: 'custom', title: 'Custom', kind: 'embed', data: { html: '<p>Literal</p>', height: 300 }, configuration: { controls: { header: { visible: false } } } });
  const customHtml = render(custom); assert.match(customHtml, /component-origin custom/); assert.match(customHtml, /Custom view/);
  const hiddenFields = render(component({ title: { visible: false }, times: { visible: false } })); assert.doesNotMatch(hiddenFields, /data-control="title"|data-control="times"/); assert.match(hiddenFields, /Built-in/);
});

test('selection preserves disclosure and draft while native save still enforces permission and exact fields', async () => {
  const { Window } = await import('happy-dom'), dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch, requests: { body: unknown; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = async (_input, init) => new Promise<Response>(resolve => requests.push({ body: JSON.parse(String(init?.body)), resolve }));
  const { act } = await import('react'), { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), c = component({ configure: { initiallyOpen: true, appearance: 'both', label: 'Edit values' } });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const draw = async (active: boolean) => act(async () => { root.render(createElement(CardInteraction.Provider, { value: active }, createElement(ComponentSettings, { component: c, runId: 'synthetic' }))); await settle(); });
  try {
    await draw(false); const details = host.querySelector<HTMLDetailsElement>('details.component-settings')!, input = host.querySelector<HTMLInputElement>('[aria-label="Configure data.unit"]')!;
    assert.equal(details.open, true); assert.equal(input.disabled, true);
    await draw(true); assert.equal(host.querySelector('details.component-settings'), details); assert.equal(details.open, true);
    await act(async () => { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, 'seconds'); input.dispatchEvent(new Event('input', { bubbles: true })); await settle(); });
    await draw(false); assert.equal(details.open, true); assert.equal(input.value, 'seconds'); assert.equal(host.querySelector('button')!.disabled, true);
    await draw(true); await act(async () => { host.querySelector('button')!.click(); await settle(); });
    assert.equal(requests.length, 1); assert.deepEqual((requests[0].body as { changes: unknown }).changes, { 'data.unit': 'seconds' });
    await act(async () => { requests[0].resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })); await settle(); });
    assert.match(host.textContent!, /Settings saved/);
  } finally { await act(() => root.unmount()); globalThis.fetch = originalFetch; await dom.happyDOM.close(); }
});
