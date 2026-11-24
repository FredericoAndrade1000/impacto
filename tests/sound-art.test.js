import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { SOUND_PROFILES, LOOP_PAD, SoundBufferBank, soundFiles } from '../src/sound-art.ts';
import { SoundSystem, soundCue, soundPosition, hearing, MAX_SOUND_VOICES, MAX_PROFILE_VOICES, MAX_ENGINE_LOOPS, MAX_FIRE_LOOPS, MAX_FIRE_EMITTERS, MAX_SERVO_LOOPS, FADE } from '../src/audio.ts';
import { LIFT_HOLD } from '../src/work-arm.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';

const folder = new URL('../sounds/', import.meta.url);

test('the recordings beside the game match their profile counts and are light enough for a phone', () => {
  const names = readdirSync(folder).filter(name => name.endsWith('.mp3')),
    found = soundFiles(Object.fromEntries(names.map(name => ['../sounds/' + name, name])));
  assert.equal(found.size, Object.keys(SOUND_PROFILES).length);
  assert.equal(names.length, found.size, 'no file the game does not play');
  const bytes = names.reduce((sum, name) => sum + statSync(new URL(name, folder)).size, 0);
  assert(bytes < 2 * 1024 * 1024, `${bytes} bytes`);
});

test('each profile has one filename; unknown names and retired numbered files are ignored', () => {
  const found = soundFiles({ '../sounds/gun-light.mp3': 'a', '/elsewhere/blast-heavy.mp3': 'b', '../sounds/gun-light-0.mp3': 'c', '../sounds/gun-heavy-2.mp3': 'f', '../sounds/laser.mp3': 'd', '../sounds/notes.txt': 'e', '../sounds/blast-fuel.mp3': 'retired' });
  assert.deepEqual([...found], [['gun-light', 'a'], ['blast-heavy', 'b']]);
});

test('weapon and explosion cues distinguish artillery, rockets, blast size and fuel', () => {
  const gun = caliberMm => soundCue({ type: 'muzzle', caliberMm });
  assert.notEqual(gun(7.62).profile, gun(12.7).profile);
  assert.notEqual(gun(25).profile, gun(120).profile);
  assert.equal(soundCue({ type: 'muzzle', weapon: 'rocket' }).profile, 'rocket');
  assert.equal(soundCue({ type: 'muzzle', weapon: 'mortar', caliberMm: 60 }).profile, 'gun-lob');
  const small = soundCue({ type: 'explosion', power: 90 }), large = soundCue({ type: 'explosion', power: 600 });
  assert(small.volume < large.volume);
  assert.deepEqual([small.profile, small.duration], ['blast-small', 3.5]);
  assert.deepEqual([large.profile, large.duration], ['blast-heavy', 8]);
  assert.deepEqual([SOUND_PROFILES['blast-small'].level, SOUND_PROFILES['blast-small'].reach], [1.05, 300]);
  assert.deepEqual([SOUND_PROFILES['blast-heavy'].level, SOUND_PROFILES['blast-heavy'].reach], [1.58, 700]);
  assert.equal(soundCue({ type: 'explosion', power: 219 }).profile, 'blast-small');
  assert.equal(soundCue({ type: 'explosion', power: 220 }).profile, 'blast-heavy');
  for (const power of [0, 90, 219, 220, 600]) {
    const fuel = soundCue({ type: 'explosion', sourceKind: 'fuel', power });
    assert.equal(fuel.profile, large.profile);
    assert.equal(fuel.duration, large.duration);
    assert.equal(fuel.filter, large.filter);
    assert.equal(fuel.filter, 11000);
  }
  assert.notEqual(soundCue({ type: 'blocked', material: 'steel' }).profile, soundCue({ type: 'blocked', material: 'concrete' }).profile);
  assert(soundPosition({ x: 90, y: 1 }, hearing({ x: 0, y: 1 })).cutoff < soundPosition({ x: 2, y: 1 }, hearing({ x: 0, y: 1 })).cutoff);
});

test('projectile ground impacts share the selected sound on soil and concrete while armor and debris stay distinct', () => {
  for (const surface of ['soil', 'concrete']) {
    for (const event of [{ type: 'ground', surface }, { type: 'ricochet', ground: true, surface }]) {
      assert.equal(soundCue(event).profile, 'ground-hit');
      assert.equal(soundCue(event).duration, 2.5);
    }
  }
  for (const type of ['blocked', 'penetration']) {
    assert.equal(soundCue({ type, material: 'steel' }).profile, 'metal-hit');
    assert.equal(soundCue({ type, material: 'concrete' }).profile, 'hard-hit');
  }
  assert.equal(soundCue({ type: 'ricochet' }).profile, 'ricochet');
  assert.equal(soundCue({ type: 'debris', material: 'steel' }).profile, 'clunk');
  for (const material of ['concrete', 'soil']) assert.equal(soundCue({ type: 'debris', material }).profile, 'hard-hit');
});

