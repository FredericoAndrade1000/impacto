import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerAim } from '../src/canvas-controls.ts';
import { World } from '../src/physics.ts';
import { Renderer } from '../src/render.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { Graphics } from 'pixi.js';

import { laboratoryCourse } from './helpers/laboratory-course.js';
import { pageWorld } from '../src/trial-targets.ts';
import { AIM_SKY } from '../src/battle-rules.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { firingSolution, mountedFiringSolution, flightPath } from '../src/ballistics.ts';
import { predictImpact } from '../src/impact-preview.ts';
import { angleDifference } from '../src/math.ts';
import { rehearsal } from '../server/room.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { duel } from './helpers/duel.js';

const rad = degrees => degrees * Math.PI / 180,
  mortar = weaponSettings('mortar', { preset: 'm252', platform: 'vehicle' }),
  // A gun two metres up on a mount: its axis and the travel to either side, in degrees.
  mounted = (axis, min, max) => ({ x: 0, y: 2, angle: rad(axis), weaponMount: { min: rad(min), max: rad(max) } }),
  inside = (launcher, angle) => { const turn = angleDifference(angle, launcher.angle); return turn >= launcher.weaponMount.min - 1e-6 && turn <= launcher.weaponMount.max + 1e-6; };

test('the automatic charge is the lowest whose arc the mount can elevate to', () => {
  const upright = mounted(90, -34.4, 34.4);
  assert.equal(mortar.charge, 'auto');
  for (const side of [-1, 1]) for (let distance = 12; distance <= 400; distance += 4) {
    const aim = { x: side * distance, y: 0 }, solution = firingSolution(upright, aim, mortar), end = flightPath(solution).at(-1);
    assert(solution.reachable, `${side * distance} m is within reach`); assert.equal(solution.limit, null); assert.equal(solution.miss, 0);
    assert(inside(upright, solution.angle), `${side * distance} m is answered inside the mount`);
    assert(Math.hypot(end.x - aim.x, end.y - aim.y) < .05, `the arc to ${side * distance} m ends on the aim`);
  }
  // Without the mount the lower charge would do, at an elevation this mount cannot give.
  const aim = { x: 490, y: 0 }, bare = firingSolution({ x: 0, y: 2 }, aim, mortar), fitted = firingSolution(upright, aim, mortar);
  assert(bare.reachable && !inside(upright, bare.angle)); assert(fitted.charge > bare.charge);
});

test('an elevation the mount cannot give is answered with the nearest round it can place', () => {
  // The lowest charge would reach 200 m only above the 66 degrees this mount allows: the point is too near for its arc.
  const tilted = mounted(135, -21, 20), aim = { x: -200, y: 0 }, solution = firingSolution(tilted, aim, mortar), end = flightPath(solution).at(-1);
  assert.equal(solution.reachable, false); assert.equal(solution.limit, 'near');
  assert(inside(tilted, solution.angle), 'the bearing stays inside the mount');
  assert(Math.abs(end.y - aim.y) < .01, 'the forecast ends where the round comes down'); assert(solution.miss > 1);
  assert(Math.abs(Math.abs(end.x - aim.x) - solution.miss) < .01, 'the miss is the distance from that landing to the aim');
  // The same gun with the mount opened to the travel the mechanism allows reaches the point.
  const opened = firingSolution(mounted(135, -37, 37), aim, mortar);
  assert(opened.reachable); assert.equal(opened.limit, null);
  assert.deepEqual(firingSolution(tilted, aim, mortar), solution, 'the answer does not wander');
});

