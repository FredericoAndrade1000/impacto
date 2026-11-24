import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { rehearsal } from '../server/room.ts';
import { fieldParts } from '../src/economy.ts';
import { Squad, descentCost, fuelRefused } from '../src/squad.ts';
import { translate } from '../src/i18n.ts';
import { onField } from './helpers/field.js';
import { aircraft } from './helpers/aircraft.js';

await initNativeDynamics();

// The fuel return of an aircraft (squad.ts `homeward`, `homeFuel`, `fuelRefusal`): it reckons the whole way home — along the
// field, up where home stands higher and down from as high as it is (`descentCost`) —, and, while it keeps its fuel to come
// home (Volta automática à base, `homing`), it takes no order of the player's that would leave it short of that.

// The pilot of an aircraft read alone, on a field of none: it hangs where it is, `height` metres over the ground there, at
// `at` along the field, burning 2 L/s — and holding itself up so, as it was built —, read as its pilot reads it each tenth of
// a second for `seconds` — or going `speed` m/s on away from home and burning `burns` a second, its tank let down to
// `drop.to` at `drop.at` seconds. Its base stands at 0, 50 m to either side, on ground as high as `ground` has it. Whether it was sent
// home for its fuel, and what its pilot reckoned it needed for that as it started (`homeFuel`, `reserve`): its two thrusters,
// upright either side of its middle, hold it up level by twice its weight and burn a tenth of a litre a second idling; the
// air holds it back falling to some 44 m/s, and, going along the field leant to 60° — its belly to the air —, to some
// 59 m/s, burning twice what holds it up.
const BLUEPRINT = { flight: { hoverLitres: 2, liftN: 2 * 1000 * 9.81, idleLitres: .1 }, fixedAssembly: { mass: 1000 }, powertrain: { dragUnder: 5 } };
function hanging({ litres, height, at = 0, ground = () => 0, homing = true, seconds = 3, speed = 0, burns = 2, drop = null }) {
  const vehicle = { flying: true, thrustN: 1, x: at, y: ground(at) + height, vx: speed, angle: 0, mass: 1000, fuelLitres: litres,
      drivetrain: { drag: 1, dragAstern: 1, dragUnder: 5, dragOver: 5 } },
    modules = [-1, 1].map(side => ({ actorId: 'a', kind: 'thruster', health: 1, thrustN: 9810, angle: 0, x: at + side, y: vehicle.y })),
    world = { time: 0, terrain: { height: ground }, modules, actor: () => ({ vehicle, blueprint: BLUEPRINT, facing: 1 }) },
    squad = Object.assign(Object.create(Squad.prototype), { side: { world, depot: () => ({ x: 0, radius: 50 }), homing: () => homing },
      position: () => vehicle.x, land(id, why) { this.landed = why; } }), unit = {}, need = squad.homeFuel('a') + squad.reserve('a');
  for (let step = 0; step <= seconds * 10 && !squad.landed; step++) {
    // Let down, it is not read as burning what it was let down by.
    if (drop && Math.abs(world.time - drop.at) < .05) { unit.burn.litres -= vehicle.fuelLitres - drop.to; vehicle.fuelLitres = drop.to; }
    squad.homeward('a', unit);
    world.time += .1; vehicle.fuelLitres -= burns * .1; vehicle.x += speed * .1;
    for (const m of modules) m.x += speed * .1;
  }
  return { landed: squad.landed, need, scale: unit.burn?.scale ?? null, left: vehicle.fuelLitres, x: vehicle.x,
    later: squad.homeFuel('a', unit.burn) + squad.reserve('a') };
}

