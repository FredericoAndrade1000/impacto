import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundSystem, soundCue, soundPosition, hearing, EAR_DEPTH, EAR_NEAREST, CREW_VIEW, HEARD_LEAST, MAX_PROFILE_VOICES, MAX_SOUND_VOICES,
  MERGE_REACH, SWELL_MOST, TOGETHER, FADE, FRAME_MOST, LAG_EASE, FLYBY_NEAR, FLYBY_VOLUME, MUZZLE_REACH, MUZZLE_GROWTH, MUZZLE_STEP, MUZZLE_LOUDEST, muzzleVolume,
  ECHO_SPREAD, ECHO_LENGTH, echoResponse } from '../src/audio.ts';
import { SOUND_PROFILES } from '../src/sound-art.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';

// A view of a wide screen, `across` metres wide, about a place of the field.
const camera = (across, x = 0, y = 0) => ({ x, y, zoom: 1600 / across, width: 1600, height: 900 });
const reachOf = cue => cue.reach || SOUND_PROFILES[cue.profile].reach;
async function setup() {
  const ctx = fakeAudioContext({ hold: true }), sound = new SoundSystem({ contextFactory: () => ctx, storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() });
  await sound.unlock(); sound.setActive(true); return { ctx, sound };
}
const frame = (time, changes = {}) => ({ time, actors: [], modules: [], plates: [], attachments: [], ...changes });
const buffers = (ctx, profile) => ctx.nodes.filter(n => n.kind === 'buffer' && (!profile || n.buffer?.url === profile + '.mp3'));

test('the ears stand in the middle of the view, out of the screen by a quarter of what it shows, or with the crew of the vehicle in hand', () => {
  assert.deepEqual(hearing(camera(60, 100, 5)), { x: 100, y: 5, depth: 60 * EAR_DEPTH, aboard: false });
  assert.equal(hearing(camera(1000)).depth, 250, 'a wide view hears all it shows from further off');
  assert.equal(hearing(camera(8)).depth, EAR_NEAREST, 'and a narrow one from no nearer than a few metres');
  assert.equal(hearing({ x: 3, y: 1 }).depth, EAR_NEAREST);
  // With the crew: at the vehicle, a few metres out while the view shows a vehicle and what is about it, and out as it opens wider.
  const crew = { x: 20, y: 1 };
  assert.deepEqual(hearing(camera(60), crew), { x: 20, y: 1, depth: EAR_NEAREST, aboard: true });
  assert.equal(hearing(camera(1000), crew).depth, (1000 - CREW_VIEW) * EAR_DEPTH);
  // A view taken away from the vehicle hears from its own middle.
  assert.deepEqual(hearing(camera(60, 500), crew), hearing(camera(60, 500)));
});

test('a sound fades with its distance from the ears, the louder reaching further, and a wide view hears it all from further off', () => {
  const at = (ears, x, reach, y = 0) => soundPosition({ x, y }, ears, reach), still = { x: 0, y: 0, depth: 0 };
  // At half its loudness `reach` metres off, as the inverse of the distance further, and dying out over eight times that.
  assert.equal(at(still, 0, 60).volume, 1);
  assert(Math.abs(at(still, 60, 60).volume - .5 * Math.exp(-1 / 8)) < 1e-12);
  assert(Math.abs(at(still, 0, 60, -60).volume - at(still, 60, 60).volume) < 1e-12, 'below or beside is all one');
  assert(Math.abs(at({ ...still, depth: 60 }, 0, 60).volume - at(still, 60, 60).volume) < 1e-12, 'out of the screen too');
  assert.equal(at(still, 5000, 60).volume, 0, 'too faint is nothing');
  // A 12.7 mm round on a plate, heard from the crew of the gun: faint some hundred metres off, gone at 800.
  const near = hearing(camera(60), { x: 0, y: 0 }), far = hearing(camera(1000), { x: 0, y: 0 }),
    heard = (cue, x, ears = near) => cue.volume * at(ears, x, reachOf(cue)).volume, hit = soundCue({ type: 'blocked', material: 'steel', power: 30 });
  assert(heard(hit, 10) > heard(hit, 100) && heard(hit, 100) > heard(hit, 300) && heard(hit, 300) > heard(hit, 800));
  assert(heard(hit, 300) < heard(hit, 10) / 5); assert(heard(hit, 800) < HEARD_LEAST);
  // A wide view stands the ears back from everything, near or far.
  assert(heard(hit, 10, far) < heard(hit, 10) / 4);
  // A big gun is heard kilometres off; the bigger, the further.
  const gun = caliberMm => soundCue({ type: 'muzzle', weapon: 'cannon', caliberMm });
  assert.equal(gun(155).reach, MUZZLE_REACH * 155 ** MUZZLE_GROWTH);
  assert(heard(gun(155), 3000) > .1 && heard(gun(155), 3000) > heard(gun(120), 3000));
  assert(soundCue({ type: 'muzzle', caliberMm: 7.62 }).reach < soundCue({ type: 'muzzle', caliberMm: 12.7 }).reach);
});

