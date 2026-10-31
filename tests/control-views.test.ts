import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { ControlView, type ControlComponent } from '../web/ControlViews.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';
import { ComponentControls } from '../web/ControlPresentation.tsx';
import type { ControlMap } from '../shared/control-presentation.ts';

type Request = { url: string; signal: AbortSignal; body?: Record<string, any>; resolve: (response: Response) => void };
const config = { version: 'synthetic-v1', application: { name: 'Synthetic app' }, actions: [
  { id: 'write', label: 'Update settings', kind: 'command', confirmation: 'Review these settings before applying.', fields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'mode', label: 'Mode', type: 'select', options: ['safe', 'fast'] }, { key: 'notes', label: 'Notes', type: 'multiline' }, { key: 'limit', label: 'Limit', type: 'number', min: 1, max: 20 }, { key: 'data', label: 'Data', type: 'json' }] },
  { id: 'logs', label: 'Read log', kind: 'logs' }, { id: 'rows', label: 'Read rows', kind: 'query' },
  { id: 'edit', label: 'Edit record', kind: 'edit', confirmation: 'Apply record changes?' }, { id: 'history', label: 'Record history', kind: 'history' },
  { id: 'add', label: 'Add record', kind: 'edit', confirmation: 'Add this record?' }, { id: 'delete', label: 'Delete record', kind: 'edit', confirmation: 'Delete this record?' }, { id: 'bulk', label: 'Bulk records', kind: 'edit', confirmation: 'Apply this callback to the selected records?' },
] };
const complete = (actionId: string, result: object = {}, extra: object = {}) => ({ id: `invocation-${actionId}`, actionId, state: 'succeeded', createdAt: '2026-01-01T12:00:00Z', result, ...extra });
async function fixture(component: ControlComponent, active = true, configuration: unknown = config, presentation: ControlMap = {}) {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let hidden = false, timerId = 800000;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  const original = { fetch: globalThis.fetch, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const requests: Request[] = [], timers = new Map<number, () => void>();
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if ([500, 750, 1500].includes(delay ?? 0)) { timers.set(++timerId, callback); return timerId; }
    return original.set(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { if (!timers.delete(id)) original.clear(id); }) as typeof clearTimeout;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
    const signal = init!.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      requests.push({ url: String(url), signal, body: init?.body ? JSON.parse(String(init.body)) : undefined, resolve });
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  let currentComponent = component;
  const render = async (selected: boolean, nextComponent = currentComponent) => act(async () => { currentComponent = nextComponent; root.render(createElement(CardInteraction.Provider, { value: selected }, createElement(ComponentControls.Provider, {value:presentation}, createElement(ControlView, { component: currentComponent, runId: 'synthetic/run' })))); await settle(); });
  const respond = async (index: number, body: unknown, status = 200) => act(async () => { requests[index]!.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })); await settle(); });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  const click = async (label: string) => act(async () => { const target = button(label); assert.ok(target, `button ${label} exists`); target.click(); await settle(); });
  const toggle = async (label: string) => act(async () => { const target = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; assert.ok(target); target.click(); await settle(); });
  const tick = async () => act(async () => { const entry = [...timers.entries()][0]; assert.ok(entry, 'poll timer exists'); timers.delete(entry[0]); entry[1](); await settle(); });
  const input = async (label: string, value: string) => act(async () => {
    const target = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; assert.ok(target);
    // Use the native setter so React observes a user edit instead of its tracked assignment.
    const prototype = target.tagName === 'TEXTAREA' ? dom.HTMLTextAreaElement.prototype : target.tagName === 'SELECT' ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await settle();
  });
  await render(active);
  assert.equal(requests[0]!.url, '/api/controls/synthetic%2Frun');
  await respond(0, configuration);
  return { host, requests, timers, respond, render, button, click, toggle, tick, input,
    visibility: async (value: boolean) => act(async () => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); await settle(); }),
    close: async () => { await act(async () => { root.unmount(); await settle(); }); globalThis.fetch = original.fetch; globalThis.setTimeout = original.set; globalThis.clearTimeout = original.clear; await dom.happyDOM.close(); },
  };
}

