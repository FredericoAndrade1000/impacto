// Shared by mobile benchmarks, never imported by the game. Missing calibration is data, not a default multiplier.
import { record } from './operational-input.ts';
import type { NetworkCondition } from './mobile-network.ts';
interface BudgetProfile { gpu?: { slowdown?: number | null } | null; transfers?: { bytesPerSecond?: number | null } | null }
export interface MobileProfile extends Record<string, unknown> {
  version: 1; benchmark: string; id: string; viewport: [number, number]; dpr: number;
  cpu: Record<string, unknown> & { rate: number };
  gpu: Record<string, unknown> & { slowdown: number | null };
  transfers: Record<string, unknown> & { scope: 'observed-webgl-uploads'; bytesPerSecond: number | null };
  network: NetworkCondition; calibration: Record<string, unknown> | null;
  missing: string[]; label: 'desktop-diagnostic' | 'synthetic-stress' | 'relative-mobile-budget'; applyBudgets: boolean; simulatedDeviceFPS: boolean;
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function networkCondition(value: unknown): NetworkCondition {
  if (!record(value) || !positive(value.downloadBytesPerSecond) || !positive(value.uploadBytesPerSecond) || typeof value.rttMs !== 'number' || !Number.isFinite(value.rttMs) || value.rttMs < 0)
    throw new Error('Condição de rede inválida.');
  return { ...value, downloadBytesPerSecond: value.downloadBytesPerSecond, uploadBytesPerSecond: value.uploadBytesPerSecond, rttMs: value.rttMs };
}
export function mobileProfile(profile: unknown, { diagnostic = false }: { diagnostic?: boolean } = {}): MobileProfile {
  if (!record(profile) || profile.version !== 1 || typeof profile.benchmark !== 'string' || !profile.benchmark || typeof profile.id !== 'string' || !profile.id)
    throw new Error('Perfil mobile sem versão, benchmark ou identificação.');
  const cpu = record(profile.cpu) ? profile.cpu : {}, gpu = record(profile.gpu) ? profile.gpu : {}, transfers = record(profile.transfers) ? profile.transfers : {};
  if (!Array.isArray(profile.viewport) || profile.viewport.length !== 2 || !positive(profile.viewport[0]) || !positive(profile.viewport[1]) || !positive(profile.dpr) || !positive(cpu.rate))
    throw new Error('Resolução ou limitação de CPU inválida.');
  const missing: string[] = [];
  for (const [name, value] of [['gpu', gpu.slowdown], ['transfers', transfers.bytesPerSecond]] satisfies [string, unknown][]) {
    if (value == null) missing.push(name);
    else if (!positive(value)) throw new Error(`Calibração inválida: ${name}.`);
  }
  if (transfers.scope !== 'observed-webgl-uploads') throw new Error('O orçamento de transferências não representa toda a RAM/VRAM.');
  const network = networkCondition(profile.network);
  if (missing.length && !diagnostic) throw new Error(`Perfil ${profile.id} sem calibração de ${missing.join(', ')}. Use diagnóstico sem anunciar FPS de A15 ou acrescente referências do mesmo benchmark.`);
  const calibration = record(profile.calibration) ? profile.calibration : null, synthetic = calibration?.kind === 'synthetic', digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    matched = calibration?.benchmark === profile.benchmark && digest(calibration.hostSHA256) && digest(calibration.referenceSHA256) && digest(calibration.inputsSHA256);
  if (!missing.length && !matched && !synthetic) throw new Error('Limites mobile exigem calibração e hashes do mesmo benchmark; números avulsos não identificam um A15.');
  if (synthetic && (!profile.id.startsWith('stress-') || calibration?.benchmark !== profile.benchmark)) throw new Error('Condição sintética deve ter identificação stress- e o mesmo benchmark.');
  return { ...profile, version: 1, id: profile.id, benchmark: profile.benchmark, viewport: [profile.viewport[0], profile.viewport[1]], dpr: profile.dpr,
    cpu: { ...cpu, rate: cpu.rate }, gpu: { ...gpu, slowdown: positive(gpu.slowdown) ? gpu.slowdown : null },
    transfers: { ...transfers, scope: 'observed-webgl-uploads', bytesPerSecond: positive(transfers.bytesPerSecond) ? transfers.bytesPerSecond : null },
    network, calibration, missing, label: missing.length ? 'desktop-diagnostic' : synthetic ? 'synthetic-stress' : 'relative-mobile-budget',
    applyBudgets: !missing.length, simulatedDeviceFPS: !missing.length && !synthetic };
}

// A quota on submitted work; the desktop still executes its GPU commands at native speed.
// GPU queries must be valid asynchronous durations, never draw() wall time or a reciprocal FPS.
export class MobileFrameBudget {
  declare profile: BudgetProfile;
  declare next: number; declare gpuSamples: number; declare transferBytes: number;
  constructor(profile: BudgetProfile) { this.profile = profile; this.reset(); }
  reset() { this.next = -Infinity; this.gpuSamples = 0; this.transferBytes = 0; }
  ready(now: number): boolean { return now >= this.next; }
  spend(now: number, { gpuMs = null, uploadBytes = 0 }: { gpuMs?: number | null; uploadBytes?: number } = {}) {
    if (!Number.isFinite(now) || !Number.isFinite(uploadBytes) || uploadBytes < 0) throw new Error('Amostra de orçamento inválida.');
    const gpu = this.profile.gpu?.slowdown;
    if (gpu && (gpuMs === null || !Number.isFinite(gpuMs) || gpuMs < 0)) throw new Error('O limite gráfico exige duração GPU válida.');
    const graphicsMs = gpu && gpuMs !== null ? gpuMs * gpu : 0, bps = this.profile.transfers?.bytesPerSecond,
      transferMs = bps ? uploadBytes * 1000 / bps : 0;
    this.gpuSamples += Number(Number.isFinite(gpuMs)); this.transferBytes += uploadBytes;
    // GPU and upload costs overlap; charging their sum would count transfer work twice.
    this.next = Math.max(now, this.next) + Math.max(graphicsMs, transferMs);
    return { graphicsMs, transferMs, next: this.next };
  }
}
