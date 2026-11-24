import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Effects } from '../src/effects.ts';

function effects(t, zoom = 65) {
  const parent = new Container(), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY), flame: Array(4).fill(Texture.EMPTY),
    spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY, flash: Texture.EMPTY,
    jet: Array(3).fill(Texture.EMPTY) }, fx = new Effects(parent, atlas);
  fx.terrain = { height: () => 0 }; fx.view = { left: -100, right: 100, bottom: -50, top: 50, zoom };
  t.after(() => { fx.clear(); parent.destroy({ children: true }); }); return fx;
}
// A 120 mm dart and a 12.7 mm bullet at a steel face that looks back along -x.
const strike = (type, more = {}) => ({ type, x: 4, y: 1.5, nx: -1, ny: 0, material: 'steel', power: 689,
  caliberMm: 120, projectileId: 'shot-1', actorId: 'tank', id: 'tank:0:plate', ...more });
const bullet = (type, more = {}) => strike(type, { power: 40, caliberMm: 12.7, ...more });
const splash = fx => fx.particles.find(p => p.art === 'flash');
const spots = fx => fx.particles.filter(p => p.art === 'glow');

test('a round stopped by a face leaves it glowing and throws its sparks back; one that goes through throws back less', t => {
  const stopped = effects(t), through = effects(t), event = strike('blocked'), before = structuredClone(event);
  stopped.consume([event]); through.consume([strike('penetration')]);
  assert.deepEqual(event, before, 'drawing cannot alter the strike');
  const spot = spots(stopped);
  assert.equal(spot.length, 2, 'a hot spot and its white core');
  assert(spot.every(p => p.x === 4 && p.y === 1.5 && p.carrier === undefined), 'on the face, where it struck');
  assert(Math.max(...spot.map(p => p.life)) >= .35 && Math.max(...spot.map(p => p.life)) <= .45, 'glowing for about 0.4 s');
  assert.equal(spots(through).length, 0, 'a round that went through leaves no spot');
  assert(splash(through).size < splash(stopped).size * .7, 'and its splash outside is smaller');
  const sparks = fx => fx.particles.filter(p => p.kind === 'spark');
  assert(sparks(through).length < sparks(stopped).length);
  assert(sparks(stopped).every(p => p.vx < 0), 'the sparks fly back out of the face');
  assert(stopped.particles.length <= 30 && through.particles.length <= 30, 'no more than a strike made before');
});

test('a splash keeps within its pixels at any zoom, and a machine gun makes little of it', t => {
  for (const zoom of [6, 16, 30, 65, 150, 450, 1200]) {
    const heavy = effects(t, zoom), light = effects(t, zoom);
    heavy.consume([strike('blocked')]); light.consume([bullet('blocked')]);
    const across = splash(heavy).size * zoom, small = splash(light).size * zoom;
    assert(across >= 26 - 1e-9 && across <= 110 + 1e-9, `120 mm at ${zoom} px/m: ${across} px`);
    assert(small >= 26 * Math.sqrt(12.7 / 120) - 1e-9 && small <= 110 * Math.sqrt(12.7 / 120) + 1e-9, `12.7 mm at ${zoom} px/m: ${small} px`);
    assert(small < across || across === 26);
    assert(light.particles.length <= 8, 'a bullet makes few particles');
  }
  const field = effects(t, 30); field.consume([strike('blocked')]);
  assert(splash(field).size * 30 >= 26, 'over a whole field a 120 mm strike still shows');
});

