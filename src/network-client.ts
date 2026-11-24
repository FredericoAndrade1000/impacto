import { tr } from './i18n.ts';
import type { DecodedFramePacket } from './network-protocol.ts';
import type { SceneEventBase } from './scene-contract.ts';
import { decodeFieldView, decodeDrawingEvents } from './scene-drawing-codec.ts';
import type { Point } from './math.ts';
import type { WeaponOverrides } from './weapons.ts';
import type { FactionView, RoomSquadView, FieldDesign, FieldBase, ChatMessage } from './field-contract.ts';
import type { CommandKind, CommandData, CommandResult, WelcomeMessage, ChatHistory, TestSpeed, TestAct, TestResultFor, TestRequest, LibraryAct, LibraryRequest, LibraryResultFor } from './field-protocol-contract.ts';
import { isWelcomeMessage, isFactionView, isSquadMetadata, isChatMessage, isServerReply, decodeCommandResult, decodeTestResultFor, isTestAct, decodeLibraryResultFor, isLibraryAct } from './field-protocol-codec.ts';
import { record } from './wire-shape.ts';
export type { CommandKind, CommandData, CommandResult } from './field-protocol-contract.ts';
type Phase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'updated' | 'elsewhere' | 'refused';
type FieldScene = ReturnType<typeof decodeFieldView>;
export interface NetworkFramePacket extends DecodedFramePacket<FieldScene, SceneEventBase> { physicsMs?: number }
interface ArmedIntent extends WeaponOverrides { also?: WeaponOverrides[] | undefined }
const dictionary = (value: unknown): Record<string, unknown> => { if (!record(value)) throw new Error(tr('Mensagem de rede inválida.')); return value; };
const point = (value: unknown): value is Point => record(value) && typeof value.x === 'number' && Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
import { SceneFrameReader, NETWORK_VERSION, PUBLICATION_COMMANDS, merged } from './network-protocol.ts';
import { SOCIAL_LIMITS } from './faction-social.ts';
import { PendingReplies } from './pending-replies.ts';
import { errorText } from './user-message.ts';
import { FIELD_SOCKET_PATH } from './server-directory-contract.ts';

// The aim follows the pointer twenty times a second at most, and where the pointer came to rest is always told; a point goes
// to the millimetre. How the guns in hand are laid goes with an aim, a pull of the trigger or a shot only when it changed,
// and only what the field reads of it: which gun, its arc, fuze and charge, and the others fired with it.
const AIM_EVERY = 50, LAYING = ['id', 'componentId', 'trajectory', 'detonation', 'aimAngle', 'charge', 'fuzeTime'] as const;
const millimetre = (value: number) => Math.round(value * 1000) / 1000;
const laying = (input: unknown) => {
  const weapon = dictionary(input), told: Record<string, unknown> = {};
  for (const key of LAYING) if (weapon[key] !== undefined) told[key] = weapon[key];
  if (weapon.also) told.also = weapon.also;
  return told;
};
// The page tells the field it is there every half a second, and asks it to answer. A field that has left ten pings in a row
// unanswered, the first of them five seconds ago, is taken as lost: a connection that died on the way may not close for a
// minute. Pings are counted rather than seconds, so that a tab whose timers the browser slows down is not taken for one.
const BEAT = 500, UNANSWERED = 10;
const STATUS: Partial<Record<Phase, string>> = { connecting: 'Conectando…', connected: 'Conectado', reconnecting: 'Reconectando…',
  updated: 'Jogo atualizado', elsewhere: 'Conta em outro aparelho', refused: 'Não foi possível entrar' };
const STOPPED = new Set(['updated', 'elsewhere', 'refused']);
// Where the browser keeps the key of its seat (`keyOf`): the same in every tab, and on the next visit.
const SEAT = 'impacto.network.seat';
const kept = (slot: string) => { try { return localStorage.getItem(slot) || ''; } catch { return ''; } };
const keep = (slot: string, key: string) => { try { if (key) localStorage.setItem(slot, key); else localStorage.removeItem(slot); } catch {} };
// And the name the player goes by there, which the page goes into the field with on the next visit.
const NAME = 'impacto.player-name';
export const keptName = () => { try { return localStorage.getItem(NAME) || ''; } catch { return ''; } };
const keepName = (name: string) => { try { localStorage.setItem(NAME, name); } catch {} };
function publicFrame(packet: DecodedFramePacket<FieldScene>): NetworkFramePacket {
  const { physicsMs, ...message } = packet;
  if (physicsMs !== undefined && (typeof physicsMs !== 'number' || !Number.isFinite(physicsMs))) throw new Error(tr('Medição de quadro inválida.'));
  return { ...message, events: decodeDrawingEvents(packet.events), ...(physicsMs === undefined ? {} : { physicsMs }) };
}

