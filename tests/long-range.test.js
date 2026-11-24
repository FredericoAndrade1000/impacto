import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { damageConstruction, face, interior } from './damage-fixtures.js';
import { WEAPON_PRESETS, weaponSettings, fixedWeapon, allowedAmmo } from '../src/weapons.ts';
import { firingSolution, flightPath } from '../src/ballistics.ts';
import { Camera } from '../src/camera.ts';
import { plateCorners } from '../src/math.ts';
import { componentTint } from '../src/impact-damage.ts';
import { rehearsal } from '../server/room.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { listShots } from '../src/shots.ts';
import { flyRound, advance } from './mechanical-queries.js';

const presets = ['mk19', 'm224', 'm252', 'm119', 'm777', 'hydra70'];
function settings(preset, overrides = {}) {
  return weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo: 'he', spread: 0, ...overrides });
}
// One contact of a stated power: an armour-piercing round set two centimetres off the left
// end of a component and flown level into it, spent a few centimetres inside.
const strike = (w, module, power, radius) => flyRound(w, { x: module.x - module.width / 2 - .02, y: module.y,
  vx: 600, vy: 0, power, radius, mass: .2, caliberMm: radius * 2000, ammo: 'ap' }, .0001);

for (const preset of presets) for (const distance of [30, 120, 250]) {
  test(`${preset}: an airborne blast at ${distance} m agrees with its predicted flight and detonates once`, t => {
    const original = createConstruction('empty'), saved = structuredClone(original), w = new World(original); t.after(() => w.dispose());
    w.setTestDistance(distance);
    const aim = { x: 12, y: 6 }, config = settings(preset, { detonation: 'airburst' });
    // It flies more than a step from its muzzle, 6.8 m nearer the burst on the M777.
    const solution = firingSolution(w.launcher(config), aim, config);
    assert(solution.reachable); assert(solution.time > 1 / 60);
    assert(w.fire(aim, config, true));
    const events = advance(w, Math.ceil(solution.time * 60) + 35, { events: [] });
    const blasts = events.filter(e => e.type === 'explosion');
    assert.equal(blasts.length, 1); assert.equal(blasts[0].detonation, 'airburst');
    assert.equal(blasts[0].radius, config.blastRadius);
    assert(Math.hypot(blasts[0].x - aim.x, blasts[0].y - aim.y) < 0.004);
    assert.equal(w.projectiles.length, 0, 'the detonated round is removed');
    assert.deepEqual(original, saved, 'the original construction is untouched');
  });
}

for (const preset of presets) test(`${preset}: an intervening wall triggers the explosive before its airborne timer`, t => {
  const b = createConstruction('empty'), w = new World(b); t.after(() => w.dispose());
  // A closed eight-metre authored wall, as tall as the construction box from its floor, begins 5 cm in front of the
  // muzzle of the bench, which stands back by as much of its tube as lies level, laid as it is, intercepting even a
  // steep mortar arc before it climbs over the hull.
  w.addActor(damageConstruction({ length: 3, height: 8, rideHeight: 0, frontThickness: 80 }), { id: 'barrier', x: 3.2 });
  const barrierIds = new Set(w.plates.filter(p => p.actorId === 'barrier').map(p => p.id)),
    config = settings(preset, { detonation: 'airburst' }), laid = firingSolution({ x: 1.65, y: 1.42 }, { x: 12, y: 5 }, config).angle;
  w.command('configureLauncher', { point: { x: 1.65 - Math.cos(laid) * config.barrel, y: 1.42 } });
  assert(w.fire({ x: 12, y: 5 }, config, true));
  const flight = firingSolution(w.launcher(config), { x: 12, y: 5 }, config);
  const events = advance(w, Math.ceil(flight.time * 60) + 1, { events: [] }), blasts = events.filter(e => e.type === 'explosion');
  assert.equal(blasts.length, 1); assert(barrierIds.has(blasts[0].source));
  assert.equal(blasts[0].detonation, 'impact'); assert(blasts[0].x < 5);
});

test('low and high artillery arcs are distinct, mirrored and fitted wholly inside the camera', () => {
  const source = { x: -120, y: 1.42 }, aim = { x: 12, y: 2 };
  // The lowest charge: the high arc of a full one stands seven kilometres tall over a target this near.
  const low = firingSolution(source, aim, settings('m119', { trajectory: 'low', charge: .08 }));
  const high = firingSolution(source, aim, settings('m119', { trajectory: 'high', charge: .08 }));
  assert(high.time > low.time * 4); assert(high.apex > low.apex * 4);
  const mirrored = firingSolution({ x: 120, y: 1.42 }, { x: -12, y: 2 }, settings('m119', { trajectory: 'high', charge: .08 }));
  assert(Math.abs(high.time - mirrored.time) < 1e-9); assert(Math.abs(high.vx + mirrored.vx) < 1e-9);
  const camera = new Camera(900, 600); camera.minZoom = 0.4;
  for (const solution of [low, high]) {
    const path = flightPath(solution), target = compileBlueprint(createConstruction('heavy')); camera.fitFlight(path, target);
    const outline = target.plates.flatMap(plateCorners);
    for (const p of [...path, ...outline]) { const screen = camera.toScreen(p.x, p.y); assert(screen.x >= 0 && screen.x <= 900 && screen.y >= 0 && screen.y <= 600); }
  }
});

