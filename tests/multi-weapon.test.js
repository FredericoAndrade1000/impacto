import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { planStructuredComponent, compileStructuredConstruction } from '../src/structured-construction.ts';
import { applyWorldInput } from '../src/episode-input.ts';
import { scriptedDecision } from '../src/squad.ts';
import { linkedArmament, pieceKey, resolveArmament, loadout } from '../src/ui-model.ts';
import { rehearsal } from '../server/room.ts';
await initNativeDynamics();

// A stock construction with a heavy machine gun added at an explicit clear sector and a box of its rounds, written in
// cells of 5 cm: the gun in the middle of the lower front plate, three cells behind its line, and the box five cells
// over the floor.
function bowGun() {
  const source = createStructuredTemplate('heavy', { dual: true });
  return { ...source, components: source.components.map(part => ({ ...part, id: part.id.replace('support-weapon', 'second') })) };
}
// The infantry carrier's autocannon is fed high-explosive rounds: armour it cannot pierce is still worth its fire. Its
// second gun, a heavy machine gun, stands under it in the front of its tower, which is the taller one the template gives
// a carrier of two guns: each breech turns with its gun, and under the autocannon in the low tower the machine gun's
// would meet the other's or the floor whatever its sector. It is laid as the template lays it, as far as its 0.88 m
// tube clears the deck before the tower.
// Centre the bow mount on its flat plate: the curved mask must clear the glacis above it.
const coaxial = () => {
  const source = createStructuredTemplate('ifv', { dual: true }), second = id => id.replace('support-weapon', 'second');
  return { ...source, components: source.components.map(part => part.weaponPreset === 'm242' ? { ...part, weaponAmmo: 'he' } : { ...part, id: second(part.id) }) };
};
function bench(t) {
  const world = new World(bowGun()); t.after(() => world.dispose());
  const guns = world.modules.filter(m => m.kind === 'weapon'), cannon = guns.find(m => m.weaponPreset === 'rh120'),
    machineGun = guns.find(m => m.weaponPreset === 'm2hb'), aim = { x: cannon.x - 120, y: 0 },
    rounds = preset => world.modules.filter(m => m.kind === 'ammo' && m.ammoPreset === preset).reduce((sum, m) => sum + m.rounds, 0),
    fired = () => { const shots = { rh120: 0, m2hb: 0 }; for (const e of world.drainEvents()) if (e.type === 'muzzle') shots[e.preset]++; return shots; },
    input = data => applyWorldInput(world, 'local', { phase: 'before', aim, ...data }, { platform: 'vehicle' }),
    run = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) world.step(); };
  return { world, cannon, machineGun, aim, rounds, fired, input, run };
}