test('an aircraft high over its base reckons the way down home: 35.6 km up it turns home short of coming down, as it did not along the field alone', () => {
  // Right over its base the way along the field is none, and it once needed only its reserve to spare: 15 s of what holds it
  // up, 30 L.
  const far = descentCost(BLUEPRINT, 1000, 35600).litres;
  assert(far > 0, 'coming down 35.6 km burns fuel');
  assert.equal(hanging({ litres: far + 25, height: 35600 }).landed, 'fuel', `${far.toFixed(0)} L to come down 35.6 km are reckoned`);
  // At 300 m it turns home once what it has is short of coming down and the reserve.
  const down = descentCost(BLUEPRINT, 1000, 300).litres, need = down + 30;
  assert(down > 0, 'coming down burns fuel');
  assert(Math.abs(hanging({ litres: 1e6, height: 300 }).need - need) < 1e-6);
  assert.equal(hanging({ litres: need + 20, height: 300 }).landed, undefined, `${(need + 20).toFixed(0)} L takes it down with ${need.toFixed(0)} L to spare`);
  assert.equal(hanging({ litres: need - 5, height: 300 }).landed, 'fuel');
  // 2 km off at its floor, the 2 km to the middle of its base, where it is sent to come down, are reckoned as it is flown
  // there, flat out leant into its way against the air: more than it burns cruising there, 0.07 L/m, and less than holding
  // itself up for as long as it would take at the 15 m/s it was once reckoned at, 270 L.
  const flat = hanging({ litres: 1e6, height: 6, at: 2000 }).need - descentCost(BLUEPRINT, 1000, 6).litres - 30;
  assert(flat > 2000 * .067 && flat < 2000 / 15 * 2, `${flat.toFixed(0)} L along the field`);
  // A base on ground 500 m higher: climbing there is reckoned too, as it climbs flat out against the air on its top — no
  // faster than 44 m/s, so for 11 s of holding itself up at the least —, and it turns home with what took it home before.
  const plateau = x => Math.abs(x) <= 100 ? 500 : 0, high = hanging({ litres: 1e6, height: 6, at: 2000, ground: plateau }).need,
    low = hanging({ litres: 1e6, height: 6, at: 2000 }).need, between = (low + high) / 2;
  assert(high - low > 500 / Math.sqrt(1000 * 9.81 / 5) * 2, `${(high - low).toFixed(0)} L to climb 500 m`);
  assert.equal(hanging({ litres: between, height: 6, at: 2000 }).landed, undefined);
  assert.equal(hanging({ litres: between, height: 6, at: 2000, ground: plateau }).landed, 'fuel');
  // With the fuel return off, it is never sent home for its fuel, whatever it has.
  assert.equal(hanging({ litres: 230, height: 35600, homing: false }).landed, undefined);
  assert.equal(hanging({ litres: 1, height: 300, homing: false }).landed, undefined);
});

// What an aircraft burns going home is reckoned as it is flown there, flat out against the air, and as it was read to burn
// cruising (`scale`): one that crosses the field fast is not called back while it still holds a good deal more than takes it
// home, as it was when its way home was reckoned at 15 m/s; one read burning less than reckoned is reckoned to burn so on the
// way home. The pilot is read alone, on a field of none, at its floor over level ground, 10 km off its base.
test('an aircraft going fast is called home for its fuel by what it burns flying as it was read cruising, not at a walking pace', () => {
  // Hanging there, never read cruising: as its thrusters would fly it home — 0.07 L/m at 59 m/s, and a fifth more for what
  // is not reckoned —, far under the 1 400 L 10 km at 15 m/s took.
  const still = hanging({ litres: 1e6, height: 6, at: 10000, seconds: 0 });
  assert(still.need > 10000 * .067 && still.need < 1000, `${still.need.toFixed(0)} L hanging`);
  // Flying on away from home at 50 m/s for 15 s, burning 2 L/s: 0.04 L/m, read as cruising, where it was reckoned to burn
  // some 0.063 L/m. What takes it home with its reserve then: the 10.8 km as it was read to burn, and the 120 m or so it goes
  // on as it is slowed to turn back.
  const fast = hanging({ litres: 1e6, height: 6, at: 10000, speed: 50, seconds: 16 }), way = fast.x;
  assert(fast.scale > .55 && fast.scale < .7, `read at ${fast.scale.toFixed(2)} of what it was reckoned to burn`);
  assert(fast.later > way * .04 + 30 && fast.later < still.need, `${fast.later.toFixed(0)} L from ${(way / 1000).toFixed(1)} km`);
  // Let down to a little more than that, it is not called back; to a little less, it is.
  assert.equal(hanging({ litres: 1e6, height: 6, at: 10000, speed: 50, seconds: 16, drop: { at: 15, to: fast.later + 12 } }).landed, undefined);
  assert.equal(hanging({ litres: 1e6, height: 6, at: 10000, speed: 50, seconds: 16, drop: { at: 15, to: fast.later - 8 } }).landed, 'fuel');
});

