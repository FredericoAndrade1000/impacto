import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileDraftConstruction } from '../src/structured-construction.ts';
import { CELL } from '../src/grid.ts';
import { componentDimensions } from '../src/component-size.ts';
import { ARRIVAL, HOLDING, flightFuel, laden, lifts, slingLimit } from '../src/squad.ts';
import { SLING_REACH, slung } from '../src/sling.ts';
import { towReady } from '../src/tow-ui.ts';
import { Publication } from '../server/publication.ts';
import { chapters } from '../server/fog.ts';
import { aircraft, airMiner } from './helpers/aircraft.js';
import { onField } from './helpers/field.js';

await initNativeDynamics();

// An aircraft takes another vehicle up on a sling (game_towing.rs `Tow::sling`), with the order Rebocar from the air and
// Mover as for any aircraft (squad.ts `fly`): on the real field, by its own pilot.

// A light truck: the chassis of the stock truck without its cab, its engine, tank and command post on its bed as on the
// aircraft of the tests (helpers/aircraft.js), on its wheels. It weighs 4.4 t.
function lorry() {
  const source = createStructuredTemplate('chassis');
  Object.assign(source, { plates: [], nodes: [] });
  source.components = source.components.filter(m => m.kind !== 'sensor');
  const bed = compileDraftConstruction(source).plates.find(plate => plate.id === 'chassis:top-0'), floor = bed.y - 1.3 + bed.thicknessMm / 2000,
    part = kind => source.components.find(m => m.kind === kind),
    standing = (piece, x) => { piece.pose = { x: x / CELL, y: (floor + componentDimensions(piece, piece.sizeScale ?? 1).height / 2) / CELL, angle: 0 }; };
  standing(part('engine'), 2.5); standing(part('fuel'), -2.75); standing(part('command'), -1.6);
  return source;
}
// The ore aircraft of the tests without its digger, on the thrusters it has with it (helpers/aircraft.js `airMiner`): what
// they push it up with level — with no torque about its centre of mass, which the front pair of them, nearer it, make less
// of than all they push — takes it up with the truck on its sling and a quarter to spare. The smaller thrusters it has
// without its digger would not: they would hold up the two of them, but not so.
const hopper = () => airMiner({ tool: false, size: 1.15 });
// A field with its base at 0, a player's aircraft of `design` and the light truck, out of automatic, the truck standing
// at 60 m and the aircraft at 20 m, on its skids.
function field(t, design) {
  const f = onField(t, rehearsal([0], undefined, { fog: false })), { room, world } = f, player = room.join('Piloto'),
    air = f.publish(player, design), load = f.publish(player, lorry()), squad = room.players.get(player.playerId).squad;
  room.supplyDispatch.set(air, false); f.order(player, 'control', { id: null });
  f.put(load, 60); f.put(air, 20);
  return { ...f, player, squad, air, load, vehicle: id => world.actor(id).vehicle, unit: () => squad.units.get(air),
    height: id => world.actor(id).vehicle.y - f.ground.height(world.actor(id).vehicle.x),
    // Sent to hover `up` metres over the ground over the truck, and there.
    over(up) {
      const x = world.actor(load).vehicle.x;
      f.order(player, 'move', { ids: [air], x, y: f.ground.height(x) + up });
      assert(f.until(() => !squad.units.get(air).move, 60), 'it hovers over the truck');
      f.run(2);
    },
    attach: () => f.send(player, 'tow', { act: 'attach', actorId: air, targetId: load }) };
}

