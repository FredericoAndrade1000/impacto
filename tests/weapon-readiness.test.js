import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { scriptedDecision } from '../src/squad.ts';
import { applyWorldInput } from '../src/episode-input.ts';
import { weaponSettings } from '../src/weapons.ts';
import { weaponAngle, weaponBarrelProfile } from '../src/weapon-geometry.ts';
import { setPart, flyRound } from './mechanical-queries.js';
import { duel } from './helpers/duel.js';

const session = (t, design = createConstruction('recon'), options = {}) => duel(t, design, { visualEvents: false, ...options });
// The guns a rule pilot may use are the ones that work and have rounds: it reports how many, and names the one it lays.
const decide = (w, targetId) => scriptedDecision(w, 'local', w.bounds, targetId);
const parts = (w, kind) => w.modules.filter(m => m.actorId === 'local' && m.kind === kind);
const emptyFeeds = w => { for (const feed of parts(w, 'ammo')) setPart(w, feed, { rounds: 0 }); };

test('a destroyed gun and an empty feed leave the pilot unarmed, while a reload stops the shot and not the choice of the gun', t => {
  const w = session(t), [gun] = parts(w, 'weapon');
  w.game().call({ op: 'setActorState', actorId: 'local', state: { cooldown: 10 } });
  const reloading = decide(w), bore = weaponAngle(gun), aim = { x: gun.x + Math.cos(bore) * 50, y: gun.y + Math.sin(bore) * 50 };
  assert.equal(reloading.diagnostics.weaponCandidates, 1); assert.equal(reloading.componentId, gun.id);
  assert.equal(gun.reload, 10);
  assert.equal(w.fire(aim, w.playerWeapon({ platform: 'vehicle', componentId: gun.id, aimAngle: bore }, 'local'), false, 'local'), false);
  assert.equal(w.actor('local').stats.shots, 0);
  setPart(w, gun, { health: 0 });
  const destroyed = decide(w);
  assert.equal(destroyed.diagnostics.weaponCandidates, 0); assert.equal(destroyed.componentId, 'none');
  const empty = session(t);
  assert(parts(empty, 'weapon').some(m => m.health > 0));
  assert.equal(decide(empty).diagnostics.weaponCandidates, 1);
  emptyFeeds(empty);
  const unfed = decide(empty);
  assert.equal(unfed.diagnostics.weaponCandidates, 0); assert.equal(unfed.diagnostics.reason, 'no-armed-feed');
  assert.equal(unfed.componentId, 'none'); assert.equal(unfed.fire, false);
});

// A scout with a mortar and a machine gun beside it, each with its own box of rounds.
const twoGunScout = () => createConstruction('scout', { preset: 'm252', dual: true });
const twoGuns = t => session(t, twoGunScout(), { terrain: 'sand', separation: 53 });

test('a vehicle offers its pilot every gun it owns that works and is fed, an enemy in sight or not, and takes the one a command names', t => {
  const w = twoGuns(t), [first, second] = parts(w, 'weapon'), both = decide(w),
    offered = [both.componentId, ...both.also.map(gun => gun.componentId)];
  assert.equal(both.diagnostics.weaponCandidates, 2);
  assert.deepEqual(offered.sort(), [first.id, second.id].sort()); assert(offered.every(id => id.startsWith('local:')));
  const sensorless = twoGunScout(); sensorless.components = sensorless.components.filter(m => m.kind !== 'sensor');
  const blind = decide(session(t, sensorless, { separation: 800 }));
  assert.equal(blind.contact.detected, false); assert.equal(blind.diagnostics.weaponCandidates, 2);
  const bore = weaponAngle(first);
  applyWorldInput(w, 'local', { type: 'controls', phase: 'before', throttle: 0, brake: 0, fire: false, componentId: first.id, charge: 1, aimAngle: bore,
    aim: { x: first.x + Math.cos(bore) * 50, y: first.y + Math.sin(bore) * 50 } }, { platform: 'vehicle' });
  assert.equal(w.actor('local').weapon.componentId, first.id);
  setPart(w, first, { health: 0 });
  const remaining = decide(w);
  assert.equal(remaining.diagnostics.weaponCandidates, 1); assert.equal(remaining.componentId, second.id);
  assert.equal(remaining.also, undefined);
  emptyFeeds(w);
  assert.equal(decide(w).diagnostics.weaponCandidates, 0);
});