test('one trigger fires two guns of a vehicle, each with its own reload and its own ammunition', t => {
  const { world, cannon, machineGun, rounds, fired, input, run } = bench(t), before = { rh120: rounds('rh120'), m2hb: rounds('m2hb') };
  input({ type: 'aim', componentId: cannon.id, also: [{ componentId: machineGun.id }] }); run(3); world.drainEvents();
  assert.equal(machineGun.loaded, 100, 'its belt comes in full');
  assert.equal(world.actor().also.length, 1); assert.equal(world.actor().also[0].held, false, 'an aim lays the gun and pulls no trigger');
  const { accepted, record } = input({ type: 'trigger', active: true, componentId: cannon.id, also: [{ componentId: machineGun.id }] });
  assert(accepted); assert.deepEqual(record.also.map(gun => gun.componentId), [machineGun.id]);
  run(6);
  const shots = fired();
  assert.equal(shots.rh120, 1, 'six rounds a minute: one shell in six seconds');
  assert.equal(shots.m2hb, 55, '550 rounds a minute, counted on its own');
  assert.equal(before.rh120 - rounds('rh120'), 1); assert.equal(before.m2hb - rounds('m2hb'), 55);
  assert.equal(world.actor().stats.shots, 56);
  assert(cannon.reload > 3.9 && cannon.reload < 4.1, 'the cannon is four seconds from its next shell'); assert(machineGun.reload < .12);
  assert.equal(world.cooldown, 0, 'the bench launcher was not used');
  // Letting go of the trigger lets go of both.
  applyWorldInput(world, 'local', { type: 'trigger', phase: 'before', active: false }); run(2);
  assert.deepEqual(fired(), { rh120: 0, m2hb: 0 }); assert.equal(world.actor().also[0].held, false);
  // A command that names the cannon alone lets the other gun go.
  input({ type: 'trigger', active: true, componentId: cannon.id }); run(3);
  assert.deepEqual(fired(), { rh120: 1, m2hb: 0 }); assert.equal(world.actor().also.length, 0);
  // Changing the weapon in hand does not carry a reload across: the machine gun is ready while the cannon waits. Let go
  // for three seconds with more than half its belt fired, its crew was topping the belt up: the trigger back, it fires the
  // rounds it has, and the crew leaves the belt as it is.
  assert(cannon.reload > 8);
  assert.equal(machineGun.loaded, 45); assert(machineGun.feedReload > 0, 'its belt is being topped up');
  input({ type: 'trigger', active: true, componentId: machineGun.id }); run(1);
  assert.deepEqual(fired(), { rh120: 0, m2hb: 10 });
  assert.equal(machineGun.feedReload, 0); assert.equal(machineGun.loaded, 35);
});

test('a click fires the guns already laid and keeps the shot of one still turning', t => {
  const { world, cannon, machineGun, aim, fired, input, run } = bench(t), weapons = { componentId: cannon.id, also: [{ componentId: machineGun.id }] };
  input({ type: 'aim', ...weapons }); run(3); world.drainEvents();
  assert(input({ type: 'fire', shot: true, queue: true, ...weapons }).accepted); run(.1);
  assert.deepEqual(fired(), { rh120: 1, m2hb: 1 }, 'a click is one round a gun');
  run(1); assert.deepEqual(fired(), { rh120: 0, m2hb: 0 });
  // Higher up, both guns have to turn: the click waits for each and each fires when it gets there.
  const high = { x: aim.x, y: 12 };
  assert.equal(input({ type: 'fire', shot: true, queue: true, aim: high, ...weapons }).accepted, false);
  assert.equal(typeof world.actor().also[0].expires, 'number', 'the shot of the second gun waits for its servo');
  assert.deepEqual(fired(), { rh120: 0, m2hb: 0 });
  run(4); assert.equal(fired().m2hb, 1); assert.equal(world.actor().also[0].expires, null);
  // The same laying sent again keeps a waiting shot; another aim, or a cancel, drops it.
  run(11); input({ type: 'aim', ...weapons }); run(3); world.drainEvents();
  input({ type: 'fire', shot: true, queue: true, aim: high, ...weapons }); assert.equal(typeof world.actor().also[0].expires, 'number');
  input({ type: 'aim', aim: high, ...weapons }); assert.equal(typeof world.actor().also[0].expires, 'number');
  input({ type: 'aim', aim: { x: aim.x, y: 11 }, ...weapons }); assert.equal(world.actor().also[0].expires, null);
  input({ type: 'fire', shot: true, queue: true, aim: high, ...weapons }); assert.equal(typeof world.actor().also[0].expires, 'number');
  input({ type: 'aim', aim: high, cancel: true, ...weapons }); assert.equal(world.actor().also[0].expires, null);
});

