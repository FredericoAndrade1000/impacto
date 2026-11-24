import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { mobileNetwork } from '../scripts/mobile-network.ts';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('mobile link shapes combined TCP traffic, preserves bytes and supports half close', async () => {
  const payload = randomBytes(96 * 1024), server = net.createServer({ allowHalfOpen: true }, socket => {
    const chunks = []; socket.on('data', data => chunks.push(data)); socket.on('end', () => socket.end(Buffer.concat(chunks)));
  });
  await listen(server);
  const rate = 1024 * 1024, link = await mobileNetwork({ targetPort: server.address().port, downloadBytesPerSecond: rate, uploadBytesPerSecond: rate, rttMs: 20 });
  try {
    const start = performance.now();
    await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
      const socket = net.connect({ port: link.port, host: '127.0.0.1' }), chunks = [];
      socket.on('connect', () => socket.end(payload)); socket.on('data', data => chunks.push(data)); socket.on('error', reject);
      socket.on('end', () => { try { assert.deepEqual(Buffer.concat(chunks), payload); resolve(); } catch (error) { reject(error); } });
    })));
    assert(performance.now() - start >= payload.length * 2 * 1000 / rate, 'both connections share the directional link capacity');
    assert.equal(link.metrics.upload.bytes, payload.length * 2); assert.equal(link.metrics.download.bytes, payload.length * 2);
    assert.equal(link.metrics.upload.queued, 0); assert.equal(link.metrics.download.queued, 0);
  } finally { await link.close(); await close(server); }
});

test('compressed WebSockets and latency traverse the same byte shaper without changing the protocol', async () => {
  const server = http.createServer(), wss = new WebSocketServer({ server, perMessageDeflate: true });
  wss.on('connection', socket => socket.on('message', (bytes, binary) => socket.send(bytes, { binary })));
  await listen(server);
  const link = await mobileNetwork({ targetPort: server.address().port, downloadBytesPerSecond: 128 * 1024, uploadBytesPerSecond: 128 * 1024, rttMs: 40 });
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${link.port}`, { perMessageDeflate: true });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    assert.equal(socket.extensions, 'permessage-deflate');
    const payload = randomBytes(48 * 1024), began = performance.now();
    const reply = new Promise((resolve, reject) => { socket.once('message', resolve); socket.once('error', reject); });
    socket.send(payload); assert.deepEqual(await reply, payload);
    assert(performance.now() - began >= 700, 'incompressible data pays the upload and download bandwidth limits');
    assert(link.metrics.upload.bytes > payload.length && link.metrics.download.bytes > payload.length);
  } finally { socket?.terminate(); await link.close(); for (const peer of wss.clients) peer.terminate(); await new Promise(resolve => wss.close(resolve)); await close(server); }
});
