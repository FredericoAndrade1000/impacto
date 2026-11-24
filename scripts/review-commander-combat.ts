// Declared encounters, ordinary stocks/equipment/fog and the real 60 Hz host.
// Every case has a Native snapshot baseline and a diary usable by replay:viewer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SharedRoom } from '../server/room.ts';
import { FieldHost } from '../server/field-host.ts';
import { observeCommander } from '../server/commander-observation.ts';
import { isDefender } from '../server/commander-units.ts';
import { writeField } from '../server/field-snapshot.ts';
import type { CommanderObservation, CommanderProfile } from '../server/commander-contract.ts';
import type { GroundOperation } from '../server/commander-contract.ts';
import type { IndustryLevels } from '../src/industry.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { SceneEventBase } from '../src/scene-contract.ts';
import { STARTING_STOCK, STOCK_IDS, bill } from '../src/economy.ts';
import { initNativeDynamics, nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';

interface Scenario {
  id: string; name: string; kind: 'incursion' | 'arena' | 'capture' | 'duel' | 'supply'; positions: number[];
  profiles: CommanderProfile[]; entrySlots: number[];
  stock?: SupplyBill; industry?: IndustryLevels;
}
const SCENARIOS: Scenario[] = [
  { id: 'incursion', name: 'Defesa da base contra incursão', kind: 'incursion', positions: [-1200, 1200], profiles: ['balanced'], entrySlots: [0] },
  { id: 'arena-a', name: 'Quatro IAs · disposição A', kind: 'arena', positions: [-2400, -800, 800, 2200],
    profiles: ['balanced', 'cautious', 'cautious', 'balanced'], entrySlots: [0, 1, 2, 3] },
  { id: 'arena-b', name: 'Quatro IAs · disposição B', kind: 'arena', positions: [-2400, -800, 800, 2200],
    profiles: ['cautious', 'balanced', 'balanced', 'cautious'], entrySlots: [3, 2, 1, 0] },
  { id: 'capture', name: 'Operação terrestre · captura e retorno', kind: 'capture', positions: [-1800, 1800],
    profiles: ['balanced'], entrySlots: [0], stock: bill(400000, 10000, 10000, 4000), industry: { workshop: 2, hangar: 0, processing: 1 } },
  { id: 'duel', name: 'Operações terrestres · duas IAs ativas', kind: 'duel', positions: [-1800, 1800],
    profiles: ['balanced', 'cautious'], entrySlots: [0, 1], stock: bill(400000, 10000, 10000, 4000), industry: { workshop: 2, hangar: 0, processing: 1 } },
  { id: 'duel-b', name: 'Operações terrestres · perfis trocados', kind: 'duel', positions: [-1800, 1800],
    profiles: ['cautious', 'balanced'], entrySlots: [0, 1], stock: bill(400000, 10000, 10000, 4000), industry: { workshop: 2, hangar: 0, processing: 1 } },
  { id: 'supply', name: 'Recuperação de Sílica com um minerador', kind: 'supply', positions: [-4200],
    profiles: ['balanced'], entrySlots: [0], stock: bill(150000, 10000, 1000, 3000), industry: { workshop: 2, hangar: 0, processing: 1 } },
];
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name); if (index < 0) return undefined;
  const value = process.argv[index + 1]; assert(value && !value.startsWith('--'), `${name} needs a value`); return value;
}
const seconds = Number(option('--seconds') ?? 600), selected = option('--scenario') ?? 'combat',
  scenarios = SCENARIOS.filter(scenario => selected === 'all' || scenario.id === selected ||
    selected === 'combat' && (scenario.kind === 'incursion' || scenario.kind === 'arena') ||
    selected === 'operations' && (scenario.kind === 'capture' || scenario.kind === 'duel')),
  root = resolve(option('--out') ?? 'validation/commander-combat-20261103'), within = relative(resolve('validation'), root);
assert(Number.isInteger(seconds) && seconds >= 120 && seconds <= 3600, 'Use 120–3600 simulation seconds.');
assert(scenarios.length, 'Unknown combat scenario.');
assert(within && !within.startsWith('..') && !isAbsolute(within), 'Use a dedicated directory inside validation.');
await initNativeDynamics(); assert.equal(nativeDynamicsRuntime, 'native', 'Combat experiments require Native dynamics.');
mkdirSync(root, { recursive: true });
const sourceFiles = ['scripts/review-commander-combat.ts', 'server/field-host.ts', 'server/room.ts', 'server/commander-policy.ts',
  'server/commander-tactics.ts', 'server/commander-defense.ts', 'server/commander-operations.ts', 'server/commander-observation.ts', 'server/faction-commander.ts', 'src/squad.ts'];
