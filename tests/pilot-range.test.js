import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { World } from '../src/physics.ts';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { scriptedDecision } from '../src/squad.ts';
import { applyWorldInput } from '../src/episode-input.ts';
import { SHOT_WORDS, SHOT_KIND, SHOT_Y } from '../src/shots.ts';
import { perceptionScene, crestTerrain, sensed, emptyBlueprint } from './helpers/perception-scene.js';
import { weaponSettings } from '../src/weapons.ts';
import { firingSolution } from '../src/ballistics.ts';
import { predictImpact } from '../src/impact-preview.ts';
import { duel } from './helpers/duel.js';

const scouts = (t, options) => duel(t, createConstruction('scout'), options);
const input = (w, command) => applyWorldInput(w, 'local', { ...command, phase: 'before' }, { platform: 'vehicle' });
const decide = w => scriptedDecision(w, 'local', w.bounds);
// The highest of the rounds in the air, fragments aside.
function highestShell(w) {
  const shots = w.shots; let top = -Infinity;
  for (let at = 0; at < shots.data.length; at += SHOT_WORDS)
    if (!shots.kinds[shots.data[at + SHOT_KIND]].fragment) top = Math.max(top, shots.data[at + SHOT_Y]);
  return top;
}

for (const id of ['mud', 'sand', 'hills', 'mixed', 'rough'])
  test(`${id}: distant terrain shares a continuous contact/CCD outline on both sides`, () => {
    const ground = new Terrain(id);
    assert(ground.minX < -300 && ground.maxX > 300);
    for (const [start, end] of [[-300, -100], [100, 300]]) {
      const points = ground.points.filter(p => p.x >= start && p.x <= end);
      assert(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) > .25);
      for (const p of points) assert.equal(ground.height(p.x), p.y);
      const x = start + 33.17, hit = ground.raycast({ x, y: 8 }, { x, y: -2 });
      assert(hit); assert(Math.abs(hit.y - ground.height(x)) < 1e-8);
      assert.equal(hit.surface, ground.materialAt(x));
    }
    for (const x of [ground.minX - .01, ground.minX, ground.minX + .01, -64, 96,
      ground.maxX - .01, ground.maxX, ground.maxX + .01]) assert.equal(ground.height(x), ground.surface(x).y);
    for (let x = 0; x <= 16; x += .5) assert.equal(ground.height(x), 0, 'the workshop remains level');
  });

test('distant mixed terrain contains distinct real materials instead of a decorative soil plane', () => {
  const ground = new Terrain('mixed');
  for (const [start, end] of [[-300, -100], [100, 300]]) {
    const materials = new Set(); for (let x = start; x <= end; x++) materials.add(ground.materialAt(x));
    assert.deepEqual([...materials].sort(), ['gravel', 'mud', 'rock', 'sand', 'soil']);
  }
});

test('vehicles 800 m apart keep manual and scripted aiming beyond 204 m', t => {
  const w = scouts(t, { separation: 800 }), aim = { x: 270, y: 2 };
  input(w, { type: 'aim', aim });
  assert.equal(w.actor('local').aim.x, 270);
  input(w, { type: 'controls', throttle: 0, brake: 1, aim, fire: false });
  assert.equal(w.actor('local').aim.x, 270);
  // Move the observer and its external camera into range of the far opponent,
  // whose world coordinate stays beyond 204 m.
  w.game().call({ op: 'setVehicleState', actorId: 'local', state: { x: 158 } });
  for (let i = 0; i < 6; i++) w.step(); // A new legal 10 Hz sensor sample.
  // The pilot aims at a place on the target, which its gun may first have to be laid on: laid, not fired.
  let action = decide(w);
  for (let i = 0; i < 60 && !action.fire; i++) {
    input(w, { ...action, fire: false, also: [] }); w.step();
    if (i % 6 === 5) action = decide(w);
  }
  assert(action.contact.detected); assert(action.fire, JSON.stringify(action.diagnostics));
  assert(action.aim.x > 204, 'a scripted aim is the world coordinate of its contact, with no mask on distant coordinates');
});