test('only metal projectile impacts of at least 25 mm use the approved C1 recording', () => {
  for (const type of ['blocked', 'penetration']) {
    for (const caliberMm of [5.56, 12.7, 20, 24.99, 25, 30, 120]) {
      const cue = soundCue({ type, material: 'steel', caliberMm, power: 300 });
      assert.equal(cue.profile, caliberMm >= 25 ? 'metal-hit-heavy' : 'metal-hit', `${type}: ${caliberMm} mm`);
      assert.equal(cue.duration, caliberMm >= 25 ? 2.81 : .6);
      assert.equal(soundCue({ type, material: 'concrete', caliberMm }).profile, 'hard-hit');
      assert.equal(soundCue({ type: 'ground', surface: 'soil', caliberMm }).profile, 'ground-hit');
      assert.equal(soundCue({ type: 'debris', material: 'steel', caliberMm }).profile, 'clunk');
      assert.equal(soundCue({ type: 'ricochet', caliberMm }).profile, 'ricochet');
    }
  }
});

async function setup() {
  const ctx = fakeAudioContext(), sound = new SoundSystem({ contextFactory: () => ctx, storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() });
  await sound.unlock(); sound.setActive(true); return { ctx, sound };
}
const frame = (time = 1, changes = {}) => ({ time, actors: [], modules: [], plates: [], attachments: [], ...changes });
const burn = (changes = {}) => ({ type: 'burn', componentId: 'fuel', actorId: 'tank', x: 12, y: 1, strength: .8, time: 1, ...changes });
// The voices still sounding once the one that gave way to the last has faded out.
const sounding = (sound, ctx) => sound.voices.filter(v => v.endAt > ctx.currentTime + FADE);

test('many slow hits on steel and aluminum keep the chosen recordings whole without synthesizing musical notes', async () => {
  const { ctx, sound } = await setup(), plates = Array.from({ length: 12 }, (_, i) => ({
    id: 'plate-' + i, material: i % 2 ? 'aluminum' : 'steel', actorId: 'local', integrity: 1,
    definition: { id: 'plate-' + i, x: 12 + i * .3, y: 1, angle: 0, length: 2, widthM: 1, thicknessMm: 12, anchors: [] },
  })), events = plates.map((plate, i) => ({ id: plate.id, projectileId: 'shot-' + i, type: 'blocked', material: plate.material,
    caliberMm: i < 6 ? 20 : 25, power: 8, impulse: 180, normalSpeed: 12, speed: 12, mass: .8, energy: 57.6,
    x: plate.definition.x, y: 1, time: 1 }));
  sound.receive(frame(1, { plates }), events);
  assert.equal(ctx.nodes.filter(node => node.kind === 'oscillator').length, 0, 'a recorded impact has no additional pitched sine tones');
  assert(sound.voices.length <= MAX_SOUND_VOICES);
  for (const profile of ['metal-hit', 'metal-hit-heavy']) {
    const voices = sound.voices.filter(voice => voice.profile === profile);
    assert(voices.length > 0 && voices.length <= MAX_PROFILE_VOICES);
    for (const voice of voices) {
      assert.equal(voice.sources[0].buffer, sound.bank.get(profile));
      assert(Math.abs(voice.endAt - voice.at - SOUND_PROFILES[profile].duration) < 1e-9);
    }
  }
  const count = ctx.nodes.length;
  sound.receive(frame(1, { plates }), events);
  assert.equal(ctx.nodes.length, count, 'repeated snapshots do not replay the impacts');
  sound.stop();
});

test('shots reuse prepared samples and consume one transient source each', async () => {
  const { ctx, sound } = await setup(), allocations = ctx.buffers.length, bank = sound.bank.get('gun-auto');
  for (let i = 0; i < 100; i++) { ctx.advance(i / 10); sound.play({ x: 12, y: 1, time: i / 10 }, soundCue({ type: 'muzzle', caliberMm: 25 })); }
  assert.equal(ctx.buffers.length, allocations); assert.equal(sound.bank.get('gun-auto'), bank);
  assert.equal(ctx.nodes.filter(n => n.kind === 'buffer').length, 100);
  assert.equal(sounding(sound, ctx).length, MAX_PROFILE_VOICES); assert(sound.voices.every(v => v.sources.length === 1 && v.sources[0].loop !== true));
  assert.equal(ctx.nodes.filter(n => n.kind === 'oscillator').length, 0);
  assert.equal(ctx.nodes.filter(n => n.kind === 'compressor').at(-1).attack.value, 0);
});

