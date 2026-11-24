import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { BlastWaves, blastWaveRadius, burstFront, muzzleFront } from '../src/blast-waves.ts';
import { SHOCKWAVE_RING_RADIUS } from '../src/effect-art.ts';
import { weaponSettings } from '../src/weapons.ts';

function setup(t) {
  const ambient = new Container(), actors = new Map(), atlas = { shockwave: Texture.WHITE },
    target = id => { if (!id) return ambient; if (!actors.has(id)) actors.set(id, new Container()); return actors.get(id); },
    waves = new BlastWaves(atlas, target);
  t.after(() => { waves.clear(); for (const sprite of waves.sprites) sprite.destroy(); ambient.destroy({ children: true });
    for (const parent of actors.values()) if (!parent.destroyed) parent.destroy({ children: true }); });
  return { waves, ambient, actors, atlas, target };
}
const event = extra => ({ type: 'explosion', actorId: 'tank', x: 2, y: 1, radius: 5.2, ...extra });
const finiteSprite = sprite => [sprite.x, sprite.y, sprite.width, sprite.height, sprite.rotation, sprite.alpha,
  sprite.scale.x, sprite.scale.y].every(Number.isFinite);

test('simultaneous bursts obey each quality budget and continuously reuse a bounded sprite pool', t => {
  const { waves } = setup(t);
  for (const [quality, limit] of [['high', 24], ['balanced', 16], ['low', 8]]) {
    waves.setQuality(quality);
    for (let i = 0; i < 200; i++) waves.emit(event({ x: i }), { quality });
    waves.sample(); assert.equal(waves.waves.length, limit); assert.equal(waves.sprites.length, limit);
    assert.equal(waves.waves.at(-1).x, 199, 'recent explosions retain pressure fronts under saturation');
    const allocated = new Set(waves.sprites);
    for (let i = 0; i < 200; i++) waves.emit(event({ x: 200 + i }), { quality });
    assert(waves.sprites.every(sprite => allocated.has(sprite)), 'saturation must replace waves without allocating more sprites');
    assert.equal(new Set(waves.waves.map(w => w.sprite)).size, limit);
    assert(waves.sprites.every(finiteSprite));
  }
});

test('ground contact creates an anchored low ellipse while airborne fronts remain circular', t => {
  const { waves, actors } = setup(t), ground = waves.emit(event({ y: 3.06 }), { ground: 3 }),
    air = waves.emit(event({ y: 6 }), { ground: 3 });
  waves.update(.1); waves.sample();
  assert.equal(ground.grounded, true); assert.equal(air.grounded, false);
  assert(Math.abs(ground.sprite.height / ground.sprite.width - .14) < 1e-8);
  assert(Math.abs(ground.sprite.y - ground.sprite.height / 2 - 3.014) < 1e-8, 'the lower pressure front stays above the actual ground');
  assert.equal(air.sprite.width, air.sprite.height); assert.equal(air.sprite.y, 6);
  assert.strictEqual(ground.sprite.parent, actors.get('tank')); assert(ground.sprite.alpha < .4);
});

test('inclined ground waves align with the supplied surface normal without querying terrain', t => {
  const { waves } = setup(t), normal = { y: 1, nx: -.6, ny: .8 }, before = structuredClone(normal),
    wave = waves.emit(event({ y: 1.02 }), { ground: normal });
  waves.update(.05); waves.sample(.5);
  assert.equal(wave.grounded, true); assert(Math.abs(wave.sprite.rotation - Math.atan2(.6, .8)) < 1e-12);
  assert(finiteSprite(wave.sprite)); assert.deepEqual(normal, before);
});

test('sampling and paused updates never advance lifetime or expansion', t => {
  const { waves } = setup(t), wave = waves.emit(event()); waves.update(.08); waves.sample(.5);
  const state = { age: wave.age, previousAge: wave.previousAge, x: wave.sprite.x, y: wave.sprite.y,
    width: wave.sprite.width, height: wave.sprite.height, alpha: wave.sprite.alpha };
  for (let i = 0; i < 120; i++) { waves.update(0); waves.sample(.5); }
  assert.deepEqual({ age: wave.age, previousAge: wave.previousAge, x: wave.sprite.x, y: wave.sprite.y,
    width: wave.sprite.width, height: wave.sprite.height, alpha: wave.sprite.alpha }, state);
  waves.sample(0); const previousWidth = wave.sprite.width; waves.sample(1); assert(wave.sprite.width > previousWidth);
  assert.equal(wave.age, state.age); assert.equal(wave.previousAge, state.previousAge);
});

