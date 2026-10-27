import type { Component } from './protocol.js';

/** Plans remain visible ahead of supporting evidence, independent of arrival order. */
export function isTaskList(component: Component): boolean {
  if (component.kind !== 'markdown' && component.kind !== 'tree') return false;
  const named = /(?:^|[\s_\-])(tasks?|tasklist|to[\s_\-]?do|plans?)(?:$|[\s_\-])/i.test(component.id + ' ' + component.title);
  return named || component.kind === 'markdown' && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/m.test(component.data.text);
}