test('mortar charge increases with distance and an unreachable shot consumes neither ammunition nor cooldown', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  const config = settings('m252'), near = firingSolution({ x: -18, y: 1.42 }, { x: 12, y: 1 }, config);
  const far = firingSolution({ x: -988, y: 1.42 }, { x: 12, y: 1 }, config);
  assert(near.speed < far.speed && far.speed <= config.speed); assert(near.time < far.time);
  // The field of the workshop is shorter than the reach of the full charge: the lowest one is held to.
  assert.equal(w.fire({ x: 1200, y: 3 }, settings('m252', { charge: .08 })), false);
  assert.equal(w.stats.shots, 0); assert.equal(w.cooldown, 0);
});

test('range and projectiles are simulation state and resetting restores the original construction', t => {
  const b = createConstruction('heavy'), original = structuredClone(b), w = new World(b); t.after(() => w.dispose());
  w.setTestDistance(250); assert(w.snapshot().launcher.x < -200);
  assert(w.fire({ x: 12, y: 6 }, settings('m119', { detonation: 'airburst' }), true));
  assert(listShots(w.snapshot().shots).some(p => p.preset === 'm119'));
  w.reset(); assert.equal(w.testDistance, 0); assert.deepEqual(w.snapshot().launcher, w.blueprint.launcher);
  assert.equal(w.projectiles.length, 0); assert.deepEqual(b, original);
  assert.throws(() => w.setTestDistance(999), /Distância/);
});

test('secondary explosions from exposed ammunition remain singular with simplified component damage', t => {
  const b = damageConstruction({ components: [interior('ammo', { x: .4, y: .1675 }, 'ammo', { ammoPreset: 'rh120' })] }),
    w = new World(b); t.after(() => w.dispose());
  const box = w.modules[0], front = face(w, 'front');
  w.cutBody(front, front.definition, front.definition, front.definition.length);
  w.command('configureLauncher', { point: { x: box.x - 3, y: box.y } });
  assert(w.fire({ x: box.x + 1, y: box.y }, settings('m119', { trajectory: 'direct' }), true));
  const events = advance(w, 150, { events: [] }), secondary = events.filter(e => e.type === 'explosion' && e.source === box.id && !e.preset);
  assert.equal(secondary.length, 1); assert.equal(w.modules[0].health, 0);
  const explosions = w.stats.explosions;
  assert.equal(box.rounds, 0); assert(box.physicalMass > 0, 'the empty failed rack retains its material');
  assert.equal(w.index.raycast({ x: box.x - box.width, y: box.y }, { x: box.x + box.width, y: box.y })?.owner.id,
    box.id, 'functional failure leaves the rack as a ballistic obstacle');
  const impacts = w.stats.impacts;
  strike(w, box, 999, .03); advance(w, 30, { drain: true });
  assert.equal(w.stats.impacts, impacts + 1, 'a round goes through the spent rack');
  assert.equal(w.stats.explosions, explosions, 'the spent rack cannot detonate a second time');
});

test('components have continuous health colours and native light track damage is much smaller than engine damage', t => {
  const base = { health: 100, maxHealth: 100 }, colours = [100, 80, 60, 30, 0].map(health => componentTint({ ...base, health }));
  assert.equal(colours[0], 0xffffff); assert.equal(new Set(colours).size, 5);
  assert.equal(colours.at(-1), 0x686c68);
  const b = createConstruction('heavy'); b.components = b.components.filter(part => ['engine', 'track'].includes(part.kind));
  const w = new World(b); t.after(() => w.dispose());
  const [engine, track] = w.modules, damage = (module, power) => {
    const before = module.health;
    strike(w, module, power, .005);
    return before - module.health;
  };
  const lightTrack = damage(track, 35), lightEngine = damage(engine, 35);
  assert(lightTrack > 0 && lightEngine > 0);
  assert(lightTrack < lightEngine * 0.12);
  assert(damage(track, 155) > lightTrack * 8);
});