test('the air takes the highs first; a sound comes from its side, at once', () => {
  const still = { x: 0, y: 0, depth: 0 }, at = x => soundPosition({ x, y: 0 }, still, 60);
  assert.equal(at(1).cutoff, 16000);
  assert(Math.abs(at(100).cutoff - 50000 / Math.sqrt(110)) < 1e-9); assert(Math.abs(at(1000).cutoff - 50000 / Math.sqrt(2000)) < 1e-9);
  assert(at(3000).cutoff < 500, 'artillery far off is a dull thud');
  const view = hearing(camera(60));
  assert.equal(soundPosition({ x: 0 }, view).pan, 0);
  assert(soundPosition({ x: -30 }, view).pan < -.7 && soundPosition({ x: 5 }, view).pan > .2 && soundPosition({ x: 5 }, view).pan < .4);
  assert(Math.abs(soundPosition({ x: 5000 }, view).pan - .85) < 1e-3);
  assert.deepEqual(Object.keys(soundPosition({ x: 5000 }, view)).sort(), ['cutoff', 'echo', 'pan', 'volume'], 'and nothing of when');
});

test('driving, the crew hears the own shot whole, and its round strike a target at once, faint and dull', async () => {
  const { ctx, sound } = await setup(), state = frame(1, { actors: [{ id: 'm2', vehicle: { x: 0, y: 0 } }] }),
    shot = { type: 'muzzle', weapon: 'machinegun', caliberMm: 12.7, x: 1.2, y: 2.4, time: 1, id: 'gun' }, strike = { type: 'blocked', material: 'steel', power: 125, x: 250, y: 1, time: 1, id: 'truck' };
  sound.receive(state, [shot, strike], { listener: camera(60, 10), hands: 'm2' });
  assert.deepEqual(sound.ears, hearing(camera(60, 10), { x: 0, y: 0 }));
  const own = sound.voices.find(v => v.profile === 'gun-heavy'), far = sound.voices.find(v => v.profile === 'metal-hit');
  assert.deepEqual([own.at, far.at], [0, 0], 'no wait for the sound to come across the field');
  assert.equal(own.chain.filter.frequency.value, soundCue(shot).filter);
  assert(own.level > .9 * soundCue(shot).volume * SOUND_PROFILES['gun-heavy'].level);
  assert(far.chain.filter.frequency.value < 3000); assert(far.level < own.level / 20);
  assert(far.chain.pan.pan.value > .8 && Math.abs(own.chain.pan.pan.value) < .2);
  // Commanding the same view, the ears are in its middle.
  ctx.advance(.5); sound.receive(frame(1.5), [{ ...shot, time: 1.5 }], { listener: camera(60, 10) });
  assert.equal(sound.ears.aboard, false); assert(sound.voices.at(-1).chain.pan.pan.value < -.4);
});

