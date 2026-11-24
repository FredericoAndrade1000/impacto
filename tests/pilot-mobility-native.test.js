import test from 'node:test';
import { withRaisedFloor } from './helpers/designs.js';
import assert from 'node:assert/strict';
import { SharedRoom, rehearsal } from '../server/room.ts';
import { cargoRoom, CARGO } from '../src/component-volume.ts';
import { onField } from './helpers/field.js';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { validateStructuredConstruction } from '../src/structured-construction.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { CELL, cellOf } from '../src/grid.ts';

// A real generated world and real admitted vehicles, kept and opened again.
// These checks need the coordinated current native build; no server or browser.
function ordinaryGround(terrain) {
  for (let x = -2000; x < 2000; x += 20) {
    let ordinary = true;
    for (let d = -100; d <= 100; d += 2)
      if (Math.abs(terrain.height(x + d + 2) - terrain.height(x + d - 2)) / 4 > .08 ||
        ['sand', 'mud'].includes(terrain.materialAt(x + d))) { ordinary = false; break; }
    if (ordinary) return x;
  }
  throw new Error('The fixed world fixture needs a firm ordinary stretch');
}

for (const model of ['mining-truck', 'truck']) test(`${model}: a saved real vehicle follows ordinary orders in both directions, loaded and after live damage`, { timeout: 90000 }, t => {
  let base;
  const original = rehearsal(() => base); t.after(() => original.field.dispose());
  const place = ordinaryGround(original.world.terrain); base = place - 1000;
  const f = onField(t, original), player = original.join('Rota de teste'), id = f.publish(player, model);
  f.put(id, place); // Ordinary ground outside the base, where a load is not automatically unloaded.
  f.run(1);
  const kept = JSON.parse(JSON.stringify(original.keep())); original.field.dispose();
  const room = new SharedRoom({ kept }), resumed = onField(t, room), squad = room.players.get(player.playerId).squad,
    unit = squad.units.get(id), vehicle = room.world.actor(id).vehicle, start = vehicle.x;
  room.join('Rota de teste', player.token);
  for (const goal of [start + 30, start]) {
    squad.command({ order: 'move', ids: [id], x: goal });
    assert(resumed.until(() => !unit.move, 30), 'the ordinary order completes');
    assert.equal(unit.halt, '', 'ordinary terrain is not refused');
    assert(Math.abs(room.world.actor(id).vehicle.x - goal) < 3, 'the current carrier after turning reaches its place');
  }
  const current = () => room.world.actor(id).vehicle;
  const hopper = resumed.parts(id, 'hopper')[0], unloaded = current().mass,
    amount = Math.min(1000, cargoRoom(hopper) * 2400 / 4);
  resumed.set(hopper, { cargo: { ferro: amount } }); resumed.run(.2);
  assert(current().mass > unloaded + amount * .9, 'the native body accounts for its actual carried mass');
  squad.command({ order: 'move', ids: [id], x: start + 30 });
  resumed.run(.2);
  const before = current().traction;
  for (const gear of resumed.parts(id, 'wheel', 'track')) resumed.set(gear, { health: gear.maxHealth * .4 });
  resumed.run(.2);
  assert(current().traction < before, 'the native mobility reading reflects live running-gear damage');
  assert(resumed.until(() => !unit.move, 30));
  assert.equal(unit.halt, '', 'the damaged but still capable vehicle keeps an ordinary route');
  squad.command({ order: 'control', id });
  assert.equal(squad.decide(squad.side.member(room.world.actor(id))), null, 'taking control bypasses route decisions');
});

