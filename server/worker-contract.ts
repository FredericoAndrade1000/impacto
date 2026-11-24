import type { SupplyBill } from '../src/economy-contract.ts';
import type { RoomRequest } from './room-contract.ts';
import { isAbsolute, parse, resolve } from 'node:path';
import { ROOM_LIMITS } from './room-limits.ts';
export interface RehearsalField { bases?: number[]; stock?: SupplyBill }
export interface FieldSaveOptions { dir: string; seconds?: number }
export interface FieldWorkerOptions { rehearsal?: RehearsalField | null; stress?: boolean | number; save?: FieldSaveOptions | null; testTools?: boolean; commanders?: number; commanderFill?: number }
export const COMMANDER_LIMIT = 4;
export type HostMessage = { type: 'ack' } | { type: 'save'; done: Int32Array } | { type: 'whole'; peerIds: string[] } |
  { type: 'disconnect'; peerId: string } | { type: 'command'; peerId: string; data: RoomRequest; address?: string | null };
export interface BroadcastFrame { peers: string[]; buffer: ArrayBuffer; whole: boolean }
export type WorkerMessage = { type: 'ready' } | { type: 'broadcast'; frames: BroadcastFrame[] } |
  { type: 'kick' | 'handled'; peerId: string } | { type: 'direct'; peerId: string; payload: Record<string, unknown> };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s: unknown) => typeof s === 'string');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function bill(v: unknown): v is SupplyBill { return record(v) && finite(v.ferro) && finite(v.ligas) && finite(v.silica) && finite(v.combustivel); }
export function readCommanderCount(value: unknown, testTools: boolean): number {
  if (!finite(value) || !Number.isInteger(value) || value < 0 || value > COMMANDER_LIMIT) throw new Error('A contagem de comandantes de teste deve ser de 0 a 4.');
  if (value > 0 && !testTools) throw new Error('Comandantes exigem IMPACTO_TEST_SERVER=1.');
  return value;
}
export function readCommanderFill(value: unknown): number {
  if (!finite(value) || !Number.isInteger(value) || value < 0 || value > ROOM_LIMITS.players)
    throw new Error(`A população mínima deve ser de 0 a ${ROOM_LIMITS.players} jogadores.`);
  return value;
}
export function readWorkerOptions(v: unknown): FieldWorkerOptions {
  if (!record(v)) throw new Error('Configuração do worker inválida.');
  const options: FieldWorkerOptions = {};
  if (v.testTools !== undefined) { if (typeof v.testTools !== 'boolean') throw new Error('Modo de testes inválido.'); options.testTools = v.testTools; }
  if (v.commanders !== undefined) options.commanders = readCommanderCount(v.commanders, options.testTools === true);
  if (v.commanderFill !== undefined) options.commanderFill = readCommanderFill(v.commanderFill);
  if (v.stress !== undefined) { if (typeof v.stress !== 'boolean' && !finite(v.stress)) throw new Error('Campo de carga inválido.'); options.stress = v.stress; }
  if (v.save !== undefined) {
    if (v.save === null) options.save = null;
    else { const save = v.save; if (!record(save) || typeof save.dir !== 'string' || save.seconds !== undefined && !finite(save.seconds)) throw new Error('Configuração de save inválida.'); options.save = { dir: save.dir, ...(save.seconds === undefined ? {} : { seconds: save.seconds }) }; }
  }
  if (v.rehearsal !== undefined) {
    if (v.rehearsal === null) options.rehearsal = null;
    else { const field = v.rehearsal, rehearsal: RehearsalField = {}; if (!record(field)) throw new Error('Campo de ensaio inválido.');
      if (field.bases !== undefined) { if (!Array.isArray(field.bases) || !field.bases.every(finite)) throw new Error('Bases de ensaio inválidas.'); rehearsal.bases = field.bases; }
      if (field.stock !== undefined) { if (!bill(field.stock)) throw new Error('Estoque de ensaio inválido.'); rehearsal.stock = field.stock; } options.rehearsal = rehearsal;
    }
  }
  if (options.commanders && (options.rehearsal || options.stress)) throw new Error('Comandantes de teste exigem um campo normal, com estoques e fabricação normais.');
  if (options.commanderFill !== undefined) {
    if (options.testTools || options.commanders !== undefined || options.rehearsal || options.stress)
      throw new Error('A população pública não pode ser combinada com testes, ensaio ou stress.');
    const dir = options.save?.dir;
    if (!dir || !isAbsolute(dir) || resolve(dir) === parse(resolve(dir)).root)
      throw new Error('A população pública exige uma pasta de save explícita, absoluta e própria do campo.');
  }
  return options;
}
export function readHostMessage(v: unknown): HostMessage {
  if (!record(v)) throw new Error('Mensagem de host inválida.');
  switch (v.type) {
    case 'ack': return { type: 'ack' };
    case 'save': if (v.done instanceof Int32Array) return { type: 'save', done: v.done }; break;
    case 'whole': if (strings(v.peerIds)) return { type: 'whole', peerIds: v.peerIds }; break;
    case 'disconnect': if (typeof v.peerId === 'string') return { type: 'disconnect', peerId: v.peerId }; break;
    case 'command': if (typeof v.peerId === 'string' && record(v.data) && typeof v.data.type === 'string' && (v.address === undefined || v.address === null || typeof v.address === 'string'))
      return { type: 'command', peerId: v.peerId, data: { ...v.data, type: v.data.type }, ...(v.address === undefined ? {} : { address: v.address }) }; break;
  }
  throw new Error('Mensagem de host inválida.');
}
export function readWorkerMessage(v: unknown): WorkerMessage {
  if (!record(v)) throw new Error('Resposta de worker inválida.');
  if (v.type === 'ready') return { type: 'ready' };
  if ((v.type === 'kick' || v.type === 'handled') && typeof v.peerId === 'string') return { type: v.type, peerId: v.peerId };
  if (v.type === 'direct' && typeof v.peerId === 'string' && record(v.payload)) return { type: 'direct', peerId: v.peerId, payload: v.payload };
  if (v.type === 'broadcast' && Array.isArray(v.frames)) {
    const frames = v.frames.map((raw: unknown): BroadcastFrame => { if (!record(raw) || !strings(raw.peers) || !(raw.buffer instanceof ArrayBuffer) || typeof raw.whole !== 'boolean') throw new Error('Frame de worker inválido.'); return { peers: raw.peers, buffer: raw.buffer, whole: raw.whole }; });
    return { type: 'broadcast', frames };
  }
  throw new Error('Resposta de worker inválida.');
}
