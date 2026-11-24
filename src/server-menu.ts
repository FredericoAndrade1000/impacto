import { actionButton, node } from './dom-view.ts';
import { locale, tr } from './i18n.ts';
import { checkServerEntry, compatible, lastServer, loadServerList, measureServer, pageField, typedServer } from './server-browser.ts';
import type { ListedServer } from './server-directory-contract.ts';
import { DEFAULT_SOURCE_URL } from './source-url.ts';

export interface ServerChoice { address: URL; name: string; official: boolean }
const LANGUAGES = { 'pt-BR': 'Português', en: 'English', es: 'Español' };
const byName = (a: ListedServer, b: ListedServer) => a.name.localeCompare(b.name, locale());

export function createServerMenu(dialog: HTMLDialogElement, choose: (server: ServerChoice) => void, workshop: () => void) {
  const local = pageField(location);
  const heading = dialog.querySelector<HTMLElement>('#servers-title')!;
  const rows = dialog.querySelector<HTMLElement>('#server-list')!;
  const summary = dialog.querySelector<HTMLElement>('#server-list-status')!;
  const filter = dialog.querySelector<HTMLInputElement>('#server-filter')!;
  const order = dialog.querySelector<HTMLSelectElement>('#server-order')!;
  const address = dialog.querySelector<HTMLInputElement>('#server-address')!;
  const form = dialog.querySelector<HTMLFormElement>('#server-direct')!;
  const error = dialog.querySelector<HTMLElement>('#server-error')!;
  const refresh = dialog.querySelector<HTMLButtonElement>('#server-refresh')!;
  const source = dialog.querySelector<HTMLAnchorElement>('#server-source')!;
  source.href = DEFAULT_SOURCE_URL;
  let cycle = new AbortController(), attempt: AbortController | undefined, official: string | undefined;
  let servers: ListedServer[] = [], state: 'loading' | 'loaded' | 'disabled' | 'offline' = 'loading';
  const pings = new Map<string, number>();
  const pingLabels = new Map<string, HTMLElement>();
  const pingText = (server: string) => pings.has(server) ? tr('{0} ms', pings.get(server)!) : tr('Ping indisponível');
  const reportError = (message = '') => { error.hidden = !message; error.textContent = message; };
  const stop = () => { cycle.abort(); attempt?.abort(); attempt = undefined; };
  const close = () => { stop(); dialog.close(); };
  const select = (target: URL, name: string) => {
    close();
    choose({ address: target, name, official: target.href === official });
  };
  async function enter(target: URL | null, name?: string) {
    attempt?.abort(); attempt = undefined;
    const pending = attempt = new AbortController();
    if (target && target.href !== local.href) reportError(tr('Verificando servidor…'));
    const result = await checkServerEntry(target, local, pending.signal);
    if (pending.signal.aborted) return;
    attempt = undefined;
    if (result === 'compatible' && target) select(target, name ?? (target.href === local.href ? tr('Servidor desta página') : target.host));
    else reportError(result === 'invalid' ? tr('Digite um endereço HTTPS ou WSS válido.') :
      result === 'incompatible' ? tr('Este servidor usa outra versão do jogo.') :
      tr('Servidor indisponível ou sem acesso a partir desta página.'));
  }
  function render() {
    const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.address : undefined;
    const search = filter.value.trim().toLocaleLowerCase(locale()), last = lastServer(local);
    const visible = servers.filter(server => [server.name, server.region, LANGUAGES[server.language], server.field].some(value =>
      value.toLocaleLowerCase(locale()).includes(search)));
    visible.sort((a, b) => Number(b.official) - Number(a.official) ||
      (order.value === 'players' ? b.players - a.players : order.value === 'ping' ?
        (pings.get(a.address) ?? Infinity) - (pings.get(b.address) ?? Infinity) : 0) || byName(a, b));
    pingLabels.clear();
    rows.replaceChildren(...visible.map(server => {
      const row = node('li', 'server-row'), copy = node('div', 'server-copy'), title = node('div', 'server-row-title');
      row.classList.toggle('server-official', server.official);
      title.append(node('strong', '', server.name), node('span', 'server-badge', server.official ? tr('Oficial') : tr('Comunitário')));
      if (last?.href === server.address) title.append(node('span', 'server-last', tr('Último acesso')));
      copy.append(title);
      if (server.description) copy.append(node('span', 'server-description', server.description));
      copy.append(node('span', 'server-meta', [server.region, LANGUAGES[server.language], server.field].join(' · ')));
      const ok = compatible(server), info = node('div', 'server-metrics'), ping = node('span', '', pingText(server.address));
      pingLabels.set(server.address, ping);
      info.append(node('span', '', tr('{0}/{1} jogadores', server.players, server.capacity)), ping,
        node('span', ok ? 'server-compatible' : 'server-incompatible', ok ? tr('Compatível') : tr('Incompatível')));
      const go = actionButton(tr('Entrar'), () => void enter(new URL(server.address), server.name), 'primary-button');
      go.dataset.address = server.address; go.disabled = !ok;
      go.setAttribute('aria-label', tr('Entrar em {0}', server.name));
      row.append(copy, info, go);
      return row;
    }));
    if (focused) [...rows.querySelectorAll('button')].find(button => button.dataset.address === focused)?.focus({ preventScroll: true });
    summary.textContent = state === 'loading' ? tr('Buscando servidores…') : state === 'offline' ?
      tr('Lista indisponível. Você ainda pode entrar neste servidor ou por endereço.') : state === 'disabled' ?
      tr('Jogue neste servidor ou entre por endereço.') : !servers.length ? tr('Nenhum servidor anunciado.') :
      !visible.length ? tr('Nenhum servidor corresponde à busca.') : '';
    summary.hidden = !summary.textContent;
  }
  async function reload() {
    cycle.abort(); const current = cycle = new AbortController();
    state = 'loading'; servers = []; pings.clear(); refresh.disabled = true; render();
    try {
      const result = await loadServerList(current.signal, local.protocol === 'ws:', url => { source.href = url; });
      if (current.signal.aborted) return;
      ({ official, servers, state } = result);
    } catch {
      if (current.signal.aborted) return;
      state = 'offline';
    }
    refresh.disabled = false; render();
    let next = 0;
    const poll = async () => {
      while (!current.signal.aborted && next < servers.length) {
        const server = servers[next++]!;
        try {
          const status = await measureServer(new URL(server.address), current.signal);
          if (current.signal.aborted) return;
          pings.set(server.address, status.ping);
          const changed = status.network !== server.network || status.core !== server.core;
          Object.assign(server, { network: status.network, core: status.core, players: status.players, capacity: status.capacity });
          if (changed) render();
          const label = pingLabels.get(server.address);
          if (label) label.textContent = pingText(server.address);
        } catch { /* The server can still be selected and checked again. */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(servers.length, 6) }, poll));
    if (!current.signal.aborted && servers.length) render();
  }
  refresh.onclick = () => void reload();
  dialog.querySelector<HTMLButtonElement>('#server-local')!.onclick = () => void enter(local);
  dialog.querySelector<HTMLButtonElement>('#server-workshop')!.onclick = () => { close(); workshop(); };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); workshop(); });
  form.addEventListener('submit', event => { event.preventDefault(); void enter(typedServer(address.value)); });
  filter.addEventListener('input', render);
  order.addEventListener('change', render);
  return {
    open() {
      if (dialog.open) return;
      const last = lastServer(local);
      address.value = last && last.href !== local.href ? last.href : '';
      filter.value = ''; reportError(); dialog.showModal(); heading.focus(); void reload();
    },
  };
}
