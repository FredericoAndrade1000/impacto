import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { chassisSpec } from '../src/chassis.ts';
import { face, damageConstruction } from './damage-fixtures.js';
import { managedWorld, ownerState, physics, dent, impulse, setVehicle, setPart, advance } from './mechanical-queries.js';

const near = (a, b, e = 1e-7) => assert(Math.abs(a - b) < e, `${a} != ${b}`);
// The floor is one identified surface of a closed authored hull. The other
// three walls remain installed and contribute their real carrier mass/inertia.
// The dynamic floor assay uses the current wheeled frame.
function rigid(t, { x = 10, y = 2, length = 1, angle = 0, thicknessMm = 100, chassis, ends } = {}, state = {}) {
  const source = damageConstruction({ dynamic: true, chassis, length, height: 1, thicknesses: { floor: thicknessMm } });
  if (ends) for (const plate of source.plates) plate.ends = ends[plate.id];
  const world = managedWorld(t, source);
  setVehicle(world, { x, y, angle, ...state });
  return { world, plate: face(world, 'floor') };
}

test('moving dents keep bounded records while material supports retain their coordinates', t => {
  const { world: w, plate: p } = rigid(t),
    nodes = p.nodes.map(n => ({ ...n.local })), indices = [...p.activeIndices], initial = p.remainingArea;
  const center = p.materialPosition({ u: .5, v: .5 });
  for (let i = 0; i < 300; i++) dent(w, p, { x: center.x + Math.sin(i) * .002, y: center.y }, .001);
  assert.deepEqual(p.nodes.map(n => n.local), nodes); assert.deepEqual([...p.activeIndices], indices);
  assert(p.dents.size > 0 && p.dents.size <= 64);
  const uv = { u: .5001, v: .5 }, point = p.materialPosition(uv), actual = p.materialUV(point);
  near(actual.u, uv.u); near(actual.v, uv.v);
  const physicalMass = p.physicalMass, cutUV = { u: .501, v: .5 }, cut = p.materialPosition(cutUV),
    halfChord = p.definition.thicknessMm / 1000;
  assert(cut, 'cut the admitted sheet, including its construction offset from the carrier');
  w.cutBody(p, { x: cut.x, y: cut.y - halfChord }, { x: cut.x, y: cut.y + halfChord }, .008);
  assert.equal(p.materialPosition(cutUV), null);
  assert(p.remainingArea < initial); assert.equal(p.physicalMass, physicalMass);
});

test('large plastic work cannot invert base cells or add rigid momentum', t => {
  const { world: w, plate: p } = rigid(t, { angle: .3 }),
    points = p.nodes.map(n => ({ ...n.local })), properties = { ...p.massProperties };
  dent(w, p, p.definition, 2, .1);
  assert([...p.dents.values()].every(d => d.depth <= .026 + 1e-12));
  assert.deepEqual(p.nodes.map(n => n.local), points); assert.deepEqual(p.massProperties, properties);
  assert(p.attached);
});

test('repeated point cuts change ballistic material once and never allocate physical fragments', t => {
  const { world: w, plate: p } = rigid(t, { x: 11, y: 2.6, length: 2, thicknessMm: 120, chassis: 'wheeled' }),
    initial = p.remainingArea, topology = [...p.activeIndices], center = p.materialPosition({ u: .5, v: .5 });
  assert(center, 'derive the point cut from actual admitted material');
  w.cutBody(p, center, center, .08); const removed = initial - p.remainingArea;
  assert(removed > 0);
  assert.equal(p.materialPosition({ u: .5, v: .5 }), null);
  w.cutBody(p, center, center, .08); near(initial - p.remainingArea, removed);
  w.cutBody(p, center, center, 2); near(p.remainingArea, 0);
  assert.deepEqual(p.solidRegions, []); assert.deepEqual([...p.activeIndices], topology);
});

test('large rigid transforms change accepted pose without moving local material coordinates', t => {
  // This mitred specimen writes its physical end dimensions explicitly; moving
  // or changing another plate no longer extends this specimen automatically.
  // In cells: each plate runs one cell past the joint it covers (4 or 2.5 cm before the grid) and none past the other
  // (2.5 mm before).
  const { world: w, plate: p } = rigid(t, { x: 12, y: 1.3, length: 2, angle: .4, thicknessMm: 50, ends: {
    'hull:floor': { start: 1, end: 0 }, 'hull:rear': { start: 1, end: 0 },
    'hull:roof': { start: 0, end: 1 }, 'hull:front': { start: 0, end: 1 },
  } }),
    local = p.nodes.map(n => ({ ...n.local }));
  setVehicle(w, { x: -2, y: 7, angle: 2.17 });
  assert.deepEqual(p.nodes.map(n => n.local), local);
  for (const n of p.nodes) {
    near(n.x, p.frame.x + p.frame.c * n.local.x - p.frame.s * n.local.y);
    near(n.y, p.frame.y + p.frame.s * n.local.x + p.frame.c * n.local.y);
  }
  // The floor is mitred into its neighbours, so its length is the plate's own, not the wall's 2 m.
  assert(p.definition.length > 2); near(p.remainingArea, p.definition.length * .05);
});

