import test from 'node:test';
import assert from 'node:assert/strict';
import { Gearbox, GEARS, gearFor, engineTurning, upshift, downshift, ENGINE_IDLE, ENGINE_STALL, BRAKING_DOWN, CLIMB_LIFT, SHIFT_TIME, SHIFT_DIP, SHIFT_HOLD, REVERSE_SHARE } from '../src/gearbox.ts';
import { SoundSystem, soundCue, soundPosition, engineVoice, ENGINE_POWER, ENGINE_MOST, ENGINE_STEP, ENGINE_DEEPEN, MAX_ENGINE_LOOPS, MAX_PROFILE_VOICES, MAX_SOUND_VOICES, FADE } from '../src/audio.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';
import { SOUND_PROFILES, LOOP_PAD } from '../src/sound-art.ts';

const FRAME = 1 / 60, TOP = 20, steps = gears => gears.slice(1).map((ratio, i) => gears[i] / ratio);
// A box driven over `seconds` at 60 frames a second from `from` seconds on, the vehicle going as `going` says at each
// time: what it heard at every frame.
function drive(box, seconds, going, from = 0) {
  const heard = [];
  for (let time = from; time < from + seconds - 1e-9; time += FRAME) heard.push({ time, ...going(time), ...box.update(going(time), time) });
  return heard;
}
const shifts = heard => heard.filter((h, i) => i > 0 && h.gear !== heard[i - 1].gear);

async function setup() {
  const ctx = fakeAudioContext(), sound = new SoundSystem({ contextFactory: () => ctx, storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() });
  await sound.unlock(); sound.setActive(true); return { ctx, sound };
}
const frame = (time, actors, modules = []) => ({ time, actors, modules, plates: [], attachments: [] });
// A vehicle by the ears (they stand at x 12, a few metres out of the screen), facing right: on wheels, or on a track
// when the frame has a `track` of it.
const vehicle = (id, changes = {}, x = 12) => ({ id, facing: 1, vehicle: { engine: true, x, y: 1.5, vx: 0, throttle: 0, traction: 1, powerKw: 300, maxSpeed: TOP, ...changes } });
const track = id => ({ id: `${id}-track`, actorId: id, kind: 'track', health: 100 });
const target = parameter => parameter.soundTarget;

test('requesting the opposite direction sounds like braking until the physical drive engages reverse', async () => {
  for (const facing of [-1, 1]) for (const tracked of [false, true]) {
    const manual = await setup(), opposite = await setup(), modules = tracked ? [track('truck')] : [],
      actor = changes => ({ ...vehicle('truck', changes), facing }),
      hear = (system, time, changes) => {
        system.receive(frame(time, [actor(changes)], modules), []);
        const engine = system.engines.get('truck');
        return { pitch: target(engine.motor.playbackRate), level: target(engine.gain.gain) };
      };
    for (const { sound } of [manual, opposite]) hear(sound, 0, { vx: facing * 8, throttle: facing, driveSpeed: facing * 16 });
    let stopped;
    for (let step = 1; step <= 90; step++) {
      const time = step / 60, vx = facing * Math.max(0, 8 - time * 8),
        expected = hear(manual.sound, time, { vx, throttle: 0, brake: 1, driveSpeed: 0 }),
        actual = hear(opposite.sound, time, { vx, throttle: -facing, brake: 0, driveSpeed: 0 });
      assert.deepEqual(actual, expected, 'the effective braking target must not rev the engine or select reverse early');
      stopped = actual;
    }
    const reverse = { vx: -facing * 6, throttle: -facing, driveSpeed: -facing * 8 };
    hear(opposite.sound, 3, reverse);
    const reversing = hear(opposite.sound, 4, reverse);
    assert(reversing.pitch > stopped.pitch && reversing.level > stopped.level, 'the engine pulls normally once the physical drive engages reverse');
    manual.sound.stop(); opposite.sound.stop();
  }
});

test('the gear goes by the speed: four under a track and six on wheels, the top one at the rated speed at the top speed', () => {
  assert.equal(GEARS.track.length, 4); assert.equal(GEARS.wheel.length, 6);
  for (const gears of Object.values(GEARS)) {
    assert.equal(gears.at(-1), 1);
    const step = steps(gears);
    assert(step.every((s, i) => s > 1 && (i === 0 || s <= step[i - 1])), 'each step a little shorter than the one below it');
    for (const pull of [0, .5, 1]) for (const [gear, ratio] of gears.entries()) {
      const up = upshift(pull) * TOP / ratio;
      assert.equal(gearFor(gears, up * .99, TOP, pull), gear);
      assert.equal(gearFor(gears, up * 1.01, TOP, pull), Math.min(gear + 1, gears.length - 1));
    }
    assert.equal(engineTurning(gears, gears.length - 1, TOP, TOP), 1);
  }
  // A box starts in the gear its speed calls for, a wheeled vehicle in a higher one than a tracked at the same speed.
  for (const [tracked, gears] of [[true, GEARS.track], [false, GEARS.wheel]]) {
    const { gear } = new Gearbox(tracked).update({ speed: 12, top: TOP, pull: 1 }, 0);
    assert.equal(gear, gearFor(gears, 12, TOP, 1));
  }
  assert(new Gearbox(false).update({ speed: 12, top: TOP, pull: 1 }, 0).gear > new Gearbox(true).update({ speed: 12, top: TOP, pull: 1 }, 0).gear);
  // Pulling away flat out, a box goes through every gear in turn, each near the rated speed, and none back.
  for (const tracked of [true, false]) {
    const box = new Gearbox(tracked), heard = drive(box, 30, time => ({ speed: TOP * time / 30, top: TOP, pull: 1 })), up = shifts(heard);
    assert.deepEqual(up.map(h => h.gear), box.gears.slice(1).map((_, i) => i + 1));
    for (const h of up) assert(Math.abs(engineTurning(box.gears, h.gear - 1, h.speed, TOP) - upshift(1)) < .01);
  }
});

