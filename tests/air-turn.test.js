import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { rehearsal } from '../server/room.ts';
import { AIR_TURN_SECONDS, TURN_SECONDS } from '../src/economy.ts';
import { unitServices } from '../src/faction-ui.ts';
import { Squad } from '../src/squad.ts';
import { aircraft, airMiner } from './helpers/aircraft.js';
import { onField } from './helpers/field.js';

await initNativeDynamics();

// Turning about in the air (room.ts `turn`, World.turnActor, game_install.rs `admit`): an aircraft that flies turns about
// where it is and flies on, as its own mirror image, and its pilot turns it so where that serves.

// An aircraft of Alice's on a field, standing on its skids, and how it stands: where its centre of mass is along the field,
// how high it is over the ground there, how fast it goes along the field, which way it faces and whether it flies.
function stood(t, design = aircraft()) {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground } = f, alice = room.join('Alice'), id = f.publish(alice, design),
    stands = () => {
      const v = world.actor(id).vehicle, c = v.center;
      return { x: c.x, height: c.y - ground.height(c.x), vx: v.vx, facing: world.actor(id).facing, flying: Boolean(v.flying) };
    };
  return { ...f, alice, id, stands, unit: () => room.factionView(alice.playerId).units.find(u => u.id === id) };
}
// That aircraft taken up by hand, still in Alice's hands, and let be to hover well over the ground.
function hovering(t, design) {
  const f = stood(t, design), { alice, id, run } = f;
  f.order(alice, 'control', { id }); run(.5);
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 1 }); run(2.5);
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 0 }); run(4);
  return f;
}

test('on its skids an aircraft turns about as any vehicle does, held where it stands', t => {
  const { alice, id, run, order, stands, unit } = stood(t);
  run(.5);
  const before = stands();
  assert.deepEqual(order(alice, 'turn', { ids: [id] }), { turning: [id], seconds: TURN_SECONDS });
  assert.deepEqual([unit().service.kind, unit().service.aloft], ['turn', undefined]);
  assert.match(unitServices(unit(), { stock: {} }).held, /^Virando: fica parada/);
  run(TURN_SECONDS + .5);
  assert.deepEqual([stands().facing, stands().flying], [-before.facing, false]);
});

test('an aircraft in the air turns about where it is in two seconds, flying on: it loses no height and faces the other way', t => {
  const { room, world, alice, id, order, stands, unit } = hovering(t), before = stands();
  assert(before.flying && before.height > 50, JSON.stringify(before));
  assert.equal(AIR_TURN_SECONDS, 2);
  assert.deepEqual(order(alice, 'turn', { ids: [id] }), { turning: [id], seconds: AIR_TURN_SECONDS, aloft: true });
  // It is held as it turns, and says so; its flight computer holds it up all the while.
  assert.deepEqual([unit().service.kind, unit().service.aloft], ['turn', true]);
  assert.match(unitServices(unit(), { stock: {} }).held, /^Virando no ar: segue voando, sem atirar/);
  let lowest = Infinity;
  for (let i = 0; i < (AIR_TURN_SECONDS + .5) * 60; i++) {
    room.step();
    lowest = Math.min(lowest, stands().height);
    assert(stands().flying, `it fell at ${i} steps`);
  }
  const after = stands();
  assert.deepEqual([after.facing, world.actor(id).revision, unit().service], [-before.facing, 1, null]);
  assert(before.height - lowest < .1 && Math.abs(after.x - before.x) < .3, `${before.height.toFixed(2)} m up at ${before.x.toFixed(2)}, ` +
    `${lowest.toFixed(2)} m at the lowest, at ${after.x.toFixed(2)} after`);
});

test('an aircraft that flies along the field turns about on its way and goes on as one that does not turn: as fast, as high, as far', t => {
  // Flown tail first by its player, who keeps the key down all the way.
  const fly = turning => {
    const f = hovering(t), { alice, id, run, stands } = f, way = -stands().facing;
    f.send(alice, 'drive', { throttle: way, brake: 0, rise: 0 }); run(3);
    const from = stands();
    if (turning) f.order(alice, 'turn', { ids: [id] });
    run(AIR_TURN_SECONDS + 2);
    return { from, to: stands(), way };
  };
  const twin = fly(false), turned = fly(true);
  assert.deepEqual(turned.from, twin.from, 'the two flew alike till then');
  assert(Math.abs(twin.from.vx) > 10, `${twin.from.vx} m/s`);
  // Facing the way it flies, it went on as the other went: it lost no height and kept its course. Leant as far as its
  // flight computer leans it, flat out, it is its own mirror image leant the same way — its centre of mass on the other
  // side of the middle of its thrusters —, which shares out what they push it with otherwise to hold it level: it is
  // sped up a tenth faster or slower than the other from then on (game_hover_tests.rs, where turned back it is again
  // the very aircraft it was).
  assert.equal(turned.to.facing, turned.way);
  assert(Math.abs(turned.to.height - twin.to.height) < .3, `${turned.to.height.toFixed(2)} m up for ${twin.to.height.toFixed(2)}`);
  assert(Math.abs(turned.to.x - twin.to.x) < 2 && Math.abs(turned.to.vx - twin.to.vx) < 2,
    `at ${turned.to.x.toFixed(1)} going ${turned.to.vx.toFixed(1)} m/s for ${twin.to.x.toFixed(1)} at ${twin.to.vx.toFixed(1)}`);
});

