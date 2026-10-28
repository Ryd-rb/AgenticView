import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { SessionView, type SessionComponent } from '../web/SessionViews.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';

type Request = { path: string; signal: AbortSignal; body?: Record<string, any>; done: boolean; resolve: (value: Response) => void; reject: (error: Error) => void };
const record = (extra: object = {}) => ({ id: 'session-1', runId: 'run-1', name: 'Synthetic session', agentType: 'synthetic-cli', state: 'draft', desiredState: 'running', attempt: 0, recoveryCount: 0, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001, outputRevision: 0, autoRecover: true, replacementAvailable: false, configurationVersion: 'cfg-v1', ...extra });
const entry = (sequence: number, text = `Output entry ${sequence}`, extra: object = {}) => ({ sequence, text, time: 1_700_000_000_000 + sequence, stream: 'stdout', format: 'text', level: 'info', ...extra });
const output = (entries: unknown[] = [], next = 0, truncated = false) => ({ entries, next, earliest: 0, truncated });
async function fixture(component: SessionComponent = { kind: 'agent-session', data: { sessionId: 'session-1' } }, selected = true, embeds = true) {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let hidden = false, timerId = 700_000;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  const original = { fetch: globalThis.fetch, set: globalThis.setTimeout, clear: globalThis.clearTimeout }, requests: Request[] = [], timers = new Map<number, () => void>();
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => { if (delay === 1500) { timers.set(++timerId, callback); return timerId; } return original.set(callback, delay, ...args); }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { if (!timers.delete(id)) original.clear(id); }) as typeof clearTimeout;
  globalThis.fetch = async (path, init) => {
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store'); const signal = init!.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => { requests.push({ path: String(path), signal, body: init?.body ? JSON.parse(String(init.body)) : undefined, done: false, resolve, reject }); signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
  };
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = () => new Promise<void>(done => setImmediate(done));
  let active = selected, trusted = embeds, unmounted = false;
  const render = async (nextSelected = active, nextEmbeds = trusted) => act(async () => { active = nextSelected; trusted = nextEmbeds; root.render(createElement(CardInteraction.Provider, { value: active }, createElement(SessionView, { component, runId: 'launcher-run', embeds: trusted }))); await settle(); });
  const respond = async (index: number, value: unknown, status = 200) => act(async () => { requests[index]!.done = true; requests[index]!.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })); await settle(); });
  const reject = async (index: number) => act(async () => { requests[index]!.done = true; requests[index]!.reject(new Error('Connection lost.')); await settle(); });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  const click = async (label: string) => act(async () => { const target = button(label); assert.ok(target, `button ${label}`); target.click(); await settle(); });
  const input = async (label: string, value: string) => act(async () => { const target = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; assert.ok(target); const prototype = target.tagName === 'TEXTAREA' ? dom.HTMLTextAreaElement.prototype : target.tagName === 'SELECT' ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await settle(); });
  const advance = async () => act(async () => { const due = [...timers.values()]; timers.clear(); for (const callback of due) callback(); await settle(); });
  const pending = (part: string) => requests.findLastIndex(request => (part === '/api/sessions/session-1' ? request.path === part : request.path.includes(part)) && !request.done && !request.signal.aborted);
  const visibility = async (value: boolean) => act(async () => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); await settle(); });
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => { root.unmount(); await settle(); }); } };
  await render();
  return { host, requests, timers, render, respond, reject, button, click, input, advance, pending, visibility, unmount,
    close: async () => { await unmount(); globalThis.fetch = original.fetch; globalThis.setTimeout = original.set; globalThis.clearTimeout = original.clear; await dom.happyDOM.close(); },
  };
}

test('launcher creates only a draft on explicit selection and retries uncertainty with the same identity', async () => {
  const view = await fixture({ kind: 'session-launcher', data: { actionId: 'launch', label: 'New agent prompt' } }, false);
  try {
    assert.equal(view.requests.length, 0); assert.equal(view.button('New agent prompt').disabled, true); await view.click('New agent prompt'); assert.equal(view.requests.length, 0);
    await view.render(true); await view.click('New agent prompt'); assert.equal(view.requests[0]!.path, '/api/sessions/draft'); assert.equal(view.requests[0]!.body!.launcherRunId, 'launcher-run'); assert.equal(view.requests[0]!.body!.actionId, 'launch'); assert.equal(view.requests[0]!.body!.prompt, undefined);
    const body = view.requests[0]!.body!; await view.reject(0); await view.click('Retry creating prompt card'); assert.deepEqual(view.requests[1]!.body, body); await view.respond(1, record());
    assert.match(view.host.textContent!, /Enter a prompt in the new card/); assert.equal(view.requests.some(request => request.path.endsWith('/control')), false, 'draft creation never starts an agent');
  } finally { await view.close(); }
});

