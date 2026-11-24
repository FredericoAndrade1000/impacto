// Presentation only: the published strut displacement already follows the spring.
// A compression stroke sounds once, then needs a real rebound before another knock.
const STROKE = .018, REBOUND = .012, SPEED = .22, GAP = .13, SAMPLE_GAP = .25;
export interface SuspensionPart {
  readonly id: string;
  readonly actorId: string;
  readonly kind: string;
  readonly attached?: boolean | undefined;
  readonly health?: number | undefined;
  readonly x: number;
  readonly y: number;
  readonly suspension?: { readonly displacement?: number | undefined } | null | undefined;
  readonly groundContact?: unknown;
}
export interface SuspensionActor {
  readonly ghost?: unknown;
  readonly revision?: number | undefined;
  readonly vehicle?: { readonly vx?: number | undefined; readonly vy?: number | undefined; readonly chassisId?: string | null | undefined } | null | undefined;
}
export interface SuspensionState { readonly time: number; readonly modules?: readonly SuspensionPart[] | undefined }
export interface SuspensionIndex { readonly actors: Pick<ReadonlyMap<string, SuspensionActor>, 'get'> }
export interface SuspensionSound {
  type: 'suspension'; actorId: string; componentId: string; time: number; x: number; y: number; strength: number;
}
interface SuspensionHistory {
  time: number; d: number; x: number; y: number; low: number; peak: number; ready: boolean; at: number;
  revision: number | undefined; chassis: string | null | undefined;
}
export class SuspensionSoundGate {
  readonly parts = new Map<string, SuspensionHistory>();
  time: number | null = null;
  limit: number;
  constructor(limit = 256) { this.limit = limit; }
  clear(): void { this.parts.clear(); this.time = null; }
  sample(state: SuspensionState, index: SuspensionIndex): SuspensionSound[] {
    const time = state.time, bumps: SuspensionSound[] = [];
    if (!Number.isFinite(time) || time === this.time) return bumps;
    this.time = time;
    const seen = new Set<string>();
    for (const m of state.modules || []) {
      const actor = index.actors.get(m.actorId), d = m.suspension?.displacement;
      if (m.kind !== 'wheel' && m.kind !== 'track' || m.attached === false || !(Number(m.health) > 0) || typeof d !== 'number' || !Number.isFinite(d) || !actor?.vehicle || actor.ghost) continue;
      seen.add(m.id);
      let old = this.parts.get(m.id);
      if (old?.time === time) continue;
      const dt = time - (old?.time ?? time), speed = Math.hypot(actor.vehicle.vx || 0, actor.vehicle.vy || 0),
        jumped = old && Math.hypot(m.x - old.x, m.y - old.y) > 2 + speed * Math.max(0, dt) * 2;
      if (!old || dt <= 0 || dt > SAMPLE_GAP || old.revision !== actor.revision || old.chassis !== actor.vehicle.chassisId || jumped) {
        old = { time, d, x: m.x, y: m.y, low: d, peak: d, ready: true, at: -Infinity, revision: actor.revision, chassis: actor.vehicle.chassisId };
        this.parts.delete(m.id); this.parts.set(m.id, old);
      } else {
        old.low = Math.min(old.low, d); old.peak = Math.max(old.peak, d);
        if (!old.ready && old.peak - d >= REBOUND) { old.ready = true; old.low = d; old.peak = d; }
        const velocity = (d - old.d) / dt;
        if (m.groundContact && old.ready && d - old.low >= STROKE && velocity >= SPEED && time - old.at >= GAP) {
          bumps.push({ type: 'suspension', actorId: m.actorId, componentId: m.id, time, x: m.x, y: m.y,
            strength: Math.min(1, velocity / 1.2) });
          old.ready = false; old.peak = d; old.at = time;
        }
        if (!m.groundContact) { old.low = d; old.peak = d; old.ready = true; }
      }
      Object.assign(old, { time, d, x: m.x, y: m.y });
    }
    for (const id of this.parts.keys()) if (!seen.has(id)) this.parts.delete(id);
    while (this.parts.size > this.limit) {
      const oldest = this.parts.keys().next(); if (oldest.done) break;
      this.parts.delete(oldest.value);
    }
    return bumps;
  }
}
