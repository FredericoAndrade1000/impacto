import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPlayerEnvelope, readPlayerReply } from './contract.ts';
import type { PlayerRequest, PlayerReply } from './contract.ts';
import type { PlayerSession } from './session.ts';
import { record } from '../../src/wire-shape.ts';

const LIMIT = 2 * 1024 * 1024;
interface Endpoint { version: 1; socket: string; secret: string; pid: number }
export function playerSocket(directory: string) {
  const absolute = resolve(directory), identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\impacto-player-${key}` : join(absolute, 'player.sock');
}
function oneLine(socket: Socket, handler: (line: string) => void) {
  let text = '', count = 0, read = false;
  socket.setEncoding('utf8'); socket.on('error', () => {});
  socket.on('data', (data: string) => {
    if (read) return;
    count += Buffer.byteLength(data);
    if (count > LIMIT) { read = true; socket.destroy(new Error('Player message too large.')); return; }
    text += data; const end = text.indexOf('\n');
    if (end < 0) return;
    read = true;
    if (text.slice(end + 1).trim()) { socket.destroy(new Error('Only one player request per connection.')); return; }
    handler(text.slice(0, end));
  });
}
export async function servePlayer(session: PlayerSession) {
  const endpoint: Endpoint = { version: 1, socket: playerSocket(session.options.directory), secret: randomBytes(32).toString('hex'), pid: process.pid };
  const peers = new Set<Socket>();
  const server = createServer(socket => {
    const cancelled = new AbortController(); socket.on('close', () => cancelled.abort());
    peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.setTimeout(60000, () => socket.destroy());
    oneLine(socket, line => { void (async () => {
      let reply: PlayerReply;
      try {
        const envelope = readPlayerEnvelope(JSON.parse(line)), secret = Buffer.from(envelope.secret), expected = Buffer.from(endpoint.secret);
        if (secret.length !== expected.length || !timingSafeEqual(secret, expected)) throw new Error('Invalid player session secret.');
        reply = await session.request(envelope.request, envelope.id, cancelled.signal);
        socket.end(JSON.stringify(reply) + '\n');
        if (envelope.request.op === 'stop') server.close();
      } catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : String(error) }; socket.end(JSON.stringify(reply) + '\n'); }
    })(); });
  });
  server.maxConnections = 32;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(endpoint.socket, () => { server.off('error', reject); done(); }); });
  // Bind before connecting to the game: a second daemon for this directory
  // cannot steal its player seat. No HTTP listener or browser storage is used.
  try { writeFileSync(join(session.options.directory, 'connection.json'), JSON.stringify(endpoint), { mode: 0o600 }); }
  catch (error) { await new Promise<void>(done => server.close(() => done())); throw error; }
  return { async close() { try { session.close(); } finally {
    for (const peer of peers) peer.destroy();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
  } } };
}
function readEndpoint(directory: string): Endpoint {
  const value: unknown = JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8'));
  if (!record(value) || value.version !== 1 || value.socket !== playerSocket(directory) || typeof value.secret !== 'string' ||
    value.secret.length !== 64 || typeof value.pid !== 'number') throw new Error('Invalid player connection file.');
  return { version: 1, socket: value.socket, secret: value.secret, pid: value.pid };
}
export function callPlayer(directory: string, request: PlayerRequest, id: string = randomUUID()): Promise<PlayerReply> {
  const endpoint = readEndpoint(directory);
  return new Promise((done, reject) => {
    const socket = createConnection(endpoint.socket);
    socket.setTimeout(55000, () => socket.destroy(new Error('Local player tool timed out; check observe and reuse the same request ID.')));
    socket.on('error', reject);
    oneLine(socket, line => { try { done(readPlayerReply(JSON.parse(line))); } catch (error) { reject(error); } finally { socket.end(); } });
    socket.once('connect', () => socket.write(JSON.stringify({ id, secret: endpoint.secret, request }) + '\n'));
    socket.once('end', () => reject(new Error('Player bridge closed without an answer.')));
  });
}
