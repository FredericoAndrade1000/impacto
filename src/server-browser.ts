import { CORE_CONTRACT } from './native-dynamics.ts';
import { NETWORK_VERSION } from './network-protocol.ts';
import { DIRECTORY_LIMIT, DIRECTORY_PATH, FIELD_SOCKET_PATH, FIELD_STATUS_PATH, directoryURL, fieldAddress, readServerAnnouncement, readServerStatus,
  sameVersions, type ListedServer, type ServerVersions } from './server-directory-contract.ts';
import { record } from './wire-shape.ts';
import { DEFAULT_SOURCE_URL, sourceURL } from './source-url.ts';

export const compatible = (server: ServerVersions) => sameVersions(server, { network: NETWORK_VERSION, core: CORE_CONTRACT });
export const pageField = (location: Pick<Location, 'protocol' | 'host'>) =>
  new URL((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + FIELD_SOCKET_PATH);
export const serverHttpOrigin = (address: URL) => (address.protocol === 'wss:' ? 'https:' : 'http:') + '//' + address.host;
const LAST = 'impacto.last-server';
export function rememberServer(address: URL) { try { localStorage.setItem(LAST, address.href); } catch {} }
export function lastServer(local: URL): URL | null {
  try {
    const kept = localStorage.getItem(LAST);
    return kept === local.href ? local : kept ? fieldAddress(kept) : null;
  } catch { return null; }
}

async function serverJSON(url: string | URL, signal: AbortSignal, limit: number, cache: RequestCache = 'no-store'): Promise<unknown> {
  const response = await fetch(url, { cache, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]) });
  if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Response too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally { void reader.cancel().catch(() => {}); }
}

export async function loadServerList(signal: AbortSignal, allowLocal = false, showSource?: (url: string) => void) {
  const config = await serverJSON('/api/server-directory', signal, 2_048);
  if (!record(config)) throw new Error('Invalid directory configuration');
  if (!signal.aborted) showSource?.(sourceURL(config.source) ?? DEFAULT_SOURCE_URL);
  const official = typeof config.official === 'string' ? fieldAddress(config.official)?.href : undefined;
  const url = typeof config.directory === 'string' ? directoryURL(config.directory, allowLocal) : null;
  if (!url) return { state: 'disabled' as const, official, servers: [] as ListedServer[] };
  try {
    const raw = await serverJSON(new URL(DIRECTORY_PATH, url), signal, 256_000, 'default');
    if (!record(raw) || !Array.isArray(raw.servers) || raw.servers.length > DIRECTORY_LIMIT) throw new Error('Invalid directory list');
    const servers = new Map<string, ListedServer>();
    for (const row of raw.servers) {
      const server = readServerAnnouncement(row);
      if (server) servers.set(server.address, { ...server, official: server.address === official });
    }
    return { state: 'loaded' as const, official, servers: [...servers.values()] };
  } catch { return { state: 'offline' as const, official, servers: [] as ListedServer[] }; }
}

export async function measureServer(address: URL, signal: AbortSignal) {
  const started = performance.now();
  const status = readServerStatus(await serverJSON(serverHttpOrigin(address) + FIELD_STATUS_PATH, signal, 2_048));
  if (!status) throw new Error('Invalid server status');
  return { ...status, ping: Math.round(performance.now() - started) };
}

export function typedServer(address: string) {
  const input = address.trim();
  return fieldAddress(input.includes('://') ? input : 'wss://' + input);
}

export async function checkServerEntry(target: URL | null, local: URL, signal: AbortSignal) {
  if (!target) return 'invalid';
  if (target.href === local.href) return 'compatible';
  try { return compatible(await measureServer(target, signal)) ? 'compatible' : 'incompatible'; }
  catch { return 'unavailable'; }
}
