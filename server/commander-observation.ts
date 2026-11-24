// The strategic planner sees this DTO, never a World or Room reference. Own
// construction telemetry and surveyed ground complement the same faction view
// used by a player. Unknown deposits/actors are not strategic inputs.
import { createConstruction } from '../src/construction-templates.ts';
import { reserveState } from '../src/component-volume.ts';
import { billTotal, carriedBy, designBill, extracts, hauls, loadTotal, RAW_IDS } from '../src/economy.ts';
import { INDUSTRY_UPGRADES, industrialAdmission, missingIndustry } from '../src/industry.ts';
import { constructionSite, manufactureDesign, structureBill } from './field-construction.ts';
import type { SharedRoom } from './room.ts';
import type { CommanderModel, CommanderObservation, CommanderOffer, CommanderThreat } from './commander-contract.ts';
import { COMMANDER_VEHICLES } from './commander-contract.ts';
import { arcReach } from '../src/squad.ts';
import { commanderBlueprint } from './commander-designs.ts';

const FACTORIES = new Map<CommanderModel, ReturnType<typeof manufactureDesign>>();
function factory(model: typeof COMMANDER_VEHICLES[number]) {
  let facts = FACTORIES.get(model);
  if (!facts) { facts = manufactureDesign(commanderBlueprint(model)); FACTORIES.set(model, facts); }
  return facts;
}
const fixedModel = (components: readonly { kind: string }[]): string => components.some(p => p.kind === 'excavator') ? 'mining-site' :
  components.some(p => p.kind === 'weapon') ? 'guard-post' : 'other';

