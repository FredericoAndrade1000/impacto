import { createServer } from 'node:http';
import WebSocket from 'ws';
import { attachNetworkServer } from '../../server/network-server.ts';

// An ephemeral HTTP server and its field. Each test owns the socket protocol and its expectations;
// this owns only transport setup and teardown, including sockets left by a failed expectation.
export async function serveNetwork(t, options = {}) {
  const server = createServer((_req, res) => res.end('ok')), room = attachNetworkServer(server, options), sockets = [];
  let closing;
  const close = () => closing ||= (async () => {
    await room.close();
    for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) {
      if (ws.readyState === WebSocket.CONNECTING) ws.once('error', () => {});
      ws.terminate();
    }
    await new Promise(resolve => server.close(resolve));
  })();
  t.after(close);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/world`, socket = (...args) => {
    const ws = new WebSocket(...(args.length ? args : [url])); sockets.push(ws); return ws;
  };
  return { url, socket, close };
}