test('a gun is louder by a step for every doubling of its calibre, and a recording of each kind sets it on that line', () => {
  const decibels = (a, b) => 20 * Math.log10(muzzleVolume(b) / muzzleVolume(a));
  assert.equal(muzzleVolume(155), MUZZLE_LOUDEST);
  for (const caliber of [5.56, 7.62, 12.7, 25, 60]) assert(Math.abs(decibels(caliber, caliber * 2) - MUZZLE_STEP) < 1e-9);
  // The same rule from the smallest to the biggest: louder, and on further.
  const cue = caliberMm => soundCue({ type: 'muzzle', caliberMm }), played = caliberMm => cue(caliberMm).volume * SOUND_PROFILES[cue(caliberMm).profile].level;
  for (const [small, big] of [[5.56, 7.62], [20, 25], [25, 30], [30, 35], [60, 105], [105, 120], [120, 155]]) {
    assert(cue(small).volume < cue(big).volume && cue(small).reach < cue(big).reach, `${small} < ${big}`);
    if (cue(small).profile === cue(big).profile) assert(played(small) < played(big));
  }
  // The level of each recording sets it on the line where its profile meets the next: a 25 needs less gain than the
  // M2, for its recording is louder already.
  assert(SOUND_PROFILES['gun-auto'].level < SOUND_PROFILES['gun-heavy'].level);
});

test('a shot and a blast echo over the field, the bigger the more, and the further off the more of what is heard', async () => {
  const { ctx, sound } = await setup(), convolver = ctx.nodes.find(n => n.kind === 'convolver');
  // One echo for the field, made once, heard through the same compressor and limiter as the sounds.
  assert.equal(sound.echo, convolver); assert.equal(convolver.normalize, false); assert.deepEqual(convolver.connections, [sound.master]);
  assert.equal(convolver.buffer.numberOfChannels, 2); assert.equal(convolver.buffer.length, Math.round(ECHO_LENGTH * ctx.sampleRate));
  const send = (event, x = 12) => {
    ctx.advance(ctx.currentTime + 4); sound.play({ x, y: 1.5, ...event }, soundCue(event));
    const voice = sound.voices.at(-1); return voice && voice.chain.echo.gain.value;
  };
  // Of a shot near, the echo is as big a share as the gun, all of it for a 155; a round on a plate or the ground sends none.
  const big = send({ type: 'muzzle', caliberMm: 155 }), small = send({ type: 'muzzle', caliberMm: 12.7 }),
    place = soundPosition({ x: 12, y: 1.5 }, sound.ears, soundCue({ type: 'muzzle', caliberMm: 155 }).reach);
  assert(Math.abs(big - place.echo / place.volume) < 1e-12);
  assert(big > .99 && big < 1.1); assert(Math.abs(small / big - Math.sqrt(12.7 / 155)) < .02);
  assert(send({ type: 'explosion', power: 700 }) > send({ type: 'explosion', power: 50 }) * 3);
  for (const event of [{ type: 'ricochet', power: 300 }, { type: 'blocked', material: 'steel', power: 300 }, { type: 'ground', surface: 'soil', power: 300 }]) assert.equal(send(event), 0, event.type);
  // Further off, more of it against the shot itself.
  const reach = soundCue({ type: 'muzzle', caliberMm: 155 }).reach, far = send({ type: 'muzzle', caliberMm: 155 }, 12 + 4 * reach);
  assert(far > 2.5 * big);
  assert(Math.abs(soundPosition({ x: 4 * reach }, { x: 0, y: 0, depth: 0 }, reach).echo - (ECHO_SPREAD / (ECHO_SPREAD + 4)) * Math.exp(-4 / (8 * ECHO_SPREAD))) < 1e-12);
  // Every voice sends it from its own chain, after the air: still a node a sound.
  assert(sound.chains.every(chain => chain.gain.connections.includes(chain.echo) && chain.echo.connections[0] === convolver));
});

test('autocannons send more into the same distance-aware field echo without changing dry mix or allocating another reverb', async () => {
  const { ctx, sound } = await setup(), cue = soundCue({ type: 'muzzle', weapon: 'autocannon', caliberMm: 25 });
  for (const caliberMm of [20, 25, 35, 50]) {
    const current = soundCue({ type: 'muzzle', weapon: 'autocannon', caliberMm });
    assert.equal(current.volume, muzzleVolume(caliberMm));
    assert(current.echo > Math.sqrt(caliberMm / 155)); assert(current.echo <= 1);
  }
  for (const caliberMm of [12.7, 120, 155])
    assert.equal(soundCue({ type: 'muzzle', caliberMm }).echo, Math.min(1, Math.sqrt(caliberMm / 155)));
  const send = x => {
    ctx.advance(ctx.currentTime + 4);
    sound.play({ type: 'muzzle', componentId: 'mk25', x, y: 1.5 }, cue);
    return sound.voices.at(-1).chain.echo.gain.value;
  }, near = send(12), far = send(12 + cue.reach * 4);
  assert(far > near * 2.5);
  assert.equal(ctx.nodes.filter(node => node.kind === 'convolver').length, 1);
  assert.equal(buffers(ctx, 'gun-auto').length, 2);
  assert(sound.voices.filter(voice => voice.endAt > ctx.currentTime + FADE).length <= MAX_PROFILE_VOICES);
  sound.stop();
});

