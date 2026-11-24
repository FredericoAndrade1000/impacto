import type { SupplyBill } from './economy-contract.ts';
import { isDuelView } from './duel.ts';
import type { DuelView } from './duel.ts';

export const REPLAY_VERSION = 2;
export const REPLAY_FPS = 20;
export const REPLAY_CHUNK_SECONDS = 10;
export interface ReplayEntry {
  id: string; name: string; at: string; fieldId: string; start: number; end: number;
  compatible: boolean; reason: string | null; bytes: number;
  kind: 'chapter' | 'complete'; chapters: number;
}
export interface ReplayFaction {
  duel?: DuelView;
  id: string; name: string; color: string; base: number | null; ai: boolean;
  stock: SupplyBill; reason: string | null;
}
export interface ReplayUnit {
  id: string; factionId: string | null; name: string; order: string; goal: number | null;
  activity: string; reason: string; health: number; fuel: number;
}
export interface ReplayTelemetry { factions: ReplayFaction[]; units: ReplayUnit[] }
export interface ReplayMarker {
  time: number; kind: 'decision' | 'shot' | 'loss' | 'structure' | 'base' | 'chapter'; label: string;
  actorId?: string; factionId?: string; x?: number; y?: number;
}
export interface ReplayChunk {
  index: number; from: number; to: number; frames: number; bytes: number;
  chapter?: number; source?: { archiveId: string; index: number };
}
export interface ReplayChapter { name: string; from: number; to: number; worldFrom: number; worldTo: number }
export interface ReplayArchive {
  version: number; id: string; name: string; start: number; end: number; fps: number;
  status: 'verified' | 'diverged' | 'fell'; prints: number; stoppedAt: number; detail: string | null;
  chunks: ReplayChunk[]; markers: ReplayMarker[];
  chapters?: ReplayChapter[];
}
export type ReplayJob =
  | { status: 'idle' }
  | { status: 'preparing'; id: string; time: number; end: number }
  | { status: 'ready'; id: string; archive: ReplayArchive }
  | { status: 'error'; id: string; error: string };

const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// The envelope is independent of the renderer's scene schema and contains no
// saved players, access keys, native snapshots or commands to execute.
export function replayTelemetry(value: unknown): ReplayTelemetry {
  if (!record(value) || !Array.isArray(value.factions) || !Array.isArray(value.units) || value.factions.length > 256 || value.units.length > 4096)
    throw new Error('Invalid replay telemetry.');
  for (const f of value.factions) {
    if (!record(f) || typeof f.id !== 'string' || typeof f.name !== 'string' || typeof f.color !== 'string' ||
      !(f.base === null || finite(f.base)) || typeof f.ai !== 'boolean' || !(f.reason === null || typeof f.reason === 'string') ||
      !record(f.stock)) throw new Error('Invalid replay faction.');
    const stock = f.stock;
    if (f.duel !== undefined && !isDuelView(f.duel)) throw new Error('Invalid replay duel.');
    if (!['ferro', 'ligas', 'silica', 'combustivel'].every(k => finite(stock[k]))) throw new Error('Invalid replay stock.');
  }
  for (const u of value.units) if (!record(u) || typeof u.id !== 'string' || !(u.factionId === null || typeof u.factionId === 'string') ||
    typeof u.name !== 'string' || typeof u.order !== 'string' || !(u.goal === null || finite(u.goal)) ||
    typeof u.activity !== 'string' || typeof u.reason !== 'string' || !finite(u.health) || !finite(u.fuel)) throw new Error('Invalid replay unit.');
  return value as unknown as ReplayTelemetry;
}

// Each chunk starts with a complete ordinary network frame. Length-prefixing
// only bundles those packets; frame deltas and drawing validation stay shared.
export function replayPackets(bytes: ArrayBuffer): Uint8Array[] {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Replay chunk too large.');
  const data = new Uint8Array(bytes), view = new DataView(bytes), packets: Uint8Array[] = [];
  let at = 0;
  while (at < data.length) {
    if (at + 4 > data.length) throw new Error('Truncated replay chunk.');
    const length = view.getUint32(at, true); at += 4;
    if (!length || at + length > data.length || packets.length >= 1000) throw new Error('Invalid replay packet.');
    packets.push(data.subarray(at, at + length)); at += length;
  }
  return packets;
}
