import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { FrameWriter, tellEvent } from '../src/network-protocol.ts';
import { REPLAY_CHUNK_SECONDS, REPLAY_FPS, REPLAY_VERSION } from '../src/replay-contract.ts';
import type { ReplayArchive, ReplayChunk, ReplayMarker, ReplayTelemetry } from '../src/replay-contract.ts';
import type { SceneEventBase } from '../src/scene-contract.ts';
import type { FactionView } from '../src/field-contract.ts';
import { BASE_RADIUS } from '../src/economy.ts';
import { duelView } from '../src/duel.ts';
import { Publication } from './publication.ts';
import { FieldHost, openRoom } from './field-host.ts';
import type { ReplayObservation, ReplayOutcome } from './field-host.ts';
import { copyField, readField, writeField } from './field-snapshot.ts';
import type { FieldProjection, FieldSnapshot } from './field-snapshot.ts';

// Render copies are never stepped. Keep the complete native scene, orders
// and visible metadata, excluding fog/strategy caches and past blueprints.
function rendered({ room }: FieldHost): FieldProjection {
  const factions = new Set<object>(room.factions.values()), players = new Set<object>(room.players.values()),
    commanders = new Set<object>(room.commanders.values()), keys = (object: object, allowed: readonly string[]) => Object.keys(object).filter(key => allowed.includes(key));
  return {
    keys(object) {
      if (object === room) return keys(object, ['field', 'steps', 'fieldId', 'sites', 'site', 'random', 'players', 'factions', 'commanders', 'duel']);
      if (factions.has(object)) return keys(object, ['id', 'leader', 'members', 'stock', 'base', 'nation', 'flag', 'shelter']);
      if (players.has(object)) return keys(object, ['id', 'token', 'name', 'color', 'connected', 'factionId', 'squad']);
      if (commanders.has(object)) return keys(object, ['enabled', 'history']);
      return Object.keys(object);
    },
    value(object, key, value) { return commanders.has(object) && key === 'history' && Array.isArray(value) ? value.slice(-1) : value; },
  };
}

export const replayChunkFile = (index: number): string => `chunk-${index}.bin.gz`;

function telemetry(host: FieldHost): ReplayTelemetry {
  const room = host.room;
  return {
    factions: [...room.factions.values()].map(faction => {
      const leader = room.players.get(faction.leader), state = leader && room.commanders.get(leader.id);
      return { id: faction.id, name: room.named(faction), color: leader?.color ?? '#aabb99', base: faction.base?.x ?? null,
        ...(room.duel ? { duel: duelView(room.duel, faction.id) } : {}),
        stock: { ...faction.stock }, ai: Boolean(state), reason: state?.history.at(-1)?.reason ?? null };
    }),
    units: room.field.actors.map(actor => {
      const owner = actor.ownerId ? room.players.get(actor.ownerId) : undefined, order = owner?.squad?.units.get(actor.id),
        parts = room.field.modules.filter(part => part.actorId === actor.id);
      return { id: actor.id, factionId: actor.team ?? null, name: actor.name,
        order: order?.attack ? 'attack' : order?.haul ? 'haul' : order?.move?.purpose === 'home' ? 'home' : order?.move ? 'move' : 'idle',
        goal: order?.move?.x ?? null, activity: order?.activity ?? '', reason: order?.halt || order?.reason || '',
        health: parts.length ? parts.reduce((sum, part) => sum + Math.max(0, part.health / Math.max(part.maxHealth, 1e-9)), 0) / parts.length : 0,
        fuel: parts.reduce((sum, part) => sum + (part.kind === 'fuel' ? part.fuelLitres : 0), 0) };
    }),
  };
}