test('a shift lands between the lines, so the speed wavering about either does not call it back', () => {
  for (const gears of Object.values(GEARS)) for (const pull of [0, .25, .5, .75, 1]) for (const lift of [1, 1 + CLIMB_LIFT / 2, 1 + CLIMB_LIFT]) {
    const up = Math.min(1, upshift(pull) * lift), down = downshift(pull) * lift;
    for (const step of steps(gears)) {
      assert(up / step > down * 1.05, `up from ${up} lands above going down (${down})`);
      assert(down * step < up / 1.05, `down from ${down} lands below going up (${up})`);
    }
  }
  // About the line up from the first gear, and then about the line down from the second: one shift each.
  const box = new Gearbox(true), [low, second] = GEARS.track,
    upAt = upshift(1) * TOP / low, downAt = downshift(1) * TOP / second,
    waver = (at, from) => drive(box, 6, time => ({ speed: at * (1 + .03 * Math.sin(time * 9)), top: TOP, pull: 1 }), from);
  box.update({ speed: upAt * .9, top: TOP, pull: 1 }, 0);
  const above = [{ gear: box.gear }, ...waver(upAt, 1)], below = [{ gear: box.gear }, ...waver(downAt, 10)];
  assert.deepEqual(shifts(above).map(h => h.gear), [1]);
  assert.deepEqual(shifts(below).map(h => h.gear), [0]);
});

test('a shift drops the engine by the step of the gear over a quarter of a second, with a short dip and no jump', () => {
  const box = new Gearbox(true), heard = drive(box, 14, time => ({ speed: .5 * time, top: TOP, pull: 1 })), length = Math.round(SHIFT_TIME / FRAME),
    at = heard.findIndex((h, i) => i > 0 && h.gear !== heard[i - 1].gear), before = heard[at - 1], shift = heard.slice(at, at + length), settled = heard[at + length + 1];
  assert(before.turning > upshift(1) - .01);
  assert(Math.abs(settled.turning - engineTurning(GEARS.track, 1, settled.speed, TOP)) < 1e-9, 'in the new gear by the end of it');
  assert(Math.abs(settled.turning - before.turning / steps(GEARS.track)[0]) < .03, 'by the step of the gear');
  assert(Math.max(...heard.slice(1).map((h, i) => Math.abs(h.turning - heard[i].turning))) < .05, 'falling over it, not at once');
  assert.equal(before.dip, 0); assert.equal(settled.dip, 0);
  assert(Math.abs(Math.max(...shift.map(h => h.dip)) - SHIFT_DIP) < .01, 'the sound dips in the middle of it');
  // A shift that falls due right after another waits for SHIFT_HOLD.
  const quick = new Gearbox(true);
  quick.update({ speed: 5, top: TOP, pull: 1 }, 0); quick.update({ speed: 6, top: TOP, pull: 1 }, 1);
  assert.equal(quick.gear, 1);
  assert.equal(quick.update({ speed: 11, top: TOP, pull: 1 }, 1 + SHIFT_HOLD * .9).gear, 1);
  assert.equal(quick.update({ speed: 11, top: TOP, pull: 1 }, 1 + SHIFT_HOLD).gear, 2);
});

test('standing it idles; pressed on, standing or slipping, it runs up to its stall and no further; backing is one gear', async () => {
  const box = new Gearbox(false);
  assert.deepEqual(box.update({ speed: 0, top: TOP }, 0), { gear: 0, turning: ENGINE_IDLE, dip: 0 });
  assert.equal(box.update({ speed: 0, top: TOP, pull: 1 }, 1).turning, ENGINE_STALL);
  assert(ENGINE_STALL > ENGINE_IDLE && ENGINE_STALL < upshift(0));
  const back = drive(new Gearbox(true), 5, time => ({ speed: REVERSE_SHARE * TOP * time / 5, top: TOP, pull: 1, backing: true }));
  assert(back.every(h => h.gear === -1));
  assert(Math.abs(back.at(-1).turning - 1) < .01, 'at its rated speed as fast as a vehicle backs');
  // In the field: standing with the throttle down, its running gear slipping, and backing against the way it faces.
  const { sound } = await setup(), rate = id => target(sound.engines.get(id).motor.playbackRate);
  sound.receive(frame(1, [vehicle('idle'), vehicle('stuck', { throttle: 1, slip: 4 }), vehicle('back', { throttle: -1, vx: -3 })]), []);
  assert.equal(sound.engines.get('idle').gearbox.turning, ENGINE_IDLE);
  assert.equal(sound.engines.get('stuck').gearbox.turning, ENGINE_STALL);
  assert(rate('stuck') > rate('idle'));
  assert.equal(sound.engines.get('back').gearbox.gear, -1);
});

