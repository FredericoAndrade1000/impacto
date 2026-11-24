import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { nativeRuntimeInfo } from '../scripts/native-dynamics-host.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { AIR_DENSITY, RATED_ALTITUDE, SCALE_HEIGHT, airDensity, thinning, thrustAltitude, thrustShare } from '../src/atmosphere.ts';
import { firingSolution, flightPath, flightState } from '../src/ballistics.ts';
import { fixedWeapon } from '../src/weapons.ts';
import { ShotTable, tellAll } from '../src/shot-forecast.ts';
import { packShots } from '../src/shots.ts';
import { rehearsal } from '../server/room.ts';
import { ceiling, lifts, HOLDING } from '../src/squad.ts';
import { aircraft, gunship, airMiner, airSupply, airBuilder } from './helpers/aircraft.js';
import { onField } from './helpers/field.js';

await initNativeDynamics();

// The 155 mm howitzer at its top charge, on its low arc or its high one.
const howitzer = (trajectory = 'high') => fixedWeapon({ preset: 'm777', trajectory, charge: 1 });
// How far a gun laid by `settings` on its low arc reaches, level, from a muzzle `y` metres over sea level: by halving,
// for a point nearer than its reach is in it.
function reach(settings, y = 0) {
  let near = 0, beyond = 200000;
  for (let i = 0; i < 30; i++) { const far = (near + beyond) / 2; if (firingSolution({ x: 0, y }, { x: far, y }, settings).reachable) near = far; else beyond = far; }
  return near;
}

test('the page has the atmosphere of the core, to the numbers the shared fixture holds', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/atmosphere-parity.json', import.meta.url)));
  for (const row of fixture.heights) {
    assert.equal(airDensity(row.altitude), row.density, `${row.altitude} m`);
    assert(Math.abs(thrustShare(row.altitude) - row.thrustShare) <= 1e-15 * row.thrustShare, `${row.altitude} m`);
  }
  for (const row of fixture.thinning) assert.equal(thinning(row.from, row.to), row.share, `${row.from} → ${row.to} m`);
  // A scale height up, 1/e of the density. A jet gives all its thrust up to 1 km, over the ground of a field, and the
  // highest it gives a share of it at is where it does; it gives all of it there, and more nowhere.
  assert(Math.abs(airDensity(SCALE_HEIGHT) * Math.E - AIR_DENSITY) < 1e-12);
  for (const altitude of [-500, 0, 700, RATED_ALTITUDE]) assert.equal(thrustShare(altitude), 1, `${altitude} m`);
  assert(thrustShare(RATED_ALTITUDE + 1) < 1);
  for (const share of [.9, .5, .2]) assert(Math.abs(thrustShare(thrustAltitude(share)) - share) < 1e-12, `${share}`);
  assert.equal(thrustAltitude(1), RATED_ALTITUDE); assert.equal(thrustAltitude(1.3), -Infinity);
});

test('a high arc into thin air still comes down on the point it was laid on, and a muzzle up a mountain reaches further', t => {
  const settings = howitzer(), far = reach(howitzer('low')), mountain = reach(howitzer('low'), 2000);
  // Fired from sea level, the shell goes as far as the real one, 22.4 km (weapons.ts `drag`); from 2 km up, through
  // thinner air all the way, further.
  assert(Math.abs(far - 22424) < 50, `${far} m`);
  assert(mountain > far * 1.05, `${mountain} m from 2 km up, ${far} m from sea level`);
  const target = { x: 20000, y: 0 }, solution = firingSolution({ x: 0, y: 0 }, target, settings);
  assert(solution.reachable && solution.apex > 10000 && solution.time > 80, JSON.stringify({ apex: solution.apex, time: solution.time }));
  const end = flightPath(solution, 512).at(-1);
  assert(Math.hypot(end.x - target.x, end.y - target.y) < .1, `the forecast lands ${Math.hypot(end.x - target.x, end.y - target.y)} m off`);
  // The round the field flies, step by step, is where the forecast has it all the way up and down.
  const info = nativeRuntimeInfo(), Core = info.runtime === 'native' ? createRequire(import.meta.url)(info.binary).NativeWorld : null;
  return (async () => {
    const Binding = Core || (await import('../src/native/battle_dynamics.js')).NativeWorld, core = new Binding(new Float64Array(), 0, -9.81);
    t.after(() => core.free());
    core.load_game(JSON.stringify({ terrain: 'flat', seed: 61, visualEvents: false, actors: [], modules: [], plates: [],
      bounds: { minX: -1000, maxX: 40000, minY: -100, maxY: 40000 } }));
    const command = request => JSON.parse(core.game_command(JSON.stringify(request))).result;
    command({ op: 'projectile', projectile: { ...settings, id: 'arc', numericId: 7, weapon: settings.id, x: solution.x, y: solution.y,
      vx: solution.vx, vy: solution.vy, power: settings.power, age: 0, flight: solution.flight } });
    let worst = 0;
    for (let step = 1; step <= Math.floor((solution.time - 1) * 60); step++) {
      core.game_step(1 / 60);
      if (step % 300) continue;
      const [round] = command({ op: 'projectiles' }), forecast = flightState(solution, step / 60);
      worst = Math.max(worst, Math.hypot(round.x - forecast.x, round.y - forecast.y));
    }
    assert(worst < .05, `the round strays ${worst} m from its forecast`);
  })();
});

