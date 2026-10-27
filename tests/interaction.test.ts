import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gestureOwner, contentPoint } from '../shared/interaction.ts';
import { TouchViewport } from '../shared/viewport.ts';
import { CardSurface } from '../web/CardSurface.tsx';

test('canvas owns inactive cards and global overrides always beat an active card', () => {
  assert.equal(gestureOwner(null, 'agent'), 'canvas'); assert.equal(gestureOwner('other', 'agent'), 'canvas');
  assert.equal(gestureOwner('agent', 'agent'), 'card');
  assert.equal(gestureOwner('agent', 'agent', true), 'canvas'); assert.equal(gestureOwner('agent', 'agent', false, true), 'canvas');
  assert.equal(gestureOwner('agent', null), 'canvas');
});
test('card coordinates account for outer canvas scale and pinch keeps independent bounds', () => {
  assert.deepEqual(contentPoint({ x: 150, y: 75 }, { left: 50, top: 25, width: 240 }, 480), { x: 200, y: 100 });
  const local = new TouchViewport(.25, 4), camera = { x: 0, y: 0, zoom: 1 };
  local.start(1, { x: 0, y: 0 }, camera); local.start(2, { x: 10, y: 0 }, camera);
  assert.equal(local.move(2, { x: 100, y: 0 })!.zoom, 4); local.clear();
  local.start(1, { x: 0, y: 0 }, camera); local.start(2, { x: 100, y: 0 }, camera);
  assert.equal(local.move(2, { x: 1, y: 0 })!.zoom, .25);
});
test('card activation exposes local controls without replacing main navigation', () => {
  const props = { id: 'agent', deactivate: () => {}, canvasOwnsPointer: () => false, forceCanvas: () => false, children: createElement('p', null, 'Evidence') };
  const inactive = renderToStaticMarkup(createElement(CardSurface, { ...props, active: false }));
  assert.match(inactive, /Click or tap to interact/); assert.doesNotMatch(inactive, /Active card navigation/); assert.match(inactive, /Evidence/); assert.match(inactive, /inert=""/);
  const active = renderToStaticMarkup(createElement(CardSurface, { ...props, active: true }));
  assert.match(active, /Active card navigation/); assert.match(active, /Zoom card in/); assert.match(active, /Deactivate card/); assert.doesNotMatch(active, /inert=""/);
});
