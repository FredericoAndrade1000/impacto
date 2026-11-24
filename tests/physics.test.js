import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { weaponSettings, WEAPON_PRESETS } from '../src/weapons.ts';
import { plateMaterialState } from '../scripts/review-harness.ts';
import { damageConstruction, damageWorld, face, interior } from './damage-fixtures.js';
import { ownerState, physics, flyRound, structureMass, advance } from './mechanical-queries.js';
import { regionGeometry, regionContains } from '../src/scene-frame.ts';

const fixture = (t, options = {}) => damageWorld(t, { length: 3, height: 1.44, rideHeight: .7,
  frontThickness: 100, components: [interior('engine', { x: -.25, y: -.0325 })], ...options });
// The bench stands 4 m before the wall, or its tube and two metres more.
function shoot(world, preset = 'rh120', aim) {
  const plate = face(world), config = weaponSettings(WEAPON_PRESETS[preset].family, { preset, spread: 0 });
  const target = aim || { x: plate.definition.x + 2, y: plate.definition.y };
  world.command('configureLauncher', { point: { x: plate.definition.x - Math.max(4, config.barrel + 2), y: target.y } });
  assert(world.fire(target, config, true)); advance(world, 8);
}
// A round put two centimetres short of a component, on its axis, that goes into it and is spent there.
const strike = (world, part, power) => flyRound(world, { x: part.x - part.width / 2 - .02, y: part.y, vx: 600, vy: 0,
  power, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, .0002);
function frontCast(world, y = face(world).definition.y) {
  const plate = face(world), ignoreIds = new Set([...world.plates, ...world.modules].filter(p => p !== plate).map(p => p.id));
  return world.index.raycast({ x: plate.definition.x - .3, y }, { x: plate.definition.x + .3, y }, { ignoreIds });
}

test('a low-energy round is blocked by thick steel and leaves only a bounded local visual dent', t => {
  const world = fixture(t), plate = face(world), engine = world.modules[0];
  shoot(world, 'fnmag');
  assert.equal(world.stats.penetrations, 0); assert.equal(engine.health, engine.maxHealth);
  assert(world.events.some(e => e.type === 'blocked' && e.id === plate.id)); advance(world, 100);
  assert(plate.marks.some(m => m.kind === 'dent')); assert(plateMaterialState(plate).maxLocalDent < .002);
  assert(plate.nodes.every(n => Number.isFinite(n.x + n.y))); assert(plate.integrity > .9);
});

test('continuous collision detects the complete five-millimetre authored front wall at maximum catalogue velocity', t => {
  const world = fixture(t, { frontThickness: 5 }), plate = face(world);
  shoot(world, 'rh120');
  const primary = world.events.filter(e => ['penetration', 'blocked', 'ricochet'].includes(e.type));
  assert.equal(primary.filter(e => e.id === plate.id && e.type === 'penetration').length, 1);
  assert(world.stats.impacts >= 2); assert(world.modules[0].health < world.modules[0].maxHealth);
});

test('penetration opens a real grid aperture, emits secondary rays and damages the internal engine', t => {
  const world = fixture(t), plate = face(world), before = plate.remainingArea;
  shoot(world); assert(plate.remainingArea < before);
  assert(world.stats.secondaryShots > 0);
  assert(world.modules[0].health < world.modules[0].maxHealth); assert(world.stats.penetrations > 0);
});

test('rendered material mask and native query describe the same aperture and intact material', t => {
  const world = fixture(t), plate = face(world); shoot(world);
  assert.equal(frontCast(world), null);
  assert.equal(plate.containsLocal(plate.localPoint({ x: plate.definition.x, y: plate.definition.y })), false);
  const y = plate.definition.y + .45, intact = frontCast(world, y);
  assert.equal(intact?.owner.id, plate.id); assert(plate.containsLocal(plate.localPoint(intact)));
  const snap = plate.snapshot(); assert.deepEqual(snap.ballisticGrid, plate.ballisticGrid);
  assert.equal(regionContains(snap, { x: plate.definition.x, y: plate.definition.y }), false);
  assert.equal(regionContains(snap, intact), true);
});

test('a second shot through an existing aperture never pays the removed wall resistance twice', t => {
  const world = fixture(t, { components: [] }), plate = face(world);
  shoot(world); advance(world, 45); const grid = structuredClone(plate.ballisticGrid); world.drainEvents();
  assert.equal(frontCast(world), null); shoot(world);
  assert(!world.events.some(e => ['blocked', 'penetration'].includes(e.type) && e.id === plate.id));
  assert.deepEqual(plate.ballisticGrid, grid);
});

test('perforation preserves carrier identity, contact hull, fixed mass and inertia', t => {
  const world = fixture(t), plate = face(world), before = ownerState(world, plate),
    contours = structuredClone(world.actor().contactContours);
  assert(Array.isArray(contours) && contours.length > 0 && contours.every(polygon =>
    Array.isArray(polygon) && polygon.length >= 3 && polygon.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))),
  'the installed contact shape contains real finite polygons');
  shoot(world); const after = ownerState(world, plate);
  assert(plate.remainingArea < plate.originalArea); assert.equal(after.state.mass, before.state.mass);
  assert.equal(after.state.inertia, before.state.inertia); assert.equal(after.body, before.body);
  assert.deepEqual(world.actor().contactContours, contours);
});

test('concrete and steel show distinct local marks without remote collapse', t => {
  const steel = fixture(t), concrete = fixture(t, { material: 'concrete', frontThickness: 600 });
  for (const w of [steel, concrete]) { shoot(w, 'm2hb'); shoot(w, 'm2hb'); shoot(w, 'm2hb'); }
  assert(face(steel).marks.some(m => m.kind === 'dent')); assert(face(concrete).marks.some(m => m.kind === 'crack'));
  assert(face(concrete).integrity > .95);
});

