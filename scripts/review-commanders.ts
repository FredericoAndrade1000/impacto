// Autonomous factions using normal admission, fog, stocks and Native physics.
// Controlled initial depletion/losses are declared; no orders are supplied by
// this runner after creation. The two-policy race is economic, not a PvP rating.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { SharedRoom } from '../server/room.ts';
import { startActivities, AIRDROP } from '../server/world-activities.ts';
import { observeCommander } from '../server/commander-observation.ts';
import { chooseCommanderAction } from '../server/commander-policy.ts';
import { carriedBy, supplied, extracts, hauls, RAW_IDS, STOCK_IDS, STARTING_STOCK, LOAD_REACH, bill, billSum, load } from '../src/economy.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';
import { initNativeDynamics, nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import type { CommanderProfile } from '../server/commander-contract.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { SceneActor } from '../src/scene-contract.ts';

await initNativeDynamics(); assert.equal(nativeDynamicsRuntime, 'native', 'Commander experiments require Native dynamics');
const STEADY = { pace: () => 1 }, OUTPUTS = ['validation/commander-20261102', 'validation/commander-20261103'].map(path => resolve(path));
const runnerSHA256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const strategySources = Object.fromEntries(['commander-contract.ts', 'commander-policy.ts', 'commander-tactics.ts', 'commander-units.ts',
  'commander-observation.ts', 'faction-commander.ts', 'room.ts', 'room-limits.ts', 'world-activities.ts']
  .map(file => [file, createHash('sha256').update(readFileSync(new URL('../server/' + file, import.meta.url))).digest('hex')]));
interface Scenario {
  id: string; group: 'opening' | 'depleted' | 'miner-loss' | 'carrier-loss' | 'mobile-miner-after-plant-loss' | 'tanker-loss' | 'fuel-bootstrap' | 'competition' | 'activities' | 'arena-normal' | 'arena-frontier' | 'arena-compact';
  eventMode: 'none' | 'live-scheduled'; seed: number; profiles: CommanderProfile[];
  initialStock?: SupplyBill;
  arena?: { family: 'normal' | 'frontier' | 'compact'; arrangement: 'a' | 'b'; entrySlots: number[]; profileBySlot: CommanderProfile[]; positions?: number[] };
}
interface CarrierDelivery { at: number; actorId: string; siteId: string; mineId: string; iron: number }
interface Loss { at: number; actorId: string; cargo: ReturnType<typeof load>; supplies: SupplyBill; fuelLitres: number; stock: SupplyBill; ironDelivered: number }
function arenaScenario(family: 'normal' | 'frontier' | 'compact', arrangement: 'a' | 'b'): Scenario {
  const profileBySlot: CommanderProfile[] = arrangement === 'a' ? ['balanced', 'cautious', 'cautious', 'balanced'] : ['cautious', 'balanced', 'balanced', 'cautious'],
    entrySlots = family !== 'normal' && arrangement === 'b' ? [3, 2, 1, 0] : [0, 1, 2, 3];
  return { id: `arena-${family}-${arrangement}`, group: `arena-${family}`, eventMode: 'none', seed: 1234,
    profiles: entrySlots.map(slot => profileBySlot[slot]!),
    arena: { family, arrangement, entrySlots, profileBySlot,
      ...(family === 'frontier' ? { positions: [-14800, -4800, 5200, 15200] } : family === 'compact' ? { positions: [-2400, -800, 800, 2200] } : {}) } };
}
const SCENARIOS: Scenario[] = [
  ...[7, 1234, 987654].map(seed => ({ id: `opening-${seed}`, group: 'opening' as const, eventMode: 'none' as const, seed, profiles: ['balanced' as const] })),
  { id: 'depleted', group: 'depleted', eventMode: 'none', seed: 1234, profiles: ['balanced'] },
  { id: 'miner-loss', group: 'miner-loss', eventMode: 'none', seed: 1234, profiles: ['balanced'] },
  { id: 'carrier-loss', group: 'carrier-loss', eventMode: 'none', seed: 1234, profiles: ['balanced'] },
  { id: 'mobile-miner-after-plant-loss', group: 'mobile-miner-after-plant-loss', eventMode: 'none', seed: 1234, profiles: ['balanced'] },
  { id: 'tanker-loss', group: 'tanker-loss', eventMode: 'none', seed: 1234, profiles: ['balanced'] },
  { id: 'fuel-bootstrap', group: 'fuel-bootstrap', eventMode: 'none', seed: 1234, profiles: ['balanced'], initialStock: bill(30000, 10000, 10000, 250) },
  { id: 'competition-balanced-first', group: 'competition', eventMode: 'none', seed: 1234, profiles: ['balanced', 'cautious'] },
  { id: 'competition-cautious-first', group: 'competition', eventMode: 'none', seed: 1234, profiles: ['cautious', 'balanced'] },
  { id: 'live-activities', group: 'activities', eventMode: 'live-scheduled', seed: 1234, profiles: ['balanced'] },
  ...(['normal', 'frontier'] as const).flatMap(family => (['a', 'b'] as const).map(arrangement => arenaScenario(family, arrangement))),
  ...(['a', 'b'] as const).map(arrangement => arenaScenario('compact', arrangement)),
];
function option(name: string): string | undefined {
  const at = process.argv.indexOf(name); if (at < 0) return undefined;
  const value = process.argv[at + 1]; assert(value && !value.startsWith('--'), `${name} needs a value`); return value;
}
const seconds = Number(option('--seconds') ?? 3600); assert(Number.isInteger(seconds) && seconds >= 60 && seconds <= 21600);
const selected = option('--scenario') ?? 'all', scenarios = SCENARIOS.filter(s => selected === 'all' || selected === s.group || selected === s.id ||
  selected === 'arena' && Boolean(s.arena) ||
  selected === 'loss' && (s.group === 'miner-loss' || s.group === 'carrier-loss'));
assert(scenarios.length, 'Unknown commander scenario');
const repeated = process.argv.includes('--verify-repeat');
const asRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBill = (value: unknown): value is SupplyBill => asRecord(value) && STOCK_IDS.every(id => typeof value[id] === 'number' && Number.isFinite(value[id]));

// Evaluation only: this reader never supplies observations or orders to a bot.
function arenaTelemetry(room: SharedRoom, seats: readonly { id: string; factionId: string }[]) {
  const factions = new Map(seats.map(seat => [seat.factionId, { id: seat.id, factionId: seat.factionId, shots: 0, firstShotAt: null as number | null,
    sampledModuleHealthLost: 0, attributedPrimaryDamageGiven: 0, attributedPrimaryDamageTaken: 0, unattributedModuleDamageTaken: 0 }])),
    owners = new Map<string, string>(), shotCounts = new Map<string, number>(), health = new Map<string, number>(),
    contacts = new Map<string, { from: string; to: string; primaryContacts: number; componentDamage: number; firstAt: number; lastAt: number }>(),
    losses: { at: number; actorId: string; factionId: string; abandoned: boolean }[] = [],
    meetings: { at: number; by: string; other: string }[] = [], knownMeetings = new Set<string>(),
    bases = new Map(seats.map(seat => [seat.factionId, room.factions.get(seat.factionId)!.base?.x ?? null])),
    baseChanges: { at: number; factionId: string; from: number | null; to: number | null }[] = [],
    diagnostics: { at: number; id: string; strategicDue: boolean; observation: ReturnType<typeof observeCommander>;
      state: NonNullable<ReturnType<typeof room.commanders.get>>; prospectiveChoice: ReturnType<typeof chooseCommanderAction> }[] = [], diagnosed = new Set<string>();
  type Dispute = { kind: 'orders' | 'working'; depositId: string; factions: string[]; from: number; to: number };
  const ongoing = new Map<string, Dispute>(), disputes: Dispute[] = [];
  const actorTeam = (actor: SceneActor) => { if (actor.team && factions.has(actor.team)) owners.set(actor.id, actor.team); return owners.get(actor.id); },
    countShots = (actor: SceneActor) => {
      const team = actorTeam(actor), row = team && factions.get(team), previous = shotCounts.get(actor.id) ?? 0;
      if (row) row.shots += Math.max(0, actor.stats.shots - previous);
      shotCounts.set(actor.id, actor.stats.shots);
    };
  for (const actor of room.world.actors) { actorTeam(actor); shotCounts.set(actor.id, actor.stats.shots); }
  for (const part of room.world.modules) health.set(part.id, part.health);
  const wreck = room.wreck.bind(room);
  room.wreck = (actor, abandoned = false) => {
    countShots(actor);
    const team = actorTeam(actor);
    if (team) losses.push({ at: room.world.time, actorId: actor.id, factionId: team, abandoned });
    return wreck(actor, abandoned);
  };
  function updateDisputes(kind: Dispute['kind'], seen: Map<string, Set<string>>) {
    const present = new Set<string>();
    for (const [depositId, participants] of seen) if (participants.size > 1) {
      const of = [...participants].sort(), key = `${kind}:${depositId}:${of.join(',')}`; present.add(key);
      if (!ongoing.has(key)) ongoing.set(key, { kind, depositId, factions: of, from: room.world.time, to: room.world.time });
      ongoing.get(key)!.to = room.world.time;
    }
    for (const [key, interval] of ongoing) if (interval.kind === kind && !present.has(key)) {
      disputes.push({ ...interval, to: room.world.time }); ongoing.delete(key);
    }
  }
  return {
    step(sample: boolean) {
      for (const actor of room.world.actors) actorTeam(actor);
      for (const event of room.world.drainEvents()) {
        const at = event.time ?? room.world.time, shooter = event.shooterActorId && owners.get(event.shooterActorId),
          target = (event.targetActorId && owners.get(event.targetActorId)) || (event.actorId && owners.get(event.actorId));
        if (event.type === 'muzzle' && event.actorId) {
          const row = factions.get(owners.get(event.actorId) ?? ''); if (row) row.firstShotAt ??= at;
        }
        const damage = typeof event.damage === 'number' ? Math.max(0, event.damage) : 0;
        if (event.primaryContact && shooter && target && shooter !== target) {
          const key = `${shooter}:${target}`;
          if (!contacts.has(key)) contacts.set(key, { from: shooter, to: target, primaryContacts: 0, componentDamage: 0, firstAt: at, lastAt: at });
          const contact = contacts.get(key)!; contact.primaryContacts++; contact.componentDamage += damage; contact.lastAt = at;
          factions.get(shooter)!.attributedPrimaryDamageGiven += damage; factions.get(target)!.attributedPrimaryDamageTaken += damage;
        } else if (target && damage > 0) factions.get(target)!.unattributedModuleDamageTaken += damage;
      }
      if (!sample) return;
      for (const actor of room.world.actors) countShots(actor);
      for (const part of room.world.modules) {
        const previous = health.get(part.id), row = factions.get(owners.get(part.actorId) ?? '');
        if (previous !== undefined && row) row.sampledModuleHealthLost += Math.max(0, previous - part.health);
        health.set(part.id, part.health);
      }
      const intents = new Map<string, Set<string>>(), work = new Map<string, Set<string>>(),
        add = (map: Map<string, Set<string>>, siteId: string | null | undefined, factionId: string) => {
          if (!siteId || !room.sites.has(siteId)) return;
          if (!map.has(siteId)) map.set(siteId, new Set()); map.get(siteId)!.add(factionId);
        };
      for (const { id, factionId } of seats) {
        const owner = room.players.get(id)!, faction = room.factions.get(factionId)!;
        for (const other of faction.met.keys()) {
          const key = `${factionId}:${other}`;
          if (!knownMeetings.has(key)) { meetings.push({ at: room.world.time, by: factionId, other }); knownMeetings.add(key); }
        }
        const base = faction.base?.x ?? null, previousBase = bases.get(factionId)!;
        if (base !== previousBase) { baseChanges.push({ at: room.world.time, factionId, from: previousBase, to: base }); bases.set(factionId, base); }
        for (const actor of room.owned(id)) if (!room.outOfAction()[actor.id]) {
          const unit = owner.squad!.units.get(actor.id), record = room.records.get(actor.id), job = room.supplyDispatch.jobs.get(actor.id);
          add(intents, unit?.haul?.depositId ?? job?.targetId, factionId);
          add(work, record?.loading, factionId);
          for (const extraction of record?.extraction ?? []) add(work, extraction.siteId, factionId);
        }
        if (!diagnosed.has(id) && base !== null && faction.stock.combustivel >= 1000 && faction.stock.combustivel <= 1750 &&
          owner.squad!.side.threats?.().some(threat => Math.abs(threat.x - base) <= 1000)) {
          const observation = observeCommander(room, id);
          if (!observation.units.some(unit => unit.vehicle && unit.extracts.includes('petroleo') && unit.carries.includes('petroleo'))) {
            const state = structuredClone(room.commanders.get(id)!);
            diagnostics.push({ at: room.world.time, id, strategicDue: state.nextAt <= room.world.time + 1e-9,
              observation, state, prospectiveChoice: chooseCommanderAction(observation, structuredClone(state)) }); diagnosed.add(id);
          }
        }
      }
      updateDisputes('orders', intents); updateDisputes('working', work);
    },
    disrupted() { return losses.length > 0 || baseChanges.length > 0 || [...factions.values()].some(row => row.shots > 0 || row.sampledModuleHealthLost > 0); },
    snapshot(factionId: string) { return { ...factions.get(factionId)! }; },
    result() { return { factions: [...factions.values()].map(row => ({ ...row })), contacts: [...contacts.values()], losses, meetings, baseChanges,
      resourceDisputes: [...disputes, ...[...ongoing.values()].map(interval => ({ ...interval, to: room.world.time }))], diagnostics,
      combatObserved: contacts.size > 0, shotsObserved: [...factions.values()].some(row => row.shots > 0) }; },
  };
}

function experiment(scenario: Scenario) {
  let seed = scenario.seed;
  const room = new SharedRoom({ ...(scenario.initialStock ? { stock: { ...scenario.initialStock } } : {}),
    ...(scenario.arena?.positions ? { base: (index: number) => scenario.arena!.positions![scenario.arena!.entrySlots[index]!]! } : {}),
    random: () => (seed = seed * 16807 % 2147483647) / 2147483647 });
  try {
    // Match the normal worker boot order: start the schedule before bot seats.
    if (scenario.eventMode === 'live-scheduled') startActivities(room);
    if (scenario.group === 'depleted') for (const site of room.deposits) room.veins.set(site.id, 0);
    const draws = ['0011223344556677', '8899aabbccddeeff', '1a2b3c4d5e6f7081', '91a2b3c4d5e6f708'],
      seats = scenario.profiles.map((profile, index) => room.addCommander(`Base autônoma ${index + 1}`, profile, draws[index] ?? draws[0]!));
    const secrets = [...room.players.values()].map(player => player.token), commands: unknown[] = [], samples: unknown[] = [],
      rows = seats.map((seat, index) => {
        const player = room.players.get(seat.id); assert(player);
        const faction = room.faction(player); assert(faction.base);
        if (scenario.arena) { assert.deepEqual(faction.stock, STARTING_STOCK); assert.equal(room.owned(seat.id).length, 3); }
        const miner = room.owned(seat.id).find(actor => actor.vehicle && actor.blueprint.modules.some(p => p.kind === 'excavator'));
        assert(miner, 'The normal granted fleet includes a miner');
        return { id: seat.id, factionId: faction.id, profile: scenario.profiles[index]!, entryIndex: index, spawnSlot: scenario.arena?.entrySlots[index] ?? index, baseX: faction.base.x,
          initialStock: { ...faction.stock }, initialFleet: room.owned(seat.id).map(actor => actor.id), minerId: miner.id,
          initialYardIron: faction.yard.ferro, initialSupplyIron: room.owned(seat.id).reduce((sum, actor) => sum + supplied(carriedBy(room.crates(actor.id)).carried).ferro, 0),
          delivered: load(), purchases: bill(), plans: [] as { id: string; at: number; cost: SupplyBill }[],
          manufactures: [] as { id: string; at: number; name: string | null; cost: SupplyBill }[],
          recentDelivered: load(), recentStock: { ...faction.stock },
          lastDeliveryAt: null as number | null, deliveryGaps: [] as { from: number; to: number; seconds: number; beforeFirstDelivery: boolean }[],
          firstIronAt: null as number | null, firstOilAt: null as number | null, lastIronAt: null as number | null, lastOilAt: null as number | null,
          firstUpgradeAt: null as number | null, loss: null as Loss | null,
          carrierDelivery: null as CarrierDelivery | null, replacementCarrierAt: null as number | null, replacementCarrierDeliveryAt: null as number | null,
          oilDelivery: null as { at: number; actorId: string; litres: number } | null,
          paidTankerAt: null as number | null, replacementTankerAt: null as number | null, replacementTankerDeliveryAt: null as number | null };
      });
    const rowByFaction = new Map(rows.map(row => [row.factionId, row]));
    const arena = scenario.arena ? arenaTelemetry(room, seats) : null;
    let ironServiceCharges = 0;
    const charge = room.charge.bind(room);
    room.charge = (point, cost) => { const result = charge(point, cost); ironServiceCharges += cost.ferro; return result; };
    const rawCarrier = (actorId: string): boolean => {
      const actor = room.world.actor(actorId), pieces = room.world.modules.filter(part => part.actorId === actorId && part.health > 0 && part.attached !== false);
      return Boolean(actor?.vehicle) && pieces.some(part => hauls(part, 'ferro')) && !pieces.some(part => RAW_IDS.some(raw => extracts(part, raw)));
    };
    const oilCarrier = (actorId: string): boolean => {
      const actor = room.world.actor(actorId), pieces = room.world.modules.filter(part => part.actorId === actorId && part.health > 0 && part.attached !== false);
      return Boolean(actor?.vehicle) && pieces.some(part => hauls(part, 'petroleo')) && pieces.some(part => extracts(part, 'petroleo'));
    };
    const alive = (actorId: string): boolean => Boolean(room.world.actor(actorId)) && !room.outOfAction()[actorId] && !room.records.get(actorId)?.wreck;
    const unload = room.unload.bind(room);
    room.unload = (pieces, yard) => {
      const before = { ...yard }, result = unload(pieces, yard),
        faction = [...room.factions.values()].find(f => f.yard === yard || f.posts.some(post => post.yard === yard)),
        row = faction && rowByFaction.get(faction.id);
      if (row) {
        if (RAW_IDS.some(raw => yard[raw] - before[raw] > 1e-6)) {
          const from = row.lastDeliveryAt ?? 0;
          if (room.world.time - from >= 60) row.deliveryGaps.push({ from, to: room.world.time, seconds: room.world.time - from, beforeFirstDelivery: row.lastDeliveryAt === null });
          row.lastDeliveryAt = room.world.time;
        }
        for (const raw of RAW_IDS) {
          const delta = Math.max(0, yard[raw] - before[raw]); row.delivered[raw] += delta;
          if (delta > 1e-6 && raw === 'ferro') row.lastIronAt = room.world.time;
          if (delta > 1e-6 && raw === 'petroleo') row.lastOilAt = room.world.time;
        }
        if (row.delivered.ferro > 1) row.firstIronAt ??= room.world.time;
        if (row.delivered.petroleo > 1) row.firstOilAt ??= room.world.time;
        if (yard.ferro > before.ferro) {
          const actorId = pieces[0]?.actorId, unit = actorId ? room.players.get(row.id)?.squad?.units.get(actorId) : undefined,
            sourceId = actorId ? unit?.haul?.depositId ?? room.supplyDispatch.jobs.get(actorId)?.targetId : null,
            source = sourceId && room.sites.get(sourceId),
            mine = source && room.owned(row.id).find(actor => !actor.vehicle && Math.abs(room.position(actor) - source.x) <= LOAD_REACH &&
              room.world.modules.some(part => part.actorId === actor.id && part.health > 0 && part.attached !== false && extracts(part, 'ferro')));
          if (actorId && rawCarrier(actorId) && source && mine) {
            if (!row.carrierDelivery) row.carrierDelivery = { at: room.world.time, actorId, siteId: source.id, mineId: mine.id, iron: 0 };
            if (row.carrierDelivery.actorId === actorId) row.carrierDelivery.iron += yard.ferro - before.ferro;
            if (scenario.group === 'carrier-loss' && row.loss && actorId !== row.loss.actorId) row.replacementCarrierDeliveryAt ??= room.world.time;
          }
        }
        if (yard.petroleo > before.petroleo) {
          const actorId = pieces[0]?.actorId;
          if (actorId && oilCarrier(actorId)) {
            row.oilDelivery ??= { at: room.world.time, actorId, litres: 0 };
            if (row.oilDelivery.actorId === actorId) row.oilDelivery.litres += yard.petroleo - before.petroleo;
            if (scenario.group === 'tanker-loss' && row.loss && actorId !== row.loss.actorId) row.replacementTankerDeliveryAt ??= room.world.time;
          }
        }
      }
      return result;
    };
    const command = room.command.bind(room);
    room.command = (playerId, input, draw) => {
      const request = asRecord(input) ? input : {}, row = rows.find(row => row.id === playerId), at = room.world.time,
        stockBefore = row ? { ...room.factions.get(row.factionId)!.stock } : null;
      const entry = { at, playerId, type: request.type, order: request.order,
        ids: request.ids, actorId: request.actorId, depositId: request.depositId, upgrade: request.type === 'upgrade' ? request.id : undefined };
      try {
        const result = command(playerId, input, draw);
        if (row && request.type === 'spawn' && asRecord(result) && 'actor' in result && isBill(result.cost)) row.purchases = billSum(row.purchases, result.cost);
        if (row && request.type === 'spawn' && asRecord(result) && asRecord(result.actor) && typeof result.actor.id === 'string' && isBill(result.cost)) {
          const actor = room.world.actor(result.actor.id);
          row.manufactures.push({ id: result.actor.id, at, name: actor?.construction.name ?? null, cost: { ...result.cost } });
          if (oilCarrier(result.actor.id)) {
            row.paidTankerAt ??= at;
            if (row.loss && scenario.group === 'tanker-loss') row.replacementTankerAt ??= at;
          }
        }
        if (row?.loss && scenario.group === 'carrier-loss' && request.type === 'spawn' && asRecord(result) &&
          asRecord(result.actor) && typeof result.actor.id === 'string' && rawCarrier(result.actor.id)) row.replacementCarrierAt ??= at;
        if (row && request.type === 'spawn' && asRecord(result) && asRecord(result.work) && typeof result.work.id === 'string' && isBill(result.cost))
          row.plans.push({ id: result.work.id, at, cost: { ...result.cost } });
        const stockDelta = row && stockBefore ? Object.fromEntries(STOCK_IDS.map(id => [id, room.factions.get(row.factionId)!.stock[id] - stockBefore[id]])) : null;
        commands.push({ ...entry, applied: true, stockDelta }); return result;
      } catch (error) {
        commands.push({ ...entry, applied: false, error: error instanceof Error ? error.message : String(error) }); throw error;
      }
    };
    const fuel = (actorId: string) => room.world.modules.filter(p => p.actorId === actorId && p.kind === 'fuel')
      .reduce((sum, p) => sum + (p.kind === 'fuel' ? p.fuelLitres : 0), 0),
      assets = (playerId: string) => room.owned(playerId).map(actor => {
        const usable = room.world.modules.filter(part => part.actorId === actor.id && part.health > 0 && part.attached !== false),
          unit = room.players.get(playerId)?.squad?.units.get(actor.id);
        return { id: actor.id, x: room.position(actor), vehicle: Boolean(actor.vehicle), defeated: Boolean(room.outOfAction()[actor.id]), auto: Boolean(room.records.get(actor.id)?.auto), fuelLitres: fuel(actor.id),
          extracts: RAW_IDS.filter(raw => usable.some(part => extracts(part, raw))), carries: RAW_IDS.filter(raw => usable.some(part => hauls(part, raw))),
          builder: usable.some(part => part.kind === 'builder'), armed: usable.some(part => part.kind === 'weapon'),
          order: { halt: unit?.halt ?? '', move: unit?.move ? { x: unit.move.x, purpose: unit.move.purpose } : null,
            haul: unit?.haul ? { depositId: unit.haul.depositId, phase: unit.haul.phase } : null },
          job: room.supplyDispatch.view(actor.id),
          cargo: carriedBy(room.pieces(actor.id)).carried, supplies: supplied(carriedBy(room.crates(actor.id)).carried) };
      }),
      snapshot = () => rows.map(row => {
        const faction = room.factions.get(row.factionId); assert(faction);
        const commander = room.commanders.get(row.id); assert(commander);
        return { id: row.id, stock: { ...faction.stock }, yard: { ...faction.yard }, base: faction.base ? { ...faction.base } : null,
          presence: { active: room.active(room.players.get(row.id)!), manned: room.manned(faction), sheltered: faction.shelter !== null },
          siege: structuredClone(faction.capture), ...(arena ? { encounter: arena.snapshot(faction.id) } : {}),
          slots: { used: room.constructionCounts(faction), limits: { ...CONSTRUCTION_LIMITS } },
          industry: structuredClone(faction.industry), fleet: assets(row.id), delivered: { ...row.delivered },
          works: room.works.of(faction.id).map(work => ({ id: work.id, x: work.x, progress: work.progress, cost: { ...work.cost }, delivered: { ...work.delivered } })),
          // Evaluation truth is logged separately and never supplied to the policy.
          knownResourceMeasurements: [...faction.veins ?? []].map(([id, known]) => {
            const site = room.sites.get(id); assert(site);
            return { id, known: { ...known }, actualReserve: room.left(site), actualPile: room.extracted.get(id) ?? 0 };
          }),
          actions: commander.actions, refusals: commander.refusals, reason: commander.history.at(-1)?.reason ?? null };
      });
    const lose = (row: typeof rows[number], actorId: string) => {
      const actor = room.world.actor(actorId);
      if (!actor || room.outOfAction()[actor.id]) return;
      row.loss = { at: room.world.time, actorId: actor.id, cargo: { ...carriedBy(room.pieces(actor.id)).carried }, fuelLitres: fuel(actor.id),
        supplies: supplied(carriedBy(room.crates(actor.id)).carried), stock: { ...room.factions.get(row.factionId)!.stock }, ironDelivered: row.delivered.ferro };
      for (const part of room.world.modules.filter(p => p.actorId === actor.id && p.kind === 'command'))
        room.world.game().call({ op: 'setPartState', owner: room.world.game().handle(part), state: { health: 0 } });
      samples.push({ time: room.world.time, event: scenario.group, factions: snapshot(), activities: structuredClone(room.activities) });
    };
    for (let tick = 0; tick < seconds * 60; tick++) {
      if (scenario.group === 'miner-loss' && room.world.time >= 900) for (const row of rows) if (!row.loss) lose(row, row.minerId);
      if (scenario.group === 'carrier-loss') for (const row of rows) if (!row.loss && row.carrierDelivery && row.carrierDelivery.iron >= 1000)
        lose(row, row.carrierDelivery.actorId);
      if (scenario.group === 'mobile-miner-after-plant-loss') for (const row of rows) if (!row.loss && row.carrierDelivery &&
        row.carrierDelivery.iron >= 1000 && alive(row.carrierDelivery.mineId) && alive(row.carrierDelivery.actorId)) lose(row, row.minerId);
      if (scenario.group === 'tanker-loss') for (const row of rows) if (!row.loss && row.oilDelivery) lose(row, row.oilDelivery.actorId);
      room.step(STEADY);
      arena?.step((tick + 1) % 60 === 0);
      for (const row of rows) {
        const faction = room.factions.get(row.factionId); assert(faction);
        assert(STOCK_IDS.every(id => Number.isFinite(faction.stock[id]) && faction.stock[id] >= -1e-6), 'No non-finite stock or debt');
        if (faction.industry.capital.ferro > 0) row.firstUpgradeAt ??= room.world.time;
        if (tick + 1 === Math.max(0, seconds - 600) * 60) {
          row.recentDelivered = { ...row.delivered }; row.recentStock = { ...faction.stock };
        }
      }
      if (tick % 1800 === 0) samples.push({ time: room.world.time, factions: snapshot(), activities: structuredClone(room.activities) });
    }
    const final = snapshot(), states = rows.map(row => ({ id: row.id, state: structuredClone(room.commanders.get(row.id)!) })),
      ironLedger = rows.map(row => {
        const faction = room.factions.get(row.factionId)!, fleet = assets(row.id),
          pendingWorks = room.works.of(faction.id).length, supplyIron = fleet.reduce((sum, actor) => sum + actor.supplies.ferro, 0),
          heapIron = room.works.heapsOf(faction.id).reduce((sum, heap) => sum + heap.stock.ferro, 0),
          yardIron = faction.yard.ferro + faction.posts.reduce((sum, post) => sum + post.yard.ferro, 0),
          constructionIron = row.plans.reduce((sum, plan) => sum + plan.cost.ferro, 0),
          reasons = [
            ...(arena?.disrupted() ? ['encounter-shots-health-loss-or-base-change'] : []),
            ...(pendingWorks ? ['unfinished-work'] : []), ...(faction.industry.pending ? ['unfinished-upgrade'] : []),
            ...(supplyIron + heapIron + row.initialSupplyIron + (row.loss?.supplies.ferro ?? 0) > 1e-6 ? ['supplies-or-heaps'] : []),
            ...(ironServiceCharges > 1e-6 ? ['paid-iron-services'] : []),
            ...(commands.some(entry => asRecord(entry) && entry.playerId === row.id && entry.applied && entry.type === 'recover') ? ['recovery'] : []),
          ], assessed = !reasons.length,
          expectedStock = assessed ? row.initialStock.ferro + row.initialYardIron + row.delivered.ferro - yardIron - row.purchases.ferro -
            faction.industry.capital.ferro - constructionIron : null,
          residual = expectedStock === null ? null : faction.stock.ferro - expectedStock;
        assert(residual === null || Math.abs(residual) < .01, 'Closed iron ledger must reconcile actual deliveries, invoices and capital');
        return { id: row.id, assessed, reasons, initial: row.initialStock.ferro, initialYard: row.initialYardIron,
          delivered: row.delivered.ferro, unrefinedYard: yardIron, vehicles: row.purchases.ferro, industry: faction.industry.capital.ferro,
          construction: constructionIron, pendingWorks, supplyIron, heapIron, ironServiceCharges, expectedStock, actualStock: faction.stock.ferro, residual };
      }),
      finalDecisions = rows.map(row => {
        const observation = observeCommander(room, row.id);
        return { id: row.id, observation, next: chooseCommanderAction(observation, room.commanders.get(row.id)!) };
      }),
      metrics = rows.map((row, index) => {
        const faction = room.factions.get(row.factionId)!, observation = finalDecisions[index]!.observation,
          missing = (cost: SupplyBill) => STOCK_IDS.flatMap(id => cost[id] > faction.stock[id] + 1e-6 ? [{ id, amount: cost[id] - faction.stock[id] }] : []);
        return { id: row.id, window: { from: Math.max(0, seconds - 600), to: seconds },
          deliveryGaps: [...row.deliveryGaps, ...(seconds - (row.lastDeliveryAt ?? 0) >= 60 ? [{ from: row.lastDeliveryAt ?? 0, to: seconds, seconds: seconds - (row.lastDeliveryAt ?? 0), beforeFirstDelivery: row.lastDeliveryAt === null }] : [])],
          deliveredInWindow: load(...RAW_IDS.map(id => row.delivered[id] - row.recentDelivered[id])),
          stockChangeInWindow: bill(...STOCK_IDS.map(id => faction.stock[id] - row.recentStock[id])),
          slots: { used: room.constructionCounts(faction), limits: { ...CONSTRUCTION_LIMITS } },
          unfundedOffers: observation.offers.flatMap(offer => { const lack = missing(offer.cost); return lack.length ? [{ model: offer.model, x: offer.x, missing: lack }] : []; }),
          unfundedUpgrades: observation.upgrades.filter(upgrade => upgrade.eligible).flatMap(upgrade => {
            const lack = missing(upgrade.cost); return lack.length ? [{ id: upgrade.id, missing: lack }] : [];
          }) };
      }),
      result = { scenario: { ...scenario, normalStartingStock: !scenario.initialStock }, seconds, digest: room.digest(), factions: rows, final, ironLedger, finalDecisions, metrics, encounter: arena?.result() ?? null, commanders: states, commands, samples,
        activities: structuredClone(room.activities), faults: [...room.faults],
        goals: rows.map(row => ({ id: row.id, hasBase: Boolean(room.factions.get(row.factionId)?.base), ironDelivered: row.firstIronAt !== null,
          petroleumDelivered: row.firstOilAt !== null, improvedInstallation: row.firstUpgradeAt !== null,
          paidTanker: row.paidTankerAt !== null,
          recentIronIntake: row.lastIronAt !== null && room.world.time - row.lastIronAt <= 600,
          activeMiner: assets(row.id).some(actor => !actor.defeated && actor.extracts.includes('ferro')),
          lossInjected: ['miner-loss', 'carrier-loss', 'mobile-miner-after-plant-loss', 'tanker-loss'].includes(scenario.group) ? row.loss !== null : null,
          carrierReplaced: scenario.group === 'carrier-loss' ? row.replacementCarrierAt !== null : null,
          carrierResumed: scenario.group === 'carrier-loss' ? row.replacementCarrierDeliveryAt !== null : null,
          finiteFuelInventory: assets(row.id).every(actor => Number.isFinite(actor.fuelLitres) && actor.fuelLitres >= 0) })) };
    const body = JSON.stringify(result); assert(secrets.every(secret => !secret || !body.includes(secret)), 'Reports must not contain player tokens');
    return result;
  } finally { room.world.dispose(); }
}
const results = scenarios.map(scenario => {
  const result = experiment(scenario);
  console.log(JSON.stringify({ scenario: scenario.id, eventMode: scenario.eventMode, seconds, activities: result.activities, goals: result.goals, factions: result.factions.map(row => ({
    profile: row.profile, baseX: row.baseX, delivered: row.delivered, firstIronAt: row.firstIronAt, firstOilAt: row.firstOilAt,
    firstUpgradeAt: row.firstUpgradeAt })), faults: result.faults }));
  return result;
});
if (repeated) assert.deepEqual(scenarios.map(experiment), results, 'Autonomous commands, cooldowns, stocks, movement and history must repeat exactly');
const report = { scope: 'Native autonomous faction economy/local-defense experiment, not a PvP or hardware rating',
  runtime: nativeRuntimeInfo('native'), runnerSHA256, strategySources, assumptions: {
    repeated, normalKit: true, normalStartingStock: scenarios.every(scenario => !scenario.initialStock), fog: true,
    startingBudgets: 'Only fuel-bootstrap starts with a declared restricted constructor budget of 30,000 iron, 10,000 alloys, 10,000 silica and 250L refined fuel. It retains the normal three-unit kit. Other scenarios retain ordinary starting stocks.',
    decisionTime: 'Simulation seconds, Native 60Hz and normal decision pace fixed independently of CPU contention.',
    control: 'Only commander decisions issue player commands. The runner never supplies haul/move/manufacture orders, fuel, cargo or reserve replenishment.',
    conditioning: 'Depleted starts every natural reserve at zero before founding; ordinary regeneration remains active. Miner-loss destroys the original granted miner command module at 900s. Carrier-loss destroys the first raw-only truck after it unloads at least 1,000 kg of iron from a known fixed mine. Mobile-miner-after-plant-loss destroys the original mobile miner after that delivery, while the plant and truck remain alive. Tanker-loss destroys the tanker after its first actual petroleum unloading; fuel stocks are not reduced or forced scarce. Only command-module health is zeroed; wrecks and contents remain normally.',
    competition: 'Economic race in one world, balanced/cautious policies swapped between the same seeded entry positions. No forced raid or attack is supplied; it is not a combat tournament.',
    arena: 'Four ordinary factions use two balanced and two cautious instances, never four distinct strategies. Normal retains default founding; frontier fixes declared INIT locations 10km apart; compact is a separate short territorial-overlap diagnostic. No attack, travel or economy orders are supplied after entry. ABBA/BAAB profile placement and reversed frontier entry slots cover all four positions and entry ranks per profile across the pair.',
    encounters: 'Arena events are drained after each physics step as on a bot-only live host. Shots use actor counters; attributed damage includes only published primary component-contact health damage, not all armour/fire/blast loss. Module health drops, meetings, base changes and shared-deposit order/work intervals are sampled at 1Hz. Losses are by victim faction; no killer is inferred. Delivery gaps >=60s describe physical unloading, not every refinery cash increment. The simple iron ledger is unassessed after shots/health loss/base change or services, and no single score ranks these outcomes.',
    eventMode: 'Each scenario declares none (isolated economy) or live-scheduled (startActivities before bot entry, as in normal worker boot). Ordinary event deadlines are never shortened.',
    firstScheduledEventAfter: AIRDROP.first,
    activities: 'A one-hour live-scheduled run validates the real boot and pending schedule, not a sentinel encounter: the normal first event is later than this horizon. Human competition is outside this economy experiment.',
    metrics: 'Raw deliveries are observed through actual unloading into a base/post yard. Purchases, carried stock, unfinished construction and capital are recorded separately; no public pile is credited as income. Metrics include an exact frame checkpoint for the last 600 simulation seconds, faction slot counts and immediate invoice shortages; shortages do not include policy reserve budgets.',
    ironLedger: 'Iron-only reconciliation is assessed for terminal cases without unfinished works/upgrades, supply/heap balances, paid iron services or recovery. It uses actual invoices, delivered raw iron less the unrefined yard and industrial capital, within 0.01 iron unit; unsupported cases are explicitly unassessed.',
    horizon: seconds >= 3600 ? 'At least one hour observed; inspect each goal before calling the opening autonomous.' : 'Short diagnostic only; does not qualify one-hour autonomy or progression.',
    milestones: 'The economic milestone also requires iron delivered in the last ten minutes; this is an explicit experiment criterion. Known-resource ground truth is evaluation telemetry only, never planner input.',
    fuelBootstrapObjective: 'For the restricted fuel-bootstrap scenario, the target is an ordinarily paid tanker, petroleum delivery, recent iron intake, a live miner/base and no debt. Workshop II is not required. No stock or physical reserve is edited during the run.',
    evaluation: 'The final strategic snapshot/next choice is read only after the simulation horizon; it supplies no extra commands during the experiment.',
  }, economicMilestoneDemonstrated: seconds >= 3600 && results.every(result => !result.faults.length && result.ironLedger.every(ledger => ledger.assessed) && result.goals.every(goal =>
    goal.hasBase && goal.ironDelivered && goal.petroleumDelivered && (result.scenario.group === 'fuel-bootstrap' ? goal.paidTanker : goal.improvedInstallation) && goal.recentIronIntake && goal.activeMiner && goal.finiteFuelInventory &&
    (goal.lossInjected === null || goal.lossInjected) && (goal.carrierReplaced === null || goal.carrierReplaced) &&
    (goal.carrierResumed === null || goal.carrierResumed))), cases: results };
const out = option('--out');
if (out) {
  const path = resolve(out), root = OUTPUTS.find(output => { const within = relative(output, path); return within && !within.startsWith('..') && !isAbsolute(within); });
  assert(root, '--out must be inside validation/commander-20261102 or validation/commander-20261103');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
}
assert(results.every(result => !result.faults.length), 'Inspect Native faults before qualifying autonomous factions');
