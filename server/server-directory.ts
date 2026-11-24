import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DIRECTORY_LEASE_MS, DIRECTORY_LIMIT, DIRECTORY_PATH, readServerAnnouncement, sameVersions,
  type ListedServer, type ServerVersions } from '../src/server-directory-contract.ts';
import { playerAddress, proxyTrust, type ProxyTrust } from './network-address.ts';
import { probeWorld } from './directory-probe.ts';
import { retainedBudget, TokenBucket } from './request-budget.ts';

export const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
export const keyDigestFile = (address: string): string => digest(address).toString('hex') + '.sha256';
const KEY = /^Bearer ([\w-]{43})$/;
const BODY_LIMIT = 4_096;

interface DirectoryOptions {
  readKey: (address: string) => Buffer | undefined;
  official?: string;
  origins?: ReadonlySet<string>;
  trust?: ProxyTrust;
  now?: () => number;
  probe?: (address: URL) => Promise<ServerVersions | null>;
}

function send(response: ServerResponse, status: number, body: object | null): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  response.end(body === null ? undefined : JSON.stringify(body));
}

async function readAnnouncement(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > BODY_LIMIT) return null;
    chunks.push(chunk);
  }
  try { return readServerAnnouncement(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { return null; }
}

export function createDirectory({ readKey, official, origins = new Set(), trust = proxyTrust(),
  now = () => performance.now(), probe = probeWorld }: DirectoryOptions) {
  const live = new Map<string, { server: ListedServer; until: number }>();
  const queries = new TokenBucket([80, 120]), announcements = new TokenBucket([16, 24]);
  const clients = retainedBudget(() => ({ read: new TokenBucket([2, 12]), write: new TokenBucket([1, 8]) }));
  const keys = retainedBudget(() => new TokenBucket([1 / 20, 2])), checking = new Set<string>();
  let pending = 0;
  const prune = (time: number) => {
    for (const [address, lease] of live) if (lease.until <= time) live.delete(address);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const time = now();
    response.setHeader('Cache-Control', 'no-store');
    if (request.url !== DIRECTORY_PATH) return send(response, 404, { error: 'not-found' });
    const origin = request.headers.origin;
    response.setHeader('Vary', 'Origin');
    if (request.method === 'GET' && origin && origins.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      return send(response, 405, { error: 'method' });
    }
    const refused = () => {
      response.setHeader('Retry-After', request.method === 'GET' ? '1' : '20');
      return send(response, 429, { error: 'rate' });
    };
    const client = clients.get(playerAddress(request, trust), time);
    prune(time);
    if (request.method === 'GET') {
      if (!queries.take(time) || !client.read.take(time)) return refused();
      const servers = [...live.values()].map(lease => lease.server).sort((a, b) =>
        Number(b.official) - Number(a.official) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
      response.setHeader('Cache-Control', 'public, max-age=10');
      return send(response, 200, { servers });
    }
    if (!announcements.take(time) || !client.write.take(time) || pending >= 16) return refused();
    const key = KEY.exec(request.headers.authorization ?? '')?.[1];
    if (!key) return send(response, 401, { error: 'key' });
    if (request.headers['content-type'] !== 'application/json' || Number(request.headers['content-length']) > BODY_LIMIT)
      return send(response, 400, { error: 'announcement' });
    pending++;
    let address: string | undefined;
    try {
      const server = await readAnnouncement(request);
      if (!server) { response.setHeader('Connection', 'close'); return send(response, 400, { error: 'announcement' }); }
      const expected = readKey(server.address);
      if (!expected || !timingSafeEqual(digest(key), expected)) return send(response, 401, { error: 'key' });
      const officialEntry = server.address === official;
      if (checking.has(server.address) || !keys.get(server.address, now()).take(now()) ||
        !officialEntry && !live.has(server.address) && live.size + checking.size >= DIRECTORY_LIMIT - 1) return refused();
      address = server.address;
      checking.add(address);
      const versions = await probe(new URL(address)).catch(() => null);
      if (!versions || !sameVersions(server, versions)) {
        live.delete(address);
        return send(response, 422, { error: 'unverified' });
      }
      live.set(address, { server: { ...server, official: officialEntry }, until: now() + DIRECTORY_LEASE_MS });
      send(response, 204, null);
    } finally {
      if (address) checking.delete(address);
      pending--;
    }
  };
  const server = createServer({ requestTimeout: 6_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000,
    keepAliveTimeout: 5_000, maxHeaderSize: 8_192 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.destroyed && !response.headersSent) send(response, 500, { error: 'internal' });
    });
  });
  server.maxConnections = 256;
  server.setTimeout(6_000, socket => socket.destroy());
  const maintenance = setInterval(() => { const time = now(); prune(time); clients.prune(time); keys.prune(time); }, 30_000).unref();
  server.on('close', () => clearInterval(maintenance));
  return server;
}