test('braking it only goes down, and climbing it goes down sooner', () => {
  const box = new Gearbox(true);
  box.update({ speed: 19, top: TOP, pull: 1 }, 0);
  assert.equal(box.gear, 3);
  const braked = drive(box, 5, time => ({ speed: Math.max(0, 19 - 5 * (time - 1)), top: TOP, braking: true }), 1);
  assert(braked.every((h, i) => i === 0 || h.gear <= braked[i - 1].gear));
  assert.equal(braked.at(-1).gear, 0); assert.equal(braked.at(-1).turning, ENGINE_IDLE);
  for (const h of shifts(braked).filter(h => h.gear > 0)) assert(engineTurning(GEARS.track, h.gear + 1, h.speed, TOP) <= BRAKING_DOWN + .01);
  // Losing speed up a slope, a box goes down at a greater speed than on the flat.
  const downAt = climb => {
    const box = new Gearbox(true); box.update({ speed: 12, top: TOP, pull: 1 }, 0);
    return shifts(drive(box, 6, time => ({ speed: 12 - 1.5 * (time - 1), top: TOP, pull: 1, climb }), 1))[0].speed;
  };
  assert(downAt(.15) > downAt(0) * 1.1);
});

test('an engine is heard by its power: louder by ENGINE_STEP dB a doubling, deeper, and further off', async () => {
  const doubled = engineVoice(2 * ENGINE_POWER), one = engineVoice(ENGINE_POWER);
  assert(Math.abs(20 * Math.log10(doubled.volume / one.volume) - ENGINE_STEP) < 1e-9);
  assert(Math.abs(12 * Math.log2(one.pitch / doubled.pitch) - ENGINE_DEEPEN) < 1e-9);
  for (const [kw, reach] of [[150, 80], [600, 150], [1100, 197]]) assert(Math.abs(engineVoice(kw).reach - reach) < 2, `${kw} kW reaches ${engineVoice(kw).reach} m`);
  assert.deepEqual(engineVoice(5000), engineVoice(ENGINE_MOST)); assert.deepEqual(engineVoice(undefined), one, 'a power not told is the usual one');
  // A light and a heavy at the same place pressed on alike: the heavy louder by the step for every doubling, and deeper.
  const { sound } = await setup(), light = vehicle('light', { powerKw: 150, throttle: 1, vx: 8 }), heavy = vehicle('heavy', { powerKw: 1100, throttle: 1, vx: 8 });
  sound.receive(frame(1, [light, heavy]), []);
  const [a, b] = ['light', 'heavy'].map(id => sound.engines.get(id)), place = kw => soundPosition(light.vehicle, sound.ears, engineVoice(kw).reach).volume;
  assert.equal(a.gearbox.turning, b.gearbox.turning);
  const louder = 20 * Math.log10(target(b.gain.gain) / target(a.gain.gain)) - 20 * Math.log10(place(1100) / place(150));
  assert(Math.abs(louder - ENGINE_STEP * Math.log2(1100 / 150)) < 1e-6, `${louder} dB`);
  assert(Math.abs(12 * Math.log2(target(a.motor.playbackRate) / target(b.motor.playbackRate)) - ENGINE_DEEPEN * Math.log2(1100 / 150)) < 1e-6);
  // A kilometre off a light engine is not heard any more and a heavy one is.
  sound.receive(frame(2, [vehicle('light', { powerKw: 150 }, 1012), vehicle('heavy', { powerKw: 1100 }, 1012)]), []);
  assert.deepEqual([...sound.engines.keys()], ['heavy']);
});

test('the engines heard are the loudest, and loops together are as loud as the loudest engine among them', async () => {
  const { sound } = await setup(),
    lights = Array.from({ length: 10 }, (_, i) => vehicle(`light-${i}`, { powerKw: 115 }, 62 + i)), heavy = vehicle('heavy', { powerKw: 1100 }, 162);
  sound.receive(frame(1, [...lights, heavy]), []);
  assert.equal(sound.engines.size, MAX_ENGINE_LOOPS); assert(sound.engines.has('heavy'), 'a heavy further off is louder than a light nearer');
  // One by the ears and five far off: about as loud as the one alone; four alike at one place: as loud as one of them.
  const ambience = () => target(sound.ambience.gain);
  sound.receive(frame(2, [vehicle('near', { powerKw: 600 }), ...Array.from({ length: 5 }, (_, i) => vehicle(`far-${i}`, { powerKw: 115 }, 412 + i))]), []);
  assert.equal(sound.engines.size, 6); assert(ambience() > .9, `${ambience()}`);
  sound.receive(frame(3, Array.from({ length: 4 }, (_, i) => vehicle(`alike-${i}`))), []);
  assert(Math.abs(ambience() - 1 / 2) < 1e-9);
});

