import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { FIXED_DT } from '../src/physics.ts';
import { pageWorld } from '../src/trial-targets.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { FramePresentation } from '../src/presentation.ts';
import { FrameWriter, FrameReader, tellEvent } from '../src/network-protocol.ts';
import { packShots } from '../src/shots.ts';
await initNativeDynamics();

// What a frame shows of an impact goes with the round that made it: the round is drawn on every frame of its flight
// up to the frame that shows what it struck, and in that frame where it struck, with the effects and the sounds
// of it (they are the frame's `events`). A delivery brings several steps of the world — the shared field tells it
// every 48 ms, a busy page takes the worker's frames late — and the path of a round tells only the steps it met
// something on.

const STEP = 1 / 60, SPEED = 600, END = 7 * STEP + .008;
// One round, number 7, born at the time 0 at x = 0 and flying level at SPEED: where it is at a time.
const at = time => SPEED * time;
const round = time => ({ number: 7, ammo: 'he', weapon: 'grenade', x: at(time), y: 2, vx: SPEED, vy: 0, age: time, radius: .02 });
const point = time => ({ time, x: at(time), y: 2, vx: SPEED, vy: 0 });
const flight = (from, to, terminal = false) => ({ type: 'flight', id: 'shot-7', n: 7, ammo: 'he', weapon: 'grenade', radius: .02, terminal,
  time: from, points: [point(from), point((from + to) / 2), point(to)] });
// Three steps a delivery: the round leaves the gun on the first step, meets something on the fourth and the sixth,
// and bursts on the eighth.
function deliveries(shared) {
  const state = (step, rounds) => ({ time: step * STEP, shared, actors: [], plates: [], modules: [], shots: packShots(rounds) });
  return [
    { state: state(0, []), events: [] },
    { state: state(3, [round(3 * STEP)]), events: [flight(0, STEP)] },
    { state: state(6, [round(6 * STEP)]), events: [flight(3 * STEP, 4 * STEP), flight(5 * STEP, 6 * STEP)] },
    { state: state(9, []), events: [flight(7 * STEP, END, true), { type: 'explosion', time: END, x: at(END), y: 2, power: 95, radius: 1.8 }] },
    { state: state(12, []), events: [] },
  ];
}
// The frames of a page at 60 Hz over the deliveries, each `arrival` ms after the time of its state.
function frames(list, arrival) {
  const playback = new FramePresentation(), shown = [], original = structuredClone(list.map(item => item.events));
  let next = 0;
  for (let now = 0; now < 400; now += 1000 / 60) {
    while (next < list.length && list[next].state.time * 1000 + arrival <= now) {
      playback.receive(list[next].state, list[next].events, { now: list[next].state.time * 1000 + arrival }); next++;
    }
    const sample = playback.sample(now); if (!sample) continue;
    const events = [], frame = playback.present(sample, { consume: event => events.push(event) });
    shown.push({ time: frame.time, rounds: frame.shots.filter(shot => shot.number === 7), events });
  }
  assert.deepEqual(list.map(item => item.events), original, 'the events are left as they came');
  return shown;
}
function aligned(shown) {
  const impact = shown.findIndex(frame => frame.events.some(event => event.type === 'explosion'));
  assert(impact > 0, 'the burst is shown');
  const frame = shown[impact];
  assert(frame.time >= END - 1e-9 && shown[impact - 1].time < END, 'the burst is shown on the first frame at or after its time');
  assert.equal(frame.rounds.length, 1, 'the frame of the burst shows the round');
  assert(Math.abs(frame.rounds[0].x - at(END)) < 1e-6, 'where it burst');
  let flying = 0;
  for (const earlier of shown.slice(0, impact)) {
    if (earlier.time <= 1e-9) continue;
    flying++;
    assert.equal(earlier.rounds.length, 1, `the round is drawn at ${earlier.time.toFixed(4)} s`);
    assert(Math.abs(earlier.rounds[0].x - at(earlier.time)) < 1e-6, `where it was at ${earlier.time.toFixed(4)} s`);
  }
  assert(flying >= 4, 'the flight is shown over several frames');
  for (const later of shown.slice(impact + 1)) assert.equal(later.rounds.length, 0, 'and it is gone after');
}

test('on the shared field a round is drawn up to where it bursts, in the frame of the burst', () => {
  for (const arrival of [20, 35, 60]) aligned(frames(deliveries(true), arrival));
});

test('a page that takes several steps of its own world at once shows the round all the way too', () => {
  aligned(frames(deliveries(false), 1));
});