test('an aircraft takes a light truck up on its sling from a hover, carries it 500 m, sets it down there, lets go of it and lands beside it', { timeout: 180000 }, t => {
  const f = field(t, hopper()), { room, world, ground, until, vehicle, unit, air, load } = f;
  assert(slingLimit(world, air) > vehicle(load).mass, `${slingLimit(world, air)} kg for ${vehicle(load).mass} kg`);
  f.over(11);
  assert.equal(towReady({ actors: world.actors, plates: world.plates }, air, load), null, 'the page asks the field of an aircraft');
  assert.deepEqual(f.attach(), { towing: true });
  const cable = world.tows[0];
  assert(cable.sling && cable.length > 3 && cable.length <= SLING_REACH, JSON.stringify(cable));
  assert.equal(slung(world, air).id, load);
  assert.equal(vehicle(load).brake, 1, 'the load stands on its brakes');
  // Its faction is told it is a sling, and where the bridle holds the truck, to draw it by: on either side of the ring,
  // under it.
  const publication = new Publication(), told = factionId => {
    const state = world.snapshot(s => publication.state(s));
    return room.audience(state, chapters(state), [], factionId).state.tows;
  }, [row] = told(room.players.get(f.player.playerId).factionId), ring = row.anchorB, [left, right] = [...row.bridle ?? []].sort((a, b) => a.x - b.x);
  assert(row.sling && row.bridle.length === 2 && left.x < ring.x - 1 && right.x > ring.x + 1 && [left, right].every(end => end.y < ring.y - .5), JSON.stringify(row));
  // Carried 500 m along the field and hovered there, it hangs clear of the ground all the way, level enough, and the
  // cable holds. Its fuel return is off: what it has left is reckoned short of taking the two of them there and home with
  // its reserve (fuel-return.test.js), and this is of how it carries the truck.
  f.send(f.player, 'homing', { actorId: air, on: false });
  const goal = vehicle(load).x + 500, seen = { lowest: Infinity, tilt: 0, peak: 0, off: false };
  f.order(f.player, 'move', { ids: [air], x: goal, y: ground.height(goal) + 15 });
  const carried = until(() => {
    const tow = world.tows[0], up = f.height(load);
    if (tow) seen.peak = Math.max(seen.peak, tow.tension);
    if (up > 3) seen.off = true;
    if (seen.off) { seen.lowest = Math.min(seen.lowest, up); seen.tilt = Math.max(seen.tilt, Math.abs(vehicle(load).angle)); }
    return !unit().move && world.tows.length === 1;
  }, 150);
  t.diagnostic(JSON.stringify({ time: world.time, ...seen, loadX: vehicle(load).x, airX: vehicle(air).x }));
  assert(carried && world.tows.length === 1, 'it carried it there on its sling');
  assert(Math.abs(vehicle(air).x - goal) <= ARRIVAL && Math.abs(vehicle(load).x - goal) < 4, `${vehicle(air).x} / ${vehicle(load).x} for ${goal}`);
  assert(seen.lowest > 2 && seen.tilt < .6 && seen.peak < 2.5 * vehicle(load).mass * 9.81, JSON.stringify(seen));
  // Sent down there, it sets the truck down, lets go of it and lands clear of it.
  f.order(f.player, 'move', { ids: [air], x: goal });
  let touch = null;
  const landed = until(() => {
    if (touch === null && world.tows.length && world.tows[0].tension < .05 * vehicle(load).mass * 9.81 && f.height(load) < 2) touch = vehicle(load).vy;
    return !unit().move;
  }, 90);
  const gap = Math.abs(vehicle(air).x - vehicle(load).x);
  t.diagnostic(JSON.stringify({ time: world.time, touch, gap, loadX: vehicle(load).x, airX: vehicle(air).x }));
  assert(landed && !vehicle(air).flying, 'it landed');
  assert.deepEqual(world.tows, [], 'it let go of the truck');
  assert(Math.abs(vehicle(load).x - goal) < 15 && f.height(load) < 2 && Math.abs(vehicle(load).vx) < .1, 'the truck stands there');
  assert(touch !== null && touch > -1, `set down at ${touch} m/s`);
  assert(gap > 8, `it came down clear of it: ${gap} m apart`);
  assert.equal(vehicle(load).brake, 1);
  assert.equal(world.dynamics.recoveries, 0); assert.deepEqual([...room.faults], []);
});

