import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { firingSolution } from '../src/ballistics.ts';
import { weaponSettings } from '../src/weapons.ts';
import { TURN_SECONDS } from '../src/economy.ts';
import { turnedLauncher } from '../src/turn-about.ts';
import { scriptedDecision } from '../src/squad.ts';
import { onField } from './helpers/field.js';

function battery(t, { model = 'howitzer', facing = -1, narrow = false } = {}) {
  const f = onField(t, rehearsal([0, 3000])), { room, world, ground } = f,
    player = room.join('Artilharia'), source = createStructuredTemplate(model);
  if (narrow) source.components.find(m => m.kind === 'weapon').mount.sector = { min: -.6, max: -.15 };
  const id = f.publish(player, source, { x: 0, facing }), squad = room.players.get(player.playerId).squad,
    unit = squad.units.get(id), actor = () => world.actor(id), gun = () => world.modules.find(m => m.actorId === id && m.kind === 'weapon'),
    point = side => ({ x: actor().vehicle.x + side * 2000, y: ground.height(actor().vehicle.x + side * 2000) + 2 }),
    service = () => room.record(actor()).service,
    decide = () => squad.decide(squad.side.member(actor()));
  f.order(player, 'control', { id: null }); f.run(1);
  return { ...f, player, id, squad, unit, actor, gun, point, service, decide,
    mark: place => { room.watch.marks = () => [{ id: 'battery:1', x: place.x, error: 60, at: world.time }]; squad.sampled = null; },
    order: (order, data = {}) => f.order(player, order, { ids: [id], ...data }) };
}

for (const facing of [-1, 1]) for (const model of ['howitzer', 'mortar'])
  test(`${model} facing ${facing}: turns for an ordered point its current sector cannot reach, then fires from the real mount`, t => {
    const f = battery(t, { model, facing, narrow: model === 'mortar' }),
      { actor, gun, point, order, run, until, service, unit } = f,
      target = point(model === 'mortar' ? facing : -facing), before = actor().stats.shots,
      settings = weaponSettings(model, { preset: gun().weaponPreset, trajectory: 'auto', charge: 'auto' });
    assert.equal(firingSolution(gun(), target, settings).reachable, false);
    assert.equal(firingSolution(turnedLauncher(actor(), gun()), target, settings).reachable, true);
    order('bombard', { point: target }); run(.3);
    assert.equal(service()?.kind, 'turn'); assert.equal(unit.reason, 'turn-to-fire');
    const stood = actor().vehicle.x;
    run(TURN_SECONDS - 1);
    assert.equal(actor().facing, facing); assert.equal(actor().stats.shots, before);
    assert(Math.abs(actor().vehicle.x - stood) < .2, 'it holds its place while turning');
    assert(until(() => actor().facing === -facing, 2), 'the timed turn completes');
    assert.equal(service(), null); assert.deepEqual(unit.attack, { point: target }, 'the order survives');
    assert(until(() => actor().stats.shots > before, 12), 'a real round leaves the turned gun');
    assert.equal(firingSolution(gun(), target, settings).reachable, true);
    run(1); assert.equal(actor().facing, -facing, 'it does not turn back between shots');
  });

test('counterbattery fire turns for a located gun behind it, respecting Revidar and Segurar fogo', t => {
  const f = battery(t), { actor, point, mark, order, decide, service, unit, run, until } = f,
    target = point(-actor().facing);
  mark(target);
  assert.equal(decide().fire, false); assert.equal(service(), null, 'a mark alone is no leave to return fire');
  order('stance', { stance: 'hold' }); unit.alertUntil = f.world.time + 30;
  assert.equal(decide().fire, false); assert.equal(service(), null, 'holding fire keeps its orientation');
  order('stance', { stance: 'return' });
  const action = decide();
  assert.equal(action.fire, false); assert.equal(service()?.kind, 'turn');
  assert.deepEqual(unit.counter?.point, { x: target.x, y: f.ground.height(target.x) + 1 });
  run(TURN_SECONDS + .3);
  assert.equal(actor().facing, 1);
  assert(until(() => actor().stats.shots > 0, 12), 'return fire resumes after turning');
});

