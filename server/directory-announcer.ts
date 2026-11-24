import { DIRECTORY_BEAT_MS, DIRECTORY_PATH, directoryURL, fieldAddress, readServerAnnouncement,
  type ServerStatus } from '../src/server-directory-contract.ts';
import { readHttpsOrigins } from './server-origins.ts';

export function directoryConfig(env: NodeJS.ProcessEnv, publicAddress: URL | null, local: boolean) {
  const url = env.IMPACTO_DIRECTORY_URL ? directoryURL(env.IMPACTO_DIRECTORY_URL, local) : null;
  const official = env.IMPACTO_OFFICIAL_SERVER ? fieldAddress(env.IMPACTO_OFFICIAL_SERVER) : null;
  const key = env.IMPACTO_DIRECTORY_KEY || '';
  if (env.IMPACTO_DIRECTORY_URL && !url) throw new Error('IMPACTO_DIRECTORY_URL deve ser uma origem HTTPS.');
  if (env.IMPACTO_OFFICIAL_SERVER && !official) throw new Error('IMPACTO_OFFICIAL_SERVER deve ser um endereço WSS público.');
  const clientOrigins = readHttpsOrigins(env.IMPACTO_CLIENT_ORIGINS);
  const server = key ? readServerAnnouncement({ address: env.IMPACTO_DIRECTORY_ADDRESS || publicAddress?.href,
    name: env.IMPACTO_DIRECTORY_NAME, description: env.IMPACTO_DIRECTORY_DESCRIPTION || '', region: env.IMPACTO_DIRECTORY_REGION,
    language: env.IMPACTO_DIRECTORY_LANGUAGE, field: env.IMPACTO_DIRECTORY_FIELD || 'Campo principal',
    network: 1, core: 1, players: 0, capacity: 1 }) : null;
  if (key && (!url || !server || !/^[\w-]{43}$/.test(key)))
    throw new Error('Configure uma URL, chave, endereço, nome, região e idioma válidos para anunciar o campo.');
  return { url, official, clientOrigins, announcement: server && url ? { server, url, key } : null };
}

export function announceField(config: NonNullable<ReturnType<typeof directoryConfig>['announcement']>,
  status: () => ServerStatus | null): () => void {
  const url = new URL(DIRECTORY_PATH, config.url), lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, failing = false;
  async function announce() {
    const field = status();
    if (field) {
      try {
        const response = await fetch(url, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(8_000)]),
          headers: { Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...config.server, ...field }) });
        await response.body?.cancel();
        if (response.status !== 204) throw new Error('HTTP ' + response.status);
        failing = false;
      } catch (error) {
        if (!failing && !lifetime.signal.aborted)
          console.warn('Não foi possível anunciar o campo na lista:', error instanceof Error ? error.message : 'falha');
        failing = true;
      }
    }
    if (!lifetime.signal.aborted) timer = setTimeout(announce, field ? DIRECTORY_BEAT_MS : 2_000).unref();
  }
  void announce();
  return () => { clearTimeout(timer); lifetime.abort(); };
}