test('grazing projectiles ricochet from an admitted inclined hull face', t => {
  // At the incidence it once had, its top set back 2.5 m over the 0.6 m of the hull: now from a nose.
  const source = damageConstruction({ height: .6, frontThickness: 160, incidence: 76.5, components: [] });
  const world = new World(source); t.after(() => world.dispose()); shoot(world, 'fnmag');
  assert(world.stats.ricochets > 0); assert(world.events.some(e => e.type === 'ricochet'));
});

test('a wall cut across both ends retains installation and cannot separate structural bodies', t => {
  const world = fixture(t), plate = face(world), before = ownerState(world, plate);
  for (const dy of [-.35, .35]) world.cutBody(plate,
    { x: plate.definition.x - .3, y: plate.definition.y + dy },
    { x: plate.definition.x + .3, y: plate.definition.y + dy }, .07);
  advance(world, 15); assert.equal(ownerState(world, plate).body, before.body);
  assert(plate.remainingArea > 0);
});

test('closed armour shields the same engine from substantially more external blast damage than a thin wall', t => {
  const shield = fixture(t, { frontThickness: 900 }), exposed = fixture(t, { frontThickness: 5 }),
    point = { x: face(shield).definition.x - .5, y: shield.modules[0].y };
  for (const world of [shield, exposed]) { world.explode(point.x, point.y, 65, 2.4); advance(world, 8); }
  assert(shield.modules[0].health > exposed.modules[0].health + 12);
});

test('fuel ignition and ammunition failure schedule only one detonation for that rack', t => {
  const world = damageWorld(t, { length: 7, height: 3, components:
    [interior('ammo', { x: -1.6, y: .1675 }, 'ammo', { ammoPreset: 'rh120' }), interior('fuel', { x: 1.4, y: .2175 })] }),
    ammo = world.modules.find(m => m.kind === 'ammo'), fuel = world.modules.find(m => m.kind === 'fuel');
  // A round that takes six tenths of the tank's health sets it alight. One through the rack destroys it,
  // and the next finds it destroyed.
  strike(world, fuel, 55); assert(fuel.burning);
  strike(world, ammo, 120); strike(world, ammo, 120); advance(world, 2);
  assert.equal(world.events.filter(e => e.type === 'explosion' && e.source === ammo.id).length, 1);
});

test('AP failure leaves engine material as ballistic cover without a fireball or separate body', t => {
  const world = fixture(t); shoot(world); const engine = world.modules[0];
  assert.equal(world.stats.explosions, 0); assert.equal(engine.health, 0);
  const y = engine.y + engine.height * .3, ignoreIds = new Set(world.plates.map(p => p.id)),
    hit = world.index.raycast({ x: engine.x - engine.width, y }, { x: engine.x + engine.width, y }, { ignoreIds });
  assert.equal(hit?.owner.id, engine.id); assert.equal(ownerState(world, engine).body, ownerState(world, face(world)).body);
});

test('internal blast can destroy installed reserves while the closed vehicle remains one rigid object', t => {
  const source = damageConstruction({ dynamic: true, length: 6, height: 3,
    components: [interior('fuel', { x: 1.4, y: .92 }), interior('ammo', { x: -1.1, y: .17 }, 'ammo', { ammoPreset: 'rh120' })] }),
    world = new World(source); t.after(() => world.dispose()); const before = physics(world).bodyStates[0], structure = structureMass(world);
  const ammo = world.modules.find(m => m.kind === 'ammo');
  world.explode(ammo.x, ammo.y, 400, 4); advance(world, 30);
  assert(world.stats.explosions >= 1); assert(world.modules.some(m => m.health < m.maxHealth));
  assert(world.plates.some(p => p.integrity < .95)); const after = physics(world).bodyStates[0];
  // What the reserves held is gone from the body with them; the structure weighs what it did.
  assert.equal(after.handle, before.handle); assert(after.mass < before.mass - 20 && after.inertia < before.inertia);
  assert(Math.abs(structureMass(world) - structure) < 1e-6); assert.equal(physics(world).bodyStates.length, 1);
  assert.equal(world.dynamics.recoveries || 0, 0);
});

test('seeded reset restores material, reserves and exactly reproduces the shot sequence', t => {
  const world = fixture(t), initial = world.snapshot(); shoot(world);
  const outcome = JSON.stringify({ stats: world.stats, health: world.modules.map(m => m.health), grid: face(world).ballisticGrid });
  world.reset(); assert.deepEqual(world.snapshot().plates.map(p => regionGeometry(p)), initial.plates.map(p => regionGeometry(p)));
  assert.equal(world.projectiles.length, 0);
  shoot(world); assert.equal(JSON.stringify({ stats: world.stats, health: world.modules.map(m => m.health), grid: face(world).ballisticGrid }), outcome);
});

test('render sampling is observational and cannot change later fixed-step damage or physics', t => {
  const source = damageConstruction({ components: [interior('engine', { x: -.65, y: -.0325 })] }),
    a = new World(source), b = new World(source); t.after(() => { a.dispose(); b.dispose(); });
  for (const w of [a, b]) w.fire({ x: 13, y: 1.4 }, weaponSettings('cannon', { preset: 'rh120', spread: 0 }), true);
  for (let i = 0; i < 40; i++) { a.step(); b.step(); a.snapshot(); if (i % 2 === 0) a.snapshot(); }
  assert.deepEqual(a.stats, b.stats); assert.deepEqual(a.modules, b.modules);
  assert.deepEqual(a.snapshot().plates, b.snapshot().plates); assert.deepEqual(physics(a), physics(b));
});