test('a screen follows a round up into thin air as the core flies it', () => {
  const settings = howitzer(), solution = firingSolution({ x: 0, y: 0 }, { x: 20000, y: 0 }, settings),
    { mass, caliberMm, dragCoefficient } = solution.flight, diameter = caliberMm * .001,
    drag = AIR_DENSITY * dragCoefficient * Math.PI * diameter * diameter / (8 * mass),
    block = packShots([{ number: 1, x: solution.x, y: solution.y, vx: solution.vx, vy: solution.vy, age: 0, weapon: 'howitzer', preset: 'm777', radius: .08 }]),
    table = new ShotTable();
  assert(table.mend([], tellAll(block.data, Float64Array.of(drag)), []));
  // Told every twentieth of a second, as a host tells a frame: within the three centimetres a screen is let stray.
  let worst = 0, highest = 0;
  for (let time = .05; time < solution.time - 1; time += .05) {
    table.advance(.05);
    const forecast = flightState(solution, table.flight[4]);
    worst = Math.max(worst, Math.hypot(table.flight[0] - forecast.x, table.flight[1] - forecast.y));
    highest = Math.max(highest, table.flight[1]);
  }
  assert(highest > 10000, `${highest} m`);
  assert(worst < .03, `${worst} m off the core`);
});

test('an aircraft sent 47 km up climbs no higher than its thrusters, jets in thin air, hold it up as its pilot flies it', { timeout: 180000 }, t => {
  // The ceilings of the designs the pilots' tests fly: where their pilot flies them to at the most, their thrusters
  // holding them up a quarter more than they weigh (`ceiling`), and where they hold them up no more than once over, as
  // high again as the thrust of a jet takes to fall by that quarter over 1 km (`flies`): 10.8 to 13.1 km for the three
  // that fight or carry, which lift 2.2 to 2.7 times what they weigh at sea level.
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    ceilings = {};
  for (const [name, design] of Object.entries({ aircraft, gunship, airMiner, airSupply, airBuilder })) {
    const id = f.publish(alice, design()), top = ceiling(world, id);
    ceilings[name] = { id, top, flies: top + thrustAltitude(1 / HOLDING) - thrustAltitude(1) };
  }
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(ceilings).map(([name, c]) => [name, { flies: Math.round(c.flies), pilot: Math.round(c.top) }]))));
  for (const name of ['aircraft', 'gunship', 'airSupply'])
    assert(ceilings[name].flies > 9500 && ceilings[name].flies < 15000 && ceilings[name].top < ceilings[name].flies - 2000, `${name}: ${JSON.stringify(ceilings[name])}`);
  const id = ceilings.aircraft.id, vehicle = () => world.actor(id).vehicle, squad = room.players.get(alice.playerId).squad, top = ceilings.aircraft.top,
    tanks = f.parts(id, 'fuel'), full = tanks.map(m => m.fuelLitres);
  f.order(alice, 'control', { id: null }); run(.5);
  const goal = vehicle().x + 1000 * Math.sign(400 - vehicle().x);
  // Its fuel return off: it is reckoned to climb all the 47 km it is sent to (squad.ts `flightLitres`), which its tank does not take.
  f.send(alice, 'homing', { actorId: id, on: false });
  f.order(alice, 'move', { ids: [id], x: goal, y: ground.height(goal) + 47000 });
  assert(until(() => vehicle().flying && vehicle().y > ground.height(vehicle().x) + 20, 30), 'it took off');
  // Put some way under its ceiling, with its tanks kept full so that it weighs the same all the way (what it burns lowers
  // the ceiling of this one, its centre of mass going back with the fuel), it climbs to it on its way, swings a little
  // past it as it leans into its way — under where its thrusters would barely hold it up by far — and stops there, still
  // lifted with room to spare, its order done.
  world.command('setVehicleState', { actorId: id, state: { y: top - 400, vy: 0 } });
  let highest = -Infinity;
  const done = until(() => {
    tanks.forEach((tank, i) => f.set(tank, { fuelLitres: full[i] }));
    highest = Math.max(highest, vehicle().y);
    return !squad.units.get(id).move;
  }, 120);
  assert(done, `still going at ${vehicle().y.toFixed(0)} m, ${vehicle().vy.toFixed(2)} m/s`);
  assert(highest < top + 150 && Math.abs(vehicle().y - top) < 20 && Math.abs(vehicle().x - goal) < 2,
    `${vehicle().y.toFixed(1)} m, ${highest.toFixed(1)} at the highest, for ${top.toFixed(1)}`);
  assert(vehicle().flying && lifts(world, id, HOLDING * .99), 'its thrusters still hold it up there with room to spare');
});
