import type { CargoKind } from './economy-contract.ts';
import type { TerrainFeature } from './terrain.ts';

export interface Deposit { readonly id: string; readonly x: number; readonly material: CargoKind; readonly feature: DepositFeatureKind; readonly reserve: number }
export interface DepositTerrain { seed: number; length: number; center: number; features?: readonly TerrainFeature[] }

// Where the materials of the shared field are dug. The sites are read off the features of the
// generated ground, so the server and every page find the same ones with nothing sent: iron in
// outcrops and ruins, alloys in the scree at the foot of ridges and tablelands, silica in dunes,
// petroleum where it seeps into the low wet ground, one such place in so many (`DEPOSIT_RUN`). Every site holds a vein
// — ore, counted in kilograms, or petroleum, in litres — with a reserve of its own, what it holds when a field begins:
// what is dug of it the vein gains back by itself, a little at a time, up to that reserve and no
// further (`recovered`). What is left in each from then on is the field's to say (server/room.ts).
// Everything about a site follows from the seed and from where its feature lies, counted from the
// middle of the world: a longer world keeps the sites of a shorter one, but for the last few at each end, and adds to them.
export const DEPOSIT_FEATURES = Object.freeze({ outcrop: 'ferro', ruins: 'ferro', talus: 'ligas', dune: 'silica', lowland: 'petroleo' } satisfies Partial<Record<TerrainFeature['kind'], CargoKind>>);
export type DepositFeatureKind = keyof typeof DEPOSIT_FEATURES;
const isDepositFeature = (kind: TerrainFeature['kind']): kind is DepositFeatureKind => Object.hasOwn(DEPOSIT_FEATURES, kind);
export const DEPOSIT_SPACING = 600;   // metres of ground with such features that hold one place a site may be
export const DEPOSIT_RUN = 4;         // of the places of a material that follow each other along the ground, one is a site
export const DEPOSIT_RESERVE = 60000; // units a vein holds at the middle of the world
export const RICHEST = 3;             // times as much at the ends of the world
// Seconds of the field a vein takes to come back whole from nothing: two hours, at an even pace. A vein with a larger
// reserve gains back as much more in the same time.
export const RECOVERY_SECONDS = 2 * 60 * 60;
// Units what is left in a vein is told in. A vein with less than a step left is empty: it is told as nothing, and a
// hauler that finds it so there goes home (squad.ts `haul`), however little comes back to it meanwhile.
export const RESERVE_STEP = 1000;
const CHANNELS = { ferro: 401, ligas: 402, silica: 403, petroleo: 404 }, RUN_CHANNELS = { ferro: 411, ligas: 412, silica: 413, petroleo: 414 };

// An integer hash of the kind the ground is grown with: the same draw in every host.
function draw(seed: number, channel: number, cell: number): number {
  let n = (seed ^ Math.imul(channel + 1, 0x9e3779b9) ^ Math.imul(cell, 0x85ebca6b)) >>> 0;
  n = Math.imul(n ^ n >>> 16, 0x7feb352d); n = Math.imul(n ^ n >>> 15, 0x846ca68b);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
const known = new WeakMap<DepositTerrain, readonly Deposit[]>();
// The sites of a ground, from one end to the other. The ground is divided into stretches of
// `DEPOSIT_SPACING`, and of the features of a material that lie in one stretch the seed keeps
// one: a place about every 600 m where the ground has such features, and none where it has not.
// The places of a material are counted off from the middle of the world to each side, `DEPOSIT_RUN`
// at a time, and of each such run the seed keeps one as a site — the last run at an end too, however
// short: the sites of a thing lie about evenly along the ground that has it, and apart.
// The vein of a site is richer the farther it lies from the middle of the world.
export function depositsOf(terrain: DepositTerrain): readonly Deposit[] {
  let list = known.get(terrain);
  if (list) return list;
  type Place = { drawn: number; x: number; material: CargoKind; feature: DepositFeatureKind };
  const places = new Map<string, Place>(), half = terrain.length / 2, kept: [string, Place][] = [];
  for (const feature of terrain.features || []) {
    if (!isDepositFeature(feature.kind)) continue;
    const material = DEPOSIT_FEATURES[feature.kind];
    const u = feature.peak - terrain.center, id = material + ':' + Math.floor(u / DEPOSIT_SPACING), drawn = draw(terrain.seed, CHANNELS[material], Math.round(u));
    const previous = places.get(id);
    if (!(previous && previous.drawn <= drawn)) places.set(id, { drawn, x: feature.peak, material, feature: feature.kind });
  }
  for (const material of Object.keys(RUN_CHANNELS).filter((key): key is keyof typeof RUN_CHANNELS => Object.hasOwn(RUN_CHANNELS, key))) for (const side of [-1, 1]) {
    const row = [...places].filter(([, place]) => place.material === material && (side > 0) === (place.x >= terrain.center))
      .sort(([, a], [, b]) => side * (a.x - b.x));
    for (let start = 0, group = 1; start < row.length; start += DEPOSIT_RUN, group++) {
      const place = row[start + Math.floor(draw(terrain.seed, RUN_CHANNELS[material], side * group) * Math.min(DEPOSIT_RUN, row.length - start))];
      if (!place) throw new TypeError('Missing generated deposit.');
      kept.push(place);
    }
  }
  list = Object.freeze(kept.map(([id, { x, material, feature }]) => {
    const richness = 1 + (RICHEST - 1) * Math.min(1, Math.abs(x - terrain.center) / half);
    return Object.freeze({ id, x, material, feature, reserve: Math.round(DEPOSIT_RESERVE * richness) });
  }).sort((a, b) => a.x - b.x));
  known.set(terrain, list);
  return list;
}
// What is left of the vein of a site that had `left` once `seconds` more of the field go by: it gains back its whole
// reserve over `RECOVERY_SECONDS`, and never holds more than that.
export const recovered = (site: Pick<Deposit, 'reserve'>, left: number, seconds: number): number => Math.min(site.reserve, left + site.reserve * seconds / RECOVERY_SECONDS);
// The sites within `reach` of a place, from left to right.
export function depositsNear<Site extends { x: number }>(deposits: readonly Site[], x: number, reach: number): Site[] {
  let lo = 0, hi = deposits.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1, site = deposits[mid];
    if (!site) throw new TypeError('Missing deposit.');
    if (site.x < x - reach) lo = mid + 1; else hi = mid;
  }
  for (hi = lo; hi < deposits.length; hi++) { const site = deposits[hi]; if (!site || !(site.x <= x + reach)) break; }
  return deposits.slice(lo, hi);
}