test('a rebuilt scene keeps each gun reloading and the second gun under its trigger', t => {
  const { world, cannon, machineGun, fired, input, run } = bench(t);
  input({ type: 'aim', componentId: cannon.id, also: [{ componentId: machineGun.id }] }); run(3);
  input({ type: 'trigger', active: true, componentId: cannon.id, also: [{ componentId: machineGun.id }] }); run(1); world.drainEvents();
  const reload = cannon.reload; assert(reload > 8);
  world.addActor(createStructuredTemplate('scout'), { id: 'other', ownerId: 'other', x: 80, facing: 1 });
  const again = world.modules.find(m => m.id === cannon.id);
  assert.equal(again.reload, reload); assert.equal(world.actor().also[0].held, true);
  run(1); assert.equal(fired().m2hb, 9, 'the machine gun goes on firing at its own rate');
  // A reload imposed on the actor holds every gun it carries.
  world.game().call({ op: 'setActorState', actorId: 'local', state: { cooldown: 5 } });
  assert.deepEqual(world.modules.filter(m => m.actorId === 'local' && m.kind === 'weapon').map(m => m.reload), [5, 5]);
  run(1); assert.deepEqual(fired(), { rh120: 0, m2hb: 0 });
});

test('the guns fired along are admitted like the one in hand', t => {
  const { world, cannon, machineGun, input } = bench(t), base = { type: 'aim', aim: { x: 0, y: 1 } };
  for (const also of [{}, [{}], [{ componentId: 7 }], [{ componentId: 'a', fire: 1 }], [{ componentId: 'a', aimAngle: 'x' }],
    [{ componentId: 'a', charge: 'full' }], [{ componentId: 'a', aim: { x: 1 } }], Array.from({ length: 16 }, () => ({ componentId: 'a' }))])
    assert.throws(() => input({ ...base, also }), /Controle de arma inválido|Mira inválida/);
  assert(input({ ...base, also: [{ componentId: 'a', charge: 'auto', fire: true, aim: { x: 1, y: 2 } }] }).accepted);
  // The gun in hand named again, a gun named twice and one that is not on the vehicle are left out.
  const { record } = input({ type: 'aim', componentId: cannon.id,
    also: [{ componentId: cannon.id }, { componentId: machineGun.id, ammo: 'ap' }, { componentId: machineGun.id }, { componentId: 'nothing' }] });
  assert.deepEqual(record.also, [{ componentId: machineGun.id, ammo: 'ap', trajectory: 'direct', charge: 1, detonation: 'impact' }]);
  assert.equal(world.actor().also.length, 1);
  // Each fires the round it is fed, whatever the command names.
  assert.equal(input({ type: 'aim', componentId: cannon.id, also: [{ componentId: machineGun.id, ammo: 'he' }] }).record.also[0].ammo, 'ap');
});

test('a vehicle ordered to shell a point uses every gun that has rounds', t => {
  const room = rehearsal([-100, 160]); t.after(() => room.world.dispose());
  const alice = room.join('Alice'), publish = x => { room.players.get(alice.playerId).builtAt = -Infinity;
    return room.publish(alice.playerId, bowGun(), { x, facing: 1 }).actor.id; }, ids = [publish(-90)], world = room.world;
  for (let i = 0; i < 120; i++) room.step();
  room.command(alice.playerId, { type: 'squad', order: 'control', id: null });
  const x = world.actor(ids[0]).vehicle.x + 150;
  room.command(alice.playerId, { type: 'squad', order: 'bombard', ids, point: { x, y: world.terrain.height(x) } }); world.drainEvents();
  const shots = new Map();
  for (let i = 0; i < 8 * 60; i++) { room.step();
    for (const e of world.drainEvents()) if (e.type === 'muzzle') shots.set(e.actorId + e.preset, (shots.get(e.actorId + e.preset) || 0) + 1); }
  for (const id of ids) { assert.equal(shots.get(id + 'rh120'), 1); assert(shots.get(id + 'm2hb') > 60, 'the machine gun fires along with the cannon'); }
  // Stopping the order lets every gun go.
  room.command(alice.playerId, { type: 'squad', order: 'stop', ids });
  for (let i = 0; i < 30; i++) room.step(); world.drainEvents();
  for (let i = 0; i < 60; i++) room.step();
  assert(!world.drainEvents().some(e => e.type === 'muzzle'));
});