test('session Start requires a prompt, selection and configured inline version-bound confirmation', async () => {
  const view = await fixture(undefined, false);
  try {
    assert.equal(view.requests.length, 2); await view.respond(view.pending('/output?'), output()); await view.respond(view.pending('/api/sessions/session-1'), record({ confirmation: 'Launch the configured agent?' }));
    assert.equal(view.button('Start').disabled, true); assert.equal(view.requests.filter(request => request.body).length, 0);
    await view.render(true); assert.equal(view.button('Start').disabled, true); assert.equal(view.host.querySelector<HTMLTextAreaElement>('[aria-label="Session prompt"]')!.maxLength, 65536);
    await view.input('Session prompt', 'Investigate the synthetic task.'); await view.click('Start'); assert.ok(view.host.querySelector('[aria-label="Review session action"]')); assert.equal(view.requests.length, 2);
    await view.click('Cancel'); await view.click('Start'); await view.render(false); assert.equal(view.host.querySelector('[aria-label="Review session action"]'), null); assert.equal(view.requests.length, 2, 'deselection cannot confirm a pending launch');
    await view.render(true); await view.click('Start'); await view.click('Confirm Start'); const start = view.requests.at(-1)!; assert.equal(start.path, '/api/sessions/session-1/control'); assert.equal(start.body!.operation, 'start'); assert.equal(start.body!.prompt, 'Investigate the synthetic task.'); assert.equal(start.body!.confirmed, true); assert.equal(start.body!.configurationVersion, 'cfg-v1');
    await view.respond(view.requests.length - 1, record({ state: 'running', attempt: 1, updatedAt: 1_700_000_000_002 }));
    await view.render(false); assert.equal(view.button('Pause').disabled, true); await view.click('Pause'); assert.equal(view.requests.filter(request => request.body).length, 1);
    await view.render(true); await view.click('Pause'); assert.equal(view.requests.at(-1)!.body!.operation, 'pause'); await view.respond(view.requests.length - 1, record({ state: 'paused', attempt: 1, updatedAt: 1_700_000_000_003 }));
    await view.click('Resume'); assert.equal(view.requests.at(-1)!.body!.operation, 'resume'); await view.respond(view.requests.length - 1, record({ state: 'running', attempt: 1, updatedAt: 1_700_000_000_004 }));
    await view.click('Stop'); assert.equal(view.requests.at(-1)!.body!.operation, 'stop');
  } finally { await view.close(); }
});

test('recovery stays in the same card and exposes explicit fallback resume plus private export', async () => {
  const view = await fixture();
  try {
    await view.respond(view.pending('/output?'), output()); await view.respond(view.pending('/api/sessions/session-1'), record({ state: 'offline', attempt: 2, recoveryCount: 1, recoveryMode: 'handoff', replacementAvailable: true, lastError: 'The worker is offline.', confirmation: 'Review recovery launch.' }));
    assert.match(view.host.textContent!, /Handoff recovery · replacement agent, same card/); assert.equal(view.button('Start recovery session').disabled, false); assert.equal(view.host.querySelector<HTMLAnchorElement>('a[download]')!.getAttribute('href'), '/api/sessions/session-1/export');
    await view.click('Start recovery session'); assert.equal(view.requests.filter(request => request.body).length, 0); await view.click('Confirm Start recovery session'); assert.equal(view.requests.at(-1)!.body!.operation, 'resume'); assert.equal(view.requests.at(-1)!.body!.confirmed, true); await view.respond(view.requests.length - 1, record({ state: 'paused', attempt: 3, recoveryCount: 2, recoveryMode: 'native', nativeSessionId: 'native-identity' })); assert.match(view.host.textContent!, /Native session recovery · same card/); assert.match(view.host.textContent!, /native-identity/);
  } finally { await view.close(); }
});

test('structured output renders safe Markdown and JSON; HTML stays sandboxed, shielded and trust-gated', async () => {
  const view = await fixture();
  try {
    await view.respond(view.pending('/api/sessions/session-1'), record({ state: 'running', attempt: 1 })); await view.respond(view.pending('/output?'), output([entry(1, '# Heading\n<script>unsafe()</script>', { format: 'markdown', label: 'tool result' })], 1));
    assert.equal(view.host.querySelector('h1')!.textContent, 'Heading'); assert.equal(view.host.querySelector('script'), null); assert.match(view.host.textContent!, /tool result/);
    await view.input('Output render mode', 'HTML'); let frame = view.host.querySelector<HTMLIFrameElement>('iframe')!; assert.ok(frame); assert.equal(frame.getAttribute('src'), '/api/sessions/session-1/output/1/html'); assert.equal(frame.hasAttribute('srcdoc'), false); assert.match(frame.getAttribute('sandbox')!, /allow-scripts/); assert.doesNotMatch(frame.getAttribute('sandbox')!, /allow-same-origin|allow-top-navigation/); assert.equal(frame.style.pointerEvents, 'none'); assert.ok(view.host.querySelector('.session-html-shield')); assert.match(view.host.textContent!, /Custom view/);
    await view.click('Interact with HTML'); frame = view.host.querySelector('iframe')!; assert.equal(frame.style.pointerEvents, 'auto'); await view.render(false); assert.equal(view.host.querySelector<HTMLIFrameElement>('iframe')!.style.pointerEvents, 'none');
    await view.render(true, false); assert.equal(view.host.querySelector('iframe'), null); assert.match(view.host.textContent!, /paused in trusted embed settings/);
    await view.render(true, true); await view.advance(); await view.respond(view.pending('/output?'), output([entry(2, '{"answer":42}', { format: 'json' })], 2)); await view.input('Output render mode', 'Auto'); assert.match(view.host.querySelector('.session-json')!.textContent!, /"answer": 42/);
  } finally { await view.close(); }
});

