import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';

type AddressRequest = Pick<IncomingMessage, 'socket' | 'headers'>;
export interface ProxyTrust {
  peers: ReadonlySet<string>;
  header: 'cf-connecting-ip' | 'x-forwarded-for';
}

function ip(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const address = value.trim(), family = isIP(address);
  if (family === 4) return address;
  if (family !== 6 || address.includes('%')) return;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  if (!canonical.startsWith('::ffff:')) return canonical;
  const [high = 0, low = 0] = canonical.slice(7).split(':').map(group => parseInt(group, 16));
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function peerIPs(list: string, variable: string): ReadonlySet<string> {
  const peers = new Set<string>();
  for (const entry of list.trim() ? list.split(',') : []) {
    const address = ip(entry);
    if (!address) throw new Error(`${variable} deve conter somente endereços IP separados por vírgula.`);
    peers.add(address);
  }
  return peers;
}

export function proxyTrust(list = '', header = 'x-forwarded-for'): ProxyTrust {
  if (header !== 'cf-connecting-ip' && header !== 'x-forwarded-for')
    throw new Error('IMPACTO_PROXY_IP_HEADER deve ser cf-connecting-ip ou x-forwarded-for.');
  return { peers: peerIPs(list, 'IMPACTO_TRUSTED_PROXIES'), header };
}

const socketIP = ({ socket }: AddressRequest) => ip(socket.remoteAddress?.split('%')[0]);
export function trustedProxy(request: AddressRequest, trust: ProxyTrust): boolean {
  const peer = socketIP(request);
  return peer !== undefined && trust.peers.has(peer);
}

export function secureConnection(request: AddressRequest, trust: ProxyTrust): boolean {
  return request.socket instanceof TLSSocket && request.socket.encrypted ||
    trustedProxy(request, trust) && request.headers['x-forwarded-proto'] === 'https';
}

export function localConnection(request: AddressRequest, peers: ReadonlySet<string>): boolean {
  const ip = socketIP(request);
  return ip !== undefined && (ip === '::1' || ip.startsWith('127.') || peers.has(ip));
}

export function playerAddress(request: AddressRequest, trust: ProxyTrust): string {
  const peer = socketIP(request);
  if (!peer) return 'unknown';
  let address = peer;
  const forwarded = request.headers[trust.header];
  if (trust.peers.has(peer) && typeof forwarded === 'string') {
    if (trust.header === 'cf-connecting-ip') address = ip(forwarded) ?? peer;
    else {
      // A trusted hop appends the address it observed. Stop at the first hop
      // outside the trust list, leaving any client-supplied prefix unread.
      for (const entry of forwarded.split(',').reverse()) {
        const hop = ip(entry);
        if (!hop) { address = peer; break; }
        if (!trust.peers.has(hop)) { address = hop; break; }
      }
    }
  }
  if (isIP(address) !== 6) return address;
  const [head, tail] = address.split('::'), front = head ? head.split(':') : [], back = tail ? tail.split(':') : [];
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill('0'), ...back];
  return groups.slice(0, 4).join(':') + '::/64';
}
