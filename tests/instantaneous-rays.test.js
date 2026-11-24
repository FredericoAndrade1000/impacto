import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { FramePresentation } from '../src/presentation.ts';
import { Effects } from '../src/effects.ts';

const state = time => ({ time, modules: [], plates: [], actors: [] });
const ray = (id = 'ray-1', time = .05) => ({ type: 'secondary-ray', projectileId: id, time,
  x: 2, y: 3, endX: 2.4, endY: 3.3, internal: true, actorId: 'tank',
  energyBudget: 50, energySpent: 20 });
const contact = (id = 'ray-1', time = .05, extra = {}) => ({ type: 'secondary-impact', projectileId: id,
  time, x: 2.2, y: 3.1, nx: -1, ny: 0, actorId: 'tank', material: 'steel', power: 2,
  fragment: true, spall: true, instantaneous: true, ...extra });

function effects(t) {
  const parent = new Container(), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
    spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY }, fx = new Effects(parent, atlas);
  t.after(() => { fx.clear(); parent.destroy({ children: true }); }); return fx;
}

test('a fragment ray shows as a streak to where it stopped and sparks at its contact, never as a round or a path', t => {
  const playback = new FramePresentation(), fx = effects(t), events = [contact('ray-1', .05, { x: 2.4, y: 3.3 }), ray()], original = structuredClone(events);
  playback.receive(state(0), [], { now: 0 });
  playback.receive(state(.1), events, { now: 0 });
  const show = now => playback.present(playback.sample(now), {
    update: dt => fx.update(dt), consume: (e, ahead) => fx.consume([e], ahead),
  });
  const before = show(25);
  assert.equal(before.time, .025); assert.equal(before.events.length, 0);
  assert.equal(before.shots.length, 0); assert.equal(fx.particles.length, 0);
  const impact = show(50);
  assert.equal(impact.time, .05); assert.deepEqual(impact.events, events);
  assert.equal(impact.shots.length, 0); assert.equal(impact.specks.count, 0); assert.equal(impact.shotTrails.length, 0);
  assert(!Object.hasOwn(impact, 'traces')); assert.equal(playback.paths.length, 0);
  const streaks = fx.particles.filter(p => p.art === 'spark');
  assert.equal(streaks.length, 1, 'one streak for the ray');
  assert(Math.abs(streaks[0].x - 2.2) < 1e-12 && Math.abs(streaks[0].y - 3.15) < 1e-12 && Math.abs(streaks[0].size - .5) < 1e-12,
    'from where the ray starts to the contact it stopped at');
  assert(fx.particles.filter(p => p.kind === 'spark').some(p => p.x === 2.4 && p.y === 3.3), 'the contact itself sparks');
  assert(fx.particles.every(p => p.effectActorId === 'tank'), 'all of it with the construction the ray went through');
  const later = show(75);
  assert.equal(later.events.length, 0); assert(fx.particles.every(p => Math.abs(p.age - .025) < 1e-12));
  assert.deepEqual(events, original, 'presentation cannot mutate native damage evidence');
});

test('what a ray shows follows simulation time through pause and replay reset without fragment history', t => {
  const playback = new FramePresentation(), fx = effects(t), events = [contact(), ray()],
    show = now => playback.present(playback.sample(now), { update: dt => fx.update(dt), consume: (e, ahead) => fx.consume([e], ahead) });
  playback.receive(state(0)); playback.receive(state(.1), events, { now: 0 }); show(75);
  playback.paused = true;
  const paused = show(5000), particles = fx.particles.map(p => [p.x, p.y, p.age]), later = show(9000);
  assert.equal(paused.time, .1); assert.equal(later.time, .1);
  assert.deepEqual(fx.particles.map(p => [p.x, p.y, p.age]), particles);
  assert.equal(later.events.length, 0); assert.equal(playback.paths.length, 0);
  playback.receive(state(2.5), [], { now: 9000, paused: true }); show(9000);
  assert.equal(fx.particles.length, 0);
  playback.receive(state(0), [], { paused: true });
  assert.equal(playback.paths.length, 0); assert.equal(playback.pending.length, 0);
});

test('hundreds of internal and external rays stay within the budget and make no paths or rounds', t => {
  const playback = new FramePresentation(), fx = effects(t), events = Array.from({ length: 600 }, (_, i) => ({ ...ray(`ray-${i}`), internal: i % 2 === 0 })),
    contacts = [contact('ray-2'), contact('ray-3', .05, { material: 'concrete', x: 4 })], original = structuredClone(events);
  playback.receive(state(0)); playback.receive(state(.1), [...contacts, ...events], { paused: true });
  const frame = playback.present(playback.sample(0), { consume: e => fx.consume([e]) });
  assert.equal(playback.paths.length, 0); assert.equal(playback.shotTrailHistory.size, 0);
  assert.equal(frame.shots.length, 0); assert.equal(frame.specks.count, 0); assert.equal(frame.shotTrails.length, 0);
  assert(!Object.hasOwn(frame, 'traces')); assert.equal(frame.events.length, 602);
  assert(fx.particles.length <= fx.limit);
  assert.equal(fx.particles.filter(p => p.art === 'glow').length, 1, 'the rays thrown from one place at once light it once');
  assert.deepEqual(events, original); assert.equal(playback.pending.length, 0);
  fx.update(2); assert.equal(fx.particles.length, 0); playback.clear(); assert.equal(playback.paths.length, 0);
});

test('malformed or zero-length rays cannot fabricate a source flash or endpoint contact', t => {
  const playback = new FramePresentation(), fx = effects(t), events = [
    { ...ray('bad'), endX: NaN }, { ...ray('still'), endX: 2, endY: 3 },
  ], before = structuredClone(events);
  playback.receive(state(0)); playback.receive(state(.1), events, { paused: true });
  const frame = playback.present(playback.sample(0), { consume: e => fx.consume([e]) });
  assert.equal(frame.shots.length, 0); assert.equal(frame.shotTrails.length, 0); assert.equal(playback.paths.length, 0);
  assert.equal(fx.particles.length, 0); assert.deepEqual(events, before);
});

test('legacy fragment flight records cannot become primary bodies or tracer histories', () => {
  const playback = new FramePresentation(), flight = { type: 'flight', id: 'old-chip', fragment: true, spall: true,
    points: [{ x: 1, y: 2, time: 0 }, { x: 4, y: 2, time: .05 }] }, original = structuredClone(flight);
  playback.receive(state(0)); playback.receive(state(.1), [flight], { paused: true });
  const frame = playback.present(playback.sample(0));
  assert.equal(playback.paths.length, 0); assert.equal(frame.shots.length, 0); assert.equal(frame.shotTrails.length, 0);
  assert.equal(playback.shotTrailHistory.size, 0); assert.deepEqual(flight, original);
});