test('a direct round crosses the exposed tube without disabling the gun', t => {
  const w = session(t, createConstruction('ifv'), { visualEvents: true }), [gun] = parts(w, 'weapon'),
    angle = weaponAngle(gun), profile = weaponBarrelProfile(gun);
  w.game();
  // The tube reserves mounting space, but direct projectiles ignore it; the receiver and mask remain solid.
  const across = { x: Math.sin(angle), y: -Math.cos(angle) }, reach = profile.end * .65, above = profile.radius + .02,
    start = { x: gun.x + Math.cos(angle) * reach - across.x * above, y: gun.y + Math.sin(angle) * reach - across.y * above },
    end = { x: gun.x + Math.cos(angle) * reach + across.x * above, y: gun.y + Math.sin(angle) * reach + across.y * above },
    ignoreIds = new Set([...w.plates, ...w.modules].filter(part => part.id !== gun.id).map(part => part.id)),
    health = gun.health, barrelDamage = gun.barrelDamage;
  assert.equal(w.index.raycast(start, end, { ignoreIds })?.owner.id, gun.id, 'the tube still occupies its structural space');
  assert.equal(w.index.raycast(start, end, { ignoreIds, projectile: true }), null);
  w.drainEvents();
  flyRound(w, { ...start, vx: across.x * 600, vy: across.y * 600,
    power: 1000, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, above * 2 / 600 + .00001);
  assert.equal(gun.barrelDisabled, false); assert.equal(gun.barrelDamage, barrelDamage); assert.equal(gun.health, health);
  assert.deepEqual(w.drainEvents().filter(event => event.id === gun.id || event.componentId === gun.id), [],
    'crossing the tube produces no gun impact or disable event');
});

test('switching a mounted weapon family cannot reset reload for either side', t => {
  const w = twoGuns(t);
  for (const actorId of ['local', 'opponent']) {
    const actor = w.actor(actorId), gun = w.modules.find(m => m.actorId === actorId && m.kind === 'weapon');
    assert(w.fire({ x: 20, y: 2 }, weaponSettings('cannon'), true, actorId));
    assert.equal(actor.lastWeapon, 'cannon'); const shots = actor.stats.shots;
    w.game().call({ op: 'setActorState', actorId, state: { cooldown: 3 } });
    const settings = w.playerWeapon({ platform: 'vehicle', componentId: gun.id }, actorId);
    assert.equal(w.fire({ x: 20, y: 2 }, settings, false, actorId), false);
    assert.equal(actor.cooldown, 3); assert.equal(gun.reload, 3); assert.equal(actor.stats.shots, shots);
  }
});

test('an enemy left with no gun, no eye (sensor or command post) and no way to move is out of the fight: no pilot takes it on alone, an order does', t => {
  const w = session(t, createConstruction('recon'), { separation: 120 }),
    of = (...kinds) => w.modules.filter(m => m.actorId === 'opponent' && kinds.includes(m.kind)), lose = (...kinds) => { for (const m of of(...kinds)) setPart(w, m, { health: 0 }); };
  assert.equal(decide(w).targetId, 'opponent');
  lose('weapon'); assert.equal(decide(w).targetId, 'opponent', 'with its gun gone it still sees and moves');
  lose('sensor'); assert.equal(decide(w).targetId, 'opponent', 'blind too, it still moves');
  lose('wheel', 'track'); assert.equal(decide(w).targetId, 'opponent', 'its command post still sees for its side');
  lose('command');
  const left = decide(w);
  assert.equal(left.targetId ?? null, null); assert.equal(left.fire, false);
  assert.equal(decide(w, 'opponent').targetId, 'opponent', 'an order to attack it is obeyed');
});