test('a flat-firing gun hits an aim by its muzzle and fires along the line of sight at one short of it', () => {
  // The machine gun of the starter car and a tank gun, laid as the page and the pilots lay them: by the low arc. Past
  // the muzzle by less than the round flies in a millisecond (0.9 m for the first, 1.65 m for the second) or short
  // of the muzzle, each fires that way.
  const launcher = mounted(0, -12, 20), along = reach => ({ x: Math.cos(rad(8)) * reach, y: 2 + Math.sin(rad(8)) * reach });
  for (const [family, preset] of [['machinegun', 'm2hb'], ['cannon', 'rh120']]) {
    const gun = weaponSettings(family, { preset, platform: 'vehicle', trajectory: 'low' });
    assert.equal(gun.trajectory, 'low');
    for (const reach of [gun.barrel * .5, gun.barrel + .05, gun.barrel + .5, gun.barrel + 1.5]) {
      const solution = firingSolution(launcher, along(reach), gun), held = mountedFiringSolution({ ...launcher, barrelAngle: rad(8) }, along(reach), gun);
      assert(solution.reachable && held.reachable, `${preset} at ${reach} m`); assert.equal(solution.limit, null); assert.equal(solution.miss, 0);
      assert(Math.abs(angleDifference(solution.angle, rad(8))) < rad(.05), `${preset} at ${reach} m is fired at along the line of sight`);
    }
    // One above what the mount rises to is out of its sector, not out of range, short of the muzzle or past it.
    for (const aim of [{ x: .3, y: 2.6 }, { x: gun.barrel, y: 2 + gun.barrel }]) assert.equal(firingSolution(launcher, aim, gun).limit, 'sector');
  }
});

test('a reconnaissance car fires its machine gun at an aim by its muzzle and along one short of it', t => {
  const world = duel(t, createConstruction('recon'), { visualEvents: false, separation: 200 });
  for (let i = 0; i < 60; i++) world.step();
  const gun = world.modules.find(m => m.actorId === 'local' && m.kind === 'weapon'),
    config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, trajectory: 'low' }, 'local'),
    bearing = gun.angle + (gun.weaponMount.min + gun.weaponMount.max) / 2;
  assert.equal(config.preset, 'm2hb');
  for (const reach of [config.barrel * .6, config.barrel + .3]) {
    const aim = { x: gun.x + Math.cos(bearing) * reach, y: gun.y + Math.sin(bearing) * reach }, shots = world.stats.shots;
    world.aimWeapon(aim, config);
    for (let i = 0; i < 120; i++) world.step();
    assert(firingSolution(world.launcher(config), aim, config).reachable, `${reach} m from the trunnion`);
    assert.equal(world.fire(aim, config), true, `${reach} m from the trunnion`); assert.equal(world.stats.shots, shots + 1);
  }
});

test('a high arc steeper than its mount rises says the aim is too near for it', () => {
  // A mortar leaning 45 degrees rises to 79: its steepest arc comes down a couple of hundred metres off.
  const leaning = mounted(45, -34.4, 34.4);
  for (const distance of [1, 20, 100]) {
    const solution = firingSolution(leaning, { x: distance, y: 0 }, mortar);
    assert.equal(solution.reachable, false); assert.equal(solution.limit, 'near');
    assert(inside(leaning, solution.angle) && solution.miss > 50, `${distance} m`);
  }
  assert(firingSolution(leaning, { x: 1500, y: 0 }, mortar).reachable);
});

test('an aim beyond the range gets the longest round, which comes down on the ground', () => {
  const upright = mounted(90, -34.4, 34.4), shots = [5700, 12000, 50000].map(distance => {
    const aim = { x: distance, y: 0 }, solution = firingSolution(upright, aim, mortar), end = flightPath(solution).at(-1);
    assert.equal(solution.reachable, false); assert.equal(solution.limit, 'range');
    assert.equal(solution.charge, 1); assert(inside(upright, solution.angle));
    assert(Math.abs(end.y) < .01, `aiming ${distance} m away, the forecast stops at the height of the aim`);
    assert(Math.abs(distance - end.x - solution.miss) < .01);
    return { angle: solution.angle, landing: end.x };
  });
  for (const shot of shots) { assert.equal(shot.angle, shots[0].angle, 'the barrel does not move as the aim runs away'); assert(Math.abs(shot.landing - shots[0].landing) < .01); }
  // A gun free to elevate fires its longest round near 45 degrees.
  const free = firingSolution({ x: 0, y: 2 }, { x: 5700, y: 0 }, mortar);
  assert.equal(free.limit, 'range'); assert(Math.abs(free.angle - Math.PI / 4) < rad(1.5)); assert(flightPath(free).at(-1).x > shots[0].landing);
  // A chosen charge is kept, however short it falls.
  const lowest = mortar.charges[0].value, kept = firingSolution(upright, { x: 600, y: 0 }, { ...mortar, charge: lowest });
  assert.equal(kept.reachable, false); assert.equal(kept.limit, 'range'); assert.equal(kept.charge, lowest);
});

