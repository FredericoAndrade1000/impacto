import { record } from './wire-shape.ts';

export const FIELD_SOCKET_PATH = '/world';
export const FIELD_STATUS_PATH = '/api/server-status';
export const FIELD_NETWORK_HEADER = 'impacto-network';
export const FIELD_CORE_HEADER = 'impacto-core';
export const DIRECTORY_PATH = '/servers';
export const DIRECTORY_LIMIT = 100;
export const DIRECTORY_LEASE_MS = 180_000;
export const DIRECTORY_BEAT_MS = 60_000;

export interface ServerVersions { network: number; core: number }
export interface ServerStatus extends ServerVersions { players: number; capacity: number }
export interface ServerAnnouncement extends ServerStatus {
  address: string; name: string; description: string; region: string; language: 'pt-BR' | 'en' | 'es'; field: string;
}
export interface ListedServer extends ServerAnnouncement { official: boolean }

export function fieldAddress(input: string): URL | null {
  try {
    if (input.length > 256 || /[\p{C}\\@?#]/u.test(input)) return null;
    const url = new URL(input.trim());
    if (!['https:', 'wss:'].includes(url.protocol) || !['/', FIELD_SOCKET_PATH].includes(url.pathname)) return null;
    url.protocol = 'wss:';
    url.pathname = FIELD_SOCKET_PATH;
    return url;
  } catch { return null; }
}

export function directoryURL(input: string, allowLocal = false): URL | null {
  try {
    const url = new URL(input);
    const local = allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url;
  } catch { return null; }
}

export const sameVersions = (a: ServerVersions, b: ServerVersions) => a.network === b.network && a.core === b.core;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export function readServerStatus(value: unknown): ServerStatus | null {
  if (!record(value) || !integer(value.network, 1, 1_000_000) || !integer(value.core, 1, 1_000_000) ||
    !integer(value.capacity, 1, 10_000) || !integer(value.players, 0, value.capacity)) return null;
  return { network: value.network, core: value.core, players: value.players, capacity: value.capacity };
}

function shortText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  return Array.from(value.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .slice(0, limit).join('');
}

export function readServerAnnouncement(value: unknown): ServerAnnouncement | null {
  const status = readServerStatus(value);
  if (!status || !record(value) || typeof value.address !== 'string') return null;
  const address = fieldAddress(value.address), name = shortText(value.name, 48), description = shortText(value.description, 140),
    region = shortText(value.region, 32), field = shortText(value.field, 40), language = value.language;
  if (!address || !name || description === null || !region || !field || language !== 'pt-BR' && language !== 'en' && language !== 'es') return null;
  return { ...status, address: address.href, name, description, region, field, language };
}