test('mist limits the command camera and blind starts do not disclose the enemy coordinate', t => {
  const w = scouts(t, { separation: 450, weather: 'mist' }), game = w.game();
  for (const sensor of w.modules.filter(m => m.actorId === 'local' && m.kind === 'sensor'))
    game.call({ op: 'setPartState', owner: game.handle(sensor), state: { health: 0 } });
  const blind = decide(w);
  assert.equal(blind.contact.detected, false); assert.equal(blind.contact.width, 0); assert.equal(blind.targetId, null);
  assert(Math.abs(blind.aim.x - w.actor('opponent').vehicle.x) > 150, 'a blind pilot has no enemy coordinate to aim at');
});

test('a rule pilot is asked only who decides and within what bounds, and an enemy\'s hidden parts change nothing it decides', t => {
  const w = duel(t, createConstruction('ifv')), core = w.game(), call = core.call.bind(core), asked = [];
  core.call = request => { if (request.op === 'scriptedDecision') asked.push(request); return call(request); };
  const before = decide(w);
  for (const [kind, state] of [['command', { health: 20 }], ['ammo', { rounds: 1 }]]) {
    const part = w.modules.find(m => m.actorId === 'opponent' && m.kind === kind);
    call({ op: 'setPartState', owner: core.handle(part), state });
  }
  assert.deepEqual(decide(w), before);
  assert.deepEqual(asked.map(request => Object.keys(request).sort()), Array(2).fill(['actorId', 'arenaBounds', 'op']));
  for (const key of ['health', 'rounds', 'fuelLitres', 'enemyModules']) assert(!(key in before.contact), key);
});

test('a rule pilot leads a target by the motion its sensors measured, never by the motion the target has', t => {
  const w = duel(t, createConstruction('ifv')), gun = w.modules.find(m => m.actorId === 'local' && m.kind === 'weapon'),
    push = () => w.game().call({ op: 'setVehicleState', actorId: 'opponent', state: { vx: 4 } }), still = decide(w).contact;
  push();
  assert.deepEqual(decide(w).contact, still, 'a velocity set a moment ago is not measured yet');
  // A track takes some readings to tell a drive from the noise of its readings: a second of them, the chassis kept going.
  for (let i = 0; i < 60; i++) { push(); w.step(); }
  let action = decide(w);
  assert(action.contact.vx > 2);
  // Led ahead of where it is seen, whatever place on it the pilot aims at.
  assert(action.aim.x - (action.diagnostics.aimOffset?.x ?? 0) > action.contact.x); assert.equal(action.componentId, gun.id);
  // The pilot may hold a shot while the servo still lays the gun: its controls are applied until it fires.
  for (let i = 0; i < 30 && !action.fire; i++) {
    input(w, action); w.step();
    if (i % 6 === 5) action = decide(w);
  }
  assert(action.fire, JSON.stringify(action.diagnostics)); assert.equal(action.componentId, gun.id);
});

