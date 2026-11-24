const average = (values: readonly number[]): number => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const percentile = (values: readonly number[], fraction: number): number => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0 : 0;

export class FrameBudget {
  period = 0;
  remainder = 0;
  last = 0;
  constructor(now = 0, fps = 60) { this.setLimit(fps); this.reset(now); }
  // Zero lets requestAnimationFrame follow the display, including a refresh-rate change.
  setLimit(fps: number): void { this.period = fps > 0 ? 1000 / fps : 0; this.remainder = 0; }
  reset(now: number): void { this.last = now; this.remainder = 0; }
  take(now: number): boolean {
    if (!this.period) { this.last = now; return true; }
    this.remainder += Math.max(0, Math.min(100, now - this.last)); this.last = now;
    if (this.remainder + 1e-7 < this.period) return false;
    const elapsedPeriods = Math.max(1, Math.floor((this.remainder + 1e-7) / this.period));
    this.remainder = Math.max(0, this.remainder - elapsedPeriods * this.period); return true;
  }
}

export class PhysicsMetrics {
  started = 0;
  simStarted = 0;
  steps = 0;
  samples: { now: number; duration: number }[] = [];
  hz = 0;
  ratio = 0;
  measured = false;
  constructor(now = 0, time = 0) { this.reset(now, time); }
  reset(now: number, time: number): void { this.started = now; this.simStarted = time; this.steps = 0; this.samples = []; this.hz = 0; this.ratio = 0; this.measured = false; }
  record(now: number, duration: number): void { this.steps++; this.samples.push({ now, duration }); while (this.samples[0] && this.samples[0].now < now - 2000) this.samples.shift(); }
  read(now: number, time: number, speed: number, paused: boolean, backlog: number, snapshotMs: number): PhysicsProfile {
    const span = now - this.started;
    if (span >= 500) {
      this.hz = this.steps * 1000 / span;
      this.ratio = (time - this.simStarted) * 1000 / (span * speed);
      this.measured = true;
      this.started = now; this.simStarted = time; this.steps = 0;
    }
    while (this.samples[0] && this.samples[0].now < now - 2000) this.samples.shift();
    const durations = this.samples.map(s => s.duration);
    return { measured: this.measured, physicsMs: average(durations), physicsP95: percentile(durations, 0.95), physicsPeak: Math.max(0, ...durations), physicsHz: paused ? 0 : this.hz, simRatio: paused ? 0 : this.ratio, backlogMs: backlog * 1000, snapshotMs };
  }
}
export interface PhysicsProfile {
  measured: boolean; physicsMs: number; physicsP95: number; physicsPeak: number; physicsHz: number;
  simRatio: number; backlogMs: number; snapshotMs: number;
}