test('selected light and heavy shots keep one recording and play their complete tails at their original speed', async () => {
  const { ctx, sound } = await setup(), allocations = ctx.buffers.length;
  for (const [round, [caliberMm, profile]] of [[5.56, 'gun-light'], [7.62, 'gun-light'], [12.7, 'gun-heavy']].entries()) {
    const chosen = sound.bank.get(profile);
    for (let index = 0; index < 12; index++) {
      const time = round * 2 + index / 7, event = { type: 'muzzle', caliberMm, componentId: 'gun', time, x: 12, y: 1 }, cue = soundCue(event);
      assert.equal(cue.profile, profile); assert.equal(cue.duration, .8);
      ctx.advance(time); sound.play(event, cue);
      const source = sound.voices.at(-1).sources[0], rate = source.playbackRate.value;
      assert.equal(source.buffer, chosen);
      assert.equal(source.loop, undefined);
      assert.equal(rate, 1);
      assert.equal(source.stops[0], source.starts[0] + .8);
    }
  }
  assert.equal(ctx.buffers.length, allocations);
  assert.equal(sounding(sound, ctx).length, MAX_PROFILE_VOICES);
});

test('every field one-shot keeps its recording, speed and duration across different event identities, times and positions', async () => {
  const { ctx, sound } = await setup(), allocations = ctx.buffers.length,
    events = [{ id: 'a', actorId: 'unit-a', componentId: 'part-a', time: 0, x: -2, y: 1 },
      { id: 'b', actorId: 'unit-b', componentId: 'part-b', time: 3.7, x: 15, y: 2 },
      { id: 'c', actorId: 'unit-c', componentId: 'part-c', time: 17, x: 34, y: -1 }];
  for (const [profile, definition] of Object.entries(SOUND_PROFILES).filter(([name, p]) => !p.loop && !name.startsWith('alert-'))) {
    const chosen = sound.bank.get(profile), cue = { profile, duration: definition.duration, filter: 12000, volume: .4, priority: 3 };
    for (const event of events) {
      const before = ctx.nodes.length;
      sound.play(event, cue);
      const sources = ctx.nodes.slice(before).filter(node => node.kind === 'buffer');
      assert.equal(sources.length, 1, profile);
      const [source] = sources;
      assert.equal(source.buffer, chosen, profile);
      assert.equal(source.playbackRate.value, 1, profile);
      assert.equal(source.loop, undefined, profile);
      assert.deepEqual(source.starts, [ctx.currentTime], profile);
      assert.deepEqual(source.stops, [source.starts[0] + definition.duration], profile);
    }
  }
  assert.equal(ctx.buffers.length, allocations, 'events never decode or allocate another recording');
});

test('native burn events sustain one loop, follow the module and expire without synthetic fires', async () => {
  const { ctx, sound } = await setup(), module = { id: 'fuel', actorId: 'tank', kind: 'fuel', x: 12, y: 1, burning: true };
  const event = burn(), before = structuredClone(event);
  sound.receive(frame(1, { modules: [module] }), [event]); const fire = [...sound.fires.values()][0]; assert(fire);
  const count = ctx.nodes.length;
  for (let i = 1; i <= 20; i++) sound.receive(frame(1 + i * .1, { modules: [{ ...module, x: 12 + i }] }), [burn({ time: 1 + i * .1 })]);
  assert.equal(ctx.nodes.length, count); assert.equal([...sound.fires.values()][0], fire);
  assert(fire.pan.pan.calls.at(-1)[1] > .5); assert.equal(sound.voices.length, 0); assert.deepEqual(event, before);
  sound.receive(frame(3.15, { modules: [module] }), []); assert.equal(sound.fires.size, 1);
  sound.receive(frame(3.31, { modules: [module] }), []); assert.equal(sound.fires.size, 0); assert.equal(sound.fireEmitters.size, 0);
  assert(fire.sources[0].stops.length); assert(fire.nodes.every(n => n.disconnects));
  sound.receive(frame(4, { modules: [module] }), []); assert.equal(sound.fires.size, 0, 'burning state alone cannot invent a new audio event');
});