test('the gearbox goes by the time the frames are heard at, and one not told the pedals or the top speed shifts by its speed', async () => {
  const { ctx, sound } = await setup(), [low] = GEARS.track, running = speed => [vehicle('tank', { throttle: 1, vx: speed })];
  sound.receive(frame(1, running(5), [track('tank')]), []);
  const engine = sound.engines.get('tank'); assert.equal(engine.gearbox.gear, 0);
  const due = upshift(1) * TOP / low + .1, was = engine.gearbox.turning;
  sound.receive(frame(2, running(due), [track('tank')]), []);
  assert.equal(engine.gearbox.gear, 1); assert.equal(engine.gearbox.turning, was, 'the shift begins where the engine was');
  sound.receive(frame(2 + SHIFT_TIME, running(due), [track('tank')]), []);
  assert.equal(ctx.currentTime, 0, 'the context clock did not move');
  assert(Math.abs(engine.gearbox.turning - engineTurning(GEARS.track, 1, due, TOP)) < 1e-9);
  // Of another faction a page is told neither the pedals nor the top speed (server/fog.ts): going fast it is in a high gear.
  const unseen = { id: 'unseen', facing: -1, vehicle: { engine: true, x: 12, y: 1.5, vx: -18, traction: 1 } };
  sound.receive(frame(3, [unseen]), []);
  const box = sound.engines.get('unseen').gearbox;
  assert.equal(box.gear, 4); assert(box.turning < 1);
});

const wheel = id => ({ id: `${id}-wheel`, actorId: id, kind: 'wheel', health: 100, attached: true });
const recordings = (ctx, profile) => ctx.nodes.filter(node => node.kind === 'buffer' && node.buffer?.url === `${profile}.mp3` && node.starts.length);

test('the engine of an aircraft is not heard in the air, where it turns nothing, and idles on its skids; its thrusters are heard', async t => {
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  // As the core tells one with an engine for its tools: no gear, no top speed of its own, its keys asking its flight
  // computer to go along flat out at 50 m/s and its drivetrain at nothing (game_motion.rs `drive`).
  const aircraft = changes => ({ id: 'flier', facing: -1, vehicle: { engine: true, x: 12, y: 1.5, powerKw: 92, maxSpeed: 0, traction: 0, gearCount: 0,
      throttle: 1, brake: 0, driveSpeed: 0, fuelRate: 2500, ...changes } }),
    jets = thrust => [0, 1].map(i => ({ id: `lift${i}`, actorId: 'flier', kind: 'thruster', health: 100, x: 12 + i, y: 2, thrust }));
  for (const [i, time] of [0, .1, .2, .3].entries()) {
    ctx.advance(time);
    sound.receive(frame(time, [aircraft({ flying: true, vx: -20 - 10 * i })], jets(.8)), []);
    assert(!sound.engines.has('flier'), 'no engine heard in the air, revving with how fast it flies');
  }
  assert.equal(recordings(ctx, 'diesel').length, 0);
  assert(sound.voices.some(voice => voice.profile === 'jet' && voice.endAt === Infinity), 'its thrusters are heard');
  assert(!sound.voices.some(voice => voice.profile === 'engine-turbo'), 'nor its turbo, by what its thrusters burn');
  // On its skids, its thrusters still, it idles as any vehicle standing.
  ctx.advance(1);
  sound.receive(frame(1, [aircraft({ flying: false, vx: 0, throttle: 0, brake: 1, fuelRate: 0 })], jets(0)), []);
  assert.equal(sound.engines.get('flier')?.gearbox.turning, ENGINE_IDLE);
});

test('metal brake loops last through held high-speed braking, including reverse and an engine switched off', async t => {
  for (const facing of [-1, 1]) for (const engine of [true, false]) for (const mode of ['pedal', 'reverse', 'released']) {
    const { ctx, sound } = await setup(); t.after(() => sound.stop());
    const hear = (time, changes = {}) => {
      ctx.advance(time);
      sound.receive(frame(time, [{ ...vehicle('truck', { engine, vx: facing * 22,
        throttle: facing, brake: 0, driveSpeed: facing * TOP, ...changes }), facing }], [wheel('truck')]), []);
    }, applied = mode === 'reverse' ? { throttle: -facing, driveSpeed: 0 }
      : mode === 'released' ? { throttle: 0, driveSpeed: 0 } : { brake: 1, driveSpeed: 0 };
    hear(0); hear(.02, applied);
    const first = recordings(ctx, 'brake-squeal')[0];
    assert(first, `${mode}, facing ${facing}, engine ${engine}`);
    assert.equal(first.loop, true); assert.equal(first.playbackRate.value, 1);
    assert.equal(first.loopStart, LOOP_PAD); assert.equal(first.loopEnd, LOOP_PAD + SOUND_PROFILES['brake-squeal'].duration);
    for (let step = 1; step <= 180; step++) hear(.02 + step / 60, applied);
    assert.equal(recordings(ctx, 'brake-squeal').length, 1, 'one source spans repeated rotations of the loop');
    assert.equal(first.stops.length, 0, 'a held brake does not end after the old 0.4s clip');
    assert.equal(recordings(ctx, 'brake-air').length, 0);
    hear(3.1); assert.equal(target(sound.voices.find(v => v.profile === 'brake-squeal').chain.gain.gain), 0);
    hear(4); assert(first.stops.some(at => at <= 4)); assert.equal(first.disconnects, 1);
  }
});

