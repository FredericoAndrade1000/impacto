import type { Point } from './math.ts';
import type { ComponentArtOptions } from './vehicle-art-contract.ts';
import type { ArtContext, CanvasPaint, GradientStop, XY } from './canvas-art.ts';
// The running gear as it is painted, by the one rule of the art of every piece (machine-art.ts): a
// side elevation, seen square on, where a wheel turns across the vehicle and so shows round.
// The tyre, rim, brake drum and hub have concentric procedural geometry and equally repeated pieces.
// The renderer turns their cached picture; a bitmap finish changes only its surface.
// The environmental shade (`shade`, `overlay`) stays still over the running gear.
import { TAU } from './math.ts';
import { SPROCKET_TEETH, SPROCKET_TIP, TRACK_GROUSER, TRACK_HORN, TRACK_SHOE_HALF_THICKNESS, beltJoint, builtGear, linkStart, trackLinks, trackOutline,
  trackWheels } from './running-gear.ts';
import { idlerCrank, paintTrackShoe, paintTrackSide, rollerBracket, TRACK_GROUSER_WIDTH, TRACK_HORN_WIDTH, TRACK_JOINT, TRACK_SHOE_COLORS } from './track-shoe-art.ts';

// The tread of a tyre, in its radius: `blocks` blocks alike at equal turns, the first along the axis of its picture,
// each from its `foot` out to its `tip`, as wide either side of its axis as `footHalf` there and `tipHalf` here, and
// edged by a line `edge` wide; between them, open down to its carcass, `carcass` of the radius.
export const TREAD = Object.freeze({ blocks: 32, carcass: .955, foot: .885, tip: .995, footHalf: .074, tipHalf: .06, edge: .007 });
// The outline of a tyre follows its blocks where they stand at least this many of its lines out of the carcass.
const TREAD_SHOWN = 2;

// The outline of a tyre of `radius`, its line `width` wide (silhouette.ts), in the frame of its picture: out round each
// block of its tread, its edge with it, and along the carcass between them, so that nothing of it crosses the open
// between two blocks. The picture is drawn out to `reach` of the radius whichever way the tyre has turned (on a polygon
// round it, render.ts): the line goes round the tips of the blocks no farther out, so that it never stands off a tip the
// polygon cuts. Where the blocks stand less than `TREAD_SHOWN` lines out of the carcass, a fringe the picture shows
// only as a tone, it goes round the carcass alone. Its arcs are cut close enough that none of their sides falls a tenth
// of the line inside them.
export function tyreOutline(radius: number, width: number, reach = 1) {
  const { blocks, carcass, foot, tip, footHalf, tipHalf, edge } = TREAD,
    arc = (round: number, from: number, to: number, points: Point[], first = 0) => {
      const count = Math.ceil((to - from) / Math.sqrt(.8 * width / (round * radius)));
      for (let i = first; i < count; i++) {
        const angle = from + (to - from) * i / count;
        points.push({ x: Math.cos(angle) * round * radius, y: Math.sin(angle) * round * radius });
      }
      return points;
    };
  if ((tip - carcass) * radius < TREAD_SHOWN * width) return arc(carcass, 0, TAU, []);
  // The side of the first block that looks back, moved out by half its edge (`along`, from `start`): where it rises out
  // of the carcass (`root`) and where it reaches the tip, as far out as the tip and its edge go and the picture is drawn
  // (`top`). The other side is its mirror, and the tip an arc between them.
  const run = Math.hypot(tip - foot, footHalf - tipHalf), along = { x: (tip - foot) / run, y: (footHalf - tipHalf) / run },
    start = { x: foot + along.y * edge / 2, y: -footHalf - along.x * edge / 2 }, ahead = start.x * along.x + start.y * along.y,
    to = (round: number) => { const out = Math.sqrt(ahead * ahead - start.x * start.x - start.y * start.y + round * round) - ahead; return { x: start.x + out * along.x, y: start.y + out * along.y }; },
    outer = Math.min(reach, tip + edge / 2), root = to(carcass), top = to(outer),
    pitch = TAU / blocks, low = Math.atan2(-root.y, root.x), high = Math.atan2(-top.y, top.x), points = [];
  for (let k = 0; k < blocks; k++) {
    const axis = k * pitch, c = Math.cos(axis), s = Math.sin(axis), at = (x: number, y: number) => ({ x: (x * c - y * s) * radius, y: (x * s + y * c) * radius });
    points.push(at(root.x, root.y), at(top.x, top.y));
    arc(outer, axis - high, axis + high, points, 1);
    points.push(at(top.x, -top.y), at(root.x, -root.y));
    arc(carcass, axis + low, axis + pitch - low, points, 1);
  }
  return points;
}