test('the echo of the field: silent a moment, a few slaps from either side, then a low rumble that rolls away', () => {
  const rate = 48000, [left, right] = echoResponse(rate), energy = (side, from, to) => side.slice(Math.round(from * rate), Math.round(to * rate)).reduce((sum, v) => sum + v * v, 0),
    both = (from, to) => energy(left, from, to) + energy(right, from, to),
    // How often it crosses zero over a stretch: the higher it rings, the oftener.
    crossings = (side, from, to) => { let n = 0; for (let i = Math.round(from * rate) + 1; i < Math.round(to * rate); i++) if (side[i - 1] < 0 !== side[i] < 0) n++; return n / (to - from); };
  assert.equal(left.length, ECHO_LENGTH * rate); assert.deepEqual(echoResponse(rate), [left, right], 'always the same field');
  assert.equal(both(0, .1), 0, 'nothing before the nearest hill can answer');
  // The first slap comes from the left, the second from the right.
  assert(energy(left, .23, .26) > 4 * energy(right, .23, .26)); assert(energy(right, .51, .55) > 4 * energy(left, .51, .55));
  // In all a quarter as loud as the sound sent in (-12 dB), most of it in its first second.
  assert(Math.abs(10 * Math.log10(both(0, ECHO_LENGTH)) + 12.3) < 1); assert(both(0, 1) > 4 * both(1, ECHO_LENGTH));
  assert(both(ECHO_LENGTH - .5, ECHO_LENGTH) < both(.3, .8) * 1e-3, 'faded out well before its end');
  // The later, the duller.
  for (const side of [left, right]) assert(crossings(side, .15, .6) > 1.6 * crossings(side, 1.5, 2.5));
});

test('many of one sound do not pile up: merged where they start together, sharing the loudness of one, and a few at most', async () => {
  const { ctx, sound } = await setup(), hit = (x, more = {}) => ({ type: 'blocked', material: 'steel', power: 300, x, y: 1.5, ...more }), cue = soundCue(hit(12)),
    alone = x => cue.volume * soundPosition(hit(x), sound.ears, reachOf(cue)).volume * SOUND_PROFILES['metal-hit'].level;
  // Ten at once on one plate: one voice, one source, a little louder than one.
  for (let i = 0; i < 10; i++) sound.play(hit(12 + i * MERGE_REACH / 20), cue);
  assert.equal(sound.voices.length, 1); assert.equal(buffers(ctx).length, 1);
  assert(sound.voices[0].level > alone(12) && sound.voices[0].level <= alone(12) * SWELL_MOST + 1e-12);
  // Three at once on plates apart from each other: each at 1/√(1 + the others).
  for (const [i, x] of [24, 0].entries()) { sound.play(hit(x), cue); assert(Math.abs(sound.voices.at(-1).level - alone(x) / Math.sqrt(2 + i)) < 1e-12); }
  // Struck again and again, no more than a few sound together; the oldest gives way.
  ctx.advance(1); assert.equal(sound.voices.length, 0);
  const ground = { type: 'ground', surface: 'soil', power: 300, y: 0 };
  for (let i = 0; i < 12; i++) {
    ctx.advance(1 + i * TOGETHER * 3);
    sound.play({ ...ground, x: 12 + i }, soundCue(ground));
    assert(sound.voices.filter(v => v.profile === 'ground-hit' && v.endAt > ctx.currentTime + FADE).length <= MAX_PROFILE_VOICES);
  }
  const sources = buffers(ctx, 'ground-hit');
  assert.equal(sources.length, 12); assert(sources.slice(0, 8).every(s => s.stopAt < s.starts[0] + SOUND_PROFILES['ground-hit'].duration), 'cut short to give way');
  // Faded out as at its end, not cut.
  assert(sources.slice(0, 8).every(s => s.stopAt >= s.starts[0] + FADE));
  assert(sound.chains.every(chain => chain.gain.gain.calls.filter(c => c[0] === 'ramp').every(c => c[1] === .0001)));
  // Every sound makes its source and no more: the filter, gain and side of a voice are kept and used again.
  assert(ctx.nodes.filter(n => n.kind === 'filter').length <= MAX_SOUND_VOICES);
  assert(sound.chains.every(chain => chain.pan.connections[0] === sound.master));
});