test('action panel gates execution by selection, reviews/cancels inline, binds version, polls one ID and renders safe bounded results', async () => {
  const view = await fixture({ kind: 'action-panel', data: { actionIds: ['write'] } }, false);
  try {
    assert.equal(view.button('Review Update settings').disabled, true); assert.equal(view.requests.length, 1);
    assert.ok(view.host.querySelector('textarea[aria-label="Notes"]')); assert.ok(view.host.querySelector('select[aria-label="Mode"]')); assert.ok(view.host.querySelector('input[type="number"]'));
    await view.render(true); assert.match(view.requests[1]!.url, /history\?limit=20$/); await view.respond(1, []);
    await view.input('Mode', 'safe'); await view.input('Notes', 'Review notes'); await view.input('Limit', '5'); await view.input('Data', '{"key":1}');
    await view.click('Review Update settings'); assert.match(view.host.textContent!, /Review these settings/); assert.equal(view.requests.length, 2);
    await view.click('Cancel'); assert.equal(view.requests.length, 2);
    await view.click('Review Update settings'); await view.click('Confirm Update settings');
    const request = view.requests[2]!; assert.equal(request.body!.definitionVersion, 'synthetic-v1'); assert.equal(request.body!.confirmed, true); assert.equal(request.body!.actionId, 'write'); assert.match(request.body!.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(request.body!.input, { enabled: false, mode: 'safe', notes: 'Review notes', limit: 5, data: { key: 1 } });
    await view.respond(2, complete('write', {}, { state: 'queued' }));
    assert.equal(view.timers.size, 1); assert.equal(view.button('Review Update settings').disabled, true);
    const historyIndex = view.requests.length - 1; await view.respond(historyIndex, []);
    await view.tick(); const index = view.requests.length - 1; assert.match(view.requests[index]!.url, /invocations\/invocation-write$/);
    await view.respond(index, complete('write', { output: '<script>unsafe()</script>' + 'x'.repeat(20_000) }));
    assert.equal(view.host.querySelector('script'), null); assert.match(view.host.textContent!, /output truncated/); assert.match(view.host.textContent!, /succeeded/);
    assert.equal(view.requests.filter(item => item.body?.actionId === 'write').length, 1, 'pending actions never resubmit');
    await view.click('Review Update settings'); await view.visibility(true); assert.equal(view.host.querySelector('[aria-label="Review action"]'), null);
  } finally { await view.close(); }
});

test('automatic readers refuse command actions without sending an invocation', async () => {
  for (const component of [
    { kind: 'log-stream', data: { actionId: 'write' } },
    { kind: 'data-grid', data: { readAction: 'write', keyColumn: 'id', columns: [{ key: 'id', label: 'ID' }] } },
  ] satisfies ControlComponent[]) {
    const view = await fixture(component);
    try { assert.equal(view.requests.length, 1); assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /requires an action of kind/); }
    finally { await view.close(); }
  }
});

test('filter handoff aborts the previous log request and suppresses its late cursor and entries', async () => {
  const view = await fixture({ kind: 'log-stream', data: { actionId: 'logs', pollMs: 1500 } });
  try {
    const old = view.requests[1]!; await view.input('Filter logs', 'new filter');
    assert.equal(old.signal.aborted, true); assert.equal(view.requests[2]!.body!.input.filter, 'new filter');
    await view.respond(1, complete('logs', { entries: [{ message: 'Obsolete result' }], cursor: 'obsolete' }));
    await view.respond(2, complete('logs', { entries: [{ message: 'Current result' }], cursor: 'current' }));
    assert.equal(view.host.textContent!.includes('Obsolete result'), false); assert.match(view.host.textContent!, /Current result/);
    await view.tick(); assert.equal(view.requests[3]!.body!.input.cursor, 'current');
    await view.render(false); assert.equal(view.requests[3]!.signal.aborted, false, 'deselection preserves readonly monitoring');
    await view.visibility(true); assert.equal(view.requests[3]!.signal.aborted, true); assert.equal(view.timers.size, 0);
  } finally { await view.close(); }
});

