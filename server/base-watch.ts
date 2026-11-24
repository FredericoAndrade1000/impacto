// The watch a base keeps of its own, with no construction to keep it: a radar that follows the shells in the air
// about it and says where each was fired from, and ears that hear the guns of the field and say, later and less
// surely, where each stood. Neither sees a construction. What a faction is told is a place and how far off that
// may be: the mark of a gun that gave itself away by firing, surer with every round of it that is followed, and
// kept for a while after the last (`BATTERY_SECONDS`). A gun that fires and moves leaves its mark behind; one that
// fires from the air leaves it in the air, as high as it was (`ALOFT`). A mark does not name the construction that
// fired: it has a name of its own, and a gun found again or elsewhere another. How far a base is from a gun, or from a
// shell, is the straight line between them: along the field and up alike.
import { WEAPONS, isWeaponId, weaponOf } from '../src/weapons.ts';
import { SHOT_WORDS, SHOT_NUMBER, SHOT_KIND, SHOT_X, SHOT_Y, SHOT_VX, SHOT_VY, SHOT_AGE } from '../src/shots.ts';
import { BATTERY_SECONDS, LOW_AIR } from '../src/battle-rules.ts';
import type { ShotLegend } from '../src/shots.ts';

export type WatchShotKind = Pick<ShotLegend, 'actorId' | 'preset' | 'weapon'>;
type ShotActorId = WatchShotKind['actorId'];
export interface WatchShots { data: Float64Array; kinds: readonly WatchShotKind[] }
export interface WatchBase { team: string; x: number; y: number }
interface WatchTerrain { height(x: number): number }
interface GunPlace { x: number; y: number | null }
interface TrackedBase { actorId: ShotActorId; team: string | null | undefined; calibre: number; tracked: Set<string>; aloft: boolean }
type TrackedRound = TrackedBase & ({ x: null; y: null } | { x: number; y: number });
type LocatedRound = TrackedBase & { x: number; y: number };
interface HeldGun extends GunPlace { id: string; weight: number; error: number; at: number; radar: boolean }
interface EarReport { team: string; actorId: ShotActorId; place: GunPlace; error: number; at: number }
export interface BatteryMark { id: string; kind: 'battery'; x: number; y?: number; error: number; at: number; by: 'radar' | 'sound' }
export interface WatchLook {
  shots: WatchShots; bases: readonly WatchBase[]; teamOf(id: ShotActorId): string | null | undefined;
  terrain: WatchTerrain; time: number;
}

// The radar follows shells, not bullets: rounds of this calibre (mm) and more, within this many metres of its mast —
// this high over the base —, that it has in sight over the ground in between.
export const TRACK_CALIBRE = 60, RADAR_REACH = 8000, RADAR_MAST = 25;
// One round followed puts the gun within this share of the way from the base to it, and no nearer than so many metres.
export const RADAR_ERROR = .015, RADAR_FLOOR = 20;
// The ears hear a gun of this calibre (mm) and more, so many metres off for each millimetre of it, as late as its
// sound takes to come, and no more often than every so many seconds: one report says less than one round followed.
export const EAR_CALIBRE = 40, EAR_REACH = 60, EAR_ERROR = .06, EAR_FLOOR = 60, SOUND_SPEED = 343, EAR_PAUSE = 1;
// However many rounds of a gun are followed, its place is told no surer than this (m).
export const BEST_FIX = 10;
// A gun that fired from higher than this over the ground under it (m) fired from the air: as high as the sky begins over
// ground a faction knows (battle-rules.ts `LOW_AIR`). Its mark says how high it is, and never lower than that.
export const ALOFT = LOW_AIR;
// The ground under the line from the mast to a shell is looked at this often (m), and a round met in the air no
// later than this (s) after it was fired says where it left its gun.
const SIGHT_STRIDE = 64, FRESH = .25;

// A round is of the calibre of the gun it was fired from, made over or not; of a gun not named, of its kind's.
const FAMILIES: Readonly<Partial<Record<string, { caliberMm: number }>>> = WEAPONS;
const calibreOf = (kind: WatchShotKind): number => (isWeaponId(kind.preset) ? weaponOf(kind.preset)?.caliberMm : undefined) ??
  (kind.weapon === undefined ? undefined : FAMILIES[kind.weapon]?.caliberMm) ?? 0;