// Regression routes from normally published vehicles on the default generated
// world. The former static predictor refused each before its wheels moved. A trip begins at its base, on the asphalt
// there; or, with the base `base` metres behind, off it: the vehicle is published at the base and stood at the start.
// `hop` is the most steps on end it has all its running gear off the ground: over the bumps of the ground
// (game_terrain.rs `Bumps`) its springs may let go of it all for a few steps, as a vehicle thrown off a crest does not.
// Four are some 70 ms: the air that holds a hull back by the side it shows the way it goes (game_motion.rs
// `Powertrain::air`) takes it over a bump a step longer than one held back along the ground alone.
// It is sent where the squad places it (`goal`): sent within the reach of a vein, which every site holds, it stops inside
// that reach (Squad.command 'move'). Stood at the start, it is handed with the world to `prepare`, which may load it.
function driveNormally(t, source, from, to, seconds = 90, base = 0, prepare = () => {}) {
  const steady = { pace: () => 1 }; // Keep route decisions independent of concurrent test CPU load.
  const heading = Math.sign(to - from), room = rehearsal([from - heading * base], undefined, { fog: false }); t.after(() => room.field.dispose());
  const player = room.join('Condução'), id = room.publish(player.playerId, source, { x: from - heading * base, facing: heading }).actor.id,
    world = room.world, vehicle = world.actor(id).vehicle;
  if (base) world.command('setVehicleState', { actorId: id, state: { x: from, y: vehicle.y - world.terrain.height(vehicle.x) + world.terrain.height(from), vx: 0, vy: 0 } });
  prepare(world, id);
  for (let i = 0; i < 180; i++) room.step(steady);
  const squad = room.players.get(player.playerId).squad,
    unit = squad.units.get(id), gear = world.modules.filter(part => part.actorId === id && ['wheel', 'track'].includes(part.kind));
  room.command(player.playerId, { type: 'squad', order: 'move', ids: [id], x: to });
  const goal = unit.move.x, startedAt = world.time;
  let air = 0, hop = 0, maxLean = 0;
  for (let i = 0; i < seconds * 60 && unit.move; i++) {
    if (i % 60 === 0) room.command(player.playerId, { type: 'ping' });
    room.step(steady);
    air = gear.some(part => part.groundContact) ? 0 : air + 1; hop = Math.max(hop, air);
    maxLean = Math.max(maxLean, Math.abs(Math.atan2(Math.sin(vehicle.angle), Math.cos(vehicle.angle))));
  }
  return { room, world, vehicle, squad, unit, hop, maxLean, to, goal, startedAt };
}

for (const [from, to] of [[-107680, -107230], [-107230, -107680]])
  test(`an ordinary scout crosses the known muddy slope ${from} → ${to} without a speculative veto`, { timeout: 90000 }, t => {
    const f = driveNormally(t, createStructuredTemplate('scout'), from, to);
    assert.equal(f.unit.move, null); assert.equal(f.unit.halt, '');
    assert(Math.abs(f.goal - to) <= 30 && Math.abs(f.vehicle.x - f.goal) <= 1.5 && Math.abs(f.vehicle.vx) < 1, 'the normal pilot arrives stopped');
    assert(f.hop <= 4, `off the ground ${f.hop} steps on end`); assert(f.maxLean < .2, 'the existing speed envelope keeps it on the road');
  });

