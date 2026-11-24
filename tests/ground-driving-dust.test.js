import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUND_SURFACES } from '../src/ground-impact.ts';
import { dustDrive, dustScene } from './helpers/driving-dust.js';

test('rolling without slip raises a larger, longer dust trail progressively with road speed', () => {
  const slow = dustDrive({ speed: 3 }), medium = dustDrive({ speed: 10 }), fast = dustDrive({ speed: 30 });
  assert(slow.count > 0 && medium.count > slow.count * 1.5 && fast.count > medium.count * 1.4);
  assert(fast.emitted.every(p => p.kind === 'smoke' && p.tint === GROUND_SURFACES.soil.dust && p.vx < 0));
  assert(Math.min(...fast.emitted.map(p => p.size)) > Math.max(...slow.emitted.map(p => p.size)));
  assert(Math.min(...fast.emitted.map(p => p.grow)) > Math.max(...slow.emitted.map(p => p.grow)));
  assert(Math.min(...fast.emitted.map(p => p.opacity)) > Math.max(...slow.emitted.map(p => p.opacity)));
  assert(fast.emitted.every(p => p.life < 2.1 && p.opacity <= .34), 'rolling dust remains a short, translucent cloud');
});

test('one rolling budget per vehicle is independent of axle count and remains stable at 30, 60 and 120 FPS', () => {
  const one = dustDrive({ speed: 30, wheels: 1 }), many = dustDrive({ speed: 30, wheels: 12 }),
    counts = [30, 60, 120].map(fps => dustDrive({ speed: 30, fps, seconds: 6 }).count);
  assert.equal(many.count, one.count, 'extra axles distribute the same particles rather than multiplying their rate');
  assert(Math.max(...counts) - Math.min(...counts) < counts[1] * .2, String(counts));
  assert(counts.every(count => count >= 160 && count <= 270), 'the capped rate stays near 36 particles per second');
});

test('fast legitimate contact travel at 20 or 10 FPS is retained while a hundred-metre teleport is rejected', () => {
  for (const [speed, fps] of [[47, 20], [30, 10]]) {
    const run = dustDrive({ speed, fps, seconds: 6 });
    assert(run.count >= 160 && run.count <= 270, `${speed} m/s at ${fps} FPS: ${run.count} particles`);
    const scene = dustScene({ speed });
    try {
      scene.at(1 / fps); const before = scene.fx.particles.length;
      for (const module of scene.modules) module.groundContact.x += 100;
      scene.trails.record(scene.state, scene.terrain, 2 / fps);
      assert.equal(scene.fx.particles.length, before, 'the velocity allowance cannot turn a teleport into travel');
    } finally { scene.dispose(); }
  }
});

test('rolling uses only actual loose-ground contacts, with no stationary, airborne or hard-surface puffs', () => {
  for (const speed of [0, .5, .75]) assert.equal(dustDrive({ speed }).count, 0);
  for (const surface of ['concrete', 'rock']) assert.equal(dustDrive({ speed: 30, slip: 8, surface }).count, 0);
  for (const surface of ['soil', 'sand', 'gravel']) assert(dustDrive({ speed: 15, surface }).kinds.smoke > 10);
  const mud = dustDrive({ speed: 15, surface: 'mud' }); assert(mud.count > 0 && mud.kinds.smoke === 0);
  const reverse = dustDrive({ speed: -15 }); assert(reverse.count > 0 && reverse.emitted.every(p => p.vx > 0));
  for (const missing of ['airborne', 'detached']) {
    const scene = dustScene({ speed: 30, slip: 8 });
    try {
      for (const module of scene.modules) if (missing === 'airborne') module.groundContact = null; else module.attached = false;
      for (let i = 1; i <= 60; i++) scene.at(i / 60);
      assert.equal(scene.fx.particles.length, 0, missing);
    } finally { scene.dispose(); }
  }
});

test('pause, teleport, re-contact and a long presentation gap emit no artificial burst', () => {
  const scene = dustScene({ speed: 30, slip: 8 }), { modules, state, terrain, trails, fx } = scene;
  try {
    for (let i = 1; i <= 60; i++) scene.at(i / 60);
    const before = fx.particles.length;
    for (const module of modules) module.groundContact.x += 100;
    trails.record(state, terrain, 1); assert.equal(fx.particles.length, before, 'paused time emits nothing');
    trails.record(state, terrain, 1 + 1 / 60); assert.equal(fx.particles.length, before, 'teleport is rejected before slip or rolling emissions');
    for (const module of modules) module.groundContact = null;
    trails.record(state, terrain, 1 + 2 / 60);
    for (const [i, module] of modules.entries()) module.groundContact = { x: 200 + i * 1.5 };
    trails.record(state, terrain, 1 + 3 / 60); assert.equal(fx.particles.length, before, 'first re-contact initializes its anchor');
    trails.record(state, terrain, 8); assert.equal(fx.particles.length, before, 'a long gap does not catch up missed dust');
    trails.record(state, terrain, 0); assert.equal(fx.particles.length, before, 'restoration starts with no emission');
    assert.equal(trails.marks.length, 0);
  } finally { scene.dispose(); }
});

test('slipping keeps its stronger clod jet and rolling dust reuses the existing bounded particle pool', () => {
  const rolling = dustDrive({ speed: 30 }), slipping = dustDrive({ speed: 30, slip: 8 });
  assert(slipping.count > rolling.count * 1.8 && slipping.kinds.dust > 50);
  assert(slipping.emitted.some(p => p.kind === 'dust' && p.opacity > .9 && p.vy > 2));
  const pooled = dustDrive({ speed: 30, slip: 8, wheels: 12, seconds: 20, quality: 'low', advance: true });
  assert(pooled.count > pooled.sprites * 5, 'retired particle sprites are reused over sustained driving');
  assert(pooled.maxAlive <= pooled.limit && pooled.sprites <= pooled.limit + 1);
  const saturated = dustDrive({ speed: 30, slip: 8, wheels: 12, seconds: 30, quality: 'low' });
  assert.equal(saturated.maxAlive, saturated.limit); assert.equal(saturated.sprites, saturated.limit, 'even unretired driving particles cannot exceed the existing quality budget');
});