test('an oblique strike flattens its splash along the face and spreads its sparks wider', t => {
  // How squarely a round struck is the way its path went: 1.2 rad off the normal of the face, or square where no path was told.
  const square = effects(t), oblique = effects(t), sparks = fx => fx.particles.filter(p => p.kind === 'spark'),
    spread = fx => Math.max(...sparks(fx).map(p => Math.abs(Math.atan2(p.vy - 1.2, -p.vx))));
  oblique.learn([{ type: 'flight', id: 'shot-1', ammo: 'apfsds', points: [{ time: 0, x: 0, y: 1.5 + 4 * Math.tan(1.2), vx: 1650 * Math.cos(1.2), vy: -1650 * Math.sin(1.2) }] }]);
  square.consume([strike('blocked')]); oblique.consume([strike('blocked')]);
  assert.equal(splash(square).aspectX, 1);
  assert(Math.abs(splash(oblique).aspectX - (.35 + .65 * Math.cos(1.2))) < 1e-9);
  assert(spread(oblique) > spread(square), 'its sparks fan wider');
});

test('a round that goes on through a piece within leaves no spot on it; one the piece stopped does', t => {
  const stopped = effects(t), through = effects(t);
  stopped.consume([strike('module', { penetrated: false, id: 'tank:0:engine' })]); through.consume([strike('module', { penetrated: true, id: 'tank:0:engine' })]);
  assert.equal(spots(stopped).length, 2); assert.equal(spots(through).length, 0);
  assert(!splash(stopped) && !splash(through), 'a piece within throws no splash out of a face');
  const sparks = fx => fx.particles.filter(p => p.kind === 'spark');
  assert(sparks(through).length < sparks(stopped).length);
});

test('a hot spot stays on the part it struck as the part moves', t => {
  const fx = effects(t), pose = { x: 4.5, y: 1.5, angle: 0 };
  fx.pose = id => id === 'tank:0:plate' ? pose : null;
  fx.consume([strike('blocked')]);
  const spot = spots(fx)[0];
  assert.equal(spot.carrier, 'tank:0:plate');
  Object.assign(pose, { x: 6.5, y: 2, angle: Math.PI / 2 }); fx.update(.05); fx.sample(1);
  assert(Math.abs(spot.x - 6.5) < 1e-9 && Math.abs(spot.y - 1.5) < 1e-9, 'carried and turned with the plate');
  assert(Math.abs(spot.sprite.x - (6.5 - fx.origin.x)) < 1e-9);
});

test('a shaped charge bursts small and its jet runs to where its path ended, not the fireball of HE', t => {
  const shaped = effects(t), he = effects(t), path = { type: 'flight', id: 'shot-7', ammo: 'heat', radius: .07, terminal: true,
    points: [{ time: 0, x: 0, y: 1.5, vx: 1140, vy: 0 }, { time: .004, x: 4, y: 1.5, vx: 2000, vy: 0 }, { time: .0045, x: 5.1, y: 1.5, vx: 2000, vy: 0 }] },
    burst = { type: 'explosion', x: 4, y: 1.5, power: 90, radius: .8, shaped: true, projectileId: 'shot-7' }, before = structuredClone([path, burst]);
  shaped.learn([path]); shaped.consume([strike('penetration', { projectileId: 'shot-7', power: 600 }), burst]);
  he.consume([{ ...burst, shaped: undefined }]);
  assert.deepEqual([path, burst], before);
  assert.equal(shaped.particles.filter(p => p.kind === 'fire').length, 0, 'no fireball');
  assert(he.particles.filter(p => p.kind === 'fire').length > 10);
  assert(shaped.particles.filter(p => p.kind === 'smoke').length < he.particles.filter(p => p.kind === 'smoke').length / 2,
    'the jet leaves a smaller cloud even when HE uses fewer transient sparks');
  const jet = shaped.particles.filter(p => p.art === 'spark');
  assert.equal(jet.length, 2, 'a white line and its glow');
  for (const line of jet) {
    assert(Math.abs(line.x - 4.55) < 1e-9 && Math.abs(line.y - 1.5) < 1e-9 && Math.abs(line.size - 1.1) < 1e-9 && line.rotation === 0,
      'along the flight, from the burst to where the jet stopped');
  }
  assert(jet.some(line => line.tint === 0xffffff));
  const droplets = shaped.particles.filter(p => p.kind === 'spark' && p.ember && p.x > 4);
  assert(droplets.length >= 3 && droplets.every(p => p.vx > 0), 'molten metal sprays on behind the plate');
  assert.equal(spots(shaped).length, 1, 'only the burst glows: no hot spot of a stopped round');
});

