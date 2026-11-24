import { Squad } from '../src/squad.ts';
import { applyWorldInput } from '../src/episode-input.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { BASE_RADIUS, LOAD_REACH } from '../src/economy.ts';
import { manufactureDesign } from './field-construction.ts';
import { isSquadMove, isSquadStance } from '../src/squad-contract.ts';
import type { SquadOrders, SquadMember } from '../src/squad-contract.ts';
import type { SquadAction } from '../src/scripted-contract.ts';
import type { Actor } from '../src/scene-contract.ts';
import type { SharedRoom } from './room.ts';

export type GuardianOrder = Pick<SquadOrders, 'stance' | 'move' | 'halt'>;
export type GuardianOrders = [string, GuardianOrder][];
type GuardianInput = Partial<Omit<SquadAction, 'type' | 'phase'>> & { type?: string; phase?: string };
function decodeOrders(value: unknown): GuardianOrders {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Campo salvo com ordem de sentinela inválida.');
  return value.map((entry: unknown): [string, GuardianOrder] => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error('Campo salvo com ordem de sentinela inválida.');
    const order: unknown = entry[1];
    if (!order || typeof order !== 'object' || !('stance' in order) || !isSquadStance(order.stance) ||
      !('halt' in order) || typeof order.halt !== 'string' || !('move' in order) || order.move !== null && !isSquadMove(order.move))
      throw new Error('Campo salvo com ordem de sentinela inválida.');
    return [entry[0], { stance: order.stance, move: order.move, halt: order.halt }];
  });
}

export const GUARDIAN = Object.freeze({ template: 'scout', offset: 40, leash: 120 });

