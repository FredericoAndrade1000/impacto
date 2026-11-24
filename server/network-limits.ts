import { ROOM_LIMITS } from './room-limits.ts';
import type { RoomRequest } from './room-contract.ts';
import { commandResultGuards } from '../src/field-protocol-codec.ts';
import { TokenBucket } from './request-budget.ts';
export { TokenBucket, retainedBudget } from './request-budget.ts';

const KiB = 1024;
export const WORLD_LIMITS = {
  sockets: 2 * ROOM_LIMITS.players + 24, socketsPerAddress: 4, greetings: 24,
  greetingMs: 5_000, bootMs: 30_000, idleMs: 180_000, heartbeatMs: 30_000, closeMs: 5_000,
  payload: 64 * KiB, lightPayload: 8 * KiB, fragments: 64, bufferedChunks: 256,
  deflate: {
    serverNoContextTakeover: true, clientNoContextTakeover: true,
    serverMaxWindowBits: 12, clientMaxWindowBits: 12, concurrencyLimit: 4, threshold: 256,
    zlibDeflateOptions: { level: 1, memLevel: 7 }, zlibInflateOptions: { chunkSize: 4 * KiB },
  },
  depth: 16, values: 16_000, properties: 128, arrayLength: 1024, keyLength: 128, helloFieldLength: 256, libraryIdLength: 128,
  socketRate: { messages: [48, 96], bytes: [128 * KiB, 128 * KiB] },
  addressRate: { messages: [128, 192], bytes: [256 * KiB, 256 * KiB] },
  globalRate: { messages: [2048, 3072], bytes: [2 * 1024 * KiB, 2 * 1024 * KiB] },
  lightBytes: [16 * KiB, 16 * KiB], presence: [6, 12], resync: [1, 2],
  openPerAddress: [8, 12], openGlobal: [64, 96],
  costlyPerSocket: [2, 4], costlyPerAddress: [4, 8], costlyPerSeat: [2, 4], costlyGlobal: [16, 32],
  queuedPerSocket: 64, queuedGlobal: 512, directBuffer: 2 * 1024 * KiB, directMessage: 8 * 1024 * KiB,
  frameBuffer: 2_000_000, frameBufferFactor: 3,
} as const;

export function worldDeflateOptions(extensions: string) {
  const limits = WORLD_LIMITS.deflate;
  const offer = extensions.split(',').find(value => /^\s*permessage-deflate\s*(?:;|$)/.test(value));
  if (!offer) return limits;
  // Let ws validate the offer. The peer has to advertise client_max_window_bits
  // before we can send it back (RFC 7692); Firefox uses the 32 KiB default.
  const client = /;\s*client_max_window_bits(?:\s*=\s*"?(\d+)"?)?\s*(?=;|$)/.exec(offer),
    server = /;\s*server_max_window_bits\s*=\s*"?(\d+)"?\s*(?=;|$)/.exec(offer);
  return { ...limits,
    clientMaxWindowBits: client ? Math.min(limits.clientMaxWindowBits, Number(client[1] ?? Infinity)) : undefined,
    serverMaxWindowBits: Math.min(limits.serverMaxWindowBits, Number(server?.[1] ?? Infinity)) };
}

export function trafficBudget({ messages, bytes }: { messages: readonly [number, number]; bytes: readonly [number, number] }) {
  const count = new TokenBucket(messages), volume = new TokenBucket(bytes);
  return (now: number, size: number) => count.take(now) && volume.take(now, size);
}


export const hasDesign = (data: RoomRequest) => data.type === 'spawn' || data.type === 'replace' || data.type === 'library' && data.act === 'publish';
export const costly = (data: RoomRequest) => hasDesign(data) ||
  ['blueprint', 'library', 'relocate', 'post', 'road', 'recover', 'leave-faction'].includes(data.type) ||
  data.type === 'member' && data.act === 'remove' || data.type === 'test' && (data.act === 'spawn' || data.act === 'list');
export function readWorldRequest(source: string): RoomRequest {
  const data: unknown = JSON.parse(source);
  const invalid = () => { throw new Error('Mensagem inválida.'); };
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !('type' in data) || typeof data.type !== 'string') return invalid();
  const request: RoomRequest = { ...data, type: data.type };
  if (!Object.hasOwn(commandResultGuards, request.type) && !['hello', 'performance', 'ping', 'resync'].includes(request.type)) return invalid();
  if (request.request !== undefined && (typeof request.request !== 'number' || !Number.isSafeInteger(request.request) || request.request < 0)) return invalid();
  if (request.type === 'hello' && (!Number.isSafeInteger(request.version) ||
      ![request.name, request.token, request.build].every(value => value == null || typeof value === 'string' && value.length <= WORLD_LIMITS.helloFieldLength))) return invalid();
  if (request.type === 'ping' && request.time !== undefined && typeof request.time !== 'number') return invalid();
  if (hasDesign(request) && (request.blueprint === null || typeof request.blueprint !== 'object' || Array.isArray(request.blueprint))) return invalid();
  if (request.type === 'library' && request.act === 'get' &&
      (!Array.isArray(request.ids) || request.ids.length > ROOM_LIMITS.library ||
      !request.ids.every(id => typeof id === 'string' && id.length <= WORLD_LIMITS.libraryIdLength))) return invalid();

  let remaining = WORLD_LIMITS.values;
  function bounded(value: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > WORLD_LIMITS.depth) return false;
    if (Array.isArray(value)) return value.length <= WORLD_LIMITS.arrayLength && value.every(item => bounded(item, depth + 1));
    if (typeof value === 'number') return Number.isFinite(value);
    if (value === null || typeof value !== 'object') return true;
    const entries = Object.entries(value);
    return entries.length <= WORLD_LIMITS.properties && entries.every(([key, item]) =>
      key !== '__proto__' && key.length <= WORLD_LIMITS.keyLength && bounded(item, depth + 1));
  }
  if (!bounded(request, 0)) return invalid();
  return request;
}