test('visible unselected log cards keep monitoring with interaction controls disabled', async () => {
  const view = await fixture({ kind: 'log-stream', data: { actionId: 'logs', pollMs: 1500 } }, false);
  try {
    assert.equal(view.requests[1]!.body!.actionId, 'logs'); assert.equal(view.button('Pause').disabled, true); assert.equal(view.button('Refresh actions').disabled, true);
    assert.equal(view.host.querySelector<HTMLInputElement>('[aria-label="Filter logs"]')!.disabled, true);
    await view.click('Pause'); assert.equal(view.requests[1]!.signal.aborted, false);
    await view.respond(1, complete('logs', { entries: [{ message: 'Read while unselected' }], cursor: 'visible-tail' }));
    assert.match(view.host.textContent!, /Read while unselected/); assert.match(view.host.textContent!, /Following/);
    await view.tick(); assert.equal(view.requests[2]!.body!.input.cursor, 'visible-tail');
    await view.render(true); assert.equal(view.requests[2]!.signal.aborted, false, 'selection does not restart an active read');
    await view.render(false); assert.equal(view.requests[2]!.signal.aborted, false);
    await view.visibility(true); assert.equal(view.requests[2]!.signal.aborted, true); assert.equal(view.timers.size, 0);
  } finally { await view.close(); }
});

test('readonly monitoring never bypasses a configured confirmation on an unselected card', async () => {
  const view = await fixture({ kind: 'log-stream', data: { actionId: 'logs', pollMs: 1500 } }, false, { ...config, actions: config.actions.map(action => action.id === 'logs' ? { ...action, confirmation: 'Review access to this log.' } : action) });
  try {
    assert.equal(view.requests.length, 1, 'unselected read does not bypass confirmation'); assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /Select this card/);
    await view.render(true); await view.tick(); assert.ok(view.host.querySelector('[aria-label="Review action"]')); assert.equal(view.requests.length, 1);
    await view.render(false); assert.equal(view.host.querySelector('[aria-label="Review action"]'), null); assert.equal(view.requests.length, 1, 'deselected read review cannot execute');
  } finally { await view.close(); }
});

test('visible unselected grids read rows but deselection cancels reviews and edit requests', async () => {
  const view = await fixture({ kind: 'data-grid', data: { readAction: 'rows', editAction: 'edit', historyAction: 'history', keyColumn: 'id', versionColumn: 'version', columns: [{ key: 'name', label: 'Name', editable: true }] } }, false);
  try {
    assert.equal(view.requests[1]!.body!.actionId, 'rows');
    await view.respond(1, complete('rows', { rows: [{ id: 'row-1', version: 1, name: 'Observed' }] }));
    assert.match(view.host.querySelector('tbody')!.textContent!, /Observed/); assert.equal(view.button('Edit').disabled, true); assert.equal(view.button('History').disabled, true); assert.equal(view.button('Apply filter').disabled, true);
    await view.click('Edit'); await view.click('History'); assert.equal(view.requests.length, 2, 'inactive controls never execute edits or history actions');
    await view.render(true); await view.click('Edit'); await view.input('Name for row-1', 'Draft'); await view.click('Save');
    assert.ok(view.host.querySelector('[aria-label="Review action"]'));
    await view.render(false); assert.equal(view.host.querySelector('[aria-label="Review action"]'), null); assert.equal(view.requests.length, 2, 'deselected review never submits');
    assert.equal(view.button('Save').disabled, true); assert.equal(view.button('Cancel edit').disabled, true);
    await view.render(true); await view.click('Save'); await view.click('Confirm Edit record'); assert.equal(view.requests[2]!.body!.actionId, 'edit');
    await view.render(false); assert.equal(view.requests[2]!.signal.aborted, true, 'deselection stops the pending edit request');
    assert.equal(view.requests.length, 3, 'no edit or query replay follows cancellation');
  } finally { await view.close(); }
});