test('fire voices and emitter memory stay bounded; muted, paused and restored scenes release everything', async () => {
  const { sound } = await setup(), events = Array.from({ length: 100 }, (_, i) => burn({ componentId: `fuel-${i}`, x: 12 + i / 5 }));
  sound.receive(frame(), events); assert.equal(sound.fires.size, MAX_FIRE_LOOPS); assert.equal(sound.fireEmitters.size, MAX_FIRE_EMITTERS);
  sound.receive(frame(1.05), events); assert.equal(sound.fires.size, MAX_FIRE_LOOPS);
  sound.receive(frame(1.1), [], { active: false }); assert.equal(sound.fires.size, 0); assert.equal(sound.fireEmitters.size, 0);
  sound.receive(frame(2), [burn({ time: 2 })]); assert.equal(sound.fires.size, 1);
  sound.receive(frame(0), []); assert.equal(sound.fires.size, 0);
  sound.receive(frame(.1), [burn({ time: .1 })]); sound.setEnabled(false); assert.equal(sound.fires.size, 0);
  sound.receive(frame(.2), [burn({ time: .2 })]); assert.equal(sound.fires.size, 0);
});

test('removing the last actor or extinguishing its native module ends fire immediately', async () => {
  const { sound } = await setup(), actor = { id: 'tank' }, module = { id: 'fuel', kind: 'fuel', burning: true, x: 12, y: 1 };
  sound.receive(frame(1, { actors: [actor], modules: [module] }), [burn()]); assert.equal(sound.fires.size, 1);
  sound.receive(frame(1.01), []); assert.equal(sound.fires.size, 0);
  sound.receive(frame(2, { actors: [actor], modules: [module] }), [burn({ time: 2 })]); assert.equal(sound.fires.size, 1);
  sound.receive(frame(2.01, { actors: [actor], modules: [{ ...module, burning: false }] }), []); assert.equal(sound.fires.size, 0);
});

test('engines reuse nodes, respond to throttle and only sound rolling while in contact', async () => {
  const { ctx, sound } = await setup(), actor = { id: 'tank', vehicle: { engine: true, x: 12, y: 1, vx: 0, throttle: 0, traction: 1 } },
    track = { actorId: 'tank', id: 'track', kind: 'track', health: 100 };
  sound.receive(frame(1, { actors: [actor], modules: [track] }), []);
  const engine = sound.engines.get('tank'), count = ctx.nodes.length, idle = engine.motor.playbackRate.calls.at(-1)[1];
  for (let i = 0; i < 60; i++) sound.receive(frame(1, { actors: [actor], modules: [track] }), []);
  assert.equal(ctx.nodes.length, count); assert.equal(engine.motor.playbackRate.calls.length, 1, 'idle does not enqueue repeated automation');
  // Pressed on, it is in gear within a shift (gearbox.ts).
  for (const time of [2, 2.5]) sound.receive(frame(time, { actors: [{ ...actor, vehicle: { ...actor.vehicle, throttle: 1, vx: 5 } }], modules: [track] }), []);
  assert(engine.motor.playbackRate.calls.at(-1)[1] > idle); assert(engine.rollGain.gain.calls.at(-1)[1] > 0);
  sound.receive(frame(2.6, { actors: [{ ...actor, vehicle: { ...actor.vehicle, throttle: 1, vx: 5, traction: 0 } }], modules: [track] }), []);
  assert.equal(engine.rollGain.gain.calls.at(-1)[1], 0);
  const actors = Array.from({ length: 20 }, (_, i) => ({ id: String(i), vehicle: { ...actor.vehicle, x: 12 + i } }));
  sound.receive(frame(3, { actors }), []); assert.equal(sound.engines.size, MAX_ENGINE_LOOPS); assert(engine.sources.every(s => s.stops.length));
  sound.stop(); assert.equal(sound.engines.size, 0);
});

test('low-power fuel explosions resolved from their source module use the large explosion buffer without changing native events or snapshots', async () => {
  const { sound } = await setup(), events = [
    { type: 'explosion', componentId: 'fuel', source: 'fuel-id', x: 12, y: 1, power: 90, time: 1 },
    { type: 'explosion', source: 'fuel', x: 20, y: 1, power: 0, time: 1 },
    { type: 'explosion', source: 'shell', x: 28, y: 1, power: 600, time: 1 },
  ], snapshot = frame(1, { modules: [{ id: 'fuel', kind: 'fuel', x: 12, y: 1 }] }), before = structuredClone({ events, snapshot });
  sound.receive(snapshot, events);
  assert.equal(sound.voices.length, 3);
  for (const voice of sound.voices) {
    assert.equal(voice.sources.length, 1);
    assert.equal(voice.sources[0].buffer, sound.bank.get('blast-heavy'));
    assert.equal(voice.sources[0].playbackRate.value, 1);
    assert.equal(voice.chain.filter.frequency.value, 11000);
    assert.equal(voice.endAt, voice.at + 8);
  }
  assert.equal(sound.bank.get('blast-fuel'), undefined, 'fuel has no separate recording or fallback profile');
  const count = sound.voices.length; sound.receive(snapshot, events); assert.equal(sound.voices.length, count);
  assert.deepEqual({ events, snapshot }, before);
  assert(sound.loopDuck.gain.calls.some(c => c[0] === 'target' && c[1] === .4));
});