test('the burst of a 120 mm shaped charge is larger than that of an 84 mm launcher', t => {
  const size = calibre => {
    const fx = effects(t, 30), path = { type: 'flight', id: 'shot-9', ammo: 'heat', points: [{ time: 0, x: 3, y: 1.5, vx: 300, vy: 0 }, { time: .001, x: 4.6, y: 1.5, vx: 2000, vy: 0 }] };
    fx.learn([path]);
    fx.consume([strike('penetration', { projectileId: 'shot-9', caliberMm: calibre, power: 500 }),
      { type: 'explosion', x: 4, y: 1.5, power: 80, radius: .7, shaped: true, projectileId: 'shot-9' }]);
    return splash(fx).size;
  };
  assert(size(120) > size(84) * 1.3);
});

test('a fragment ray draws its streak from where it starts to where it stops, and a plume where it got out', t => {
  const fx = effects(t), ray = { type: 'secondary-ray', projectileId: 'ejecta-3', x: 4.1, y: 1.5, endX: 6.1, endY: 1.5, internal: true, actorId: 'tank', powerBudget: 4 };
  fx.consume([ray]);
  const [streak] = fx.particles.filter(p => p.art === 'spark');
  assert(Math.abs(streak.x - 5.1) < 1e-12 && streak.y === 1.5 && Math.abs(streak.size - 2) < 1e-12 && streak.rotation === 0);
  assert(streak.life >= .06 && streak.life <= .12, 'for 60 to 120 ms');
  const sparks = fx.particles.filter(p => p.kind === 'spark');
  assert(sparks.length >= 1 && sparks.length <= 3 && sparks.every(p => p.vx > 0 && p.vx * p.life <= 2 + 1e-9), 'sparks run along it and die at its end');
  assert.equal(spots(fx).length, 1, 'its exit glows');
  assert.equal(fx.particles.filter(p => p.kind === 'smoke').length, 2, 'and raises a little dust');
  // Another ray from the same exit at once lights it no more; one that went out of the back of the hull ends there and plumes.
  const out = effects(t), contact = { type: 'secondary-impact', projectileId: 'ejecta-4', x: 5.5, y: 1.5, nx: -1, ny: 0, material: 'steel', power: 2, actorId: 'tank' };
  out.consume([contact, { ...ray, projectileId: 'ejecta-4', endX: 16.1 }]);
  const line = out.particles.find(p => p.art === 'spark');
  assert(Math.abs(line.x - 4.8) < 1e-12 && Math.abs(line.size - 1.4) < 1e-12, 'the streak ends where the ray left the hull');
  assert(out.particles.some(p => p.kind === 'smoke' && p.x === 5.5 && p.vx > 1), 'and smoke comes out of the back');
  out.consume([{ ...ray, projectileId: 'ejecta-5', endY: 1.9 }]);
  assert.equal(spots(out).length, 2, 'the exit glow is not lit again; only the plume\'s');
});

test('what a weak ray throws is less than a strong one', t => {
  const count = budget => { const fx = effects(t); fx.consume([{ type: 'secondary-ray', x: 0, y: 1, endX: 1, endY: 1, internal: true, powerBudget: budget }]); return fx.particles.length; };
  assert(count(.3) < count(6));
});

