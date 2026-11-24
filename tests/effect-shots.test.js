import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Effects } from '../src/effects.ts';
import { Terrain } from '../src/terrain.ts';
import { MUZZLE_JET_ROOT } from '../src/effect-art.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';

function effects(t, terrain) {
  const jet = Array.from({ length: 3 }, () => new Texture({ source: Texture.EMPTY.source })), flash = new Texture({ source: Texture.EMPTY.source }),
    parent = new Container(), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
      spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: jet[0], glow: Texture.EMPTY, shockwave: Texture.EMPTY, jet, flash }, fx = new Effects(parent, atlas);
  fx.terrain = terrain;
  t.after(() => { fx.clear(); parent.destroy({ children: true }); for (const texture of [...jet, flash]) texture.destroy(); });
  return fx;
}
const shot = (preset, extra = {}) => ({ type: 'muzzle', actorId: 'tank', x: 4, y: 2, angle: 0, platform: 'vehicle', preset,
  weapon: WEAPON_PRESETS[preset].family, caliberMm: WEAPON_PRESETS[preset].caliberMm, power: WEAPON_PRESETS[preset].power, ...extra });
const jets = fx => fx.particles.filter(p => p.kind === 'flash' && fx.atlas.jet.includes(p.sprite.texture));
const forward = (p, angle = 0) => Math.cos(p.rotation - angle);

test('distant small-arms fire keeps every flash and halo while subpixel powder smoke is omitted', t => {
  const near = effects(t), far = effects(t), events = [shot('minimi'), shot('minimi', { x: 5, angle: .3 })],
    before = structuredClone(events);
  far.view = { zoom: 1.5867404168941737 };
  near.consume(events); far.consume(events);
  assert.deepEqual(events, before);
  assert(near.particles.some(p => p.kind === 'smoke'));
  assert.equal(far.particles.filter(p => p.kind === 'smoke').length, 0);
  assert.equal(jets(far).length, jets(near).length);
  assert.equal(far.particles.filter(p => p.kind === 'flash').length, 4);
  assert.deepEqual(far.lights, near.lights, 'muzzle illumination keeps its positions, size, lifetime and strength');
  assert(jets(far).every(p => p.sprite.anchorX === MUZZLE_JET_ROOT));
});

test('readable powder smoke survives thinning; explosion cues and rocket trails retain their meaning at distance', t => {
  const gun = effects(t); gun.view = { zoom: 2 }; gun.consume([shot('rh202')]);
  const smoke = gun.particles.filter(p => p.hotSmoke === 4);
  assert(smoke.length > 0);
  assert(smoke.some(p => Math.SQRT2 * p.size * gun.view.zoom < 1), 'initial size alone must not discard a puff that grows into view');
  const signature = fx => fx.particles.map(({ sprite, layer, ...p }) => p);
  const near = effects(t), far = effects(t); far.view = { zoom: .01 };
  const event = { type: 'explosion', x: 4, y: 2, power: 240, radius: 1 }, before = structuredClone(event);
  near.consume([event]); far.consume([event]);
  assert.deepEqual(event,before);
  assert.deepEqual(signature(far).filter(p=>p.kind==='flash'),signature(near).filter(p=>p.kind==='flash'));
  assert.deepEqual(far.lights,near.lights);
  assert.equal(far.particles.filter(p=>p.kind==='fire').length,near.particles.filter(p=>p.kind==='fire').length);
  assert(far.particles.length < near.particles.length, 'secondary explosion particles can become unreadable');
  const nearRocket=effects(t),farRocket=effects(t);farRocket.view={zoom:.01};
  nearRocket.rocketTrail({x:3,y:2},{x:2,y:2});farRocket.rocketTrail({x:3,y:2},{x:2,y:2});
  assert.deepEqual(signature(farRocket),signature(nearRocket));
});

