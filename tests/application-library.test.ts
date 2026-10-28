import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { ApplicationLibrary } from '../web/ApplicationLibrary.tsx';

type Pending = { path: string; signal: AbortSignal; body?: Record<string, any>; resolve: (response: Response) => void; reject: (error: Error) => void };
const authored = (binding = true) => ({ schemaVersion: 1, id: 'synthetic-console', version: '1.0.0', name: 'Synthetic console', description: 'An authored repository template', permanent: true, bindings: binding ? [{ id: 'service', label: 'Service worker', description: 'Choose the worker installed here.' }] : [], actions: [{ id: 'send', label: 'Send', kind: 'prompt', target: binding ? 'service' : 'agent', ...(binding ? { handler: 'agent-hook' } : {}), confirmation: 'Review the request.' }], components: [{ id: 'controls', title: 'Controls', kind: 'action-panel', data: { actionIds: ['send'] } }, { id: 'custom', title: 'Custom view', kind: 'embed', data: { html: '<script>shouldNeverExecute()</script>' } }] });
test('component default expansion cannot produce an oversized application import',async()=>{
  const view=await fixture();try{const manifest={...authored(false),components:Array.from({length:8},(_,i)=>({id:'logs-'+i,title:'Template',kind:'logs',data:{entries:Array.from({length:2000},()=>({message:''}))}}))};const text=JSON.stringify(manifest);assert.ok(new TextEncoder().encode(text).byteLength<262144);await view.input('Application manifest JSON',text);assert.match(view.host.textContent!,/Normalized manifest exceeds/);assert.equal(view.button('Import application').disabled,true);assert.equal(view.requests.filter(r=>r.body).length,0);}finally{await view.close();}
});
async function fixture(completeList = true) {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const original = globalThis.fetch, requests: Pending[] = [], reports: string[] = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
    const signal = init!.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => { requests.push({ path: String(path), signal, body: init?.body ? JSON.parse(String(init.body)) : undefined, resolve, reject }); signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
  };
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = () => new Promise<void>(done => setImmediate(done));
  const respond = async (index: number, body: unknown, status = 200) => act(async () => { requests[index]!.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })); await settle(); });
  const reject = async (index: number) => act(async () => { requests[index]!.reject(new Error('Connection lost before acknowledgement.')); await settle(); });
  const input = async (label: string, value: string) => act(async () => { const target = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; assert.ok(target); const prototype = target.tagName === 'TEXTAREA' ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })); await settle(); });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  const click = async (label: string) => act(async () => { assert.ok(button(label), `button ${label}`); button(label).click(); await settle(); });
  const choose = async (file: unknown) => act(async () => { const target = host.querySelector<HTMLInputElement>('[aria-label="Application manifest file"]')!; Object.defineProperty(target, 'files', { configurable: true, value: [file] }); target.dispatchEvent(new Event('change', { bubbles: true })); await settle(); });
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => { root.unmount(); await settle(); }); } };
  await act(() => root.render(createElement(ApplicationLibrary, { report: message => reports.push(message) })));
  assert.equal(requests[0]!.path, '/api/applications'); if (completeList) await respond(0, []);
  return { dom, host, requests, reports, respond, reject, input, button, click, choose, unmount,
    close: async () => { await unmount(); globalThis.fetch = original; await dom.happyDOM.close(); },
  };
}