test('stale definitions require explicit refresh and a fresh review without replaying the failed invocation', async () => {
  const view = await fixture({ kind: 'action-panel', data: { actionIds: ['write'] } });
  try {
    await view.respond(1, []); await view.click('Review Update settings'); await view.click('Confirm Update settings');
    await view.respond(2, { error: 'Action configuration changed. Reload and review it again.' }, 409);
    assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /409/);
    await view.click('Refresh actions'); assert.equal(view.requests[3]!.url, '/api/controls/synthetic%2Frun');
    await view.respond(3, { ...config, version: 'synthetic-v2', actions: config.actions.map(action => action.id === 'write' ? { ...action, confirmation: 'Review the updated definition.' } : action) });
    assert.equal(view.requests.filter(request => request.body?.actionId === 'write').length, 1, 'definition refresh never reexecutes a side effect');
    assert.equal(view.host.querySelector('[aria-label="Review action"]'), null);
    await view.respond(4, []); await view.click('Review Update settings'); assert.match(view.host.textContent!, /Review the updated definition/); assert.equal(view.requests.length, 5);
    await view.click('Confirm Update settings'); assert.equal(view.requests[5]!.body!.definitionVersion, 'synthetic-v2');
    assert.notEqual(view.requests[2]!.body!.requestId, view.requests[5]!.body!.requestId, 'fresh explicit confirmation creates a fresh request');
  } finally { await view.close(); }
});

test('log stream bounds retained entries and virtual rows, serializes polls, and stops pause/hidden/unmounted requests', async () => {
  const view = await fixture({ kind: 'log-stream', data: { actionId: 'logs', maxRows: 40, pollMs: 1500 } });
  try {
    assert.equal(view.requests[1]!.body!.actionId, 'logs'); assert.equal(view.requests.length, 2); assert.equal(view.timers.size, 0);
    await view.respond(1, complete('logs', { cursor: 'cursor-1', entries: Array.from({ length: 100 }, (_, i) => ({ level: i % 2 ? 'error' : 'info', message: `entry-${i}` })), bytesRead: 300, truncated: true }));
    assert.match(view.host.textContent!, /40 rows/); assert.ok(view.host.querySelectorAll('.control-log-row').length <= 16); assert.match(view.host.textContent!, /Source truncated/); assert.equal(view.timers.size, 1);
    await view.tick(); assert.equal(view.requests[2]!.body!.input.cursor, 'cursor-1'); assert.equal(view.timers.size, 0);
    await view.click('Pause'); assert.equal(view.requests[2]!.signal.aborted, true); assert.equal(view.timers.size, 0);
    await view.click('Resume'); assert.equal(view.requests.length, 4);
    await view.visibility(true); assert.equal(view.requests[3]!.signal.aborted, true); assert.equal(view.timers.size, 0);
    await view.visibility(false); assert.equal(view.requests.length, 5);
    await view.respond(4, complete('logs', { entries: [{ message: '<img src=x onerror=unsafe()>' }], cursor: 'cursor-2' }));
    assert.equal(view.host.querySelector('img'), null);
    await view.tick(); assert.equal(view.requests.length, 6);
  } finally { const request = view.requests.at(-1)!; await view.close(); assert.equal(request.signal.aborted, true); assert.equal(view.timers.size, 0); }
});

