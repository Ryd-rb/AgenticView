import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeScrollDelta } from '../shared/interaction.ts';
import { revealScrollDelta, ScrollJourney } from '../shared/scroll-journey.ts';

test('direction reversal unwinds outer movement before returning to an inner scroll', () => {
  let leaf = 100, parent = 50, world = 0;
  const journey = new ScrollJourney([
    (x, y) => { const next = Math.max(0, Math.min(100, leaf + y)), used = next - leaf; leaf = next; return { x, y: y - used }; },
    (x, y) => { const next = Math.max(0, Math.min(100, parent + y)), used = next - parent; parent = next; return { x, y: y - used }; },
    (x, y) => { world += y; return { x, y: 0 }; }
  ]);
  journey.move(0, 80); assert.deepEqual([leaf, parent, world], [100, 100, 30]);
  journey.move(0, -20); assert.deepEqual([leaf, parent, world], [100, 100, 10]);
  journey.move(0, -40); assert.deepEqual([leaf, parent, world], [100, 70, 0]);
  journey.move(0, -30); assert.deepEqual([leaf, parent, world], [90, 50, 0]);
});

test('visibility recovery is directional, bounded, and independent on each axis', () => {
  const parent = { left: 0, top: 0, width: 300, height: 200 };
  assert.deepEqual(revealScrollDelta({ left: -40, top: -60, width: 100, height: 100 }, parent, -100, -100, .5), { x: -80, y: -100 });
  assert.deepEqual(revealScrollDelta({ left: 250, top: 160, width: 100, height: 100 }, parent, 80, 200, 1), { x: 50, y: 60 });
  assert.deepEqual(revealScrollDelta({ left: 10, top: 10, width: 100, height: 100 }, parent, 50, -50, 1), { x: 0, y: -0 });
});

function nestedFixture(reverse = false) {
  const leaf = { left: reverse ? 0 : 100, top: reverse ? 0 : 100 }, parent = { left: reverse ? 0 : 100, top: reverse ? 0 : 100 };
  const card = { left: reverse ? 0 : 200, top: reverse ? 0 : 200 }, world = { left: reverse ? -300 : 300, top: reverse ? -300 : 300 };
  const scroll = (state: typeof leaf, max: number) => (x: number, y: number) => { const next = consumeScrollDelta({ ...state, maxLeft: max, maxTop: max }, x, y); state.left = next.left; state.top = next.top; return { x: next.remainingX, y: next.remainingY }; };
  const bodyBounds = () => ({ left: 50 - world.left, top: 50 - world.top, width: 200, height: 200 });
  const parentBounds = () => { const body = bodyBounds(), base = reverse ? 300 : 20; return { left: body.left + base - card.left, top: body.top + base - card.top, width: 100, height: 100 }; };
  const childBounds = () => { const bounds = parentBounds(), base = reverse ? 150 : 10; return { left: bounds.left + base - parent.left, top: bounds.top + base - parent.top, width: 60, height: 60 }; };
  const journey = new ScrollJourney([scroll(leaf, 100), scroll(parent, 200), scroll(card, 400), (x, y) => { world.left += x; world.top += y; return { x: 0, y: 0 }; }], [undefined,
    (x, y) => revealScrollDelta(childBounds(), parentBounds(), x, y, 1),
    (x, y) => revealScrollDelta(parentBounds(), bodyBounds(), x, y, 1),
    (x, y) => revealScrollDelta(bodyBounds(), { left: 0, top: 0, width: 300, height: 300 }, x, y, 1)
  ]);
  return { journey, leaf, parent, card, world };
}
test('multiple hidden layers recover outside-in until children fit, then the leaf scrolls', () => {
  const f = nestedFixture();
  f.journey.move(-200, -200); assert.deepEqual([f.world.left, f.card.left, f.parent.left, f.leaf.left], [100, 200, 100, 100]);
  f.journey.move(-100, -100); assert.deepEqual([f.world.left, f.card.left, f.parent.left, f.leaf.left], [50, 150, 100, 100]);
  f.journey.move(-300, -300); assert.deepEqual([f.world.left, f.card.left, f.parent.left, f.leaf.left], [50, 20, 10, 20]);
  assert.deepEqual([f.world.top, f.card.top, f.parent.top, f.leaf.top], [50, 20, 10, 20]);
});
test('right and bottom clipping recover before the child receives forward scrolling', () => {
  const f = nestedFixture(true);
  f.journey.move(610, 610); assert.deepEqual([f.world.left, f.card.left, f.parent.left, f.leaf.left], [-50, 200, 110, 50]);
  assert.deepEqual([f.world.top, f.card.top, f.parent.top, f.leaf.top], [-50, 200, 110, 50]);
});