test('loops play their turn of the file, clear of the pad on both of its sides', async () => {
  const { sound } = await setup(), actor = { id: 'tank', vehicle: { engine: true, x: 12, y: 1, vx: 0, throttle: 0, traction: 1 } },
    modules = [{ actorId: 'tank', id: 'track', kind: 'track', health: 100 }, { id: 'fuel', actorId: 'tank', kind: 'fuel', x: 12, y: 1, burning: true }];
  sound.receive(frame(1, { actors: [actor], modules }), [burn()]);
  const engine = sound.engines.get('tank'), fire = [...sound.fires.values()][0];
  for (const [source, name] of [[engine.motor, 'diesel'], [engine.rolling, 'tracks'], [fire.sources[0], 'fire']]) {
    assert.equal(source.loop, true); assert.equal(source.loopStart, LOOP_PAD); assert.equal(source.loopEnd, LOOP_PAD + SOUND_PROFILES[name].duration);
    const into = source.offset; assert(into >= LOOP_PAD && into < source.loopEnd, name);
    assert.equal(source.buffer, sound.bank.get(name));
  }
});

test('separate loop emitters share one recording per profile and differ only in valid starting phases at the same operating state', async () => {
  const { ctx, sound } = await setup(), ids = ['a', 'b', 'c'],
    vehicle = { engine: true, x: 12, y: 1, vx: 5, throttle: .3, brake: 0, driveSpeed: 20, traction: 1, powerKw: 300, fuelRate: 75 },
    actors = ids.flatMap(id => [{ id: `tracked-${id}`, vehicle: { ...vehicle } }, { id: `wheeled-${id}`, vehicle: { ...vehicle } },
      { id: `braking-${id}`, vehicle: { ...vehicle, engine: false, throttle: 0, brake: 1, driveSpeed: 0 } },
      { id: `jet-${id}`, vehicle: { ...vehicle, engine: false } },
      { id: `build-${id}`, field: { wreck: null, service: { kind: 'build', until: 20 } } }]),
    modules = cargo => ids.flatMap(id => [
      { id: `track-${id}`, actorId: `tracked-${id}`, kind: 'track', health: 100 },
      { id: `wheel-${id}`, actorId: `braking-${id}`, kind: 'wheel', health: 100 },
      { id: `thruster-${id}`, actorId: `jet-${id}`, kind: 'thruster', health: 100, x: 12, y: 2, thrust: .6 },
      { id: `fuel-${id}`, actorId: `tracked-${id}`, kind: 'fuel', x: 12, y: 1, burning: true },
      { id: `hopper-${id}`, actorId: `wheeled-${id}`, kind: 'hopper', x: 12, y: 1, cargo: { ferro: cargo } },
      { id: `gun-${id}`, actorId: `tracked-${id}`, kind: 'weapon', health: 100, x: 12, y: 1, servoVelocity: .5 },
      { id: `workpiece-${id}`, actorId: `build-${id}`, kind: 'hull', x: 12, y: 1 },
    ]),
    burns = time => ids.map(id => burn({ componentId: `fuel-${id}`, actorId: `tracked-${id}`, time }));
  sound.receive(frame(1, { actors, modules: modules(10) }), burns(1));
  sound.receive(frame(1.1, { actors, modules: modules(11) }), burns(1.1));
  // An engine turns as the gearbox of its kind of running gear does (gearbox.ts): engines of one kind are in the same state.
  const byProfile = new Map(Object.entries(SOUND_PROFILES).filter(([, p]) => p.loop).map(([name]) => [name, []])), wheeled = [];
  for (const engine of sound.engines.values()) {
    (engine.tracked ? byProfile.get('diesel') : wheeled).push(engine.motor);
    byProfile.get(engine.tracked ? 'tracks' : 'wheels').push(engine.rolling);
  }
  for (const fire of sound.fires.values()) byProfile.get('fire').push(fire.sources[0]);
  for (const voice of sound.voices.filter(voice => voice.loop)) byProfile.get(voice.profile).push(...voice.sources);
  for (const [loops, profile] of [[sound.pours, 'ore'], [sound.servos, 'servo'], [sound.works, 'workshop']])
    for (const loop of loops.values()) byProfile.get(profile).push(loop.source);
  for (const [profile, sources] of [...byProfile, ['diesel', wheeled]]) {
    assert(sources.length >= 3, `${profile} has independent emitters`);
    assert(new Set(sources.map(source => source.offset)).size > 1, `${profile} does not synchronize every emitter`);
    assert.equal(new Set(sources.map(source => source.playbackRate.value)).size, 1, `${profile} does not change pitch by identity`);
    for (const source of sources) {
      assert.equal(source.buffer, sound.bank.get(profile), profile);
      assert.equal(source.loop, true, profile);
      assert.equal(source.loopStart, LOOP_PAD, profile);
      assert.equal(source.loopEnd, LOOP_PAD + SOUND_PROFILES[profile].duration, profile);
      assert(source.offset >= source.loopStart && source.offset < source.loopEnd, profile);
    }
  }
  const allocations = ctx.buffers.length, nodes = ctx.nodes.length, sources = [...byProfile.values(), wheeled].flat();
  sound.receive(frame(1.2, { actors, modules: modules(11) }), burns(1.2));
  assert.equal(ctx.buffers.length, allocations);
  assert.equal(ctx.nodes.length, nodes, 'updates reuse the existing loop sources');
  assert(sources.every(source => source.starts.length === 1 && source.stops.length === 0));
});