test('brake loops need moving grounded wheels and public effective drive telemetry', async t => {
  const cases = [
    ['stationary', { vx: 0 }, [wheel('truck')]], ['slow', { vx: .1 }, [wheel('truck')]],
    ['airborne', { traction: 0 }, [wheel('truck')]], ['track', {}, [track('truck')]],
    ['no gear', {}, []], ['broken wheel', {}, [{ ...wheel('truck'), health: 0 }]],
    ['detached wheel', {}, [{ ...wheel('truck'), attached: false }]],
    ['zero target without released or opposing input', { throttle: 1, brake: 0 }, [wheel('truck')]],
    ['released input without an effective stopping target', { brake: 0, driveSpeed: TOP }, [wheel('truck')]],
    ...['throttle', 'brake', 'driveSpeed'].map(key => [`private ${key}`, { [key]: undefined }, [wheel('truck')]]),
  ];
  for (const [name, changes, modules] of cases) {
    const { ctx, sound } = await setup(); t.after(() => sound.stop());
    sound.receive(frame(0, [vehicle('truck', { engine: false, vx: 20, throttle: 0, brake: 1, driveSpeed: 0, ...changes })], modules), []);
    assert.equal(recordings(ctx, 'brake-squeal').length, 0, name);
  }
  for (const key of ['throttle', 'brake', 'driveSpeed']) {
    const { ctx, sound } = await setup(); t.after(() => sound.stop());
    sound.receive(frame(0, [vehicle('truck', { vx: 20, throttle: .9, brake: 0, driveSpeed: TOP, fuelRate: 75, [key]: undefined })], [wheel('truck')]), []);
    assert.equal(recordings(ctx, 'engine-turbo').length, 0, `private ${key}`);
  }
});

test('brake squeal softens small real demands and lower speeds without restarting its held loop', async t => {
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  const hear = (time, brake, vx, changes = {}) => {
    ctx.advance(time);
    sound.receive(frame(time, [vehicle('truck', { engine: false, vx, throttle: 0, brake, driveSpeed: 0, ...changes })], [wheel('truck')]), []);
  };
  hear(0, 1, 12);
  const voice = sound.voices.find(value => value.profile === 'brake-squeal'), source = voice.sources[0],
    gain = () => target(voice.chain.gain.gain), full = gain(), allocated = ctx.nodes.length,
    gainSets = voice.chain.gain.gain.calls.filter(call => call[0] === 'set').length;
  hear(.05, .25, 12);
  const weak = gain();
  assert(weak > 0 && weak < full * .25, 'a light real brake gets a softer volume curve even at speed');
  hear(.1, .25, 12, { throttle: 1 });
  assert.equal(gain(), weak, 'the explicit partial brake wins over both released and held throttle');
  hear(.15, .25, 3);
  assert(gain() > 0 && Math.abs(gain() / weak - .25) < 1e-9, 'the same light brake gets quieter with speed');
  hear(.2, .1, 3);
  assert(gain() > 0, 'a relevant light low-speed brake is softened rather than discarded by a second profile-gain threshold');
  hear(.25, 1, 6);
  assert(Math.abs(gain() / full - .5) < 1e-9, 'medium-speed braking no longer saturates at the old 6 m/s');
  hear(.3, 1, 22); assert.equal(gain(), full, 'strong high-speed braking keeps its approved peak mix');
  hear(.35, 1, -6); assert(Math.abs(gain() / full - .5) < 1e-9, 'the speed envelope is the same in reverse');
  hear(.4, 0, 12, { throttle: 1, driveSpeed: TOP }); assert.equal(gain(), 0);
  hear(.45, .25, 3); assert(gain() > 0);
  assert.equal(recordings(ctx, 'brake-squeal').length, 1); assert.equal(voice.sources[0], source);
  assert.equal(ctx.nodes.length, allocated); assert.equal(source.stops.length, 0);
  assert.equal(voice.chain.gain.gain.calls.filter(call => call[0] === 'set').length, gainSets, 'changes keep the existing smoothed automation');
  assert.equal(source.playbackRate.value, 1);
  hear(.5, 1, 0); assert.equal(gain(), 0);
  hear(1.4, 1, 0); assert.equal(source.disconnects, 1);
});

