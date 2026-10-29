import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { Login } from '../web/Login.tsx';

type SignInInput = { token: string; remember: boolean };
type Pending = { input: SignInInput; resolve: (value: unknown) => void; reject: (error: Error) => void };
async function fixture() {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const requests: Pending[] = [];
  let completions = 0, storageWrites = 0;
  dom.localStorage.setItem = () => { storageWrites++; };
  dom.sessionStorage.setItem = () => { storageWrites++; };
  const signIn = (input: SignInInput) => new Promise<unknown>((resolve, reject) => { requests.push({ input, resolve, reject }); });
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host), settle = () => new Promise<void>(resolve => setImmediate(resolve));
  await act(() => root.render(createElement(Login, { signIn, complete: () => { completions++; } })));
  const password = () => { const field = host.querySelector<HTMLInputElement>('input[type="password"]'); assert.ok(field); return field; };
  const remember = () => { const field = host.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(field); return field; };
  const button = () => { const target = host.querySelector<HTMLButtonElement>('button'); assert.ok(target); return target; };
  const input = async (value: string) => act(async () => {
    const field = password();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  });
  const submit = async () => act(async () => {
    const form = host.querySelector('form'); assert.ok(form);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  });
  const resolve = async (index: number) => act(async () => { requests[index]!.resolve({ authenticated: true }); await settle(); });
  const reject = async (index: number, message: string) => act(async () => { requests[index]!.reject(new Error(message)); await settle(); });
  return { dom, host, requests, password, remember, button, input, submit, resolve, reject, completions: () => completions, storageWrites: () => storageWrites, close: async () => { await act(() => root.unmount()); await dom.happyDOM.close(); } };
}

test('login defaults to keeping the device signed in and clears the masked token after one successful submission', async () => {
  const view = await fixture();
  try {
    assert.equal(view.remember().checked, true);
    const label = [...view.host.querySelectorAll('label')].find(label => label.textContent?.trim() === 'Keep me signed in on this device');
    assert.ok(label, 'the persistence option has a visible label');
    assert.ok(label.contains(view.remember()) || label.htmlFor === view.remember().id, 'the label is associated with its checkbox');
    await view.input('synthetic-viewer-token');
    assert.equal(view.password().type, 'password');
    assert.equal(view.host.textContent!.includes('synthetic-viewer-token'), false);
    await view.submit();
    assert.deepEqual(view.requests.map(request => request.input), [{ token: 'synthetic-viewer-token', remember: true }]);
    assert.equal(view.button().disabled, true);
    assert.equal(view.completions(), 0);
    await view.submit();
    assert.equal(view.requests.length, 1, 'pending login cannot submit twice');
    await view.resolve(0);
    assert.equal(view.password().value, '');
    assert.equal(view.completions(), 1);
    assert.equal(view.storageWrites(), 0, 'the raw token is never saved in browser storage');
  } finally { await view.close(); }
});

test('the device can opt out of persistent login', async () => {
  const view = await fixture();
  try {
    await act(() => view.remember().click());
    assert.equal(view.remember().checked, false);
    await view.input('synthetic-session-only-token');
    await view.submit();
    assert.deepEqual(view.requests[0]!.input, { token: 'synthetic-session-only-token', remember: false });
    await view.resolve(0);
    assert.equal(view.password().value, '');
    assert.equal(view.completions(), 1);
    assert.equal(view.storageWrites(), 0);
  } finally { await view.close(); }
});

test('a failed login reports the error and permits an explicit retry with the chosen persistence mode', async () => {
  const view = await fixture();
  try {
    await view.input('synthetic-rejected-token');
    await view.submit();
    await view.reject(0, 'Synthetic sign-in rejected');
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? '', /Synthetic sign-in rejected/);
    assert.equal(view.button().disabled, false);
    assert.equal(view.completions(), 0);
    assert.equal(view.requests.length, 1, 'errors never automatically retry');
    await act(() => view.remember().click());
    await view.input('synthetic-replacement-token');
    await view.submit();
    assert.deepEqual(view.requests[1]!.input, { token: 'synthetic-replacement-token', remember: false });
    await view.resolve(1);
    assert.equal(view.password().value, '');
    assert.equal(view.completions(), 1);
    assert.equal(view.host.querySelector('[role="alert"]'), null);
    assert.equal(view.storageWrites(), 0);
  } finally { await view.close(); }
});