test('fronts expand with simulation time, expire within 210 milliseconds, and recycle for later bursts', t => {
  const { waves } = setup(t), wave = waves.emit(event({ radius: 7 })); waves.sample();
  const first = wave.sprite.width, sprite = wave.sprite; assert(wave.life < .21);
  waves.update(.1); waves.sample(); assert(sprite.width > first);
  waves.update(.11); waves.sample(); assert.equal(waves.waves.length, 0);
  assert.equal(sprite.visible, false); assert.equal(sprite.parent, null);
  const next = waves.emit(event()); assert.strictEqual(next.sprite, sprite); assert.equal(waves.sprites.length, 1);
});

test('large-blast pressure leads the fire within 20 milliseconds and quickly becomes faint', t => {
  const { waves } = setup(t), wave = waves.emit(event({ radius: 4.5 })), samples = [];
  for (const dt of [.02, .03, .03]) {
    waves.update(dt); waves.sample();
    samples.push({ age: wave.displayAge, radius: wave.frontRadius, alpha: wave.displayAlpha });
    assert(wave.frontRadius > 2.5, 'the leading edge must already clear the roughly 2 metre fire body');
    assert.equal(wave.frontRadius, blastWaveRadius(wave, wave.displayAge) * SHOCKWAVE_RING_RADIUS);
    assert(Math.abs(wave.displayRadius * 2 - wave.sprite.width) < 1e-10);
  }
  assert(Math.abs(samples[0].age - .02) < 1e-12);
  assert(samples[0].radius > 3 && samples[0].radius < 3.6);
  assert(samples[1].radius > 4.4 && samples[1].radius < 4.9);
  assert(samples[2].radius > 4.8 && samples[2].radius < 5.1);
  assert(samples[0].radius < samples[1].radius && samples[1].radius < samples[2].radius);
  assert(samples[0].alpha < .17, 'a thin front must not become a bright expanding aureole');
  assert(samples[1].alpha < samples[0].alpha * .65);
  assert(samples[2].alpha < samples[0].alpha * .4);
  waves.update(.08); waves.sample();
  assert.equal(wave.sprite.visible, false); assert.equal(wave.displayAlpha, 0);
  waves.update(.05); assert.equal(waves.waves.length, 0);
});

test('radius queries and sampled optical geometry share terrain placement without advancing time', t => {
  const { waves } = setup(t), wave = waves.emit(event({ radius: 4.5 }), { ground: { y: 1, nx: -.6, ny: .8 } });
  assert.equal(blastWaveRadius(wave, -1), wave.startRadius);
  assert(Math.abs(blastWaveRadius(wave, wave.life) - wave.endRadius) < 1e-10);
  assert.equal(blastWaveRadius(wave, wave.life + 1), blastWaveRadius(wave, wave.life));
  waves.update(.05); waves.sample(.4);
  assert(Math.abs(wave.displayAge - .02) < 1e-12);
  assert(Math.abs(wave.frontRadius - blastWaveRadius(wave, .02) * SHOCKWAVE_RING_RADIUS) < 1e-10);
  assert.equal(wave.displayX, wave.sprite.x); assert.equal(wave.displayY, wave.sprite.y);
  assert.equal(wave.displayRotation, wave.sprite.rotation); assert.equal(wave.displayAlpha, wave.sprite.alpha);
  const before = [wave.age, wave.previousAge, wave.displayAge, wave.frontRadius, wave.displayX, wave.displayY, wave.displayRotation, wave.displayAlpha];
  for (let i = 0; i < 120; i++) { blastWaveRadius(wave, .08); waves.update(0); waves.sample(.4); }
  assert.deepEqual([wave.age, wave.previousAge, wave.displayAge, wave.frontRadius, wave.displayX, wave.displayY, wave.displayRotation, wave.displayAlpha], before);
});