test('an aircraft is refused a load its thrusters do not take up with a quarter to spare, in words, and is told how far to hover from one', { timeout: 120000 }, t => {
  const f = field(t, aircraft()), { world, vehicle, air, load } = f;
  f.over(11);
  const limit = slingLimit(world, air);
  assert(limit > 3000 && limit < vehicle(load).mass, `${limit} kg`);
  assert.throws(() => f.attach(), error => error.code === 'TOW_HEAVY' &&
    /^Pesado demais para os propulsores: a aeronave ergue até 3,\d t além do próprio peso, e o veículo pesa 4,4 t\.$/.test(error.message));
  assert.deepEqual(world.tows, []);
  // The hopper aircraft on the smaller thrusters it has without its digger: all they push it up with would take it up with
  // the truck and a quarter to spare, but not with no torque about its centre of mass, under which the truck hangs. Its
  // pilot reckons by that (`lifts` with `HOLDING`), and the core is to refuse it as he would (game_towing.rs `tow_lift`).
  const e = field(t, airMiner({ tool: false })), turn = e.vehicle(e.air).angle,
    pushed = e.parts(e.air, 'thruster').reduce((sum, m) => sum + m.thrustN * Math.max(0, Math.cos(m.angle - turn)), 0),
    pair = laden(e.world, e.air) + e.vehicle(e.load).mass;
  e.over(11);
  assert(pushed > HOLDING * pair * 9.81 && slingLimit(e.world, e.air) < e.vehicle(e.load).mass, `${pushed} N for ${pair} kg`);
  assert.throws(() => e.attach(), error => error.code === 'TOW_HEAVY');
  assert(!lifts(e.world, e.air, HOLDING * pair / laden(e.world, e.air)), 'its pilot would not take it up');
  assert.deepEqual(e.world.tows, []);
  // Too high over a load it may take up: the hopper aircraft 25 m over the truck.
  const g = field(t, hopper());
  g.over(25);
  assert.throws(() => g.attach(), error => error.code === 'TOW_REACH' && error.message === `Paire a até ${SLING_REACH} m sobre o veículo para conectar o cabo.`);
});

test('the pilot of an aircraft counts what hangs from its sling: what its thrusters lift, the fuel it burns and the way home for it', { timeout: 180000 }, t => {
  // The hopper aircraft hovering 400 m off its base, with the truck on its sling or not, with the fuel in one of its tanks
  // that takes it home empty, and to spare, but not with the truck: what its pilot reckons on, and whether he sends it home.
  const out = loaded => {
    const f = field(t, hopper()), { world, run, until, vehicle, unit, air, load } = f;
    f.over(11);
    if (loaded) f.attach();
    const blueprint = world.actor(air).blueprint, x = 400;
    f.order(f.player, 'move', { ids: [air], x, y: f.ground.height(x) + 18 });
    assert(until(() => !unit().move, 150), 'it hovers there');
    // Its tank let down at once: its reading of what it burns starts over (aircraft-work.test.js); what it burns a second
    // over the 3 s after.
    f.parts(air, 'fuel').forEach((tank, i) => f.set(tank, { fuelLitres: i ? 0 : 120 }));
    unit().burn = null; run(3);
    return { home: unit().move?.land === 'fuel', rate: (120 - vehicle(air).fuelLitres) / 3, laden: laden(world, air), own: vehicle(air).mass, load: vehicle(load).mass,
      lifts: lifts(world, air), fuel: flightFuel(blueprint, laden(world, air), 60), hangs: Boolean(slung(world, air)) };
  };
  const [carrying, empty] = [out(true), out(false)];
  t.diagnostic(JSON.stringify({ carrying, empty }));
  assert(carrying.hangs && !empty.hangs);
  assert.equal(carrying.laden, carrying.own + carrying.load, 'it weighs with the truck');
  assert.equal(empty.laden, empty.own);
  assert(carrying.lifts && empty.lifts, 'its thrusters lift it and the truck');
  assert(carrying.fuel > 1.8 * empty.fuel, 'it reckons on burning nearly twice as much on a way it has not flown');
  assert(carrying.rate > 1.6 * empty.rate, 'and it burns so');
  assert(carrying.home && !empty.home, 'carrying the truck it is sent home for its fuel, where empty it is not');
});