test('manifest paste previews safe authored content, maps bindings and imports only after an explicit click', async () => {
  const view = await fixture(); let imported = 0;
  try {
    window.addEventListener('agenticview:applications-imported', () => imported++);
    const manifest = { ...authored(), name: '<script>literal application name</script>' };
    await view.input('Application manifest JSON', JSON.stringify(manifest));
    assert.ok(view.host.querySelector('[aria-label="Application preview"]')); assert.match(view.host.textContent!, /Permanent application/); assert.match(view.host.textContent!, /2 components · 1 actions · 1 bindings/); assert.match(view.host.textContent!, /Custom view/); assert.equal(view.host.querySelector('script'), null); assert.equal(view.host.querySelector('iframe'), null);
    assert.equal(view.requests.length, 1, 'preview never imports applications or invokes actions'); assert.equal(view.button('Import application').disabled, true);
    await view.input('Local connector for Service worker', 'local-worker'); assert.equal(view.button('Import application').disabled, false);
    await view.click('Import application'); assert.equal(view.requests[1]!.path, '/api/applications/import'); assert.deepEqual(view.requests[1]!.body!.bindings, { service: 'local-worker' }); assert.equal(view.requests[1]!.body!.manifest.actions[0].target, 'service'); assert.equal(JSON.stringify(view.requests[1]!.body!.manifest).includes('local-worker'), false);
    assert.match(view.requests[1]!.body!.requestId, /^[a-f0-9-]{36}$/); assert.ok(view.requests[1]!.body!.registrationKey.length >= 32); assert.equal(view.button('Importing…').disabled, true);
    await view.click('Importing…'); assert.equal(view.requests.length, 2, 'double-click cannot create a second in-flight import');
    await view.respond(1, { runId: 'synthetic-run', sequence: 1, application: { id: manifest.id, name: manifest.name, version: manifest.version } }); assert.equal(imported, 1); assert.equal(view.reports.length, 1); assert.equal(view.requests[2]!.path, '/api/applications'); assert.equal(view.button('Imported').disabled, true);
    await view.respond(2, [{ runId: 'run/with?reserved', id: manifest.id, name: manifest.name, version: '1.0.0', components: 2, actions: 1 }]);
    const link = view.host.querySelector<HTMLAnchorElement>('a')!; assert.equal(link.getAttribute('href'), '/api/applications/run%2Fwith%3Freserved/export'); assert.equal(link.download, 'synthetic-console.agenticview.json'); assert.equal(view.host.querySelector('script'), null);
  } finally { await view.close(); }
});

test('uncertain import retries preserve identity and payload edits create a fresh explicit intent', async () => {
  const view = await fixture();
  try {
    await view.input('Application manifest JSON', JSON.stringify(authored())); await view.input('Local connector for Service worker', 'first-worker'); await view.click('Import application'); const first = view.requests[1]!.body!;
    await view.reject(1); assert.match(view.host.textContent!, /Retry keeps this import request unchanged/); assert.equal(view.requests.length, 2, 'transport failure never automatically reimports');
    await view.click('Retry import'); assert.deepEqual(view.requests[2]!.body, first, 'request ID and registration proof remain stable after uncertain delivery'); await view.reject(2);
    await view.input('Local connector for Service worker', 'second-worker'); await view.click('Import application'); const changedBinding = view.requests[3]!.body!; assert.notEqual(changedBinding.requestId, first.requestId); assert.notEqual(changedBinding.registrationKey, first.registrationKey); assert.deepEqual(changedBinding.bindings, { service: 'second-worker' }); await view.reject(3);
    await view.input('Application manifest JSON', JSON.stringify({ ...authored(false), version: '2.0.0' })); await view.click('Import application'); assert.notEqual(view.requests[4]!.body!.requestId, changedBinding.requestId); assert.equal(view.requests[4]!.body!.manifest.version, '2.0.0');
  } finally { await view.close(); }
});

test('invalid manifests and oversized UTF-8 input never import; oversized files are rejected before reading', async () => {
  const view = await fixture();
  try {
    for (const source of ['{bad json', JSON.stringify({ ...authored(false), permanent: false }), JSON.stringify({ ...authored(false), runToken: 'not-a-manifest-field' }), JSON.stringify({ ...authored(false), description: '😀'.repeat(70_000) })]) {
      await view.input('Application manifest JSON', source); assert.equal(view.button('Import application').disabled, true); assert.ok(view.host.querySelector('[role="alert"]')); await view.click('Import application'); assert.equal(view.requests.length, 1);
    }
    assert.match(view.host.textContent!, /256 KiB UTF-8 limit/);
    let reads = 0; await view.choose({ size: 262145, text: async () => { reads++; return ''; } }); assert.equal(reads, 0); assert.match(view.host.textContent!, /file exceeds/); assert.equal(view.requests.length, 1);
  } finally { await view.close(); }
});

test('file selection uses the same validated preview and never automatically imports', async () => {
  const view = await fixture();
  try {
    const input = view.host.querySelector<HTMLInputElement>('[aria-label="Application manifest file"]')!; assert.match(input.accept, /\.agenticview\.json/);
    await view.choose(new view.dom.File([JSON.stringify(authored(false))], 'synthetic.agenticview.json', { type: 'application/json' }));
    assert.match(view.host.querySelector('[aria-label="Application preview"]')!.textContent!, /Synthetic console/); assert.equal(view.button('Import application').disabled, false); assert.equal(view.requests.length, 1);
    await view.choose({ size: 10, text: async () => { throw new Error('Unreadable file'); } }); assert.equal(view.button('Import application').disabled, true, 'a failed file read cannot accidentally import the previous preview'); assert.equal(view.requests.length, 1);
    await view.choose(new view.dom.File([JSON.stringify(authored(false))], 'synthetic.agenticview.json', { type: 'application/json' }));
    await view.click('Import application'); assert.deepEqual(view.requests[1]!.body!.bindings, {});
  } finally { await view.close(); }
});