test('a material support survives a dent and accepted motion but cannot restore a through-cut', t => {
  // The support is the middle of the floor wall: halfway between the plate's
  // two joints, which a mitred plate no longer has at its own middle. Its
  // carrier offset comes from the admitted floor; suspension clearance can
  // raise the real deck above the catalogue reference.
  const { world: w, plate: p } = rigid(t, { x: 12, y: 1.3, length: 2, chassis: 'wheeled' }), joints = p.definition.anchors,
    uv = { u: .5 + (joints[0].u + joints[1].u) / 2, v: .5 }, properties = { ...p.massProperties },
    support = p.materialPosition(uv), offset = { x: support.x - w.vehicle.x, y: support.y - w.vehicle.y };
  dent(w, p, support, .02, .04); assert(p.marks.some(m => m.depth > 0));
  assert.deepEqual(p.materialPosition(uv), support);
  assert.deepEqual(p.massProperties, properties); setVehicle(w, { x: 14, y: 3, angle: .3 });
  const point = p.materialPosition(uv), c = Math.cos(.3), s = Math.sin(.3);
  near(point.x, 14 + c * offset.x - s * offset.y); near(point.y, 3 + s * offset.x + c * offset.y);
  w.cutBody(p, point, point, .07); assert.equal(p.materialPosition(uv), null);
});

for (const angle of [0, .61]) test(`cold readmission preserves asymmetric ballistic apertures and fixed carrier mass at ${angle}`, t => {
  const { world: w, plate: p } = rigid(t, { y: 4, length: 2, angle, thicknessMm: 300, chassis: 'wheeled' }),
    uv = { u: .75, v: .5 }, hole = p.materialPosition(uv), before = ownerState(w, p).state;
  w.cutBody(p, hole, hole, .06); assert.equal(p.materialPosition(uv), null);
  const area = p.remainingArea, kept = [{ u: .1, v: .6 }, { u: .5, v: .5 }, { u: .9, v: .3 }],
    points = kept.map(q => p.materialPosition(q));
  w.addActor(damageConstruction(), { id: 'other', x: 70 });
  assert.equal(p.materialPosition(uv), null); near(p.remainingArea, area);
  kept.forEach((q, i) => assert.deepEqual(p.materialPosition(q), points[i]));
  const after = ownerState(w, p).state; near(after.mass, before.mass, .001); near(after.inertia, before.inertia, .001);
});

test('off-centre impulses enter the one native rigid mass with their actual moment', t => {
  const { world: w, plate: f } = rigid(t, { thicknessMm: 40 }),
    point = { x: 10.1, y: 2.02 }, before = ownerState(w, f).state;
  impulse(w, f, point, { x: 100, y: -30 }); const after = ownerState(w, f).state;
  near(after.mass * after.vx, 100, .002); near(after.mass * after.vy, -30, .002);
  near(after.inertia * after.omega, (point.x - before.center.x) * -30 - (point.y - before.center.y) * 100, .002);
  assert.deepEqual(ownerState(w, f).state, after, 'a diagnostic query cannot apply the impulse a second time');
});

test('installed plate dents are bounded records without changing carrier mass, spin or shape', t => {
  const { world: w, plate: f } = rigid(t, {}, { vx: 2, vy: -.3, omega: 4 }),
    before = ownerState(w, f), geometry = f.nodes.map(n => ({ ...n.local })), indices = [...f.activeIndices];
  for (let i = 0; i < 100; i++) dent(w, f, { x: 10, y: 2.05 }, .01);
  assert(f.dents.size > 0 && f.dents.size <= 64 && f.marks.length <= 32);
  assert.deepEqual(ownerState(w, f), before); assert.deepEqual(f.nodes.map(n => n.local), geometry);
  assert.deepEqual([...f.activeIndices], indices);
});

test('native solving returns one frame and presentation accepts that pose once', t => {
  const { world: w, plate: f } = rigid(t, { y: 3, thicknessMm: 40 }, { vy: -2 }), game = w.game(), y = f.definition.y;
  const frame = JSON.parse(game.core.game_step(1 / 60));
  assert.equal(f.definition.y, y, 'native solving cannot mutate the JS presentation object');
  game.accept(frame); assert(f.definition.y < y); near(w.time, 1 / 60);
  const accepted = f.definition.y; game.accept(frame); assert.equal(f.definition.y, accepted);
});

test('a disabled track keeps its fixed carrier and original construction mass', t => {
  const w = managedWorld(t, createConstruction('heavy')), track = w.modules.find(m => m.kind === 'track'),
    before = ownerState(w, track),
    mass = physics(w).bodyStates.reduce((sum, p) => sum + p.mass, 0);
  setPart(w, track, { health: 0 });
  assert(track.attached && track.health === 0);
  assert.equal(ownerState(w, track).body, before.body);
  advance(w, 1); near(physics(w).bodyStates.reduce((sum, p) => sum + p.mass, 0), mass, .01);
  assert.equal(w.dynamics.recoveries, 0);
});

test('the wheels of the chassis share one carrier with zero axle joints and invalid loads preserve the world', t => {
  const b = createConstruction('scout'), w = managedWorld(t, b), { axles } = chassisSpec(b.chassis.model);
  const wheels = w.modules.filter(m => m.kind === 'wheel');
  assert(wheels.length >= 2, 'the wheeled chassis has separated supporting axles');
  assert.deepEqual(wheels.map(wheel => wheel.id).sort(), Array.from({ length: axles }, (_, i) => `chassis:wheel-${i}`),
    'every axle of the chassis brings its wheel');
  const carrier = ownerState(w, w.plates[0]).body;
  for (const wheel of w.modules.filter(m => m.kind === 'wheel')) assert.equal(ownerState(w, wheel).body, carrier);
  const invalid = structuredClone(b); invalid.plates[0].thicknessMm = -1;
  assert.throws(() => w.load(invalid));
  advance(w, 1); assert.equal(physics(w).bodyStates.filter(b => b.dynamic).length, 1); assert(Number.isFinite(w.vehicle.y));
});