test('every weapon shows a flame at its muzzle, a burst of light and smoke, sized by its bore', t => {
  const lengths = {};
  for (const preset of Object.keys(WEAPON_PRESETS)) {
    const fx = effects(t), event = shot(preset), before = structuredClone(event);
    fx.consume([event]);
    assert.deepEqual(event, before, preset + ': presentation cannot alter the native shot');
    const main = jets(fx).find(p => forward(p) > .99);
    assert(main, preset + ' has a tongue of flame along its bore');
    assert(main.x === 4 && main.y === 2 && main.sprite.anchorX === MUZZLE_JET_ROOT, 'the flame is rooted at the muzzle, not centred on it');
    assert(main.layer === fx.actorLayers.get('tank').fire, 'the opaque flame lies with the fire, so a bright sky cannot wash it out');
    assert(fx.particles.some(p => p.kind === 'flash' && p.additive && p.sprite.texture === fx.atlas.flash), preset + ' has a burst of light');
    assert(fx.particles.some(p => p.kind === 'smoke'), preset + ' leaves smoke'); assert.equal(fx.lights.length, 1);
    assert(fx.particles.length <= 90, preset + ' stays within a small budget: ' + fx.particles.length);
    assert(fx.particles.every(p => p.effectActorId === 'tank' && p.life <= 4.5));
    lengths[preset] = main.size;
    fx.update(.2); assert.equal(jets(fx).length, 0, 'the flame is gone within a fifth of a second'); assert.equal(fx.lights.length, 0);
    fx.update(5); assert.equal(fx.particles.length, 0);
  }
  assert(lengths.minimi < lengths.fnmag && lengths.fnmag < lengths.m2hb && lengths.m2hb < lengths.rh202);
  assert(lengths.rh202 < lengths.mk44 && lengths.mk44 < lengths.mk35 && lengths.mk35 < lengths.rh120);
  assert(lengths.m224 < lengths.m252 && lengths.m119 < lengths.m777);
  assert(lengths.m2hb < .7 && lengths.rh120 > 2.5 && lengths.rh120 < 4, 'from a hand span for a machine gun to a few metres for a tank gun');
});

test('a muzzle brake vents to both sides and a launcher blasts rearward', t => {
  const braked = effects(t), plain = effects(t), launcher = effects(t);
  braked.consume([shot('m777', { angle: .4 })]); plain.consume([shot('rh120', { angle: .4 })]); launcher.consume([shot('at4', { angle: .4 })]);
  const side = jets(braked).filter(p => Math.abs(forward(p, .4)) < .4), main = jets(braked).find(p => forward(p, .4) > .99);
  assert.equal(side.length, 2); assert(Math.sin(side[0].rotation - .4) * Math.sin(side[1].rotation - .4) < 0, 'one jet to each side');
  assert(side.every(p => p.size < main.size * .5));
  assert.equal(jets(plain).length, 1, 'a smooth bore without a brake has only its forward flame');
  const back = jets(launcher).find(p => forward(p, .4) < -.99), front = jets(launcher).find(p => forward(p, .4) > .99);
  assert(back && front && back.size > front.size * 1.5, 'the backblast is larger than what leaves the front');
  const smoke = launcher.particles.filter(p => p.kind === 'smoke'), rearward = smoke.filter(p => p.vx * Math.cos(.4) + p.vy * Math.sin(.4) < 0);
  assert(rearward.length > smoke.length / 2);
});

test('rapid fire keeps its flashes at low quality and stays within the particle budget', t => {
  const fx = effects(t); fx.setQuality('low');
  for (let i = 0; i < 400; i++) { fx.consume([shot('m2hb', { x: 4 + i * .001 })]); fx.update(1 / 60); }
  assert(fx.particles.length <= fx.limit); assert(fx.lights.length <= 64);
  const fresh = effects(t);
  for (let i = 0; i < 50; i++) {
    fresh.clear(); fresh.setQuality('low'); fresh.random.state = 1000 + i; fresh.consume([shot('m2hb')]);
    assert.equal(jets(fresh).length, 1, 'thinning the smoke never removes the flash itself');
  }
});

