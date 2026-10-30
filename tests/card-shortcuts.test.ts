import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardShortcutSchema, cardShortcutsSchema, normalizeShortcutChord, parseShortcutChord, matchCardShortcut, type CardShortcut, type ShortcutKeyEvent } from '../shared/card-shortcuts.ts';
import { CardShortcutBar, CardShortcutEditor } from '../web/CardShortcuts.tsx';

const shortcut = (patch: Partial<CardShortcut> = {}): CardShortcut => ({ id: 'workbench', label: 'Workbench', cardId: 'card', chord: 'Alt+1', mode: 'maximize', ...patch });
const key = (patch: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({ key: '1', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, ...patch });

test('shortcut grammar normalizes modifier aliases and rejects ambiguous or unbounded chords', () => {
  assert.equal(normalizeShortcutChord(' shift + control + k '), 'Ctrl+Shift+K');
  assert.equal(normalizeShortcutChord('option+command+PageDown'), 'Alt+Meta+PageDown');
  assert.equal(normalizeShortcutChord('f12'), 'F12'); assert.equal(normalizeShortcutChord('Shift+F1'), 'Shift+F1');
  assert.deepEqual(parseShortcutChord('Ctrl+Alt+Shift+Meta+Space'), { chord: 'Ctrl+Alt+Shift+Meta+Space', key: 'Space', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true });
  for (const chord of ['', 'Ctrl+', 'Ctrl++K', 'Ctrl+Control+K', 'K+Ctrl', 'Ctrl+Shift', 'Ctrl+F13', 'A', 'Shift+A', 'Escape', 'Ctrl+<script>', 'Ctrl+KeyA', 'a'.repeat(81)]) assert.equal(parseShortcutChord(chord), null, chord);
});

test('shortcut settings validate strict fields, unique canonical chords and stable identities', () => {
  assert.equal(cardShortcutSchema.parse(shortcut({ label: ' Workbench ', chord: 'alt+1' })).label, 'Workbench');
  assert.deepEqual(cardShortcutsSchema.parse([]), []);
  for (const invalid of [shortcut({ label: '   ' }), shortcut({ id: '__proto__' }), shortcut({ cardId: '../card' }), { ...shortcut(), script: 'unexpected' }, { ...shortcut(), mode: 'execute' }]) assert.equal(cardShortcutSchema.safeParse(invalid).success, false);
  assert.equal(cardShortcutsSchema.safeParse([shortcut(), shortcut({ id: 'other', chord: 'Option+1' })]).success, false);
  assert.equal(cardShortcutsSchema.safeParse([shortcut(), shortcut({ chord: 'Alt+2' })]).success, false);
  const tooMany = Array.from({ length: 33 }, (_, i) => shortcut({ id: 'shortcut-' + i, chord: `Ctrl+Alt+${String.fromCharCode(65 + i % 26)}` }));
  assert.equal(cardShortcutsSchema.safeParse(tooMany).success, false);
});

test('matching requires exact modifiers and leaves composition, repeat and handled events alone', () => {
  const items = [shortcut(), shortcut({ id: 'command', chord: 'Ctrl+Shift+K' })];
  assert.equal(matchCardShortcut(items, key())?.id, 'workbench');
  assert.equal(matchCardShortcut(items, key({ key: 'K', altKey: false, ctrlKey: true, shiftKey: true }))?.id, 'command');
  for (const patch of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { key: 'Dead' }, { key: 'Process' }, { getModifierState: () => true }]) assert.equal(matchCardShortcut(items, key(patch)), undefined);
  const digit = shortcut({ chord: 'Ctrl+Shift+1' });
  assert.equal(matchCardShortcut([digit], key({ key: '!', code: 'Digit1', altKey: false, ctrlKey: true, shiftKey: true })), digit);
});

test('typing targets retain function keys while explicit command chords may activate', () => {
  const field = { closest: () => ({}) }, items = [shortcut({ chord: 'F2' }), shortcut({ id: 'command', chord: 'Ctrl+K' })];
  assert.equal(matchCardShortcut(items, key({ key: 'F2', altKey: false }), field), undefined);
  assert.equal(matchCardShortcut(items, key({ key: 'F2', altKey: false }))?.id, 'workbench');
  assert.equal(matchCardShortcut(items, key({ key: 'k', altKey: false, ctrlKey: true }), field)?.id, 'command');
  assert.equal(matchCardShortcut(items, key({ key: 'F2', altKey: false }), { isContentEditable: true }), undefined);
});

