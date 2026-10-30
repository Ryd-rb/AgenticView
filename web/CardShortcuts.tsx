import { useState } from 'react';
import { cardShortcutsSchema, normalizeShortcutChord, type CardShortcut } from '../shared/card-shortcuts.js';

export type ShortcutCard = { id: string; label: string };
export type CardShortcutBarProps = { shortcuts: readonly CardShortcut[]; cards: readonly ShortcutCard[]; onActivate: (shortcut: CardShortcut) => void };

/** The host activates, focuses or maximizes; this strip never changes camera state itself. */
export function CardShortcutBar({ shortcuts, cards, onActivate }: CardShortcutBarProps) {
  if (!shortcuts.length) return null;
  const live = new Map(cards.map(card => [card.id, card]));
  return <nav className="card-shortcut-bar" aria-label="Card shortcuts">{shortcuts.slice(0, 32).map(shortcut => {
    const card = live.get(shortcut.cardId), title = `${shortcut.label} · ${shortcut.chord} · ${shortcut.mode === 'maximize' ? 'Maximize' : 'Focus'}${card ? ' ' + card.label : ' · Card unavailable'}`;
    return <button type="button" key={shortcut.id} disabled={!card} title={title} onClick={() => { if (live.has(shortcut.cardId)) onActivate(shortcut); }}><span>{shortcut.label}</span><kbd>{shortcut.chord}</kbd>{!card && <small>Unavailable</small>}</button>;
  })}</nav>;
}

export type CardShortcutEditorProps = { shortcuts: readonly CardShortcut[]; cards: readonly ShortcutCard[]; onSave: (shortcuts: CardShortcut[]) => Promise<void> | void; disabled?: boolean };
function nextChord(shortcuts: readonly CardShortcut[]) {
  const used = new Set(shortcuts.map(shortcut => normalizeShortcutChord(shortcut.chord)));
  return [...Array.from({ length: 9 }, (_, i) => `Alt+${i + 1}`), ...Array.from({ length: 26 }, (_, i) => `Ctrl+Alt+${String.fromCharCode(65 + i)}`)].find(chord => !used.has(chord)) ?? 'Ctrl+Alt+F12';
}

export function CardShortcutEditor({ shortcuts, cards, onSave, disabled = false }: CardShortcutEditorProps) {
  const [draft, setDraft] = useState<CardShortcut[] | null>(null), [baseline, setBaseline] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const signature = JSON.stringify(shortcuts), values = draft ?? [...shortcuts], conflict = draft !== null && baseline !== signature, locked = disabled || busy;
  const change = (update: (current: CardShortcut[]) => CardShortcut[]) => {
    if (locked) return;
    if (draft === null) setBaseline(signature);
    setDraft(update(values)); setSaved(false); setError('');
  };
  const update = (index: number, patch: Partial<CardShortcut>) => change(current => current.map((shortcut, i) => i === index ? { ...shortcut, ...patch } : shortcut));
  const reset = () => { setDraft(null); setBaseline(signature); setError(''); setSaved(false); };
  const save = async () => {
    if (locked || draft === null || conflict) return;
    const parsed = cardShortcutsSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).slice(0, 4).join('; ')); return; }
    setBusy(true); setError(''); setSaved(false);
    try { await onSave(parsed.data); setDraft(null); setSaved(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Shortcuts could not be saved'); }
    finally { setBusy(false); }
  };
  const add = () => {
    if (!cards.length || values.length >= 32) return;
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    change(current => [...current, { id: `shortcut-${random}`, label: cards[0].label.slice(0, 160) || 'Card', cardId: cards[0].id, chord: nextChord(current), mode: 'maximize' }]);
  };
  return <section className="card-shortcut-editor" aria-label="Configure card shortcuts"><h3>Card shortcuts</h3><p>Choose a card, a key chord and whether to focus or maximize it. Focus selects the card before framing it. Escape restores a maximized view.</p>
    {values.length > 0 ? <ol>{values.slice(0, 32).map((shortcut, index) => <li key={shortcut.id}><fieldset disabled={locked}><legend>Shortcut {index + 1}</legend>
      <label>Label<input aria-label={`Shortcut ${index + 1} label`} maxLength={160} value={shortcut.label} onChange={event => update(index, { label: event.target.value })} /></label>
      <label>Card<select aria-label={`Shortcut ${index + 1} card`} value={shortcut.cardId} onChange={event => update(index, { cardId: event.target.value })}>{!cards.some(card => card.id === shortcut.cardId) && <option value={shortcut.cardId}>Unavailable card ({shortcut.cardId})</option>}{cards.map(card => <option key={card.id} value={card.id}>{card.label}</option>)}</select></label>
      <label>Key chord<input aria-label={`Shortcut ${index + 1} chord`} placeholder="Alt+1" maxLength={80} autoComplete="off" spellCheck={false} value={shortcut.chord} onChange={event => update(index, { chord: event.target.value })} /></label>
      <label>Open as<select aria-label={`Shortcut ${index + 1} mode`} value={shortcut.mode} onChange={event => update(index, { mode: event.target.value as CardShortcut['mode'] })}><option value="focus">Focused card</option><option value="maximize">Maximized app view</option></select></label>
      <button type="button" className="shortcut-remove" aria-label={`Remove shortcut ${index + 1}`} onClick={() => change(current => current.filter((_, i) => i !== index))}>Remove</button>
    </fieldset></li>)}</ol> : <p className="native-note">No shortcuts configured.</p>}
    <p className="shortcut-key-help">Use Ctrl, Alt, Shift or Meta with a letter, number or navigation key. F1–F12 may be used alone. Some system or browser chords may be reserved.</p>
    {!cards.length && <p role="status">No live cards are available to add. Saved shortcuts remain available for editing.</p>}
    {conflict && <p role="alert">Shortcuts changed elsewhere. Reload saved shortcuts before editing further.</p>}
    {error && <p role="alert">{error}</p>}{saved && <p role="status">Shortcuts saved.</p>}
    <div className="shortcut-editor-actions"><button type="button" disabled={locked || !cards.length || values.length >= 32 || conflict} onClick={add}>Add shortcut</button><button type="button" disabled={locked || draft === null || conflict} onClick={() => void save()}>{busy ? 'Saving…' : 'Save shortcuts'}</button>{draft !== null && <button type="button" disabled={locked} onClick={reset}>{conflict ? 'Reload saved shortcuts' : 'Discard changes'}</button>}<span>{values.length} / 32</span></div>
  </section>;
}