test('quality changes opacity and budget while retaining the same leading trajectory', t => {
  const { waves } = setup(t), wave = waves.emit(event({ radius: 4.5 }));
  waves.update(.02); waves.sample();
  const radius = wave.frontRadius, alpha = wave.displayAlpha;
  for (const [quality, fraction] of [['balanced', .8], ['low', .6], ['high', 1]]) {
    waves.setQuality(quality); waves.sample();
    assert.equal(wave.frontRadius, radius); assert.equal(wave.age, .02);
    assert(Math.abs(wave.displayAlpha - alpha * fraction) < 1e-12);
  }
});

test('actor reset retires only its fronts and protects sprites while the old glow layer is destroyed', t => {
  const { waves, actors, ambient } = setup(t), a = waves.emit(event({ actorId: 'a' })), b = waves.emit(event({ actorId: 'b' })),
    unowned = waves.emit(event({ actorId: null })); waves.sample();
  const old = actors.get('a'); waves.resetActors(new Set(['a']));
  assert.deepEqual(waves.waves, [b, unowned]); assert.equal(a.sprite.parent, null); assert.equal(a.sprite.visible, false);
  old.destroy({ children: true }); actors.delete('a'); assert.equal(a.sprite.destroyed, false);
  const replacement = waves.emit(event({ actorId: 'a' })); waves.sample();
  assert.strictEqual(replacement.sprite, a.sprite); assert.strictEqual(replacement.sprite.parent, actors.get('a'));
  assert.strictEqual(unowned.sprite.parent, ambient); assert.equal(b.sprite.destroyed, false);
});

test('active sprites survive layer reparenting and clear leaves a reusable, detached pool', t => {
  const { waves, ambient, actors } = setup(t), wave = waves.emit(event()); waves.sample();
  const old = actors.get('tank'); ambient.addChild(wave.sprite); old.destroy({ children: true });
  actors.set('tank', ambient); waves.sample(); assert.equal(wave.sprite.destroyed, false); assert.strictEqual(wave.sprite.parent, ambient);
  const allocated = new Set(waves.sprites); waves.clear();
  assert.equal(waves.waves.length, 0); assert(waves.sprites.every(sprite => !sprite.visible && sprite.parent === null));
  assert(allocated.has(waves.emit(event()).sprite));
});

// The radius of a round's burst, as the catalogue states it.
const burst = (family, preset, ammo = 'he') => weaponSettings(family, { preset, ammo }).blastRadius;

test('a burst under a few kilograms of explosive throws no front, and takes no sprite', t => {
  const { waves } = setup(t);
  for (const [family, preset, ammo] of [['autocannon', 'rh202'], ['autocannon', 'm242'], ['autocannon', 'mk35'], ['grenade', 'mk19'],
    ['mortar', 'm224'], ['cannon', 'rh120', 'heat'], ['cannon', 'rh120'], ['rocket', 'at4', 'heat'], ['rocket', 'carlgustaf', 'heat'], ['rocket', 'carlgustaf']]) {
    const radius = burst(family, preset, ammo);
    assert(radius < 3, preset); assert.equal(burstFront(radius), null, preset);
    assert.equal(waves.emit(event({ radius }), { ground: 1 }), null, preset);
  }
  for (const radius of [2.99, 0, -1, NaN, undefined]) assert.equal(waves.emit(event({ radius })), null);
  assert.equal(waves.sprites.length, 0); assert.equal(waves.waves.length, 0);
});