test('output retains a bounded window, preserves scrollback, forwards search and aborts hidden/unmounted polls', async () => {
  const view = await fixture();
  try {
    await view.respond(view.pending('/api/sessions/session-1'), record({ state: 'running', attempt: 1 })); await view.respond(view.pending('/output?'), output(Array.from({ length: 200 }, (_, i) => entry(i + 1)), 200)); assert.equal(view.host.querySelectorAll('.session-output-row').length, 50);
    await view.click('Previous output'); assert.match(view.host.textContent!, /Reading scrollback/); const selected = view.host.querySelector('[aria-label="Selected output"]')!.textContent;
    await view.advance(); const pendingRecord = view.pending('/api/sessions/session-1'), pendingOutput = view.pending('/output?'); assert.ok(pendingRecord >= 0 && pendingOutput >= 0); assert.equal(view.timers.size, 0);
    await act(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(view.pending('/output?'), pendingOutput, 'visible notifications never overlap a pending endpoint');
    await view.respond(pendingOutput, output(Array.from({ length: 200 }, (_, i) => entry(i + 201)), 400)); assert.equal(view.host.querySelector('[aria-label="Selected output"]')!.textContent, selected, 'new output cannot move an operator reading scrollback'); assert.equal(view.host.querySelectorAll('.session-output-row').length, 50);
    await view.click('Follow latest'); assert.match(view.host.querySelector('[aria-label="Selected output"]')!.textContent!, /#400/);
    for (let chunk = 2; chunk < 12; chunk++) { await view.advance(); await view.respond(view.pending('/output?'), output(Array.from({ length: 200 }, (_, i) => entry(chunk * 200 + i + 1)), (chunk + 1) * 200, true)); }
    assert.match(view.host.textContent!, /2000 retained entries/); assert.equal(view.host.querySelectorAll('.session-output-row').length, 50);
    await view.advance(); await view.respond(view.pending('/output?'), output(Array.from({ length: 20 }, (_, i) => entry(3000 + i, 'x'.repeat(60_000))), 3020)); assert.match(view.host.textContent!, /16 retained entries/); assert.match(view.host.textContent!, /960,000 characters/); assert.ok(view.host.textContent!.length < 50_000, 'rich detail and row excerpts never mount the retained megabyte');
    await view.input('Search session output', 'tool & failure'); await view.click('Search'); const searched = view.pending('/output?'); assert.match(view.requests[searched]!.path, /after=0&limit=200&filter=tool%20%26%20failure/); await view.respond(searched, output([entry(4000, 'Filtered result')], 4000));
    await view.advance(); const activeOutput = view.pending('/output?'); await view.render(false); assert.equal(view.requests[activeOutput]!.signal.aborted, false, 'unselected visible output keeps monitoring'); await view.visibility(true); assert.equal(view.requests[activeOutput]!.signal.aborted, true); assert.equal(view.requests[pendingRecord]!.signal.aborted, true); assert.equal(view.timers.size, 0);
    await view.visibility(false); const last = view.requests.at(-1)!; await view.unmount(); assert.equal(last.signal.aborted, true); assert.equal(view.timers.size, 0);
  } finally { await view.close(); }
});

test('completed sessions accept follow-up prompts; uncertain controls preserve request identity and output pause leaves status live', async () => {
  const view = await fixture();
  try {
    await view.respond(view.pending('/api/sessions/session-1'), record({ state: 'completed', attempt: 1, confirmation: 'Review this prompt.' })); await view.respond(view.pending('/output?'), output());
    await view.input('Session prompt', 'One explicit prompt'); await view.click('Send prompt'); assert.equal(view.requests.filter(item => item.body).length, 0); await view.click('Confirm Send prompt'); const request = view.requests.at(-1)!, first = request.body!; assert.equal(first.confirmed, true); await view.reject(view.requests.length - 1); assert.equal(view.requests.filter(item => item.body).length, 1);
    await view.click('Retry session request'); assert.deepEqual(view.requests.at(-1)!.body, first); await view.respond(view.requests.length - 1, record({ state: 'running', attempt: 1 })); assert.equal(view.host.querySelector<HTMLTextAreaElement>('[aria-label="Session prompt"]')!.value, '', 'acknowledged retry clears the consumed prompt');
    await view.click('Pause output'); await view.advance(); assert.equal(view.pending('/output?'), -1); assert.ok(view.pending('/api/sessions/session-1') >= 0); await view.click('Resume output'); assert.ok(view.pending('/output?') >= 0);
  } finally { await view.close(); }
});
