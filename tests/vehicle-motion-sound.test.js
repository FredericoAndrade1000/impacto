import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundSystem, MAX_PROFILE_VOICES, MAX_SOUND_VOICES, soundCue } from '../src/audio.ts';
import { SuspensionSoundGate } from '../src/suspension-sound-gate.ts';
import { sceneFrame } from '../src/scene-frame.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { Publication } from '../server/publication.ts';
import { FrameReader, FrameWriter } from '../src/network-protocol.ts';

const actor = (id = 'truck', changes = {}) => ({ id, revision: 0, vehicle: { x: 12, y: 1.5, vx: 0, vy: 0, ...changes } });
const frame = (time, modules = [], actors = [actor()]) => ({ time, modules, actors, plates: [], attachments: [] });
const gear = (d, changes = {}) => ({ id: 'wheel', actorId: 'truck', kind: 'wheel', health: 100, x: 12, y: .5, suspension: { displacement: d }, groundContact: { x: 12 }, ...changes });
const jet = (thrust, changes = {}) => ({ id: 'jet', actorId: 'truck', kind: 'thruster', health: 100, x: 12, y: 2, width: .64, height: 1.31, thrust, ...changes });
async function setup(t) {
  const ctx = fakeAudioContext(), sound = new SoundSystem({ contextFactory: () => ctx,
    storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() });
  await sound.unlock(); sound.setActive(true); t.after(() => sound.stop()); return { ctx, sound };
}

test('a compression sounds once, requires a rebound, and stays quiet at rest or on repeated frames', () => {
  const gate = new SuspensionSoundGate(), sample = (time, d, changes) => {
    const state = frame(time, [gear(d, changes)]); return gate.sample(state, sceneFrame(state));
  };
  assert.equal(sample(0, .02).length, 0);
  for (let i = 1; i <= 30; i++) assert.equal(sample(i * .05, .02 + i % 2 * .001).length, 0);
  assert.equal(sample(1.55, .05).length, 1);
  assert.equal(sample(1.55, .05).length, 0);
  assert.equal(sample(1.6, .08).length, 0, 'continuing the same compression does not drum');
  assert.equal(sample(1.65, .09).length, 0);
  assert.equal(sample(1.7, .03).length, 0, 'rebound itself is silent');
  assert.equal(sample(1.75, .07).length, 1);
  assert.equal(sample(1.8, .01, { groundContact: null }).length, 0);
  assert.equal(sample(1.85, .07, { groundContact: null }).length, 0);
  assert.equal(sample(3, .14).length, 0, 'no invented stroke over a delivery gap');
  assert.equal(sample(3.05, .19, { x: 500 }).length, 0, 'a teleport is not a bump');
});

test('suspension history is cleared on replacement, removal and stop, and remains bounded', async t => {
  const gate = new SuspensionSoundGate(2), first = frame(0, [gear(0)]); gate.sample(first, sceneFrame(first));
  const changed = frame(.05, [gear(.09)], [{ ...actor(), revision: 1 }]);
  assert.equal(gate.sample(changed, sceneFrame(changed)).length, 0);
  const many = frame(.1, Array.from({ length: 100 }, (_, i) => gear(.1, { id: 'wheel-' + i })));
  gate.sample(many, sceneFrame(many)); assert.equal(gate.parts.size, 2);
  gate.sample(frame(.15), sceneFrame(frame(.15))); assert.equal(gate.parts.size, 0);
  const { ctx, sound } = await setup(t);
  sound.receive(frame(0, [gear(0)]), []); ctx.advance(.05); sound.receive(frame(.05, [gear(.08)]), []);
  assert(sound.voices.some(v => v.profile === 'suspension'));
  sound.setActive(false); assert.equal(sound.suspensionGate.parts.size, 0); assert.equal(sound.voices.length, 0);
});

test('real published suspension travel sounds on a small landing but not during settled support', async t => {
  const world = new World(createConstruction('scout')); t.after(() => world.dispose());
  const { ctx, sound } = await setup(t), publication = new Publication(), writer = new FrameWriter(), reader = new FrameReader();
  const listen = () => {
    const state = reader.decode(writer.encode({ state: publication.state(world.snapshot()), events: [] })).state;
    ctx.advance(world.time); sound.receive(state, []);
  };
  for (let i = 0; i < 180; i++) { world.step(); world.drainEvents(); if (i % 3 === 0) listen(); }
  sound.stop();
  const sources = () => ctx.nodes.filter(n => n.kind === 'buffer' && n.buffer?.url === 'suspension.mp3').length, before = sources();
  for (let i = 0; i < 90; i++) { world.step(); world.drainEvents(); if (i % 3 === 0) listen(); }
  assert.equal(sources(), before, 'steady support has no percussion');
  world.command('setVehicleState', { state: { y: world.vehicle.y + .35 } });
  for (let i = 0; i < 120; i++) { world.step(); world.drainEvents(); if (i % 3 === 0) listen(); }
  assert(sources() > before, 'the existing published spring movement is enough, without a new network event');
  assert.equal(soundCue({ type: 'ground', contactPair: 'terrain:a:b', impactEnergy: 100 }).profile, 'suspension');
  assert.equal(soundCue({ type: 'ground', power: 100 }).profile, 'ground-hit');
});

test('jets follow public thrust and nozzle positions, group per vehicle, then fade off within the existing voice budget', async t => {
  const { ctx, sound } = await setup(t), listen = (time, thrust, count = 2) => {
    ctx.advance(time); sound.receive(frame(time, Array.from({ length: count }, (_, i) => jet(thrust, { id: 'jet-' + i, x: 11 + 2 * i }))), []);
  }, voices = () => sound.voices.filter(v => v.profile === 'jet');
  listen(0, 0); assert.equal(voices().length, 0);
  listen(.1, .2); const voice = voices()[0], source = voice.sources[0], quiet = voice.chain.gain.gain.soundTarget, idle = source.playbackRate.soundTarget;
  assert(voice && source.loop); assert.equal(voice.x, 12); assert.equal(voice.y, 2);
  listen(.2, 1, 4); assert.equal(voices().length, 1); assert.equal(voices()[0].sources[0], source);
  assert(voice.chain.gain.gain.soundTarget > quiet); assert(source.playbackRate.soundTarget > idle);
  listen(.3, 0); assert.equal(voice.chain.gain.gain.soundTarget, 0); assert.equal(source.stops.length, 0);
  listen(1.2, 0); assert.equal(voices().length, 0); assert(source.stops.length);
  const actors = Array.from({ length: 20 }, (_, i) => actor('unit-' + i));
  sound.receive(frame(2, actors.map(a => jet(1, { id: a.id + '-jet', actorId: a.id })), actors), []);
  assert.equal(voices().length, MAX_PROFILE_VOICES); assert(sound.voices.length <= MAX_SOUND_VOICES);
  sound.setShown(false); assert.equal(voices().length, 0);
});
