import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NetworkClient } from '../../src/network-client.ts';
import type { FieldView } from '../../src/faction-ui.ts';
import type { TestSpeed } from '../../src/field-protocol-contract.ts';
import { PlayerObservation, ownUnits, visibleContacts, describeParts, quoteDesign } from './observation.ts';
import type { PlayerView } from './observation.ts';
import type { PlayerAction, PlayerRequest, PlayerEvent, PlayerEventKind, PlayerPlan, PlayerReply } from './contract.ts';
import { decodeSquadCommand } from '../../src/squad-contract.ts';

export interface PlayerSessionOptions { origin: URL; directory: string; name: string | null; key: string; speed: TestSpeed }
export class PlayerSession {
  readonly options: PlayerSessionOptions;
  private readonly sessionId = randomUUID();
  readonly client: NetworkClient;
  private scene: FieldView | null = null;
  private receivedAt: number | null = null;
  private observation = new PlayerObservation();
  private changes = new EventEmitter().setMaxListeners(32);
  private sequence = 0;
  private events: PlayerEvent[] = [];
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private sampledAt = -Infinity;
  private fingerprints = new Map<string, string>();
  private progress = new Map<string, { x: number | null; cargo: string; rounds: number; health: number | null; since: number; warned: boolean }>();
  private serial: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private receipts = new Map<string, { fingerprint: string; reply: Promise<PlayerReply> }>();
  private plan: PlayerPlan | null = null;
  constructor(options: PlayerSessionOptions) {
    this.options = options;
    this.client = new NetworkClient(options.origin);
    const planFile = join(options.directory, 'plan.json');
    if (existsSync(planFile)) {
      const p: unknown = JSON.parse(readFileSync(planFile, 'utf8'));
      if (p && typeof p === 'object' && 'goal' in p && typeof p.goal === 'string' && 'notes' in p && typeof p.notes === 'string' &&
        'updatedAt' in p && typeof p.updatedAt === 'string' && 'at' in p && (p.at === null || typeof p.at === 'number'))
        this.plan = { goal: p.goal, notes: p.notes, updatedAt: p.updatedAt, at: p.at };
      else throw new Error('Invalid saved player plan.');
    }
    this.client.onframe = packet => { this.scene = packet.state; this.receivedAt = performance.now(); this.sample(); this.changes.emit('change'); };
    this.client.onfaction = () => this.sample();
    this.client.onsquad = () => this.sample();
    this.client.onstatus = () => {
      if (!this.client.connected) { this.scene = null; this.receivedAt = null; this.sampledAt = -Infinity; this.progress.clear(); this.fingerprints.clear(); }
      this.emit('connection', `${this.client.phase}${this.client.issue ? ': ' + this.client.issue : ''}`);
    };
    this.client.onerror = error => this.emit('connection', error);
    this.client.ontestsettings = () => this.emit('clock', `factor=${this.client.testSpeed}`);
    this.client.onwelcome = () => writeFileSync(join(options.directory, 'seat.json'), JSON.stringify({
      origin: options.origin.origin, key: this.client.token, playerId: this.client.playerId,
    }, null, 2), { mode: 0o600 });
    this.timer = setInterval(() => this.changes.emit('change'), 50);
  }
  private get view(): PlayerView { return { client: this.client, scene: this.scene, receivedAt: this.receivedAt }; }
  private get at() { return this.scene?.time ?? null; }
  private emit(kind: PlayerEventKind, detail: string, actorId?: string) {
    const event: PlayerEvent = { session: this.sessionId, sequence: ++this.sequence, kind, at: this.at, wallAt: new Date().toISOString(), detail,
      ...(actorId === undefined ? {} : { actorId }) };
    this.events.push(event); if (this.events.length > 512) this.events.shift();
    appendFileSync(join(this.options.directory, 'events.jsonl'), JSON.stringify(event) + '\n');
    this.changes.emit('change');
  }
  private changed(key: string, value: unknown, kind: PlayerEventKind, detail: string, actorId?: string) {
    const fingerprint = JSON.stringify(value);
    if (this.fingerprints.get(key) === fingerprint) return;
    this.fingerprints.set(key, fingerprint); this.emit(kind, detail, actorId);
  }
  private sample() {
    const at = this.at; if (at === null || !this.client.faction) return;
    if (at - this.sampledAt < 1) return; this.sampledAt = at;
    const units = ownUnits(this.view);
    const present = new Set(units.map(u => u.id));
    for (const id of this.progress.keys()) if (!present.has(id)) this.progress.delete(id);
    for (const key of this.fingerprints.keys()) if (key.startsWith('unit:') && !present.has(key.slice(5))) this.fingerprints.delete(key);
    this.changed('roster', units.map(u => u.id), 'unit', 'Own roster changed');
    for (const u of units) {
      this.changed('unit:' + u.id, [u.defeated, u.status.activity, u.status.reason, u.status.move, u.status.attack,
        u.status.haul?.phase, u.status.haul?.blocked, u.status.haul?.waiting, u.status.service?.kind, u.status.auto,
        u.status.job, u.status.stuck, u.builder, u.tools?.limit,
        u.fuelLow, u.health === null ? null : Math.floor(u.health.share * 20), u.rounds === 0, u.capabilities.weapons],
      'unit', `${u.name}: ${u.status.activity ?? 'unknown'} ${u.status.reason ?? ''}`, u.id);
      const cargo = JSON.stringify(u.cargo), prior = this.progress.get(u.id), health = u.health?.current ?? null;
      if (u.defeated || u.status.service || !(u.status.move || u.status.haul || u.status.attack)) this.progress.delete(u.id);
      else if (!prior || (u.x !== null && prior.x !== null && Math.abs(u.x - prior.x) >= 1) || prior.cargo !== cargo || prior.rounds !== u.rounds || prior.health !== health)
        this.progress.set(u.id, { x: u.x, cargo, rounds: u.rounds, health, since: at, warned: false });
      else if (!prior.warned && !u.status.service && (u.status.move || u.status.haul || u.status.attack) && at - prior.since >= 30) {
        prior.warned = true; this.emit('stalled', 'No observed travel of 1 m, cargo, ammunition or health progress for 30 simulated seconds', u.id);
      }
    }
    this.changed('contacts', visibleContacts(this.view).map(c => [c.id, c.knowledge, Math.floor(c.x / 100)]), 'contact', 'Known contacts changed');
    this.changed('reports', this.scene?.contacts?.map(c => [c.id, c.kind, c.x === undefined ? null : Math.floor(c.x / 100)]), 'contact', 'Sensor reports changed');
    const f = this.client.faction;
    this.changed('works', f.works.map(w => [w.id, w.waiting, w.blocked, w.building, w.share >= 1]), 'work', 'Work status changed');
    this.changed('industry', f.industry, 'industry', 'Industry status changed');
    this.changed('duel', [f.duel, f.siege?.state, f.taking.map(t => [t.id, t.state])], 'duel', 'Base capture or duel status changed');
  }
  async connect() {
    const response = await fetch(this.options.origin, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Cannot read the public game page.');
    this.client.build = /name="impacto-build" content="([a-f0-9]{16})"/.exec(await response.text())?.[1];
    if (!this.client.build) throw new Error('Public page build stamp absent.');
    this.client.connect(this.options.name, this.options.key);
    const start = performance.now();
    while (!this.ready()) {
      if (this.stopped || ['updated', 'elsewhere', 'refused'].includes(this.client.phase)) throw new Error(this.client.issue || this.client.phase);
      if (performance.now() - start > 20000) throw new Error('Player connection did not become ready.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (this.client.testTools && this.client.testSpeed !== this.options.speed)
      await this.client.command('test', { act: 'speed', factor: this.options.speed });
    return this.observe();
  }
  private ready() { return !this.stopped && this.client.connected && this.scene !== null && this.client.faction !== null && this.client.squad !== null &&
    this.receivedAt !== null && performance.now() - this.receivedAt < 2000; }
  private requireReady() { if (!this.ready()) throw new Error('Wait for a fresh player connection before issuing orders.'); }
  observe() {
    const summary = this.observation.summary(this.view);
    return { ...summary, cursor: `${this.sessionId}:${this.sequence}`, plan: this.plan, noProgress: [...this.progress].filter(([,p]) => p.warned)
      .map(([actorId, p]) => ({ actorId, since: p.since, simSeconds: (this.at ?? p.since) - p.since })) };
  }
  private wait(request: Extract<PlayerRequest, { op: 'wait' }>, signal?: AbortSignal) {
    const [session, position] = request.after.split(':'), after = Number(position);
    if (session !== this.sessionId) return Promise.reject(new Error('Event cursor belongs to another bridge instance; observe again.'));
    if (after > this.sequence) return Promise.reject(new Error('Event cursor is ahead of this session.'));
    const started = performance.now(), at = this.at;
    return new Promise<unknown>(resolve => {
      const check = () => {
        const events = this.events.filter(e => e.sequence > after && (!request.kinds || request.kinds.includes(e.kind))),
          gap = after < (this.events[0]?.sequence ?? 1) - 1,
          simulation = request.simSeconds !== undefined && at !== null && this.at !== null && this.at - at >= request.simSeconds,
          wall = performance.now() - started >= (request.wallSeconds ?? 45) * 1000;
        if (events.length || gap || simulation || wall || this.stopped || signal?.aborted) {
          this.changes.off('change', check);
          signal?.removeEventListener('abort', check);
          resolve({ reason: signal?.aborted ? 'cancelled' : gap ? 'cursor-gap' : events.length ? 'event' : this.stopped ? 'stopped' : simulation ? 'sim-time' : 'wall-time',
            cursor: `${this.sessionId}:${this.sequence}`, gap, events, state: this.observe() });
        }
      };
      this.changes.on('change', check); signal?.addEventListener('abort', check, { once: true }); check();
    });
  }
  request(request: PlayerRequest, id: string = randomUUID(), signal?: AbortSignal): Promise<PlayerReply> {
    const run = async (): Promise<PlayerReply> => { try { return { ok: true, value: await this.execute(request, signal) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } };
    if (['observe', 'inspect', 'quote', 'wait'].includes(request.op)) return run();
    const fingerprint = JSON.stringify(request), old = this.receipts.get(id);
    if (old) return old.fingerprint === fingerprint ? old.reply : Promise.resolve({ ok: false, error: 'Request ID already used for another intention.' });
    if (this.pending >= 16) return Promise.resolve({ ok: false, error: 'Player command queue is full.' });
    this.pending++;
    const reply = this.serial.then(async () => {
      const issuedAt = this.at, wall = performance.now(), result = await run();
      appendFileSync(join(this.options.directory, 'commands.jsonl'), JSON.stringify({ id, request, issuedAt, answeredAt: this.at,
        elapsedWallMs: Math.round(performance.now() - wall), reactionSimSeconds: 'observedAt' in request && request.observedAt !== undefined && issuedAt !== null ? issuedAt - request.observedAt : null,
        result }) + '\n');
      this.emit('command', `${request.op}: ${result.ok ? 'answered' : result.error}`);
      return result;
    }).finally(() => { this.pending--; });
    this.serial = reply.catch(() => {}); this.receipts.set(id, { fingerprint, reply });
    if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!);
    return reply;
  }
  private async execute(request: PlayerRequest, signal?: AbortSignal): Promise<unknown> {
    switch (request.op) {
      case 'observe': return this.observe();
      case 'wait': return this.wait(request, signal);
      case 'stop': this.close(); return { stopped: true };
      case 'plan': {
        this.plan = { goal: request.goal, notes: request.notes ?? '', updatedAt: new Date().toISOString(), at: this.at };
        writeFileSync(join(this.options.directory, 'plan.json'), JSON.stringify(this.plan, null, 2), { mode: 0o600 }); return this.plan;
      }
      case 'inspect': {
        this.requireReady();
        if (!this.client.faction!.units.some(u => u.id === request.actorId))
          throw new Error('Inspect accepts only constructions of this faction; other faction information is in contacts.');
        const blueprint = request.blueprint ? (await this.client.command('blueprint', { actorId: request.actorId })).actor.blueprint : undefined;
        this.requireReady();
        const unit = ownUnits(this.view).find(u => u.id === request.actorId);
        if (!unit) throw new Error('The construction left the faction roster during inspection.');
        return { at: this.at, unit, vehicle: this.scene!.actors.find(a => a.id === request.actorId)?.vehicle ?? null,
          parts: describeParts(this.scene!.modules.filter(p => p.actorId === request.actorId)),
          ...(blueprint ? { blueprint } : {}) };
      }
      case 'quote': this.requireReady(); return { at: this.at, ...quoteDesign(request.design, this.view, request.replaceId).quote };
      case 'build': {
        this.requireReady(); const { source, quote } = quoteDesign(request.design, this.view, request.replaceId);
        const data = { blueprint: source, ...(request.replaceId ? { actorId: request.replaceId } : {}),
          ...(request.x === undefined ? {} : { x: request.x }), ...(request.facing === undefined ? {} : { facing: request.facing }) };
        const result = await this.client.command(request.replaceId ? 'replace' : 'spawn', data);
        if (result.actor) this.client.designs.set(result.actor.id, result.actor);
        return { quote, result };
      }
      case 'speed': {
        this.requireReady(); if (!this.client.testTools) throw new Error('Clock control requires a test server.');
        return this.client.command('test', { act: 'speed', factor: request.factor });
      }
      case 'order': this.requireReady(); return this.order(request.action);
    }
  }
  private async order(action: PlayerAction): Promise<unknown> {
    switch (action.kind) {
      case 'free': case 'turn': return this.client.command('squad', { order: action.kind, ids: action.ids });
      case 'move': case 'attack': case 'bombard': case 'haul': case 'home': case 'stop': case 'stance': {
        const { kind, ...data } = action; return this.client.command('squad', decodeSquadCommand({ order: kind, ...data }));
      }
      case 'auto': case 'homing': case 'repair': case 'cancel-repair': case 'remove': case 'cancel-dismantle': case 'abandon': case 'dump-cargo': {
        const answers = [];
        for (const actorId of action.ids) try {
          const data = 'on' in action ? { actorId, on: action.on } : { actorId };
          answers.push({ actorId, ok: true, result: await this.client.command(action.kind, data) });
        } catch (error) { answers.push({ actorId, ok: false, error: error instanceof Error ? error.message : String(error) }); }
        return answers;
      }
      case 'recover': return this.client.command('recover');
      case 'salvage': return this.client.command('salvage', { wreckId: action.wreckId });
      case 'upgrade': return this.client.command('upgrade', { id: action.id });
      case 'cancel-upgrade': return this.client.command('cancel-upgrade', { id: action.id });
      case 'road': return this.client.command('road', { x0: action.x0, x1: action.x1, kind: action.roadKind });
      case 'cancel-road': return this.client.command('cancel-road', { roadId: action.roadId });
      case 'cancel-work': return this.client.command('cancel-work', { workId: action.workId });
      case 'post': return this.client.command('post', { x: action.x, ...(action.facing === undefined ? {} : { facing: action.facing }) });
      case 'remove-post': case 'keep-post': return this.client.command(action.kind, { postId: action.postId });
      case 'tow': return this.client.command('tow', { act: 'attach', actorId: action.actorId, targetId: action.targetId });
      case 'unhook': return this.client.command('tow', { act: 'detach', actorId: action.actorId });
    }
  }
  close() {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.timer);
    this.client.enabled = false; clearTimeout(this.client.reconnectTimer); this.client.closeSocket(undefined, 1000);
    this.emit('connection', 'Bridge stopped; normal player disconnect'); this.changes.emit('change');
  }
}
