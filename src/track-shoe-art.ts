import type { ArtContext, CanvasPaint, XY } from './canvas-art.ts';
import type { Point } from './math.ts';
export type TrackShoeColors = Record<keyof typeof TRACK_SHOE_COLORS, string>;
import { TRACK_SIDE } from './running-gear.ts';

// The pictures of a belt, shared by the still picture of a track and its animated mesh: its shoes, the joints between
// them and the side of the hull behind its wheels. A shoe is three faces, each painted along the belt, its inner side
// up: its guide horn (`part` 0), standing in from the middle of its body, narrowing to its tip, a hole through it; its
// body (1), the forged plate from pin to pin, lit along its inner face, a pocket in its middle; and its grouser (2),
// standing out from the middle of its outer face, its tip worn bright. The joint (`part` 3) is the end connector
// clamped over the pin two shoes turn on, as thick as their bodies and `TRACK_JOINT` of a link long, the end of the pin
// in its middle, its outer corners cut where the belt bends out (running-gear.ts `beltJoint`). What is outside the
// horn and the grouser is clear. The generated material changes brightness only.
export const TRACK_JOINT = .36;
// How wide a horn and a grouser are along the belt, at their foot, of a link.
export const TRACK_HORN_WIDTH = .44, TRACK_GROUSER_WIDTH = .5;
export function paintTrackShoe(ctx: ArtContext, width: number, height: number, part: number, colors: TrackShoeColors) {
  const { steel, shade, light, dark, deep, worn } = colors,
    rect = (x: number, y: number, w: number, h: number, color: CanvasPaint) => { ctx.fillStyle = color; ctx.fillRect(x * width, y * height, w * width, h * height); },
    oval = (x: number, y: number, r: number, color: CanvasPaint) => { ctx.beginPath(); ctx.ellipse(x * width, y * height, width * r, height * r, 0, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); },
    shape = (points: readonly XY[], color: CanvasPaint) => { ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height)); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); };
  if (part === 3) {
    rect(.04, 0, .92, 1, dark); rect(.1, .08, .8, .84, deep); rect(.12, .1, .76, .12, steel); rect(.12, .82, .76, .08, dark);
    oval(.5, .52, .2, dark); oval(.5, .52, .14, worn); return;
  }
  if (part === 0) {
    shape([([.2, 0] as const), ([.8, 0] as const), ([1, 1] as const), ([0, 1] as const)], dark); shape([([.26, .08] as const), ([.74, .08] as const), ([.92, 1] as const), ([.08, 1] as const)], deep);
    shape([([.26, .08] as const), ([.36, .08] as const), ([.18, 1] as const), ([.08, 1] as const)], shade); oval(.5, .52, .1, dark); return;
  }
  if (part === 1) {
    rect(0, 0, 1, 1, dark); rect(.015, .07, .97, .86, steel); rect(.035, .09, .93, .12, light);
    rect(.035, .8, .93, .11, deep); rect(.2, .34, .6, .34, shade); rect(.2, .34, .6, .06, deep); return;
  }
  shape([([0, 0] as const), ([1, 0] as const), ([.86, 1] as const), ([.14, 1] as const)], dark); shape([([.05, 0] as const), ([.95, 0] as const), ([.83, .8] as const), ([.17, .8] as const)], deep);
  rect(.06, 0, .88, .16, shade); shape([([.17, .8] as const), ([.83, .8] as const), ([.86, 1] as const), ([.14, 1] as const)], worn);
}

export const TRACK_SHOE_COLORS = Object.freeze({ steel: '#8b9182', shade: '#737a6c', light: '#c2c6b3', dark: '#293126', deep: '#4f5649', worn: '#a9ad9c' });

