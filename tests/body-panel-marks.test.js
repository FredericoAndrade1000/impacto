import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { sampleScene } from '../src/scene-frame.ts';

const polygon = [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }];
const impact = (tag, more = {}) => ({ tag, kind: 'hole', u: .5, v: .5, radius: .04, strength: 1, ...more });
const plate = (id, x, y, marks) => ({ id, actorId: 'local', marks,
  definition: { id, x, y, angle: 0, length: 4, thicknessMm: 100 } });
function stateOf(plates) {
  return { actors: [{ id: 'local', vehicle: { x: 0, y: 0, angle: 0 } }], plates, modules: [],
    bodyPanels: [{ id: 'hull', actorId: 'local', pose: { x: 0, y: 0, angle: 0 }, localPolygon: polygon }] };
}
const marksOf = state => bodyPanelSurfaces(state)[0].marks;
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('only marked plates need a sampled pose when projecting hull damage', () => {
  const state = stateOf([plate('empty', 0, 1, []), plate('absent', 0, 1), plate('marked', 0, 1, [impact('hit')])]),
    scene = sampleScene(state), asked = [], source = JSON.stringify(state),
    shown = bodyPanelSurfaces(state, null, null, 1, { ...scene, pose: id => { asked.push(id); return scene.pose(id); } });
  assert.deepEqual(asked, ['marked']); assert.deepEqual(shown[0].marks.map(mark => mark.tag), ['hit']);
  assert.equal(JSON.stringify(state), source);
});

test('hull marks include both sides and the exact quarter-metre boundary of every edge', () => {
  const state = stateOf([
    plate('on-top', 0, 1, [impact('on')]),
    plate('inside', 0, .8, [impact('inside')]),
    plate('inside-boundary', 0, .75, [impact('inside-boundary')]),
    plate('inside-far', 0, .75 - 1e-8, [impact('inside-far')]),
    plate('outside', 0, 1.2, [impact('outside')]),
    plate('outside-boundary', 0, 1.25, [impact('outside-boundary')]),
    plate('outside-far', 0, 1.25 + 1e-8, [impact('outside-far')]),
    plate('right', 2.2, 0, [impact('right')]),
    plate('bottom', 0, -1.2, [impact('bottom')]),
    plate('left', -2.2, 0, [impact('left')]),
    plate('corner-far', 2.2, 1.2, [impact('corner-far')]),
    plate('centre', 0, 0, [impact('centre')]),
  ]), source = JSON.stringify(state), shown = marksOf(state);
  assert.deepEqual(shown.map(mark => mark.tag), ['on', 'inside', 'inside-boundary', 'outside', 'outside-boundary', 'right', 'bottom', 'left']);
  for (const mark of shown) { assert.equal(mark.radius, .04); assert.equal(mark.angle, 0); }
  near(shown[0].x, 0); near(shown[0].y, 1 - .04 * .65);
  near(shown.find(mark => mark.tag === 'right').x, 2.2 - .04 * .65);
  near(shown.find(mark => mark.tag === 'bottom').y, -1.2 + .04 * .65);
  assert.equal(JSON.stringify(state), source);
});

test('the last sixteen marks keep their source order without altering measured footprints', () => {
  const records = Array.from({ length: 20 }, (_, i) => impact(i, { u: .1 + i * .04, radius: .01 + i * .001 })),
    state = stateOf([plate('top', 0, 1, records)]), source = JSON.stringify(state), shown = marksOf(state);
  assert.deepEqual(shown.map(mark => mark.tag), Array.from({ length: 16 }, (_, i) => i + 4));
  assert.deepEqual(shown.map(mark => mark.radius), records.slice(4).map(mark => mark.radius));
  assert.equal(JSON.stringify(state), source);
});

test('duplicate material coordinates retain the first slot, largest footprint and latest equal footprint', () => {
  const records = [impact('small', { u: .2, radius: .02 }), impact('dent', { kind: 'dent', u: .3, radius: .03 }),
    impact('large', { u: .2, radius: .08 }), impact('smaller-later', { u: .2, radius: .04 }),
    impact('other', { u: .4, radius: .05 }), impact('equal-later', { u: .2, radius: .08 })],
    state = stateOf([plate('top', 0, 1, records)]), source = JSON.stringify(state), shown = marksOf(state);
  assert.deepEqual(shown.map(mark => mark.tag), ['equal-later', 'dent', 'other']);
  assert.deepEqual(shown.map(mark => mark.radius), [.08, .03, .05]);
  const length = Math.hypot(1.2, 1), inward = .08 * .65;
  near(shown[0].x, -1.2 + 1.2 / length * inward); near(shown[0].y, 1 - inward / length);
  assert.equal(JSON.stringify(state), source);
});
