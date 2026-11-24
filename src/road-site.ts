import { phrase, tr, translate } from './i18n.ts';
import { isRoadKind, stretches } from './roads.ts';
import { within, bridged } from './ground-sight.ts';
import type { Road, RoadKind, RoadSpan } from './roads.ts';
import type { Spans, SightSpan } from './ground-sight.ts';

export type RoadPart = 'grade' | 'pave';
export interface RoadWorkRequest { x0: number; x1: number; kind: RoadKind; roads: readonly Road[]; taken?: readonly Road[] }

// Where a road may be asked for on the shared field, and what it makes there: the same rules on the field
// (server/road-works.ts) and on the page that chooses the stretch (road-placement.ts), each with what it knows. A road is
// asked for over a stretch of ground its faction knows (`roadKnown`), this long at least and at most, within the ends of the
// field. What it makes there is what of the stretch is short of the road asked for and no road its faction asked for
// already is to make (`roadWork`): a stretch asked for from one road to another, over either or both, joins them, and one
// with nothing of that is refused. Anywhere else on the field: across the base, whose apron is asphalt already, or
// another's, as the faction sees it.
export const ROAD_SHORTEST = 10, ROAD_LONGEST = 10000;
// What is left of a stretch shorter than this is none: a seam between two roads, or between two chunks of one.
export const ROAD_SEAM = .05;
// A fold of the ground no eye of the faction caught, this wide or less, between ground it explored, it knows all the same:
// the bank of mist over it never closes (ground-mist.ts `mistBands`, which comes on over `MIST_EDGE` metres from each side):
// it comes a third of the way up its ramp at the most, and shows at about a quarter of its strength, the ground showing
// through it. A road over it tells nothing of it the screen does not.
export const ROAD_FOLD = 40;
const KIND_WORDS = Object.freeze({ graded: tr('Terra batida'), asphalt: tr('Asfalto') });
export const roadKindText = (kind: unknown): string => isRoadKind(kind) ? KIND_WORDS[kind] : '';

// The ground a faction knows for a road, of the ground it explored: that, with the folds of `ROAD_FOLD` between.
export const roadKnown = (explored: Spans): SightSpan[] => bridged(explored, ROAD_FOLD);
// The stretches of `spans` not covered by any of `cuts`.
export function without(spans: RoadSpan[], cuts: Spans): RoadSpan[] {
  let left = spans;
  for (const [from, to] of cuts) left = left.flatMap(([a, b]): RoadSpan[] => b <= from || a >= to ? [[a, b]] : ([[a, Math.min(b, from)], [Math.max(a, to), b]] satisfies RoadSpan[]).filter(([x, y]) => y > x));
  return left;
}
const whole = ([a, b]: readonly [number, number]): boolean => b - a >= ROAD_SEAM;
// The stretches of the roads of a faction asked for over others (`taken`, of each its ends and kind) that make a part of them:
// every one grades its stretch, and one of asphalt paves it.
const making = (taken: readonly Road[], part: RoadPart): RoadSpan[] => taken.flatMap((road): RoadSpan[] => part === 'grade' || road.kind === 'asphalt' ? [[road.x0, road.x1]] : []);

// What a road of `kind` asked for from `x0` to `x1` makes there, of the field's `roads`, as [from, to] in order: what of the
// stretch is short of that kind — natural ground, and of asphalt graded earth too — but what the roads its faction asked for
// already (`taken`) are to make that kind or better.
export function roadWork({ x0, x1, kind, roads, taken = [] }: RoadWorkRequest): RoadSpan[] {
  const short = kind === 'graded' ? stretches(roads, x0, x1, null) : without([[x0, x1]], stretches(roads, x0, x1, 'asphalt'));
  return without(short, making(taken, kind === 'graded' ? 'grade' : 'pave')).filter(whole);
}
// What is left of a part of the making of a road — `grade`, or `pave` — of the field's `roads`, as [from, to] in order: the
// natural ground of its stretch, that a blade grades, or the graded earth, that a paver paves; but what the roads its faction
// asked for before it (`before`) are to make of that. A stretch two roads were asked for over is made once, for the one asked
// for first, and the later's again when that one is given up.
export function roadLeft({ x0, x1 }: Pick<Road, 'x0' | 'x1'>, part: RoadPart, roads: readonly Road[], before: readonly Road[] = []): RoadSpan[] {
  return without(stretches(roads, x0, x1, part === 'grade' ? null : 'graded'), making(before, part)).filter(whole);
}

// Why a road may not be asked for from `x0` to `x1` as `kind`, in words, or nothing when it may. `limits` are the ends of the
// field it may come to; `explored` the ground its faction has explored (nothing on a field without fog, where it knows all of
// it); `roads` those the field has laid; and `taken` those its faction asked for already, of each its ends and kind. Unknown
// ground is refused before what lies on it is read: a stretch asked for is no scouting tool.
export function roadRefusalMessage({ x0, x1, kind, limits, explored = null, roads, taken = [] }: Omit<RoadWorkRequest, 'kind'> & {
  kind: unknown; limits: { minX: number; maxX: number }; explored?: Spans | null;
}) {
  if (!isRoadKind(kind)) return phrase('Tipo de estrada inválido.');
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return phrase('Trecho inválido.');
  const a = Math.min(x0, x1), b = Math.max(x0, x1);
  if (b - a < ROAD_SHORTEST) return phrase`Trecho curto demais: no mínimo ${ROAD_SHORTEST} m.`;
  if (b - a > ROAD_LONGEST) return phrase`Trecho longo demais: no máximo ${ROAD_LONGEST / 1000} km.`;
  if (a < limits.minX || b > limits.maxX) return phrase('O trecho passa do limite do campo.');
  if (explored && !within(roadKnown(explored), a, b)) return phrase('Terreno desconhecido: escolha chão já visto.');
  if (roadWork({ x0: a, x1: b, kind, roads, taken }).length) return null;
  return roadWork({ x0: a, x1: b, kind, roads }).length ? phrase('Já há uma estrada pedida nesse trecho.') : kind === 'graded' ? phrase('Esse trecho já tem estrada.') : phrase('Esse trecho já é de asfalto.');
}

export const roadRefusal = (options: Parameters<typeof roadRefusalMessage>[0]): string => translate(roadRefusalMessage(options) ?? '');
