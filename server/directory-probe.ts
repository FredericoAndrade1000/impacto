import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { FIELD_CORE_HEADER, FIELD_NETWORK_HEADER, type ServerVersions } from '../src/server-directory-contract.ts';

const reserved = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) reserved.addSubnet(address, bits);
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  reserved.addSubnet(address, bits, 'ipv6');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

export function publicProbeIP(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !reserved.check(address);
  return family === 6 && globalIPv6.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
}

// Exercise the game's real upgrade without sending hello, cookies or the registry key.
// Resolve once and connect to an approved address while preserving the TLS hostname.
export async function probeWorld(address: URL): Promise<ServerVersions | null> {
  const signal = AbortSignal.timeout(4_000);
  const url = new URL(address.href);
  url.protocol = 'https:';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  const peer = addresses.find(ip => ip.family === 4) ?? addresses[0];
  if (signal.aborted || !peer || addresses.some(ip => !publicProbeIP(ip.address))) return null;
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  return new Promise(resolve => {
    const probe = request(url, {
      agent: false, family: peer.family, signal, rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, peer.address, peer.family),
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
      maxHeaderSize: 8_192,
    });
    probe.on('upgrade', (response, socket) => {
      socket.destroy();
      const { headers } = response;
      if (response.statusCode !== 101 || headers.upgrade?.toLowerCase() !== 'websocket' ||
        headers['sec-websocket-accept'] !== accept) return resolve(null);
      const network = Number(headers[FIELD_NETWORK_HEADER]), core = Number(headers[FIELD_CORE_HEADER]);
      resolve(Number.isSafeInteger(network) && network > 0 && Number.isSafeInteger(core) && core > 0 ? { network, core } : null);
    });
    probe.on('response', response => { response.destroy(); resolve(null); });
    probe.on('error', () => resolve(null));
    probe.end();
  });
}