// A number from -1 to 1, always the same for the same round and the same listener: how far off, of what it may be,
// that listener has that round.
function scatter(number: number, salt: number): number {
  let h = Math.imul(number ^ salt, 0x9E3779B1); h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return (h >>> 0) / 0x7FFFFFFF - 1;
}
const salted = (name: string): number => { let h = 0; for (let i = 0; i < name.length; i++) h = Math.imul(h, 31) + name.charCodeAt(i) | 0; return h; };
// Where a listener has the gun of a round, as far off as `error`: along the field off by as much as that, each listener its
// own way (`scatter`, by its salt); and of one that fired from the air, how high, off as much again and never lower over the
// ground there than the air begins (`ALOFT`). Of one on the ground, no height.
function placed(round: LocatedRound, error: number, number: number, salt: number, terrain: WatchTerrain): GunPlace {
  const x = round.x + error * scatter(number, salt);
  return { x, y: round.aloft ? Math.max(terrain.height(x) + ALOFT, round.y + error * scatter(number, salt + 2)) : null };
}
// Whether the radar of a base has a place in the air in sight: no ground stands in the line from its mast to it.
function clear(terrain: WatchTerrain, base: WatchBase, x: number, y: number): boolean {
  const from = base.y + RADAR_MAST, steps = Math.ceil(Math.abs(x - base.x) / SIGHT_STRIDE);
  for (let i = 1; i < steps; i++) if (terrain.height(base.x + (x - base.x) * i / steps) > from + (y - from) * i / steps) return false;
  return true;
}