test('the recordings are read before playback, and one that cannot be read leaves only its own sound silent', async () => {
  const ctx = fakeAudioContext(), sounds = everySound(),
    bank = new SoundBufferBank(ctx, { ...sounds, load: async url => { if (url === 'fire.mp3') throw new Error('offline'); return url; } });
  assert.equal(bank.ready, false); await bank.prepare(); assert.equal(bank.ready, true);
  assert.equal(bank.buffers.size, sounds.files.size - 1);
  assert.equal(bank.get('fire'), undefined); assert.equal(bank.get('diesel').url, 'diesel.mp3');
  const sound = new SoundSystem({ contextFactory: () => fakeAudioContext(), storage: { getItem: () => '{}', setItem() {} } });
  await sound.unlock(); sound.setActive(true);
  sound.play({ x: 12, y: 1 }, soundCue({ type: 'muzzle', caliberMm: 25 }));
  sound.receive(frame(1, { actors: [{ id: 'tank', vehicle: { engine: true, x: 12, y: 1 } }] }), [burn()]);
  assert.equal(sound.voices.length + sound.engines.size + sound.fires.size, 0, 'a game without recordings is silent, not broken');
});

test('a round from elsewhere is heard once as it passes the middle of the view; one leaving the gun there is not', async () => {
  const { sound } = await setup(), view = { x: 0, y: 1, zoom: 20, width: 800, height: 500 },
    round = (number, x, y, age, more = {}) => ({ number, x, y, age, weapon: 'machinegun', ...more }),
    look = (time, shots) => sound.receive(frame(time), [], { listener: view, shots }),
    flybys = () => sound.voices.filter(v => v.sources[0].buffer === sound.bank.get('flyby-bullet') || v.sources[0].buffer === sound.bank.get('flyby-shell'));
  // A bullet crossing from the left, 3 m over the middle: heard once, as it goes away again.
  for (let i = 0; i <= 6; i++) look(1 + i * .05, [round(7, -15 + i * 6, 4, 1 + i * .05)]);
  assert.equal(flybys().length, 1);
  look(1.4, [round(7, 30, 4, 1.4)]); assert.equal(flybys().length, 1, 'once');
  // One that leaves a gun at the middle is nearest as it leaves: the shot is heard, not its passing.
  for (let i = 0; i <= 4; i++) look(2 + i * .05, [round(8, i * 5, 1.5, i * .05)]);
  // One passing far from the middle, a fragment and one that stops before passing are not heard either.
  for (let i = 0; i <= 4; i++) look(3 + i * .05, [round(9, -20 + i * 10, 15, 2), round(10, -20 + i * 10, 2, 2, { fragment: true })]);
  for (let i = 0; i <= 2; i++) look(4 + i * .05, i < 2 ? [round(11, -6 + i * 3, 1, 2)] : []);
  assert.equal(flybys().length, 1);
  // A shell passing is the shell's; a stream of bullets is heard so often and no more.
  for (let i = 0; i <= 4; i++) look(5 + i * .05, [round(12, -10 + i * 5, 3, 3, { weapon: 'howitzer' })]);
  assert.equal(sound.voices.filter(v => v.sources[0].buffer === sound.bank.get('flyby-shell')).length, 1);
  const before = flybys().length;
  for (let i = 0; i <= 4; i++) look(6 + i * .01, Array.from({ length: 10 }, (_, k) => round(100 + k, -10 + i * 5, 3, 3)));
  assert(flybys().length - before <= 1);
  assert(sound.flybys.size <= 12); sound.stop(); assert.equal(sound.flybys.size, 0);
});

