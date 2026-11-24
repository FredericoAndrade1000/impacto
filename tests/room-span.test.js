import test from 'node:test';
import assert from 'node:assert/strict';
import { drawRoom, roomSpan } from '../src/frame-editing.ts';

const source = () => ({
  nodes: [{ id: 'a', x: -60, y: 0 }, { id: 'b', x: 60, y: 0 }, { id: 'c', x: 60, y: 32 }, { id: 'd', x: -60, y: 32 }],
  plates: [['floor', 'a', 'b'], ['rear', 'b', 'c'], ['roof', 'c', 'd'], ['front', 'd', 'a']]
    .map(([id, a, b]) => ({ id, a, b, material: 'steel', thicknessMm: 20 })),
  components: [{ id: 'camera', kind: 'sensor', pose: { x: 48, y: 36, angle: 0 } }],
});
const compiled = { frame: { origin: { x: 0, y: 0 } } },
  roof = { id: 'roof', aId: 'c', bId: 'd', a: { x: 3, y: 1.6 }, b: { x: -3, y: 1.6 },
    length: 6, normal: { x: 0, y: 1 }, material: 'steel', thicknessMm: 20 },
  middle = { x: 0, y: 1.6 };
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);
const onFace = (point, wall) => near((point.x - wall.a.x) * (wall.b.y - wall.a.y) - (point.y - wall.a.y) * (wall.b.x - wall.a.x), 0);

test('a partial bay inserts its own feet and preserves the support and equipment', () => {
  const before = source(), snapshot = structuredClone(before), support = roomSpan(roof, middle),
    drawn = drawRoom(before, compiled, support, middle, { x: 0, y: 2.5 });
  assert.deepEqual(before, snapshot);
  near(support.length, 1.8);
  assert.equal(drawn.source.nodes.length, 8);
  assert.equal(drawn.source.plates.length, 7);
  assert.deepEqual(drawn.source.plates.slice(0, 4), before.plates);
  assert.deepEqual(drawn.source.components, before.components);
  drawn.polygon.forEach((point, i) => near(point.x, [.9, .9, -.9, -.9][i]));
});

test('a bay near an end reuses that corner and never leaves a short leftover plate', () => {
  const support = roomSpan(roof, { x: 2.98, y: 1.6 }), drawn = drawRoom(source(), compiled, support, middle);
  assert.equal(support.aId, 'c'); assert.equal(support.bId, null);
  assert.equal(drawn.source.nodes.length, 7);
  assert.equal(drawn.source.plates.length, 7);
  assert.equal(drawn.source.nodes.filter(node => node.x === 60 && node.y === 32).length, 1);
});

test('a short support keeps its two existing corners and full span', () => {
  const short = { ...roof, length: 1.2, b: { x: 1.8, y: 1.6 } };
  assert.equal(roomSpan(short, short.a), short);
  const nearly = { ...roof, length: 1.85, b: { x: 1.15, y: 1.6 } };
  assert.equal(roomSpan(nearly, nearly.a), nearly, 'a five-centimetre remainder is absorbed into the bay');
});

test('an angled support is divided along the same line rather than snapping a foot away from it', () => {
  const wall = { ...roof, a: { x: 3, y: 2.1 }, b: { x: -3, y: 1.1 }, length: Math.hypot(6, 1) },
    clipped = roomSpan(wall, { x: 0, y: 1.6 });
  for (const point of [clipped.a, clipped.b]) onFace(point, wall);
  near(Math.hypot(clipped.b.x - clipped.a.x, clipped.b.y - clipped.a.y), 1.8);
});