test('an aircraft turning about in the air is flown on by its player meanwhile, its guns silent', t => {
  // Flown tail first by its player, who lets go of the key as it turns, or keeps it down.
  const fly = letGo => {
    const f = hovering(t), { alice, id, run, stands } = f, way = -stands().facing;
    f.send(alice, 'drive', { throttle: way, brake: 0, rise: 0 }); run(3);
    const from = stands();
    f.order(alice, 'turn', { ids: [id] }); run(.5);
    if (letGo) f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 0 });
    assert.throws(() => f.send(alice, 'trigger', { request: true, active: true }), /^Error: Essa construção está virando.$/);
    run(AIR_TURN_SECONDS + 3);
    return { from, to: stands() };
  };
  const kept = fly(false), left = fly(true);
  assert(Math.abs(kept.to.vx) > Math.abs(kept.from.vx) * .9, `${kept.from.vx} m/s, then ${kept.to.vx}`);
  assert(Math.abs(left.to.vx) < Math.abs(left.from.vx) / 2 && left.to.flying, `${left.from.vx} m/s, then ${left.to.vx}`);
});

test('a hit undoes a turning about in the air: the aircraft flies on as it faced, free at once', t => {
  const { alice, id, run, order, stands, unit, parts, set } = hovering(t), before = stands();
  order(alice, 'turn', { ids: [id] }); run(1);
  const tank = parts(id, 'fuel')[0];
  set(tank, { health: tank.health * .8 }); run(.3);
  assert.deepEqual([unit().service, stands().facing, stands().flying], [null, before.facing, true]);
  run(AIR_TURN_SECONDS);
  assert.deepEqual([stands().facing, stands().flying], [before.facing, true]);
});

// An aircraft of the squad in the air, facing -X at the middle of a field that turns it about when the squad asks
// (`turned`), going at `vx` along the field, with the air holding it back by `drag` ahead and `astern` behind it, a gun when
// `armed`, and on its way to `x`.
function airborne({ vx = 0, drag = .8, astern = .9, armed = false, flying = true } = {}) {
  const turned = [], actor = { facing: -1, vehicle: { x: 0, vx, flying, thrustN: 1e5, fuelLitres: 500, config: { enabled: true }, drivetrain: { drag, dragAstern: astern } } };
  const squad = new Squad({ world: { time: 0, actor: () => actor, modules: armed ? [{ actorId: 'a', kind: 'weapon', health: 1 }] : [], terrain: { minX: -50000, maxX: 50000 } },
    roster: [{ id: 'a', team: 'local', role: 'scout' }], defeats: {}, input() {}, veinAt: () => null, turnAbout: id => (turned.push(id), true) });
  squad.command({ order: 'control', id: null });
  const unit = squad.units.get('a'), sent = (x, contact = null, purpose = 'order') => {
    unit.move = { x, best: Math.abs(x), since: 0, purpose };
    return squad.turnsAloft('a', unit, contact);
  };
  return { squad, unit, turned, sent };
}

test('an aircraft sent far the other way from where it faces turns about in the air where facing its way saves time enough against the air', () => {
  // Shown to the air 0.8 m² ahead and 0.9 astern, it goes 6 % faster front first: reckoned at 15 m/s, that saves the two
  // seconds of the turn and three more from 1.3 km on.
  let { sent } = airborne();
  assert.deepEqual([sent(-5000), sent(1000), sent(1500)], [false, false, true], 'ahead it flies on; a little way behind it flies tail first');
  // Going fast it turns for a longer way only, and as it shows the air alike either way, for none.
  ({ sent } = airborne({ vx: 60 })); assert.deepEqual([sent(4000), sent(6000)], [false, true]);
  ({ sent } = airborne({ astern: .8 })); assert.equal(sent(20000), false);
  ({ sent } = airborne({ astern: .7 })); assert.equal(sent(20000), false, 'it shows the air less astern');
  // Not on the ground, nor on its way to strike, nor with its gun on an enemy ahead, nor hit a moment ago.
  ({ sent } = airborne({ flying: false })); assert.equal(sent(20000), false);
  ({ sent } = airborne()); assert.equal(sent(20000, null, 'strike'), false);
  const ahead = { detected: true, age: 0, x: -600 };
  ({ sent } = airborne({ armed: true })); assert.deepEqual([sent(20000, ahead), sent(20000, { ...ahead, x: 600 })], [false, true]);
  const hit = airborne(); hit.unit.alertUntil = 10; assert.equal(hit.sent(20000), false);
});

test('on the field an aircraft sent far behind it turns about in the air by itself and flies there front first', { timeout: 120000 }, t => {
  const { room, world, ground, alice, id, run, until, order, send, stands, unit } = hovering(t, airMiner()), before = stands();
  const drag = world.actor(id).vehicle.drivetrain;
  assert(drag.dragAstern > drag.drag * 1.05, `${drag.drag} ahead, ${drag.dragAstern} astern`);
  order(alice, 'control', { id: null });
  // Whether its fuel takes it there and back is no part of it (`homing`).
  send(alice, 'homing', { actorId: id, on: false });
  const far = before.x - before.facing * 3000;
  order(alice, 'move', { ids: [id], x: far, y: ground.height(far) + before.height });
  assert(until(() => unit().service?.kind === 'turn', 2), 'it turns about');
  assert.equal(unit().service.aloft, true);
  run(AIR_TURN_SECONDS + .5);
  const after = stands(), leg = room.players.get(alice.playerId).squad.units.get(id).move;
  assert.deepEqual([after.facing, after.flying, leg?.x], [-before.facing, true, far], 'it faces its way, on it still');
  run(5);
  assert(stands().vx * -before.facing > 5 && stands().facing === -before.facing, `${stands().vx} m/s`);
});