test('on the shared field the construction in hand fires the guns the player switched on', t => {
  const room = rehearsal([-100, 160]); t.after(() => room.world.dispose());
  const alice = room.join('Alice'), world = room.world, id = room.publish(alice.playerId, bowGun(), { x: -90, facing: 1 }).actor.id;
  room.command(alice.playerId, { type: 'squad', order: 'control', id });
  for (let i = 0; i < 120; i++) room.step();
  const modules = world.modules.filter(m => m.actorId === id), [cannon, machineGun] = modules.filter(m => m.kind === 'weapon'),
    weapon = resolveArmament({ platform: 'vehicle', componentId: cannon.id }, modules, true),
    also = linkedArmament({ linked: new Set(['second']), loadouts: {} }, modules, weapon),
    x = world.actor(id).vehicle.x + 120, aim = { x, y: world.terrain.height(x) },
    run = seconds => { const shots = { rh120: 0, m2hb: 0 };
      for (let i = 0; i < seconds * 60; i++) { room.step(); for (const e of world.drainEvents()) if (e.type === 'muzzle') shots[e.preset]++; } return shots; };
  assert.equal(also[0].componentId, machineGun.id);
  room.command(alice.playerId, { type: 'aim', aim, weapon: { ...weapon, also } }); run(3);
  room.command(alice.playerId, { type: 'trigger', active: true, aim, weapon: { ...weapon, also } });
  assert.deepEqual(run(6), { rh120: 1, m2hb: 56 }, 'the press fires at once, then each gun keeps its own rate');
  room.command(alice.playerId, { type: 'trigger', active: false });
  assert.deepEqual(run(2), { rh120: 0, m2hb: 0 });
  // Switched off again, the machine gun stays silent under the same trigger.
  room.command(alice.playerId, { type: 'trigger', active: true, aim, weapon });
  assert.deepEqual(run(3), { rh120: 1, m2hb: 0 });
});

test('the rule pilot fires a coaxial gun along with the gun it chose', t => {
  const room = rehearsal([-100, 160]); t.after(() => room.world.dispose());
  const alice = room.join('Alice'), bob = room.join('Bob'), publish = (player, blueprint, x, facing) => {
    room.players.get(player.playerId).builtAt = -Infinity; return room.publish(player.playerId, blueprint, { x, facing }).actor.id; };
  const own = publish(alice, coaxial(), -90, 1), enemy = publish(bob, createStructuredTemplate('heavy'), 160, -1), world = room.world;
  for (let i = 0; i < 120; i++) room.step();
  const decision = scriptedDecision(world, own, room.players.get(alice.playerId).squad.side.arenaBounds, enemy);
  assert.equal(decision.diagnostics.guns, 2); assert.equal(decision.also.length, 1);
  const second = world.modules.find(m => m.actorId === own && m.weaponPreset === 'm2hb');
  assert.equal(decision.also[0].componentId, second.id); assert.notEqual(decision.componentId, second.id);
  assert.equal(typeof decision.also[0].fire, 'boolean'); assert(Number.isFinite(decision.also[0].aimAngle));
  room.command(alice.playerId, { type: 'squad', order: 'control', id: null });
  room.command(alice.playerId, { type: 'squad', order: 'attack', ids: [own], targetId: enemy }); world.drainEvents();
  const shots = { m242: 0, m2hb: 0 };
  for (let i = 0; i < 4 * 60; i++) { room.step(); for (const e of world.drainEvents()) if (e.type === 'muzzle' && e.actorId === own) shots[e.preset]++; }
  assert(shots.m242 >= 10 && shots.m2hb >= 30, JSON.stringify(shots));
  // A vehicle told to hold its fire lays both guns and fires neither.
  room.command(alice.playerId, { type: 'squad', order: 'stop', ids: [own] });
  room.command(alice.playerId, { type: 'squad', order: 'stance', ids: [own], stance: 'hold' });
  for (let i = 0; i < 30; i++) room.step(); world.drainEvents();
  for (let i = 0; i < 90; i++) room.step();
  assert(!world.drainEvents().some(e => e.type === 'muzzle' && e.actorId === own));
});

