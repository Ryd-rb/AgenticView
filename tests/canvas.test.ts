import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFreePosition, isVisible, moveWithoutOverlap, overlaps, resizeWithoutOverlap } from '../shared/canvas.js';
const card = { x: 0, y: 0, width: 480, height: 420 };
test('stable free placement and exact gap boundaries', () => {
  assert.deepEqual(findFreePosition(card, []), card);
  assert.equal(overlaps(card, { ...card, x: 496 }), false);
  assert.equal(overlaps(card, { ...card, x: 495 }), true);
});
test('drag respects a fixed obstacle without moving it', () => {
  const locked = Object.freeze({ ...card, x: 600 });
  const moved = moveWithoutOverlap(card, { x: 620, y: 30 }, [locked]);
  assert.equal(overlaps(moved, locked), false);
  assert.equal(locked.x, 600);
});
test('dense placement remains deterministic and does not overlap', () => {
  const obstacles = Array.from({ length: 120 }, (_, i) => ({ ...card, x: (i % 12) * 496, y: Math.floor(i / 12) * 436 }));
  const result = findFreePosition(card, obstacles);
  assert.ok(obstacles.every(o => !overlaps(result, o)));
  assert.deepEqual(findFreePosition(card, obstacles), result);
});
test('visibility and invalid geometry have meaningful contracts', () => {
  assert.equal(isVisible(card, { x: 500, y: 0, width: 100, height: 100 }), false);
  assert.equal(isVisible(card, { x: 450, y: 0, width: 100, height: 100 }), true);
  assert.throws(() => findFreePosition({ ...card, x: NaN }, []), RangeError);
});
test('bounded candidate search uses a safe fallback beyond all obstacles', () => {
  const obstacles = [...Array.from({ length: 48 }, () => ({ ...card })), { x: -10000, y: -10000, width: 20000, height: 20000 }];
  const result = findFreePosition(card, obstacles);
  assert.equal(result.x, 10016);
  assert.ok(obstacles.every(o => !overlaps(result, o)));
});
test('fixed-origin resizing stops before a locked obstacle and preserves position', () => {
  const obstacle = Object.freeze({ x: 600, y: 0, width: 480, height: 420 });
  const result = resizeWithoutOverlap(card, { width: 900, height: 700 }, [obstacle]);
  assert.equal(result.x, card.x); assert.equal(result.y, card.y);
  assert.ok(result.width > card.width && result.width <= 584);
  assert.equal(overlaps(result, obstacle), false);
  assert.equal(obstacle.x, 600);
});
test('content height can grow safely, cap at an obstacle, then shrink freely', () => {
  const below = { x: 0, y: 600, width: 480, height: 300 };
  const grown = resizeWithoutOverlap(card, { width: 480, height: 900 }, [below]);
  assert.ok(grown.height > 583 && grown.height <= 584);
  assert.equal(overlaps(grown, below), false);
  assert.equal(resizeWithoutOverlap(grown, { width: 480, height: 240 }, [below]).height, 240);
});
