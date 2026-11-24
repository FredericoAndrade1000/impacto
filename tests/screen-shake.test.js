import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenShake, SHAKE_LEVELS } from '../src/screen-shake.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';

// A screen of 1600 by 900 pixels over a field, its middle 100 m along and 5 m up, at so many pixels a metre.
const view = (zoom = 30) => ({ x: 100, y: 5, zoom, width: 1600, height: 900 });
const told = (zoom = 30, more = {}) => ({ own: 'mine', view: view(zoom), seen: true, mode: 'test', ...more });
const blast = (more = {}) => ({ type: 'explosion', x: 100, y: 5, power: 430, radius: 2, actorId: 'enemy', ...more });
const muzzle = (more = {}) => ({ type: 'muzzle', x: 100, y: 5, angle: 0, weapon: 'cannon', preset: 'rh120', caliberMm: 120, actorId: 'mine', componentId: 'gun', ...more });
// The shot of a gun of the arsenal (weapons.ts), as the core tells of it.
const gun = preset => muzzle({ weapon: WEAPON_PRESETS[preset].family, preset, caliberMm: WEAPON_PRESETS[preset].caliberMm });
const strike = (type, power, more = {}) => ({ type, x: 100, y: 5, power, actorId: 'mine', ...more });
// The trauma one thing leaves a still view with.
const traumaOf = (e, context = told()) => { const shake = new ScreenShake(); shake.event(e, context); return shake.trauma; };
// The farthest the view is thrown either way over `frames` steps of `dt` seconds of the world, at `zoom`.
function widest(shake, zoom, frames = 40, dt = 1 / 120) {
  let most = 0;
  for (let i = 0; i < frames; i++) {
    const { x, y } = shake.offset(zoom, 'test');
    most = Math.max(most, Math.abs(x), Math.abs(y)); shake.update(dt);
  }
  return most;
}

test('jolts add up to the cap of the trauma and the view is never thrown past the pixels of its level', () => {
  const shake = new ScreenShake();
  shake.event(blast({ power: 200 }), told());
  const one = shake.trauma;
  shake.event(blast({ power: 200 }), told());
  assert(one > 0 && shake.trauma > one, 'a second burst adds to the first');
  for (let i = 0; i < 60; i++) shake.event(blast({ power: 5000 }), told(120));
  assert.equal(shake.trauma, 1);
  let most = 0;
  for (let i = 0; i < 120; i++) {
    const { x, y } = shake.offset(450, 'test');
    assert(Math.abs(x) <= SHAKE_LEVELS.normal && Math.abs(y) <= SHAKE_LEVELS.normal);
    most = Math.max(most, Math.abs(x), Math.abs(y));
    for (let j = 0; j < 30; j++) shake.event(blast(), told(120));
    shake.update(1 / 240);
  }
  assert(most > SHAKE_LEVELS.normal / 2, 'a whole shake throws the view most of its reach');
  assert.equal(shake.offset(450, 'test'), shake.offset(450, 'test'), 'one object, written anew each frame');
});

test('a quick fire of small jolts stays the shake of one of them', () => {
  const shake = new ScreenShake(), round = gun('rh202'), alone = traumaOf(round);
  for (let i = 0; i < 200; i++) { shake.event(round, told()); shake.update(.06); }
  assert(alone > 0 && shake.trauma <= 1.5 * alone + 1e-12, `a burst of 20 mm stays faint: ${shake.trauma}`);
});

test('the shake falls to exactly nothing within half a second', () => {
  const shake = new ScreenShake();
  for (let i = 0; i < 10; i++) shake.event(blast({ power: 2000 }), told());
  assert.equal(shake.trauma, 1);
  for (let i = 0; i < 31; i++) shake.update(1 / 60);
  assert.equal(shake.trauma, 0);
  assert.deepEqual({ ...shake.offset(30, 'test') }, { x: 0, y: 0 });
  const time = shake.time; shake.update(1 / 60);
  assert.equal(shake.time, time, 'a still view keeps no wave going');
});

test('nothing shakes in the Workshop, and a shake under way stops there', () => {
  assert.equal(traumaOf(blast(), told(30, { mode: 'edit' })), 0);
  assert.equal(traumaOf(muzzle(), told(30, { mode: 'edit' })), 0);
  assert.equal(traumaOf(strike('penetration', 689), told(30, { mode: 'edit' })), 0);
  const shake = new ScreenShake(); shake.event(blast(), told());
  assert(shake.trauma > 0);
  assert.deepEqual({ ...shake.offset(30, 'edit') }, { x: 0, y: 0 });
  assert.equal(shake.trauma, 0, 'what shook the field is not kept for the return');
});

test('off shakes nothing, soft half as far as normal, and an unknown level is normal', () => {
  const shake = new ScreenShake(); shake.setLevel('off');
  shake.event(blast(), told()); shake.event(muzzle(), told());
  assert.equal(shake.trauma, 0);
  const on = new ScreenShake(); on.event(blast(), told()); on.update(.01);
  const normal = { ...on.offset(120, 'test') };
  on.setLevel('soft');
  const soft = { ...on.offset(120, 'test') };
  assert(Math.abs(normal.x) > 0 && Math.abs(soft.x - normal.x / 2) < 1e-12 && Math.abs(soft.y - normal.y / 2) < 1e-12);
  on.setLevel('off');
  assert.equal(on.trauma, 0); assert.deepEqual({ ...on.offset(120, 'test') }, { x: 0, y: 0 });
  on.setLevel('tremendo'); assert.equal(on.level, 'normal');
  on.setLevel(null); assert.equal(on.level, 'normal');
});