test('a pilot holds fire behind allied armour and resumes when the ally leaves its line', t => {
  const w = new World(emptyBlueprint(), { visualEvents: false }), recon = createConstruction('recon');
  t.after(() => w.dispose()); w.removeActor('local');
  w.addActor(recon, { id: 'shooter', ownerId: 'blue', team: 'blue', x: 0, facing: 1 });
  w.addActor(recon, { id: 'friend', ownerId: 'blue', team: 'blue', x: 60, facing: -1 });
  w.addActor(recon, { id: 'enemy', ownerId: 'red', team: 'red', x: 67, facing: -1 });
  for (let i = 0; i < 60; i++) w.step();
  const wear = id => [...w.modules.filter(m => m.actorId === id).map(m => m.health), ...w.plates.filter(p => p.actorId === id).map(p => p.integrity)],
    friend = wear('friend'), enemy = wear('enemy');
  // The forecast stops at the first physical contact, including an ally.
  const gun = w.modules.find(m => m.actorId === 'shooter' && m.kind === 'weapon'), settings = w.playerWeapon({ platform: 'vehicle', componentId: gun.id }, 'shooter'),
    body = w.actor('enemy').vehicle, solution = firingSolution(gun, { x: body.x, y: body.y }, settings);
  assert.equal(predictImpact(w.snapshot(), solution, { platform: 'vehicle', componentId: gun.id }).owner.object.actorId, 'friend');
  let decision;
  for (let i = 0; i < 600 && !w.actor('shooter').stats.shots; i++) {
    if (i % 6 === 0) applyWorldInput(w, 'shooter', decision = scriptedDecision(w, 'shooter', w.bounds), { platform: 'vehicle' });
    w.step();
  }
  assert.equal(decision.targetId, 'enemy'); assert.equal(w.actor('shooter').stats.shots, 0, 'the pilot does not waste rounds on the allied hull');
  assert.equal(decision.diagnostics.reason, 'ally-in-line');
  assert.deepEqual(wear('friend'), friend, 'the ally stays whole');
  assert.deepEqual(wear('enemy'), enemy, 'the hull protects what is behind it');
  w.removeActor('friend');
  for (let i = 0; i < 600 && !w.actor('shooter').stats.shots; i++) {
    if (i % 6 === 0) applyWorldInput(w, 'shooter', decision = scriptedDecision(w, 'shooter', w.bounds), { platform: 'vehicle' });
    w.step();
  }
  assert(w.actor('shooter').stats.shots > 0, 'the pilot resumes without a new order');
  for (let i = 0; i < 60; i++) w.step();
  assert.notDeepEqual(wear('enemy'), enemy, 'the enemy is struck once the ally is clear');
});

test('a crest masks camera and radar even when the target is inside range', async t => {
  for (const mode of ['visual', 'radar']) {
    const world = await perceptionScene(t, { distance: 30, mode, terrain: crestTerrain() });
    assert(world.terrain.raycast({ x: 0, y: 2 }, { x: 30, y: 1.6 }));
    assert.equal(sensed(world, 'own', 'enemy').detected, false);
  }
});

// The lowest charge of each: a full one keeps a shell this steep in the air for more than a minute.
for (const [family, preset] of [['mortar', 'm252'], ['howitzer', 'm119']])
  test(`${preset}: a real high-arc shell crosses 100 m, returns and detonates rather than disappearing`, t => {
    const world = scouts(t, { separation: 240 }),
      origin = { x: world.actor('local').vehicle.x, y: 4 }, target = { x: world.actor('opponent').vehicle.x, y: 2 },
      settings = weaponSettings(family, { preset, trajectory: 'high', spread: 0, charge: .08 }),
      solution = firingSolution(origin, target, settings);
    assert(solution.apex > 100);
    world.game().call({ op: 'configureLauncher', actorId: 'local', point: origin });
    assert(world.fire(target, settings, true));
    let apex = -Infinity;
    for (let i = 0; i < 40 * 60 && !(world.stats.explosions > 0 && !world.shots.data.length); i++) {
      world.step(); apex = Math.max(apex, highestShell(world));
    }
    assert.equal(world.dynamics.recoveries || 0, 0);
    assert(apex > 100, `the shell rose to ${apex} m`);
    assert(world.stats.explosions > 0, 'the shell must actually return to a physical surface');
  });

test('distant projectile previews hit extended terrain using the same surface as live CCD', t => {
  const w = scouts(t, { separation: 240, terrain: 'hills' }),
    launcher = { x: 98, y: .6 }, aim = { x: 133, y: .6 },
    settings = weaponSettings('autocannon', { preset: 'rh202', trajectory: 'direct', spread: 0 });
  const predicted = predictImpact(w.snapshot(), firingSolution(launcher, aim, settings));
  assert.equal(predicted.owner.type, 'ground'); assert(predicted.x > 98 && predicted.x < 113);
  w.game().call({ op: 'configureLauncher', actorId: 'local', point: launcher }); assert(w.fire(aim, settings, true));
  for (let i = 0; i < 3; i++) w.step();
  const impact = w.drainEvents().find(e => e.type === 'ground');
  assert(impact); assert(Math.abs(impact.x - predicted.x) < .01);
});