test('a glancing round or one into the ground is no louder than one a plate stops; a hard landing as loud as its work', () => {
  for (const power of [10, 30, 155, 430, 2000]) {
    const stopped = soundCue({ type: 'blocked', material: 'steel', power }).volume;
    assert(soundCue({ type: 'ricochet', material: 'steel', power }).volume <= stopped);
    assert(soundCue({ type: 'ricochet', ground: true, surface: 'soil', power }).volume <= stopped);
    assert(soundCue({ type: 'ground', surface: 'soil', power }).volume <= stopped);
  }
  const landing = impactEnergy => soundCue({ type: 'ground', contactPair: 'terrain:1:2', impactEnergy }).volume;
  assert(landing(20) < landing(2000) && landing(2000) < landing(200000)); assert(landing(1e9) <= .14);
});

test('a round passing by is heard low, once at a time in a burst, and the further it passes the fainter', async () => {
  const { ctx, sound } = await setup(), view = camera(60), hands = 'm2', state = time => frame(time, { actors: [{ id: 'm2', vehicle: { x: 0, y: 0 } }] }),
    pass = (number, miss, start, weapon = 'machinegun') => { for (let k = 0; k <= 4; k++) sound.receive(state(start + k / 60), [], { listener: view, hands, shots: [{ number, weapon, x: -30 + 15 * k, y: miss, age: 1 + k / 60 }] }); },
    passing = profile => sound.voices.filter(v => v.profile === profile);
  pass(1, 2, 1);
  const [close] = passing('flyby-bullet'), ears = sound.ears, near = Math.max(FLYBY_NEAR, ears.depth);
  assert(Math.abs(close.level - FLYBY_VOLUME['flyby-bullet'] * Math.sqrt(1 - 2 / near) * soundPosition({ x: 0, y: 2 }, ears, SOUND_PROFILES['flyby-bullet'].reach).volume * SOUND_PROFILES['flyby-bullet'].level) < 1e-12);
  ctx.advance(2); pass(2, 10, 2); const [wide] = passing('flyby-bullet');
  assert(wide.level < close.level / 2.5);
  ctx.advance(3); pass(3, 5, 3, 'cannon'); assert.equal(passing('flyby-shell').length, 1);
  // A burst passing close: a pass heard so often at most, never piling up.
  ctx.advance(4); const before = buffers(ctx, 'flyby-bullet').length;
  for (let f = 0; f < 120; f++) {
    const t = 4 + f / 60; ctx.advance(t);
    const shots = Array.from({ length: 18 }, (_, k) => ({ number: 100 + k, weapon: 'machinegun', x: -300 + (t - 4 - k / 9) * 890, y: 2 + k % 3, age: 1 + t })).filter(s => s.x > -320 && s.x < 120);
    sound.receive(state(t), [], { listener: view, hands, shots });
    assert(passing('flyby-bullet').length <= 4);
  }
  assert(buffers(ctx, 'flyby-bullet').length - before <= 9);
});

