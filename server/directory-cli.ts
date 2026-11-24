import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldAddress } from '../src/server-directory-contract.ts';
import { proxyTrust } from './network-address.ts';
import { createDirectory, digest, keyDigestFile } from './server-directory.ts';
import { readHttpsOrigins } from './server-origins.ts';

const store = process.env.IMPACTO_DIRECTORY_DATA ?? './directory-data';
const [command, input, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Use serve, register <wss://host/world> ou revoke <wss://host/world>.');
if (command === 'register' || command === 'revoke') {
  const address = input && fieldAddress(input);
  if (!address) throw new Error('Informe o endereço WSS público do campo.');
  const file = join(store, keyDigestFile(address.href));
  if (command === 'revoke') rmSync(file);
  else {
    mkdirSync(store, { recursive: true, mode: 0o700 });
    const key = randomBytes(32).toString('base64url'), temp = join(store, randomBytes(16).toString('hex') + '.tmp');
    writeFileSync(temp, digest(key).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    try { linkSync(temp, file); }
    finally { rmSync(temp); }
    console.log(key);
  }
} else if (command === 'serve' && input === undefined) {
  const { IMPACTO_OFFICIAL_SERVER, IMPACTO_DIRECTORY_PORT = '8080', IMPACTO_DIRECTORY_HOST = '127.0.0.1',
    IMPACTO_DIRECTORY_ORIGINS, IMPACTO_DIRECTORY_TRUSTED_PROXIES, IMPACTO_DIRECTORY_PROXY_IP_HEADER } = process.env;
  const official = IMPACTO_OFFICIAL_SERVER ? fieldAddress(IMPACTO_OFFICIAL_SERVER) : null;
  if (IMPACTO_OFFICIAL_SERVER && !official) throw new Error('IMPACTO_OFFICIAL_SERVER deve ser um endereço WSS público.');
  const port = Number(IMPACTO_DIRECTORY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('IMPACTO_DIRECTORY_PORT inválida.');
  const server = createDirectory({
    ...(official ? { official: official.href } : {}),
    origins: readHttpsOrigins(IMPACTO_DIRECTORY_ORIGINS),
    trust: proxyTrust(IMPACTO_DIRECTORY_TRUSTED_PROXIES, IMPACTO_DIRECTORY_PROXY_IP_HEADER),
    readKey(address) {
      try {
        const hash = readFileSync(join(store, keyDigestFile(address)), 'utf8').trim();
        return /^[a-f0-9]{64}$/.test(hash) ? Buffer.from(hash, 'hex') : undefined;
      } catch { return undefined; }
    },
  });
  server.listen(port, IMPACTO_DIRECTORY_HOST, () => console.log('Lista de servidores disponível na porta ' + port));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close());
} else throw new Error('Use serve, register <wss://host/world> ou revoke <wss://host/world>.');
