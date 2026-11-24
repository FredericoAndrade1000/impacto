// The slow motion of a test of armour: a round struck at the design (armour-strike.ts) is seen flying to what it
// strikes, however fast it goes, and striking it at a tenth of the pace of the world; the world goes back to its pace
// by itself. Nothing tells of it. The core steps as it always does: only how much of its time passes in a second of
// the player's changes, and the page shows its steps as slowly (presentation.ts).

// The pace of the world after a round strikes.
export const SLOW_PACE = .1;
// How long the flight of a round struck at the design is shown, in seconds of the player's time, and the slowest the
// world goes for it: a flight too short to be shown so long at that pace is shown shorter. A flight is shown no
// quicker than the world goes.
export const FLIGHT_SECONDS = .8, FLIGHT_PACE = 1e-3;
// In seconds of the player's time: how long the world stays slow after a round strikes, how long it eases back up,
// and how long when the player asks for it.
export const SLOW_HOLD = 2.2, SLOW_OUT = .5, SLOW_CUT = .25;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const ease = (from: number, to: number, t: number): number => { const s = Math.max(0, t); return s >= 1 ? to : from + (to - from) * s * s * (3 - 2 * s); };

export interface SlowStrike { from: number; until: number; pace: number }
interface SlowFlight extends SlowStrike { left: number }
interface SlowPhase { at: number; leave: number; back: number; out: number }
type Playback = { kind: 'running' } | { kind: 'flight'; flight: SlowFlight; phase: SlowPhase } | { kind: 'slowing'; phase: SlowPhase };

export class SlowMotion {
  private playback: Playback = { kind: 'running' };
  private speed = 1;
  private shown: SlowStrike | null = null;
  get flight(): Readonly<SlowFlight> | null { return this.playback.kind === 'flight' ? this.playback.flight : null; }
  get phase(): Readonly<SlowPhase> | null { return this.playback.kind === 'running' ? null : this.playback.phase; }
  get struck(): Readonly<SlowStrike> | null { return this.shown; }
  get pace(): number { return this.speed; }
  clear(): void { this.playback = { kind: 'running' }; this.shown = null; this.speed = 1; }
  // Whether the world is slowed and not yet easing back up.
  get slowed(): boolean { return this.playback.kind === 'flight' || this.playback.kind === 'slowing' && this.playback.phase.at < this.playback.phase.leave; }
  // A round was put in the air at `time` of the world that strikes `flight` seconds of it later: until then the world
  // goes at the pace of its flight (`flight.pace`), and from then on slowly, for SLOW_HOLD. `struck` tells the page
  // that flight, to show it as slowly, until the player asks for the pace back.
  strike(time: number, flight: number): void {
    const flying = { from: time, until: time + flight, left: flight, pace: clamp(flight / FLIGHT_SECONDS, FLIGHT_PACE, 1) };
    this.shown = { from: time, until: time + flight, pace: flying.pace };
    this.playback = { kind: 'flight', flight: flying, phase: { at: 0, leave: SLOW_HOLD, back: SLOW_PACE, out: SLOW_OUT } };
    this.speed = SLOW_PACE;
  }
  // The player asks for the pace back: it eases up at once, quicker. Whether the world was slowed.
  end(): boolean {
    this.shown = null;
    const active = this.playback;
    if (active.kind === 'running' || active.kind === 'slowing' && !(active.phase.at < active.phase.leave)) return false;
    if (active.kind === 'flight') { this.playback = { kind: 'slowing', phase: active.phase }; this.speed = SLOW_PACE; }
    Object.assign(active.phase, { leave: active.phase.at, back: this.speed, out: SLOW_CUT });
    return true;
  }
  // Time of the player passes, `seconds` of it, while the world runs: how much time of the world passes with it.
  // `pace` is that of the world after it.
  advance(seconds: number): number {
    let passed = 0;
    let playback = this.playback;
    if (playback.kind === 'flight') {
      const flight = playback.flight;
      const flown = Math.min(seconds * flight.pace, flight.left);
      flight.left -= flown; passed += flown; seconds -= flown / flight.pace;
      if (flight.left > 1e-12) return passed;
      this.playback = playback = { kind: 'slowing', phase: playback.phase };
    }
    if (playback.kind === 'running') { this.speed = 1; return passed + seconds; }
    const phase = playback.phase;
    phase.at += seconds;
    if (phase.at < phase.leave) this.speed = SLOW_PACE;
    else {
      const t = (phase.at - phase.leave) / phase.out;
      if (t >= 1) { this.playback = { kind: 'running' }; this.speed = 1; }
      else this.speed = ease(phase.back, 1, t);
    }
    return passed + seconds * this.speed;
  }
}
