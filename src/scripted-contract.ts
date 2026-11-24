import type { Point } from './math.ts';
import { AMMO } from './weapons.ts';
import { record as isRecord } from './wire-shape.ts';
import type { AmmoId, Trajectory, WeaponOverrides } from './weapons.ts';

export interface PilotBounds { minX: number; maxX: number; minY?: number | undefined; maxY?: number | undefined }
export interface PilotRequest { actorId: string; arenaBounds: PilotBounds; targetId?: string | undefined }
export interface PilotContact extends Point {
  detected: boolean; visible: boolean; source: string; channel?: string | undefined; classification: string;
  identified: boolean; confidence: number; time: number; age: number; uncertainty: number;
  width: number; height: number; vx: number; vy: number; sharedSound?: boolean | undefined;
}
export interface PilotGunAction extends WeaponOverrides { fire: boolean; aim?: Point | undefined }
export interface PilotControls extends PilotGunAction {
  type: 'controls'; throttle: number; brake: number; aim: Point;
  phase?: 'decision' | undefined; platform?: 'vehicle' | undefined; rise?: number | undefined;
  cancel?: boolean | undefined; also?: PilotGunAction[] | undefined;
}
export interface PilotDiagnostics {
  reason: string; confidence: number; uncertainty: number; nearestFreshContactDistance: number | null;
  flightTime: number | null; detonation: 'impact' | 'airburst'; burst: boolean; weaponCandidates: number;
  shotCandidates: number; checkedPaths: number; viableShots: number; guns: number;
  contactCover: boolean; terrainKnown: number; dispersion: number | null; aim: string | null; aimOffset: Point | null;
}
export interface ScriptedDecision { action: PilotControls; targetId: string | null; contact: PilotContact; diagnostics: PilotDiagnostics }
export interface SquadAction extends PilotControls { targetId?: string | null | undefined; contact?: PilotContact | null | undefined; diagnostics?: PilotDiagnostics | undefined }
export type ScriptedDecisionEntry = { result: ScriptedDecision; error?: never } | { error: string; result?: never };

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Resposta do piloto inválida.');
  return value;
}
function numeric(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Número do piloto inválido.'); return value; }
function string(value: unknown): string { if (typeof value !== 'string') throw new Error('Texto do piloto inválido.'); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Estado do piloto inválido.'); return value; }
function point(value: unknown): Point { const v = record(value); return { x: numeric(v.x), y: numeric(v.y) }; }
const nullableNumber = (value: unknown): number | null => value === null ? null : numeric(value);
function trajectory(value: unknown): Trajectory {
  if (value !== 'auto' && value !== 'direct' && value !== 'high' && value !== 'low') throw new Error('Trajetória do piloto inválida.');
  return value;
}
function isAmmo(value: unknown): value is AmmoId { return typeof value === 'string' && Object.hasOwn(AMMO, value); }
function ammo(value: unknown): AmmoId { if (!isAmmo(value)) throw new Error('Munição do piloto inválida.'); return value; }
function gun(value: unknown): PilotGunAction {
  const v = record(value), result: PilotGunAction = { fire: boolean(v.fire) };
  if (v.aim !== undefined) result.aim = point(v.aim);
  if (v.componentId !== undefined) result.componentId = string(v.componentId);
  if (v.ammo !== undefined) result.ammo = ammo(v.ammo);
  if (v.trajectory !== undefined) result.trajectory = trajectory(v.trajectory);
  if (v.charge !== undefined) result.charge = v.charge === 'auto' ? 'auto' : numeric(v.charge);
  if (v.aimAngle !== undefined) result.aimAngle = numeric(v.aimAngle);
  if (v.fuzeTime !== undefined) result.fuzeTime = numeric(v.fuzeTime);
  if (v.detonation !== undefined) {
    if (v.detonation !== 'impact' && v.detonation !== 'airburst') throw new Error('Espoleta do piloto inválida.');
    result.detonation = v.detonation;
  }
  return result;
}
export function decodeScriptedDecision(value: unknown): ScriptedDecision {
  const v = record(value), a = record(v.action), c = record(v.contact), d = record(v.diagnostics);
  if (a.type !== 'controls' || a.phase !== 'decision' || a.platform !== 'vehicle') throw new Error('Ação do piloto inválida.');
  if (d.detonation !== 'impact' && d.detonation !== 'airburst') throw new Error('Espoleta do piloto inválida.');
  const action: PilotControls = { ...gun(a), type: 'controls', phase: 'decision', platform: 'vehicle',
    throttle: numeric(a.throttle), brake: numeric(a.brake), aim: point(a.aim) };
  if (a.cancel !== undefined) action.cancel = boolean(a.cancel);
  if (a.rise !== undefined) action.rise = numeric(a.rise);
  if (a.also !== undefined) { if (!Array.isArray(a.also)) throw new Error('Armamento do piloto inválido.'); action.also = a.also.map(gun); }
  const contact: PilotContact = { x: numeric(c.x), y: numeric(c.y), detected: boolean(c.detected), visible: boolean(c.visible),
    source: string(c.source), classification: string(c.classification), identified: boolean(c.identified), confidence: numeric(c.confidence),
    time: numeric(c.time), age: numeric(c.age), uncertainty: numeric(c.uncertainty), width: numeric(c.width), height: numeric(c.height), vx: numeric(c.vx), vy: numeric(c.vy) };
  if (c.channel !== undefined) contact.channel = string(c.channel);
  if (c.sharedSound !== undefined) contact.sharedSound = boolean(c.sharedSound);
  const distance = nullableNumber(d.nearestFreshContactDistance);
  if (distance !== null && distance < 0) throw new Error('Leitura de ameaça do piloto inválida.');
  return { action, contact, targetId: v.targetId === null ? null : string(v.targetId), diagnostics: {
    reason: string(d.reason), confidence: numeric(d.confidence), uncertainty: numeric(d.uncertainty), nearestFreshContactDistance: distance,
    flightTime: nullableNumber(d.flightTime), detonation: d.detonation, burst: boolean(d.burst), weaponCandidates: numeric(d.weaponCandidates),
    shotCandidates: numeric(d.shotCandidates), checkedPaths: numeric(d.checkedPaths), viableShots: numeric(d.viableShots), guns: numeric(d.guns),
    contactCover: boolean(d.contactCover), terrainKnown: numeric(d.terrainKnown), dispersion: nullableNumber(d.dispersion),
    aim: d.aim === null ? null : string(d.aim), aimOffset: d.aimOffset === null ? null : point(d.aimOffset) } };
}
export function decodeScriptedDecisions(value: unknown): ScriptedDecisionEntry[] {
  if (!Array.isArray(value)) throw new Error('Lote de decisões inválido.');
  return value.map(entry => { const v = record(entry); return v.error === undefined ? { result: decodeScriptedDecision(v.result) } : { error: string(v.error) }; });
}
export function decodeLineOfFire(value: unknown): 'own' | 'ally' | null {
  if (value !== null && value !== 'own' && value !== 'ally') throw new Error('Linha de tiro inválida.'); return value;
}
