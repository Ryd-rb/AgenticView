import { z } from 'zod';

export type ShortcutModifier = 'Ctrl' | 'Alt' | 'Shift' | 'Meta';
export type ParsedShortcutChord = { chord: string; key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };
const modifiers: ShortcutModifier[] = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const modifierAliases: Record<string, ShortcutModifier> = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta' };
const keys = ['Enter', 'Escape', 'Space', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
function keyName(value: string): string | null {
  if (value === ' ') return 'Space';
  if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase();
  if (/^F(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
  return keys.find(key => key.toLowerCase() === value.toLowerCase()) ?? null;
}
/** Canonical, finite key grammar; no browser key strings are evaluated as code. */
export function parseShortcutChord(chord: string): ParsedShortcutChord | null {
  if (chord.length > 80) return null;
  const parts = chord.split('+').map(part => part.trim());
  if (parts.some(part => !part)) return null;
  const key = keyName(parts.at(-1)!); if (!key) return null;
  const selected = new Set<ShortcutModifier>();
  for (const token of parts.slice(0, -1)) { const modifier = Object.hasOwn(modifierAliases, token.toLowerCase()) ? modifierAliases[token.toLowerCase()] : undefined; if (!modifier || selected.has(modifier)) return null; selected.add(modifier); }
  // Reserve ordinary unmodified typing/navigation for the application and browser.
  if (!selected.has('Ctrl') && !selected.has('Alt') && !selected.has('Meta') && !/^F\d+$/.test(key)) return null;
  return { chord: [...modifiers.filter(modifier => selected.has(modifier)), key].join('+'), key, ctrlKey: selected.has('Ctrl'), altKey: selected.has('Alt'), shiftKey: selected.has('Shift'), metaKey: selected.has('Meta') };
}
export const normalizeShortcutChord = (chord: string): string | null => parseShortcutChord(chord)?.chord ?? null;
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), 'Reserved identifier');
export const cardShortcutSchema = z.strictObject({ id, label: z.string().min(1).max(160).transform(value => value.trim()).refine(value => value.length > 0, 'Shortcut label must not be empty'), cardId: id, chord: z.string().min(1).max(80).refine(value => normalizeShortcutChord(value) !== null, 'Use Ctrl, Alt, Shift or Meta with a supported key; F1–F12 may be unmodified').transform(value => normalizeShortcutChord(value)!), mode: z.enum(['focus', 'maximize']) });
export const cardShortcutsSchema = z.array(cardShortcutSchema).max(32).superRefine((shortcuts, context) => {
  if (new Set(shortcuts.map(shortcut => shortcut.id)).size !== shortcuts.length) context.addIssue({ code: 'custom', message: 'Shortcut IDs must be unique' });
  if (new Set(shortcuts.map(shortcut => shortcut.chord)).size !== shortcuts.length) context.addIssue({ code: 'custom', message: 'Shortcut chords must be unique' });
});
export type CardShortcut = z.infer<typeof cardShortcutSchema>;
export type ShortcutKeyEvent = { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; repeat?: boolean; defaultPrevented?: boolean; isComposing?: boolean; target?: EventTarget | null; getModifierState?: (key: string) => boolean };
/** Structural detection also works across documents and in non-browser consumers. */
export function isShortcutTypingTarget(target?: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  let node = target as { nodeType?: number; parentElement?: unknown; closest?: (selector: string) => unknown; isContentEditable?: boolean };
  if (node.nodeType === 3 && node.parentElement) node = node.parentElement as typeof node;
  return node.isContentEditable === true || typeof node.closest === 'function' && !!node.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
}
/** Host owns preventDefault and live-card lookup after a match is accepted. */
export function matchCardShortcut(shortcuts: readonly CardShortcut[], event: ShortcutKeyEvent, target: unknown = event.target): CardShortcut | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.key === 'Dead' || event.key === 'Process' || event.getModifierState?.('AltGraph')) return undefined;
  if (isShortcutTypingTarget(target) && !event.ctrlKey && !event.altKey && !event.metaKey) return undefined;
  const key = keyName(event.key) ?? (/^(?:Key[A-Z]|Digit[0-9])$/.test(event.code ?? '') ? event.code!.replace(/^(Key|Digit)/, '') : null);
  if (!key) return undefined;
  return shortcuts.slice(0, 32).find(shortcut => { const parsed = parseShortcutChord(shortcut.chord); return parsed && parsed.key === key && parsed.ctrlKey === event.ctrlKey && parsed.altKey === event.altKey && parsed.shiftKey === event.shiftKey && parsed.metaKey === event.metaKey; });
}
