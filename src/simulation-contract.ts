import type { Point } from './math.ts';
import type { ConstructionSource } from './construction-contract.ts';
import type { SceneSnapshot, SceneEvent } from './scene-contract.ts';
import type { TerrainId } from './terrain.ts';
import type { WeaponOverrides } from './weapons.ts';
import type { PhysicsProfile } from './performance.ts';
import type { SlowStrike } from './slow-motion.ts';
import type { TestRequest, TestResult } from './field-protocol-contract.ts';
export interface WorkerInput { aim?: Point; weapon?: WeaponOverrides & { also?: WeaponOverrides[] }; queue?: boolean; cancel?: boolean; force?: boolean }
export interface WorkerCommands {
  ack: { serial: number }; clear: { generation: number };
  load: { generation: number; blueprint: ConstructionSource; terrain?: TerrainId; targets?: boolean; paused?: boolean; slow?: boolean };
  test: TestRequest; fire: WorkerInput; trigger: WorkerInput & { active: boolean }; aim: WorkerInput;
  drive: { throttle: number; brake?: number; rise?: number }; strike: { round: unknown; flight?: number };
  quicken: {}; resistance: { id: string; point: Point; end: Point; depth: number; cosine: number };
  pause: { value: boolean }; visible: { value: boolean }; reset: {};
}
export type WorkerCommandKind = keyof WorkerCommands;
export type WorkerCommandData = WorkerCommands;
export type WorkerCommand = { [Kind in WorkerCommandKind]: WorkerCommands[Kind] & { type: Kind; request?: number } }[WorkerCommandKind];
export type WorkerResult<Kind extends WorkerCommandKind> = Kind extends 'test' ? TestResult : Kind extends 'fire' | 'strike' ? { accepted: boolean } :
  Kind extends 'resistance' ? { resistance: number } : { ok: true };
export interface WorkerFrame {
  type: 'frame'; generation: number; serial: number; state: SceneSnapshot; events: SceneEvent[]; paused: boolean; pace: number;
  flight: Readonly<SlowStrike> | null; slowed: boolean; physicsMs: number; profile: PhysicsProfile & { dynamicsBackend: string };
}
export type WorkerReply = { type: 'reply'; request?: number; generation: number } & ({ error: string } | TestResult | { accepted: boolean } | { resistance: number } | { ok: true });
export type WorkerMessage = { type: 'ready' } | WorkerFrame | WorkerReply;
