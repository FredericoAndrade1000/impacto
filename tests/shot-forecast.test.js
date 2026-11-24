import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { FrameWriter, FrameReader, decodeFrame } from '../src/network-protocol.ts';
import { ShotTable, ShotTeller, tellAll, TOLD_WORDS } from '../src/shot-forecast.ts';
import { packShots, listShots, shotCount, SHOT_WORDS, SHOT_KIND } from '../src/shots.ts';
import { placeRound } from './mechanical-queries.js';

const frame = (state, events = []) => ({ type: 'frame', state, events, profile: {} });
// The rounds a frame carries as it was written, before a reader made a block of them.
const told = buffer => decodeFrame(buffer).state.shots;
// How far the rounds of a reader are from those of the field, which must be the same rounds in the same order.
function apart(read, truth) {
  assert.equal(shotCount(read), shotCount(truth));
  const a = listShots(read), b = listShots(truth); let far = 0;
  for (const [index, shot] of a.entries()) {
    assert.deepEqual([shot.number, shot.id, shot.radius], [b[index].number, b[index].id, b[index].radius]);
    far = Math.max(far, Math.abs(shot.x - b[index].x), Math.abs(shot.y - b[index].y), Math.abs(shot.vx - b[index].vx) / 10, Math.abs(shot.vy - b[index].vy) / 10);
  }
  return far;
}

test('a round is told when it leaves the muzzle and followed from there to where the field has it', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  const config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 }), gun = w.launcher(config), writer = new FrameWriter(), reader = new FrameReader();
  const snapshot = () => { const state = w.snapshot(); state.shots = { ...state.shots, drag: w.shotDrags }; return state; };
  reader.decode(writer.encode(frame(snapshot()), true));
  let fired = 0, again = 0, far = 0, most = 0;
  for (let step = 0; step < 240; step++) {
    // A burst of twelve, a little higher each time; they are in the air for seconds.
    if (step % 5 === 0 && fired < 12) fired += w.fire({ x: gun.x + 60, y: gun.y + 30 + fired * 4 }, config, true) ? 1 : 0;
    w.step();
    if (step % 3 !== 2) continue;
    const state = snapshot(), buffer = writer.encode(frame(state, w.drainEvents())), said = told(buffer), got = reader.decode(buffer);
    assert(got, 'the reader keeps up'); assert(!said?.all, 'a frame after the first tells what changed, if anything did');
    again += (said?.turned?.length ?? 0) / TOLD_WORDS; most = Math.max(most, shotCount(state.shots));
    far = Math.max(far, apart(got.state.shots, state.shots));
  }
  assert.equal(fired, 12); assert(most >= 10, 'most of the burst was in the air at once: ' + most);
  assert.equal(again, 0, 'no round in free flight was told twice');
  assert(far < 0.01, 'the reader has every round within a centimetre of the field: ' + far);
});

test('a compacted native legend preserves a live round through the shared frame codec', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  const writer = new FrameWriter(), reader = new FrameReader(),
    shot = { x: 0, y: 500, vx: 1, vy: 0, power: 1, mass: 1, caliberMm: 20, ammo: 'ap' };
  placeRound(w, { ...shot, id: 'first-expired', fuzeTime: .001, blastRadius: 0 });
  placeRound(w, { ...shot, id: 'kept-round' });
  let previous = 0, resets = 0, previousKind = null, remapped = false;
  for (let i = 0; i < 520; i++) {
    placeRound(w, { ...shot, id: `expired-${i}`, fuzeTime: .001, blastRadius: 0 });
    w.step();
    const state = w.snapshot(); state.shots = { ...state.shots, drag: w.shotDrags };
    const count = state.shots.kinds.length;
    if (count < previous) resets++; previous = count;
    const kind = state.shots.data[SHOT_KIND];
    if (previousKind !== null && previousKind !== kind) remapped = true;
    previousKind = kind;
    assert(count <= 256, 'metadata stays bounded after expired shots');
    const got = reader.decode(writer.encode(frame(state, w.drainEvents()), i === 0));
    assert(got); assert.equal(shotCount(got.state.shots), 1);
    assert.equal(listShots(got.state.shots)[0].id, 'kept-round');
    assert(apart(got.state.shots, state.shots) < 1e-6);
  }
  assert(resets >= 2, 'more than one history window was replaced');
  assert(remapped, 'a surviving round changed its legend index without changing identity');
});