test('a big gun near the ground raises dust along the real surface, and a high one does not', t => {
  const terrain = new Terrain('hills'), low = effects(t, terrain), high = effects(t, terrain), small = effects(t, terrain), x = 37;
  low.consume([shot('rh120', { x, y: terrain.height(x) + 1.2 })]); high.consume([shot('rh120', { x, y: terrain.height(x) + 9 })]);
  small.consume([shot('m2hb', { x, y: terrain.height(x) + .6 })]);
  assert(low.particles.filter(p => p.groundDust).length >= 3);
  assert.equal(high.particles.filter(p => p.groundDust).length, 0); assert.equal(small.particles.filter(p => p.groundDust).length, 0);
  assert.equal(low.blastWaves.waves.length, 1, 'the shot of a large gun has a faint pressure ring'); assert.equal(small.blastWaves.waves.length, 0);
  for (let i = 0; i < 30; i++) { low.update(1 / 60); low.sample(1); }
  for (const p of low.particles.filter(p => p.groundDust)) assert(Math.abs(p.y - terrain.height(p.x) - p.dustLift) < 1e-9);
  assert.equal(low.blastWaves.waves.length, 0);
});

test('a cannon or a howitzer keeps the faint ring of its blast, smaller than any burst that throws one; no other gun has one', t => {
  // The reach, edge and life each ring had before bursts were sized by their radius.
  const kept = { rh120: [1.8202, .108, .17012], m119: [1.5602, .108, .16914], m777: [2.027, .11047, .17218] };
  for (const preset of Object.keys(WEAPON_PRESETS)) {
    const fx = effects(t); fx.consume([shot(preset)]);
    const rings = fx.blastWaves.waves, ring = kept[preset];
    if (!ring) { assert.equal(rings.length, 0, preset); continue; }
    assert.equal(rings.length, 1, preset); assert.equal(rings[0].refraction, 1);
    assert(rings[0].endRadius < 3, 'below the radius from which a burst throws a front');
    for (const [i, key] of ['endRadius', 'opacity', 'life'].entries()) assert(Math.abs(rings[0][key] - ring[i]) < 1e-4, `${preset} ${key}`);
  }
});

test('a burst on the ground throws soil and marks it; the same burst in the air does neither', t => {
  const terrain = new Terrain('hills'), x = 37, ground = terrain.height(x), onGround = effects(t, terrain), inAir = effects(t, terrain),
    event = y => ({ type: 'explosion', actorId: 'tank', x, y, power: 600, radius: 4.5 });
  onGround.consume([event(ground + .1)]); inAir.consume([event(ground + 6)]);
  const clods = fx => fx.particles.filter(p => p.kind === 'dust'), soil = fx => fx.particles.filter(p => p.kind === 'smoke' && p.art==='denseSmoke');
  assert(clods(onGround).length >= 10 && soil(onGround).length >= 12); assert.equal(clods(inAir).length + soil(inAir).length, 0);
  assert(clods(onGround).every(p => p.vy > 0) && soil(onGround).every(p => p.vy > 0), 'the ground is thrown upward');
  assert(soil(onGround).every(p => p.aspectY > p.aspectX && p.opacity>.8),
    'fine soil is an upright dense plume');
  assert(onGround.particles.filter(p => p.kind === 'smoke' || p.kind === 'dust').every(p => p.y >= terrain.height(p.x)));
  assert.equal(onGround.scorches.length, 1); assert.equal(inAir.scorches.length, 0);
  assert(onGround.scorches[0].width > 1 && onGround.scorches[0].width < 4.5, 'the mark is narrower than the lethal radius');
  assert(onGround.particles.length <= 420 && inAir.particles.length <= 260);
  onGround.update(2.5); assert.equal(clods(onGround).length,0,'solid fragments are no longer visible');
  assert(soil(onGround).length>0&&soil(onGround).every(p=>p.vy>=0),'fine soil stays suspended with the rising smoke');
  assert(onGround.particles.some(p => p.kind === 'smoke' && p.y > ground + 3), 'a column of smoke climbs out of the burst');
});

test('a rocket motor glows at the head of its smoke trail', t => {
  const fx = effects(t); fx.rocketTrail({ x: 3, y: 2 }, { x: 2, y: 2 });
  const glow = fx.particles.filter(p => p.kind === 'flash');
  assert.equal(glow.length, 1); assert(glow[0].x === 3 && glow[0].additive && glow[0].life < .1);
  assert(fx.particles.filter(p => p.kind === 'smoke').length >= 8);
});
