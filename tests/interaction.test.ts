import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gestureOwner, contentPoint, minimumContentZoom, clampContentCamera } from '../shared/interaction.ts';
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
test('card zoom-out stops at the content fit boundary', () => {
  const view = { width: 400, height: 300 }, content = { width: 800, height: 900 };
  assert.equal(minimumContentZoom(view, content), .5);
  assert.deepEqual(clampContentCamera({ x: 90, y: 80, zoom: .01 }, view, content), { x: 0, y: 0, zoom: .5 });
  assert.equal(clampContentCamera({ x: 0, y: 0, zoom: .25 }, view, { width: 400, height: 1000 }).zoom, 1);
});
test('card pan is constrained to native scroll ranges on every edge', () => {
  const view = { width: 400, height: 300 }, content = { width: 1000, height: 900 };
  assert.deepEqual(clampContentCamera({ x: 500, y: 500, zoom: 2 }, view, content), { x: 0, y: 0, zoom: 2 });
  assert.deepEqual(clampContentCamera({ x: -10000, y: -10000, zoom: 2 }, view, content), { x: -1600, y: -1500, zoom: 2 });
});
test('content shrinking removes obsolete scroll offsets and rejects invalid geometry', () => {
  assert.deepEqual(clampContentCamera({ x: -900, y: -700, zoom: 1 }, { width: 400, height: 300 }, { width: 400, height: 200 }), { x: 0, y: 0, zoom: 1 });
  assert.throws(() => minimumContentZoom({ width: 0, height: 300 }, { width: 400, height: 300 }), RangeError);
});