test('above the cut, reach, light, bending and life grow with the radius, to a 155 mm shell as it was', () => {
  const fronts = [['mortar', 'm252'], ['rocket', 'hydra70'], ['howitzer', 'm119'], ['howitzer', 'm777']]
    .map(([family, preset]) => ({ radius: burst(family, preset), ...burstFront(burst(family, preset)) }));
  for (let i = 1; i < fronts.length; i++) for (const key of ['endRadius', 'opacity', 'refraction', 'life', 'travelTime'])
    assert(fronts[i][key] > fronts[i - 1][key], key);
  for (const front of fronts) assert(Math.abs(front.endRadius / front.radius - 1.363) < 1e-12, 'the reach follows the radius, the cube root of the charge');
  const [mortar, hydra, light, heavy] = fronts;
  assert(mortar.opacity < heavy.opacity * .6 && hydra.opacity < heavy.opacity * .6, 'an 81 mm bomb and a Hydra show a faint front');
  assert(light.opacity > heavy.opacity * .7, 'a 105 mm shell shows a clear one');
  // The 155 mm front is the one every burst had before: 9.8 m, an edge of .207 and a fifth of a second.
  assert(Math.abs(heavy.endRadius - 9.812) < .002 && heavy.opacity === .207 && heavy.refraction === 1);
  assert(Math.abs(heavy.life - .1978) < .0005 && Math.abs(heavy.travelTime - .0186) < .0001 && heavy.startRadius === .22);
  for (const radius of [9, 1e100, Infinity]) assert.deepEqual(burstFront(radius), { ...burstFront(7.2), endRadius: Math.min(12, radius * 1.363) });
});

test('a gun keeps the faint front of its own blast, though it is smaller than any burst that throws one', t => {
  const { waves } = setup(t);
  // Bore against a 120 mm gun and length of the flame of the 105 mm, 120 mm and 155 mm guns, with the front each had.
  for (const [calibre, flame, startRadius, endRadius, opacity, life, travelTime] of [[105, 3, .08664, 1.5602, .108, .16915, .023918],
    [120, 3.2, .1008, 1.8202, .108, .17012, .023407], [155, 3, .1116, 2.027, .11048, .17219, .022517]]) {
    const bore = Math.sqrt(calibre / 120), front = muzzleFront(bore, bore ** 1.3 * flame),
      wave = waves.emit({ actorId: 'tank', x: 2, y: 1 }, { front });
    assert(wave, `${calibre} mm`); assert.equal(wave.refraction, 1);
    for (const [key, value] of Object.entries({ startRadius, endRadius, opacity, life, travelTime }))
      assert(Math.abs(wave[key] - value) < 1e-4, `${calibre} mm ${key}`);
    assert(wave.endRadius < 3);
  }
});

test('the atlas must provide its pressure-front texture', () => {
  for (const atlas of [{}, { glow: Texture.WHITE }, { shockwave: null, glow: Texture.WHITE }])
    assert.throws(() => new BlastWaves(atlas), /requires a shockwave texture/);
});

test('malformed evidence cannot create nonfinite geometry', t => {
  const { waves, atlas } = setup(t);
  for (const bad of [event({ x: NaN }), event({ y: Infinity }), event({ x: Number.MAX_VALUE })]) assert.equal(waves.emit(bad), null);
  assert.equal(waves.sprites.length, 0);
  for (const radius of [NaN, Infinity, -1, 0, 1e100]) waves.emit(event({ radius }), { ground: NaN });
  for (const dt of [NaN, Infinity, -1, 0]) waves.update(dt);
  waves.sample(NaN); assert(waves.sprites.every(sprite => sprite.texture === atlas.shockwave && finiteSprite(sprite)));
  assert(waves.waves.every(w => w.age === 0 && w.life > 0 && w.life < .5));
  for (const normal of [{ y: 1, nx: 0, ny: 0 }, { y: 1, nx: Number.MAX_VALUE, ny: Number.MAX_VALUE }])
    waves.emit(event(), { ground: normal });
  waves.update(.2); waves.sample(2); assert(waves.sprites.every(finiteSprite));
});

test('pressure presentation does not mutate evidence or use global randomness', t => {
  const { waves } = setup(t), evidence = event(), before = structuredClone(evidence), original = Math.random;
  try {
    Math.random = () => { throw new Error('global random must not be used'); };
    waves.emit(evidence, { ground: 1 }); waves.update(.05); waves.sample();
  } finally { Math.random = original; }
  assert.deepEqual(evidence, before); assert(waves.waves.every(w => !('power' in w) && !('damage' in w)));
});