test('the screen sends the guns switched on: one of another model with the loadout it was last given, one of the model in hand with what that has', () => {
  const modules = compileStructuredConstruction(coaxial()).modules.map(m => ({ ...m, id: 'actor:3:' + m.id, health: 100 })),
    [first, second] = modules.filter(m => m.kind === 'weapon'), view = { linked: new Set(), loadouts: {} },
    weapon = resolveArmament({ platform: 'vehicle', componentId: first.id }, modules, true);
  assert.equal(pieceKey(second.id), 'second'); assert.equal(pieceKey('second'), 'second');
  assert.deepEqual(linkedArmament(view, modules, weapon), []);
  view.linked.add('second');
  assert.deepEqual(linkedArmament(view, modules, weapon), [{ componentId: second.id, trajectory: 'low', detonation: 'impact', charge: 1 }]);
  view.loadouts.second = loadout({ trajectory: 'low', detonation: 'impact', charge: 1 });
  assert.equal(linkedArmament(view, modules, weapon)[0].trajectory, 'low');
  // The gun in hand is not sent twice, a gun out of action is left out, and the bench launcher fires alone.
  assert.deepEqual(linkedArmament(view, modules, resolveArmament({ platform: 'vehicle', componentId: second.id }, modules, true)), []);
  second.barrelDisabled = true; assert.deepEqual(linkedArmament(view, modules, weapon), []); second.barrelDisabled = false;
  assert.deepEqual(linkedArmament(view, modules, resolveArmament({ platform: 'ground', preset: 'rh120' }, modules)), []);
  // Two guns of one model: the arc chosen for the one in hand is that of the other, whatever it was last given. The
  // round is the one each is fed, whatever the screen names.
  const twins = modules.map(m => m === second ? { ...m, weaponPreset: first.weaponPreset } : m),
    lobbed = resolveArmament({ platform: 'vehicle', componentId: first.id, trajectory: 'low', ammo: 'ap' }, twins, true);
  assert.deepEqual([lobbed.trajectory, lobbed.ammo], ['low', 'he']);
  assert.deepEqual(linkedArmament(view, twins, lobbed), [{ componentId: second.id, ...loadout(lobbed) }]);
  assert.equal(linkedArmament(view, twins, resolveArmament({ platform: 'vehicle', componentId: first.id }, twins, true))[0].trajectory, 'low');
});

test('a gun that fires direct, laid on a far place by its low arc, drops its rounds there; by the line of sight they fall far short', t => {
  // Where the rounds of a machine gun first come down, of those fired in five seconds at a place 800 m away on level ground.
  const fall = lay => {
    const world = new World(createStructuredTemplate('scout')); t.after(() => world.dispose());
    const gun = world.modules.find(m => m.kind === 'weapon'), x = gun.x - 800, aim = { x, y: world.terrain.height(x) + .2 }, falls = [], down = new Set();
    for (let i = 0; i < 5 * 60; i++) {
      if (i % 6 === 0) applyWorldInput(world, 'local', { phase: 'before', type: 'controls', throttle: 0, brake: 1, fire: true, aim, componentId: gun.id, ...lay },
        { platform: 'vehicle' });
      world.step();
      for (const e of world.drainEvents()) if (e.type === 'flight' && !down.has(e.id)) {
        const landed = e.points.find(p => p.y <= world.terrain.height(p.x) + .3 && Math.abs(p.x - gun.x) > 15);
        if (landed) { down.add(e.id); falls.push(Math.abs(landed.x - gun.x)); }
      }
    }
    assert(falls.length > 20, 'the gun fired and its rounds came down');
    return falls.sort((a, b) => a - b)[falls.length >> 1];
  };
  const sighted = fall({}), arced = fall({ trajectory: 'low' });
  assert(sighted < 600, `aimed straight at the place the rounds fall ${Math.round(sighted)} m out`);
  assert(Math.abs(arced - 800) < 100, `laid by the arc they fall ${Math.round(arced)} m out`);
});
