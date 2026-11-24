import test from 'node:test';
import assert from 'node:assert/strict';
import { labelGroups } from '../src/faction-ui.ts';
import { hullArtwork } from '../src/hull-art.ts';
import { outlineEdges, within } from '../src/hull-details.ts';
import { Renderer } from '../src/render.ts';
import { chassisPlacement, chassisPoint, chassisLocal, suspensionRig } from '../src/chassis-art.ts';

const label = (id, x, more = {}) => ({ id, key: 'Farofa · |j2| · ausente', name: 'Caminhão de minério leve', x, y: 100, width: 180, ...more });

test('overlapping labels group spatially by owner/state, independent of long design names', () => {
  const groups = labelGroups([label('a', 400), label('c', 410), label('b', 395), label('far', 900)]);
  assert.deepEqual(groups, [{ ids: ['b', 'a', 'c'] }, { ids: ['far'] }]);
  assert.deepEqual(labelGroups([label('a', 400), label('b', 420, { name: 'Blindado' }), label('c', 430)]), [{ ids: ['a', 'b', 'c'] }]);
  // Labels that only touch are one too; with a gap between them, two.
  assert.equal(labelGroups([label('a', 400), label('b', 583)]).length, 1);
  assert.equal(labelGroups([label('a', 400), label('b', 600)]).length, 2);
  // Another owner's, one on another row of the screen, and one with more to say of itself stand by themselves.
  assert.equal(labelGroups([label('a', 400), label('b', 405, { key: 'Bia · |j3|' })]).length, 2);
  assert.equal(labelGroups([label('a', 400), label('b', 405, { y: 140 })]).length, 2);
  assert.equal(labelGroups([label('a', 400), label('b', 405, { alone: true })]).length, 2);
});

test('the edges of a hull point out of it, wound either way, along its steps too', () => {
  // A hull with a step down at its front, wound one way and the other.
  const stepped = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 2 }, { x: 0, y: 2 }];
  for (const outline of [stepped, stepped.slice().reverse()]) {
    const edges = outlineEdges(outline);
    assert.equal(edges.length, 6);
    for (const { a, b, normal } of edges) {
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      assert(!within({ x: middle.x + normal.x * .01, y: middle.y + normal.y * .01 }, outline), 'out of the hull');
      assert(within({ x: middle.x - normal.x * .01, y: middle.y - normal.y * .01 }, outline), 'into the hull');
    }
    // The top of the step faces up; the floor faces down.
    const facing = (y, from, to) => edges.find(e => e.a.y === y && e.b.y === y && Math.min(e.a.x, e.b.x) === from && Math.max(e.a.x, e.b.x) === to).normal.y;
    assert.equal(facing(1, 4, 6), 1); assert.equal(facing(0, 0, 6), -1);
  }
});

test('a wheel of a wheeled chassis hangs from its rail by its springs, where the wheel is now; from afar none is drawn', () => {
  const dimensions = { wheelDiameter: 1.1, deck: .9, depth: .25 }, ANGLE = .2, hull = { angle: ANGLE }, rig = suspensionRig('wheeled', dimensions),
    // The plates of a straight chassis 5.2 m long: its frame, which tells its points, and the rail the wheel is on.
    plate = (part, size, more = {}) => ({ length: 5.2, thicknessMm: 8, chassis: { model: 'wheeled', kind: 'wheeled', part, segment: 0, ...size, ...more } }),
    frameOf = size => plate('frame', size, { length: 5.2, profile: [{ x: 0, y: 0 }, { x: 5.2, y: 0 }],
      outlines: [[{ x: 0, y: 0 }, { x: 5.2, y: 0 }, { x: 5.2, y: -size.depth }, { x: 0, y: -size.depth }]] });
  const drawn = (axle, zoom = 40, size = dimensions) => {
    const points = [], g = { poly(list) { for (let i = 0; i < list.length; i += 2) points.push({ x: list[i], y: list[i + 1] }); return g; },
        moveTo(x, y) { points.push({ x, y }); return g; }, lineTo(x, y) { points.push({ x, y }); return g; }, fill: () => g, stroke: () => g },
      definition = frameOf(size), pose = { x: 12, y: 2, angle: Math.PI + ANGLE, definition }, placement = chassisPlacement(pose, definition.chassis, ANGLE),
      parts = [{ id: 'chassis:frame-0', type: 'plate', data: { definition } }],
      frame = { get: (id, type) => id === 'chassis:rail-0' && type === 'plate' ? { definition: plate('rail', size) } : null, actorParts: new Map([['a', parts]]), actors: new Map() },
      renderer = { scene: { frame, pose: id => id === 'chassis:frame-0' ? pose : null }, camera: { zoom },
        actorLayer: () => g, paintOf: Renderer.prototype.paintOf, drawRig: Renderer.prototype.drawRig };
    Renderer.prototype.drawSuspension.call(renderer, { id: 'w', actorId: 'a', mountId: 'chassis:rail-0', height: size.wheelDiameter }, { ...chassisPoint(placement, axle.x, axle.y), angle: 0 }, hull);
    // In the frame of the chassis: along it from its front end, up from the top of its deck.
    return points.map(p => chassisLocal(placement, p));
  };
  for (const axle of [{ x: 1, y: rig.axle }, { x: 2.6, y: rig.axle - .12 }, { x: 4, y: rig.axle + .1 }]) {
    const local = drawn(axle);
    // The end of the axle where the wheel is; the leaves and the damper up to the rail, none above its top.
    assert(Math.min(...local.map(p => Math.hypot(p.x - axle.x, p.y - axle.y))) < rig.housing * .6, 'round the axle');
    assert(Math.max(...local.map(p => p.y)) > -rig.depth && Math.max(...local.map(p => p.y)) <= 0, 'up into the rail');
    // The eyes of the spring stay on their pins under the rail, wherever the wheel is.
    for (const side of [-1, 1]) assert(local.some(p => Math.hypot(p.x - (axle.x + side * rig.span), p.y - rig.eye) < rig.leaf * 1.5), 'an eye on its pin');
  }
  // A shallow rail over a smaller wheel uses a coil from the axle up to the tower of the rail.
  const shallow = { wheelDiameter: .95, deck: .8, depth: .16 },
    coilRig = suspensionRig('wheeled', shallow), coil = drawn({ x: 1, y: coilRig.axle }, 40, shallow);
  assert(Math.max(...coil.map(p => p.y)) > coilRig.top - .05 && Math.max(...coil.map(p => p.y)) <= 0);
  assert.equal(drawn({ x: 1, y: rig.axle }, 4).length, 0, 'from afar, behind the tyre, nothing');
});

test('a hull is painted for the side it is seen from: the same outline is two pictures', () => {
  const outline = [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: -2, y: 1 }];
  const inside = hullArtwork(outline, 0x68765a), outside = hullArtwork(outline, 0x68765a, 'outside');
  assert.deepEqual([inside.side, outside.side], ['inside', 'outside']);
  assert.notEqual(inside.key, outside.key);
  assert.deepEqual([outside.width, outside.height, outside.points], [inside.width, inside.height, inside.points]);
});