for (const preset of ['m242', 'mk44', 'mk35']) test(`${preset}: successive AP perforations leave most of a wide tank panel connected`, t => {
  // The tower of the stock heavy stands open to its hull, the breech of its gun going down through it: without the gun,
  // its floor is given back, and that is the wide panel.
  const b = createConstruction('heavy'); b.components = b.components.filter(m => !['ammo', 'fuel', 'weapon'].includes(m.kind));
  const under = b.plates.findIndex(p => p.id === 'hull:roof') + 1;
  b.plates.splice(under, 0, { id: 'turret:floor', a: 'turret-rear', b: 'turret-front', material: 'steel', thicknessMm: b.plates[under - 1].thicknessMm });
  // The rounds come down through the tower from a bench that holds the muzzle of the longest tube, 3.3 m, over it.
  b.launcher = { x: 12, y: 8 };
  // The roof of the hull under the tower is the tower's floor.
  const w = new World(b); t.after(() => w.dispose()); const roof = w.plates.find(p => p.id === 'turret:floor'), plateIds = w.plates.map(p => p.id).sort(), config = weaponSettings('autocannon', { preset, ammo: 'ap', spread: 0 });
  const events = [];
  for (let i = 0; i < 12; i++) {
    assert(w.fire({ x: 12 + ((i % 3) - 1) * 0.09, y: 2.88 }, config, true));
    advance(w, 8, { events });
  }
  advance(w, 120, { events });
  assert(events.some(e => e.type === 'penetration' && e.id === roof.id));
  assert(roof.attached && roof.integrity > 0.75, 'local holes do not separate the complete roof');
  assert.equal(w.plates.filter(p => p.attached !== false).length, plateIds.length);
  assert.deepEqual(w.plates.map(p => p.id).sort(), plateIds, 'all admitted hull and turret walls remain installed');
  assert(w.vehicle.y < 1.5 && Math.abs(w.vehicle.vy) < 1);
});


test('shared-world artillery accepts only catalogue power, respects explosive-only ammo and replicates its flight', t => {
  const room = rehearsal([-80]); t.after(() => room.world.dispose()); const player = room.join('Artilharia');
  const b = createConstruction('mortar');
  const result = room.command(player.playerId, { type: 'spawn', blueprint: b, x: -80, facing: 1 });
  room.command(player.playerId, { type: 'squad', order: 'control', id: result.actor.id });
  const actor = room.world.actor(result.actor.id), installed = room.world.modules.find(m => m.actorId === actor.id && m.kind === 'weapon');
  // A command that names another round is fired with the one the mortar is fed.
  const input = { aim: { x: 80, y: room.world.terrain.height(80) + 5 }, weapon: { id: 'mortar', componentId: installed.id, power: 9999, ammo: 'ap', trajectory: 'high', detonation: 'airburst', fuzeTime: -1 } };
  // This is a firing/catalogue test on a hillside. Hold the carrier rather
  // than allowing it to coast until pitch puts the target outside elevation.
  room.command(player.playerId, { type: 'drive', throttle: 0, brake: 1 });
  room.command(player.playerId, { ...input, type: 'aim' });
  for (let i = 0; i < 240; i++) room.world.step();
  const shot = room.command(player.playerId, { ...input, type: 'fire' });
  assert(shot.accepted); room.world.step(); // an input leaves the scene to the step that follows it
  const [projectile] = room.world.projectiles;
  // An HE round keeps the power of its fill in the air.
  assert.equal(projectile.power, WEAPON_PRESETS.m252.power); assert.equal(projectile.ammo, 'he'); assert(projectile.fuzeTime > 1);
  assert.deepEqual(allowedAmmo('m252'), ['he']);
  const replica = new FrameReader().decode(new FrameWriter().encode({ state: room.world.snapshot(), events: [] }, true));
  const [flying] = listShots(replica.state.shots);
  assert.equal(flying.preset, 'm252'); assert.equal(flying.actorId, room.world.actors[0].id); assert.equal(flying.ammo, 'he');
  assert(Math.abs(flying.x - projectile.x) < .01 && Math.abs(flying.vy - projectile.vy) < .01, 'the words carry where the round is and how it moves');
  assert.equal(fixedWeapon({ preset: 'm119', power: 9999 }).power, WEAPON_PRESETS.m119.power);
});

for (const preset of presets) for (const distance of [30, 120, 250]) test(`${preset}: a ${distance} m vehicle impact reaches real armour and leaves finite debris`, t => {
  const b = createConstruction('heavy'), saved = structuredClone(b), w = new World(b); t.after(() => w.dispose());
  w.setTestDistance(distance); const aim = { x: 12, y: WEAPON_PRESETS[preset].family === 'mortar' ? 3.2 : 1.5 }, config = settings(preset);
  const solution = firingSolution(w.launcher(config), aim, config);
  assert(w.fire(aim, config, true));
  const events = advance(w, Math.ceil(solution.time * 60) + 70, { events: [] });
  assert(w.stats.impacts > 0 && w.stats.explosions > 0);
  assert(events.some(e => e.type === 'explosion' && e.preset === preset && e.source !== 'ground'));
  assert(w.plates.every(p => p.nodes.every(n => Number.isFinite(n.x + n.y))));
  assert(w.vehicle.y < 4 && Math.abs(w.vehicle.vy) < 20, 'contact does not catapult the carrier');
  const detonationIds = events.filter(e => e.type === 'explosion' && !e.preset).map(e => e.source);
  assert.equal(new Set(detonationIds).size, detonationIds.length, 'secondary components explode once');
  assert.deepEqual(b, saved);
});