// `options.style` tells the wheels apart: a tyre (the default, the wheel of a wheeled vehicle), and the
// `road` wheel, `sprocket`, `idler` and `roller` of a track; `shade` stands still over them, and `fendered` over a tyre under a fender.
// `guard` paints only the optional steel protection after the rim's material finish.
// `options.armorMm` puts a guard plate over the rim of a tyre. The skirt over a track is the chassis's (chassis-art.ts).
// `options.overlay` paints only what stands still over the wheels and the links of a track the renderer draws close up.
export function paintGear(ctx: ArtContext, kind: 'wheel' | 'track', widthM: number, heightM: number, options: ComponentArtOptions = {}) {
  const w = ctx.canvas.width, h = ctx.canvas.height, armour = options.armorMm || 0;
  const circle = (x: number, y: number, r: number, fill?: CanvasPaint | null, stroke?: CanvasPaint | null, lineWidth = 1) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  };
  const shape = (points: readonly XY[], fill?: CanvasPaint | null, stroke?: CanvasPaint | null, lineWidth = 1) => {
    ctx.beginPath(); points.forEach(([x, y], i: number) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, color: CanvasPaint, width: number) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  const radial = (x: number, y: number, r: number, stops: readonly GradientStop[]) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); for (const [at, color] of stops) g.addColorStop(at, color); return g; };
  const fall = (y0: number, y1: number, stops: readonly GradientStop[]) => { const g = ctx.createLinearGradient(0, y0, 0, y1); for (const [at, color] of stops) g.addColorStop(at, color); return g; };
  // The same thing at equal turns about a centre, each drawn along its own x axis.
  const around = (x: number, y: number, count: number, draw: (index: number) => void, turn = 0) => { for (let i = 0; i < count; i++) { ctx.save(); ctx.translate(x, y); ctx.rotate(turn + i * TAU / count); draw(i); ctx.restore(); } };

  // The hub a wheel turns on: a bolted flange and its cap.
  const hub = (x: number, y: number, r: number, size: number) => {
    const s = r * size;
    circle(x, y, s, '#1c2c22', '#0d1813', r * .014);
    circle(x, y, s * .86, radial(x, y, s * .86, [[0, '#8f9e7d'], [.5, '#6d8062'], [1, '#485a40']]), '#aab497', r * .009);
    around(x, y, 6, () => { circle(s * .6, 0, s * .12, '#24352a'); circle(s * .6, 0, s * .075, '#bcc3a8'); });
    circle(x, y, s * .32, '#566a4c', '#16241b', r * .012);
    circle(x, y, s * .12, '#a9b497');
  };
  // A pressed steel dish with a ring of holes, from the rim down to the hub, the outer of a pair on one hub: through each
  // hole shows the dish of the inner wheel, in its shade, and the edge of the hole in it, a quarter of a hole round.
  const dish = (x: number, y: number, r: number, outer: number, holes: number) => {
    const o = r * outer, behind = TAU / holes / 4;
    circle(x, y, o, radial(x, y, o, [[0, '#6f8262'], [.5, '#5e7154'], [.82, '#4c5f45'], [1, '#34472f']]), '#aeb89c', r * .014);
    circle(x, y, o * .93, null, '#273829', r * .012);
    circle(x, y, o * .8, null, '#7c8c6d55', r * .01);
    around(x, y, holes, () => {
      circle(o * .58, 0, o * .135, null, '#93a28148', r * .008);
      ctx.save(); ctx.beginPath(); ctx.arc(o * .58, 0, o * .12, 0, TAU); ctx.clip();
      circle(o * .58, 0, o * .12, '#2b3927'); circle(o * .58 * Math.cos(behind), o * .58 * Math.sin(behind), o * .12, '#0b130e');
      ctx.restore();
      circle(o * .58, 0, o * .12, null, '#1f3024', r * .012);
    });
  };
  // The guard of an armoured wheel: a plate over the whole rim, bolted round its edge, a second one over its middle when it is thick.
  const guard = (x: number, y: number, r: number, outer: number) => {
    const o = r * outer;
    circle(x, y, o, radial(x, y, o, [[0, '#5d6f53'], [.7, '#516349'], [.94, '#44563e'], [1, '#28392a']]), '#0d1913', r * .022);
    circle(x, y, o * .94, null, '#9ca98b', r * .009);
    if (armour >= 20) { circle(x, y, o * .58, '#566950', '#223326', r * .028); circle(x, y, o * .555, null, '#93a182', r * .008); }
    around(x, y, 10, () => { circle(o * .8, 0, r * .036, '#18271d'); circle(o * .8, 0, r * .024, '#bac1a6', '#3a4c37', r * .006); });
    circle(x, y, o * .4, null, '#28392a', r * .02); circle(x, y, o * .375, null, '#8f9d7e80', r * .008);
  };
  // The tyre's broad flange and visible cap follow the off-road reference, with
  // eight identical fasteners. Track wheels keep their own smaller six-bolt hub.
  const tyreHub = (x: number, y: number, r: number) => {
    circle(x, y, r * .255, '#293c2b', '#142419', r * .014);
    circle(x, y, r * .24, radial(x, y, r * .24, [[0, '#82906d'], [.75, '#6e7c5c'], [1, '#46593c']]), '#a7b08f', r * .008);
    circle(x, y, r * .225, null, '#354b31', r * .009);
    around(x, y, 8, () => {
      circle(r * .188, 0, r * .035, '#1b2c20');
      shape(Array.from({ length: 6 }, (_, i: number) => [r * .188 + Math.cos(i * TAU / 6) * r * .029,
        Math.sin(i * TAU / 6) * r * .029]), '#bcc3a8', '#3b4b35', r * .005);
    });
    circle(x, y, r * .145, '#31472f', '#17271b', r * .012);
    circle(x, y, r * .13, radial(x, y, r * .13, [[0, '#899570'], [.83, '#78865f'], [1, '#5c6f48']]), '#bec5a3', r * .007);
    circle(x, y, r * .121, null, '#526944', r * .007);
  };
  // The drum turns with the hub behind the pressed rim. Its cast face and cooling rings show through
  // the rim's openings, covering the spring behind them. Paint the rings first and the face last,
  // behind the finished wheel: neither its dish nor the gaps between tread blocks are covered.
  const drum = (x: number, y: number, r: number) => {
    ctx.save(); ctx.globalCompositeOperation = 'destination-over';
    for (const radius of [.315, .39, .415]) {
      circle(x, y, r * radius, null, '#80735f', r * .007);
      circle(x, y, r * (radius + .008), null, '#171b17', r * .01);
    }
    circle(x, y, r * .46, radial(x, y, r * .46,
      [[0, '#393c32'], [.63, '#44483c'], [.9, '#363a31'], [1, '#20251f']]));
    ctx.restore();
  };
  // The tyre has identical tread blocks, a sidewall and a pressed rim. Its warm rubber tones
  // retain their hue under the shared metal finish; the olive dish and hub take the metal.
  // Optional armour is painted separately, after that finish, by the guard style.
  const tyre = (x: number, y: number, r: number) => {
    const { blocks, carcass, foot, tip, footHalf, tipHalf, edge } = TREAD;
    circle(x, y, r * carcass, '#252420');
    around(x, y, blocks, () => shape([[r * foot, -r * footHalf], [r * tip, -r * tipHalf], [r * tip, r * tipHalf], [r * foot, r * footHalf]], '#3c3a34', '#181711', r * edge));
    circle(x, y, r * .885, radial(x, y, r * .885, [[0, '#24231f'], [.66, '#34322d'], [.86, '#444138'], [1, '#282721']]));
    circle(x, y, r * .835, null, '#68625066', r * .008);
    circle(x, y, r * .79, null, '#181711', r * .009);
    around(x, y, 16, () => { ctx.fillStyle = '#68625059'; ctx.fillRect(r * .73, -r * .026, r * .055, r * .052); });
    circle(x, y, r * .62, '#0c0b07');
    circle(x, y, r * .6, radial(x, y, r * .6, [[0, '#7a8865'], [.74, '#758260'], [.93, '#5a6c4b'], [1, '#364a31']]), '#1b2d1e', r * .016);
    circle(x, y, r * .58, null, '#b1ba98', r * .008);
    circle(x, y, r * .55, null, '#34472e', r * .024);
    circle(x, y, r * .53, null, '#98a581', r * .008);
    circle(x, y, r * .5, radial(x, y, r * .5, [[0, '#7d8b67'], [.75, '#71805c'], [1, '#566a46']]), '#3b5034', r * .01);
    around(x, y, 8, () => {
      circle(r * .36, 0, r * .074, null, '#b2bc9355', r * .009);
      circle(r * .36, 0, r * .067, null, '#1d2e20', r * .012);
    });
    // Open the pressed rim, retaining its bevels, then lay the brake drum behind it.
    // Track wheels keep their own recesses. A separate armour guard covers the rim.
    ctx.save(); ctx.globalCompositeOperation = 'destination-out';
    around(x, y, 8, () => circle(r * .36, 0, r * .067, '#000000'));
    ctx.restore();
    tyreHub(x, y, r);
    drum(x, y, r);
  };
  // The hub of a wheel of a track: a flange held on by `bolts` nuts round it, and over its middle a domed cap.
  const cap = (x: number, y: number, r: number, size: number, bolts: number) => {
    const s = r * size;
    circle(x, y, s, '#1c2c22', '#0d1813', r * .014);
    circle(x, y, s * .9, radial(x, y, s * .9, [[0, '#8f9e7d'], [.55, '#6d8062'], [1, '#485a40']]), '#aab497', r * .009);
    around(x, y, bolts, () => {
      circle(s * .68, 0, s * .14, '#1b2c20');
      shape(Array.from({ length: 6 }, (_, i: number) => [s * .68 + Math.cos(i * TAU / 6) * s * .1, Math.sin(i * TAU / 6) * s * .1]), '#bcc3a8', '#3b4b35', r * .005);
    });
    circle(x, y, s * .44, '#31472f', '#17271b', r * .012);
    circle(x, y, s * .4, radial(x, y, s * .4, [[0, '#a3ae8c'], [.6, '#7f8d69'], [1, '#596c48']]), '#bec5a3', r * .007);
    circle(x, y, s * .13, '#3c4f37', '#1b2c20', r * .006);
  };
  // A road wheel of a track, the outer of a pair on one hub: a thick tyre of rubber, lit along its shoulder, on a
  // pressed steel dish, through whose holes the inner wheel shows (`dish`), and the cap over its hub.
  const road = (x: number, y: number, r: number) => {
    circle(x, y, r, '#16150f'); circle(x, y, r * .955, null, '#3d3a33', r * .04);
    circle(x, y, r * .875, null, '#24221c', r * .03); circle(x, y, r * .815, null, '#0d0c08', r * .025);
    dish(x, y, r, .8, 8);
    circle(x, y, r * .785, null, '#bbc2a6', r * .012);
    circle(x, y, r * .755, null, '#32452f', r * .022);
    circle(x, y, r * .69, null, '#90a07b66', r * .009);
    circle(x, y, r * .38, '#435a3a', '#a4af90', r * .01);
    cap(x, y, r, .34, 8);
  };
  // The wheel that drives the belt: `teeth` teeth all the way round a ring, the gaps between them at `turn` and every
  // tooth on, where the pins of the links come round it (running-gear.ts `linkStart`), so that each tooth stands in the
  // middle of a link (`SPROCKET_TEETH`), between the joints over its pins. Each reaches out over the body of the link
  // to the line of its pins (`SPROCKET_TIP`), clear of those joints, and broadens to its root inside the belt.
  const sprocket = (x: number, y: number, r: number, teeth: number, turn = 0) => {
    const pitch = TAU / teeth, tooth = ([[.78, -.3], [.88, -.22], [SPROCKET_TIP, -.13], [SPROCKET_TIP, .13], [.88, .22], [.78, .3]] satisfies XY[])
      .map(([out, half]): XY => [r * out * Math.cos(half * pitch), r * out * Math.sin(half * pitch)]);
    around(x, y, teeth, () => shape(tooth, '#6c7c5d', '#1c2a1f', r * .014), turn + SPROCKET_TEETH * pitch);
    circle(x, y, r * .84, '#596b4e', '#16251b', r * .02); circle(x, y, r * .8, null, '#b7bba5', r * .018);
    circle(x, y, r * .7, '#0c1712');
    around(x, y, 5, () => shape([[r * .18, -r * .1], [r * .73, -r * .15], [r * .73, r * .15], [r * .18, r * .1]], '#586b51', '#91a07f', r * .008));
    circle(x, y, r * .7, null, '#1d2d2180', r * .03); circle(x, y, r * .75, null, '#839272', r * .012);
    cap(x, y, r, .36, 6);
  };
  // The wheel the belt turns back over: bare steel, the outer of a pair, with wide openings.
  const idler = (x: number, y: number, r: number) => {
    circle(x, y, r, '#536448', '#0f1a14', r * .024); circle(x, y, r * .96, null, '#b0b59d', r * .018);
    circle(x, y, r * .915, null, '#253823', r * .028);
    dish(x, y, r, .86, 6); circle(x, y, r * .35, '#526548', '#a1ae8b', r * .01); cap(x, y, r, .3, 6);
  };
  // A roller the upper run comes back over, the outer of a pair: a road wheel made small, its tyre as thick for its
  // size, fewer holes in its dish and its cap the larger.
  const roller = (x: number, y: number, r: number) => {
    circle(x, y, r, '#16150f'); circle(x, y, r * .95, null, '#3d3a33', r * .05);
    circle(x, y, r * .79, null, '#0d0c08', r * .04);
    dish(x, y, r, .76, 5);
    circle(x, y, r * .745, null, '#bbc2a6', r * .02);
    cap(x, y, r, .46, 6);
  };
  // What stands still over a wheel that turns: the light of the sky on its upper half, and its own shade
  // on the half that faces the ground. Under a fender (`fendered`) the very top of the tyre is in a light
  // shade of the fender instead, and the sky lights it, a little less, just below that.
  const shade = (x: number, y: number, r: number, fendered = false) => {
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
    ctx.fillStyle = fall(y - r, y + r, fendered
      ? [[0, '#060a0840'], [.06, '#060a0818'], [.12, '#060a0800'], [.16, '#e6edd612'], [.3, '#e6edd608'], [.46, '#e6edd600'], [.5, '#060a0800'], [.8, '#060a0838'], [1, '#060a0870']]
      : [[0, '#e6edd624'], [.3, '#e6edd60d'], [.46, '#e6edd600'], [.5, '#060a0800'], [.8, '#060a0838'], [1, '#060a0870']]);
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r); ctx.restore();
  };
  if (kind === 'wheel') {
    const x = w / 2, y = h / 2, r = w * .5;
    if (options.style === 'guard') { if (armour) { guard(x, y, r, .645); hub(x, y, r, .2); } }
    else if (options.style === 'sprocket') sprocket(x, y, r, options.teeth!);
    else { const painters: Partial<Record<string, (x: number, y: number, r: number) => void>> = { road, idler, roller, shade, fendered: (x, y, r) => shade(x, y, r, true) }; (painters[options.style!] || tyre)(x, y, r); }
    return;
  }

  // A track is painted on its outline (running-gear.ts `trackOutline`): the belt round its road wheels, up the runs to
  // its sprocket and its idler, raised at its ends, and along the upper run between them. Its parts are laid in metres
  // of it, the middle of the track in the middle of the picture. This is how it is seen from afar: close up, the
  // renderer draws its wheels, its links and what stands behind them where the running gear has them (track-links.ts),
  // and lays the shade over them (`options.overlay`).
  const sx = w / widthM, sy = h / heightM, X = (x: number) => (x + widthM / 2) * sx, Y = (y: number) => h / 2 - y * sy, { end } = trackWheels(widthM, heightM);
  const outline = (inset = 0) => {
    ctx.beginPath(); trackOutline(widthM, heightM, inset * heightM, 48).forEach((p, i: number) => i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)));
    ctx.closePath();
  };
  // What stands still over the wheels of a track: the shade of the hull over its upper run, and the dark along the
  // ground. On the picture of the track, within its outline; alone, all over its picture, for the renderer to lay
  // within the outline of the belt as it is drawn.
  const cover = (within: boolean) => {
    ctx.save(); if (within) { outline(); ctx.clip(); }
    ctx.fillStyle = fall(0, h, [[0, '#05090770'], [.16, '#05090738'], [.34, '#05090700'], [.6, '#05090700'], [.85, '#05090730'], [1, '#05090766']]);
    ctx.fillRect(0, 0, w, h); ctx.restore();
  };
  if (options.overlay) { cover(false); return; }

  // The side of the hull behind the wheels; within the belt round it, between them, what is behind the track shows.
  paintTrackSide(ctx, X(-end.x), X(end.x), (v: number) => Y(v * heightM));
  ctx.strokeStyle = '#3d4f3a'; ctx.lineWidth = Math.max(1.5, h * .02); outline(.055); ctx.stroke();
  ctx.strokeStyle = '#060d0a'; ctx.lineWidth = Math.max(1, h * .014); outline(.08); ctx.stroke();
  // The running gear as the track has it built (running-gear.ts `trackGear`), as the renderer draws it close up: the
  // brackets of the rollers, the arm of each road wheel from its boss on the side of the hull to the middle of the
  // wheel, and the crank of the idler with its screw; then the links of the belt; then the wheels, in the order they
  // are drawn, the inner row of road wheels in its shade.
  const gear = builtGear(widthM, heightM), { count, teeth } = trackLinks(widthM, heightM), belt = gear.belt,
    half = TRACK_SHOE_HALF_THICKNESS * heightM, corners = (points: readonly Point[]) => points.map((p): XY => [X(p.x), Y(p.y)]), boss = heightM * .05 / .74;
  for (const roller of gear.rollers) {
    const { stem, flange, bolts } = rollerBracket(roller);
    shape(corners(flange), '#2b3a2a', '#111c17', roller.radius * sy * .06);
    shape(corners(stem), '#33412f', '#111c17', roller.radius * sy * .06);
    for (const bolt of bolts) circle(X(bolt.x), Y(bolt.y), bolt.r * sy, '#bcc3a8', '#24352a', bolt.r * sy * .4);
  }
  for (const { x, y, pivot } of gear.road) {
    circle(X(pivot.x), Y(pivot.y), boss * sy, '#33412f', '#111c17', boss * sy * .12);
    circle(X(pivot.x), Y(pivot.y), boss * sy * .5, '#5f6e56');
    line(X(pivot.x), Y(pivot.y), X(x), Y(y), '#17271d', .045 * sy);
    line(X(pivot.x), Y(pivot.y + .008), X(x), Y(y + .008), '#8b957bcc', .016 * sy);
  }
  const crank = idlerCrank(gear.crank, gear.idler, heightM), rim = heightM * .006 * sy, dot = ({ x, y, r }: Point & { r: number }, fill?: CanvasPaint | null, stroke?: CanvasPaint | null) => circle(X(x), Y(y), r * sy, fill, stroke, rim);
  shape(corners(crank.sleeve), '#2b3a2a', '#111c17', rim); shape(corners(crank.rod), '#9aa38b', '#111c17', rim);
  dot(crank.bracket, '#33412f', '#111c17'); shape(corners(crank.arm), '#33412f', '#111c17', rim);
  dot(crank.eye, '#5f6e56', '#111c17'); dot(crank.boss, '#33412f', '#111c17'); dot(crank.pin, '#bcc3a8');
  // The links of the belt, its sprocket unturned: each a shoe from the pin behind it to the one ahead (track-links.ts),
  // its lit face inwards, its horn in from its middle and its grouser out from it, and over the pins the joints between
  // them, all the way round.
  const pins = belt.sample(count, linkStart(gear, count, teeth, 0), belt.length / count, new Float64Array(count * 4)),
    metres = (i: number) => ({ x: pins[(i % count) * 4]!, y: pins[(i % count) * 4 + 1]! }), pin = (i: number) => { const p = metres(i); return { x: X(p.x), y: Y(p.y) }; },
    step = belt.length / count, joint = TRACK_JOINT * step * sx, horn = TRACK_HORN * heightM, grouser = TRACK_GROUSER * heightM,
    // A face of the belt from `at` the way to `towards` from `from`, `length` long, `tall` thick, its inner face up.
    lay = (at: Point, from: Point, towards: Point, length: number, tall: number, part: number) => {
      ctx.save(); ctx.translate(at.x, at.y); ctx.rotate(Math.atan2(towards.y - from.y, towards.x - from.x)); ctx.translate(0, -tall / 2);
      paintTrackShoe(ctx, length, tall, part, TRACK_SHOE_COLORS); ctx.restore();
    },
    // A face `long` along the link from pin i + 1 to pin i and `tall` thick, its middle `inward` in from the middle of it.
    stud = (i: number, long: number, tall: number, inward: number, part: number) => {
      const a = metres(i + 1), b = metres(i), length = Math.hypot(b.x - a.x, b.y - a.y), c = (b.x - a.x) / length, s = (b.y - a.y) / length,
        mx = (a.x + b.x) / 2 - s * inward, my = (a.y + b.y) / 2 + c * inward, from = { x: X(mx - c * long / 2), y: Y(my - s * long / 2) },
        to = { x: X(mx + c * long / 2), y: Y(my + s * long / 2) };
      lay(from, from, to, Math.hypot(to.x - from.x, to.y - from.y), tall * sy, part);
    };
  for (let i = 0; i < count; i++) {
    const from = pin(i + 1), to = pin(i);
    stud(i, TRACK_HORN_WIDTH * step, horn, half + horn / 2, 0);
    lay(from, from, to, Math.hypot(to.x - from.x, to.y - from.y), 2 * half * sy, 1);
    stud(i, TRACK_GROUSER_WIDTH * step, grouser, -half - grouser / 2, 2);
  }
  // Each joint along the way between the two links it joins, its outer corners cut where the belt bends out over a wheel
  // (running-gear.ts `beltJoint`).
  const cut = new Float64Array(18), way = (a: Point, b: Point): XY => { const length = Math.hypot(b.x - a.x, b.y - a.y) || 1; return [(b.x - a.x) / length, (b.y - a.y) / length]; };
  for (let i = 0; i < count; i++) {
    const at = metres(i);
    beltJoint(at.x, at.y, ...way(metres(i + 1), at), ...way(at, metres(i + count - 1)), half, joint / sx / 2, cut);
    const from = { x: X(cut[0]!), y: Y(cut[1]!) }, to = { x: X(cut[2]!), y: Y(cut[3]!) };
    ctx.save(); ctx.beginPath();
    for (let n = 0; n < 12; n += 2) ctx.lineTo(X(cut[n]!), Y(cut[n + 1]!));
    ctx.clip();
    lay({ x: X(at.x) + (from.x - to.x) / 2, y: Y(at.y) + (from.y - to.y) / 2 }, from, to, joint, 2 * half * sy, 3);
    ctx.restore();
  }
  for (const wheel of gear.drawn) {
    const x = X(wheel.x), y = Y(wheel.y), r = wheel.radius * sy;
    if (wheel.role === 'sprocket') sprocket(x, y, r, teeth);
    else ({ idler, roller, road }[wheel.role])(x, y, r);
    if (wheel.shade < 1) circle(x, y, r, `rgba(6,10,8,${1 - wheel.shade})`);
  }
  cover(true);
}