test('an HE burst on armour stays on the outer side of the face it met', t => {
  const fx = effects(t, 30), contact = { type: 'primary-contact', projectileId: 'shot-5', x: 4, y: 1.5, nx: -1, ny: 0, ammo: 'he', actorId: 'tank' },
    burst = { type: 'explosion', x: 4, y: 1.5, power: 430, radius: 3, projectileId: 'shot-5', targetActorId: 'tank' };
  fx.consume([contact, burst]);
  const thrown = fx.particles.filter(p => p.kind === 'fire' || p.kind === 'spark' || p.kind === 'smoke' && !p.groundDust);
  assert(thrown.length > 30);
  assert(thrown.every(p => p.x <= 4 + 1e-9), 'nothing starts behind the face');
  assert(thrown.filter(p => p.kind !== 'smoke').every(p => p.vx <= 1e-9), 'nor goes into it');
  assert(fx.particles.filter(p => p.kind === 'flash').every(p => p.x < 4), 'its light stands outside it');
  assert.equal(fx.faces.size, 0, 'the contact is spent');
  const whole = effects(t, 30); whole.consume([{ ...burst, projectileId: 'other' }]);
  assert(whole.particles.some(p => p.kind === 'fire' && p.vx > 0), 'a burst in the open throws all round');
  assert(fx.particles.length < whole.particles.length);
});

test('an HE dome is held within its pixels in a close view', t => {
  const fx = effects(t, 450);
  fx.consume([{ type: 'primary-contact', projectileId: 'shot-5', x: 4, y: 1.5, nx: 0, ny: 1, ammo: 'he' },
    { type: 'explosion', x: 4, y: 1.5, power: 430, radius: 3, projectileId: 'shot-5' }]);
  const flash = fx.particles.find(p => p.art === 'flash');
  assert(flash.size * 450 <= 240 * 1.1 + 1e-9, `${flash.size * 450} px`);
  assert(fx.particles.filter(p => p.kind === 'fire').every(p => p.y >= 1.5 - 1e-9), 'a roof struck from above burns above it');
});

test('the back of a face a blast broke throws cold chips and dust inward, with no fire', t => {
  const fx = effects(t), spall = { type: 'spall', x: 4.05, y: 1.5, nx: 1, ny: 0, power: 9, time: 2, actorId: 'tank' };
  fx.consume([spall]);
  assert(fx.particles.length >= 4 && fx.particles.length <= 10);
  assert(fx.particles.every(p => p.kind === 'dust' || p.kind === 'smoke'), 'chips and dust');
  assert(fx.particles.filter(p => p.kind === 'dust').every(p => p.vx > 0), 'thrown inward');
});

test('a budget with no smoke in it is not gone through for some on every flash', t => {
  const fx = effects(t);
  for (let i = 0; i < fx.limit; i++) fx.add('spark', { x: i % 50, y: 2, life: 10 });
  let scans = 0; const evict = fx.evict.bind(fx); fx.evict = test => { scans++; return evict(test); };
  for (let i = 0; i < 20; i++) fx.consume([strike('blocked', { x: i })]);
  assert.equal(scans, 0); assert.equal(fx.particles.length, fx.limit);
});

test('particles that go out leave their layers once a step, and their sprites are made again at once', t => {
  const fx = effects(t);
  for (let i = 0; i < 400; i++) fx.add(i % 2 ? 'smoke' : 'spark', { x: i % 50, y: 2, life: i % 4 ? 10 : .01 });
  fx.update(1 / 60);
  const live = fx.particles.length, layers = [fx.smoke, fx.fire, fx.sparks].reduce((sum, layer) => sum + layer.particleChildren.length, 0);
  assert.equal(live, 300); assert.equal(layers, live, 'no layer keeps a sprite that went out');
  assert.equal(fx.pool.length, 100);
  const reused = new Set(fx.pool);
  for (let i = 0; i < 100; i++) fx.add('smoke', { x: 1, y: 2, life: 10 });
  assert(fx.particles.slice(-100).every(p => reused.has(p.sprite)));
  // A sprite that leaves and is made again before the layers settle is drawn once, where it is now.
  const p = fx.particles.at(-1); fx.retire(p); fx.particles.pop();
  const again = fx.add('smoke', { x: 1, y: 2, life: 10 }); fx.sample(1);
  assert.equal(again.sprite, p.sprite); assert.equal(fx.smoke.particleChildren.filter(sprite => sprite === p.sprite).length, 1);
  assert.equal(fx.smoke.particleChildren.length + fx.sparks.particleChildren.length, fx.particles.length);
});