test('an irrational-length 45-degree face can carry a partial room with exact feet and free depth', () => {
  const a = { x: -1.123456789123, y: .345678912345 }, b = { x: 1.234567891234, y: 2.703703592702 },
    wall = { ...roof, a, b, aId: null, bId: null, normal: { x: -1, y: 1 }, length: Math.hypot(b.x - a.x, b.y - a.y) },
    midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, support = roomSpan(wall, midpoint, 1.73123456789),
    from = midpoint, drawn = drawRoom(source(), compiled, support, from, { x: from.x, y: from.y + .743219876543 });
  near(support.length, 1.73123456789);
  near(drawn.depth, .743219876543);
  for (const point of [support.a, support.b]) onFace(point, wall);
  assert.deepEqual([drawn.polygon[0], drawn.polygon[3]], [support.a, support.b]);
  const feet = drawn.source.nodes.slice(-4, -2);
  for (let i = 0; i < feet.length; i++) {
    near(feet[i].x * .05, [support.a, support.b][i].x);
    near(feet[i].y * .05, [support.a, support.b][i].y);
    assert(!Number.isInteger(feet[i].x) || !Number.isInteger(feet[i].y));
  }
});

test('optional room snap steps length and offset along a sloped face while keeping feet on it', () => {
  const a = { x: -2.183456789, y: .812345679 }, b = { x: 2.297654321, y: 2.173456789 },
    wall = { ...roof, a, b, aId: null, bId: null, length: Math.hypot(b.x - a.x, b.y - a.y) },
    point = { x: .12345, y: 1.23456 }, support = roomSpan(wall, point, 1.73123456, { snap: true }),
    from = support.a, drawn = drawRoom(source(), compiled, support, from, { x: from.x, y: from.y + .743219 }, { snap: true });
  near(support.length, 1.75);
  near(Math.hypot(support.a.x - a.x, support.a.y - a.y) / .05,
    Math.round(Math.hypot(support.a.x - a.x, support.a.y - a.y) / .05));
  for (const foot of [support.a, support.b]) onFace(foot, wall);
  near(drawn.depth, .75);
  assert.deepEqual([drawn.polygon[0], drawn.polygon[3]], [support.a, support.b]);
});

test('downward free rooms use their exact support feet and stop at the construction floor', () => {
  const wall = { ...roof, a: { x: -1.1234567, y: -.3456789 }, b: { x: 1.2345678, y: -.3456789 },
    aId: null, bId: null, normal: { x: 0, y: -1 }, length: 2.3580245 },
    support = roomSpan(wall, { x: .12345, y: wall.a.y }, 1.713579),
    drawn = drawRoom(source(), compiled, support, support.a, { x: support.a.x, y: -4 });
  assert.deepEqual([drawn.polygon[0], drawn.polygon[3]], [support.a, support.b]);
  for (const point of drawn.polygon.slice(1, 3)) near(point.y, -1.3);
  assert.equal(drawn.source.plates.length, 7);
});

test('a room on a derived chassis floor creates the closing plate without moving or quantizing its feet', () => {
  const a = { x: -.743219876, y: .123456789 }, b = { x: .954321987, y: .123456789 },
    wall = { ...roof, bed: true, a, b, aId: null, bId: null, length: b.x - a.x },
    support = roomSpan(wall, a, 4), drawn = drawRoom(source(), compiled, support, a, { x: a.x, y: a.y + .713579 });
  assert.equal(drawn.source.plates.length, 8);
  assert.deepEqual([drawn.polygon[0], drawn.polygon[3]], [a, b]);
  const closing = drawn.source.plates.at(-1), feet = [closing.a, closing.b].map(id => drawn.source.nodes.find(node => node.id === id));
  near(feet[0].x * .05, b.x); near(feet[1].x * .05, a.x);
  for (const foot of feet) near(foot.y * .05, a.y);
});

test('the 20 cm room minimum remains usable when subtracting free coordinates loses a floating point bit', () => {
  const from = { x: 0, y: 1.6 }, support = roomSpan(roof, from),
    drawn = drawRoom(source(), compiled, support, from, { x: 0, y: 1.8 });
  assert(drawn.source);
  near(drawn.depth, .2);
  assert.deepEqual(drawRoom(source(), compiled, support, from, { x: 0, y: 1.799999 }), {});
});