test('different bullets and shells reuse their one recording at a speed-sensitive rate and keep its complete tail', async () => {
  const { ctx, sound } = await setup(), allocations = ctx.buffers.length,
    listener = { x: 0, y: 0, zoom: 20, width: 800, height: 500 },
    seen = new Map([['flyby-bullet', []], ['flyby-shell', []]]);
  let index = 0;
  for (const weapon of ['machinegun', 'autocannon', 'cannon', 'howitzer', 'mortar', 'grenade', 'rocket']) {
    const profile = ['machinegun', 'autocannon'].includes(weapon) ? 'flyby-bullet' : 'flyby-shell';
    for (let occurrence = 0; occurrence < 3; occurrence++, index++) {
      ctx.advance(index * 2);
      const before = ctx.nodes.length, xs = index % 2 ? [15, 3, -3, -15] : [-15, -3, 3, 15];
      for (const [step, x] of xs.entries()) sound.receive(frame(1 + index * 2 + step * .1), [], { listener,
        shots: [{ number: 100 + index * 17, weapon, x, y: 1 + index % 3, age: 1 + step * .1 }] });
      const sources = ctx.nodes.slice(before).filter(node => node.kind === 'buffer');
      assert.equal(sources.length, 1, `${weapon} passes once`);
      const [source] = sources;
      seen.get(profile).push(source.buffer);
      assert.equal(source.buffer, sound.bank.get(profile), weapon);
      assert(source.playbackRate.value >= .65 && source.playbackRate.value <= 1.45, weapon);
      assert(Math.abs((source.stops[0]-source.starts[0])*source.playbackRate.value-SOUND_PROFILES[profile].duration)<1e-10, weapon);
    }
  }
  for (const [profile, buffers] of seen) assert.equal(new Set(buffers).size, 1, profile);
  assert.equal(ctx.buffers.length, allocations, 'passing projectiles never decode another recording');
});

test('repeated interface cues keep each recording, original speed and complete duration', async () => {
  const { ctx, sound } = await setup(), allocations = ctx.buffers.length;
  sound.setActive(false);
  for (const [profile, definition] of Object.entries(SOUND_PROFILES).filter(([, p]) => !p.loop)) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const before = ctx.nodes.length;
      sound.cue(profile);
      const sources = ctx.nodes.slice(before).filter(node => node.kind === 'buffer');
      assert.equal(sources.length, 1, profile);
      const [source] = sources;
      assert.equal(source.buffer, sound.bank.get(profile), profile);
      assert.equal(source.playbackRate.value, 1, profile);
      assert.deepEqual(source.stops, [ctx.currentTime + definition.duration], profile);
    }
  }
  assert.equal(ctx.buffers.length, allocations);
});

test('ore pours while a hopper\'s load changes and a little after; a gun is heard turning while it turns', async () => {
  const { sound } = await setup(), hopper = (cargo, more = {}) => ({ id: 'hopper', actorId: 'truck', kind: 'hopper', x: 12, y: 1, cargo, ...more }),
    gun = speed => ({ id: 'gun', actorId: 'tank', kind: 'weapon', health: 100, x: 14, y: 2, servoVelocity: speed });
  sound.receive(frame(1, { modules: [hopper({ ferro: 10 }), gun(0)] }), []);
  assert.deepEqual([sound.pours.size, sound.servos.size], [0, 0], 'standing still and full, it is silent');
  sound.receive(frame(1.2, { modules: [hopper({ ferro: 12 }), gun(.5)] }), []);
  assert.deepEqual([sound.pours.size, sound.servos.size], [1, 1]);
  const pour = sound.pours.get('hopper'), servo = sound.servos.get('gun');
  assert.equal(pour.source.loopEnd, LOOP_PAD + SOUND_PROFILES.ore.duration); assert.equal(servo.source.loopEnd, LOOP_PAD + SOUND_PROFILES.servo.duration);
  // Emptying it pours too; a gun turning faster is louder and higher.
  sound.receive(frame(2, { modules: [hopper({ ferro: 4 }), gun(1)] }), []);
  assert.equal(sound.pours.get('hopper'), pour); assert(servo.gain.gain.calls.at(-1)[1] > servo.gain.gain.calls[0][1]);
  assert(servo.source.playbackRate.calls.at(-1)[1] > servo.source.playbackRate.calls[0][1]);
  // Once it no longer changes, the pouring stops after its arm would have; a gun that stopped is silent at once.
  sound.receive(frame(3, { modules: [hopper({ ferro: 4 }), gun(0)] }), []); assert.deepEqual([sound.pours.size, sound.servos.size], [1, 0]);
  sound.receive(frame(4, { modules: [hopper({ ferro: 4 }), gun(0)] }), []); assert.equal(sound.pours.size, 0);
  assert(pour.sources[0].stops.length && servo.sources[0].stops.length);
  // At most a few of each, the nearest.
  const guns = Array.from({ length: 9 }, (_, i) => ({ ...gun(.6), id: 'gun-' + i, x: 12 + i }));
  sound.receive(frame(5, { modules: guns }), []); assert.equal(sound.servos.size, MAX_SERVO_LOOPS);
  sound.stop(); assert.equal(sound.servos.size, 0);
});

