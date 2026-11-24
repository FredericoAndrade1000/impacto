import type { NetworkClient } from './network-client.ts';
import type { ChatMessage } from './field-contract.ts';
import type { ChatHistory } from './field-protocol-contract.ts';
type ChatView = ChatHistory;
type ChatScope = ChatMessage['scope'];
export interface ChatOptions {
  readonly host: HTMLElement; readonly network: Pick<NetworkClient, 'connected' | 'faction' | 'name' | 'chat' | 'command'>;
  readonly canvas: Pick<HTMLCanvasElement, 'focus'>; readonly toast?: (text: string, error?: boolean) => void;
  readonly shown: () => boolean; readonly blocked?: () => boolean; readonly fieldTime?: () => number | null;
}
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing chat control'); return value; };
const isNode = (target: EventTarget | null): target is Node => target !== null && 'contains' in target && typeof target.contains === 'function';
const isKeyboardEvent = (event: Event): event is KeyboardEvent => 'key' in event && typeof event.key === 'string';
const errorText = (error: unknown): string => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
import { tr, locale } from './i18n.ts';
import { node, icon } from './dom-view.ts';
import { flagMarkup } from './flag.ts';
import { SOCIAL_LIMITS, socialText } from './faction-social.ts';

// The conversation of the field. On a computer it is always there, in the lower left corner of the field: one history of
// what was said to the faction, to it and its allies, and to everyone, in the order it came, the oldest at the top, each
// line led by the tag of its channel in that channel's colour; and at its foot the line to write in, after the channel
// the player speaks on, which a click on it, or Tab while writing, changes — Facção, Aliados while the faction has an
// alliance, Global, and Facção again; Shift+Tab goes back. At rest the box has hardly a ground of its own. Enter, or a click
// on what was said or on the line, brings the line out: Enter sends and puts it away, Escape puts it away with the draft
// kept, and the keys go back to the field. While it is out no key reaches the field. On a phone (`COMPACT`) there is no
// room for it: a button with what came while it was shut opens the conversation over the field. The room owns every
// message; here are only the draft, the channel and what was read.
const COMPACT = '(max-width: 900px), (max-height: 520px)',
  NAMES = { faction: tr('Facção'), allies: tr('Aliados'), global: 'Global' }, CHANNELS: ChatScope[] = ['faction', 'allies', 'global'],
  PLACEHOLDERS = { faction: tr('Mensagem para a sua facção'), allies: tr('Mensagem para a sua facção e os aliados'), global: tr('Mensagem para todos no campo') },
  BALLOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9a1.5 1.5 0 0 1-1.5 1.5h-8.5l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z"/></svg>';
const write = (element: Node, text: string): void => { if (element.textContent !== text) element.textContent = text; };
const mark = (element: HTMLElement, name: string, value: string): void => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
const counted = (n: number): string => n > 99 ? '99+' : n ? String(n) : '';
const button = (className: string, text?: string): HTMLButtonElement => { const b = node('button', className, text); b.type = 'button'; return b; };
// The field numbers its messages as it takes them, every channel on one count (room.ts `mint`): that is the order they
// came in. What was said to the faction and to its allies comes in the faction's list (network-client.ts).
const serial = (message: ChatMessage): number => Number(message.id.slice(1));
const everything = (chat: ChatView): ChatMessage[] => [...chat.faction, ...chat.global];
const merged = (chat: ChatView): ChatMessage[] => everything(chat).sort((a, b) => serial(a) - serial(b));