// A separate publication/codec never participates in recorded tell(), fog,
// commands, event draining or native state mutation. Frames stay provisional
// until the diary's next print has passed its ordinary equality check.
export class ReplayRecording {
  readonly publication = new Publication();
  writer = new FrameWriter();
  readonly chunks: ReplayChunk[] = [];
  readonly markers: ReplayMarker[] = [];
  private staged: { time: number; packet: Buffer }[] = [];
  private packets: Buffer[] = [];
  private pending: SceneEventBase[] = [];
  private eventCursor = 0;
  private lastSample = -Infinity;
  private from = 0;
  private to = 0;
  private count = 0;
  private totalBytes = 0;
  private lastTelemetry = -Infinity;
  private telemetryDirty = true;
  private resultMarked = false;
  private status: ReplayTelemetry = { factions: [], units: [] };
  private traces = new Map<string, number>();
  private defeated = new Set<string>();
  private structures = new Set<string>();
  private bases = new Set<string>();
  private observerBases: FactionView['bases'] = [];
  private lastShot = -Infinity;
  private boundary: { snapshot: FieldSnapshot; cursor: number; pending: SceneEventBase[] } | null = null;
  private readingCopy = false;
  private copy: FieldHost | null = null;
  start = 0;
  verifiedTo = 0;

  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  observe(host: FieldHost, phase: ReplayObservation): void {
    const room = host.room, world = room.field, now = world.time;
    if (phase === 'ready') {
      this.start = this.verifiedTo = now;
      for (const [id, state] of room.commanders) this.traces.set(id, state.history.at(-1)?.at ?? -Infinity);
    }
    if (phase === 'before-tell') {
      // tell() synchronizes here anyway; quiet cleanup only drains the JS queue.
      world.game().sync();
    } else if (phase === 'ready' && world.game().stale) {
      this.isolated(host, copy => this.privateFrame(copy, 'ready')); return;
    }
    if (!this.readingCopy) this.events(host);
    if (room.duel && room.duel.phase !== 'playing' && !this.resultMarked) {
      this.resultMarked = true; this.telemetryDirty = true;
      for (const factionId of room.duel.sides) this.marker({ kind: 'decision', time: Math.max(this.start, room.duel.at),
        label: 'duel-' + duelView(room.duel, factionId).phase, factionId });
    }
    for (const [id, state] of room.commanders) {
      const trace = state.history.at(-1);
      if (!trace || trace.at <= (this.traces.get(id) ?? -Infinity)) continue;
      this.traces.set(id, trace.at);
      this.telemetryDirty = true;
      const factionId = room.players.get(id)?.factionId;
      if (trace.action && trace.result === 'applied') this.marker({ time: trace.at, kind: 'decision', label: trace.reason,
        ...('unitId' in trace.action && trace.action.unitId ? { actorId: trace.action.unitId } : {}), ...(factionId ? { factionId } : {}) });
    }
    // A quiet step deliberately leaves native events unread. Reading a frame
    // here would deliver those events to the room earlier than its diary did.
    // Sample only projections already read by an ordinary command or drain.
    if (!world.game().stale && (phase === 'ready' || now - this.lastSample >= 1 / REPLAY_FPS - 1e-8)) {
      const state = world.snapshot((frame, sources) => this.publication.state(frame, sources));
      if (!this.readingCopy) this.events(host);
      for (const actor of state.actors) if (actor.defeated && !this.defeated.has(actor.id)) {
        this.defeated.add(actor.id);
        // A chapter starts with the wrecks it inherited. Only a later defeat
        // is a new loss; a rewound chapter can start with that actor alive again.
        if (phase !== 'ready') this.marker({ time: now, kind: 'loss', label: actor.name ?? actor.id, actorId: actor.id, ...(actor.team ? { factionId: actor.team } : {}) });
      }
      const rosterChanged = state.actors.length !== this.status.units.length || room.factions.size !== this.status.factions.length ||
        state.actors.some((actor, i) => actor.id !== this.status.units[i]?.id);
      if (this.telemetryDirty || now - this.lastTelemetry >= .5 || rosterChanged) {
        this.status = telemetry(host); this.lastTelemetry = now; this.telemetryDirty = false;
        this.observerBases = [...room.factions.values()].flatMap(faction => faction.base ? [{ id: faction.id, name: room.named(faction),
          nation: faction.nation, flag: faction.flag, x: faction.base.x, facing: faction.base.facing, radius: BASE_RADIUS,
          seen: true, at: null, sheltered: faction.shelter !== null }] : []);
      }
      for (const actor of state.actors) if (actor.preset === 'bunker' && !this.structures.has(actor.id)) {
        this.structures.add(actor.id); this.marker({ kind: 'structure', time: now, label: actor.name ?? actor.id,
          actorId: actor.id, x: actor.x, ...(actor.y === undefined ? {} : { y: actor.y }), ...(actor.team ? { factionId: actor.team } : {}) });
      }
      for (const base of this.observerBases) if (!this.bases.has(base.id)) {
        this.bases.add(base.id); this.marker({ kind: 'base', time: now, label: base.name, factionId: base.id, x: base.x });
      }
      const encoded = this.writer.encode({ state: { ...state, shared: false, observerBases: this.observerBases, players: room.roster(),
        ...(state.shots ? { shots: { ...state.shots, drag: world.shotDrags } } : {}) }, events: this.pending, telemetry: this.status });
      this.pending = [];
      const payload = Buffer.from(encoded), packet = Buffer.allocUnsafe(4 + payload.length);
      packet.writeUInt32LE(payload.length); payload.copy(packet, 4);
      this.staged.push({ time: now, packet }); this.lastSample = now;
    }
    // A field without publications still needs regular visual samples. Copy at
    // most ten times a second; events remain on the original diary's read path.
    if (phase === 'step' && world.game().stale && now - this.lastSample >= .1 - 1e-8) {
      this.isolated(host, copy => this.privateFrame(copy, 'input'));
    }
    if (phase === 'ready' || phase === 'step' && room.steps % 60 === 0) {
      this.confirm(now);
      this.boundary = typeof world.dynamics?.core.export_state === 'function' ?
        { snapshot: this.checkpoint(host), cursor: this.eventCursor, pending: [...this.pending] } : null;
    }
  }

