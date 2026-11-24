import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { World } from '../src/physics.ts';
import { sensorSupport, drawSensorSupport } from '../src/sensor-support.ts';
await initNativeDynamics();
const near = (a, b, what = '') => assert(Math.abs(a - b) < 1e-8, `${what} ${a} differs from ${b}`);
const THICK = .02, HALF_H = .12;
// A camera of a bunker over a free plate (20 mm thick), `gap` metres over it where its nearer corner is, the plate rising
// `slope` metres over its four; or beside an upright plate, its side against it.
function rig({ side = 'bottom', slope = 0, gap = 0, mirrored = false } = {}) {
  const base = createStructuredConstruction({ preset: 'bunker', length: 6, height: 3, thicknessMm: 8 }),
    e = new Editor({ ...base, nodes: [], plates: [], components: [] });
  e.snap = false;
  let point;
  if (side === 'left' || side === 'right') { e.addPlate({ x: 12, y: 3 }, { x: 12, y: 5 }); point = { x: 12 + (side === 'left' ? .17 : -.17), y: 4 }; }
  else { e.addPlate({ x: 11, y: 3 }, { x: 15, y: 3 + slope }); point = { x: 13, y: 3 + slope / 2 + THICK / 2 * Math.hypot(4, slope) / 4 + HALF_H + Math.abs(slope) / 4 * .16 + gap }; }
  const added = e.addModule('sensor', point, { sensorMode: 'visual', mirrored });
  return e.blueprint.modules.find(module => module.id === added.id);
}
// What a mount is drawn of: the corners of its shapes, in the sensor's physical frame (its group mirrors the drawing).
function drawn(seat) {
  const points = [], g = {
    poly(flat) { for (let i = 0; i < flat.length; i += 2) points.push({ x: seat.mirrored ? -flat[i] : flat[i], y: flat[i + 1] }); return this; },
    fill() { return this; }, stroke() { return this; } };
  drawSensorSupport(g, seat);
  return points;
}
const inside = (p, polygon) => polygon.every((a, i) => {
  const b = polygon[(i + 1) % polygon.length]; return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-9;
});
const boxOf = module => [{ x: -module.width / 2, y: -module.height / 2 }, { x: module.width / 2, y: -module.height / 2 },
  { x: module.width / 2, y: module.height / 2 }, { x: -module.width / 2, y: module.height / 2 }];

test('a camera standing right on a level face is painted with its own foot, and draws no mount', () => {
  const camera = rig();
  assert.equal(camera.support.reach, 0);
  assert.equal(sensorSupport(camera), null);
});

for (const mirrored of [false, true]) for (const slope of [0, .3, -.3]) for (const gap of [.004, .05, .5, 1.3])
  test(`a camera ${gap} m over a face rising ${slope} stands on a column whose foot lies along it, mirrored=${mirrored}`, () => {
    const camera = rig({ slope, gap, mirrored }), seat = sensorSupport(camera), { foot, polygon } = camera.support;
    assert(seat); assert.equal(seat.mode, 'column'); assert.equal(seat.separate, false);
    assert(camera.support.reach > 0 && camera.support.reach <= 1.5 + 1e-9, `reach ${camera.support.reach}`);
    // The camera stays level; the foot of its column follows the face.
    near(camera.angle, 0); near((foot[1].y - foot[0].y) / (foot[1].x - foot[0].x), slope / 4, 'slope of the foot');
    const points = drawn(seat), box = boxOf(camera);
    assert(points.length > 20);
    assert(points.every(p => inside(p, polygon) || inside(p, box)), 'drawn within the column and the camera');
    // The flange lies on the face from end to end, and the cradle meets the foot of the camera.
    for (const end of foot) assert(points.some(p => Math.hypot(p.x - end.x, p.y - end.y) < 1e-9), 'the flange reaches the end of the foot');
    assert(points.some(p => Math.abs(p.y + camera.height / 2) < 1e-9), 'the cradle meets the camera');
  });

for (const side of ['left', 'right']) test(`a camera held by a plate at its ${side} gets a bracket in its box, its own foot painted apart`, () => {
  const camera = rig({ side }), seat = sensorSupport(camera);
  assert.equal(camera.support.reach, undefined);
  assert(seat); assert.equal(seat.mode, 'bracket'); assert.equal(seat.separate, true);
  near(Math.abs(seat.normal.x), 1);
  const points = drawn(seat);
  assert(points.length > 10); assert(points.every(p => inside(p, boxOf(camera))));
});

test('a seat is worked out once for each support, and anew for a mirrored picture', () => {
  const camera = rig({ gap: .3 }), seat = sensorSupport(camera);
  assert.equal(sensorSupport({ ...camera }), seat);
  const mirrored = sensorSupport({ ...camera, mirrored: true });
  assert.notEqual(mirrored, seat); assert.notEqual(mirrored.key, seat.key);
  const plain = drawn(seat), flipped = drawn(mirrored);
  assert.deepEqual(flipped, plain);
});

test('a construction facing the other way reflects the column of each piece with it, still counter-clockwise', () => {
  const world = new World(createStructuredTemplate('grader'), { visualEvents: false });
  try {
    world.addActor(createStructuredTemplate('grader'), { id: 'other', ownerId: 'bob', x: 60, facing: -1 });
    const blades = world.modules.filter(module => module.kind === 'blade'), [ours, theirs] = ['local', 'other'].map(id => blades.find(m => (m.actorId || 'local') === id));
    assert(ours.support.polygon && theirs.support.polygon);
    const same = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
    ours.support.foot.map(p => ({ x: -p.x, y: p.y })).reverse().forEach((p, i) => same(theirs.support.foot[i], p));
    same(theirs.support.normal, { x: -ours.support.normal.x, y: ours.support.normal.y });
    const area = polygon => polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2;
    assert(area(theirs.support.polygon) > 0); near(area(theirs.support.polygon), area(ours.support.polygon));
  } finally { world.dispose(); }
});

test('the column of a piece shows through fog and goes over the wire with it', async () => {
  const { Fog, chapters } = await import('../server/fog.ts'), { Publication } = await import('../server/publication.ts'),
    { FrameWriter, FrameReader } = await import('../src/network-protocol.ts'), world = new World(createStructuredTemplate('grader'), { visualEvents: false });
  try {
    const whole = world.snapshot(), actor = whole.actors[0], fog = new Fog(), blade = whole.modules.find(module => module.kind === 'blade');
    fog.read({ sight: { watcher: [{ actorId: actor.id, channel: 'visual', visible: true, x: actor.x, y: 2, error: .5, by: 'w1' }] } }, whole.time);
    assert(blade.support.polygon);
    assert.deepEqual(fog.tell(whole, chapters(whole), 'watcher').modules.find(module => module.id === blade.id).support, blade.support);
    const decoded = new FrameReader().decode(new FrameWriter().encode({ state: new Publication().state({ ...whole, shared: true }), events: [] }, true)).state;
    // The wire rounds its numbers, finer than a tenth of a millimetre.
    const told = decoded.modules.find(module => module.id === blade.id).support, alike = (a, b) => typeof a === 'number' ? assert(Math.abs(a - b) < 1e-4, a + ' against ' + b)
      : typeof a === 'object' ? (assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort()), Object.keys(a).forEach(key => alike(a[key], b[key]))) : assert.equal(a, b);
    alike(told, blade.support);
  } finally { world.dispose(); }
});
