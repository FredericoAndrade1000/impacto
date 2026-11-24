import type { NetworkClient } from '../../src/network-client.ts';
import type { FieldView } from '../../src/faction-ui.ts';
import type { DrawingModule } from '../../src/scene-drawing-contract.ts';
import { standing, knownVeins } from '../../src/faction-ui.ts';
import { Terrain } from '../../src/terrain.ts';
import { depositsOf } from '../../src/deposits.ts';
import { RAW_IDS, extracts, hauls, designBill, STOCK_IDS, billSum, buildSeconds } from '../../src/economy.ts';
import { createConstruction } from '../../src/construction-templates.ts';
import { CONSTRUCTION_TEMPLATES } from '../../src/construction-template-catalogue.ts';
import { compileManufacture } from '../../src/structured-construction.ts';
import { industrialAdmission, missingIndustry } from '../../src/industry.ts';
import type { PlayerDesign } from './contract.ts';

export interface PlayerView { client: NetworkClient; scene: FieldView | null; receivedAt: number | null }
const alive = (p: DrawingModule) => p.attached !== false && (p.health ?? 0) > 0;
export function ownUnits({ client, scene }: PlayerView) {
  if (!scene || !client.faction) return [];
  const actors = new Map(scene.actors.map(a => [a.id, a])), orders = new Map(client.squad?.units.map(u => [u.id, u]));
  const parts = new Map<string | undefined, DrawingModule[]>();
  for (const p of scene.modules) { const group = parts.get(p.actorId) ?? []; group.push(p); parts.set(p.actorId, group); }
  return client.faction.units.map(info => {
    const actor = actors.get(info.id), all = parts.get(info.id) ?? [], usable = all.filter(alive), order = orders.get(info.id),
      hp = all.filter(p => p.health !== undefined && p.maxHealth !== undefined),
      maximum = hp.reduce((n, p) => n + p.maxHealth!, 0),
      current = hp.reduce((n, p) => n + (p.attached === false ? 0 : Math.max(0, p.health!)), 0);
    return {
      id: info.id, name: actor?.name ?? info.id, vehicle: info.vehicle, defeated: actor?.defeated ?? order?.defeated ?? false,
      x: actor?.vehicle?.x ?? actor?.x ?? null, y: actor?.vehicle?.y ?? actor?.y ?? null,
      health: maximum > 0 ? { current, maximum, share: current / maximum } : null,
      fuelLitres: actor?.vehicle?.fuelLitres ?? null, fuelLow: info.fuelLow ?? false,
      rounds: usable.filter(p => p.kind === 'ammo').reduce((n, p) => n + (p.rounds ?? 0), 0),
      flying: actor?.vehicle?.flying ?? false, atBase: info.atBase,
      capabilities: { weapons: usable.filter(p => p.kind === 'weapon').map(p => ({ id: p.id, preset: p.weaponPreset ?? null, barrelDisabled: p.barrelDisabled ?? false })),
        extracts: RAW_IDS.filter(material => usable.some(p => extracts(p, material))),
        carries: RAW_IDS.filter(material => usable.some(p => hauls(p, material))),
        kinds: [...new Set(usable.map(p => p.kind))] },
      status: { activity: order?.activity ?? null, reason: order?.reason ?? null, auto: info.auto ?? false,
        service: info.service, job: info.job ?? null, manual: client.squad?.manual === info.id,
        stance: order?.stance ?? null, move: order?.move ?? null, attack: order?.attack ?? null,
        haul: order?.haul ?? null, reservedBy: order?.by ?? null, stuck: actor?.vehicle?.stuck ?? null },
      cargo: info.cargo, supplies: info.supplies, builder: info.builder ?? null, tools: info.tools ?? null,
    };
  });
}
export type PlayerUnit = ReturnType<typeof ownUnits>[number];
export function visibleContacts({ client, scene }: PlayerView) {
  if (!scene) return [];
  const view = { ...scene, shared: true, localPlayerId: client.playerId, faction: client.faction, squad: client.squad };
  return scene.actors.filter(actor => standing(actor, view) === 'enemy').map(actor => ({
    id: actor.id, name: actor.name ?? null, factionId: actor.team ?? null,
    x: actor.vehicle?.x ?? actor.x, y: actor.vehicle?.y ?? actor.y ?? null,
    knowledge: actor.ghost ? 'remembered' as const : 'current' as const, ghost: actor.ghost ?? null,
    // An absent part is unknown, not proof that the enemy is unarmed.
    observedWeapons: scene.modules.filter(p => p.actorId === actor.id && p.kind === 'weapon' && p.attached !== false)
      .map(p => ({ id: p.id, preset: p.weaponPreset ?? null })),
  }));
}
export function describeParts(parts: readonly DrawingModule[]) {
  return parts.map(p => ({ id: p.id, kind: p.kind, attached: p.attached, health: p.health ?? null, maximum: p.maxHealth ?? null,
    x: p.x, y: p.y, angle: p.angle, preset: p.weaponPreset ?? p.ammoPreset ?? null,
    rounds: p.rounds ?? null, burning: p.burning ?? null, barrelDisabled: p.barrelDisabled ?? null,
    reload: p.reload ?? null, elevationDisabled: p.elevationDisabled ?? null, weaponMount: p.weaponMount ?? null }));
}
export class PlayerObservation {
  private terrain: Terrain | null = null;
  private terrainKey = '';
  summary(view: PlayerView) {
    const { client, scene } = view, faction = client.faction;
    const key = scene?.terrain && JSON.stringify([scene.terrain, scene.terrainSettings]);
    if (key && scene?.terrain && key !== this.terrainKey) { this.terrain = new Terrain(scene.terrain, scene.terrainSettings); this.terrainKey = key; }
    return {
      connection: { phase: client.phase, connected: client.connected, issue: client.issue || null, playerId: client.playerId ?? null,
        frameAgeWallMs: view.receivedAt === null ? null : Math.round(performance.now() - view.receivedAt) },
      at: scene?.time ?? null, factor: client.testSpeed, cursor: 0,
      faction: faction ? { id: faction.id, name: faction.name, stock: faction.stock, wants: faction.wants, yard: faction.yard,
        base: faction.base, industry: faction.industry, duel: faction.duel ?? null, siege: faction.siege,
        taking: faction.taking, bases: faction.bases, outposts: faction.outposts, counts: faction.counts,
        recovery: faction.recovery, accords: faction.accords, known: faction.known,
        works: faction.works.map(({ blueprint: _blueprint, ...work }) => work),
        roadworks: faction.roadworks, wrecks: faction.wrecks, activity: faction.activity } : null,
      units: ownUnits(view), contacts: visibleContacts(view), reports: scene?.contacts ?? [],
      deposits: this.terrain && faction ? knownVeins(depositsOf(this.terrain), faction) : [],
      explored: faction?.explored ?? null,
    };
  }
}
export function quoteDesign(spec: PlayerDesign, view: PlayerView, replaceId?: string) {
  const source = 'model' in spec ? createConstruction(spec.model) : spec.blueprint;
  const { construction, compiled } = compileManufacture(source), fullCost = designBill(compiled),
    admission = industrialAdmission(construction, compiled), faction = view.client.faction;
  const old = replaceId ? faction?.units.find(u => u.id === replaceId && u.vehicle) : undefined;
  if (replaceId && !old) throw new Error('Replacement quote needs a vehicle of this faction.');
  const cost = old ? billSum(fullCost, old.value, -1) : fullCost;
  return { source, quote: { name: construction.name, cost, fullCost, reused: old?.value ?? null,
    seconds: buildSeconds(cost), replacementAtBase: old?.atBase ?? null,
    requirements: admission.requirements, measurement: admission.measurement,
    oversized: admission.oversized, missingIndustry: faction ? missingIndustry(admission, faction.industry.levels) : null,
    missingStock: faction ? STOCK_IDS.filter(id => faction.stock[id] < cost[id]).map(id => ({ id, amount: cost[id] - faction.stock[id] })) : null,
    templates: CONSTRUCTION_TEMPLATES.map(t => ({ id: t.id, type: t.type, name: t.name })) } };
}
