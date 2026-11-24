import type { CargoKind } from './economy-contract.ts';

// Every job family has a scheduling weight and an explicit presentation branch.
export const PRIORITY = Object.freeze({ rearm: 4, repair: 2, work: 2, build: 2, dismantle: 2, grade: 2, pave: 2, heap: 1, haul: 1 });
export type JobKind = keyof typeof PRIORITY;
export type DispatchPhase = 'collect' | 'fetch' | 'deliver' | 'go' | 'work' | 'load' | 'return' | 'aside';
export type HaulPhase = 'out' | 'load' | 'home' | 'unload';
export type WaitReason = 'waiting-stock' | 'no-room' | 'waiting-place' | 'waiting-fuel' | 'waiting-material' | 'waiting-dismantle' |
  'waiting-grade' | 'target-lost' | 'threat' | 'danger' | 'immobile' | 'blocked-way' | 'no-loader' |
  `stuck-${string}` | 'no-landing' | 'out-of-range' | 'refuelling' | 'thruster-lost' | 'forced-landing' | 'mending';
export type PauseReason = 'manual-order' | 'manual-control';
export type JobReason = WaitReason | PauseReason | 'target-moving' | '';
interface Details { reason: JobReason; passing?: CargoKind | 'supplies'; post?: true }
export type ActiveJob = Details & { kind: JobKind; phase: DispatchPhase | HaulPhase; targetId: string };
export type ReturningJob = Details & ({ kind: null; phase: 'return'; targetId: null } | { kind: null; phase: 'aside'; targetId: null });
export type PausedJob = { kind: null; phase: 'paused'; targetId: null; reason: JobReason };
export type IdleJob = { kind: null; phase: 'idle'; targetId: string | null; reason: JobReason };
export type DispatchView = ActiveJob | ReturningJob | PausedJob | IdleJob;

// A Squad haul has its own phase. It does not replace the dispatcher's leg state.
type ActiveSource = Omit<ActiveJob, 'reason' | 'post'> & { reason?: JobReason; haul?: { phase: HaulPhase } | null };
type ReturningSource = Omit<ReturningJob, 'reason' | 'post'> & { reason?: JobReason };
export function jobView(job: ActiveSource | ReturningSource, post = false): ActiveJob | ReturningJob {
  const common: Details = { reason: job.reason || '', ...(job.passing ? { passing: job.passing } : {}), ...(post ? { post: true } : {}) };
  return job.kind === null ? { kind: null, phase: job.phase, targetId: null, ...common } :
    { kind: job.kind, phase: job.haul?.phase ?? job.phase, targetId: job.targetId, ...common };
}
export const pausedJob = (reason: JobReason): PausedJob => ({ kind: null, phase: 'paused', targetId: null, reason });
export const idleJob = (reason: JobReason, targetId: string | null = null): IdleJob => ({ kind: null, phase: 'idle', targetId, reason });
