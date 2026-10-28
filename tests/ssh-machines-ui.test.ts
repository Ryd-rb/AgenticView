import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { SshMachines } from '../web/SshMachines.tsx';

type Pending = { path: string; method: string; signal: AbortSignal; body?: Record<string, any>; resolve: (response: Response) => void; reject: (error: Error) => void };
const account = (id = 'account-a', extra: object = {}) => ({ id, label: `Saved ${id}`, username: `user-${id}`, version: 'version-1', updatedAt: id === 'account-a' ? 200 : 100, ...extra });
const machine = (extra: object = {}) => ({ id: 'machine-one', label: 'Synthetic machine', host: 'synthetic-private-alias', port: 22, connectorId: 'local-worker', authentication: 'password', credentialId: 'account-b', credentialLabel: 'Saved account-b', credentialVersion: 'version-1', username: 'user-account-b', valid: true, updatedAt: 1, ...extra });
const metadata = (extra: object = {}) => ({ machines: [machine()], credentials: [account(), account('account-b')], ...extra });
async function fixture(initial?: unknown) {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const original = globalThis.fetch, requests: Pending[] = [], reports: string[] = [];
  globalThis.fetch = async (path, init) => { assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store'); const signal = init!.signal as AbortSignal; return new Promise<Response>((resolve, reject) => { requests.push({ path: String(path), method: init?.method ?? 'GET', signal, body: init?.body ? JSON.parse(String(init.body)) : undefined, resolve, reject }); signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }); };
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = () => new Promise<void>(done => setImmediate(done));
  const respond = async (index: number, value: unknown, status = 200) => act(async () => { requests[index]!.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })); await settle(); });
  const reject = async (index: number, message = 'Synthetic transport failure') => act(async () => { requests[index]!.reject(new Error(message)); await settle(); });
  const input = async (label: string, value: string) => act(async () => { const target = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; assert.ok(target, `input ${label}`); Object.getOwnPropertyDescriptor(target.tagName === 'SELECT' ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await settle(); });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(target => target.textContent === label)!;
  const click = async (label: string) => act(async () => { const target = button(label); assert.ok(target, `button ${label}`); target.click(); await settle(); });
  const clickAria = async (label: string) => act(async () => { const target = [...host.querySelectorAll<HTMLButtonElement>('button')].find(target => target.getAttribute('aria-label') === label)!; assert.ok(target); target.click(); await settle(); });
  const fillMachine = async () => { await input('Machine ID', 'new-machine'); await input('Machine label', 'New machine'); await input('SSH host', 'new-private-alias'); await input('SSH connector ID', 'local-worker'); };
  let unmounted = false; const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => { root.unmount(); await settle(); }); } };
  await act(() => root.render(createElement(SshMachines, { report: message => reports.push(message) }))); assert.equal(requests[0]!.path, '/api/ssh/machines');
  if (initial !== undefined) await respond(0, initial);
  return { dom, host, requests, reports, respond, reject, input, button, click, clickAria, fillMachine, unmount, close: async () => { await unmount(); globalThis.fetch = original; await dom.happyDOM.close(); } };
}

test('new machines reuse a saved account without resending its username or password', async () => {
  const view = await fixture(metadata());
  try {
    assert.equal(view.requests.length, 1); assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="SSH account source"]')!.value, 'reuse'); assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="Saved SSH account"]')!.value, 'account-a'); assert.equal(view.host.querySelector('input[type="password"]'), null);
    await view.fillMachine(); await view.click('Save machine'); assert.equal(view.requests[1]!.method, 'PUT'); assert.deepEqual(view.requests[1]!.body, { id: 'new-machine', label: 'New machine', host: 'new-private-alias', port: 22, connectorId: 'local-worker', credentialId: 'account-a' });
    assert.equal(view.button('Saving…').disabled, true); await view.click('Saving…'); assert.equal(view.requests.length, 2, 'only one save can be pending');
    await view.respond(1, machine({ id: 'new-machine', credentialId: 'account-a' })); assert.equal(view.requests[2]!.method, 'GET'); assert.equal(view.reports.length, 1);
  } finally { await view.close(); }
});

test('new passwords are masked, preserved exactly for saving, cleared on acknowledgement and never stored or listed', async () => {
  const view = await fixture(metadata({ machines: [], credentials: [] })); const password = ' synthetic-only password with spaces ';
  try {
    let writes = 0; view.dom.localStorage.setItem = () => { writes++; }; view.dom.sessionStorage.setItem = () => { writes++; };
    await view.fillMachine(); await view.input('SSH account label', 'Shared synthetic login'); await view.input('SSH username', 'DOMAIN\\user name'); await view.input('SSH password', password);
    assert.equal(view.host.querySelector<HTMLInputElement>('[aria-label="SSH password"]')!.type, 'password'); assert.equal(view.host.textContent!.includes(password), false);
    await view.click('Save machine'); assert.equal(view.requests[1]!.body!.password, password); assert.equal(view.requests[1]!.body!.username, 'DOMAIN\\user name'); assert.equal(view.requests[1]!.body!.credentialId, undefined);
    await view.respond(1, { ...machine(), password: 'unexpected-response-secret' }); assert.equal(view.host.querySelector<HTMLInputElement>('[aria-label="SSH password"]')!.value, '');
    await view.respond(2, metadata({ machines: [machine({ id: 'new-machine' })], credentials: [account('account-b', { password: 'must-never-be-listed' })] })); assert.equal(view.host.querySelector('input[type="password"]'), null); assert.equal(view.host.textContent!.includes('must-never-be-listed'), false); assert.equal(view.host.textContent!.includes('unexpected-response-secret'), false); assert.equal(view.reports.join('').includes(password), false); assert.equal(writes, 0);
  } finally { await view.close(); }
});

