import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RoomRequest } from './room-contract.ts';
import type { FieldWorkerOptions, WorkerMessage } from './worker-contract.ts';
import { readWorkerMessage, readWorkerOptions } from './worker-contract.ts';
import type { ProxyTrust } from './network-address.ts';
import { localConnection, playerAddress, proxyTrust, secureConnection, trustedProxy } from './network-address.ts';
import { WORLD_LIMITS as LIMIT, TokenBucket, trafficBudget, retainedBudget, hasDesign, costly, readWorldRequest, worldDeflateOptions } from './network-limits.ts';
import { FIELD_SOCKET_PATH, FIELD_NETWORK_HEADER, FIELD_CORE_HEADER } from '../src/server-directory-contract.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { ROOM_LIMITS } from './room-limits.ts';
interface FieldWorker extends Worker { ready?: boolean; why?: string; pending: number }
interface FieldSocket extends WebSocket {
  joined?: boolean; behind?: boolean; field?: FieldWorker; address?: string; playerId?: string;
  pending: number; lastMessage: number; awaitingPong?: boolean;
}
type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
// Only the upgrade channel is consumed, including Vite's HTTP/2-compatible host.
export interface UpgradeServer {
  on(event: 'upgrade', listener: UpgradeListener): unknown;
  off(event: 'upgrade', listener: UpgradeListener): unknown;
  listenerCount(event: 'upgrade'): number;
}
export interface NetworkServerOptions extends FieldWorkerOptions {
  stamp?: (() => string | null) | null; perAddress?: boolean; entry?: () => URL; trust?: ProxyTrust; publicHost?: string;
  localHttpPeers?: ReadonlySet<string>; requireTLS?: boolean; telemetry?: boolean;
  clientOrigins?: ReadonlySet<string>;
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
import { Worker } from 'node:worker_threads';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ClientPerformanceReports, performanceLog } from './client-performance.ts';
import { checkTestSave } from './test-server.ts';
import { loadNativeHost } from '../scripts/native-dynamics-host.ts';

const INCOMPATIBLE = 'Esta página e o campo usam versões diferentes. Recarregue a página (F5). Se continuar, reinicie o servidor para aplicar a atualização.';
// What a player is told when the field cannot be started: why is for the log of the server.
const DOWN = 'O campo está fora do ar e não pôde ser retomado. Nenhum campo substituto foi criado. Sua chave foi mantida. Aguardando a recuperação do servidor.';
// A saved field that falls again this soon requires an explicit server restart; its checkpoint stays intact.
const FELL_AGAIN = 10 * 60_000;
const FLOOD = 'Mensagens demais em pouco tempo.';
const BUSY = 'O campo está ocupado. Tente de novo em instantes.';