test('an aim far up in the sky is kept: the barrel is raised at that point, not at one held under a ceiling', t => {
  for (const terrain of [null, 'world']) {
    const world = new World({ ...createStructuredTemplate('mortar'), ...(terrain ? { terrain } : {}) }, { visualEvents: false }); t.after(() => world.dispose());
    for (let i = 0; i < 120; i++) world.step();
    const gun = world.modules.find(m => m.kind === 'weapon'), config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, charge: 1 }),
      aim = { x: gun.x + 700, y: gun.y + 2600 };
    world.aimWeapon(aim, config);
    for (let i = 0; i < 480; i++) world.step();
    assert.deepEqual(world.actor().aim, aim, 'the core keeps the aim where it was put');
    const solution = firingSolution(world.launcher(config), aim, config);
    assert(Math.abs(angleDifference(gun.barrelAngle, solution.angle)) < 1e-3, 'and the servo rests on the bearing the forecast shows');
    const held = firingSolution(world.launcher(config), { x: aim.x, y: Math.min(aim.y, world.bounds.maxY ?? 100, terrain ? Infinity : 100) }, config);
    assert(Math.abs(angleDifference(held.angle, solution.angle)) > rad(1), 'not the bearing of the same aim held under the ceiling');
  }
});

test('the pointer puts the aim below the gun: at the bottom of a valley of the proving ground and into the ground of the field', () => {
  // How the page lays the aim on the point under the pointer (main.ts, `pointAim`), in a test and on the shared field.
  const page = { renderer: { ground: laboratoryCourse(), aim: null }, field: false };
  const pointAim = point => pointerAim(point, page.renderer.ground, page.field), ground = page.renderer.ground,
    // The bottom of the steep descent, eight metres under the start (its sign stands 6 m before it, and it comes down
    // over 10 m): its floor ahead of a vehicle down there, and the ground under that.
    bottom = ground.signs.find(sign => sign.text === 'Descida íngreme').x - 21;
  assert(ground.height(bottom) < -7.9, 'the bottom of the descent lies eight metres under the start');
  for (const point of [{ x: bottom, y: ground.height(bottom) }, { x: bottom - 3, y: ground.height(bottom) - 5 }])
    assert.deepEqual(pointAim(point), point, 'in a test the aim is where the pointer is, under the level of the start too');
  // The field: the aim goes under its lowest ground as well, and is held only to its ends and AIM_SKY above or below.
  Object.assign(page, { field: true }); page.renderer.ground = { minX: -1000, maxX: 1000, minHeight: 20 };
  assert.deepEqual(pointAim({ x: 40, y: 5 }), { x: 40, y: 5 }, 'not lifted to the lowest ground of the field');
  assert.deepEqual(pointAim({ x: 1200, y: -AIM_SKY - 10 }), { x: 1000, y: -AIM_SKY });
  assert.deepEqual(pointAim({ x: -1200, y: AIM_SKY + 10 }), { x: -1000, y: AIM_SKY });
});

test('an aim under the ground is kept: the gun is lowered at that point, not at one held over a floor', t => {
  // The car on the proving ground, as the test of the page lays it.
  const world = pageWorld(createConstruction('recon')); t.after(() => world.dispose());
  for (let i = 0; i < 120; i++) world.step();
  const gun = world.modules.find(m => m.kind === 'weapon'), config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, trajectory: 'low' }),
    // Down along the lower end of the travel of the mount, to a point 25 m under the level ground the car stands on.
    [down] = [gun.weaponMount.min, gun.weaponMount.max].map(turn => gun.angle + turn * .8).sort((a, b) => Math.sin(a) - Math.sin(b)),
    reach = (gun.y + 25) / -Math.sin(down), aim = { x: gun.x + Math.cos(down) * reach, y: gun.y + Math.sin(down) * reach };
  assert(Math.sin(down) < -.05 && reach < 400, 'the gun lowers under the level');
  world.aimWeapon(aim, config);
  for (let i = 0; i < 480; i++) world.step();
  assert.deepEqual(world.actor().aim, aim, 'the core keeps the aim where it was put');
  const solution = firingSolution(world.launcher(config), aim, config);
  assert(solution.reachable && inside(gun, solution.angle));
  assert(Math.abs(angleDifference(gun.barrelAngle, solution.angle)) < 1e-3, 'and the servo rests on the bearing the forecast shows');
  // The floors the aim was once held over: the level of the workshop and ten metres under it.
  for (const floor of [.03, -10]) {
    const held = firingSolution(world.launcher(config), { x: aim.x, y: floor }, config);
    assert(Math.abs(angleDifference(held.angle, solution.angle)) > rad(1), `not the bearing of the same aim held over ${floor} m`);
  }
});

