import { merged, within, clip } from './ground-sight.ts';
import { LOAD_REACH, BASE_SHARE, STARTING_STOCK, bill } from './economy.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { distance } from './format.ts';
import { phrase, translate } from './i18n.ts';
import type { SightSpan, Spans, SightGround, SightEye } from './ground-sight.ts';
import type { Deposit } from './deposits.ts';

// The ground a faction holds on the shared field: the same rules on the field (server/room.ts), which refuses a structure
// out of it, and on the page, which paints it on the strip of the field (overview.ts) and refuses a place the field would.
// A faction holds `BASE_TERRITORY` metres to each side of its base and `POST_TERRITORY` to each side of each of its posts,
// as one list of spans of the world from the left ([[from, to], …], in metres). A structure stands within its own
// territory, its edge as well, and nowhere in that of another faction: a faction grows outwards a post at a time.
export const BASE_TERRITORY = 5000, POST_TERRITORY = 2000;
// A faction has this many posts at most, each this far at least from its base and from its other posts — short of the
// territory of a post, so that one at the edge of another's widens the territory by as much as that, with half a kilometre
// of ground to choose it on —; and a post serves what stands still this many metres to each side of it, as a base serves
// what stands in it (economy.ts `BASE_RADIUS`).
export const POST_LIMIT = 4, POST_SPACING = 1500, POST_RADIUS = 50;
export const OUTSIDE = 'Fora do território da sua facção.', FOREIGN = 'No território de outra facção.', POST_FULL_MESSAGE = phrase`Sua facção já tem ${POST_LIMIT} postos.`;
export const POST_FULL = translate(POST_FULL_MESSAGE, 'pt-BR');
// A post is a place of its faction, as its base is, and not a construction: nothing meets it, nobody shoots it, and it is
// drawn behind the field (base-art.ts `drawPostArt`). It is called so wherever it is named.
export const POST_NAME = 'Posto';
// What raising a post costs, whatever the place: the share of each material a faction is founded with that establishing a
// base costs (economy.ts `BASE_SHARE`), and no fuel. A post is a great thing to have, and is paid for as one.
export const POST_BILL = Object.freeze(bill(STARTING_STOCK.ferro * BASE_SHARE, STARTING_STOCK.ligas * BASE_SHARE, STARTING_STOCK.silica * BASE_SHARE));
// A post sees for its faction as an optical camera does (combat-sensors.ts), from the top of its mast, this many metres
// over the ground at its middle — where its flag flies —, as far to each side as a camera sees, over the crests of the
// ground in between: the ground, and the constructions of others on it or over it, for the fog of the field (server/room.ts).
export const POST_EYE = 9, POST_SIGHT = SENSOR_MODES.visual.range;

// The ground a post at `x` stands on and serves, to each side of it: what nothing else of its faction is put up over,
// and what a builder stands beside to put it up or take it down.
export const postSpan = (x: number): { minX: number; maxX: number } => ({ minX: x - POST_RADIUS, maxX: x + POST_RADIUS });
// The eye of a post at `x` over `ground`, as the eyes of a construction are told (an eye at `x`, `y`, seeing `left` and
// `right` along the ground).
export const postEye = (x: number, ground: SightGround): SightEye => ({ x, y: ground.height(x) + POST_EYE, left: POST_SIGHT, right: POST_SIGHT });
// The territory of a faction with its base at `base` (or none) and posts at `posts`.
export const territoryOf = (base: number | null | undefined, posts: readonly number[] = []): SightSpan[] => merged([
  ...typeof base === 'number' && Number.isFinite(base) ? [[base - BASE_TERRITORY, base + BASE_TERRITORY] satisfies SightSpan] : [],
  ...posts.map((x): SightSpan => [x - POST_TERRITORY, x + POST_TERRITORY])]);
// What of `spans` lies within `seen` too: of the territory of another faction, what a faction may be told of it.
export const meeting = (spans: Spans, seen: Spans): SightSpan[] => merged(seen.flatMap(([from, to]) => clip(spans, from, to)));
// Why a structure over `span` may not stand there for the territories, in words, or nothing when it may: `own` is the
// territory of its faction, and `foreign` those of the others, each a list of spans. Touching the edge of another's is no
// standing in it.
export function territoryRefusal(span: { minX: number; maxX: number }, own: Spans, foreign: readonly Spans[] = []) {
  if (!within(own, span.minX, span.maxX)) return OUTSIDE;
  if (foreign.some(spans => clip(spans, span.minX, span.maxX).some(([from, to]) => to > from))) return FOREIGN;
  return '';
}
// Why a post may not stand at `x`, in words, or nothing when it may: its faction has as many posts as it may have,
// standing or being put up (`posts`, where each stands), it would stand too near the base (`base`) or one of them, or it
// would serve over a site of the ground (`sites`, deposits.ts): where a hauler loads, nothing unloads.
export function postRefusalMessage({ x, base = null, posts = [], sites = [] }: {
  x: number; base?: number | null; posts?: readonly number[]; sites?: readonly Pick<Deposit, 'x'>[];
}) {
  if (posts.length >= POST_LIMIT) return POST_FULL_MESSAGE;
  if ([base, ...posts].some(other => typeof other === 'number' && Number.isFinite(other) && Math.abs(other - x) < POST_SPACING))
    return phrase`Perto demais da base ou de outro posto: no mínimo ${distance(POST_SPACING)}.`;
  if (sites.some(site => Math.abs(site.x - x) <= POST_RADIUS + LOAD_REACH)) return phrase('Perto demais de uma jazida: o posto descarregaria onde os caminhões carregam.');
  return null;
}
export const postRefusal = (options: Parameters<typeof postRefusalMessage>[0]): string => translate(postRefusalMessage(options) ?? '');