export class NetworkClient {
  private origin: URL | null;
  private seatSlot = SEAT;
  declare enabled: boolean; declare connected: boolean; declare replies: PendingReplies; declare designs: Map<string, FieldDesign>;
  declare reader: SceneFrameReader<FieldScene>; declare asked: number; declare serial: number; declare pingMs: number; declare selected: string | null;
  declare squad: RoomSquadView | null; declare faction: FactionView | null; declare retry: number; declare told: { squad?: unknown; faction?: unknown };
  declare chat: ChatHistory; declare aimAt: number; declare armed: string | undefined; declare publishing: { asked: string; test: boolean; ticket: string } | null;
  declare testTools: boolean; declare testSpeed: TestSpeed; declare phase: Phase; declare issue: string; declare persistenceFailed: boolean;
  declare build: string | undefined; declare playerId?: string; declare token?: string; declare name?: string | null;
  declare saying?: boolean; declare typed?: boolean; declare socket: WebSocket | null | undefined;
  declare reconnectTimer?: ReturnType<typeof setTimeout>; declare connectionTimer?: ReturnType<typeof setTimeout>;
  declare heartbeat?: ReturnType<typeof setInterval>; declare unanswered: number | undefined;
  declare aimTimer: ReturnType<typeof setTimeout> | null | undefined; declare pointed: { aim: Point; weapon: ArmedIntent } | null | undefined;
  declare base?: FieldBase | null; declare watch?: { x: number; y: number; zoom: number } | null;
  declare onstatus?: (status: string | undefined) => void; declare ontestsettings?: () => void;
  declare onframe?: (packet: NetworkFramePacket, recovered: boolean) => void; declare onspent?: ((milliseconds: number) => void) | null;
  declare onchat?: (message?: ChatMessage) => void; declare onwelcome?: (message: WelcomeMessage & { reconnected: boolean }) => void;
  declare onsquad?: () => void; declare onfaction?: () => void; declare onerror?: (message: string) => void;
  declare onkey?: (message: string, typed: boolean) => void; declare onname?: (message: string, typed: boolean) => void;
  declare onoutdated?: (message: string) => void; declare onleave?: (message: string) => void;
  declare stopUpdates?: () => void; declare checkUpdates: (() => Promise<void>) | null | undefined;