test('shortcut strip renders native bounded controls and escapes producer text', () => {
  const html = renderToStaticMarkup(createElement(CardShortcutBar, { shortcuts: [shortcut({ label: '<script>literal</script>' }), shortcut({ id: 'gone', cardId: 'missing', chord: 'Alt+2' })], cards: [{ id: 'card', label: 'Synthetic card' }], onActivate() {} }));
  assert.match(html, /aria-label="Card shortcuts"/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<iframe/);
  assert.match(html, /disabled=""/); assert.match(html, /Unavailable/); assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.equal(renderToStaticMarkup(createElement(CardShortcutBar, { shortcuts: [], cards: [], onActivate() {} })), '');
});

test('manual editor saves typed shortcuts, preserves unavailable targets and handles validation/concurrent edits', async () => {
  const { Window } = await import('happy-dom'), dom = new Window();
  for (const property of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'HTMLInputElement', 'HTMLSelectElement'] as const) Object.defineProperty(globalThis, property, { configurable: true, value: property === 'window' ? dom : dom[property] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { act } = await import('react'), { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let items: CardShortcut[] = [], saves = 0, reject = false;
  const activated: CardShortcut[] = [];
  const cards = [{ id: 'card', label: 'Synthetic card' }], settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const editor = (disabled = false) => createElement(CardShortcutEditor, { shortcuts: items, cards, disabled, onSave: async (next: CardShortcut[]) => { saves++; if (reject) throw new Error('Settings changed; reload'); items = next; root.render(editor()); } });
  const render = async (disabled = false) => act(async () => { root.render(editor(disabled)); await settle(); });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  const click = async (label: string) => act(async () => { button(label).click(); await settle(); });
  const input = async (label: string, value: string) => act(async () => {
    const element = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(element.tagName === 'SELECT' ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await settle();
  });
  try {
    await render(true); assert.equal(button('Add shortcut').disabled, true);
    await render(); await click('Add shortcut'); await input('Shortcut 1 label', 'Investigate'); await input('Shortcut 1 chord', 'control+shift+k'); await input('Shortcut 1 mode', 'focus'); await click('Save shortcuts');
    assert.equal(saves, 1); assert.equal(items[0].label, 'Investigate'); assert.equal(items[0].chord, 'Ctrl+Shift+K'); assert.equal(items[0].mode, 'focus'); assert.match(host.textContent!, /Shortcuts saved/);
    await click('Add shortcut'); await input('Shortcut 2 chord', 'Ctrl+Shift+K'); await click('Save shortcuts'); assert.equal(saves, 1); assert.match(host.querySelector('[role=alert]')!.textContent!, /unique/);
    await input('Shortcut 2 chord', 'Alt+2'); reject = true; await click('Save shortcuts'); assert.equal(saves, 2); assert.match(host.querySelector('[role=alert]')!.textContent!, /Settings changed/); assert.equal(host.querySelectorAll('fieldset').length, 2);
    items = [shortcut({ cardId: 'missing' })]; await render(); assert.match(host.querySelector('[role=alert]')!.textContent!, /changed elsewhere/); assert.equal(button('Save shortcuts').disabled, true);
    await click('Reload saved shortcuts'); assert.equal(host.querySelectorAll('fieldset').length, 1); assert.match(host.querySelector('option')!.textContent!, /Unavailable card/);
    await act(() => root.render(createElement(CardShortcutBar, { shortcuts: items, cards, onActivate: item => { activated.push(item); } })));
    host.querySelector('button')!.click(); assert.equal(activated.length, 0);
    items = [shortcut()]; await act(() => root.render(createElement(CardShortcutBar, { shortcuts: items, cards, onActivate: item => { activated.push(item); } })));
    host.querySelector('button')!.click(); assert.equal(activated[0]?.id, 'workbench');
  } finally { await act(() => root.unmount()); await dom.happyDOM.close(); }
});