// A field with a player's aircraft published at the base, out of the hands of the player, and a truck: the aircraft, its
// squad, its fuel, its base, how high it is over the ground, and the switch of its fuel return.
function airfield(t) {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground } = f, alice = room.join('Alice'),
    id = f.publish(alice, aircraft()), truck = f.publish(alice, 'truck'), squad = room.players.get(alice.playerId).squad,
    faction = room.faction(room.players.get(alice.playerId)), base = room.depot(faction, faction.base.x), vehicle = () => world.actor(id).vehicle;
  f.order(alice, 'control', { id: null }); f.run(.5);
  return { ...f, alice, id, truck, squad, faction, base, vehicle, toward: Math.sign(400 - base.x),
    unit: () => squad.units.get(id), litres: () => vehicle().fuelLitres, fill: litres => f.set(f.parts(id, 'fuel')[0], { fuelLitres: litres }),
    height: () => vehicle().y - ground.height(vehicle().x), home: () => Math.abs(vehicle().x - base.x) <= base.radius,
    homing: on => f.send(alice, 'homing', { actorId: id, on }), told: () => room.units(faction, fieldParts(world)).find(unit => unit.id === id) };
}

test('an aircraft hanging high over its base with less fuel than coming down takes is sent home, and comes down there with fuel left', { timeout: 180000 }, t => {
  const f = airfield(t), { world, ground, run, until, alice, id } = f;
  f.order(alice, 'move', { ids: [id], x: f.vehicle().x, y: ground.height(f.vehicle().x) + 30 });
  assert(until(() => !f.unit().move, 60) && f.vehicle().flying && f.home(), 'it hovers over its base');
  // As high as coming down from there burns half its tank — 3 km up at the most —, and with a litre more than that.
  const actor = world.actor(id), tank = f.parts(id, 'fuel')[0].capacityLitres, burns = h => descentCost(actor.blueprint, f.vehicle().mass, h, ground.height(f.vehicle().x)).litres;
  let low = 10, high = 3000;
  if (burns(high) > tank / 2) for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (burns(mid) > tank / 2) high = mid; else low = mid; }
  world.command('setVehicleState', { actorId: id, state: { y: ground.height(f.vehicle().x) + high, vx: 0, vy: 0 } });
  f.fill(burns(high) + 1);
  assert(until(() => f.unit().move?.land === 'fuel', 5), `${f.litres().toFixed(0)} L at ${f.height().toFixed(0)} m over its base: it turns home for its fuel`);
  assert(until(() => !f.vehicle().flying, 170), `still ${f.height().toFixed(0)} m up`);
  assert(f.home() && f.litres() > 0, `down at ${f.vehicle().x.toFixed(1)} with ${f.litres().toFixed(1)} L`);
});