test('grid pages bounded data, explicitly confirms versioned edits and preserves values on conflict', async () => {
  const view = await fixture({ kind: 'data-grid', data: { readAction: 'rows', editAction: 'edit', historyAction: 'history', keyColumn: 'id', versionColumn: 'version', pageSize: 2, columns: [{ key: 'name', label: 'Name', editable: true }, { key: 'count', label: 'Count', type: 'number', editable: true }] } });
  try {
    assert.deepEqual(view.requests[1]!.body!.input, { limit: 2 });
    await view.respond(1, complete('rows', { rows: [{ id: 'row-1', version: 7, name: 'Original', count: 3 }, { id: 'row-2', version: 2, name: 'Second', count: 4 }, { id: 'overflow', name: 'Excluded' }], nextCursor: 'page-2', totalRows: 3 }));
    assert.equal(view.host.querySelectorAll('tbody > tr').length, 2); assert.equal(view.host.textContent!.includes('Excluded'), false);
    await view.click('Edit'); await view.input('Name for row-1', 'Changed');
    await view.click('Save'); assert.match(view.host.textContent!, /Apply record changes/); assert.equal(view.requests.length, 2);
    await view.click('Confirm Edit record'); assert.deepEqual(view.requests[2]!.body!.input, { operation: 'update', row: { id: 'row-1', version: 7, name: 'Changed', count: 3 }, rows: [{ id: 'row-1', version: 7, name: 'Changed', count: 3 }], previousRow: { id: 'row-1', version: 7, name: 'Original', count: 3 }, rowId: 'row-1', expectedVersion: 7, changes: { name: 'Changed' } });
    assert.equal(view.requests[2]!.body!.confirmed, true); assert.equal(view.requests[2]!.body!.definitionVersion, 'synthetic-v1');
    await view.respond(2, complete('edit', {}, { state: 'failed', error: 'Version conflict; reload this row.' }));
    assert.match(view.host.textContent!, /Version conflict/); await view.click('Cancel edit'); assert.match(view.host.querySelector('tbody')!.textContent!, /Original/); assert.equal(view.host.querySelector('tbody')!.textContent!.includes('Changed'), false);
    await view.click('History'); assert.deepEqual(view.requests[3]!.body!.input, { rowId: 'row-1', row: { id: 'row-1', version: 7, name: 'Original', count: 3 } }); await view.respond(3, complete('history', { changes: ['Prior change'] })); assert.match(view.host.textContent!, /Prior change/);
    await view.click('Edit'); await view.input('Name for row-1', ''); await view.click('Save'); await view.click('Confirm Edit record');
    assert.deepEqual(view.requests[4]!.body!.input.changes, { name: '' }, 'text edits can clear a server value');
    await view.respond(4, complete('edit', { saved: true })); assert.match(view.host.textContent!, /saved/); assert.match(view.host.querySelector('tbody')!.textContent!, /Original/, 'values stay authoritative until reloaded');
    await view.respond(5, complete('rows', { rows: [{ id: 'row-1', version: 8, name: '', count: 3 }], nextCursor: 'page-2' })); assert.equal(view.host.querySelector('tbody')!.textContent!.includes('Original'), false); assert.match(view.host.textContent!, /saved/, 'save acknowledgement survives refresh');
    await view.click('Next page'); assert.equal(view.requests[6]!.body!.input.cursor, 'page-2'); await view.respond(6, complete('rows', { rows: [{ id: 'row-3', version: 1, name: 'Third', count: 5 }] })); assert.match(view.host.textContent!, /Page 2/); assert.equal(view.button('Next page').disabled, true);
  } finally { await view.close(); }
});