test('a current firing opportunity is preferred to turning for a nearer counterbattery mark', t => {
  const { room, world, squad, actor, point, order, service, decide } = battery(t),
    ahead = point(actor().facing), behind = point(-actor().facing);
  behind.x /= 2;
  room.watch.marks = () => [behind, ahead].map((p, i) => ({ id: 'battery:' + i, x: p.x, error: 60, at: world.time }));
  squad.sampled = null; order('stance', { stance: 'fire' });
  const action = decide();
  assert.equal(action.fire, true); assert.equal(action.aim.x, ahead.x); assert.equal(service(), null);
});

test('a mortar covering both sides fires behind the vehicle without an unnecessary turn', t => {
  const { actor, point, order, decide, service } = battery(t, { model: 'mortar' }), target = point(-actor().facing);
  order('bombard', { point: target });
  assert.equal(decide().fire, true); assert.equal(service(), null);
});

test('artillery brakes before starting its firing turn', t => {
  const { world, id, actor, point, order, decide, service, until } = battery(t), target = point(-actor().facing);
  world.game().call({ op: 'setVehicleState', actorId: id, state: { vx: 8, vy: 0 } }); world.sync();
  order('bombard', { point: target });
  const action = decide();
  assert.deepEqual([action.throttle, action.brake, action.fire], [0, 1, false]);
  assert.equal(service(), null, 'it cannot start turning while rolling');
  assert(until(() => service()?.kind === 'turn', 5), 'braking is followed by the timed turn');
  assert(Math.abs(actor().vehicle.vx) <= 1);
});

test('no turn is spent on an unreachable or unsafe point, an empty gun, movement or manual control', t => {
  const f = battery(t), { actor, gun, point, order, decide, service, unit, world, parts, set, id } = f,
    target = point(-actor().facing);
  for (const point of [{ x: target.x * 100, y: target.y }, { x: actor().vehicle.x + 2, y: actor().vehicle.y }]) {
    order('bombard', { point }); assert.equal(decide().fire, false); assert.equal(service(), null);
  }
  order('move', { x: actor().vehicle.x + actor().facing * 30 }); order('bombard', { point: target });
  assert.equal(decide().fire, false); assert.equal(service(), null); assert(unit.move, 'movement has priority');
  order('stop');
  for (const box of parts(id, 'ammo')) set(box, { rounds: 0 }); world.step();
  order('bombard', { point: target }); assert.equal(decide().fire, false); assert.equal(service(), null);
  assert.equal(unit.reason, 'no-armed-feed');
  order('control', { id }); assert.equal(decide(), null); assert.equal(service(), null);
  assert(gun(), 'the gun itself was not removed');
});

test('a fresh enemy in its sensors can make artillery turn to return fire', t => {
  const f = battery(t, { model: 'mortar', narrow: true }), { room, world, player, actor, id, decide, service, unit, run, publish } = f,
    enemy = room.join('Adversário'), target = publish(enemy, 'recon', { facing: -1 });
  room.command(enemy.playerId, { type: 'squad', order: 'control', id: target });
  f.put(target, actor().vehicle.x - 400); run(.5);
  const observed = scriptedDecision(world, id, f.squad.side.arenaBounds, target);
  assert.equal(observed.contact.detected, true, 'the real sensors hold the enemy');
  assert.equal(observed.diagnostics.reason, 'no-ballistic-solution');
  assert.equal(decide().fire, false); assert.equal(service(), null, 'Revidar waits for a hit');
  unit.alertUntil = world.time + 30;
  const core = world.game(), call = core.call.bind(core);
  for (const contact of [{ age: 2 }, { source: 'team', channel: 'sound', visible: false }]) {
    core.call = request => {
      const result = call(request);
      return request.op === 'scriptedDecision' ? { ...result, contact: { ...result.contact, ...contact } } : result;
    };
    decide(); assert.equal(service(), null, 'a lost contact or sound alone does not make it turn');
  }
  core.call = call;
  decide();
  assert.equal(service()?.kind, 'turn');
  assert.equal(unit.reason, 'turn-to-fire');
  assert.equal(room.players.get(player.playerId).squad.manual, null);
});
