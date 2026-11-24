export interface ShotLegend {
  preset: string | null; ammo: string; poweredTrail: boolean;
  actorId?: string | null | undefined; weapon?: string | undefined; name?: string | null | undefined;
}
export interface ShotKind extends ShotLegend { actorId: string | null; weapon: string; name: string | null }
export type PublicShotKind = Pick<ShotKind, 'preset' | 'ammo' | 'poweredTrail'>;
export interface ShotView {
  id: string; number: number; actorId?: string | null | undefined; ammo: string; weapon?: string | undefined; preset: string | null; poweredTrail: boolean;
  x: number; y: number; vx: number; vy: number; age: number; radius: number;
}
export interface Shot extends ShotView { actorId: string | null; weapon: string }
export interface ShotBlock<Kind extends ShotLegend = ShotKind> { data: Float64Array; kinds: readonly Kind[] }
export type ShotInput = { [Key in keyof Shot]?: Shot[Key] | null | undefined };

// The rounds in the air as the core tells them: eight numbers a round, and a legend of the few
// kinds they are of. A screen that shows thousands of rounds reads the numbers; nothing makes an
// object of a round it does not draw.
//
//   shots = { data: Float64Array, kinds: [kind, ...] }
//   0  number   the round's own, kept for as long as it flies
//   1  kind     its place in `kinds`
//   2… x, y, vx, vy, age, radius — as the core holds them: a round a hundred kilometres from the
//      middle of the world is where the core has it, to the last bit
//
//   kind = { actorId, weapon, preset, ammo, poweredTrail, name }
//
// A round is called `name` when it was given one, otherwise `shot-number`: the `id` of the
// paths its flight sends, which carry the same number as `n`.
export const SHOT_WORDS = 8;
export const SHOT_NUMBER = 0, SHOT_KIND = 1, SHOT_X = 2, SHOT_Y = 3, SHOT_VX = 4, SHOT_VY = 5, SHOT_AGE = 6, SHOT_RADIUS = 7;
export const NO_SHOTS: Readonly<ShotBlock> = Object.freeze({ data: new Float64Array(0), kinds: Object.freeze([]) });

export const shotCount = (shots: ShotBlock<ShotLegend> | null | undefined): number => shots ? shots.data.length / SHOT_WORDS : 0;
export const shotId = (kind: Pick<ShotLegend, 'name'>, number: number | string): string => kind.name ?? 'shot-' + number;

// One round as an object: for the few a screen draws, a test looks at or a camera follows.
export function shotAt(shots: ShotBlock, index: number): Shot;
export function shotAt<Kind extends ShotLegend>(shots: ShotBlock<Kind>, index: number): ShotView;
export function shotAt(shots: ShotBlock<ShotLegend>, index: number): ShotView {
  const data = shots.data, at = index * SHOT_WORDS, number = data[at]!, kind = shots.kinds[data[at + SHOT_KIND]!]!;
  return { id: shotId(kind, number), number, actorId: kind.actorId, ammo: kind.ammo, weapon: kind.weapon, preset: kind.preset,
    poweredTrail: kind.poweredTrail, x: data[at + SHOT_X]!, y: data[at + SHOT_Y]!, vx: data[at + SHOT_VX]!, vy: data[at + SHOT_VY]!,
    age: data[at + SHOT_AGE]!, radius: data[at + SHOT_RADIUS]! };
}
// Every round as an object. Not for a frame of a long volley: see `shotAt`.
export function listShots(shots: ShotBlock | null | undefined): Shot[];
export function listShots<Kind extends ShotLegend>(shots: ShotBlock<Kind> | null | undefined): ShotView[];
export function listShots(shots: ShotBlock<ShotLegend> | null | undefined): ShotView[] {
  return Array.from({ length: shotCount(shots) }, (_, index) => shotAt(shots!, index));
}
// A block made by hand, from rounds told as objects: a scene a test or a tool writes.
// A round without a number takes the one at the end of its `id`, or its place in the list.
export function packShots(list: readonly ShotInput[]): ShotBlock {
  const kinds: ShotKind[] = [], known = new Map<string, number>(), data = new Float64Array(list.length * SHOT_WORDS);
  list.forEach((shot, index) => {
    const number = shot.number ?? Number(/-(\d+)$/.exec(shot.id || '')?.[1] ?? index + 1) >>> 0,
      kind = { actorId: shot.actorId ?? null, weapon: shot.weapon ?? '', preset: shot.preset ?? null, ammo: shot.ammo ?? 'ap',
        poweredTrail: Boolean(shot.poweredTrail), name: shot.id == null || shot.id === 'shot-' + number ? null : shot.id },
      key = JSON.stringify(kind), at = index * SHOT_WORDS;
    if (!known.has(key)) { known.set(key, kinds.length); kinds.push(kind); }
    data[at] = number; data[at + SHOT_KIND] = known.get(key)!;
    data[at + SHOT_X] = shot.x ?? 0; data[at + SHOT_Y] = shot.y ?? 0; data[at + SHOT_VX] = shot.vx ?? 0; data[at + SHOT_VY] = shot.vy ?? 0;
    data[at + SHOT_AGE] = shot.age ?? 0; data[at + SHOT_RADIUS] = shot.radius ?? 0;
  });
  return { data, kinds };
}