// `rehearsal` ({ bases, stock }) opens a field to rehearse on instead of the game's;
// `stress` opens the stress field (see stress-field.ts): true for all of it, or the number of its factions to field. `stamp` reads what the server's code is
// on disk (build-stamp.ts): its startup stamp is the field's for the life of this server. A different
// page is refused until the page or server is restarted. `entry` names the worker of a field. `save` ({ dir, seconds })
// has the field kept in a directory, every so many seconds and whenever it is stopped,
// and a field that starts resumed from there (field-save.js): the game's field, not the stress one.
// `perAddress` has the field count its players by address (`playerAddress`), with two of each connected at a time and
// three new ones of each a day (room.ts), and the server limit sockets and traffic from each.
export function attachNetworkServer(httpServer: UpgradeServer, { rehearsal = null, stress = false, stamp = null, save = null, perAddress = false, testTools = false, commanders, commanderFill,
  trust = proxyTrust(), publicHost, localHttpPeers = new Set(), clientOrigins = new Set(), requireTLS = Boolean(publicHost), telemetry = true,
  entry = () => new URL('./physics-worker.ts', import.meta.url) }: NetworkServerOptions = {}) {
  readWorkerOptions({ rehearsal, stress, save, testTools, commanders, commanderFill });
  checkTestSave(testTools, save, Boolean(stress));
  // Keep the addon loaded in the HTTP host while worker isolates are replaced.
  // Loading/unloading it only in short-lived workers can crash Windows on a restart.
  // Invalid builds still follow the worker's normal boot-failure reporting path.
  try { loadNativeHost(); } catch { /* The worker reports its build refusal. */ }
  const sockets = new Map<string, FieldSocket>();
  const built = stamp?.() ?? null;
  // Only a field that fell is started again when somebody comes. Source edits take an explicit server restart.
  let recovering: Promise<void> | null = null, down = false, fellAt = -Infinity, recoveryBlocked = false, closed = false, worker: FieldWorker;
  const performanceReports = new ClientPerformanceReports(performanceLog(telemetry ? save?.dir : null), () => built);
  // ws checks maxPayload during inflate and again across fragments, before
  // delivering a message to the intake budget.
  const socketOptions = { noServer: true, maxPayload: LIMIT.payload, perMessageDeflate: LIMIT.deflate, autoPong: false,
    maxFragments: LIMIT.fragments, maxBufferedChunks: LIMIT.bufferedChunks, closeTimeout: LIMIT.closeMs };
  const wss = new WebSocketServer(socketOptions);
  const ready = () => worker.ready === true && !down && !closed;
  const allowedTransport = (request: IncomingMessage) => !requireTLS || secureConnection(request, trust) ||
    request.headers.host?.toLowerCase() !== publicHost && !trustedProxy(request, trust) && localConnection(request, localHttpPeers);
  wss.on('headers', headers => {
    if (ready()) headers.push(FIELD_NETWORK_HEADER + ': ' + NETWORK_VERSION, FIELD_CORE_HEADER + ': ' + CORE_CONTRACT);
  });
  const globalTraffic = trafficBudget(LIMIT.globalRate), globalOpen = new TokenBucket(LIMIT.openGlobal),
    globalCost = new TokenBucket(LIMIT.costlyGlobal),
    addresses = retainedBudget(() => ({ traffic: trafficBudget(LIMIT.addressRate), open: new TokenBucket(LIMIT.openPerAddress),
      cost: new TokenBucket(LIMIT.costlyPerAddress) })),
    seats = retainedBudget(() => new TokenBucket(LIMIT.costlyPerSeat));
  const send = (ws: FieldSocket, payload: object) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > LIMIT.directBuffer) { ws.close(1013, BUSY); return; }
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > LIMIT.directMessage) { ws.close(1013, BUSY); return; }
    ws.send(encoded);
  };
  const told = (message: WorkerMessage) => {
    if (message.type === 'broadcast') {
      // The field tells each faction a frame of its own: each goes to the sockets it names.
      // A frame builds on the one before it, so one a socket could not take cannot be made up for by
      // the next: a socket that far behind is told nothing more until it has caught up, and then a
      // whole state, which the field is asked for.
      const caught: string[] = [];
      for (const { peers, buffer, whole } of message.frames) {
        const room = Math.max(LIMIT.frameBuffer, LIMIT.frameBufferFactor * buffer.byteLength);
        for (const peerId of peers) {
          const ws = sockets.get(peerId);
          if (!ws?.joined || ws.readyState !== WebSocket.OPEN) continue;
          const ready = ws.bufferedAmount < room;
          if (!ws.behind) { if (ready) ws.send(buffer); else ws.behind = true; }
          else if (ready && whole) { ws.send(buffer); ws.behind = false; }
          else if (ready) caught.push(peerId);
        }
      }
      if (caught.length) worker.postMessage({ type: 'whole', peerIds: caught });
      worker.postMessage({ type: 'ack' });
    } else if (message.type === 'handled') {
      worker.pending--;
      const ws = sockets.get(message.peerId);
      if (ws?.field === worker) ws.pending--;
    } else if (message.type === 'kick') sockets.get(message.peerId)?.close(4001, 'Sua conta entrou em outro aparelho.');
    else if (message.type === 'direct') {
      const ws = sockets.get(message.peerId); if (ws?.readyState !== WebSocket.OPEN) return;
      if (message.payload.type === 'welcome') {
        ws.joined = true;
        if (typeof message.payload.playerId === 'string') ws.playerId = message.payload.playerId;
      }
      send(ws, message.payload);
    }
  };
  // A field is heard only while it is the one that runs. It falls when it stops, whether it threw or ended of itself: a
  // field that throws says why (`why`) and stops after, and it stops once. The pages on a field that fell are let go, and
  // it is started again when somebody comes. One that the server stops (`close`) did not fall.
  const start = () => {
    const field = Object.assign(new Worker(entry(), { workerData: { rehearsal, stress, save, testTools, commanders, commanderFill } }), { pending: 0 }) as FieldWorker;
    field.on('message', (raw: unknown) => { const message = readWorkerMessage(raw); if (message.type === 'ready') field.ready = true; if (field === worker) told(message); });
    field.on('error', error => { field.why = errorMessage(error); });
    field.on('exit', code => {
      if (field !== worker || closed) return;
      down = true;
      // A failed boot, or a saved field that repeatedly falls, needs an explicit server restart.
      // Keep the checkpoint and access keys; no automatic retry may replace them with a new field.
      if (!field.ready || save && Date.now() - fellAt < FELL_AGAIN) recoveryBlocked = true;
      if (save) fellAt = Date.now();
      console.error('Servidor físico:', field.why ?? `o campo parou sem dizer por quê (código ${code})`);
      for (const ws of sockets.values()) if (ws.field === field) ws.close(1011, 'O campo parou.');
    });
    return field;
  };
  worker = start();
  // Has the field that runs kept as it is now, and waits until it is: a worker that is terminated gets to do
  // nothing more, so it is asked before. False means writing failed, the field is down or its acknowledgement timed out.
  const flush = () => {
    if (!save) return true;
    if (down || closed) return false;
    const done = new Int32Array(new SharedArrayBuffer(4));
    worker.postMessage({ type: 'save', done });
    Atomics.wait(done, 0, 0, 5000);
    return Atomics.load(done, 0) === 1;
  };
  // A field that fell resumes what was last kept. It must still load the code this server started with:
  // a source edit cannot turn crash recovery into an update under the startup stamp.
  const recover = () => recovering ||= new Promise<void>((resolve, reject) => {
    if (recoveryBlocked) return reject(new Error('o campo precisa de revisão; reinicie o servidor após verificar os dados preservados'));
    if (stamp && stamp() !== built) return reject(new Error('o código mudou; reinicie o servidor para aplicar a atualização'));
    let field: FieldWorker;
    const refused = (error: unknown) => {
      recoveryBlocked = true;
      if (!closed) console.error('O campo está fora do ar e não pôde ser iniciado:', errorMessage(error));
      reject(error);
    };
    try { field = start(); } catch (error) { return refused(error); }
    const failed = (error: unknown) => { clearTimeout(timer); field.off('message', ready); field.off('exit', stopped); field.terminate(); refused(error); },
      stopped = (code: number) => failed(new Error(field.why ?? `o campo novo parou ao iniciar (código ${code})`)),
      ready = (raw: unknown) => {
        const message = readWorkerMessage(raw);
        if (message.type !== 'ready') return;
        if (closed) return failed(new Error('o servidor foi encerrado'));
        if (stamp && stamp() !== built) return failed(new Error('o código mudou; reinicie o servidor para aplicar a atualização'));
        clearTimeout(timer); field.off('message', ready); field.off('exit', stopped);
        worker = field; down = false; resolve();
      }, timer = setTimeout(() => failed(new Error('o campo novo demorou a iniciar')), LIMIT.bootMs);
    field.once('exit', stopped); field.on('message', ready);
  }).finally(() => { recovering = null; });
  // A page says which code it was served. The code the field runs: it comes in. Another: it is refused.
  // A page comes into the field that runs then, and only while its socket is open: one that closed while the field was
  // recovered for it is nobody's to bring in. A socket that leaves leaves the
  // field it came into (`connection`).
  const enqueue = (ws: FieldSocket, peerId: string, data: RoomRequest, opening = false) => {
    if (ws.readyState !== WebSocket.OPEN || down) return;
    if (worker.pending >= LIMIT.queuedGlobal || ws.pending >= LIMIT.queuedPerSocket) {
      if (opening) send(ws, { type: 'reply', error: BUSY, retryable: true });
      else if (data.request !== undefined) send(ws, { type: 'reply', request: data.request, error: BUSY });
      return;
    }
    if (!opening && ws.field !== worker) return;
    worker.postMessage({ type: 'command', peerId, data, ...(opening ? { address: ws.address ?? null } : {}) });
    if (opening) ws.field = worker;
    worker.pending++;
    ws.pending++;
  };
  const admit = (peerId: string, ws: FieldSocket, data: RoomRequest) => {
    const told = Boolean(stamp) && typeof data.build === 'string',
      enter = () => enqueue(ws, peerId, data, true),
      refuse = (error: string, retryable = false) => send(ws, { type: 'reply', error,
        ...(retryable ? { retryable: true } : { outdated: true }) });
    if (told && data.build !== built) return refuse(INCOMPATIBLE);
    if (!down) return enter();
    recover().then(enter, () => refuse(DOWN, true));
  };
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== FIELD_SOCKET_PATH) {
      // An upgrade nobody answers stays open, and a browser opens one WebSocket
      // to a server at a time: the field would wait behind it for minutes. The
      // client Vite injects asks for one of its own even with its server off.
      if (httpServer.listenerCount('upgrade') === 1) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const origin = request.headers.origin;
    try {
      if (origin && new URL(origin).host !== request.headers.host && !clientOrigins.has(origin)) { socket.destroy(); return; }
    } catch { socket.destroy(); return; }
    if (!allowedTransport(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const address = perAddress ? playerAddress(request, trust) : undefined, now = performance.now();
    let greeting = 0, sameAddress = 0;
    for (const ws of sockets.values()) {
      if (!ws.joined) greeting++;
      if (address !== undefined && ws.address === address) sameAddress++;
    }
    if (sockets.size >= LIMIT.sockets || greeting >= LIMIT.greetings || sameAddress >= LIMIT.socketsPerAddress ||
        address !== undefined && !addresses.get(address, now).open.take(now) || !globalOpen.take(now)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // With no asynchronous verifyClient, ws copies these options during this call.
    wss.options.perMessageDeflate = worldDeflateOptions(request.headers['sec-websocket-extensions'] ?? '');
    try {
      wss.handleUpgrade(request, socket, head, ws => {
        const peer: FieldSocket = Object.assign(ws, { pending: 0, lastMessage: now }, address === undefined ? {} : { address });
        wss.emit('connection', peer);
      });
    } finally {
      wss.options.perMessageDeflate = LIMIT.deflate;
    }
  };
  httpServer.on('upgrade', upgrade);
  wss.on('connection', (ws: FieldSocket) => {
    const peerId = randomUUID(), traffic = trafficBudget(LIMIT.socketRate), light = new TokenBucket(LIMIT.lightBytes),
      cost = new TokenBucket(LIMIT.costlyPerSocket), presence = new TokenBucket(LIMIT.presence), resync = new TokenBucket(LIMIT.resync);
    sockets.set(peerId, ws);
    let helloSent = false;
    const intake = (now: number, size: number) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      if (traffic(now, size) && (ws.address === undefined || addresses.get(ws.address, now).traffic(now, size)) && globalTraffic(now, size)) return true;
      ws.close(1008, FLOOD);
      return false;
    };
    ws.on('ping', data => {
      if (!intake(performance.now(), data.byteLength)) return;
      if (ws.bufferedAmount > LIMIT.directBuffer) ws.close(1013, BUSY);
      else ws.pong(data);
    });
    ws.on('pong', data => { if (intake(performance.now(), data.byteLength) && data.length === 0) ws.awaitingPong = false; });
    ws.on('message', (raw, binary) => {
      const now = performance.now(), size = Array.isArray(raw) ? raw.reduce((sum, bytes) => sum + bytes.byteLength, 0) : raw.byteLength;
      if (!intake(now, size)) return;
      if (binary) { ws.close(1003, 'Envie comandos em texto.'); return; }
      try {
        const data = readWorldRequest(raw.toString());
        if (!hasDesign(data) && (size > LIMIT.lightPayload || !light.take(now, size))) { ws.close(1008, FLOOD); return; }
        if (data.type === 'hello') {
          if (helloSent) { ws.close(1008, 'A entrada no campo já foi solicitada.'); return; }
          helloSent = true;
          admit(peerId, ws, data);
          return;
        }
        if (!testTools && (data.type === 'test' || data.instant === true)) {
          send(ws, { type: 'reply', request: data.request, error: data.type === 'test'
            ? 'Ferramentas de testes indisponíveis neste servidor.' : 'Fabricação instantânea indisponível neste servidor.' });
          return;
        }
        if (!ws.joined) {
          if (data.type !== 'performance') ws.close(1008, 'Entre no campo primeiro.');
          return;
        }
        ws.lastMessage = now;
        if (data.type === 'performance') { performanceReports.receive(ws, data, size); return; }
        if (data.type === 'resync' && !resync.take(now) || data.type === 'ping' && !presence.take(now)) return;
        if (costly(data) && (!cost.take(now) || ws.address !== undefined && !addresses.get(ws.address, now).cost.take(now) ||
            ws.playerId !== undefined && !seats.get(ws.playerId, now).take(now) || !globalCost.take(now))) {
          if (data.request !== undefined) send(ws, { type: 'reply', request: data.request, error: BUSY });
          return;
        }
        enqueue(ws, peerId, data);
      } catch {
        send(ws, { type: 'reply', error: 'Mensagem inválida.' });
        ws.close(1008, 'Mensagem inválida.');
      }
    });
    let greetingTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN || ws.joined) return;
      const expire = () => { if (!ws.joined) ws.close(1008, 'Entre no campo primeiro.'); };
      if (helloSent && (recovering || !worker.ready)) greetingTimer = setTimeout(expire, LIMIT.bootMs - LIMIT.greetingMs).unref();
      else expire();
    }, LIMIT.greetingMs).unref();
    ws.on('close', () => {
      clearTimeout(greetingTimer);
      sockets.delete(peerId);
      ws.field?.postMessage({ type: 'disconnect', peerId });
    });
    ws.on('error', () => {});
  });
  const heartbeat = setInterval(() => {
    const now = performance.now();
    addresses.prune(now); seats.prune(now);
    for (const ws of sockets.values()) {
      if (ws.readyState !== WebSocket.OPEN || !ws.joined) continue;
      if (now - ws.lastMessage >= LIMIT.idleMs) ws.close(1001, 'Conexão inativa.');
      else if (ws.awaitingPong) ws.terminate();
      else if (ws.bufferedAmount > LIMIT.directBuffer) continue;
      else { ws.awaitingPong = true; ws.ping(); }
    }
  }, LIMIT.heartbeatMs).unref();
  return {
    build: built,
    allowedTransport,
    status() {
      if (!ready()) return null;
      const players = new Set([...sockets.values()].filter(ws => ws.joined && ws.readyState === WebSocket.OPEN).map(ws => ws.playerId));
      return { network: NETWORK_VERSION, core: CORE_CONTRACT, players: players.size, capacity: ROOM_LIMITS.players };
    },
    addresses(port: number) { return Object.values(networkInterfaces()).flatMap(addresses => (addresses ?? []).filter(a => a.family === 'IPv4' && !a.internal)).map(a => `http://${a.address}:${port}/`); },
    flush,
    async close() { clearInterval(heartbeat); httpServer.off('upgrade', upgrade); for (const ws of sockets.values()) ws.close(1001, 'Servidor encerrado.'); wss.close(); const saved = flush(); closed = true; await worker.terminate(); await recovering?.catch(() => {}); await performanceReports.close(); return saved; },
  };
}
