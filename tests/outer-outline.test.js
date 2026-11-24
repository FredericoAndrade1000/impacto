import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render.ts';
import { outerFace } from '../src/hull-details.ts';

// A room 4 m long and 2 m high on a vehicle standing at (10, 5), tilted, and the plates of its skin, each in the world
// as the frame defines it: by its middle, its angle, its length and its thickness.
const vehicle = { x: 10, y: 5, angle: .3 }, c = Math.cos(vehicle.angle), s = Math.sin(vehicle.angle),
  world = (u, v) => ({ x: vehicle.x + c * u - s * v, y: vehicle.y + s * u + c * v }),
  room = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }],
  plate = (id, x0, y0, x1, y1, thicknessMm) => {
    const a = world(x0, y0), b = world(x1, y1);
    return { id, type: 'plate', data: { attached: true, definition: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x),
      length: Math.hypot(b.x - a.x, b.y - a.y), thicknessMm } } };
  },
  skin = floor => [plate('floor', 0, floor, 4, floor, 20), plate('rear', 4, 0, 4, 2, 40), plate('roof', 4, 2, 0, 2, 20), plate('front', 0, 2, 0, 0, 30)],
  // The same plates in the frame of the room, as outerFace takes them.
  faces = floor => [[0, floor, 4, floor, .01], [4, 0, 4, 2, .02], [4, 2, 0, 2, .01], [0, 2, 0, 0, .015]]
    .map(([x0, y0, x1, y1, half]) => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, half }));
// The renderer with the frame holding the vehicle and its plates; between two frames it draws the plates where they stood
// before (`pose`), as it draws those of a construction just turned about: not where the skin is to reach.
function renderer(parts) {
  const r = new Renderer({});
  r.scene = { frame: { actors: new Map([['a', { vehicle }]]), actorParts: new Map([['a', parts]]) }, pose: () => ({ x: -40, y: 7, angle: 2 }) };
  return r;
}
const near = (points, expected) => points.length === expected.length && points.every((p, i) => Math.abs(p.x - expected[i].x) < 1e-9 && Math.abs(p.y - expected[i].y) < 1e-9);

test('seen from outside, the skin reaches the outer faces of the plates where the frame has them, worked out again when they move', () => {
  const parts = skin(0), r = renderer(parts), surface = { artPolygon: room, artPose: vehicle, actorId: 'a' }, sprite = {},
    points = r.outerOutline(sprite, surface, []);
  assert(near(points, outerFace(room, faces(0))), JSON.stringify(points));
  assert.equal(Math.min(...points.map(p => p.y)).toFixed(3), '-0.010', 'the floor reaches the underside of its plate');
  // Kept while nothing moves.
  assert.equal(r.outerOutline(sprite, surface, []), points);
  // A plate astray when it was worked out, the floor three centimetres low: mended once it is back.
  parts.splice(0, 4, ...skin(-.03));
  const astray = r.outerOutline(sprite, surface, []);
  assert(near(astray, outerFace(room, faces(-.03))));
  parts.splice(0, 4, ...skin(0));
  assert(near(r.outerOutline(sprite, surface, []), points));
  // Another room standing against it: worked out again.
  const other = [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 1, y: 3 }];
  assert(near(r.outerOutline(sprite, surface, [other]), outerFace(room, faces(0), [other])));
});

test('a construction fixed in its place has no vehicle: its skin reaches its plates from where it stands', () => {
  // Its faces are told from where it stands, up a hill (physics.ts `buildAssembly`), and its plates where they are.
  const stands = { x: 0, y: 30, angle: 0 }, r = new Renderer({}),
    parts = faces(0).map(({ a, b, half }, i) => ({ id: 'p' + i, type: 'plate', data: { attached: true, definition: { x: (a.x + b.x) / 2,
      y: stands.y + (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x), length: Math.hypot(b.x - a.x, b.y - a.y), thicknessMm: half * 2000 } } }));
  r.scene = { frame: { actors: new Map([['f', { vehicle: null }]]), actorParts: new Map([['f', parts]]) } };
  assert(near(r.outerOutline({}, { artPolygon: room, artPose: stands, actorId: 'f' }, []), outerFace(room, faces(0))));
});

test('seen from outside, armoured glass is not painted over: the skin stays at its middle and the glass shows out of it', () => {
  // A front of glass: the skin is as it would be with no plate along the front, the others reaching their outer faces.
  const parts = skin(0), [, , , front] = parts, surface = { artPolygon: room, artPose: vehicle, actorId: 'a' };
  front.data.material = 'glass';
  const points = renderer(parts).outerOutline({}, surface, []);
  assert(near(points, outerFace(room, faces(0).slice(0, 3))), JSON.stringify(points));
  assert(Math.abs(Math.min(...points.map(p => p.x))) < 1e-9, 'the front at the middle of its glass');
  // Steel there reaches its outer face.
  front.data.material = 'steel';
  assert(near(renderer(parts).outerOutline({}, surface, []), outerFace(room, faces(0))));
});