// The existing Squad drives and the existing core senses/aims/fires. This Side supplies only a local objective policy.
// There is no player, faction, economy, extra perception query or separate decision timer for this vehicle.
export class GuardianSide {
  declare room: SharedRoom;
  constructor(room: SharedRoom) { this.room = room; }
  get world() { return this.room.world; }
  get drop() { return this.room.activities?.drop; }
  get defeats() { return this.room.outOfAction(); }
  get arenaBounds() { return this.world.bounds; }
  get baseNear() {
    const drop = this.drop;
    return Boolean(drop && this.room.bases().some(base => Math.abs(base - drop.x) <= GUARDIAN.leash + BASE_RADIUS + LOAD_REACH));
  }
  freeFireRegion(id: string) {
    const drop = this.drop;
    return drop?.guardianId === id && !this.baseNear ? { anchor: drop.x, radius: GUARDIAN.leash, home: true } : null;
  }
  member(actor: Actor): SquadMember { return { id: actor.id, pilot: 'player', role: 'armor', team: 'local' }; }
  get roster() { const actor = this.world.actor(this.drop?.guardianId); return actor ? [this.member(actor)] : []; }
  get batteries() { return []; }
  veinAt() { return null; }
  deposit() { return null; }
  // No pre-explored terrain map is invented; the ordinary pilot uses its conservative unknown-ground plan.
  knowsGround() { return false; }
  foe(id: string | null | undefined): boolean {
    const actor = this.world.actor(id);
    return Boolean(actor?.ownerId && this.room.players.has(actor.ownerId) && !this.defeats[actor.id]);
  }
  // Squad's human-facing contact wording is unused here. Engagement reads the core's actual contact below.
  sighted() { return false; }
  turnAbout(id: string): boolean {
    const actor = this.world.actor(id);
    if (!actor || this.room.held(actor)) return false;
    this.room.turn(null, actor, true); return true;
  }
  input(id: string, input: GuardianInput, decision = false): boolean {
    const drop = this.drop, actor = this.world.actor(id);
    if (!drop || id !== drop.guardianId || !actor || this.defeats[id]) return false;
    let action = input;
    if (decision) {
      action = { ...input, ...(input.also ? { also: input.also.map(gun => ({ ...gun })) } : {}) };
      const x = this.room.position(actor), contact = action.contact, baseNear = this.baseNear,
        inside = Math.abs(x - drop.x) < GUARDIAN.leash,
        placed = contact?.detected && contact.age < 1 && ['visual', 'radar'].includes(contact.channel || contact.source),
        engage = !baseNear && inside && placed && this.foe(action.targetId) && Number.isFinite(contact!.x);
      // The shared Squad bounds travel. Actual sensors, mount, ammunition and ballistics bound fire.
      if (!engage) { action.fire = false; for (const gun of action.also || []) gun.fire = false; }
      if (baseNear) {
        const squad = this.room.guardianSquad!;
        if (squad.units.get(id)!.move) squad.command({ order: 'stop', ids: [id] });
        Object.assign(action, { throttle: 0, brake: 1 });
      }
    }
    const reply = applyWorldInput(this.world, id, { ...action, phase: decision ? 'decision' : 'before' }, { platform: 'vehicle', quiet: true });
    return Boolean(reply && typeof reply === 'object' && 'accepted' in reply && reply.accepted);
  }
}
export function guardianOrders(room: SharedRoom): GuardianOrders {
  return room.guardianSquad ? [...room.guardianSquad.units].map(([id, { stance, move, halt }]): [string, GuardianOrder] => [id, { stance, move, halt }]) : [];
}
export function spawnGuardian(room: SharedRoom): void {
  const drop = room.activities!.drop!;
  if (drop.guardianId !== undefined) return;
  const prepared = manufactureDesign(room.validateDesign(createStructuredTemplate(GUARDIAN.template))),
    source = prepared.construction, id = room.mint('c');
  // Keep the identity after destruction: absence of the physical actor must never authorize another grant.
  drop.guardianId = id;
  const actor = room.world.addActor(source, { id, ownerId: null, team: 'guardian:' + drop.id,
    x: drop.x + GUARDIAN.offset, facing: -1, color: '#b98a6a', playerName: 'Sentinela do airdrop' });
  room.topology++; room.show(actor);
  room.guardianSquad = new Squad(new GuardianSide(room));
  room.guardianSquad.command({ order: 'stance', ids: [id], stance: 'fire' });
  room.round = 0;
}
export function resumeGuardian(room: SharedRoom): void {
  const state = room.activities, drop = state?.drop, orders = state?.orders;
  if (state) delete state.orders;
  room.guardianSquad = null;
  if (!drop?.guardianId) return;
  const actor = room.world.actor(drop.guardianId);
  if (!actor || room.records.get(actor.id)?.wreck) return;
  if (actor.ownerId !== null || actor.team !== 'guardian:' + drop.id) throw new Error('Campo salvo com sentinela inválida.');
  const squad = room.guardianSquad = new Squad(new GuardianSide(room));
  squad.command({ order: 'stance', ids: [actor.id], stance: 'fire' });
  for (const [id, order] of decodeOrders(orders)) {
    if (id !== actor.id) throw new Error('Campo salvo com ordem de sentinela inválida.');
    // Guardian moves have always been automatic; tag legacy legs without resetting their progress.
    Object.assign(squad.units.get(id)!, { stance: order.stance, move: order.move && { ...order.move, purpose: 'fire' }, halt: order.halt, attack: null, haul: null });
  }
}
export function livingGuardian(room: SharedRoom): boolean {
  const id = room.activities?.drop?.guardianId, actor = id && room.world.actor(id);
  return Boolean(actor && !room.records.get(id)?.wreck && !room.outOfAction()[id]);
}
export function removeGuardian(room: SharedRoom): void {
  const id = room.activities?.drop?.guardianId, actor = id && room.world.actor(id);
  if (actor && !room.records.get(id)?.wreck) {
    // Death at the withdrawal boundary still produces the ordinary wreck and its ordinary lifetime.
    if (room.outOfAction()[id]) room.wreck(actor);
    else { room.guardianSquad?.release(id); room.discard(id); }
  }
  room.guardianSquad = null;
}