test('a construction the base builds or mends is heard being worked on, from the middle of it, until it is done', async () => {
  const { sound } = await setup(), part = (actorId, x, id = actorId) => ({ id, actorId, kind: 'hull', x, y: 1 }),
    actor = (id, kind) => ({ id, field: kind ? { wreck: null, service: { kind, until: 20 } } : null }),
    look = time => sound.receive(frame(time, { actors: [actor('new', 'build'), actor('mended', 'repair'), actor('turning', 'turn'), actor('idle')],
      modules: [part('new', 10), part('new', 14, 'new-gun'), part('mended', 60), part('turning', 12), part('idle', 12)] }), []);
  look(1);
  assert.deepEqual([...sound.works.keys()].sort(), ['mended', 'new'], 'turning about is no work, and standing is none');
  const work = sound.works.get('new'), far = sound.works.get('mended');
  assert.equal(work.source.loopEnd, LOOP_PAD + SOUND_PROFILES.workshop.duration);
  assert(work.gain.gain.calls.at(-1)[1] > far.gain.gain.calls.at(-1)[1], 'the nearer, the louder');
  // Done, it is silent.
  look(20); assert.equal(sound.works.size, 0); assert(work.sources[0].stops.length);
});

test('the cranes of a construction at a structure on the field are heard from them, a moment past the last look that says so', async () => {
  const { sound } = await setup(), parts = [{ id: 'cab', actorId: 'truck', kind: 'hull', x: 60, y: 1 }, { id: 'crane', actorId: 'truck', kind: 'builder', x: 20, y: 1.5 }],
    look = (time, field, more = {}) => sound.receive(frame(time, { actors: [{ id: 'truck', field, ...more }], modules: parts }), []),
    pan = x => soundPosition({ x, y: 1.5 }, sound.ears, SOUND_PROFILES.workshop.reach).pan;
  look(1, { building: { at: 'site' } });
  const work = sound.works.get('truck');
  assert(work); assert.equal(work.pan.pan.value, pan(20)); assert.notEqual(pan(20), pan(40), 'from the crane, not the middle of the construction');
  look(2, null); assert.equal(sound.works.get('truck'), work, 'between two looks that say so it goes on');
  look(1 + LIFT_HOLD + .1, null); assert.equal(sound.works.size, 0); assert(work.sources[0].stops.length);
  look(5, { building: { at: 'site' } }, { ghost: { since: 4 } }); assert.equal(sound.works.size, 0, 'a ghost is not heard');
  look(6, { building: {} }); assert(sound.works.has('truck'), 'the cranes of another faction are heard too');
  look(4, null); assert.equal(sound.works.size, 0, 'a field shown again from before forgets them');
});

test('a chip burst uses its material recording whole; the workshop plays a clunk as a part goes in', async () => {
  assert.equal(soundCue({ type: 'debris', material: 'steel' }).profile, 'clunk');
  assert.equal(soundCue({ type: 'debris', material: 'concrete' }).profile, 'hard-hit');
  const { ctx, sound } = await setup(), plate = { id: 'piece', actorId: 'tank', material: 'steel', definition: { x: 12, y: 1, angle: 0, length: 1.2, thicknessMm: 10, widthM: 1 } };
  sound.receive(frame(1, { plates: [plate] }), [{ type: 'debris', id: 'piece', material: 'steel', vx: -1, vy: 1.2, count: 3, x: 12, y: 1, time: 1 }]);
  const landing = sound.voices.find(v => !v.resonanceId);
  assert(Math.abs(landing.endAt - landing.at - SOUND_PROFILES.clunk.duration / landing.sources[0].playbackRate.value) < 1e-9, 'whole');
  // In the workshop no world is shown: the part goes in all the same.
  sound.setActive(false); const before = ctx.nodes.filter(n => n.kind === 'buffer').length;
  sound.cue('clunk'); const placed = ctx.nodes.filter(n => n.kind === 'buffer').at(-1);
  assert.equal(ctx.nodes.filter(n => n.kind === 'buffer').length, before + 1);
  assert.equal(placed.buffer, sound.bank.get('clunk')); assert.equal(placed.connections[0].connections[0], ctx.destination);
  sound.setEnabled(false); sound.cue('clunk'); assert.equal(ctx.nodes.filter(n => n.kind === 'buffer').length, before + 1, 'silenced, silent');
});