test('the forecast of an aim out of reach follows the round down to the terrain', t => {
  const world = new World(createStructuredTemplate('mortar'), { visualEvents: false }); t.after(() => world.dispose());
  for (let i = 0; i < 120; i++) world.step();
  // The lowest charge alone: the others reach past the sides of the workshop field.
  const gun = world.modules.find(m => m.kind === 'weapon'), config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, charge: mortar.charges[0].value }),
    aim = { x: gun.x + 600, y: 12 };
  world.aimWeapon(aim, config);
  for (let i = 0; i < 480; i++) world.step();
  const solution = mountedFiringSolution(world.launcher(config), aim, config),
    forecast = predictImpact(world.snapshot(), solution, { platform: 'vehicle', componentId: gun.id, ammo: config.ammo, power: config.power });
  assert.equal(solution.reachable, false);
  assert.equal(forecast.owner.type, 'ground'); assert(Math.abs(forecast.y) < .05, 'the forecast ends on the ground, not under it');
  assert(forecast.path.every(p => p.y > -.05)); assert.deepEqual({ x: forecast.path.at(-1).x, y: forecast.path.at(-1).y }, { x: forecast.x, y: forecast.y });
  assert(forecast.x - gun.x > 350 && forecast.x < aim.x);
});

test('a mounted mortar aims, fires and lands where its lowest charge alone would need an elevation below the mount', t => {
  const world = new World(createStructuredTemplate('mortar'), { visualEvents: false }); t.after(() => world.dispose());
  for (let i = 0; i < 120; i++) world.step();
  const gun = world.modules.find(m => m.kind === 'weapon'), config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, charge: 'auto' }),
    aim = { x: gun.x + 490, y: .02 }, settle = () => { for (let i = 0; i < 480; i++) world.step(); };
  world.aimWeapon(aim, config); settle();
  const ideal = firingSolution(world.launcher(config), aim, config);
  assert(ideal.reachable); assert(inside(gun, ideal.angle));
  assert(Math.abs(angleDifference(gun.barrelAngle, ideal.angle)) < 1e-6, 'the servo rests on the solution');
  assert.equal(world.fire(aim, config), true);
  let last = null;
  for (let i = 0; i < 240 * 30; i++) { const [round] = world.projectiles; if (!round) break; last = { x: round.x, y: round.y }; world.step(); }
  // A bearing off by the spread of the gun moves the fall of an arc by no more than twice its speed squared over gravity:
  // eleven metres here. The last place the round was seen is within one step of that fall.
  const stray = config.spread * Math.PI / 180 * 2 * ideal.speed ** 2 / 9.81;
  assert(Math.hypot(last.x - aim.x, last.y - aim.y) < 3 * stray + 2.5, `the round lands on the aim (${(last.x - aim.x).toFixed(2)} m)`);
  // Held to the lowest charge, which reaches the same point only below the mount, the barrel waits at its limit and holds its fire.
  const held = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, charge: mortar.charges[0].value }), shots = world.stats.shots;
  world.aimWeapon(aim, held); settle();
  const refused = firingSolution(world.launcher(held), aim, held);
  assert.equal(refused.limit, 'sector'); assert(Math.abs(angleDifference(gun.barrelAngle, refused.angle)) < 1e-6);
  assert(Math.abs(angleDifference(gun.barrelAngle, gun.angle + gun.weaponMount.min)) < 1e-6 || Math.abs(angleDifference(gun.barrelAngle, gun.angle + gun.weaponMount.max)) < 1e-6);
  assert.equal(world.fire(aim, held), false); assert.equal(world.stats.shots, shots);
});