// The crank the idler of a track turns on, and the screw that holds the belt taut by it (running-gear.ts `trackGear`, its
// `crank`), in the frame of the track `height` high: the arm from its boss over the pivot on the side of the hull to the
// hub of the idler (`hub`), each as its corners or its middle and radius; the screw from its bracket on that side (`anchor`)
// to the eye it pushes on the arm, its sleeve thick from the bracket and its rod thin to the eye.
export function idlerCrank({ pivot, anchor }: { pivot: Point; anchor: Point }, hub: Point, height: number) {
  const arm = { x: hub.x - pivot.x, y: hub.y - pivot.y }, long = Math.hypot(arm.x, arm.y), u = { x: arm.x / long, y: arm.y / long },
    eye = { x: pivot.x + arm.x * .4, y: pivot.y + arm.y * .4 }, screw = { x: eye.x - anchor.x, y: eye.y - anchor.y }, reach = Math.hypot(screw.x, screw.y),
    v = { x: screw.x / reach, y: screw.y / reach },
    bar = (from: Point, way: Point, length: number, half: number) => [([0, -half] as const), ([0, half] as const), ([length, half] as const), ([length, -half] as const)]
      .map(([along, across]) => ({ x: from.x + way.x * along - way.y * across, y: from.y + way.y * along + way.x * across }));
  return { arm: bar(pivot, u, long, .038 * height), boss: { ...pivot, r: .055 * height }, pin: { ...pivot, r: .022 * height },
    sleeve: bar(anchor, v, reach * .58, .03 * height), rod: bar(anchor, v, reach, .013 * height),
    eye: { ...eye, r: .024 * height }, bracket: { ...anchor, r: .036 * height } };
}

// The bracket a roller turns on (running-gear.ts `trackGear`, its `rollers`), from its foot on the plate along the side
// of the hull up to its hub, in the frame of the track: a stem narrowing to the hub (`stem`), the flange it is welded to
// (`flange`), each as its corners, and the two bolts that hold that to the plate (`bolts`).
export function rollerBracket({ x, y, radius, foot }: Point & { radius: number; foot: Point }) {
  const dx = x - foot.x, dy = y - foot.y, length = Math.hypot(dx, dy), u = { x: dx / length, y: dy / length },
    at = (along: number, across: number) => ({ x: foot.x + u.x * along - u.y * across, y: foot.y + u.y * along + u.x * across });
  return { stem: ([at(0, -.5 * radius), at(0, .5 * radius), at(length, .32 * radius), at(length, -.32 * radius)] as const),
    flange: ([at(-.14 * radius, -.9 * radius), at(-.14 * radius, .9 * radius), at(.2 * radius, .9 * radius), at(.2 * radius, -.9 * radius)] as const),
    bolts: ([-1, 1] as const).map(side => ({ ...at(.03 * radius, side * .62 * radius), r: .09 * radius })) };
}

// The side of the hull behind the wheels of a track (running-gear.ts `TRACK_SIDE`), from `left` to `right` and down from
// `Y(TRACK_SIDE.top)`, `Y` the place in the picture of a height over the middle of the track, in its height: in the
// shade of the hull down to the plate along its foot, lit along its upper edge and dark along its lower one.
export function paintTrackSide(ctx: ArtContext, left: number, right: number, Y: (at: number) => number) {
  const { top, plate, bottom } = TRACK_SIDE, tall = Y(0) - Y(1), wide = right - left,
    line = (at: number, color: CanvasPaint, width: number) => { ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, tall * width); ctx.beginPath(); ctx.moveTo(left, Y(at)); ctx.lineTo(right, Y(at)); ctx.stroke(); },
    fall = ctx.createLinearGradient(0, Y(plate), 0, Y(bottom));
  ctx.fillStyle = '#17251a'; ctx.fillRect(left, Y(top), wide, Y(plate) - Y(top));
  for (const [at, color] of [[0, '#526748'], [.2, '#415a38'], [1, '#263f25']] as const) fall.addColorStop(at, color);
  ctx.fillStyle = fall; ctx.fillRect(left, Y(plate), wide, Y(bottom) - Y(plate));
  line(plate - .01, '#91a17c', .012);
  line(bottom + .01, '#111f15', .018);
}