test('turbo29 follows measured fuel flow continuously and reuses its source through short releases', async t => {
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  const hear = (time, fuelRate = 75, changes = {}) => {
    ctx.advance(time);
    sound.receive(frame(time, [vehicle('truck', { vx: 19.5, throttle: .9, brake: 0, driveSpeed: TOP, fuelRate, ...changes })], [wheel('truck')]), []);
  };
  hear(0);
  const first = recordings(ctx, 'engine-turbo')[0], turbo = () => sound.voices.find(v => v.profile === 'engine-turbo' && v.endAt === Infinity),
    full = target(turbo().chain.gain.gain), allocated = ctx.nodes.length;
  assert(first); assert(first.loop); assert.equal(first.playbackRate.value, 1);
  assert.equal(first.loopStart, LOOP_PAD); assert.equal(first.loopEnd, LOOP_PAD + SOUND_PROFILES['engine-turbo'].duration);
  assert(SOUND_PROFILES['engine-turbo'].level < .2);
  for (let step = 1; step <= 600; step++) hear(step / 30, 60 + 5 * Math.sin(step));
  assert.equal(ctx.nodes.length, allocated, 'steady operation makes no sources or chains per frame');
  assert.equal(recordings(ctx, 'engine-turbo').length, 1); assert.equal(first.stops.length, 0);
  hear(20.1, 30); assert(target(turbo().chain.gain.gain) < full);
  hear(20.2, 0, { throttle: 0, driveSpeed: 0 }); assert.equal(target(turbo().chain.gain.gain), 0);
  hear(20.3, 75); assert.equal(recordings(ctx, 'engine-turbo').length, 1, 'a short release keeps the same loop');
  hear(20.4, 75, { engine: false }); hear(21.3, 75, { engine: false });
  assert(first.stops.some(at => at <= 21.3)); assert.equal(first.disconnects, 1);
});

test('equal RPM and throttle can have different turbo effort, while throttle alone is not measured work', async t => {
  const low = await setup(), high = await setup();
  for (const sample of [low, high]) t.after(() => sample.sound.stop());
  const hear = (sample, time, fuelRate, throttle = .9) => {
    sample.ctx.advance(time);
    sample.sound.receive(frame(time, [vehicle('truck', { vx: 19.5, throttle, brake: 0, driveSpeed: TOP, fuelRate })]), []);
    return sample.sound.voices.find(voice => voice.profile === 'engine-turbo');
  }, gentle = hear(low, 0, 30), working = hear(high, 0, 90), gain = target(working.chain.gain.gain);
  assert.equal(low.sound.engines.get('truck').gearbox.turning, high.sound.engines.get('truck').gearbox.turning);
  assert(gain > target(gentle.chain.gain.gain) * 2.5, 'different delivered-work flow must matter at identical audio RPM');
  const source = working.sources[0];
  hear(high, .02, 90, .3);
  assert.equal(target(working.chain.gain.gain), gain, 'the same measured flow at the same RPM is not relabelled by the pedal command');
  assert.equal(working.sources[0], source); assert.equal(source.playbackRate.value, 1);
});

test('high RPM with little measured flow is quiet, downhill follows the actual flow and braking releases it', async t => {
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  const hear = (time, fuelRate, changes = {}) => {
    ctx.advance(time);
    sound.receive(frame(time, [vehicle('truck', { vx: 19.5, throttle: .9, brake: 0, driveSpeed: TOP, fuelRate, ...changes })]), []);
  };
  hear(0, 75);
  const engine = sound.engines.get('truck'), rpm = engine.gearbox.turning, loaded = engine.turboLevel,
    voice = sound.voices.find(value => value.profile === 'engine-turbo'), source = voice.sources[0];
  hear(.1, 3.6);
  assert.equal(engine.gearbox.turning, rpm); assert(engine.turboLevel < loaded / 5, 'only turning fuel at high RPM is much less than working flow');
  hear(.2, 75, { groundSlope: -.2 });
  assert(engine.turboLevel > loaded * .95, 'a downhill slope cannot erase power that Native says the engine is delivering');
  hear(.3, 0, { throttle: 0, driveSpeed: 0 }); assert.equal(target(voice.chain.gain.gain), 0);
  hear(.4, 75, { throttle: 0, driveSpeed: 0 }); assert.equal(target(voice.chain.gain.gain), 0, 'effective braking still wins over stale positive flow');
  assert.equal(recordings(ctx, 'engine-turbo').length, 1); assert.equal(voice.sources[0], source);
});

test('synthetic shifts modulate a flowing turbo without closing or restarting its loop', async t => {
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  const hear = time => {
    ctx.advance(time);
    sound.receive(frame(time, [vehicle('truck', { vx: 1 + time * 1.5, throttle: .9, brake: 0, driveSpeed: TOP, fuelRate: 75 })]), []);
  };
  hear(0);
  const voice = sound.voices.find(value => value.profile === 'engine-turbo'), source = voice.sources[0], allocated = ctx.nodes.length, shifts = new Set();
  for (let step = 1; step <= 720; step++) {
    hear(step / 60);
    const box = sound.engines.get('truck').gearbox;
    if (box.shift) shifts.add(box.shift.at);
    assert(target(voice.chain.gain.gain) > 0, 'a shift changes audio RPM without closing a sustained flow texture');
  }
  assert(shifts.size >= 3, 'the fixture actually crossed several audio gears');
  assert.equal(recordings(ctx, 'engine-turbo').length, 1); assert.equal(ctx.nodes.length, allocated);
  assert.equal(voice.sources[0], source); assert.equal(source.stops.length, 0); assert.equal(source.playbackRate.value, 1);
});