test('a round the field took out of its flight is told again, and one that struck is gone', () => {
  const shot = (number, x, y, vx, vy, age = 1) => ({ number, x, y, vx, vy, age, ammo: 'ap', weapon: 'cannon', preset: 'rh120', actorId: 'a', radius: .06 });
  const block = (...rounds) => ({ ...packShots(rounds), drag: Float64Array.from(rounds, () => 0) });
  const teller = new ShotTeller(), table = new ShotTable();
  const follow = said => 'dt' in said ? (table.advance(said.dt), table.mend(said.gone, said.fresh, said.turned)) : (table.count = 0, table.mend([], said.fresh, []));
  const first = block(shot(1, 0, 100, 100, 0), shot(2, 0, 200, 50, 20), shot(3, 0, 300, -30, 0));
  assert(follow(teller.whole(first)));
  // A tenth of a second later with no air: where gravity alone has them. The second glanced off something on the way.
  const dt = 0.1, fall = 9.81 * dt, drop = 9.81 * dt * dt / 2,
    next = block(shot(1, 10, 100 - drop, 100, -fall, 1.1), shot(2, 4, 201, -20, 35, 1.1), shot(3, -3, 300 - drop, -30, -fall, 1.1));
  const said = teller.next(next, dt);
  assert.deepEqual([said.gone.length, said.fresh.length, said.turned.length / TOLD_WORDS], [0, 0, 1]);
  assert.equal(said.turned[0], 1, 'by the place it has among the rounds'); assert.equal(said.turned[1], 2, 'and its number');
  assert(follow(said)); assert(apart({ data: table.words(), kinds: next.kinds }, next) < 1e-5);
  // The first strikes; two come, one of them with a number below the last told: it waited a step before it came.
  const later = block(shot(2, 2, 204.5 - drop, -20, 35 - fall, 1.2), shot(7, 1, 1, 1, 1, 0), shot(3, -6, 300 - 4 * drop, -30, -2 * fall, 1.2), shot(5, 9, 9, 9, 9, 0));
  const after = teller.next(later, dt);
  assert.deepEqual([[...after.gone], after.fresh.length / TOLD_WORDS, after.turned.length], [[0], 2, 0]);
  assert.deepEqual([after.fresh[0], after.fresh[1], after.fresh[TOLD_WORDS], after.fresh[TOLD_WORDS + 1]], [1, 7, 3, 5], 'each with the place it takes');
  assert(follow(after)); assert(apart({ data: table.words(), kinds: later.kinds }, later) < 1e-4);
  // A field whose rounds are not those the table followed is told whole.
  const other = block(shot(3, 0, 0, 0, 0), shot(2, 0, 0, 0, 0));
  assert.equal('dt' in teller.next(other, dt), false, 'rounds that changed their order');
  assert.equal(new ShotTable().mend([4], [], []), false, 'a table that is told of rounds it never had says so');
  assert.equal(tellAll(first.data, first.drag).length, 3 * TOLD_WORDS); assert.equal(first.data.length, 3 * SHOT_WORDS);
});

test('a reader that lost a frame asks for a whole one and goes on from it', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  const config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 }), gun = w.launcher(config), writer = new FrameWriter(), reader = new FrameReader();
  const snapshot = () => { const state = w.snapshot(); state.shots = { ...state.shots, drag: w.shotDrags }; return state; };
  const send = whole => { for (let i = 0; i < 3; i++) w.step(); const state = snapshot(); return [writer.encode(frame(state, w.drainEvents()), whole), state]; };
  reader.decode(writer.encode(frame(snapshot()), true));
  assert(w.fire({ x: gun.x + 60, y: gun.y + 40 }, config, true));
  assert(reader.decode(send()[0])); send();
  assert.equal(reader.decode(send()[0]), null, 'the frame after one that never came builds on nothing');
  const [whole, state] = send(true), got = reader.decode(whole);
  assert(told(whole).all, 'a whole frame tells every round');
  assert(apart(got.state.shots, state.shots) < 1e-6);
  const [next, then] = send(); assert(apart(reader.decode(next).state.shots, then.shots) < 0.01);
});
