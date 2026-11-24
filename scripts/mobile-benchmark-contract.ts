/// <reference lib="dom" />
import { mobileProfile } from './mobile-profile.ts';
import type { MobileProfile } from './mobile-profile.ts';
import { record, expectRecord, expectArray, expectString, expectNumber } from './operational-input.ts';
import { isRenderFieldView, decodeDrawingEvents } from '../src/scene-drawing-codec.ts';
import type { FrameItem, FramePacket, FrameScene, DecodedFramePacket } from '../src/network-protocol.ts';
import type { RenderFieldView } from '../src/render.ts';
import type { SceneEventBase } from '../src/scene-contract.ts';

export type RecordingKind = 'fleet' | 'combat' | 'fire' | 'flight' | 'dust' | 'wreck' | 'parked' | 'wreck-ground';
export interface BenchmarkCase {
  record: RecordingKind; zoom?: number; near?: boolean; scenery?: 'forest' | 'grass' | 'deposits'; effect?: string;
  enter?: boolean; opened?: boolean; parts?: boolean; pan?: boolean; photoTick?: number; module?: string; moduleIndex?: number;
}
export interface FrozenSource { commit: string; sourceTreeSHA256: string }
export interface BenchmarkSource extends FrozenSource { modules: Record<string, string> }
export interface FrozenManifest extends FrozenSource { name: string; files: Record<string, { sha256: string; bytes: number }> }
export interface BuildFingerprint extends Record<string, unknown> { sourceSHA256: string; binarySHA256: string; profile: 'release' | 'preview' }
export interface NativeFingerprint extends BuildFingerprint { binaryFile: string }
export interface Recording extends Record<string, unknown> {
  packets: { time: number; data: string }[]; watch: Record<string, unknown>; native: BuildFingerprint; wasm: BuildFingerprint;
}
export interface RecordingFile extends Record<string, unknown> { file: string; sha256: string; bytes: number; snapshots: number }
export interface RecordingIndex extends Record<string, unknown> { native: BuildFingerprint; wasm: BuildFingerprint; records: Record<string, RecordingFile> }
export interface BenchmarkConfig {
  benchmark: string; profile: MobileProfile; directory: string; cases: Record<string, BenchmarkCase>; sources: Record<string, BenchmarkSource>;
}
export interface BenchmarkResult extends Record<string, unknown> {
  valid: boolean; summary?: Record<string, unknown>; hardware?: Record<string, unknown>; photo?: Record<string, unknown>;
}
export interface BenchmarkPageAPI { ready: boolean; renderer?: unknown; hardware?: unknown; photo(): Promise<Record<string, unknown>>; replay(options?: { steady?: boolean; captureScale?: number }): Promise<Record<string, unknown>>; run(): Promise<BenchmarkResult> }
export interface BenchmarkActor extends FrameItem { x: number; vehicle: Record<string, unknown> & { x: number; y: number; vx?: number; vy?: number } }
export interface BenchmarkModule extends FrameItem { actorId: string; kind: string; x: number; y: number; weaponPreset?: string; burning?: boolean; thrust?: number; groundContact?: { x: number } | null }
export interface BenchmarkScene extends FrameScene { actors: [BenchmarkActor, ...BenchmarkActor[]]; modules: BenchmarkModule[] }
export interface BenchmarkPacket extends DecodedFramePacket<BenchmarkScene & RenderFieldView, SceneEventBase> { bytes: number; sourceTime: number }
declare global { interface Window { mobileBenchmark?: BenchmarkPageAPI } }