export function observeCommander(room: SharedRoom, playerId: string): CommanderObservation {
  const owner = room.players.get(playerId); if (!owner?.squad) throw new Error('Commander seat has no squad.');
  const faction = room.faction(owner), view = room.factionView(playerId), squad = room.squadView(playerId);
  if (!faction || !view || !squad) throw new Error('Commander seat has no faction.');
  const own = new Set(room.owned(playerId).map(actor => actor.id)), actors = new Map(room.world.actors.filter(actor => own.has(actor.id)).map(actor => [actor.id, actor])),
    parts = room.world.modules.filter(part => own.has(part.actorId)), grouped = new Map<string, typeof parts>();
  for (const part of parts) grouped.set(part.actorId, [...grouped.get(part.actorId) ?? [], part]);
  const orders = new Map(squad.units.map(unit => [unit.id, unit])), out = new Set(squad.out),
    units: CommanderObservation['units'] = [];
  for (const unit of view.units) {
    const actor = actors.get(unit.id), order = orders.get(unit.id);
    if (!actor || out.has(unit.id) || actor.defeated) continue;
    const live = grouped.get(unit.id) ?? [], usable = live.filter(part => part.health > 0 && part.attached !== false),
      fuel = live.reduce((sum, part) => sum + (part.kind === 'fuel' ? part.fuelLitres : 0), 0),
      full = actor.blueprint.modules.reduce((sum, part) => sum + (part.kind === 'fuel' ? reserveState(part).fuelLitres : 0), 0),
      health = live.length ? live.reduce((sum, part) => sum + Math.max(0, part.health / Math.max(1e-9, part.maxHealth)), 0) / live.length : 1,
      ammoCapacity = actor.blueprint.modules.reduce((sum, part) => sum + (part.kind === 'ammo' ? reserveState(part).capacityRounds : 0), 0),
      rounds = usable.reduce((sum, part) => sum + (part.kind === 'ammo' ? part.rounds : 0), 0),
      speed = actor.vehicle?.drivetrain?.maxSpeed ?? 0, range = (actor.vehicle?.drivetrain?.rangeKm ?? 0) * 1000;
    const repairing = unit.service?.kind === 'repair' ? unit.service : null,
      damaged = billTotal(unit.repair) > 0,
      critical = live.some(part => part.attached === false || part.health < part.maxHealth * .8 || part.kind === 'weapon' && part.barrelDisabled) ||
        room.world.plates.some(plate => plate.actorId === actor.id && (plate.integrity < .8 || plate.attached === false));
    units.push({ id: unit.id, x: room.position(actor), vehicle: unit.vehicle,
      armed: usable.some(part => part.kind === 'weapon'), artillery: order?.role === 'artillery', builder: usable.some(part => part.kind === 'builder'),
      supply: usable.some(part => part.kind === 'supply'), extracts: RAW_IDS.filter(raw => usable.some(part => extracts(part, raw))),
      carries: RAW_IDS.filter(raw => usable.some(part => hauls(part, raw))), fuel, fuelCapacity: full,
      cargo: loadTotal(carriedBy(room.pieces(unit.id)).carried), health, maxHealth: live.reduce((sum, part) => sum + part.maxHealth, 0),
      ammoRatio: ammoCapacity > 0 ? Math.min(1, Math.max(0, rounds / ammoCapacity)) : 0,
      calm: unit.calm, still: unit.still, manual: squad.manual === unit.id, salvage: { ...unit.value },
      maintenance: repairing ? { phase: 'repairing', critical, cost: { ...repairing.cost }, payer: repairing.payer } :
        damaged ? { phase: unit.declined ? 'declined' : 'needed', critical, cost: { ...(unit.mend?.cost ?? unit.repair) },
          available: Boolean(unit.mender && !unit.mender.held) } : null,
      mobility: actor.vehicle?.config.enabled && Number.isFinite(speed) && speed > 0 && Number.isFinite(range) && range > 0 ? { speed, range } : null,
      aircraft: actor.blueprint.chassis?.model === 'aircraft',
      combatAt: Number.isFinite(room.records.get(unit.id)?.combatAt) ? room.records.get(unit.id)!.combatAt : null,
      attack: order?.attack?.targetId ?? null,
      ready: !unit.service && squad.manual !== unit.id && !order?.defeated,
      atBase: unit.atBase, atDepot: unit.atBase || Boolean(unit.atPost), moving: Boolean(order?.move), home: Boolean(order?.move?.home), auto: Boolean(unit.auto),
      stance: order?.stance ?? 'return', halt: owner.squad.units.get(unit.id)?.halt ?? '',
      haul: order?.haul ? { depositId: order.haul.depositId, phase: order.haul.phase } : null,
      job: unit.job ? { kind: unit.job.kind, phase: unit.job.phase, reason: unit.job.reason } : null });
  }
  const deposits: CommanderObservation['deposits'] = [];
  for (const known of view.deposits) {
    if (!known.active) continue;
    // Filter by authorized known IDs before touching the public terrain catalogue.
    const site = room.sites.get(known.id); if (!site) continue;
    deposits.push({ id: site.id, x: site.x, material: site.material, reserve: site.reserve,
      left: known.left, stock: known.stock, seen: known.seen, at: known.at });
  }
  const offers: CommanderOffer[] = [], accepts = (facts: ReturnType<typeof manufactureDesign>): boolean => {
    const admission = industrialAdmission(facts.construction, facts.compiled);
    return !admission.oversized && !missingIndustry(admission, view.industry.levels).length;
  };
  if (view.base) {
    for (const model of COMMANDER_VEHICLES) {
      const facts = factory(model);
      if (accepts(facts)) offers.push({ model, cost: designBill(facts.compiled),
        ...(model === 'mortar' ? { artilleryRange: Math.max(0, ...facts.compiled.modules
          .filter(part => part.kind === 'weapon').map(part => arcReach(part.weaponPreset ?? 'rh120'))) } : {}) });
    }
    // Normal placement checks reject an unknown footprint before examining its
    // ground or territory, and consider only owned occupancy. No reservation
    // or payment occurs here; execution checks the placement and bill again.
    const sites = deposits.filter(site => site.material !== 'petroleo')
      .sort((a, b) => Math.abs(a.x - view.base!.x) - Math.abs(b.x - view.base!.x)),
      candidates: { model: 'guard-post' | 'mining-site'; x: number; facing: -1 | 1 }[] = [
        { model: 'guard-post', x: view.base.x + 160, facing: -1 },
        { model: 'guard-post', x: view.base.x - 160, facing: 1 },
        ...sites.flatMap(site => ([-1, 1] as const).map(facing => ({ model: 'mining-site' as const, x: site.x + facing * 5, facing }))),
      ];
    for (const candidate of candidates) {
      if (Math.abs(candidate.x - view.base.x) < 150 || Math.abs(candidate.x - view.base.x) > 4900 ||
        !room.explored(faction.id, candidate.x)) continue;
      try {
        const source = createConstruction(candidate.model), facts = manufactureDesign(source, room.world, candidate);
        constructionSite(room, faction, facts.construction, candidate.x, candidate.facing);
        if (accepts(facts)) offers.push({ ...candidate, cost: structureBill(room, source, candidate.x, candidate.facing) });
      } catch (error) {
        // Unsupported terrain is not an offer; programming errors must surface.
        if (error instanceof TypeError || error instanceof ReferenceError) throw error;
      }
    }
  }
  const danger = room.supplyDispatch.perils(faction).map(([lo, hi]) => ({ lo, hi })),
    threats: CommanderThreat[] = (owner.squad.side.threats?.() ?? []).map(threat => {
      const actor = room.world.actor(threat.id), channel = actor && room.knows(faction.id, actor);
      if (channel !== 'seen' && channel !== 'radar') return { kind: 'signal', x: threat.x };
      return { kind: 'contact', id: threat.id, x: threat.x, channel, armed: threat.reach === null ? null : threat.reach > 0,
        grounded: room.explored(faction.id, threat.x) && Math.abs(threat.y - room.world.terrain.height(threat.x)) < 25 };
    });
  return { time: room.world.time, playerId, factionId: faction.id,
    wrecks: view.wrecks.map(({ id, x, value, inReach, calmIn }) => ({ id, x, value: { ...value }, inReach, calmIn })),
    base: view.base ? { x: view.base.x, facing: view.base.facing } : null, stock: { ...view.stock }, besieged: view.siege !== null,
    recovery: view.recovery ? { offered: view.recovery.offered } : null,
    industry: { levels: { ...view.industry.levels }, pending: Boolean(view.industry.pending) }, units, deposits, offers,
    upgrades: INDUSTRY_UPGRADES.map(upgrade => ({ id: upgrade.id, cost: { ...upgrade.cost },
      eligible: !view.industry.pending && view.industry.levels[upgrade.facility] === upgrade.level - 1 })),
    explored: view.explored?.map(([lo, hi]) => [lo, hi] as const) ?? null,
    bounds: { minX: room.limits.minX, maxX: room.limits.maxX }, danger, threats,
    batteries: owner.squad.side.batteries.filter(mark => mark.y === undefined).map(mark => ({ x: mark.x, error: mark.error, at: mark.at })),
    bases: view.bases.filter(base => !room.allied(faction.id, base.id)).map(base => ({ id: base.id, x: base.x,
      radius: base.radius, seen: base.seen, at: base.at, sheltered: base.sheltered })),
    taken: faction.taken ? { factionId: faction.taken.of, at: faction.taken.at } : null,
    works: [...view.works.map(work => ({ id: work.id, model: work.blueprint ? fixedModel(work.blueprint.components) : 'post', x: work.x, complete: false })),
      ...units.filter(unit => !unit.vehicle).map(unit => ({ id: unit.id, model: fixedModel(actors.get(unit.id)!.construction.components), x: unit.x, complete: true }))] };
}