test('the shared field solves the same aim: its server fires the charge the mount can elevate to', t => {
  const room = rehearsal(), alice = room.join('Alice'); t.after(() => room.world.dispose());
  const mortar = room.publish(alice.playerId, createStructuredTemplate('mortar')).actor.id;
  room.command(alice.playerId, { type: 'squad', order: 'control', id: mortar });
  for (let i = 0; i < 120; i++) room.world.step();
  const world = room.world, gun = world.modules.find(m => m.kind === 'weapon'),
    weapon = { id: 'mortar', preset: 'm252', trajectory: 'high', charge: 'auto', componentId: gun.id },
    config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, charge: 'auto' }, gun.actorId), launcher = world.launcher(config, world.actor(gun.actorId)),
    // A distance the lowest charge reaches only below the mount.
    aim = Array.from({ length: 40 }, (_, i) => ({ x: gun.x + 440 + i * 2, y: gun.y }))
      .find(point => { const bare = firingSolution({ x: launcher.x, y: launcher.y }, point, config); return bare.reachable && !inside(gun, bare.angle); });
  assert(aim, 'some distance asks the lowest charge for an elevation below the mount');
  const fitted = firingSolution(launcher, aim, config);
  assert(fitted.reachable && inside(gun, fitted.angle));
  room.command(alice.playerId, { type: 'aim', aim, weapon });
  for (let i = 0; i < 480; i++) world.step();
  assert(Math.abs(angleDifference(gun.barrelAngle, fitted.angle)) < 1e-3, 'the server servo rests on the same solution the client previews');
  assert.equal(room.command(alice.playerId, { type: 'fire', aim, weapon }).accepted, true);
  world.step(); // an input leaves the scene to the step that follows it
  assert.equal(world.projectiles[0].charge, fitted.charge);
});

function previewGun(axis = 0, min = -12, max = 20) {
  return { ...mounted(axis, min, max), id: 'gun', actorId: 'local', kind: 'weapon', weaponPreset: 'm2hb',
    width: .8, height: .3, health: 100, barrelAngle: rad(8), targetBarrelAngle: rad(8),
    weaponMount: { min: rad(min), max: rad(max), fireTolerance: rad(1) } };
}
const previewState = gun => ({ time: 1, modules: [gun], plates: [], actors: [{ id: 'local', vehicle: {
  x: 0, y: 0, angle: 0, vx: 0, vy: 0, omega: 0, chassisId: 'frame' } }] });

test('mount axis and admitted travel invalidate a forecast with the same pivot, current barrel and velocity', t => {
  for (const [name, bearing, nextGun] of [['axis', 5, previewGun(20)], ['minimum', 5, previewGun(0, 6, 20)],
    ['maximum', 15, previewGun(0, -12, 12)]]) {
    const first = previewState(previewGun()), renderer = new Renderer({}, { mode: 'test',
      weapon: { platform: 'vehicle', componentId: 'gun', preset: 'm2hb' }, aim: { x: 100, y: 2 + Math.tan(rad(bearing)) * 100 } });
    t.after(() => renderer.effectSurfaceClip.destroy());
    renderer.playback.state = first; renderer.scene = sampleScene(first);
    assert(renderer.aimingSolution(first).reachable, name);
    const next = previewState(nextGun);
    renderer.playback.state = next; renderer.scene = sampleScene(next);
    const refused = renderer.aimingSolution(next);
    assert.equal(refused.reachable, false, name); assert.equal(refused.limit, 'sector', name);
  }
});

test('a refused aim shows its limit without a complete shot, impact or lead forecast', t => {
  const state = previewState(previewGun(20)), renderer = new Renderer({}, { mode: 'test',
    weapon: { platform: 'vehicle', componentId: 'gun', preset: 'm2hb' }, aim: { x: 100, y: 80 } });
  renderer.playback.state = state; renderer.scene = sampleScene(state); renderer.overlay = new Graphics();
  renderer.camera.zoom = 80; renderer.drawDeposits = () => {}; renderer.linkedArcs = () => [];
  for (const key of ['impactLabel', 'servoLabel', 'leadLabel', 'strikeWords', 'strikeDetail']) renderer[key] = { visible: false, text: '' };
  renderer.tag = label => { label.visible = true; };
  renderer.aimingSolution = () => ({ x: -1, y: 2, reachable: false, limit: 'sector' });
  renderer.weaponObstruction = renderer.impactPrediction = renderer.movingTarget = () => { throw new Error('a refused request has no drawn shot'); };
  t.after(() => { renderer.overlay.destroy(); renderer.effectSurfaceClip.destroy(); });
  renderer.drawOverlay(state);
  assert.equal(renderer.aimPreview, null); assert.equal(renderer.impactLabel.text, 'Fora do setor da montagem');
  assert(renderer.impactLabel.visible);
});