test('supplied rows need no key or version and apply generic callback output only after acknowledgements', async () => {
  const component: ControlComponent = { kind: 'data-grid', data: { rows: [{ name: 'Alpha', count: 1, tag: 'keep hidden values' }, { name: 'Beta', count: 2, tag: 'other' }], editAction: 'edit', addAction: 'add', deleteAction: 'delete', bulkAction: 'bulk', columns: [{ key: 'name', label: 'Name', editable: true }, { key: 'count', label: 'Count', type: 'number', editable: true }] } };
  const view = await fixture(component);
  try {
    assert.equal(view.requests.length, 1, 'supplied rows never auto-invoke read or mutation actions'); assert.equal(view.host.querySelectorAll('tbody > tr').length, 2);
    await view.click('Edit'); await view.input('Name for row 1', 'Updated'); await view.click('Save'); assert.equal(view.requests.length, 1);
    await view.click('Confirm Edit record');
    const previousRow = { name: 'Alpha', count: 1, tag: 'keep hidden values' }, updated = { ...previousRow, name: 'Updated' };
    assert.deepEqual(view.requests[1]!.body!.input, { operation: 'update', row: updated, rows: [updated], previousRow, changes: { name: 'Updated' } });
    assert.equal(Object.hasOwn(view.requests[1]!.body!.input, 'rowId'), false); assert.equal(Object.hasOwn(view.requests[1]!.body!.input, 'expectedVersion'), false);
    await view.respond(1, complete('edit', { row: { ...updated, name: 'From callback' } })); assert.match(view.host.querySelector('tbody')!.textContent!, /From callback/);
    await view.click('Add row'); await view.input('New Name', 'Created'); await view.input('New Count', '3'); await view.click('Save new row'); assert.equal(view.requests.length, 2);
    await view.click('Confirm Add record'); assert.deepEqual(view.requests[2]!.body!.input, { operation: 'add', row: { name: 'Created', count: 3 }, rows: [{ name: 'Created', count: 3 }] }); assert.equal(view.host.querySelectorAll('tbody > tr').length, 2, 'pending add never inserts a speculative row');
    await view.respond(2, complete('add', { row: { name: 'Created', count: 3, tag: 'added by callback' } })); assert.equal(view.host.querySelectorAll('tbody > tr').length, 3);
    await view.click('Delete'); await view.click('Confirm Delete record'); assert.deepEqual(view.requests[3]!.body!.input, { operation: 'delete', row: { ...updated, name: 'From callback' }, rows: [{ ...updated, name: 'From callback' }] }); assert.equal(view.host.querySelectorAll('tbody > tr').length, 3, 'pending deletion preserves the authoritative row');
    await view.respond(3, complete('delete', {})); assert.equal(view.host.querySelectorAll('tbody > tr').length, 2); assert.equal(view.host.querySelector('tbody')!.textContent!.includes('From callback'), false);
    await view.toggle('Select page'); await view.click('Apply to selected'); await view.click('Confirm Bulk records');
    assert.deepEqual(view.requests[4]!.body!.input, { operation: 'bulk', rows: [{ name: 'Beta', count: 2, tag: 'other' }, { name: 'Created', count: 3, tag: 'added by callback' }] });
    await view.respond(4, complete('bulk', { rows: [{ name: 'Acknowledged snapshot', count: 4 }] })); assert.equal(view.host.querySelectorAll('tbody > tr').length, 1); assert.match(view.host.querySelector('tbody')!.textContent!, /Acknowledged snapshot/);
    await view.click('Refresh actions'); await view.respond(5, config); assert.match(view.host.querySelector('tbody')!.textContent!, /Acknowledged snapshot/, 'refreshing definitions preserves acknowledged rows until new telemetry arrives');
    await view.render(true, { ...component, data: { ...component.data, rows: [{ name: 'Fresh telemetry', count: 9 }] } }); assert.match(view.host.querySelector('tbody')!.textContent!, /Fresh telemetry/); assert.equal(view.host.querySelector('tbody')!.textContent!.includes('Acknowledged snapshot'), false);
    await view.render(false); assert.equal(view.button('Add row').disabled, true); assert.equal(view.button('Delete').disabled, true); assert.equal(view.button('Apply to selected').disabled, true); assert.equal(view.requests.length, 6);
  } finally { await view.close(); }
});

test('fresh row telemetry wins over an older pending callback acknowledgement', async () => {
  const component: ControlComponent = { kind: 'data-grid', data: { rows: [{ name: 'Original' }], editAction: 'edit', columns: [{ key: 'name', label: 'Name', editable: true }] } };
  const view = await fixture(component);
  try {
    await view.click('Edit'); await view.input('Name for row 1', 'Submitted'); await view.click('Save'); await view.click('Confirm Edit record');
    await view.render(true, { ...component, data: { ...component.data, rows: [{ name: 'Newer telemetry' }] } });
    await view.respond(1, complete('edit', { row: { name: 'Older acknowledgement' } })); assert.match(view.host.querySelector('tbody')!.textContent!, /Newer telemetry/); assert.equal(view.host.querySelector('tbody')!.textContent!.includes('Older acknowledgement'), false);
  } finally { await view.close(); }
});