const provenance = { native: nativeRuntimeInfo(), sources: Object.fromEntries(sourceFiles.map(file =>
  [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) };

function experiment(scenario: Scenario) {
  const directory = join(root, scenario.id); assert(!existsSync(directory), `Preserve the existing capture: ${directory}`);
  mkdirSync(join(directory, 'replays'), { recursive: true });
  const room = new SharedRoom({ ...(scenario.stock ? { stock: scenario.stock } : {}), ...(scenario.industry ? { industry: scenario.industry } : {}),
      base: index => scenario.positions[scenario.entrySlots[index] ?? index] }),
    host = new FieldHost(room), started = performance.now(), draws = ['0011223344556677', '8899aabbccddeeff', '1a2b3c4d5e6f7081', '91a2b3c4d5e6f708'];
  try {
    const seats = scenario.profiles.map((profile, index) => {
      const seat = host.addCommander(`IA ${index + 1} · ${profile}`, profile, draws[index]);
      return { playerId: seat.id, factionId: seat.factionId, profile: profile as CommanderProfile | null };
    });
    let invaderId: string | null = null, invaderFrom: number | null = null, destination: number | null = null;
    if (scenario.kind === 'incursion' || scenario.kind === 'capture') {
      const raider = host.enter('Incursora de teste', null, null, draws[1]!);
      seats.push({ playerId: raider.playerId, factionId: room.players.get(raider.playerId)!.factionId!, profile: null });
      const actor = room.owned(raider.playerId).find(actor => actor.vehicle && actor.blueprint.modules.some(part => part.kind === 'weapon'));
      assert(actor); invaderId = actor.id; invaderFrom = room.position(actor); destination = scenario.positions[0]! + 60;
    }
    for (const seat of seats) {
      assert.deepEqual(room.factions.get(seat.factionId)!.stock, scenario.stock ?? STARTING_STOCK);
      assert.equal(room.owned(seat.playerId).length, 3, 'Only the normal starting kit.');
    }
    // Only the starting positions are fixed. Further founding uses the normal
    // rule; no unserializable placement/random closure is left in the baseline.
    room.site = null;
    host.lines = []; host.dir = join(directory, 'replays');
    host.begin({ origin: null, snapshot: writeField(room, host.publication) });
    if (invaderId) {
      const raider = seats.at(-1)!;
      host.command(raider.playerId, { type: 'squad', order: 'stance', ids: [invaderId], stance: scenario.kind === 'capture' ? 'hold' : 'fire' });
      if (scenario.kind === 'incursion') host.command(raider.playerId, { type: 'squad', order: 'move', ids: [invaderId], x: destination });
    }
    const factions = seats.map(seat => ({ ...seat, baseX: room.factions.get(seat.factionId)!.base!.x,
      muzzleEvents: 0, firstShotAt: null as number | null, primaryDamageGiven: 0, primaryDamageTaken: 0,
      sampledHealthLost: 0, firstSeenAt: null as number | null })),
      byFaction = new Map(factions.map(faction => [faction.factionId, faction])), owners = new Map<string, string>(),
      contacts = new Map<string, { from: string; to: string; contacts: number; damage: number; firstAt: number; lastAt: number }>(),
      losses: { at: number; actorId: string; factionId: string; kind: string }[] = [], retired = new Set<string>(),
      health = new Map(room.world.modules.map(part => [part.id, part.health])),
      decisions: { playerId: string; trace: unknown }[] = [], traced = new Map<string, number>(),
      highlights: { time: number; type: string; actorId: string; x: number; y?: number }[] = [], samples: unknown[] = [],
      operations: { at: number; playerId: string; operation: GroundOperation | null;
        observed: Pick<CommanderObservation, 'stock' | 'bases' | 'threats' | 'units'> }[] = [], phaseKeys = new Map<string, string>();
    const initialArmed = new Set(room.owned(seats[0]!.playerId).filter(actor => actor.blueprint.modules.some(part => part.kind === 'weapon')).map(actor => actor.id));
    let eventCursor = 0, invaderNearest = Infinity, objectiveAt: number | null = null, endedBy: 'objective' | 'time-limit' = 'time-limit';
    let assaultIds: string[] = [];
    const rememberOwners = () => { for (const actor of room.world.actors) if (actor.team) owners.set(actor.id, actor.team); };
    rememberOwners();
    function observeEvents(): void {
      room.world.game().sync(); rememberOwners();
      const events = room.world.events; if (events.length < eventCursor) eventCursor = 0;
      for (let i = eventCursor; i < events.length; i++) {
        const event: SceneEventBase = events[i]!, time = event.time ?? room.world.time;
        if (event.type === 'muzzle' && event.actorId) {
          const faction = byFaction.get(owners.get(event.actorId) ?? '');
          if (faction) {
            faction.muzzleEvents++;
            if (faction.firstShotAt === null) {
              faction.firstShotAt = time; const actor = room.world.actor(event.actorId);
              if (actor) highlights.push({ time, type: 'first-shot', actorId: actor.id, x: room.position(actor), ...(actor.y === undefined ? {} : { y: actor.y }) });
            }
          }
        }
        const from = event.shooterActorId && owners.get(event.shooterActorId),
          to = (event.targetActorId && owners.get(event.targetActorId)) || (event.actorId && owners.get(event.actorId));
        if (!event.primaryContact || !from || !to || from === to || !byFaction.has(from) || !byFaction.has(to)) continue;
        const key = from + ':' + to, damage = Math.max(0, event.damage ?? 0),
          contact = contacts.get(key) ?? { from, to, contacts: 0, damage: 0, firstAt: time, lastAt: time };
        contact.contacts++; contact.damage += damage; contact.lastAt = time; contacts.set(key, contact);
        byFaction.get(from)!.primaryDamageGiven += damage; byFaction.get(to)!.primaryDamageTaken += damage;
      }
      eventCursor = events.length;
    }
    for (let tick = 0; tick < seconds * 60; tick++) {
      host.step(() => 1, observeEvents); observeEvents();
      const now = room.world.time;
      for (const seat of seats) {
        const operation = room.commanders.get(seat.playerId)?.operation ?? null, key = JSON.stringify(operation);
        if (key !== (phaseKeys.get(seat.playerId) ?? 'null')) {
          const observation = observeCommander(room, seat.playerId);
          operations.push({ at: now, playerId: seat.playerId, operation: structuredClone(operation), observed: {
            stock: observation.stock, bases: observation.bases, threats: observation.threats, units: observation.units.filter(isDefender) } });
          phaseKeys.set(seat.playerId, key);
          if (seat.playerId === seats[0]!.playerId && operation && operation.phase !== 'prepare') assaultIds = [...operation.unitIds];
        }
        const trace = room.commanders.get(seat.playerId)?.history.at(-1);
        if (trace && trace.at > (traced.get(seat.playerId) ?? -Infinity)) {
          decisions.push({ playerId: seat.playerId, trace: structuredClone(trace) }); traced.set(seat.playerId, trace.at);
        }
      }
      if ((tick + 1) % 60 === 0) {
        for (const faction of factions) {
          const state = room.factions.get(faction.factionId)!;
          assert(STOCK_IDS.every(id => Number.isFinite(state.stock[id]) && state.stock[id] >= -1e-6), 'Finite stock without debt.');
          if (state.met.size) faction.firstSeenAt ??= now;
        }
        for (const part of room.world.modules) {
          const before = health.get(part.id), faction = byFaction.get(owners.get(part.actorId) ?? '');
          if (before !== undefined && faction) faction.sampledHealthLost += Math.max(0, before - part.health);
          health.set(part.id, part.health);
        }
        for (const [id, factionId] of owners) {
          if (retired.has(id)) continue;
          const actor = room.world.actor(id), kind = !actor ? 'removed' : actor.defeated || room.records.get(id)?.wreck ? 'wreck' : null;
          if (kind) { retired.add(id); losses.push({ at: now, actorId: id, factionId, kind }); }
        }
        if (invaderId) {
          const actor = room.world.actor(invaderId);
          if (actor) invaderNearest = Math.min(invaderNearest, Math.abs(room.position(actor) - scenario.positions[0]!));
        }
      }
      if ((tick + 1) % 600 === 0) samples.push({ time: now,
        factions: factions.map(f => ({ id: f.factionId, stock: { ...room.factions.get(f.factionId)!.stock }, shots: f.muzzleEvents })),
        operations: seats.map(seat => ({ playerId: seat.playerId, operation: structuredClone(room.commanders.get(seat.playerId)?.operation ?? null) })),
        actors: room.world.actors.map(actor => ({ id: actor.id, team: actor.team, x: room.position(actor), defeated: Boolean(actor.defeated),
          stance: actor.ownerId ? room.players.get(actor.ownerId)?.squad?.units.get(actor.id)?.stance : null })) });
      const humans = seats.filter(seat => seat.profile === null).map(seat => seat.playerId);
      if (humans.length && tick % 6 === 0) { host.tell(humans); eventCursor = 0; }
      if ((tick + 1) % 3600 === 0) console.log(JSON.stringify({ scenario: scenario.id, time: Math.round(now), shots: factions.map(f => f.muzzleEvents),
        operations: seats.map(seat => room.commanders.get(seat.playerId)?.operation?.phase ?? null), faults: [...room.faults] }));
      if (scenario.kind === 'capture' && (tick + 1) % 60 === 0) {
        const attacker = room.factions.get(seats[0]!.factionId)!;
        if (attacker.taken?.of === seats[1]!.factionId) objectiveAt ??= now;
        if (objectiveAt !== null && room.commanders.get(seats[0]!.playerId)!.operation === null && assaultIds.length === 2 &&
          assaultIds.every(id => { const actor = room.world.actor(id), order = room.players.get(seats[0]!.playerId)?.squad?.units.get(id);
            return actor && room.atBase(attacker, actor) && !order?.move; })) { endedBy = 'objective'; break; }
      }
      if (scenario.kind === 'supply' && (tick + 1) % 60 === 0 &&
        observeCommander(room, seats[0]!.playerId).units.some(unit => isDefender(unit) && !initialArmed.has(unit.id) && unit.ready)) {
        objectiveAt = now; endedBy = 'objective'; break;
      }
    }
    host.flush(); host.diary?.close(); host.diary = null;
    assert.equal(room.faults.size, 0, [...room.faults].join('\n'));
    const result = { scenario, seconds: room.world.time, requestedSeconds: seconds, endedBy, objectiveAt, operations, digest: room.digest(), wallSeconds: (performance.now() - started) / 1000,
      method: { physicsHz: 60, normalStartingStock: !scenario.stock, normalKit: true, fog: true,
        advancedStart: scenario.stock ? { stock: scenario.stock, industry: scenario.industry,
          conditions: 'Declared initial capital, ordinary three-vehicle kit, normal paid production/services, no resources added during simulation.' } : null,
        commandsAfterBaseline: scenario.kind === 'arena' || scenario.kind === 'duel' || scenario.kind === 'supply' ? 'Only autonomous commanders.' : scenario.kind === 'capture' ?
          'Only the target scout receives Hold fire. The attacker performs all reconnaissance, purchases, movements, occupation and return autonomously.' :
          'One initial normal Move and Fire-at-will order for the raider; no commands to the defending commander.',
        limits: 'Compact overlapping territories are combat diagnostics, not progression balance or a general policy ranking. Primary component-contact damage excludes unreported armour, fire and blast damage. Losses identify victims, not killers.' },
      invader: invaderId ? { id: invaderId, from: invaderFrom, destination, nearestToDefendedBase: invaderNearest } : null,
      factions, contacts: [...contacts.values()], losses, highlights, decisions, samples,
      finalObservations: seats.filter(seat => seat.profile).map(seat => observeCommander(room, seat.playerId)), faults: [...room.faults],
      combatObserved: [...contacts.values()].some(contact => contact.damage > 0) };
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ scenario: scenario.id, seconds: result.seconds, endedBy, objectiveAt, wallSeconds: result.wallSeconds, shots: factions.map(f => f.muzzleEvents),
      primaryDamage: factions.map(f => f.primaryDamageGiven), losses: losses.length, phases: operations.map(row => row.operation?.phase ?? 'done'), combatObserved: result.combatObserved }));
    if (scenario.kind === 'incursion' || scenario.kind === 'arena') assert(result.combatObserved && factions.some(f => f.muzzleEvents > 0), 'The scenario must actually exercise shots and opposing damage.');
    return result;
  } finally { host.diary?.close(); room.world.dispose(); }
}
const cases = scenarios.map(experiment);
writeFileSync(join(root, 'report.json'), JSON.stringify({ at: new Date().toISOString(), provenance, cases }, null, 2));