test('turbo never substitutes RPM or throttle for missing, invalid or out-of-scope fuel telemetry', async t => {
  for (const changes of [{ fuelRate: undefined }, { fuelRate: NaN }, { fuelRate: Infinity }, { fuelRate: -1 },
    { fuelRate: 0 }, { powerKw: undefined }, { powerKw: 0 }, { powerKw: Infinity }, { engine: false }]) {
    const { ctx, sound } = await setup(); t.after(() => sound.stop());
    sound.receive(frame(0, [vehicle('truck', { vx: 19.5, throttle: .9, brake: 0, driveSpeed: TOP, fuelRate: 75, ...changes })]), []);
    assert.equal(recordings(ctx, 'engine-turbo').length, 0, JSON.stringify(changes));
  }
});

test('shots and grave alerts preempt live drive loops; current braking and engine load readmit them within the same caps', async t => {
  const fleet = await setup(); t.after(() => fleet.sound.stop());
  const many = Array.from({ length: 44 }, (_, i) => `brake-${i}`);
  fleet.sound.receive(frame(0, many.map(id => vehicle(id, { engine: false, vx: 22, throttle: 0, brake: 1, driveSpeed: 0 })), many.map(wheel)), []);
  assert.equal(recordings(fleet.ctx, 'brake-squeal').length, MAX_PROFILE_VOICES);
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  const engines = Array.from({ length: 12 }, (_, i) => `motor-${i}`),
    hear = (time, brake = {}, present = engines) => {
      ctx.advance(time);
      sound.receive(frame(time, [vehicle('braking', { engine: false, vx: 22, throttle: 0, brake: 1, driveSpeed: 0, ...brake }),
        ...present.map(id => vehicle(id, { vx: 19.5, throttle: .9, brake: 0, driveSpeed: TOP, fuelRate: 75 }))], ['braking', ...present].map(wheel)), []);
    }, live = profile => ctx.nodes.filter(source => source.kind === 'buffer' && source.starts.length && !source.ended &&
      (!Number.isFinite(source.stopAt) || source.stopAt > ctx.currentTime) && source.buffer?.url === `${profile}.mp3`),
    caps = (fading = 0) => {
      assert(sound.voices.filter(voice => voice.endAt > ctx.currentTime).length <= MAX_SOUND_VOICES + fading);
      for (const profile of ['brake-squeal', 'engine-turbo']) assert(live(profile).length <= MAX_PROFILE_VOICES);
      assert(sound.engines.size <= MAX_ENGINE_LOOPS);
    }, play = (event, index) => sound.play({ ...event, componentId: `effect-${index}`, x: 12 + index * 6, y: 1.5 }, soundCue(event));
  hear(0);
  assert.equal(recordings(ctx, 'diesel').length, MAX_ENGINE_LOOPS);
  assert.equal(recordings(ctx, 'engine-turbo').length, MAX_PROFILE_VOICES);
  const brake = sound.voices.find(voice => voice.profile === 'brake-squeal'),
    firstTurbo = sound.voices.find(voice => voice.profile === 'engine-turbo'),
    gainSets = brake.chain.gain.gain.calls.filter(call => call[0] === 'set').length;
  ctx.advance(.02);
  const effects = [5.56, 12.7, 120].map(caliberMm => ({ type: 'muzzle', caliberMm }))
    .concat([{ type: 'explosion', power: 80 }, { type: 'explosion', power: 600 }]);
  for (let i = 0; i < MAX_SOUND_VOICES - 5; i++) play(effects[Math.floor(i / 4)], i);
  assert.equal(sound.voices.length, MAX_SOUND_VOICES);
  ctx.advance(.04); play({ type: 'muzzle', weapon: 'autocannon', caliberMm: 25 }, 99);
  assert.equal(brake.endAt, .04 + FADE, 'a real muzzle steals the lowest-priority drive slot');
  assert.equal(brake.chain.gain.gain.calls.filter(call => call[0] === 'set').length, gainSets, 'preemption never jumps a smoothed loop to full volume');
  const afterShot = ctx.nodes.length;
  hear(.04 + FADE / 2);
  assert.equal(ctx.nodes.length, afterShot, 'a source still fading cannot admit another drive loop');
  assert.equal(recordings(ctx, 'brake-squeal').length, 1); caps(1);
  hear(.04 + FADE + .001);
  assert(brake.sources[0].ended); assert.equal(brake.sources[0].disconnects, 1);
  assert.equal(recordings(ctx, 'brake-squeal').length, 1, 'the shot still occupies the slot'); caps();
  hear(.9);
  const returnedBrake = sound.voices.find(voice => voice.profile === 'brake-squeal');
  assert.equal(recordings(ctx, 'brake-squeal').length, 2);
  assert.equal(returnedBrake.sources[0].starts[0], .9, 'held braking re-enters from current state after ordinary effects end');
  ctx.advance(.91);
  // Refill at the nearby guns whose previous shots ended; far-away small rounds can be inaudible.
  for (let i = 0; i < 7; i++) assert(play({ type: 'muzzle', caliberMm: i < 4 ? 5.56 : 12.7 }, i), 'each nearby refill shot occupies a voice');
  assert.equal(sound.voices.length, MAX_SOUND_VOICES);
  ctx.advance(.92); sound.alert('grave');
  assert.equal(recordings(ctx, 'alert-grave').length, 1);
  assert.equal(firstTurbo.endAt, .92 + FADE, 'the actual grave alert preempts a running turbo');
  const afterAlert = ctx.nodes.length;
  hear(.92 + FADE / 2);
  assert.equal(ctx.nodes.length, afterAlert); assert.equal(recordings(ctx, 'engine-turbo').length, MAX_PROFILE_VOICES); caps(1);
  hear(.92 + FADE + .001);
  assert(firstTurbo.sources[0].ended); assert.equal(firstTurbo.sources[0].disconnects, 1); caps();
  hear(1.06);
  const returnedTurbo = sound.voices.find(voice => voice.profile === 'engine-turbo' && voice.follow.actor === firstTurbo.follow.actor);
  assert(returnedTurbo);
  assert.equal(recordings(ctx, 'engine-turbo').length, MAX_PROFILE_VOICES + 1);
  assert.equal(returnedTurbo.sources[0].starts[0], 1.06, 'unchanged current load is readmitted without another throttle edge'); caps();
  hear(1.1, { vx: 0 }); assert.equal(target(returnedBrake.chain.gain.gain), 0);
  hear(1.95, { vx: 0 }); assert.equal(returnedBrake.sources[0].disconnects, 1); assert.equal(live('brake-squeal').length, 0);
  hear(2);
  const groundedBrake = sound.voices.find(voice => voice.profile === 'brake-squeal');
  assert(groundedBrake); hear(2.1, { traction: 0 }); assert.equal(target(groundedBrake.chain.gain.gain), 0);
  hear(3, { traction: 0 }); assert.equal(groundedBrake.sources[0].disconnects, 1); assert.equal(live('brake-squeal').length, 0);
  hear(3.1, { vx: 0 }, []); assert.equal(sound.engines.size, 0);
  assert(recordings(ctx, 'diesel').every(source => source.stopAt <= 3.1));
  hear(4, { vx: 0 }, []);
  assert.equal(live('engine-turbo').length, 0);
  assert(recordings(ctx, 'engine-turbo').every(source => source.disconnects === 1)); caps();
});
test('drive loops follow the camera attenuation and fade when current telemetry disappears', async t => {
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  const hear = (time, x, changes = {}) => {
    ctx.advance(time);
    sound.receive(frame(time, [vehicle('truck', { engine: false, vx: 20, throttle: 0, brake: 1, driveSpeed: 0, ...changes }, x)], [wheel('truck')]), []);
  };
  hear(0, 12);
  const source = recordings(ctx, 'brake-squeal')[0], voice = sound.voices.find(v => v.profile === 'brake-squeal'),
    near = target(voice.chain.gain.gain), cutoff = voice.chain.filter.frequency.value;
  hear(.02, 112);
  assert(target(voice.chain.gain.gain) < near); assert(voice.chain.pan.pan.value > .8);
  assert(voice.chain.filter.frequency.value < cutoff);
  hear(.04, 112, { throttle: undefined }); assert.equal(target(voice.chain.gain.gain), 0);
  hear(.9, 112, { throttle: undefined }); assert(source.stops.some(at => at <= .9)); assert.equal(source.disconnects, 1);
});