test('local supplied rows stay bounded, page and sort locally without command execution', async () => {
  const view = await fixture({ kind: 'data-grid', data: { rows: Array.from({ length: 2100 }, (_, index) => ({ name: `Row ${index}`, count: index })), pageSize: 3, editAction: 'write', columns: [{ key: 'name', label: 'Name', editable: true }, { key: 'count', label: 'Count', type: 'number' }] } });
  try {
    assert.equal(view.host.querySelectorAll('tbody > tr').length, 3); assert.match(view.host.textContent!, /2,000|2\s000/); assert.equal(view.requests.length, 1);
    await act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Sort Count"]')!.click()); assert.match(view.host.querySelector('tbody')!.textContent!, /Row 0/);
    await act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Sort Count"]')!.click()); assert.match(view.host.querySelector('tbody')!.textContent!, /Row 1999/);
    await view.click('Next page'); assert.equal(view.host.querySelectorAll('tbody > tr').length, 3); assert.match(view.host.querySelector('tbody')!.textContent!, /Row 1996/); assert.equal(view.requests.length, 1, 'local paging and sorting never run configured commands');
    await view.input('Filter rows', 'Row 20'); await view.click('Apply filter'); assert.match(view.host.textContent!, /Page 1/); assert.match(view.host.querySelector('tbody')!.textContent!, /Row 209/); assert.equal(view.requests.length, 1);
  } finally { await view.close(); }
});

test('remote totals of millions remain metadata across hundreds of bounded windows and forward filter and sorting', async () => {
  const view = await fixture({ kind: 'data-grid', data: { readAction: 'rows', pageSize: 3, columns: [{ key: 'name', label: 'Name' }, { key: 'count', label: 'Count', type: 'number' }] } });
  try {
    for (let page = 0; page < 300; page++) {
      const index = view.requests.length - 1; assert.equal(view.requests[index]!.body!.input.limit, 3);
      await view.respond(index, complete('rows', { rows: Array.from({ length: 3 }, (_, row) => ({ name: `Page ${page} row ${row}`, count: page * 3 + row })), nextCursor: `cursor-${page + 1}`, totalRows: 5_000_000 }));
      assert.equal(view.host.querySelectorAll('tbody > tr').length, 3); assert.match(view.host.textContent!, new RegExp(`Page ${page + 1} · 3 rows`));
      if (page) assert.equal(view.host.querySelector('tbody')!.textContent!.includes(`Page ${page - 1} row`), false, 'prior window rows never accumulate');
      if (page < 299) await view.click('Next page');
    }
    assert.match(view.host.textContent!, /5,000,000|5\s000\s000/);
    await view.input('Filter rows', 'server-only filter'); await view.click('Apply filter'); let index = view.requests.length - 1; assert.equal(view.requests[index]!.body!.input.filter, 'server-only filter'); assert.equal(view.requests[index]!.body!.input.cursor, undefined);
    await view.respond(index, complete('rows', { rows: [{ name: 'Filtered', count: 1 }], totalRows: 5_000_000 }));
    await act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Sort Count"]')!.click()); index = view.requests.length - 1; assert.deepEqual(view.requests[index]!.body!.input.sort, [{ key: 'count', direction: 'asc' }]); assert.equal(view.requests[index]!.body!.input.filter, 'server-only filter'); assert.equal(view.requests[index]!.body!.input.cursor, undefined);
    await view.respond(index, complete('rows', { rows: [{ name: 'Sorted', count: 1 }], totalRows: 5_000_000 })); assert.equal(view.host.querySelectorAll('tbody > tr').length, 1); assert.match(view.host.textContent!, /Page 1/);
  } finally { await view.close(); }
});

test('remote page requests cap page size at 200 and ignore overlarge callback windows', async () => {
  const view = await fixture({ kind: 'data-grid', data: { readAction: 'rows', pageSize: 10_000, columns: [{ key: 'name', label: 'Name' }] } });
  try {
    assert.equal(view.requests[1]!.body!.input.limit, 200);
    await view.respond(1, complete('rows', { rows: Array.from({ length: 250 }, (_, index) => ({ name: `Row ${index}` })), totalRows: 5_000_000 }));
    assert.equal(view.host.querySelectorAll('tbody > tr').length, 200); assert.equal(view.host.querySelector('tbody')!.textContent!.includes('Row 200'), false);
  } finally { await view.close(); }
});