test('a round that met something between the frames of the page is shown there with what it met', () => {
  // The display jumps over the burst: the frame before is short of it, the next one past it.
  const playback = new FramePresentation(), state = (time, rounds = []) => ({ time, actors: [], plates: [], modules: [], shots: packShots(rounds) });
  playback.receive(state(0, [round(0)]), [], { now: 0 });
  playback.receive(state(STEP, [round(STEP)]), [], { now: 0 });
  assert.equal(playback.present(playback.sample(1000 * STEP)).shots.length, 1);
  playback.receive(state(3 * STEP), [flight(STEP, 2 * STEP + .004, true), { type: 'blocked', time: 2 * STEP + .004, x: at(2 * STEP + .004), y: 2 }], { now: 1000 * STEP });
  playback.receive(state(4 * STEP), [], { now: 1000 * STEP + 1 });
  const events = [], frame = playback.present(playback.sample(1000 * STEP + 1), { consume: event => events.push(event) });
  assert(frame.time > 3 * STEP - 1e-9);
  assert.equal(events.filter(event => event.type === 'blocked').length, 1);
  assert.equal(frame.shots.length, 1); assert(Math.abs(frame.shots[0].x - at(2 * STEP + .004)) < 1e-9);
  assert.equal(playback.present(playback.sample(1000 * STEP + 20)).shots.length, 0);
});

// The real world told as the shared field tells it, a frame every 48 ms through the network frames, read by a page at
// 60 Hz: every round that strikes is drawn on every frame of its flight, and in the frame of what it struck, there.
test('real rounds of the field, fast and slow, are drawn up to their impacts on the frames of them', t => {
  const IMPACT = new Set(['explosion', 'blocked', 'penetration', 'ground', 'primary-contact', 'module']);
  for (const [preset, aim, shots] of [['m2hb', { x: -138, y: 1.5 }, 4], ['mk19', { x: -138, y: 0 }, 3]]) {
    const world = pageWorld(createConstruction('empty')); t.after(() => world.dispose());
    world.addActor(createConstruction('recon'), { id: 'alvo-0', ownerId: 'alvo', x: -138, facing: 1 });
    world.game();
    const config = world.playerWeapon({ preset, spread: 0 }), writer = new FrameWriter(), reader = new FrameReader(), playback = new FramePresentation(),
      ends = new Map(), inbox = [], drawn = new Map(), consumed = [];
    let fired = 0, accumulator = 0, sentAt = -Infinity, nextDraw = 3, frame = 0, whole = true, last = 0;
    for (let now = 0; now < 3500; now++) {
      if (now % 4 === 0) {
        if (fired < shots && now >= 300 + fired * 600) { fired++; world.fire(aim, config, true); }
        accumulator += (now - last) / 1000; last = now;
        for (let steps = 0; accumulator + 1e-10 >= FIXED_DT && steps < 4; steps++) { world.step(); accumulator -= FIXED_DT; }
        if (now - sentAt >= 48) {
          sentAt = now;
          const state = { ...world.snapshot(), shared: true }, events = world.drainEvents().map(tellEvent);
          state.shots = { ...state.shots, drag: world.shotDrags };
          for (const event of events) if (event.type === 'flight' && event.terminal && !event.fragment) ends.set(event.id, event.points.at(-1));
          inbox.push({ at: now + 20 + (now % 3) * 4, buffer: writer.encode({ state, events }, whole) }); whole = false;
        }
      }
      while (inbox.length && inbox[0].at <= now) {
        const packet = reader.decode(inbox.shift().buffer);
        playback.receive(packet.state, packet.events, { now });
      }
      if (now < nextDraw) continue;
      nextDraw += 1000 / 60; frame++;
      const sample = playback.sample(now); if (!sample) continue;
      const shown = playback.present(sample, { consume: event => consumed.push({ frame, time: sample.time, event }) });
      for (const shot of shown.shots) if (shot.id) {
        if (!drawn.has(shot.id)) drawn.set(shot.id, []);
        drawn.get(shot.id).push({ frame, x: shot.x, y: shot.y });
      }
    }
    let impacts = 0;
    for (const [id, end] of ends) {
      const hit = consumed.find(c => IMPACT.has(c.event.type) && Math.abs(c.event.time - end.time) < 2e-6);
      if (!hit) continue;
      impacts++;
      const marks = drawn.get(id) || [], first = marks[0]?.frame;
      assert(hit.time >= end.time - 1e-9, `${preset}: the impact is shown at its time`);
      for (let f = first; f < hit.frame; f++) assert(marks.some(mark => mark.frame === f), `${preset} ${id} is drawn on frame ${f} of its flight`);
      const there = marks.find(mark => mark.frame === hit.frame);
      assert(there && Math.hypot(there.x - end.x, there.y - end.y) < 1e-6, `${preset} ${id} is drawn where it struck, on the frame of the impact`);
      assert(!marks.some(mark => mark.frame > hit.frame), `${preset} ${id} is gone after`);
    }
    assert(impacts >= shots - 1, `${preset}: its rounds struck (${impacts})`);
  }
});
