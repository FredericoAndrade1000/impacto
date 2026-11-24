import { clamp } from './math.ts';
import { isWeaponId, weaponOf } from './weapons.ts';
import type { Point } from './math.ts';

export interface ProjectileVisualState {
  vx?: number | undefined;
  vy?: number | undefined;
  radius?: number | undefined;
  fragment?: boolean | undefined;
  trace?: boolean | undefined;
  weapon?: string | null | undefined;
  preset?: string | null | undefined;
  poweredTrail?: boolean | null | undefined;
  ammo?: string | undefined;
}
export interface ProjectileAppearance {
  speed: number; length: number; width: number; color: number; alpha: number;
  direction: Point | null; bodyKind: 'rocket' | 'he' | 'dart' | 'ap';
  bodyLength: number; bodyWidth: number; finSpan: number;
  bodyColor: number; noseColor: number; bandColor: number; highlightColor: number;
  finColor: number; outline: number; outlineWidth: number;
}
export interface ProjectileBodyGeometry {
  shell: number[]; nose: number[]; band: number[]; highlight: number[]; fins: number[];
}

// A round of another faction comes with the preset of its gun and not the gun's kind (server/fog.ts): a rocket is
// known by either.
export function projectileAppearance(shot: ProjectileVisualState, zoom: number): ProjectileAppearance | null {
  if (shot.fragment) return null;
  const speed = Math.hypot(Number(shot.vx), Number(shot.vy)) || 1;
  const pixels = Math.max(1, Number(zoom) || 1), radius = clamp(shot.radius || .007, .001, .12),
    rocket = shot.weapon === 'rocket' || shot.poweredTrail === true || isWeaponId(shot.preset) && weaponOf(shot.preset)?.family === 'rocket',
    bodyKind = rocket ? 'rocket' : shot.ammo === 'he' || shot.ammo === 'heat' ? 'he' : shot.ammo === 'apfsds' ? 'dart' : 'ap',
    dart = bodyKind === 'dart', moving = Number.isFinite(shot.vx) && Number.isFinite(shot.vy) && Math.hypot(Number(shot.vx), Number(shot.vy)) > 1e-8;
  return { speed, length: clamp(speed * .001, .09, .7), width: Math.max(.019, 1.5 / pixels),
    color: rocket ? 0xe6dec1 : bodyKind === 'he' ? 0xf2c78a : 0xf9e9c4, alpha: .94,
    direction: moving ? { x: Number(shot.vx) / speed, y: Number(shot.vy) / speed } : null, bodyKind,
    bodyLength: dart ? Math.max(clamp(radius * 2 * DART.length, .1, .9), 16 / pixels) :
      Math.max(clamp(radius * (rocket ? 11 : bodyKind === 'he' ? 5 : 6), .045, rocket ? .70 : .48), (rocket ? 12 : 9) / pixels),
    bodyWidth: dart ? Math.max(radius * 2 * DART.rod, 1.6 / pixels) : Math.max(radius * 1.85, (rocket ? 3.6 : 2.8) / pixels),
    finSpan: dart ? Math.max(radius * 2 * DART.fins, 4.4 / pixels) : 0,
    bodyColor: dart ? 0x9fa39a : rocket ? 0x819078 : bodyKind === 'he' ? 0x829169 : 0xd6d4b5,
    noseColor: dart ? 0x6d756f : bodyKind === 'ap' ? 0x85958f : 0xe7d6a4,
    bandColor: bodyKind === 'he' ? 0xd6a35d : 0xb59362,
    highlightColor: dart ? 0xf1f1e2 : bodyKind === 'ap' ? 0xfff9df : 0xdce7c5,
    finColor: dart ? 0x8a9488 : 0x627c63, outline: 0x21352d, outlineWidth: Math.max(.0015, .8 / pixels) };
}
// A fin-stabilised round flies as its dart alone, the sabot shed at the muzzle: a rod DART.length calibres long and
// DART.rod of one thick (the 745 by 26 mm of a 120 mm DM53), a sharp tip, and a tail of fins DART.fins of a calibre
// across, seen side on as one swept fin above the rod and one below.
const DART = { length: 6.2, rod: .22, fins: .75 };

// Bodies follow the recorded velocity; pixel minima affect only their paint.
// Geometry stays separate from ballistic state and makes a single Graphics
// batch sufficient for pointed AP rounds, banded HE shells, finned rockets and darts.
export function projectileBodyGeometry(shot: ProjectileVisualState & Point, visual: ProjectileAppearance | null): ProjectileBodyGeometry {
  const empty: ProjectileBodyGeometry = { shell: [], nose: [], band: [], highlight: [], fins: [] };
  if (shot.fragment || shot.trace || !visual?.direction || !Number.isFinite(shot.x) || !Number.isFinite(shot.y)) return empty;
  const { x: dx, y: dy } = visual.direction, length = visual.bodyLength, radius = visual.bodyWidth * .5,
    rocket = visual.bodyKind === 'rocket', tail = -length * .52,
    shoulder = length * (rocket ? .28 : .16), tip = length * .48;
  // The nose is the recorded flight point. Every other painted vertex sits
  // behind it so the visible body cannot lead the true contact position.
  const polygon = (points: readonly [number, number][]): number[] => points.flatMap(([x, y]) => [shot.x + dx * (x - tip) - dy * y, shot.y + dy * (x - tip) + dx * y]);
  if (visual.bodyKind === 'dart') {
    const point = tip - length * .07, span = visual.finSpan * .5, root = length * .17;
    return {
      shell: polygon([[tail, -radius], [point, -radius], [tip, 0], [point, radius], [tail, radius]]),
      nose: polygon([[point, -radius * .95], [tip, 0], [point, radius * .95]]),
      band: [],
      highlight: polygon([[tail + root, -radius * .55], [point, -radius * .5], [point, -radius * .15], [tail + root, -radius * .2]]),
      fins: polygon([[tail, -span], [tail + root * .45, -span], [tail + root, -radius], [tail + root, radius], [tail + root * .45, span], [tail, span]]),
    };
  }
  return {
    shell: polygon([[tail, -radius * .68], [tail + length * .07, -radius], [shoulder, -radius * .90],
      [tip, 0], [shoulder, radius * .90], [tail + length * .07, radius], [tail, radius * .68]]),
    nose: polygon([[shoulder, -radius * .88], [tip, 0], [shoulder, radius * .88]]),
    band: polygon([[-length * .29, -radius], [-length * .19, -radius], [-length * .19, radius], [-length * .29, radius]]),
    highlight: polygon([[-length * .39, -radius * .57], [shoulder * .65, -radius * .54],
      [shoulder * .88, -radius * .25], [-length * .39, -radius * .24]]),
    fins: rocket ? polygon([[tail - length * .025, -radius * 1.70], [tail + length * .23, -radius],
      [tail + length * .23, radius], [tail - length * .025, radius * 1.70], [tail + length * .05, 0]]) : [],
  };
}
