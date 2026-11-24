import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { nativeRuntimeInfo } from '../scripts/native-dynamics-host.ts';

const built = existsSync(new URL(`../native/artifacts/battle_dynamics-${process.platform}-${process.arch}.json`, import.meta.url)),
  native = { skip: built ? false : 'Compile with npm run build:native.' };

function scene({ visualEvents = true, targetActor = 2, stats = {} } = {}) {
  return { terrain: 'flat', visualEvents, seed: 19,
    actors: [{ id: 'local', handle: 1, ownerId: 'local' }, { id: 'opponent', handle: 2, ownerId: 'opponent' }],
    modules: [{ id: 'target', owner: 10, actor: targetActor, kind: 'engine', x: 0, y: 3,
      width: 1, height: 1, health: 110, maxHealth: 110, physicalMass: 100 }],
    plates: [], stats, bounds: { minX: -10, maxX: 100, minY: -10, maxY: 100 } };
}
function world(t, options) {
  const Core = createRequire(import.meta.url)(nativeRuntimeInfo('native').binary).NativeWorld,
    core = new Core(new Float64Array(), 0, 0);
  core.load_game(JSON.stringify(scene(options))); t.after(() => core.free()); return core;
}
// A round put into the scene half a metre short of the component, and the frame of the step that flies it there:
// its words, its numbers, and the health the component is left with, read from a cold frame after it.
function impact(core, options = {}) {
  core.game_command(JSON.stringify({ op: 'projectile', frame: false,
    projectile: { numericId: 77, actor: 1, x: -1, y: 3, vx: 100, vy: 0,
      mass: .01, caliberMm: 10, power: 2, radius: .005, emitterOwners: [90], ammo: 'ap', ...options } }));
  const frame = JSON.parse(core.game_step(1 / 60));
  return { ...frame, numbers: frame.block ? Array.from(core.frame_block()) : [],
    health: JSON.parse(core.current_frame()).modules.find(m => m.owner === 10).health };
}

test('a primary AP contact tells who fired it, at whom, and the exact component health delta', native, t => {
  // A round from no gun is of no side: it strikes the construction that put it in the air as any other.
  for (const [targetActor, source, emitters] of [[1, 1, []], [2, 1, [90]], [1, null, [90]]]) {
    const core = world(t, { targetActor }), frame = impact(core, { actor: source, emitterOwners: emitters }),
      before = 110, after = frame.health;
    assert.equal(frame.stats.impacts, 1);
    assert(before > after);
    const events = frame.events.filter(e => e.projectileId === 'shot-77' && e.fragment === false);
    assert(events.length > 0); assert.equal(events.find(e => e.damage !== undefined).damage, before - after);
    for (const event of events) {
      assert.equal(event.primaryContact, true); assert.equal(event.shooterActor, source);
      assert.equal(event.targetActor, targetActor); assert.equal(event.emitterOwner, emitters[0] ?? null);
    }
  }
  // One from a gun of its own strikes it as any other: a vehicle is not spared its own fire.
  const own = impact(world(t, { targetActor: 1 }));
  assert.equal(own.stats.impacts, 1); assert(own.health < 110);
});

test('HE tells its direct contact and its burst with who fired it and at whom', native, t => {
  const core = world(t), frame = impact(core, { ammo: 'he' }),
    contact = frame.events.find(e => e.type === 'primary-contact'),
    explosion = frame.events.find(e => e.type === 'explosion' && e.primaryContact);
  assert(contact && explosion);
  assert.equal(frame.stats.impacts, 1);
  for (const event of [contact, explosion]) {
    assert.equal(event.projectileId, 'shot-77'); assert.equal(event.shooterActor, 1);
    assert.equal(event.targetActor, 2); assert.equal(event.emitterOwner, 90);
  }
  assert.equal(explosion.sourceOwner, 10);
  assert.equal(frame.stats.explosions, 1);
});

test('headless recording preserves exact mechanical state and fresh telemetry starts at zero', native, t => {
  const shown = world(t), hidden = world(t, { visualEvents: false });
  const a = impact(shown), b = impact(hidden);
  for (const key of ['actors', 'plates', 'modules', 'numbers', 'health', 'projectiles', 'stats', 'randomState'])
    assert.deepEqual(a[key], b[key], key);
  assert(a.events.length > 0); assert.equal(b.events.length, 0);
  const fresh = world(t);
  assert.equal(JSON.parse(fresh.current_frame()).stats.impacts, 0);
  assert.equal(impact(fresh).stats.impacts, 1);
});

test('the ordinary World facade translates explicit origin ids without confusing the target and shooter', async t => {
  const { World } = await import('../src/physics.ts'), { createConstruction } = await import('../src/construction-templates.ts'),
    { flyRound } = await import('./mechanical-queries.js'),
    w = new World(createConstruction('howitzer'), { visualEvents: true });
  t.after(() => w.dispose());
  w.addActor(createConstruction('howitzer'), { id: 'other', ownerId: 'red', x: 40 });
  const target = w.modules.find(m => m.actorId === 'other' && m.kind === 'engine'), gun = w.modules.find(m => m.actorId === 'local' && m.kind === 'weapon');
  // The round is put inside the engine of the other construction, which it strikes at once.
  flyRound(w, { numericId: 991, id: 'shot-audit', actorId: 'local', x: target.x, y: target.y,
    vx: 100, vy: 0, mass: .01, caliberMm: 10, power: 2, radius: .005, ammo: 'ap',
    emitterIds: new Set([gun.id]), visited: new Set() }, .0001);
  const event = w.events.find(e => e.projectileId === 'shot-audit' && e.primaryContact);
  assert(event); assert.equal(event.shooterActorId, 'local'); assert.equal(event.targetActorId, 'other');
  assert.equal(event.emitterId, gun.id); assert.equal(w.stats.impacts, 1);
  w.addActor(createConstruction('howitzer'), { id: 'friend', ownerId: 'local', x: 80 });
  const friend = w.modules.find(m => m.actorId === 'friend' && m.kind === 'engine'), before = friend.health;
  flyRound(w, { numericId: 992, id: 'shot-friendly-audit', actorId: 'local', x: friend.x, y: friend.y,
    vx: 100, vy: 0, mass: .01, caliberMm: 10, power: 2, radius: .005, ammo: 'ap',
    emitterIds: new Set([gun.id]), visited: new Set() }, .0001);
  assert.equal(friend.health, before); assert.equal(w.stats.impacts, 2, 'the immune material contact remains physically counted');
  assert(!w.events.some(e => e.projectileId === 'shot-friendly-audit' && e.primaryContact), 'no impact is published for friendly sparks or sound');
  assert(w.events.some(e => e.type === 'flight' && e.id === 'shot-friendly-audit' && e.terminal), 'the real flight still ends and removes its projectile');
});