  private events(host: FieldHost): void {
    const events = host.room.field.events;
    if (events.length < this.eventCursor) this.eventCursor = 0;
    for (let i = this.eventCursor; i < events.length; i++) {
      const event = events[i]!;
      if ((event.time ?? host.room.field.time) < this.start - 1e-8) continue;
      this.pending.push(tellEvent(event));
      if (event.type === 'muzzle' && (event.time ?? host.room.field.time) - this.lastShot >= 1) {
        this.lastShot = event.time ?? host.room.field.time;
        this.marker({ time: this.lastShot, kind: 'shot', label: 'shot', ...(event.actorId ? { actorId: event.actorId } : {}) });
      }
    }
    this.eventCursor = events.length;
  }
  private marker(marker: ReplayMarker): void { if (this.markers.length < 5000) this.markers.push(marker); }
  private privateFrame(copy: FieldHost, phase: ReplayObservation): void {
    this.readingCopy = true;
    try { this.observe(copy, phase); } finally { this.readingCopy = false; }
  }
  private checkpoint(host: FieldHost): FieldSnapshot {
    return writeField(host.room, new Publication(), rendered(host));
  }
  private isolated(host: FieldHost, read: (copy: FieldHost) => void, snapshot?: FieldSnapshot): void {
    // Boundary frames may still be quiet. Synchronize a private checkpoint,
    // preserving the replay's pending events and native export cursors exactly.
    // A copy of the field as it stands is not written out (copyField); a checkpoint kept for later is.
    const copy = this.copy ??= new FieldHost(openRoom(host.field), { field: host.field, diary: false });
    try {
      copy.publication = snapshot ? readField(copy.room, snapshot) : copyField(host.room, new Publication(), copy.room, rendered(host));
      copy.room.field.game().sync(); read(copy);
    } catch (error) { copy.room.field.dispose(); this.copy = null; throw error; }
  }
  private confirm(time: number): void {
    this.verifiedTo = time;
    for (const frame of this.staged) {
      if (!this.count) this.from = frame.time;
      this.to = frame.time; this.count++; this.packets.push(frame.packet);
    }
    this.staged = [];
    if (this.count && this.to - this.from >= REPLAY_CHUNK_SECONDS) this.flush();
  }
  private flush(): void {
    if (!this.count) return;
    const raw = Buffer.concat(this.packets);
    if (raw.length > 64 * 1024 * 1024) throw new Error('O trecho visual excede o limite de memória.');
    const bytes = gzipSync(raw, { level: 3 }); this.totalBytes += bytes.length;
    if (this.totalBytes > 512 * 1024 * 1024) throw new Error('O replay visual excede o limite de tamanho.');
    const index = this.chunks.length;
    writeFileSync(join(this.directory, replayChunkFile(index)), bytes, { flag: 'wx' });
    this.chunks.push({ index, from: this.from, to: this.to, frames: this.count, bytes: bytes.length });
    this.count = 0; this.packets = []; this.writer.close(); this.writer = new FrameWriter();
  }
  finish(outcome: ReplayOutcome, id: string, name: string): ReplayArchive {
    this.staged = [];
    if (this.boundary) {
      const boundary = this.boundary;
      this.flush();
      this.isolated(outcome.host, copy => {
        // An independent whole frame cannot depend on discarded provisional
        // packets, and the frozen print excludes later unconfirmed commands.
        const ending = new ReplayRecording(this.directory);
        ending.start = this.start; ending.eventCursor = boundary.cursor; ending.pending = [...boundary.pending];
        ending.observe(copy, 'input');
        const frame = ending.staged[0];
        if (!frame) throw new Error('Quadro final do replay ausente.');
        this.from = this.to = frame.time; this.count = 1; this.packets = [frame.packet];
        ending.writer.close();
      }, boundary.snapshot);
    }
    this.staged = []; this.flush(); this.writer.close();
    this.copy?.room.field.dispose(); this.copy = null;
    return { version: REPLAY_VERSION, id, name, start: this.start, end: this.verifiedTo, fps: REPLAY_FPS,
      status: outcome.how === 'diverged' ? 'diverged' : outcome.how === 'fell' ? 'fell' : 'verified',
      prints: outcome.prints, stoppedAt: outcome.host.room.field.time,
      detail: outcome.how === 'diverged' ? `Divergência no passo ${outcome.step}.` : outcome.how === 'fell' ? String(outcome.error) : null,
      chunks: this.chunks, markers: this.markers.filter(marker => marker.time <= this.verifiedTo) };
  }
}