// A gun firing `rate` rounds a minute for `seconds`, `x` metres off the ears, its shots told in frames: `frames` of
// the time each frame shows of the field, and of the time it is heard at (the clock of the audio); `told`, when the
// frame that told each shot came.
async function burst({ rate = 1000, seconds = 2, x = 12, frames }) {
  const { ctx, sound } = await setup(), turn = 60 / rate, shots = Array.from({ length: Math.floor(seconds / turn) + 1 }, (_, k) => 1 + k * turn), told = [];
  for (const [shown, heard] of frames) {
    ctx.advance(heard);
    const due = []; while (told.length + due.length < shots.length && shots[told.length + due.length] <= shown + 1e-9) due.push(shots[told.length + due.length]);
    told.push(...due.map(() => heard));
    sound.receive(frame(shown), due.map(time => ({ type: 'muzzle', weapon: 'autocannon', caliberMm: 20, componentId: 'rh202', x, y: 1.5, time })), { time: shown });
  }
  return { ctx, sound, shots, told, starts: buffers(ctx, 'gun-auto').map(s => s.starts[0]) };
}

test('a burst is heard shot by shot on its own beat, however the frames bring it, near or far off', async () => {
  // Steady frames of a sixtieth of a second, near and two kilometres off: every shot is heard, each a turn of the gun after the last.
  for (const x of [12, 2000]) {
    const steady = Array.from({ length: 200 }, (_, k) => [.9 + k / 60, k / 60]), { starts, shots, sound, ctx } = await burst({ x, frames: steady });
    assert.equal(starts.length, shots.length, `every shot of the burst ${x} m off`);
    for (let k = 1; k < starts.length; k++) assert(Math.abs(starts[k] - starts[k - 1] - .06) < 1e-6, `shot ${k}: ${starts[k] - starts[k - 1]}`);
    assert(starts.every((start, k) => start - (shots[k] - .9) <= 1 / 60 + 1e-9), 'a frame late at most');
    assert(sound.voices.filter(v => v.endAt > ctx.currentTime + FADE).length <= MAX_PROFILE_VOICES);
  }
  // The rounds of a field far away come a few to a frame, the frames unevenly: the shots of each are spread over it.
  const clock = { shown: .66, heard: 0 }, uneven = [[clock.shown, clock.heard]];
  for (let k = 0; k < 42; k++) { const step = [.14, .1, .05, .08][k % 4]; clock.shown += step; clock.heard += step; uneven.push([clock.shown, clock.heard]); }
  const { starts, shots } = await burst({ x: 900, frames: uneven });
  assert.equal(starts.length, shots.length, 'none of a batch merged into another');
  for (let k = 1; k < starts.length; k++) assert(Math.abs(starts[k] - starts[k - 1] - .06) < 1e-6, `shot ${k}: ${starts[k] - starts[k - 1]}`);
  // A frame that hangs is heard over no more than FRAME_MOST, and the beat comes back after it, in a few seconds.
  const hung = [[1, 0], [1.02, .02], [1.6, .6], ...Array.from({ length: 300 }, (_, k) => [1.6 + (k + 1) / 60, .6 + (k + 1) / 60])],
    after = await burst({ seconds: 5.5, frames: hung });
  assert.equal(after.starts.length, after.shots.length);
  assert(after.starts.every((start, k) => k === 0 || start >= after.starts[k - 1]), 'in their order');
  const late = after.starts.map((start, k) => start - after.told[k]), turns = after.starts.slice(1).map((start, k) => start - after.starts[k]);
  assert(late.every(wait => wait >= 0) && Math.max(...late) <= FRAME_MOST + 1e-9 && late.at(-1) < .02, 'as late as the hung frame at most, and back to a frame late after it');
  assert(turns.slice(11).every(turn => turn > .06 * (1 - 2 * LAG_EASE) && turn < .06 + 1e-6), 'the beat no more than a little quicker while it eases back');
});

test('of shots starting together two guns are heard in one, and never two shots of one gun', async () => {
  const { ctx, sound } = await setup(), shot = (componentId, x = 12) => ({ type: 'muzzle', caliberMm: 120, componentId, x, y: 1.5 });
  sound.play(shot('a'), soundCue(shot('a'))); sound.play(shot('b', 13), soundCue(shot('b', 13)));
  assert.equal(sound.voices.length, 1, 'a pair of tanks firing together');
  sound.play(shot('a'), soundCue(shot('a')));
  assert.equal(sound.voices.length, 2, 'the same gun again is its own shot');
  assert.equal(buffers(ctx, 'gun-cannon').length, 2);
});