test('invalid machines are selectable for repair and a new machine can reuse the previously chosen account', async () => {
  const view = await fixture(metadata());
  try {
    await view.input('Saved machine', 'machine-one'); assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="Saved SSH account"]')!.value, 'account-b'); assert.equal(view.host.querySelector<HTMLInputElement>('[aria-label="Machine ID"]')!.disabled, true);
    await view.click('New machine'); assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="Saved SSH account"]')!.value, 'account-b', 'new machine reuses the previously selected account');
    await view.input('Saved machine', 'machine-one'); await view.click('Refresh machines'); await view.respond(1, metadata({ machines: [machine({ valid: false, message: '<script>Authentication rejected</script>' })] }));
    assert.ok(view.host.querySelector('[aria-label="Machine credentials required"]')); assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="SSH account source"]')!.value, 'new'); assert.equal(view.host.querySelector<HTMLInputElement>('[aria-label="SSH password"]')!.value, ''); assert.equal(view.host.querySelector('script'), null); assert.match(view.host.textContent!, /Authentication rejected/);
    await view.input('SSH password', 'replacement synthetic password'); await view.click('New machine'); assert.equal(view.host.querySelector('input[type="password"]'), null, 'switching machine discards a typed password'); assert.match(view.host.textContent!, /no scheduled expiry/);
  } finally { await view.close(); }
});

test('existing SSH agent/config mode sends no password or saved credential reference and supports optional username', async () => {
  const view = await fixture(metadata());
  try {
    await view.fillMachine(); await view.input('SSH account source', 'agent'); assert.equal(view.host.querySelector('input[type="password"]'), null); assert.match(view.host.textContent!, /No password is saved/);
    await view.input('SSH host', '::1'); await view.click('Save machine'); assert.deepEqual(view.requests[1]!.body, { id: 'new-machine', label: 'New machine', host: '::1', port: 22, connectorId: 'local-worker', authentication: 'agent' });
    await view.respond(1, machine({ id: 'new-machine', authentication: 'agent' })); await view.respond(2, metadata({ machines: [machine({ id: 'new-machine', authentication: 'agent', username: '' })] })); assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="SSH account source"]')!.value, 'agent');
    await view.input('SSH username', 'optional.login'); await view.click('Save machine'); assert.equal(view.requests[3]!.body!.username, 'optional.login'); assert.equal(Object.hasOwn(view.requests[3]!.body!, 'credentialId'), false); assert.equal(Object.hasOwn(view.requests[3]!.body!, 'password'), false);
  } finally { await view.close(); }
});

test('forgetting an account requires an explicit review and refreshes bound machine state', async () => {
  const view = await fixture(metadata());
  try {
    await view.input('Saved machine', 'machine-one'); await view.clickAria('Forget account Saved account-b'); assert.ok(view.host.querySelector('[aria-label="Confirm forget SSH account"]')); assert.equal(view.requests.length, 1);
    await view.click('Cancel'); assert.equal(view.requests.length, 1); await view.clickAria('Forget account Saved account-b'); await view.click('Confirm forget account'); assert.equal(view.requests[1]!.method, 'DELETE'); assert.equal(view.requests[1]!.path, '/api/ssh/credentials/account-b'); assert.equal(view.requests[1]!.body, undefined);
    await view.respond(1, { removed: true }); await view.respond(2, metadata({ machines: [machine({ valid: false, message: 'Saved account removed.' })], credentials: [account()] })); assert.match(view.host.textContent!, /Credentials required/); assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="SSH account source"]')!.value, 'new'); assert.equal(view.host.querySelector<HTMLInputElement>('[aria-label="SSH password"]')!.value, '');
  } finally { await view.close(); }
});

test('validation blocks option/shell hosts and server errors never echo a typed password', async () => {
  const view = await fixture(metadata({ machines: [], credentials: [] }));
  try {
    await view.fillMachine(); await view.input('SSH username', 'synthetic'); await view.input('SSH password', 'synthetic-secret-password'); await view.input('SSH host', 'host;command'); await view.click('Save machine'); assert.equal(view.requests.length, 1); assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /without a username/);
    await view.input('SSH host', 'synthetic-host'); await view.input('SSH username', '-oBad'); await view.click('Save machine'); assert.equal(view.requests.length, 1); await view.input('SSH username', 'synthetic'); await view.click('Save machine'); await view.respond(1, { error: 'synthetic-secret-password echoed by bad server' }, 500); assert.equal(view.host.textContent!.includes('synthetic-secret-password'), false); assert.equal(view.reports.join('').includes('synthetic-secret-password'), false); assert.equal(view.requests.length, 2, 'failed save never automatically retries');
  } finally { await view.close(); }
});

test('401 notifies authentication and unmount aborts catalog/save requests without leaking late success', async () => {
  const initial = await fixture();
  try { let unauthorized = 0; window.addEventListener('agenticview:unauthorized', () => unauthorized++); await initial.respond(0, {}, 401); assert.equal(unauthorized, 1); assert.match(initial.host.textContent!, /Sign in/); }
  finally { await initial.close(); }
  const loading = await fixture(); try { await loading.unmount(); assert.equal(loading.requests[0]!.signal.aborted, true); } finally { await loading.close(); }
  const view = await fixture(metadata());
  try { await view.fillMachine(); await view.click('Save machine'); await view.unmount(); assert.equal(view.requests[1]!.signal.aborted, true); await view.respond(1, machine()); assert.equal(view.reports.length, 0); assert.equal(view.requests.length, 2); }
  finally { await view.close(); }
});
