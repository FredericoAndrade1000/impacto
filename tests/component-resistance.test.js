import { withRaisedFloor } from './helpers/designs.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { materialState, setPart, setVehicle, ownerState, physics, flyRound } from './mechanical-queries.js';
import { damageWorld, face, interior } from './damage-fixtures.js';
import { pieceCost } from '../src/construction-cost.ts';
import { weaponSettings } from '../src/weapons.ts';
import { MATERIALS } from '../src/materials.ts';

const componentWorld = (t, kind, options = {}) => damageWorld(t, { length: 8, height: 4,
  components: [interior(kind, { x: 0, y: 1 }, kind, kind === 'ammo' ? { ammoPreset: 'rh120', ...options } : options)] });
const resistance = (world, part, point = part) => materialState(world, part, point, { depth: part.width }).resistance;

test('native engine mechanics are porous, with fixed casing thickness and square cost/mass scaling', t => {
  const small = componentWorld(t, 'engine'), large = componentWorld(t, 'engine', { sizeScale: 2 }),
    a = small.modules[0], b = large.modules[0], value = resistance(small, a),
    solidSteel = a.width * 1000 * MATERIALS.steel.resistance;
  assert(value > 5 && value < 70); assert(value < solidSteel * .05);
  // Twice as big is twice as long and tall, as deep across the body: four times the room, the mass and the price.
  assert(Math.abs(b.physicalMass / a.physicalMass - 4) < 1e-8);
  assert(pieceCost(b) >= pieceCost(a) * 3.95);
  assert(resistance(large, b) < value * 2, 'resizing a mechanism cannot turn its casing into a solid armour slab');
});

test('empty reserves offer less ballistic resistance and functional failure cannot strengthen a wreck', t => {
  for (const kind of ['fuel', 'ammo']) {
    const world = componentWorld(t, kind), part = world.modules[0], loaded = resistance(world, part);
    setPart(world, part, kind === 'fuel' ? { fuelLitres: 0 } : { rounds: 0 });
    const empty = resistance(world, part); assert(empty < loaded); assert(loaded < 25);
    setPart(world, part, { health: 0 }); assert.equal(resistance(world, part), empty);
  }
});

test('component perforations survive cosmetic mark eviction and occupy bounded memory', t => {
  const world = componentWorld(t, 'engine'), part = world.modules[0], half = { x: part.width / 2 + .02, y: part.height / 2 + .02 },
    point = { x: part.x - part.width / 2, y: part.y }, before = resistance(world, part, point);
  // A round set two centimetres off a face of the casing and flown into it, spent a few centimetres inside.
  const shoot = (x, y, vx, vy, power) => flyRound(world, { x, y, vx, vy, power, radius: .005, mass: .2, caliberMm: 10, ammo: 'ap' }, .0001);
  for (let i = 0; i < 20; i++) shoot(part.x - half.x, part.y, 600, 0, 160);
  assert.equal(world.stats.penetrations, 20);
  // Forty-eight rounds too weak to enter dent the top of the casing across its width.
  for (let i = 0; i < 48; i++) shoot(part.x + (i / 48 - .5) * part.width, part.y + half.y, 0, -600, 1);
  assert.equal(world.stats.penetrations, 20); assert(part.marks.every(mark => mark.kind === 'dent'));
  setPart(world, part, { health: 0 }); assert(resistance(world, part, point) < before * .1); assert(part.marks.length <= 48);
  // A round scars the cell of the casing it enters by: rounds through every face fill the rim of the 32 x 32 lattice and no more.
  for (let i = 0; i <= 32; i++) {
    const x = part.x + (i / 32 - .5) * part.width, y = part.y + (i / 32 - .5) * part.height;
    shoot(part.x - half.x, y, 600, 0, 160); shoot(part.x + half.x, y, -600, 0, 160);
    shoot(x, part.y - half.y, 0, 600, 160); shoot(x, part.y + half.y, 0, -600, 160);
  }
  const scars = Object.keys(part.ballisticScars).length; assert(scars > 100 && scars <= 4 * 31);
});

