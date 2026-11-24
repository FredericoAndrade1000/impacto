// The rounds in the air, followed between two tellings. Nothing acts on a round that strikes
// nothing but gravity and the air, so whoever has where it was, how fast and what the air takes
// of it knows where it is a moment later. A host tells a round once and a screen follows it from
// there; the host follows it the same way, and tells it again when the screen would have it
// somewhere it is not: a ricochet, a fuze, a round the field took out of its flight.
//
// A told round is ten numbers: its place among the rounds, the eight numbers of `shots.ts`, and
// its drag, per metre flown at sea level: higher up, as much less as the air there is thinner
// (atmosphere.ts). They are told at the width the core holds them, so that a round followed from
// one telling is the core's round wherever in the world it flies.
import { SHOT_WORDS } from './shots.ts';
import { AIR_DENSITY, airDensity, thinning } from './atmosphere.ts';
import type { ShotBlock } from './shots.ts';

type NumberBlock = ArrayLike<number>;
export interface ForecastShots extends Pick<ShotBlock, 'data'> { drag?: Float64Array }
export interface ShotDelta { gone: Uint32Array; fresh: Float64Array; turned: Float64Array }

export const TOLD_WORDS = 10;
const GRAVITY = 9.81;
// How far a screen may have a round from where it is before it is told again: three
// centimetres, a twentieth of a metre a second, and for its age a fiftieth of a second.
const NEAR = 0.03, SLOW = 0.05, YOUNG = 0.02;
// What the air takes of a round's speed, as a share of it, over `step` seconds of the flow of the air alone (game_flight.rs
// `split`): the round going at `speed` along a straight chord from the height `y`, climbing at `uy` m/s, through the air
// at the middle of that chord, as the air at the height `reference`, which takes `air` for each metre, tells where that is.
function spent(air: number, reference: number, y: number, uy: number, speed: number, step: number) {
  const guess = air * speed * step;
  return air * thinning(reference, y + uy * step * 0.5 * (6 + guess) / (6 + 4 * guess)) * speed * step;
}