test('with its fuel return on an aircraft takes no order that would leave it short of the way home; off, it takes every one', { timeout: 180000 }, t => {
  const f = airfield(t), { ground, run, until, alice, id, truck, toward } = f, near = f.vehicle().x + 20 * toward, far = f.vehicle().x + 5000 * toward,
    sky = x => ({ x, y: ground.height(x) + 30 }), move = (x, ids = [id]) => f.order(alice, 'move', { ids, ...sky(x) });
  assert.deepEqual([f.told().homing, f.room.units(f.faction, fieldParts(f.world)).find(unit => unit.id === truck).homing], [true, undefined],
    'an aircraft keeps its fuel to come home by default; what does not fly has no such switch');
  assert.throws(() => f.send(alice, 'homing', { actorId: truck, on: false }), /Selecione uma aeronave/);
  assert.throws(() => f.send(alice, 'homing', { actorId: id, on: 'no' }), /volta automática inválido/);
  move(near);
  assert(until(() => !f.unit().move, 60) && f.vehicle().flying, 'it hovers 30 m up by its base');
  // Its tank, full, does not take it 5 km out and back: the order is refused, in a few words, and it hovers on where it was.
  assert.throws(() => move(far), new RegExp('^Error: ' + translate(fuelRefused(['short'], 1), 'pt-BR') + '$'));
  assert.equal(f.unit().move, null);
  for (const order of [{ order: 'bombard', point: sky(far) }, { order: 'move', x: far }])
    assert.throws(() => f.order(alice, order.order, { ids: [id], ...order }), /Sem combustível para ir e voltar à base · ordem recusada pela volta automática/);
  // A truck sent with it goes; the aircraft stays, and the player is told of it alone.
  const told = move(far, [id, truck]);
  assert.deepEqual(told, { refused: fuelRefused(['short'], 2), held: [id] });
  assert.equal(translate(told.refused, 'pt-BR'), 'Ordem recusada para 1 aeronave pela volta automática: sem combustível para ir e voltar à base.');
  assert.equal(translate(told.refused, 'en'), 'Order refused for 1 aircraft by the automatic return: not enough fuel to go there and back to base.');
  assert.equal(f.unit().move, null); assert(f.squad.units.get(truck).move, 'the truck goes');
  f.order(alice, 'stop', { ids: [truck] });
  // Near by, it goes.
  assert.deepEqual(move(near + 10 * toward), {}); assert(f.unit().move);
  // On its way home for its fuel — left with no more than its reserve — it takes nothing but Base: neither another way, nor
  // Parar.
  f.fill(f.squad.reserve(id));
  assert(until(() => f.unit().move?.land === 'fuel', 5), 'it turns home for its fuel');
  assert.throws(() => move(near), /^Error: Voltando à base para reabastecer · ordem recusada pela volta automática\.$/);
  assert.throws(() => f.order(alice, 'stop', { ids: [id] }), /Voltando à base para reabastecer/);
  assert.equal(f.unit().move?.land, 'fuel', 'it goes on home');
  assert.deepEqual(f.order(alice, 'home', { ids: [id] }), {}); assert.equal(f.unit().move?.land, 'order');
  // Off: it takes the order it refused, and with the fuel of nowhere near the way there and back it goes on, not home.
  f.homing(false);
  assert.equal(f.told().homing, false);
  assert.deepEqual(move(far), {});
  run(4);
  assert(f.unit().move && !f.unit().move.land && Math.abs(f.unit().move.x - far) < 20, `it flies on out, at ${f.vehicle().x.toFixed(0)}`);
  // Back on, its pilot turns it home at once.
  f.homing(true);
  assert(until(() => f.unit().move?.land === 'fuel', 3), 'on again, it turns home for its fuel');
});

// The aircraft of the field above flying out of its base fast: sent 6 km out at 30 m over the ground with its fuel return
// off, and switched back on as it is 800 m out at some 80 m/s — faster than the 184 km/h of the one of the player whose
// order was refused on such a way —, read cruising and with some 165 L of its 202 left; and the point of the sky 30 m over
// the ground at `x`.
function cruising(t) {
  const f = airfield(t), { ground, until, alice, id, base, toward } = f, sky = x => ({ x, y: ground.height(x) + 30 });
  f.homing(false);
  f.order(alice, 'move', { ids: [id], ...sky(base.x + toward * 6000) });
  assert(until(() => Math.abs(f.vehicle().x - base.x) > 800, 60), 'it flies out');
  f.homing(true);
  assert(Math.abs(f.vehicle().vx) > 70 && f.unit().burn?.scale > 0, `at ${f.vehicle().vx.toFixed(0)} m/s, read cruising`);
  return { ...f, sky };
}

// Its way there and back is reckoned as it is flown, by what its thrusters give against the air at the speed they fly it at
// (squad.ts `cruise`, `flightLitres`): it takes an order 1.5 km out and back, which reckoned as it was — at 15 m/s, burning
// half again what holds it up — would have taken 360 L, more than its tank holds, and it flies it and lands home with its
// reserve to spare.
test('an aircraft crossing the field fast takes an order out and back it has the fuel for, and lands home with its reserve', { timeout: 180000 }, t => {
  const f = cruising(t), { until, alice, id, base, toward } = f, tank = f.parts(id, 'fuel')[0].capacityLitres, had = f.litres();
  assert(1500 * 2 / 15 * f.squad.reserve(id) / 15 * 1.5 > tank, 'at a walking pace it was refused');
  assert.deepEqual(f.order(alice, 'move', { ids: [id], ...f.sky(base.x + toward * 1500) }), {});
  assert(until(() => !f.unit().move, 60) && f.vehicle().flying, 'it gets there');
  f.order(alice, 'home', { ids: [id] });
  assert(until(() => !f.vehicle().flying, 120), 'it comes down');
  assert(f.home() && f.litres() >= f.squad.reserve(id), `down at ${f.vehicle().x.toFixed(0)} with ${f.litres().toFixed(1)} L of the ${had.toFixed(1)} L it set out with`);
});