test('twenty-millimetre AP traverses an engine in a thin hull while armour protects the following command computer', t => {
  const source = frontThickness => ({ length: 3, height: 2, frontThickness,
    components: [interior('engine', { x: -.25, y: -.0325 }), interior('command', { x: .75, y: .1675 })] }),
    engine = damageWorld(t, source(5)), shield = damageWorld(t, source(125)),
    config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 });
  for (const world of [engine, shield]) {
    const command = world.modules.find(m => m.kind === 'command'), y = command.y;
    world.command('configureLauncher', { point: { x: face(world).definition.x - 3, y } });
    assert(world.fire({ x: command.x + 2, y }, config, true)); for (let i = 0; i < 8; i++) world.step();
  }
  assert(engine.modules.find(m => m.kind === 'command').health < 60);
  const command = shield.modules.find(m => m.kind === 'command'); assert.equal(command.health, command.maxHealth);
  assert.equal(engine.stats.explosions, 0);
});

test('track silhouette does not remove nested hull shielding from an external blast', t => {
  let source = createStructuredTemplate('heavy');
  // Preserve the original shielding experiment's 80 mm floor. The stock
  // design has a lighter floor and legitimately takes more damage.
  source = withRaisedFloor(source, 80);
  const world = new World(source); t.after(() => world.dispose());
  const track = world.modules.find(m => m.kind === 'track'), before = new Map(world.modules.map(m => [m.id, m.health])),
    body = ownerState(world, track).body, mass = physics(world).bodyStates.find(b => b.handle === body).mass;
  world.explode(track.x, track.y, 600, 4.5, 'test'); for (let i = 0; i < 12; i++) world.step();
  assert.equal(track.health, 0);
  for (const kind of ['engine', 'fuel', 'ammo']) {
    const part = world.modules.find(m => m.kind === kind);
    assert(before.get(part.id) - part.health < 2, kind);
  }
  assert.equal(world.stats.explosions, 1); assert.equal(physics(world).bodyStates.find(b => b.handle === body).mass, mass);
});

test('an upward gear hit resolves the overlapping floor before it can reach protected ammunition', t => {
  // Between the track and the floor lies the frame of the chassis, 25 mm of steel just under the deck: a floor of
  // 20 mm makes with it the 45 mm a round through the gear passes, while one of 80 mm holds the frame within its own
  // thickness and is met first.
  for (const thicknessMm of [20, 80]) {
  const source = withRaisedFloor(createStructuredTemplate('heavy'), thicknessMm);
  const world = new World(source); t.after(() => world.dispose());
  // This isolates material ordering above ground; a launcher under the
  // terrain would hit terrain before reaching the running gear.
  setVehicle(world, { y: 5 });
  const floor = world.plates.find(p => p.id === 'chassis:top-0'), ammo = world.modules.find(m => m.kind === 'ammo'),
    x = ammo.x, config = weaponSettings('autocannon', { preset: 'm242', spread: 0 });
  world.command('configureLauncher', { point: { x, y: 2 } });
  assert(world.fire({ x, y: ammo.y }, config, true)); for (let i = 0; i < 8; i++) world.step();
  const events = world.drainEvents(); assert(events.some(e => e.type === 'module' && e.kind === 'track'));
  if (thicknessMm === 80) {
    assert(events.some(e => ['blocked', 'ricochet'].includes(e.type) && e.id === floor.id));
    assert.equal(ammo.health, ammo.maxHealth);
  } else {
    assert(events.some(e => e.type === 'penetration' && e.id === floor.id));
    assert(ammo.health < ammo.maxHealth);
  }
  }
});

test('weapon material, passage and mantlet resolve a traversal without duplicate component damage', t => {
  const world = new World(createStructuredTemplate('heavy')); t.after(() => world.dispose());
  const gun = world.modules.find(m => m.kind === 'weapon'), y = gun.y, config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 }),
    command = world.modules.find(m => m.kind === 'command'), health = command.health;
  world.command('configureLauncher', { point: { x: gun.x - config.barrel - 4, y } });
  assert(world.fire({ x: gun.x + 5, y }, config, true)); for (let i = 0; i < 8; i++) world.step();
  const hits = world.drainEvents().filter(e => e.type === 'module' && e.id === gun.id);
  assert(hits.length > 0 && hits.length <= 2, 'separate barrel and receiver chords may each be crossed once');
  assert.equal(command.health, health); assert.equal(world.stats.explosions, 0);
});