export class ShotTable {
  declare count: number; declare room: number;
  declare own: Float64Array; declare flight: Float64Array;
  declare spare: { own: Float64Array; flight: Float64Array };
  // What never changes of a round is kept apart from what its flight moves: number, kind and
  // radius; then where it is and how fast, its age and its drag. Host and screen, doing the
  // same sums on the same numbers, keep the same round. A second pair of the same size is what
  // the rounds are moved into when some leave or come.
  constructor(room = 256) {
    this.count = 0; this.room = room;
    this.own = new Float64Array(room * 3); this.flight = new Float64Array(room * 6);
    this.spare = { own: new Float64Array(room * 3), flight: new Float64Array(room * 6) };
  }
  // Every round a moment later, with nothing in its way: the step the core gives a round in
  // the air (`FlightState::advance`), taken once for the whole moment. Gravity for half the
  // moment, the air for all of it, gravity for the other half; the same in two halves; and
  // what the two say of the error of each. The air is reckoned at the height the round is at
  // halfway through the moment, and each part of it flown through the air of its own chord.
  advance(dt: number) {
    if (!(dt > 0)) return;
    const flight = this.flight, half = dt * 0.5, kick = GRAVITY * dt * 0.5, nudge = GRAVITY * half * 0.5;
    for (let at = 0, end = this.count * 6; at < end; at += 6) {
      const x = flight[at]!, y = flight[at + 1]!, vx = flight[at + 2]!, vy = flight[at + 3]!,
        reference = y + half * (vy - GRAVITY * dt * 0.25), air = flight[at + 5]! * airDensity(reference) / AIR_DENSITY;
      let uy = vy - kick, q = spent(air, reference, y, uy, Math.sqrt(vx * vx + uy * uy), dt), far, slow, q2;
      // The length flown through air that slows, over the length flown through none, is
      // log(1 + q) / q: by its series while that is good to the last bits of a position.
      if (q < 0.05) { q2 = q * q; far = dt * (1 - q * 0.5 + q2 * (1 / 3 - q * 0.25) + q2 * q2 * (0.2 - q / 6 + q2 * (1 / 7 - q * 0.125))); }
      else far = dt * Math.log(1 + q) / q;
      slow = 1 / (1 + q);
      const cx = x + vx * far, cy = y + uy * far, cvx = vx * slow, cvy = uy * slow - kick;
      uy = vy - nudge; q = spent(air, reference, y, uy, Math.sqrt(vx * vx + uy * uy), half);
      if (q < 0.05) { q2 = q * q; far = half * (1 - q * 0.5 + q2 * (1 / 3 - q * 0.25) + q2 * q2 * (0.2 - q / 6 + q2 * (1 / 7 - q * 0.125))); }
      else far = half * Math.log(1 + q) / q;
      slow = 1 / (1 + q);
      let fx = x + vx * far, fy = y + uy * far, fvx = vx * slow, fvy = uy * slow - nudge;
      uy = fvy - nudge; q = spent(air, reference, fy, uy, Math.sqrt(fvx * fvx + uy * uy), half);
      if (q < 0.05) { q2 = q * q; far = half * (1 - q * 0.5 + q2 * (1 / 3 - q * 0.25) + q2 * q2 * (0.2 - q / 6 + q2 * (1 / 7 - q * 0.125))); }
      else far = half * Math.log(1 + q) / q;
      slow = 1 / (1 + q);
      fx += fvx * far; fy += uy * far; fvx *= slow; fvy = uy * slow - nudge;
      flight[at] = fx + (fx - cx) / 3; flight[at + 1] = fy + (fy - cy) / 3;
      flight[at + 2] = fvx + (fvx - cvx) / 3; flight[at + 3] = fvy + (fvy - cvy) / 3;
      flight[at + 4] = flight[at + 4]! + dt;
    }
  }
  // A told round takes the place it was told with.
  put(index: number, told: NumberBlock, at: number) {
    const own = this.own, flight = this.flight, o = index * 3, f = index * 6;
    own[o] = told[at + 1]!; own[o + 1] = told[at + 2]!; own[o + 2] = told[at + 8]!;
    flight[f] = told[at + 3]!; flight[f + 1] = told[at + 4]!; flight[f + 2] = told[at + 5]!; flight[f + 3] = told[at + 6]!;
    flight[f + 4] = told[at + 7]!; flight[f + 5] = told[at + 9]!;
  }
  // The rounds that are gone leave, by the places they had; those new take the places they are
  // told with among the ones that stay; and those that turned are told where they are. False
  // when what is told does not fit the rounds this table has: it is then no table of anything.
  mend(gone: NumberBlock, fresh: NumberBlock, turned: NumberBlock) {
    const had = this.count, count = had - gone.length + fresh.length / TOLD_WORDS;
    if (gone.length > had) return false;
    if (gone.length || fresh.length) {
      const own = this.own, flight = this.flight;
      if (count > this.room) { this.room = Math.max(count, this.room * 2); this.spare = { own: new Float64Array(this.room * 3), flight: new Float64Array(this.room * 6) }; }
      const to = this.spare; this.spare = { own, flight }; this.own = to.own; this.flight = to.flight;
      if (this.spare.own.length < to.own.length) this.spare = { own: new Float64Array(this.room * 3), flight: new Float64Array(this.room * 6) };
      // The rounds that stay move in runs: from one that left to the next, into the place before the next that came.
      let from = 0, index = 0, lost = 0, next = 0;
      while (index < count) {
        if (next < fresh.length && fresh[next]! === index) { this.put(index++, fresh, next); next += TOLD_WORDS; continue; }
        while (lost < gone.length && gone[lost]! === from) { lost++; from++; }
        const run = Math.min((lost < gone.length ? gone[lost]! : had) - from, (next < fresh.length ? fresh[next]! : count) - index);
        if (!(run > 0)) return false;
        to.own.set(own.subarray(from * 3, (from + run) * 3), index * 3);
        to.flight.set(flight.subarray(from * 6, (from + run) * 6), index * 6);
        from += run; index += run;
      }
      if (next !== fresh.length) return false;
      this.count = count;
    }
    for (let at = 0; at < turned.length; at += TOLD_WORDS) { if (turned[at]! >= this.count) return false; this.put(turned[at]!, turned, at); }
    return true;
  }
  // The rounds as a screen takes them: eight numbers each (`shots.ts`).
  words() {
    const data = new Float64Array(this.count * SHOT_WORDS), own = this.own, flight = this.flight;
    for (let index = 0, at = 0, o = 0, f = 0; index < this.count; index++, at += SHOT_WORDS, o += 3, f += 6) {
      data[at] = own[o]!; data[at + 1] = own[o + 1]!; data[at + 7] = own[o + 2]!;
      data[at + 2] = flight[f]!; data[at + 3] = flight[f + 1]!; data[at + 4] = flight[f + 2]!; data[at + 5] = flight[f + 3]!; data[at + 6] = flight[f + 4]!;
    }
    return data;
  }
}

// One round of a block as it is told: its place, its eight numbers, its drag.
function tell(out: number[], index: number, data: NumberBlock, at: number, drag: number) {
  out.push(index, data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!, data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!, drag);
}
// Every round of a block, told: what a screen that knows nothing starts from.
export function tellAll(data: NumberBlock, drags?: NumberBlock) {
  const count = data.length / SHOT_WORDS, told = new Float64Array(count * TOLD_WORDS);
  for (let index = 0, at = 0, to = 0; index < count; index++, at += SHOT_WORDS, to += TOLD_WORDS) {
    told[to] = index;
    told[to + 1] = data[at]!; told[to + 2] = data[at + 1]!; told[to + 3] = data[at + 2]!; told[to + 4] = data[at + 3]!;
    told[to + 5] = data[at + 4]!; told[to + 6] = data[at + 5]!; told[to + 7] = data[at + 6]!; told[to + 8] = data[at + 7]!;
    told[to + 9] = drags ? drags[index]! : 0;
  }
  return told;
}