export class BaseWatch {
  declare rounds: Map<number, TrackedRound>;
  declare reports: EarReport[];
  declare heard: Map<string, number>;
  declare books: Map<string, Map<ShotActorId, HeldGun>>;
  declare named: Map<string, number>;
  declare legend: { of: readonly WatchShotKind[]; calibres: number[] } | null;
  constructor() {
    // The rounds in the air worth following, by number: whose each is, where it left its gun and the teams that follow it.
    this.rounds = new Map();
    // The reports of guns on their way to the ears of a base, and when each team last took one of each gun.
    this.reports = []; this.heard = new Map();
    // By team: where it holds each gun of another, how far off that may be, and when it last had word of it; and how
    // many marks it was given names for.
    this.books = new Map(); this.named = new Map(); this.legend = null;
  }
  // One look at the rounds in the air (`shots`, a block of them: shots.ts) at `time`, for the bases of the field —
  // of each the `team` it is of, where it stands (`x`) and how high its ground is (`y`). `teamOf` says the team
  // of a construction, or nothing of one that is gone, and `terrain` is the ground.
  look({ shots, bases, teamOf, terrain, time }: WatchLook): void {
    const data = shots.data, flying = new Set<number>();
    // The reports that have come by now are heard, each where its sound puts the gun and as of when it came.
    this.reports = this.reports.filter(report => {
      if (report.at > time) return true;
      this.#fix(report.team, report.actorId, report.place, report.error, report.at, false); return false;
    });
    // An absent faction has no reader of marks to release its expired fixes.
    for (const book of this.books.values()) for (const [actorId, held] of book)
      if (time - held.at > BATTERY_SECONDS) book.delete(actorId);
    for (const [key, at] of this.heard) if (time - at >= EAR_PAUSE) this.heard.delete(key);
    if (this.legend?.of !== shots.kinds) this.legend = { of: shots.kinds, calibres: [] };
    for (let at = 0; at < data.length; at += SHOT_WORDS) {
      const place = data[at + SHOT_KIND]!, kind = shots.kinds[place]!, calibre = this.legend!.calibres[place] ??= calibreOf(kind);
      if (calibre < EAR_CALIBRE) continue;
      const number = data[at + SHOT_NUMBER]!;
      let round = this.rounds.get(number);
      if (!round) {
        const team = teamOf(kind.actorId), age = data[at + SHOT_AGE]!, fresh = team != null && age <= FRESH;
        // Met late, a round does not say where it came from: nobody follows it back.
        const common = { actorId: kind.actorId, team, calibre, tracked: new Set<string>() };
        if (fresh) {
          const x = data[at + SHOT_X]! - data[at + SHOT_VX]! * age, y = data[at + SHOT_Y]! - data[at + SHOT_VY]! * age;
          round = { ...common, x, y, aloft: y - terrain.height(x) > ALOFT };
        } else round = { ...common, x: null, y: null, aloft: false };
        this.rounds.set(number, round);
        if (round.x !== null) this.#report(round, number, bases, time, terrain);
      }
      flying.add(number);
      if (round.x === null || calibre < TRACK_CALIBRE) continue;
      for (const base of bases) {
        if (base.team === round.team || round.tracked.has(base.team)) continue;
        const x = data[at + SHOT_X]!, y = data[at + SHOT_Y]!, mast = base.y + RADAR_MAST;
        if (Math.hypot(x - base.x, y - mast) > RADAR_REACH || !clear(terrain, base, x, y)) continue;
        round.tracked.add(base.team);
        const error = Math.max(RADAR_FLOOR, RADAR_ERROR * Math.hypot(round.x - base.x, round.y - mast));
        this.#fix(base.team, round.actorId, placed(round, error, number, salted(base.team), terrain), error, time, true);
      }
    }
    for (const number of this.rounds.keys()) if (!flying.has(number)) this.rounds.delete(number);
  }
  // The report of a round just fired sets out for every base of another team within earshot of its gun.
  #report(round: LocatedRound, number: number, bases: readonly WatchBase[], time: number, terrain: WatchTerrain): void {
    for (const base of bases) {
      const far = Math.hypot(round.x - base.x, round.y - base.y), key = base.team + '\n' + round.actorId;
      if (base.team === round.team || far > EAR_REACH * round.calibre || this.heard.has(key)) continue;
      this.heard.set(key, time);
      const error = Math.max(EAR_FLOOR, EAR_ERROR * far);
      this.reports.push({ team: base.team, actorId: round.actorId, place: placed(round, error, number, salted(base.team) + 1, terrain), error, at: time + far / SOUND_SPEED });
    }
  }
  // A word of where a gun stands, as far off as it may be: weighed with what the team held of that gun, the surer
  // the more. A word far from where the gun was held is of a gun that moved: what was held of it is dropped. The
  // radar's word and the ears' are not weighed together: a report is of an earlier round, and of where the gun
  // stood then. What the radar holds the ears add nothing to, and its first word of a gun takes the place of theirs:
  // the mark is the same one, better placed. A gun found anew, or elsewhere — a gun on the ground that took to the air,
  // or came down from it, is elsewhere —, is a mark with a name of its own. A word is of a place (`placed`): where along
  // the field, and how high in the air, or nothing of a height on the ground.
  #fix(team: string, actorId: ShotActorId, { x, y }: GunPlace, error: number, time: number, radar: boolean): void {
    let book = this.books.get(team);
    if (!book) this.books.set(team, book = new Map());
    const held = book.get(actorId), weight = 1 / (error * error), kept = held && time - held.at <= BATTERY_SECONDS;
    if (kept && held.radar && !radar) return;
    if (kept && radar && !held.radar) Object.assign(held, { x, y, weight, error, at: time, radar });
    else if (!kept || (y === null) !== (held.y === null) || Math.hypot(x - held.x, (y ?? 0) - (held.y ?? 0)) > 3 * Math.max(error, held.error)) {
      const count = (this.named.get(team) ?? 0) + 1; this.named.set(team, count);
      book.set(actorId, { id: 'battery:' + count, x, y, weight, error, at: time, radar });
    }
    else {
      const sum = held.weight + weight;
      held.x = (held.x * held.weight + x * weight) / sum;
      if (y !== null) held.y = (held.y! * held.weight + y * weight) / sum;
      held.weight = sum; held.error = Math.max(BEST_FIX, 1 / Math.sqrt(sum)); held.at = time;
    }
  }
  // The guns `team` holds at `time`, as the marks it is told: of each the name of the mark (`id`), where — along the
  // field, and of one that fired from the air how high (`y`): one with no height stands on the ground —, how far off
  // that may be, when it last had word of it and whether its radar followed a round of it (`by`) or its ears alone
  // heard it. A gun of a construction the team is told as it is (`known`, those by their ids) has no mark.
  marks(team: string, time: number, known: ReadonlySet<string> | null = null, permit: ((actorId: string) => boolean) | null = null): BatteryMark[] {
    const book = this.books.get(team), marks: BatteryMark[] = [];
    if (book) for (const [actorId, held] of book) {
      if (time - held.at > BATTERY_SECONDS) book.delete(actorId);
      else if (!known?.has(actorId!) && (!permit || permit(actorId!))) marks.push({ id: held.id, kind: 'battery', x: Math.round(held.x * 10) / 10,
        ...held.y === null ? {} : { y: Math.round(held.y * 10) / 10 }, error: Math.round(held.error), at: Math.round(held.at * 1000) / 1000, by: held.radar ? 'radar' : 'sound' });
    }
    return marks;
  }
  // Server-side identity for acquisition policy only. A public battery mark still names no construction.
  source(team: string, markId: string): string | null { return [...this.books.get(team) ?? []].find(([, held]) => held.id === markId)?.[0] ?? null; }
  // Whether the radar of a team's base follows a round, by its number: from when it picked it up until it lands.
  follows(team: string): (number: number) => boolean { return number => this.rounds.get(number)?.tracked.has(team) ?? false; }
  forget(team: string): void { this.books.delete(team); this.named.delete(team); this.reports = this.reports.filter(report => report.team !== team); }
}
