import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { applyWorldInput, releaseWorldInputs } from '../src/episode-input.ts';
import { World } from '../src/physics.ts';
import { duel } from './helpers/duel.js';

const pair = t => duel(t, createConstruction('recon'), { separation: 180, visualEvents: false });
const rounds = world => world.modules.filter(m => m.actorId === 'local' && m.kind === 'ammo').map(m => [m.id, m.rounds]);

test('native input preserves a workshop launcher and a pure trigger release', t => {
  const w = pair(t), game = w.game(), before = rounds(w),
    command = { type: 'fire', phase: 'before', platform: 'ground', preset: 'minimi', ammo: 'ap',
      aim: { x: 25, y: 4 }, aimAngle: 0, componentId: '__unmounted_launcher__' };
  const result = applyWorldInput(w, 'local', command);
  assert(result.accepted); assert.equal(result.record.platform, 'ground'); assert.equal(w.actor('local').weapon.platform, 'ground');
  assert.equal(w.actor('local').weapon.preset, 'minimi'); assert.equal(w.actor('local').stats.shots, 1);
  assert.deepEqual(rounds(w), before);
  assert.equal(applyWorldInput(w, 'local', command).accepted, false, 'ordinary input cannot bypass reload');
  assert.equal(game.call({ op: 'input', actorId: 'local', input: command, force: true }).accepted, true,
    'only the explicit force of a fixture passes a reload');
  const selected = structuredClone(w.actor('local').weapon), aim = { ...w.actor('local').aim };
  game.call({ op: 'input', actorId: 'local', input: { type: 'trigger', phase: 'before', active: false } });
  assert.equal(w.actor('local').trigger, null); assert.deepEqual(w.actor('local').weapon, selected); assert.deepEqual(w.actor('local').aim, aim);
});

test('native admission rejects a whole invalid state patch and unknown guns cannot spend a real feed', t => {
  const w = pair(t), game = w.game(), component = w.modules.find(m => m.actorId === 'local' && m.kind === 'command'),
    before = structuredClone(w.snapshot());
  assert.throws(() => game.call({ op: 'setPartState', owner: game.handle(component), state: { health: 1, rounds: -1 } }), /Invalid part/);
  assert.throws(() => game.call({ op: 'setVehicleState', actorId: 'local', state: { vx: 300, unknown: 1 } }), /Invalid state/);
  assert.throws(() => game.call({ op: 'input', actorId: 'local', input: { type: 'controls', phase: 'before', platform: 'vehicle', throttle: 1,
    brake: 0, aim: { x: NaN, y: 0 }, fire: true } }), /Mira inválida/);
  assert.deepEqual(structuredClone(w.snapshot()), before);
  for (const input of [
    { type: 'trigger', phase: 'before', active: false, aim: null },
    { type: 'trigger', phase: 'before' },
    { type: 'controls', phase: 'before', platform: 'vehicle', throttle: 1, brake: 0,
      aim: { x: 25, y: 4 }, fire: false, active: true },
  ]) assert.throws(() => game.call({ op: 'input', actorId: 'local', input }), /inválid|indisponível/);
  assert.deepEqual(structuredClone(w.snapshot()), before);
  const fed = rounds(w), reloads = () => w.modules.filter(m => m.actorId === 'local' && m.kind === 'weapon').map(m => m.reload),
    ready = reloads();
  const rejected = game.call({ op: 'input', actorId: 'local', input: { type: 'fire', phase: 'before', platform: 'vehicle',
    componentId: '__unknown_gun__', aim: { x: 25, y: 4 }, aimAngle: 0 } });
  assert.equal(rejected.accepted, false); assert.equal(w.actor('local').stats.shots, 0); assert.equal(w.projectiles.length, 0);
  assert.deepEqual(rounds(w), fed);
  assert.equal(w.actor('local').cooldown, before.actors.find(a => a.id === 'local').cooldown, 'a failed shot cannot begin reload');
  assert.deepEqual(reloads(), ready);
});

test('one release preserves the old movement, trigger and pending-shot semantics, including quiet calls', t => {
  for (const brake of [0, 1]) for (const cancel of [false, true]) for (const quiet of [false, true]) {
    const worlds = [0, 1].map(() => new World(createConstruction('heavy')));
    t.after(() => worlds.forEach(w => w.dispose()));
    for (const w of worlds) {
      w.controlVehicle(.7);
      const gun = w.modules.find(m => m.kind === 'weapon'), angle = gun.angle - .3,
        aim = { x: gun.x + Math.cos(angle) * 80, y: gun.y + Math.sin(angle) * 80 },
        config = w.playerWeapon({ platform: 'vehicle', componentId: gun.id });
      w.setTrigger(true, aim, config);
      assert.equal(applyWorldInput(w, 'local', { ...config, type: 'fire', phase: 'before', aim, queue: true }).accepted, false);
      assert(w.actor().pendingShot);
    }
    const [before, after] = worlds, scene = quiet ? { frame: false } : {};
    before.command('trigger', { active: false, ...scene });
    if (cancel) before.command('cancel', scene);
    before.command('control', { throttle: 0, brake, ...scene });
    const game = after.game(), call = game.call.bind(game), requests = [];
    game.call = request => { requests.push(request); return call(request); };
    releaseWorldInputs(after, ['local'], brake, cancel, quiet);
    game.call = call;
    assert.equal(requests.length, 1); assert.equal(requests[0].op, 'input');
    assert.equal(requests[0].frame, quiet ? false : undefined);
    for (const w of worlds) w.game().call({ op: 'sync' });
    assert.deepEqual(after.snapshot(), before.snapshot());
    assert.equal(Boolean(after.actor().pendingShot), !cancel);
    assert.equal(after.vehicle.brake, brake); assert.equal(after.actor().trigger, null);
    for (let i = 0; i < 30; i++) for (const w of worlds) w.step();
    assert.deepEqual(after.snapshot(), before.snapshot());
  }
});

test('release options are admitted atomically and a recorded release retains coasting and a queued shot', t => {
  const w = pair(t), before = structuredClone(w.snapshot());
  for (const [input, refused] of [
    [{ type: 'release', phase: 'before', brake: 'yes' }, /Freio inválido/],
    [{ type: 'release', phase: 'before', brake: true }, /Freio inválido/],
    [{ type: 'release', phase: 'before', brake: 0, cancel: 1 }, /liberação inválido/],
  ]) assert.throws(() => applyWorldInput(w, 'local', input), refused);
  assert.deepEqual(w.snapshot(), before);
  const { record } = applyWorldInput(w, 'local', { type: 'release', phase: 'before', brake: 0, cancel: false });
  assert.deepEqual(record, { type: 'release', phase: 'before', brake: 0, cancel: false });
  assert.deepEqual(applyWorldInput(w, 'local', record).record, record);
});