// `shown()` says whether the field is on the screen, `blocked()` whether Enter is another's there (a works or a road
// being placed); a panel open over the field leaves it `inert`, and a dialog is the keys' while it is open. `fieldTime()`
// is the time of the field the page last heard, which dates the messages.
export function initChat({ host, network, canvas, toast = () => {}, shown, blocked = () => false, fieldTime = () => null }: ChatOptions) {
  const root = node('section', 'field-chat'); root.id = 'field-chat'; root.hidden = true; root.dataset.open = 'false';
  root.setAttribute('aria-label', tr('Conversa'));
  const toggle = button('chat-toggle'), total = node('output', 'chat-unread');
  toggle.innerHTML = BALLOON; toggle.append(total); toggle.setAttribute('aria-expanded', 'false');
  const panel = node('div', 'chat-panel'), log = node('ol', 'chat-log'), status = node('p', 'chat-status'),
    form = node('form', 'chat-form'), channel = button('chat-channel'), input = node('input', 'chat-input'), close = button('chat-close');
  close.innerHTML = icon('i-close'); close.setAttribute('aria-label', tr('Fechar a conversa')); close.title = tr('Fechar');
  log.setAttribute('role', 'log'); log.setAttribute('aria-label', tr('Histórico da conversa'));
  log.setAttribute('data-empty', tr('Nenhuma mensagem ainda.'));
  status.setAttribute('role', 'status');
  input.type = 'text'; input.value = ''; input.maxLength = SOCIAL_LIMITS.text; input.autocomplete = 'off'; input.enterKeyHint = 'send';
  input.setAttribute('aria-label', tr('Mensagem')); input.title = tr('Enter envia · Tab troca o canal · Esc fecha');
  form.append(channel, input, close);
  panel.append(log, status, form); root.append(toggle, panel); host.append(root);

  const seen = new Set<string>(), clocks = new Map<string, string>(), unread = new Set<string>(), rows = new Map<string, HTMLLIElement>(), phone = globalThis.matchMedia?.(COMPACT);
  let open = false, chosen: ChatScope = 'faction', busy = false, said = '', stuck = true;
  let drawn: { chat: ChatView; ref: ChatView['ref']; undated: boolean } | null = null;
  let unsure: { scope: ChatScope; text: string; draft: string; after: number } | null = null;
  let room: string | null = null, clear: string | null = null, sheet: string | null = null;
  const compact = () => Boolean(phone?.matches);
  const refusal = () => !network.connected ? tr('Sem conexão com o campo.') : !network.faction ? tr('Você ainda não tem facção.') : '';
  // The channels the player speaks on now, in their order: Aliados while the faction has an alliance accepted, as its
  // accords tell it. One chosen that is no longer there — the alliance is over — is Facção again.
  const channels = () => {
    const ref = network.faction?.ref, allied = (network.faction?.accords ?? [])
      .some(a => a.kind === 'alliance' && a.acceptedAt !== null && (a.from.ref === ref || a.to.ref === ref));
    return CHANNELS.filter(scope => scope !== 'allies' || allied);
  };
  const current = () => { if (!channels().includes(chosen)) chosen = 'faction'; return chosen; };
  const next = (step = 1) => { const there = channels(); return required(there[(there.indexOf(current()) + step + there.length) % there.length]); };

  // A message as a line: the tag of its channel, on Aliados and Global whose faction it is (flag and name), who wrote it
  // and what.
  const flagOf = (ref: string) => (ref === network.faction?.ref ? network.faction : network.faction?.ranking?.find(f => f.ref === ref))?.flag;
  const clock = (message: ChatMessage): string => {
    if (clocks.has(message.id)) return required(clocks.get(message.id));
    const now = fieldTime();
    if (typeof now !== 'number' || !Number.isFinite(now) || !Number.isFinite(message.at)) return '';
    const text = new Date(Date.now() - Math.max(0, now - message.at) * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    clocks.set(message.id, text); return text;
  };
  const line = (message: ChatMessage): HTMLLIElement => {
    const element = node('li', 'chat-line'); element.dataset.scope = message.scope; element.dataset.id = message.id;
    element.append(node('time', 'chat-time', clock(message)), node('span', 'chat-scope', NAMES[message.scope]));
    if (message.scope !== 'faction') {
      const flag = flagOf(message.of), nation = node('span', 'chat-nation');
      if (flag) { const flown = node('span', 'chat-flag'); flown.innerHTML = flagMarkup(flag); nation.append(flown); }
      nation.append(node('span', '', message.nation)); element.append(nation);
    }
    element.append(node('b', 'chat-by', message.by), node('span', 'chat-text', message.text));
    return element;
  };
  // The lines of the history, kept by message: one already there is not made again, but is dated once the time of the
  // field is known (a history told on coming in may arrive before it). Says whether a line is still undated.
  const place = (messages: readonly ChatMessage[]): boolean => {
    const present = new Set(messages.map(message => message.id));
    let undated = false;
    for (const [id, row] of rows) if (!present.has(id)) { row.remove(); rows.delete(id); }
    messages.forEach((message, index) => {
      let row = rows.get(message.id);
      if (!row) { row = line(message); rows.set(message.id, row); }
      else if (!required(row.firstChild).textContent) write(required(row.firstChild), clock(message));
      undated ||= !required(row.firstChild).textContent;
      if (log.children[index] !== row) log.insertBefore(row, log.children[index] || null);
    });
    return undated;
  };

  // A message told live is news, unless it is the player's own, which takes the history back to its foot; on a computer
  // it is read as it comes (render). A conversation told whole — on coming in, on joining another faction — is not: what
  // is in it is read, and what went out of it, as the old faction's, is no longer counted.
  function receive(message?: ChatMessage): void {
    const chat = network.chat;
    if (!message) {
      const kept = new Set(everything(chat).map(old => old.id));
      for (const id of kept) seen.add(id);
      for (const id of seen) if (!kept.has(id)) { seen.delete(id); clocks.delete(id); unread.delete(id); }
      delivered(); render(); return;
    }
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (message.by === network.name) drawn = null; else unread.add(message.id);
    delivered(); render();
  }

  // The line to write in comes out, with the keys unless `focus` is false; on a phone the conversation opens with it.
  function show(focus = true) {
    if (!shown()) return;
    if (!open) said = '';
    open = open || focus || compact();
    render();
    if (focus) input.focus({ preventScroll: true });
  }
  // Putting it away keeps the draft. By the keyboard or its button, the keys go back to the field; a press elsewhere has
  // taken them where it pressed.
  function hide(back = true) {
    if (!open) return;
    open = false; said = ''; render();
    if (back) canvas.focus({ preventScroll: true });
  }
  // The next channel, or with `step` -1 the one before, with the draft as it is.
  function turn(step = 1) { chosen = next(step); said = ''; render(); }
  // A line whose answer was lost — the connection fell, or the field answered too late — may have gone out all the same
  // (`unsure`): told back as the player's own, newer than all that was there when it went, it did, and is not to be sent
  // twice. A draft still as it was goes with it, and the line is put away as after any line sent.
  const newest = () => Math.max(0, ...everything(network.chat).map(serial));
  function delivered(): boolean {
    const pending = unsure;
    if (!pending || !everything(network.chat).some(m => m.scope === pending.scope && m.by === network.name && m.text === pending.text && serial(m) > pending.after)) return false;
    const { draft } = pending; unsure = null; said = '';
    if (input.value === draft) { input.value = ''; if (open && !compact()) hide(); }
    return true;
  }
  async function send(): Promise<void> {
    const scope = current(), draft = input.value, refused = refusal();
    if (busy) return;
    if (!draft.trim()) { hide(); return; }
    // Disconnected or with no faction, the box already says so, and the draft waits.
    if (refused) return;
    let text;
    try { text = socialText(draft); } catch (error) { say(errorText(error)); return; }
    const after = newest(); unsure = null;
    busy = true; input.readOnly = true; say('');
    try {
      await network.command('chat', { scope, text });
      if (input.value === draft) input.value = '';
      // On a phone the conversation stays open for the next line, the keyboard with it.
      if (open && !compact()) hide();
    } catch (error) {
      unsure = { scope, text, draft, after };
      if (!delivered()) { if (open) say(errorText(error)); else toast(errorText(error), true); }
    }
    finally { busy = false; input.readOnly = false; render(); }
  }
  const say = (text: string): void => { said = text; render(); };

  toggle.onclick = () => { if (open) hide(); else show(false); };
  close.onclick = () => hide();
  // The channel changes where the keys are: in the line while it is out (a press on it does not take them), with the
  // field otherwise.
  channel.addEventListener('mousedown', event => event.preventDefault());
  channel.onclick = () => { turn(); if (!open) canvas.focus({ preventScroll: true }); };
  // On a computer a click on what was said, or on the line at rest, brings the line out.
  log.onclick = () => { if (!compact()) show(); };
  // At its foot, or near it, the history stays there as lines come and as the box changes size (follow).
  log.addEventListener('scroll', () => { stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
  input.addEventListener('focus', () => { if (!open) show(); });
  form.onsubmit = event => { event.preventDefault(); send(); };
  input.addEventListener('input', () => { said = ''; render(); });
  // Before anything of the field hears a key: while the line is out, Escape puts it away, Tab changes the channel and
  // the keys typed are the draft's; while it is not, Enter over the field brings it out.
  globalThis.addEventListener?.('keydown', event => {
    if (!isKeyboardEvent(event)) return;
    if (open) {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); hide(); return; }
      if (event.target !== input) return;
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
      else if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); turn(event.shiftKey ? -1 : 1); }
      return;
    }
    if (event.key !== 'Enter' || event.repeat || event.isComposing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!shown() || host.inert || blocked() || document.querySelector('dialog[open]') ||
      (event.target && 'closest' in event.target && typeof event.target.closest === 'function' && event.target.closest('input, textarea, select, button, summary, a, [contenteditable=true]'))) return;
    event.preventDefault(); event.stopPropagation(); show();
  }, true);
  document.addEventListener?.('pointerdown', event => { if (open && !root.contains(isNode(event.target) ? event.target : null)) hide(false); }, true);
  phone?.addEventListener?.('change', () => render());

  function render() {
    // A panel open over the field (`inert`) puts the line away; the history stays, under it.
    const visible = Boolean(shown());
    if (open && (!visible || host.inert)) { hide(false); return; }
    if (root.hidden === visible) root.hidden = !visible;
    mark(root, 'data-open', String(open));
    if (!visible) return;
    // What is drawn is read: on a computer always, on a phone while the conversation is open.
    const reading = open || !compact();
    if (reading) unread.clear();
    mark(toggle, 'aria-expanded', String(open));
    mark(toggle, 'aria-label', unread.size ? tr`Conversa: ${unread.size} não lidas` : tr('Conversa'));
    mark(toggle, 'title', open ? tr('Fechar a conversa') : tr('Conversa'));
    write(total, counted(unread.size));
    const scope = current();
    write(channel, NAMES[scope]); mark(channel, 'data-scope', scope);
    mark(channel, 'aria-label', tr`Canal: ${NAMES[scope]}`); mark(channel, 'title', tr`Trocar para ${NAMES[next()]} · Tab`);
    const rest = document.documentElement?.dataset.input === 'touch' ? tr('Toque para escrever') : tr('Enter para escrever'),
      placeholder = open ? PLACEHOLDERS[scope] : rest;
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    const limit = input.value.length >= SOCIAL_LIMITS.text ? tr`Limite de ${SOCIAL_LIMITS.text} caracteres.` : '';
    write(status, open ? refusal() || said || limit : '');
    // The history keeps its place while the player reads back in it, and follows what comes when they are at its foot.
    const chat = network.chat;
    if (!reading) { if (drawn) { drawn = null; place([]); } }
    else if (!drawn || drawn.chat !== chat || drawn.undated && Number.isFinite(fieldTime())) {
      const bottom = !drawn || drawn.ref !== chat.ref || stuck;
      drawn = { chat, ref: chat.ref, undated: place(merged(chat)) && !Number.isFinite(fieldTime()) };
      if (bottom) { stuck = true; log.scrollTop = log.scrollHeight; }
    }
  }

  // On a computer the box keeps above what stands at the foot of the field under it (the orders of what is picked, the
  // place of a works, the pedals of a finger), and under the card at the top of the corner; on a phone, open, the
  // conversation fills what the keyboard leaves of the screen. Told at each frame, as those change under it.
  function follow() {
    if (root.hidden) return;
    if (compact()) {
      const view = globalThis.visualViewport, size = open && view ? `${Math.round(view.offsetTop)}|${Math.round(view.height)}` : '';
      if (size !== sheet) {
        sheet = size;
        if (size && view) { panel.style.setProperty('--chat-top', `${Math.round(view.offsetTop) + 8}px`); panel.style.setProperty('--chat-height', `${Math.round(view.height) - 16}px`); }
        else { panel.style.removeProperty('--chat-top'); panel.style.removeProperty('--chat-height'); }
        // The keyboard that comes up leaves the last lines in sight.
        log.scrollTop = log.scrollHeight;
      }
      return;
    }
    const field = host.getBoundingClientRect(), box = root.getBoundingClientRect(), across = (r: DOMRect): boolean => Boolean(r.width) && r.right > box.left && r.left < box.right;
    let lift = 0, top = field.top;
    for (const element of host.querySelectorAll(':scope > #field-dock:not([hidden]), .publication-dock, :scope > .touch-pad:not([hidden]) > *')) {
      const r = element.getBoundingClientRect();
      if (across(r)) lift = Math.max(lift, field.bottom - r.top + 8);
    }
    const card = host.querySelector(':scope > .field-empty:not([hidden])')?.getBoundingClientRect();
    if (card && across(card)) top = card.bottom;
    // A history longer than the box takes the clicks and the wheel all over it, its bar with them.
    const clearing = `${Math.ceil(lift)}px`, rooming = `${Math.floor(Math.max(0, field.bottom - lift - top - 8))}px`,
      full = String(log.scrollHeight > log.clientHeight + 1);
    if (clearing !== clear) { clear = clearing; root.style.setProperty('--chat-clear', clearing); }
    if (rooming !== room) { room = rooming; root.style.setProperty('--chat-room', rooming); }
    if (log.dataset.full !== full) log.dataset.full = full;
    if (stuck && log.scrollHeight - log.scrollTop - log.clientHeight > 1) log.scrollTop = log.scrollHeight;
  }

  receive(); return { render, receive, follow, open: show, close: hide };
}