test('a burst shakes less the farther from the middle of the screen, and the view less the farther it is zoomed out', () => {
  // At 30 px/m the screen is 53 m wide and 30 m tall.
  const middle = traumaOf(blast()), edge = traumaOf(blast({ x: 100 + 26 })), past = traumaOf(blast({ x: 100 + 45 })),
    far = traumaOf(blast({ x: 100 + 80 })), away = traumaOf(blast({ x: 100 + 2000 }));
  assert(middle > edge && edge > past && past > far, `${middle} ${edge} ${past} ${far}`);
  assert(edge < .9 * middle && far < .1 * middle);
  assert.equal(away, 0, 'a burst far off the screen does not shake it');
  assert(traumaOf(blast({ power: 900 })) > middle && traumaOf(blast({ power: 195 })) < middle, 'a bigger burst shakes more');
  assert.equal(traumaOf(blast({ x: NaN })), 0);
  // The same burst in the middle of a view at field zoom and in a close-up: the same trauma, fewer pixels zoomed out.
  const field = new ScreenShake(), close = new ScreenShake();
  field.event(blast(), told(30)); close.event(blast(), told(120));
  assert.equal(field.trauma, close.trauma);
  const wide = widest(field, 30), near = widest(close, 120);
  assert(wide > 0 && wide < .8 * near, `${wide} px at 30 px/m against ${near} px at 120 px/m`);
  const overview = new ScreenShake(); overview.event(blast(), told(4));
  assert.equal(widest(overview, 4), 0, 'a view of the whole battle does not tremble');
});

test('the gun of the player\'s vehicle shakes the view by its kick; machine guns, rockets and the guns of others do not', () => {
  const cannon = traumaOf(muzzle()), auto = traumaOf(gun('m242')), grenades = traumaOf(gun('mk19'));
  assert(cannon >= .5, `a 120 mm shakes clearly: ${cannon}`);
  assert(auto > 0 && auto < .5 * cannon, `an autocannon barely: ${auto}`);
  assert(grenades > 0 && grenades < .5 * auto, `a grenade launcher, whose grenades leave slowly, hardly: ${grenades}`);
  for (const quiet of ['m2hb', 'fnmag', 'at4', 'carlgustaf', 'hydra70']) assert.equal(traumaOf(gun(quiet)), 0, quiet);
  assert(traumaOf(muzzle({ preset: undefined })) > 0, 'a shot told without its gun has its family\'s');
  assert(traumaOf(gun('m777')) > cannon && traumaOf(gun('m119')) < cannon && traumaOf(gun('m252')) < traumaOf(gun('m119')));
  assert.equal(traumaOf(muzzle({ actorId: 'enemy' })), 0, 'the shot of another shakes nothing');
  assert.equal(traumaOf(muzzle(), told(30, { own: null })), 0, 'nor any shot with no vehicle in the hands');
  // An autocannon's shot is about a pixel at field zoom, a 120 mm's a few pixels.
  const small = new ScreenShake(), big = new ScreenShake();
  small.event(gun('m242'), told()); big.event(muzzle(), told());
  assert(widest(small, 30) < 1.2 && widest(big, 30) > 2.5, `${widest(small, 30)} ${widest(big, 30)}`);
});

test('strong strikes on the player\'s vehicle shake it, small blocked rounds hardly, those on others not at all', () => {
  const through = traumaOf(strike('penetration', 689)), blocked = traumaOf(strike('blocked', 689)),
    bullet = traumaOf(strike('blocked', 40)), pierced = traumaOf(strike('penetration', 40));
  assert(through >= .8 && blocked < through && blocked > .3, `${through} ${blocked}`);
  assert(bullet < .2, `a machine-gun bullet stopped by the armour does not do much: ${bullet}`);
  assert(pierced >= .45, `a round through the armour always tells: ${pierced}`);
  assert.equal(traumaOf(strike('penetration', 689, { actorId: 'enemy' })), 0);
  assert.equal(traumaOf(strike('ricochet', 689, { ground: true })), 0, 'a round into the ground is no strike on the vehicle');
  assert.equal(traumaOf(strike('burn', 689)), 0);
  // A burst against the player's vehicle shakes the view as if it were in its middle, wherever the view is.
  assert.equal(traumaOf(blast({ x: 100 + 2000, targetActorId: 'mine' })), traumaOf(blast()));
});

test('slowed, the shake is slowed with the world; paused, it stands', () => {
  const normal = new ScreenShake(), slow = new ScreenShake();
  normal.event(blast(), told()); slow.event(blast(), told());
  const start = normal.trauma;
  for (let i = 0; i < 12; i++) { normal.update(1 / 60); slow.update(1 / 600); }
  assert(slow.trauma > normal.trauma);
  assert(Math.abs((start - slow.trauma) - (start - normal.trauma) / 10) < 1e-12, 'a tenth of the trauma lost in a world ten times slower');
  assert(Math.abs(slow.time - normal.time / 10) < 1e-12, 'and a tenth of the wave gone by');
  const before = { ...slow.offset(30, 'test') }, trauma = slow.trauma;
  slow.update(0);
  assert.deepEqual({ ...slow.offset(30, 'test') }, before);
  assert.equal(slow.trauma, trauma);
});

test('what the player does not see shakes nothing', () => {
  for (const e of [blast(), muzzle(), strike('penetration', 689), blast({ targetActorId: 'mine' })]) {
    assert.equal(traumaOf(e, told(30, { seen: false })), 0);
    assert(traumaOf(e) > 0);
  }
});