// The places of the rounds of a table, by their numbers.
class Places {
  declare size: number; declare keys: Uint32Array; declare at: Int32Array;
  constructor() { this.size = 0; }
  fill(table: ShotTable) {
    let size = 256; while (size < table.count * 2) size *= 2;
    if (size !== this.size) { this.size = size; this.keys = new Uint32Array(size); this.at = new Int32Array(size); }
    this.at.fill(-1);
    const mask = size - 1, own = table.own;
    for (let index = 0; index < table.count; index++) {
      const number = own[index * 3]!; let slot = Math.imul(number, 0x9e3779b1) >>> 0 & mask;
      while (this.at[slot]! >= 0) slot = slot + 1 & mask;
      this.keys[slot] = number; this.at[slot] = index;
    }
  }
  of(number: number) {
    const mask = this.size - 1; let slot = Math.imul(number, 0x9e3779b1) >>> 0 & mask;
    while (this.at[slot]! >= 0) { if (this.keys[slot]! === number) return this.at[slot]!; slot = slot + 1 & mask; }
    return -1;
  }
}

// What a host says of the rounds from one frame to the next. It keeps the table the screen
// keeps, moved the same way, and tells what the screen cannot work out.
export class ShotTeller {
  declare table: ShotTable | null; declare places: Places; declare last: number;
  constructor() { this.table = null; this.places = new Places(); this.last = 0; }
  // Everything, for a screen that starts here.
  whole(shots: ForecastShots) {
    const fresh = tellAll(shots.data, shots.drag);
    this.table = new ShotTable(Math.max(256, shots.data.length / SHOT_WORDS)); this.table.mend([], fresh, []);
    this.last = 0; for (let at = 0; at < shots.data.length; at += SHOT_WORDS) if (shots.data[at]! > this.last) this.last = shots.data[at]!;
    return { fresh };
  }
  // What changed in `dt` seconds of the field, or everything when the rounds are not those the table follows.
  next(shots: ForecastShots, dt: number) {
    const table = this.table;
    if (!table || !(dt >= 0) || dt > 1) return this.whole(shots);
    table.advance(dt);
    // The rounds that stay keep the order they had and those that come carry numbers above every
    // number there was: one walk tells them apart. A field that does otherwise — a round that
    // waited a step before it came — is walked again with the place of every number at hand.
    const told = this.walk(shots, false) || this.walk(shots, true);
    if (!told || !table.mend(told.gone, told.fresh, told.turned)) return this.whole(shots);
    for (let at = 1; at < told.fresh.length; at += TOLD_WORDS) if (told.fresh[at]! > this.last) this.last = told.fresh[at]!;
    return { dt, ...told };
  }
  walk(shots: ForecastShots, placed: boolean): ShotDelta | null {
    const table = this.table!, data = shots.data, drags = shots.drag, count = data.length / SHOT_WORDS, had = table.count,
      own = table.own, flight = table.flight,
      gone: number[] = [], fresh: number[] = [], turned: number[] = [];
    if (placed) this.places.fill(table);
    let from = 0;
    for (let index = 0, at = 0; index < count; index++, at += SHOT_WORDS) {
      const number = data[at]!; let place;
      if (placed) {
        place = this.places.of(number);
        // One found behind where the last was: this is not the field the table followed.
        if (place >= 0 && place < from) return null;
      } else if (number > this.last) place = -1;
      else {
        place = from;
        while (place < had && own[place * 3]! !== number) place++;
        if (place === had) return null;
      }
      if (place < 0) { tell(fresh, index, data, at, drags ? drags[index]! : 0); continue; }
      while (from < place) gone.push(from++);
      from++;
      const o = place * 3, f = place * 6;
      if (own[o + 1]! !== data[at + 1]! || own[o + 2]! !== data[at + 7]! ||
          !(Math.abs(flight[f]! - data[at + 2]!) <= NEAR && Math.abs(flight[f + 1]! - data[at + 3]!) <= NEAR &&
            Math.abs(flight[f + 2]! - data[at + 4]!) <= SLOW && Math.abs(flight[f + 3]! - data[at + 5]!) <= SLOW &&
            Math.abs(flight[f + 4]! - data[at + 6]!) <= YOUNG))
        tell(turned, index, data, at, drags ? drags[index]! : 0);
    }
    while (from < had) gone.push(from++);
    return { gone: Uint32Array.from(gone), fresh: Float64Array.from(fresh), turned: Float64Array.from(turned) };
  }
}
