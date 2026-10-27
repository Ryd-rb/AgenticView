import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasKey, TouchViewport, zoomAt } from '../shared/viewport.js';
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
test('anchored wheel zoom preserves the world point at any small overview scale', () => {
  const camera = { x: 70, y: -90, zoom: .000001 }, anchor = { x: 400, y: 300 };
  const next = zoomAt(camera, .5, anchor);
  close((anchor.x - camera.x) / camera.zoom, (anchor.x - next.x) / next.zoom);
  close((anchor.y - camera.y) / camera.zoom, (anchor.y - next.y) / next.zoom);
  assert.ok(next.zoom < .000001);
});
test('pinch scales around the original world anchor while centroid movement pans', () => {
  const touches = new TouchViewport(), camera = { x: 20, y: 30, zoom: 1 };
  touches.start(1, { x: 100, y: 100 }, camera); touches.start(2, { x: 200, y: 100 }, camera);
  touches.move(1, { x: 100, y: 140 }); const next = touches.move(2, { x: 300, y: 140 })!;
  close(next.zoom, 2); close((200 - next.x) / next.zoom, 130); close((140 - next.y) / next.zoom, 70);
});
test('finger lift and cancellation rebase without jumps or stale drag state', () => {
  const touches = new TouchViewport(), camera = { x: 0, y: 0, zoom: 1 };
  touches.start(1, { x: 0, y: 0 }, camera); touches.start(2, { x: 100, y: 0 }, camera);
  const zoomed = touches.move(2, { x: 200, y: 0 })!;
  touches.end(2, zoomed); assert.equal(touches.count, 1); assert.equal(touches.move(1, { x: 20, y: 10 }), null);
  touches.start(3, { x: 220, y: 10 }, zoomed); assert.deepEqual(touches.move(3, { x: 220, y: 10 }), zoomed);
  touches.cancel(1, zoomed); touches.cancel(3, zoomed); assert.equal(touches.count, 0); assert.equal(touches.move(3, { x: 999, y: 999 }), null);
});
test('canvas shortcuts protect editable fields and interactive controls', () => {
  assert.equal(canvasKey('Home', false), 'fit'); assert.equal(canvasKey('f', false), 'fit'); assert.equal(canvasKey('+', false), 'in');
  for (const key of ['ArrowDown', '+', '0', 'Home', 'Escape']) { assert.equal(canvasKey(key, true), null); assert.equal(canvasKey(key, false, true), null); }
});
test('a third touch and replacement of a pinch finger preserve the current view', () => {
  const touches = new TouchViewport(), initial = { x: 10, y: -20, zoom: .5 };
  touches.start(1, { x: 10, y: 10 }, initial); touches.start(2, { x: 110, y: 10 }, initial);
  const current = touches.move(2, { x: 210, y: 10 })!;
  touches.start(3, { x: 300, y: 300 }, current);
  assert.deepEqual(touches.move(3, { x: 300, y: 300 }), current);
  touches.cancel(1, current);
  assert.deepEqual(touches.move(2, { x: 210, y: 10 }), current);
  touches.clear(); assert.equal(touches.count, 0);
});