test('a normally authored 30 t truck is let up a muddy climb the static capacity estimate refused, and goes on over it as a driver who floors it', { timeout: 90000 }, t => {
  const source = createStructuredTemplate('truck');
  source.components = source.components.filter(part => part.kind !== 'hopper');
  const roof = source.plates.find(plate => plate.id === 'hull:roof'), previousRoofMm = roof.thicknessMm,
    roofY = (source.nodes.find(node => node.id === roof.a).y + source.nodes.find(node => node.id === roof.b).y) / 2;
  roof.thicknessMm = 650;
  // These are the physical end dimensions of this reinforced regression.
  // Thickening the roof no longer resizes the neighbouring plates or rewrites
  // the roof's own ends; preserve the original stock and aerodynamic profile, on the cells nearest (the rear past the
  // roof by half its 650 mm).
  const reinforcedEnds = {
    'hull:rear': { start: cellOf(.005), end: cellOf(.325) },
    'hull:roof': { start: cellOf(.004), end: 0 },
    'hull:glacis': { start: cellOf(.007692307692307665), end: 0 },
  };
  source.plates = source.plates.map(plate => reinforcedEnds[plate.id]
    ? { ...plate, ends: reinforcedEnds[plate.id] } : plate);
  // Thickening no longer carries unselected equipment. Place the roof sensors
  // on the new outer face explicitly, preserving exact contact without a grid gap.
  source.components = source.components.map(part => part.kind === 'sensor' && part.pose.y > roofY ? { ...part,
    pose: { ...part.pose, y: part.pose.y + (roof.thicknessMm - previousRoofMm) / 2000 / CELL } } : part);
  // The frame has its structural mass, rather than a model's nominal mass.
  // Author the reinforced section that keeps this regression above 30 tonnes.
  source.chassis.thicknessMm = 15;
  // This 36 cm section needs a higher deck than the original 26 cm one.
  // Author the complete test vehicle there explicitly; the section is written
  // directly, so nothing moves with it. On the cell under the one nearest that deck (10 cm over the deck of the model,
  // and 10 cm under where it hangs gear under this frame, as far as its suspension reaches): a cell higher, this
  // deliberately top-heavy fixture rolls over on the ruts before its wheels spin.
  const lift = cellOf(1.2741666666666667 - 1.3) - 1 - source.chassis.points[0].y;
  source.chassis.points = source.chassis.points.map(point => ({ ...point, y: point.y + lift }));
  source.nodes = source.nodes.map(node => ({ ...node, y: node.y + lift }));
  source.components = source.components.map(part => ({ ...part, pose: { ...part.pose, y: part.pose.y + lift } }));
  // The current cab is smaller; a real 55 mm deck keeps this isolated loaded-vehicle assay above 30 t.
  Object.assign(source, withRaisedFloor(source, 55));
  const blueprint = compileBlueprint(source), { origin, centerLocal } = blueprint.fixedAssembly,
    centre = origin.x + centerLocal.x, supports = blueprint.chassis.axles,
    // This deliberately front-heavy roof follows the real frame ride height.
    // Leave a 20% margin to its geometric tipping angle, rather than an absolute angle
    // calibrated to the former, lower body. Gravity acts through the admitted
    // loaded COM and the first/last ground support define the pivot.
    leanLimit = .8 * Math.atan(Math.min(centre - supports[0], supports.at(-1) - centre) / (origin.y + centerLocal.y));
  const f = driveNormally(t, validateStructuredConstruction(source), -213088, -212638);
  assert(f.vehicle.mass > 30000, `reinforced fixture mass: ${f.vehicle.mass}`); assert.equal(f.unit.move, null);
  assert(Math.abs(f.vehicle.drivetrain.powerKw - 240) < 1e-6, 'reinforcing the frame changes no engine power');
  // Its weight lies over its front axles, and its last carries none of it. On the ruts of the mud it rocks on the first
  // two, and as often as the second leaves the ground its wheels pull with half their grip: up the 50 m of mud of the climb
  // they would spin, slowly. Its pilot takes it onto the mud as fast as it goes, as a driver who floors it, and it is
  // carried over to the soil beyond, where it is sent; held to a crawl there, it was stuck halfway.
  assert.equal(f.unit.halt, '', 'the pilot drives it on, not stopping it beforehand');
  assert(Math.abs(f.vehicle.x - f.goal) <= 1.5 && Math.abs(f.vehicle.vx) < 1, 'it is past the mud, stopped where it is sent');
  assert(f.hop <= 10, `off the ground ${f.hop} steps on end`); assert(f.maxLean < leanLimit, `peak body angle ${f.maxLean} rad / stability margin ${leanLimit} rad`);
  assert.equal(f.world.dynamics.recoveries, 0);
});

test('a genuinely underpowered native vehicle still ends an impossible trip with its real mobility reason', { timeout: 90000 }, t => {
  // Off its base: on the asphalt there it rolls easily enough to go.
  // Keep the ordinary cab and equipment poses; only author the genuinely smaller engine inside that supported body: the
  // smallest there is, a quarter as long and tall as the reference and as deep, 11.25 kW, under a hopper full of iron,
  // 0.7 kW to the tonne. Empty, with that engine, it crawls through the mud at 2 m/s.
  const source = createStructuredTemplate('truck');
  source.components.find(part => part.kind === 'engine').sizeScale = .25;
  const f = driveNormally(t, source, -129552, -129252, 20, 1000, (world, id) => {
    const hopper = world.modules.find(part => part.actorId === id && part.kind === 'hopper');
    world.command('setPartState', { owner: world.game().handle(hopper), state: { cargo: { ferro: cargoRoom(hopper) * CARGO.ferro.density } } });
  });
  assert(Math.abs(f.vehicle.drivetrain.powerKw - 11.25) < 1e-6, 'the smallest engine supplies its real 11.25 kW');
  assert.equal(f.unit.move, null); assert.equal(f.unit.halt, 'stuck-ground');
  assert(Math.abs(f.vehicle.x + 129552) < .5, 'no progress was possible despite actual throttle');
  const elapsed = f.world.time - f.startedAt;
  assert(elapsed >= 8 && elapsed < 20, `the progress timeout stays bounded after the order, excluding initial settlement: ${elapsed}`);
});