  constructor(origin: URL | null = null) {
    this.origin = origin;
    this.enabled = false; this.connected = false; this.replies = new PendingReplies(); this.designs = new Map(); this.reader = new SceneFrameReader(decodeFieldView); this.asked = -Infinity; this.serial = 0; this.pingMs = 0; this.selected = null; this.squad = null; this.faction = null; this.retry = 0;
    // The squad and the faction as the field last told them: it tells what changed of each since.
    this.told = {};
    this.chat = { ref: null, global: [], faction: [] };
    // When the aim was last told, and how the guns were laid as the field was last told it.
    this.aimAt = -Infinity; this.armed = undefined;
    // The publication last asked for that the field has not answered with what it made, with its ticket (`command`).
    this.publishing = null; this.testTools = false; this.testSpeed = 1;
    this.phase = 'idle'; this.issue = ''; this.persistenceFailed = false;
    // The code this page was served, as the server stamped it: the field accepts only a compatible page.
    this.build = globalThis.document?.querySelector<HTMLMetaElement>('meta[name="impacto-build"]')?.content;
  }
  // Retained squad data keeps selection through a reconnect. Input waits for
  // fresh connection metadata and any control order already on its way.
  get manualActorId() {
    if (!this.connected || !this.told.squad) return null;
    for (const pending of this.replies.pending.values()) if (pending.control) return null;
    return this.squad?.manual ?? null;
  }
  // The seat on the field is kept by its key, which the browser keeps: whoever comes back finds the faction and what it
  // left on the field, in any tab, and a tab that comes takes the seat from another that sits in it. A key typed
  // (`key`) comes to the seat it keeps, from any device; the browser keeps it once the field took it. A page with no
  // name to say (null) comes back under the name the seat had; and so does a page that was let in once and comes back
  // to its seat by itself (`saying`): the name is the seat's, and the player changes it on the field (`rename`).
  connect(name: string | null, key = '', origin = this.origin) {
    if (this.enabled && origin?.origin !== this.origin?.origin) return;
    this.origin = origin && new URL(origin.origin);
    this.seatSlot = this.ownPage() ? SEAT : SEAT + ':' + this.origin!.origin;
    this.enabled = true; this.name = name; this.saying = true; this.typed = Boolean(key); this.token = key || kept(this.seatSlot);
    this.issue = ''; this.persistenceFailed = false;
    this.open();
  }
  private ownPage() {
    return !this.origin || this.origin.host === globalThis.location?.host && this.origin.protocol === globalThis.location?.protocol;
  }
  setStatus(phase: Phase, issue = '') { this.phase = phase; this.issue = issue; this.onstatus?.(STATUS[phase]); }
  setTestSpeed(factor: unknown) {
    if (!this.testTools || factor !== 1 && factor !== 2 && factor !== 4 && factor !== 8 || this.testSpeed === factor) return;
    this.testSpeed = factor; this.ontestsettings?.();
  }
  // One lightweight page monitor, independent of a seat or field connection. A failed request is not an update.
  watchUpdates(onupdate: (version: string) => void) {
    this.stopUpdates?.();
    const loaded = globalThis.document?.querySelector<HTMLMetaElement>('meta[name="impacto-page"]')?.content;
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null, checking = false, stopped = false;
    const check = this.checkUpdates = async () => {
      clearTimeout(timer);
      if (document.hidden) { controller?.abort(); return; }
      if (checking || stopped) return;
      checking = true; controller = new AbortController(); deadline = setTimeout(() => controller?.abort(), 5000);
      try {
        const response = await fetch('/api/network', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const raw: unknown = await response.json(), update = record(raw) && record(raw.update) ? raw.update : null;
        if (!stopped && !document.hidden && update?.ready === true && typeof update.version === 'string' && /^[a-f0-9]{16}$/.test(update.version) && update.version !== loaded) onupdate(update.version);
      } catch { /* offline, background suspension and partial rollout do not cause a reload */ }
      finally { clearTimeout(deadline); controller = null; checking = false; if (!stopped && !document.hidden) timer = setTimeout(check, 30000); }
    };
    this.stopUpdates = () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); controller?.abort(); document.removeEventListener('visibilitychange', check); window.removeEventListener('online', check); this.checkUpdates = null; };
    document.addEventListener('visibilitychange', check); window.addEventListener('online', check); check();
  }
  // A deliberate retry keeps the same seat. It also lets the player take this tab back after opening another.
  retryNow() {
    if (!this.enabled || this.connected || this.phase === 'updated') return;
    this.retry = 0; this.open();
  }
  cancelEntry() {
    if (this.connected || this.playerId) return false;
    this.enabled = false;
    clearTimeout(this.reconnectTimer);
    this.closeSocket();
    this.token = ''; this.retry = 0;
    this.setStatus('idle');
    return true;
  }
  // Release timers and requests immediately; the eventual close event is ignored
  // by the same socket-identity guard as a reply from a superseded connection.
  closeSocket(socket = this.socket, code = 1006) {
    if (!socket) return;
    socket.close(); this.closed(socket, code);
  }
  open() {
    this.testTools = false; this.testSpeed = 1;
    if (this.publishing?.test) this.publishing = null;
    if (!this.enabled) return;
    this.closeSocket(this.socket, 1000);
    clearTimeout(this.reconnectTimer);
    this.connected = false; this.setStatus(this.playerId ? 'reconnecting' : 'connecting', STOPPED.has(this.phase) ? '' : this.issue);
    const origin = this.origin ?? globalThis.location;
    const socket = this.socket = new WebSocket(`${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}${FIELD_SOCKET_PATH}`);
    let frameGap = false;
    socket.binaryType = 'arraybuffer';
    this.connectionTimer = setTimeout(() => { if (socket === this.socket && !this.connected) this.closeSocket(socket); }, 10000);
    socket.onopen = () => { if (socket === this.socket) socket.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name: this.saying ? this.name : null,
      token: this.token, build: this.ownPage() ? this.build : undefined })); };
    socket.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (socket !== this.socket) return;
      try {
        if (data instanceof ArrayBuffer) {
          // A frame builds on the one before it. One that was lost is made up for by a whole state, asked for once a second at most.
          // Whoever asks is told how long the page spent on a frame, reading it and taking it in (`onspent`).
          const started = this.onspent ? performance.now() : 0, rawPacket = this.reader.decode(data);
          if (!rawPacket) { frameGap = true; const now = performance.now(); if (now - this.asked > 1000) { this.asked = now; this.send('resync'); } return; }
          const packet = publicFrame(rawPacket);
          const recovered = frameGap; frameGap = false;
          this.onframe?.(packet, recovered); this.onspent?.(performance.now() - started); return;
        }
        if (typeof data !== 'string') throw new Error(tr('Mensagem de rede inválida.'));
        const raw: unknown = JSON.parse(data), message = dictionary(raw);
        if (message.type === 'welcome') {
          if (!isWelcomeMessage(message)) throw new Error(tr('Saudação do campo inválida.'));
          const reconnected = this.playerId === message.playerId;
          frameGap = reconnected;
          clearTimeout(this.connectionTimer);
          this.persistenceFailed = message.persistenceFailed === true;
          this.testTools = message.testTools === true;
          this.setTestSpeed(message.factor);
          this.connected = true; this.retry = 0; this.playerId = message.playerId; this.token = message.token; this.name = message.name; this.selected = message.selected; this.base = message.base; this.faction = message.faction; this.watch = message.watch ?? null;
          this.chat = message.chat ?? { ref: this.faction?.ref, global: [], faction: [] }; this.onchat?.();
          // The seat given, by its key, is the browser's from here on, under the name it goes by.
          keep(this.seatSlot, this.token); keepName(this.name); this.typed = false; this.saying = false;
          // The faction comes whole with the welcome, and what the field says of it next is what changed since.
          this.reader = new SceneFrameReader(decodeFieldView); this.designs.clear(); this.told = { faction: message.faction }; this.armed = undefined;
          // A frame can arrive before the fresh squad metadata. Retaining the
          // last squad during that gap preserves the player's local selection.
          if (!reconnected) this.squad = null;
          for (const actor of message.actors) this.designs.set(actor.id, actor);
          this.setStatus('connected'); this.onwelcome?.({ ...message, reconnected });
          // A field that stopped answering has its socket let go now, as if it had closed.
          clearInterval(this.heartbeat); this.unanswered = 0;
          this.heartbeat = setInterval(() => {
            if (!this.connected) return;
            // This hello initialized the counter before installing the heartbeat.
            if (this.unanswered!++ >= UNANSWERED) { this.closeSocket(socket); return; }
            this.send('ping', { time: performance.now() });
          }, BEAT);
        } else if (message.type === 'pong') { if (typeof message.time !== 'number') throw new Error(tr('Resposta de presença inválida.')); this.pingMs = Math.max(0, performance.now() - message.time); this.unanswered = 0; }
        // The player's own squad: who is in hand, who has which orders, and the construction the workshop
        // looks at, which the field changes when that one is lost. The frames show what the faction is told of the field.
        else if (message.type === 'squad') { const told = this.told.squad = merged(this.told.squad, message.changes); if (!isSquadMetadata(told)) throw new Error(tr('Esquadrão de rede inválido.')); this.squad = told.squad; this.selected = told.selected; this.onsquad?.(); }
        // The player's faction: stocks, base, members and invitations, the ground it has explored, the factions it has
        // met, who else is on the field and the nations there, what each construction is worth, would cost to service and carries, the
        // wrecks on the field and the veins it knows of. The base is that of the faction: none when it lost it, another when it established one.
        else if (message.type === 'test-settings') this.setTestSpeed(message.factor);
        else if (message.type === 'faction') {
          const faction = this.told.faction = merged(this.told.faction, message.changes);
          if (faction !== null && !isFactionView(faction)) throw new Error(tr('Facção de rede inválida.'));
          this.faction = faction;
          if (this.faction) this.base = this.faction.base;
          if (this.chat.ref !== this.faction?.ref) { this.chat = { ...this.chat, ref: this.faction?.ref, faction: [] }; this.onchat?.(); }
          this.onfaction?.();
        }
        // The conversation is told to its own listener (`onchat`): whole — on coming in, on joining another faction —
        // with nothing, and a message that just came with it. What was said to the faction and to its allies is the
        // faction's list, as the field keeps it (room.ts `say`).
        else if (message.type === 'chat-history') { const messages = message.messages; if (message.ref !== null && typeof message.ref !== 'string' || !Array.isArray(messages) || !messages.every(isChatMessage)) throw new Error(tr('Histórico de conversa inválido.')); this.chat = { ...this.chat, ref: message.ref, faction: messages }; this.onchat?.(); }
        else if (message.type === 'chat') {
          if (!isChatMessage(message.message)) throw new Error(tr('Conversa de rede inválida.'));
          const item = message.message, ref = this.chat.ref, list = item.scope === 'global' ? 'global' : 'faction',
            ours = item.scope === 'global' || item.scope === 'faction' && item.of === ref || item.scope === 'allies' && (item.of === ref || item.to?.includes(ref ?? ''));
          if (ours && !this.chat[list].some(old => old.id === item.id)) {
            this.chat = { ...this.chat, [list]: [...this.chat[list], item].slice(-SOCIAL_LIMITS.history) }; this.onchat?.(item);
          }
        }
        else if (message.type === 'reply') {
          if (!isServerReply(message)) throw new Error(tr('Resposta do campo inválida.'));
          if (message.error) message.error = errorText(message);
          const pending = message.request === undefined ? undefined : this.replies.pending.get(message.request);
          // Expired or already settled requests cannot become fresh errors or change settings.
          // Notices and handshake refusals have no request and remain independent of this queue.
          if (message.request !== undefined && !pending) return;
          this.setTestSpeed(message.factor);
          // Autosave health is a server-wide notice, independent of a command acknowledgement.
          if (message.request === undefined && typeof message.persistenceFailed === 'boolean' && message.persistenceFailed !== this.persistenceFailed) {
            this.persistenceFailed = message.persistenceFailed; this.setStatus(this.phase, this.issue);
          }
          if (pending) this.replies.settle(message.request!, message.error ? new Error(message.error) : null, message);
          // A field that refuses the player says why, and the reason goes with the leaving: it is what stays on the screen.
          // A page behind the game is refused until it is loaded again: it stays a page of the field, and comes back to it then.
          // A key the field does not know takes the page off the field (`onkey`): one typed was mistyped, and the one the
          // browser kept — changed on another device, or of a field begun anew — is forgotten. So does a name another
          // player goes by (`onname`), and the browser keeps its key: the player comes in again under another name.
          else if (message.error) {
            if (this.connected) this.onerror?.(message.error);
            else if (message.unknownKey || message.nameTaken) {
              const typed = !!this.typed;
              if (message.unknownKey && !typed) keep(this.seatSlot, '');
              this.enabled = false; this.typed = false; this.token = kept(this.seatSlot);
              this.setStatus('refused', message.error); this.closeSocket(socket);
              if (message.unknownKey) this.onkey?.(message.error, typed); else this.onname?.(message.error, typed);
            } else {
              this.setStatus(message.retryable ? 'reconnecting' : message.outdated ? 'updated' : 'refused', message.error);
              this.closeSocket(socket);
              if (!message.retryable) message.outdated ? this.onoutdated?.(message.error) : this.onleave?.(message.error);
            }
          }
        }
      } catch (error) { this.onerror?.(errorMessage(error)); }
    };
    socket.onerror = () => { if (socket === this.socket) this.closeSocket(socket); };
    // A socket that closed, or that was let go, is not heard from again.
    socket.onclose = event => this.closed(socket, event.code);
  }
  closed(socket: WebSocket, code: number) {
      if (socket !== this.socket) return;
      this.socket = null; this.connected = false; clearInterval(this.heartbeat); clearTimeout(this.connectionTimer);
      this.testTools = false; this.testSpeed = 1;
      if (this.publishing?.test) this.publishing = null;
      clearTimeout(this.aimTimer ?? undefined); this.aimTimer = null; this.pointed = null;
      this.replies.rejectAll(new Error('A conexão com o campo caiu.'));
      if (!this.enabled) return;
      if (STOPPED.has(this.phase)) return;
      if (code === 4001) { this.setStatus('elsewhere', 'Sua conta entrou em outro aparelho.'); this.onleave?.(this.issue); return; }
      this.setStatus('reconnecting', this.issue); this.reconnectTimer = setTimeout(() => this.open(), Math.min(6000, 800 * 2 ** Math.min(this.retry++, 3)));
  }
  send(type: string, input: object = {}) {
    const data = dictionary(input);
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return;
    const told: Record<string, unknown> = { ...data, type, actorId: data.actorId ?? this.selected };
    if (data.aim) { if (!point(data.aim)) throw new Error(tr('Mira inválida.')); told.aim = { x: millimetre(data.aim.x), y: millimetre(data.aim.y) }; }
    const armed = data.weapon ? JSON.stringify(told.weapon = laying(data.weapon)) : this.armed;
    if (data.weapon && armed === this.armed) delete told.weapon;
    this.socket.send(JSON.stringify(told));
    this.armed = armed;
    // A shot or active trigger replaces the pending aim. A released trigger does not apply its aim on the server.
    if (data.aim && (type === 'aim' || type === 'fire' || type === 'trigger' && data.active === true)) {
      this.aimAt = performance.now();
      if (type !== 'aim') { clearTimeout(this.aimTimer ?? undefined); this.aimTimer = null; this.pointed = null; }
    }
    return true;
  }
  // Where the pointer is, with the guns in hand: told now, or the last of it when a twentieth of a second has passed.
  aim(aim: Point, weapon: ArmedIntent) {
    if (!this.connected) return;
    this.pointed = { aim, weapon };
    if (this.aimTimer) return;
    const wait = this.aimAt + AIM_EVERY - performance.now();
    if (wait > 0) this.aimTimer = setTimeout(() => { this.aimTimer = null; const pointed = this.pointed; if (pointed) this.aim(pointed.aim, pointed.weapon); }, wait);
    else this.send('aim', this.pointed);
  }
  // A publication goes under a ticket, kept until the field answers it with what it made: one asked again, the same, while
  // its answer never came — the connection fell, the field took too long — goes under the same ticket, and the field
  // answers it as it did instead of building it twice (server/room.ts). Another publication takes a ticket of its own.
  command<Act extends TestAct>(type: 'test', data: Extract<TestRequest, { act: Act }>): Promise<TestResultFor<Act>>;
  command<Act extends LibraryAct>(type: 'library', data: Extract<LibraryRequest, { act: Act }>): Promise<LibraryResultFor<Act>>;
  command<Kind extends CommandKind>(type: Kind, data?: CommandData[Kind]): Promise<CommandResult<Kind>>;
  command(type: CommandKind, data: CommandData[CommandKind] = {}): Promise<CommandResult> {
    if (!this.connected) return Promise.reject(new Error(tr('Aguarde a conexão com o campo.')));
    const request = ++this.serial, control = type === 'squad' && 'order' in data && data.order === 'control',
      asked = (PUBLICATION_COMMANDS.includes(type) || type === 'test' && 'act' in data && data.act === 'spawn') && JSON.stringify([type, data]);
    if (control) { clearTimeout(this.aimTimer ?? undefined); this.aimTimer = null; this.pointed = null; }
    if (asked && this.publishing?.asked !== asked) this.publishing = { asked, test: type === 'test', ticket: Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('') };
    const ticket = asked ? this.publishing!.ticket : undefined,
      made = (answer: unknown): CommandResult => {
        const result = type === 'test' && 'act' in data && isTestAct(data.act) ? decodeTestResultFor(data.act, answer) :
          type === 'library' && 'act' in data && isLibraryAct(data.act) ? decodeLibraryResultFor(data.act, answer) : decodeCommandResult(type, answer);
        if (ticket && this.publishing?.ticket === ticket) this.publishing = null;
        // An accepted control order is already applied, even when its metadata
        // follows a frame later. Leave the delta reader's baseline untouched.
        if (control && this.squad && this.squad.manual !== ('id' in data ? data.id ?? null : null)) {
          this.squad = { ...this.squad, manual: 'id' in data && typeof data.id === 'string' ? data.id : null }; this.onsquad?.();
        }
        return result;
      };
    const response = this.replies.wait(request, 8000, 'O campo demorou a responder. Tente de novo.', { control });
    try {
      if (!this.send(type, { ...data, ...(ticket && { ticket }), request })) throw new Error(tr('Aguarde a conexão com o campo.'));
    } catch (error) { this.replies.settle(request, error); }
    return response.then(made);
  }
  // Another key for the seat: the field answers with it, and the browser keeps it. The one before is nobody's.
  async rekey() {
    const { token } = await this.command('rekey');
    this.token = token; keep(this.seatSlot, token);
    return token;
  }
  // Another name for the player on the field, as the field worked it out: the browser keeps it for the next visit.
  async rename(name: string) {
    const { name: called } = await this.command('rename', { name });
    this.name = called; keepName(called);
    return called;
  }
}