test('grid column visibility, conditional editors, precedence and compound action envelopes obey configured features', async () => {
  const component: ControlComponent = {id:'settings',kind:'data-grid',data:{columns:[{key:'Instance',label:'Instance',hidden:true},{key:'Instrument',label:'Instrument'},{key:'Stream',label:'Stream'},{key:'Key',label:'Key'},{key:'Value',label:'Value',editable:true}],rows:[{Instance:'example',Instrument:'ABC',Stream:'',Key:'Enable',Value:'false'}],keyColumn:'Instance',keyColumns:['Instance','Instrument','Stream','Key'],editAction:'edit',rules:[{id:'boolean',column:'Value',when:{all:[{field:'Key',op:'eq',value:'Enable'}]},constraints:{type:'boolean',storage:'string',required:true},presentation:{color:'#88ddaa'},tooltip:'A strict boolean setting'}],precedence:{groupBy:['Key'],mandatory:['Instance'],dimensions:['Instrument','Stream'],context:{Instance:'example',Instrument:'ABC',Stream:'prices'}}}};
  const view=await fixture(component);
  try {
    assert.ok(![...view.host.querySelectorAll('thead th')].some(th=>th.textContent==='Instance'));
    assert.equal(view.host.querySelector('.grid-precedence')?.getAttribute('data-state'),'active');
    assert.match(view.host.querySelector('td[title="A strict boolean setting"]')!.textContent!,/false/);
    await view.click('Edit');assert.ok(view.host.querySelector('select[aria-label="Value for example"]'));
    await view.input('Value for example','true');await view.click('Save');await view.click('Confirm Edit record');
    const input=view.requests[1]!.body!.input;
    assert.equal(input.componentId,'settings');assert.equal(input.row.Value,'true');assert.equal(input.row.Instance,'example');assert.deepEqual(input.rowKey,{Instance:'example',Instrument:'ABC',Stream:'',Key:'Enable'});
    await view.respond(1,complete('edit',{row:input.row}));
    await view.render(true,{...component,data:{...component.data,features:{edit:false,hideColumns:false,sort:false,filter:false}}});
    assert.equal(view.button('Edit'),undefined);assert.doesNotMatch(view.host.textContent!,/Visible columns/);assert.equal(view.host.querySelector('[aria-label="Filter rows"]'),null);
  } finally {await view.close();}
});


test('inline icon actions retain accessible names, typed form input and version-bound confirmation', async () => {
  const view=await fixture({kind:'action-panel',data:{actionIds:['write'],layout:'inline',buttons:[{actionId:'write',appearance:'icon',icon:'lock',variant:'bare',label:''}]}},false,config,{caption:{visible:false},refresh:{visible:false},history:{visible:false}});
  const submit=()=>view.host.querySelector<HTMLButtonElement>('button[data-control="submit"]')!;
  const activate=async()=>act(async()=>{submit().click();await new Promise<void>(resolve=>setImmediate(resolve));});
  try {
    assert.equal(submit().type,'submit');assert.equal(submit().disabled,true);
    assert.equal(submit().getAttribute('aria-label'),'Review Update settings');
    assert.equal(submit().textContent,'');assert.equal(submit().title,'Review Update settings');
    assert.equal(view.host.querySelector('.control-history'),null);
    await view.render(true);assert.equal(view.requests.length,1,'hidden history does not fetch');
    await view.input('Mode','safe');await view.input('Notes','Keep this draft');await view.input('Limit','5');await view.input('Data','{"key":1}');
    await view.render(false);await view.render(true);
    assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value,'safe');
    await activate();assert.equal(view.requests.length,1,'review sends no action');
    await view.click('Cancel');await activate();await view.click('Confirm Update settings');
    const request=view.requests[1]!;
    assert.equal(request.body!.definitionVersion,'synthetic-v1');assert.equal(request.body!.confirmed,true);
    assert.deepEqual(request.body!.input,{enabled:false,mode:'safe',notes:'Keep this draft',limit:5,data:{key:1}});
    assert.equal(submit().disabled,true);assert.equal(submit().getAttribute('aria-busy'),'true');
    await view.respond(1,complete('write'));assert.equal(view.requests.length,2,'one invocation, no automatic retry');
  } finally {await view.close();}
});