const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function buildFingerprint(value: unknown): BuildFingerprint {
  const input = expectRecord(value);
  if (!digest(input.sourceSHA256) || !digest(input.binarySHA256) || input.profile !== 'release' && input.profile !== 'preview') throw new Error('Identificação do núcleo do benchmark inválida.');
  return { ...input, sourceSHA256: input.sourceSHA256, binarySHA256: input.binarySHA256, profile: input.profile };
}
export function nativeFingerprint(value: unknown): NativeFingerprint {
  const input = buildFingerprint(value);
  return { ...input, binaryFile: expectString(input.binaryFile) };
}
export function frozenManifest(value: unknown): FrozenManifest {
  const input = expectRecord(value), files: FrozenManifest['files'] = {};
  for (const [name, entry] of Object.entries(expectRecord(input.files))) {
    const file = expectRecord(entry);
    if (!digest(file.sha256)) throw new Error('Hash do código congelado inválido.');
    files[name] = { sha256: file.sha256, bytes: expectNumber(file.bytes) };
  }
  if (!digest(input.sourceTreeSHA256)) throw new Error('Hash da árvore congelada inválido.');
  return { name: expectString(input.name), commit: expectString(input.commit), sourceTreeSHA256: input.sourceTreeSHA256, files };
}
export function benchmarkSource(manifest: FrozenManifest): BenchmarkSource {
  const modules: Record<string, string> = {};
  for (const file of Object.keys(manifest.files)) {
    const match = file.match(/^src\/([^/]+)\.(js|ts)$/), name = match?.[1];
    if (name && (!modules[name] || match?.[2] === 'ts')) modules[name] = file.slice(4);
  }
  return { commit: manifest.commit, sourceTreeSHA256: manifest.sourceTreeSHA256, modules };
}
export function recording(value: unknown): Recording {
  const input = expectRecord(value), packets = expectArray(input.packets).map(value => {
    const packet = expectRecord(value); return { time: expectNumber(packet.time), data: expectString(packet.data) };
  });
  if (!packets.length) throw new Error('Benchmark sem quadros gravados.');
  return { ...input, packets, watch: expectRecord(input.watch), native: buildFingerprint(input.native), wasm: buildFingerprint(input.wasm) };
}
export function recordingIndex(value: unknown): RecordingIndex {
  const input = expectRecord(value), records: Record<string, RecordingFile> = {};
  for (const [name, entry] of Object.entries(expectRecord(input.records))) {
    const file = expectRecord(entry);
    if (!digest(file.sha256)) throw new Error('Hash da gravação inválido.');
    records[name] = { ...file, file: expectString(file.file), sha256: file.sha256, bytes: expectNumber(file.bytes), snapshots: expectNumber(file.snapshots) };
  }
  return { ...input, records, native: buildFingerprint(input.native), wasm: buildFingerprint(input.wasm) };
}
function benchmarkCase(value: unknown): value is BenchmarkCase {
  if (!record(value) || !['fleet', 'combat', 'fire', 'flight', 'dust', 'wreck', 'parked', 'wreck-ground'].includes(expectString(value.record))) return false;
  for (const key of ['zoom', 'photoTick', 'moduleIndex']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return false;
  for (const key of ['near', 'enter', 'opened', 'parts', 'pan']) if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  for (const key of ['effect', 'module']) if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  return value.scenery === undefined || value.scenery === 'forest' || value.scenery === 'grass' || value.scenery === 'deposits';
}
export function benchmarkConfig(value: unknown): BenchmarkConfig {
  const input = expectRecord(value), cases: Record<string, BenchmarkCase> = {}, sources: Record<string, BenchmarkSource> = {};
  for (const [name, item] of Object.entries(expectRecord(input.cases))) {
    if (!benchmarkCase(item)) throw new Error(`Caso de benchmark inválido: ${name}`);
    cases[name] = item;
  }
  for (const [name, item] of Object.entries(expectRecord(input.sources))) {
    const source = expectRecord(item), modules: Record<string, string> = {};
    for (const [name, value] of Object.entries(expectRecord(source.modules))) {
      const file = expectString(value);
      if (file !== name + '.js' && file !== name + '.ts') throw new Error('Módulo fora da variante congelada.');
      modules[name] = file;
    }
    sources[name] = { commit: expectString(source.commit), sourceTreeSHA256: expectString(source.sourceTreeSHA256), modules };
  }
  return { benchmark: expectString(input.benchmark), profile: mobileProfile(input.profile, { diagnostic: true }), directory: expectString(input.directory), cases, sources };
}
export function benchmarkResult(value: unknown): BenchmarkResult {
  const input = expectRecord(value);
  if (typeof input.valid !== 'boolean') throw new Error('Resultado do benchmark sem validade.');
  return { ...input, valid: input.valid, summary: expectRecord(input.summary), hardware: expectRecord(input.hardware) };
}
// The transport owns delta/binary admission. The fixed renderer scenes additionally require
// positioned vehicles and parts; this does not claim the private live-physics module shape.
export function benchmarkPacket(packet: FramePacket | null, bytes: number, sourceTime: number): BenchmarkPacket {
  if (!packet) throw new Error('Quadro da gravação recusado pelo protocolo.');
  if (!isRenderFieldView(packet.state)) throw new Error('Cena da gravação recusada pelo desenho.');
  if (!benchmarkScene(packet.state)) throw new Error('Gravação sem veículos ou componentes posicionados.');
  return { ...packet, state: packet.state, events: decodeDrawingEvents(packet.events), bytes, sourceTime };
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function benchmarkActor(value: unknown): value is BenchmarkActor {
  return record(value) && typeof value.id === 'string' && finite(value.x) && record(value.vehicle) && finite(value.vehicle.x) && finite(value.vehicle.y) &&
    (value.vehicle.vx === undefined || finite(value.vehicle.vx)) && (value.vehicle.vy === undefined || finite(value.vehicle.vy));
}
function benchmarkModule(value: unknown): value is BenchmarkModule {
  return record(value) && typeof value.id === 'string' && typeof value.actorId === 'string' && typeof value.kind === 'string' && finite(value.x) && finite(value.y) &&
    (value.weaponPreset === undefined || typeof value.weaponPreset === 'string') && (value.burning === undefined || typeof value.burning === 'boolean') && (value.thrust === undefined || finite(value.thrust));
}
function benchmarkScene(value: FrameScene): value is BenchmarkScene {
  return Array.isArray(value.actors) && value.actors.length > 0 && value.actors.every(benchmarkActor) && Array.isArray(value.modules) && value.modules.every(benchmarkModule);
}