// And a way its fuel does not take it out and back on is refused all the same: 4 km out. Switched off, it takes it, and,
// flown there and home, it runs dry short of home.
test('an aircraft crossing the field fast is still refused an order out and back its fuel does not take it on, and off it does not get home from it', { timeout: 180000 }, t => {
  const f = cruising(t), { until, alice, id, base, toward } = f, move = () => f.order(alice, 'move', { ids: [id], ...f.sky(base.x + toward * 4000) });
  assert.throws(move, new RegExp('^Error: ' + translate(fuelRefused(['short'], 1), 'pt-BR') + '$'));
  f.homing(false);
  assert.deepEqual(move(), {});
  until(() => !f.unit().move || !(f.litres() > 0), 120);
  if (f.litres() > 0) f.order(alice, 'home', { ids: [id] });
  assert(until(() => !f.vehicle().flying, 200), 'it comes down');
  assert(!(f.litres() > 0) && !f.home(), `down at ${f.vehicle().x.toFixed(0)}, ${(f.vehicle().x - base.x).toFixed(0)} m off its base, with ${f.litres().toFixed(1)} L`);
});

// Flown on out with its fuel return on, it is turned home by its pilot while it cruises away (`homeward`) — slowed and
// turned back, as reckoned —, and it lands home with its reserve.
test('an aircraft flown on out fast is turned home for its fuel in time, and lands there with its reserve', { timeout: 180000 }, t => {
  const f = cruising(t), { until, id, base } = f;
  assert(until(() => f.unit().move?.land === 'fuel', 120), 'its pilot turns it home');
  const turned = { off: Math.abs(f.vehicle().x - base.x), vx: Math.abs(f.vehicle().vx), litres: f.litres() };
  assert(turned.off > 1500 && turned.vx > 50, `turned home ${turned.off.toFixed(0)} m out at ${turned.vx.toFixed(0)} m/s`);
  assert(until(() => !f.vehicle().flying, 150), 'it comes down');
  assert(f.home() && f.litres() >= f.squad.reserve(id), `down at ${f.vehicle().x.toFixed(0)} with ${f.litres().toFixed(1)} L of the ${turned.litres.toFixed(1)} L it turned with`);
});

test('the fuel return of an aircraft, switched off, is kept with the field and resumed so; the field written before it is on', { timeout: 120000 }, t => {
  const f = airfield(t), { room, id } = f;
  f.homing(false);
  const kept = JSON.parse(JSON.stringify(room.keep())), record = kept.records.find(([actorId]) => actorId === id)[1];
  assert.equal(record.homing, false, 'kept off');
  const again = onField(t, rehearsal([-100, 400], undefined, { kept })), faction = again.room.factions.get(f.faction.id),
    told = () => again.room.units(faction, fieldParts(again.world)).find(unit => unit.id === id);
  assert.equal(again.room.records.get(id).homing, false); assert.equal(told().homing, false);
  assert.equal(again.room.players.get(f.alice.playerId).squad.homing(id), false, 'its pilot has it off');
  // A field kept on, or before there was a switch, says nothing of it, and is resumed with it on.
  delete record.homing;
  const old = onField(t, rehearsal([-100, 400], undefined, { kept })), oldFaction = old.room.factions.get(f.faction.id);
  assert.equal(old.room.records.get(id).homing, true);
  assert.equal(old.room.units(oldFaction, fieldParts(old.world)).find(unit => unit.id === id).homing, true);
  f.homing(true);
  assert.equal(room.keep().records.find(([actorId]) => actorId === id)[1].homing, undefined, 'on is not written');
});