test('application lists remain bounded and unauthorized/error text is safe', async () => {
  const view = await fixture(false); let unauthorized = 0;
  try {
    window.addEventListener('agenticview:unauthorized', () => unauthorized++);
    await view.respond(0, { error: '<script>untrusted error</script>' }, 401); assert.equal(unauthorized, 1); assert.equal(view.host.querySelector('script'), null); assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /untrusted error/);
    await view.click('Refresh applications'); await view.respond(1, Array.from({ length: 100 }, (_, index) => ({ runId: `run-${index}`, id: `app-${index}`, name: `Application ${index}`, version: '1', components: 0, actions: 0 })));
    assert.equal(view.host.querySelectorAll('.application-row').length, 25); await view.click('Next applications'); assert.equal(view.requests[2]!.path, '/api/applications?offset=25&limit=25');
    await view.respond(2, [{ runId: 'run-25', id: 'app-25', name: 'Application 25', version: '1', components: 0, actions: 0 }]); assert.match(view.host.querySelector('.application-row')!.textContent!, /Application 25/); assert.equal(view.host.querySelectorAll('.application-row').length, 1); assert.equal(view.button('Next applications').disabled, true); assert.equal(view.requests.length, 3, 'each explicit page request loads current summaries only');
  } finally { await view.close(); }
});

test('remote library pages accept large descriptions without accumulating or automatically scanning the library', async () => {
  const view = await fixture(false);
  const page = (offset: number) => Array.from({ length: 25 }, (_, index) => ({ runId: `run-${offset + index}`, id: `app-${offset + index}`, name: `Application ${offset + index}`, version: '1', description: 'é'.repeat(2000), components: 64, actions: 64 }));
  try {
    await view.respond(0, page(0)); assert.equal(view.host.querySelectorAll('.application-row').length, 25); assert.equal(view.requests.length, 1); assert.equal(view.button('Previous applications').disabled, true);
    await view.click('Next applications'); assert.equal(view.requests[1]!.path, '/api/applications?offset=25&limit=25'); assert.equal(view.button('Next applications').disabled, true, 'pending navigation cannot start overlapping page requests');
    await view.respond(1, page(25)); assert.equal(view.host.querySelectorAll('.application-row').length, 25); assert.match(view.host.querySelector('.application-row')!.textContent!, /Application 25/); assert.equal(view.host.textContent!.includes('Application 0'), false); assert.match(view.host.textContent!, /Page 2/); assert.equal(view.requests.length, 2, 'full pages never trigger an automatic next-page request');
    await view.click('Next applications'); assert.equal(view.requests[2]!.path, '/api/applications?offset=50&limit=25'); await view.respond(2, []); assert.match(view.host.textContent!, /No applications in this page/); assert.equal(view.button('Next applications').disabled, true); assert.equal(view.button('Previous applications').disabled, false);
    await view.click('Previous applications'); assert.equal(view.requests[3]!.path, '/api/applications?offset=25&limit=25'); await view.respond(3, page(25));
    await view.click('Refresh applications'); assert.equal(view.requests[4]!.path, '/api/applications'); await view.respond(4, page(0)); assert.match(view.host.textContent!, /Page 1/);
    await view.click('Next applications'); await view.respond(5, page(25));
    await view.input('Application manifest JSON', JSON.stringify(authored(false))); await view.click('Import application'); await view.respond(6, { runId: 'new-app' }); assert.equal(view.requests[7]!.path, '/api/applications', 'successful import refreshes the first remote page'); await view.respond(7, page(0)); assert.match(view.host.textContent!, /Page 1/); assert.equal(view.host.querySelectorAll('.application-row').length, 25);
  } finally { await view.close(); }
});

test('unmount aborts list and import requests and ignores late acknowledgements', async () => {
  const loading = await fixture(false);
  try { await loading.unmount(); assert.equal(loading.requests[0]!.signal.aborted, true); } finally { await loading.close(); }
  const view = await fixture(); let imported = 0;
  try {
    window.addEventListener('agenticview:applications-imported', () => imported++); await view.input('Application manifest JSON', JSON.stringify(authored(false))); await view.click('Import application'); await view.unmount(); assert.equal(view.requests[1]!.signal.aborted, true);
    await view.respond(1, { runId: 'late-run' }); assert.equal(imported, 0); assert.equal(view.reports.length, 0); assert.equal(view.requests.length, 2);
  } finally { await view.close(); }
});
