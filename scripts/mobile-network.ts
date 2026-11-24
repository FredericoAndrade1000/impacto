// Local TCP shaper for benchmark HTTP and WebSockets, including compressed frames. No game/protocol changes.
import net from 'node:net';

export interface NetworkCondition { downloadBytesPerSecond: number; uploadBytesPerSecond: number; rttMs: number }
interface DirectionMetrics { bytes: number; queued: number; peakQueued: number }
interface Flow { from: net.Socket; to: net.Socket; pending: number; ended: boolean }

class Direction {
  declare rate: number; declare delay: number; declare metrics: DirectionMetrics;
  declare queue: { flow: Flow; data: Buffer; ready: number }[];
  declare next: number; declare timer: ReturnType<typeof setTimeout> | null;
  declare closed: boolean; declare blocked: boolean; declare cancelDrain: (() => void) | null | undefined;
  constructor(bytesPerSecond: number, delayMs: number, metrics: DirectionMetrics) {
    this.rate = bytesPerSecond; this.delay = delayMs; this.metrics = metrics;
    this.queue = []; this.next = performance.now(); this.timer = null; this.closed = false; this.blocked = false;
  }
  send(flow: Flow, bytes: Buffer): void {
    const ready = performance.now() + this.delay;
    for (let start = 0; start < bytes.length; start += 16384) {
      const data = bytes.subarray(start, start + 16384); this.queue.push({ flow, data, ready }); flow.pending += data.length;
    }
    this.metrics.queued += bytes.length; this.metrics.peakQueued = Math.max(this.metrics.peakQueued, this.metrics.queued);
    if (flow.pending >= 1024 * 1024) flow.from.pause();
    this.pump();
  }
  pump(): void {
    if (this.closed || this.timer || this.blocked || !this.queue.length) return;
    const item = this.queue.shift();
    if (!item) return;
    const { flow, data } = item;
    if (flow.to.destroyed || flow.from.destroyed && !flow.ended) { this.finished(flow, data.length); this.pump(); return; }
    this.next = Math.max(performance.now(), this.next, item.ready) + data.length * 1000 / this.rate;
    this.timer = setTimeout(() => {
      this.timer = null;
      let ready = true;
      if (!flow.to.destroyed) { ready = flow.to.write(data); this.metrics.bytes += data.length; }
      this.finished(flow, data.length);
      if (!ready && !flow.to.destroyed) {
        this.blocked = true;
        const wake = () => { this.cancelDrain?.(); this.pump(); };
        this.cancelDrain = () => { flow.to.off('drain',wake); flow.to.off('close',wake); this.blocked=false; this.cancelDrain=null; };
        flow.to.once('drain',wake); flow.to.once('close',wake);
      } else this.pump();
    }, Math.max(0, this.next - performance.now()));
  }
  finished(flow: Flow, count: number): void {
    flow.pending -= count; this.metrics.queued -= count;
    if (flow.pending < 1024 * 1024 && !flow.from.destroyed) flow.from.resume();
    if (flow.ended && !flow.pending && !flow.to.destroyed) flow.to.end();
  }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.cancelDrain?.(); this.queue.length = 0; }
}

export async function mobileNetwork({ targetPort, port = 0, downloadBytesPerSecond, uploadBytesPerSecond, rttMs }: NetworkCondition & { targetPort: number; port?: number }) {
  if (![targetPort, port].every(n => Number.isInteger(n) && n >= 0 && n <= 65535) || !targetPort ||
      ![downloadBytesPerSecond, uploadBytesPerSecond].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(rttMs) || rttMs < 0)
    throw new Error('Portas, banda ou latência inválidas.');
  const metrics = { download: { bytes: 0, queued: 0, peakQueued: 0 }, upload: { bytes: 0, queued: 0, peakQueued: 0 } },
    down = new Direction(downloadBytesPerSecond, rttMs / 2, metrics.download), up = new Direction(uploadBytesPerSecond, rttMs / 2, metrics.upload), sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, client => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true });
    sockets.add(client); sockets.add(upstream); client.setNoDelay(); upstream.setNoDelay();
    const forward = (from: net.Socket, to: net.Socket, direction: Direction): void => {
      const flow = { from, to, pending: 0, ended: false };
      from.on('data', bytes => direction.send(flow, bytes));
      from.on('end', () => { flow.ended = true; if (!flow.pending && !to.destroyed) to.end(); });
      from.on('error', () => to.destroy()); from.on('close', () => { sockets.delete(from); if (!flow.ended) to.destroy(); });
    };
    forward(client, upstream, up); forward(upstream, client, down);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy sem endereço TCP.');
  return { port: address.port, metrics, async close() {
    up.close(); down.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