test('hidden, muted and paused worlds close drive loops; a visible return fades in only the current state', async t => {
  const { ctx, sound } = await setup(); t.after(() => sound.stop());
  const hear = (time, held) => {
    ctx.advance(time);
    sound.receive(frame(time, [vehicle('truck', { vx: 20, throttle: held ? 0 : .9, fuelRate: held ? 0 : 75,
      brake: held ? 1 : 0, driveSpeed: held ? 0 : TOP })], [wheel('truck')]), []);
  };
  hear(0, false); sound.alert('contact');
  const turbo = recordings(ctx, 'engine-turbo')[0], alert = recordings(ctx, 'alert-contact')[0], alertStop = [...alert.stops];
  sound.setShown(false); const hiddenNodes = ctx.nodes.length;
  hear(.02, true); assert.equal(ctx.nodes.length, hiddenNodes); assert(turbo.stops.length);
  assert.deepEqual(alert.stops, alertStop); assert(sound.alertBus.gain.value > 0);
  sound.setShown(true); hear(.06, true);
  assert.deepEqual(recordings(ctx, 'brake-squeal').map(source => source.starts[0]), [.06]);
  assert.equal(recordings(ctx, 'brake-air').length, 0);
  sound.setEnabled(false); const mutedNodes = ctx.nodes.length;
  hear(.08, false); assert.equal(ctx.nodes.length, mutedNodes);
  sound.setEnabled(true); hear(.1, false); sound.setActive(false);
  assert(sound.voices.every(voice => !voice.loop));
});
