// The stress field exercises the vehicle allowance. Twenty factions, each at
// its limit of twelve vehicles, fight five battles of four far from each other. Every vehicle is
// the catalogue's heavy vehicle armed with a 20 mm. Each faction shells the next one's base in its
// battle, its guns aimed at the vehicles there, at a thousand rounds a minute until their barrels come to the 500 °C an
// automatic gun is held under, some 45 seconds on, and then in bursts as they cool (game_barrel.rs). A battle is fought
// on open ground, where its
// factions see each other: what a faction is told of the others is part of the worst. It is the field
// of the game in all else: its fog, a frame for each faction, the rounds and the happenings each one
// witnesses.
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { planStructuredComponent } from '../src/structured-construction.ts';
import { appraise, fieldParts } from '../src/economy.ts';
import { ROOM_LIMITS, rehearsal } from './room.ts';
import type { Terrain } from '../src/terrain.ts';
import type { Player } from './room-contract.ts';
import type { Point } from '../src/math.ts';

// The battles are a long march from each other; in one, the bases stand in a row. The guns are fed
// again every so many seconds.
// Keep the reference workload within its five battle sites when admission grows.
const FACTIONS = Math.min(20, ROOM_LIMITS.players), PER_BATTLE = 4, BATTLE_SPACING = 80000, BASE_SPACING = 300, FEED_SECONDS = 10;
// A battle is fought about its place, as near it as the ground is open (`SEARCH` at most, looked at every
// `STRIDE`): the vehicles of a faction stand as far as `STAND` to each side of its base, and see from `EYE`
// over the ground.
const SEARCH = 20000, STRIDE = 50, STAND = 90, EYE = 2, LOOK = 10;
const battles = Math.ceil(FACTIONS / PER_BATTLE);
export const STRESS_FIELD = Object.freeze({ perBattle: PER_BATTLE, baseSpacing: BASE_SPACING, search: SEARCH,
  battles: Object.freeze(Array.from({ length: battles }, (_, i) => (i - (battles - 1) / 2) * BATTLE_SPACING)),
  // How high over a base whoever comes to watch looks from, and the pixels a metre that fit a battle in a window.
  watch: Object.freeze({ rise: 30, zoom: 1 }) });

const basesAbout = (centre: number): number[] => Array.from({ length: PER_BATTLE }, (_, k) => centre + (k - (PER_BATTLE - 1) / 2) * BASE_SPACING);
// Of the lines between where the factions of a battle about `centre` stand, the share the ground leaves clear.
function open(terrain: Pick<Terrain, 'height'>, centre: number): number {
  const stands = basesAbout(centre).flatMap((base, side) => [-STAND, 0, STAND].map(off => ({ side, x: base + off, y: terrain.height(base + off) + EYE })));
  let clear = 0, lines = 0;
  for (const a of stands) for (const b of stands) {
    if (a.side >= b.side) continue;
    lines++;
    let hidden = false;
    for (let x = a.x + LOOK; x < b.x && !hidden; x += LOOK) hidden = terrain.height(x) > a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
    if (!hidden) clear++;
  }
  return clear / lines;
}
// Where the bases of the stress field stand on a ground: each battle the nearest to its place where every faction
// sees every other, or where they see the most of each other.
export function stressBases(terrain: Pick<Terrain, 'height'>): number[] {
  return STRESS_FIELD.battles.flatMap(about => {
    let best = about, most = -1;
    for (let off = 0; off <= SEARCH && most < 1; off += STRIDE) for (const centre of off ? [about + off, about - off] : [about]) {
      const share = open(terrain, centre);
      if (share > most) { most = share; best = centre; }
    }
    return basesAbout(best);
  });
}

// The heavy vehicle with the 20 mm on the mount of a support vehicle, and its magazine of those rounds.
function stressDesign() {
  const frame = createStructuredTemplate('heavy', { preset: 'rh202' }), gun = frame.components.find(part => part.kind === 'weapon')!;
  return planStructuredComponent({ ...frame, name: 'Pesado 20 mm' }, { ...gun,
    mount: { ...gun.mount, sector: { min: -.08, max: .08 } } }).construction;
}

// The stress field: a field with the factions fielded (`factions` of them, for a smaller field to measure) and
// firing. Their players are nobody's: they leave, and the field has its seats free for whoever comes to watch. A
// faction with nobody on the field calls its constructions home and they stop (room.ts, `recall`): the guns are laid
// on the bases they shell once their players have left, and `feed` lays again any that stopped since — one whose
// faction a watcher left — and keeps the magazines full: the host calls it with the time of the field, as often as it
// likes. `seat` puts a player who came into one of the factions, each newcomer into the next: what a faction
// is told is what its members are, and the welcome says of it what changed with that, and where to look.
export function stressField(factions: number = FACTIONS) {
  let bases: number[] | null = null;
  const room = rehearsal((i: number): number => { const places = bases ||= stressBases(room.world.terrain); return places[Math.min(i, places.length - 1)]!; }),
    design = stressDesign(), sides: Player[] = [], aims: { player: Player; id: string; point: Point }[] = [];
  for (let i = 0; i < factions; i++) {
    const player = room.players.get(room.join('Facção ' + (i + 1)).playerId)!;
    for (let k = 0; k < ROOM_LIMITS.perFaction.vehicles; k++) { player.builtAt = -Infinity; room.publish(player.id, structuredClone(design)); }
    room.take(player, null); sides.push(player);
  }
  for (const [i, player] of sides.entries()) {
    const first = Math.floor(i / PER_BATTLE) * PER_BATTLE, foe = sides[first + (i - first + 1) % Math.min(PER_BATTLE, factions - first)]!, targets = room.owned(foe.id);
    for (const [k, actor] of room.owned(player.id).entries()) {
      const x = targets[k % targets.length]!.vehicle!.x;
      aims.push({ player, id: actor.id, point: { x, y: room.world.terrain.height(x) + 1.5 } });
    }
    room.disconnect(player.id);
  }
  const lay = () => {
    for (const { player, id, point } of aims) {
      const unit = player.squad!.units.get(id);
      if (unit && !unit.attack?.point && !room.records.get(id)?.wreck) room.order(player, { order: 'bombard', ids: [id], point });
    }
  };
  lay();
  let fedAt = 0, seated = 0;
  return {
    room,
    feed(time: number): void {
      if (time - fedAt < FEED_SECONDS) return;
      fedAt = time; lay();
      const parts = fieldParts(room.world);
      for (const actor of room.world.actors) if (!room.records.get(actor.id)?.wreck) room.supply(actor, appraise(actor, parts).full);
    },
    seat(playerId: string) {
      const player = room.players.get(playerId)!, faction = room.factions.get(sides[seated++ % sides.length]!.factionId!)!;
      if (player.factionId !== faction.id) { faction.invited.add(player.id); room.enlist(player, faction.id); }
      const base = room.base(player)!;
      return { base, faction: room.factionView(player.id), watch: { x: base.x, y: base.y + STRESS_FIELD.watch.rise, zoom: STRESS_FIELD.watch.zoom } };
    },
  };
}
