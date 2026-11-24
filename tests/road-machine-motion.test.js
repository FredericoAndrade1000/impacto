import test from 'node:test';
import assert from 'node:assert/strict';
import { Graphics, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { moldboard, ramStages, stageWidths } from '../src/machine-art.ts';
import { MODULES, metalOf } from '../src/materials.ts';
import { NO_ROADS, paved } from '../src/roads.ts';
import { TOOL_CONTACT, TOOL_POINT, gradedGround, placeOf, reaches, toolNeed, toolOffset } from '../src/road-tools.ts';
import { Roadworks } from '../server/road-works.ts';
import { RoughGround, Terrain, underfootGround } from '../src/terrain.ts';
import {
  LOWER_SECONDS, MOTION_PARTS, ROAD_HOLD, RoadMachineView, advanceLanes, armBeams, bladeDrop, bladePose, biting, cuttingEdge, drawBladeSupports, bladeHang, drawEarth,
  earthFoot, earthTone, followWork, lower, machineRig, metalPaint, partBox, partMarks, roadsAtWork, screedDrop, screedPoint, screedPose, toolAt, towArm, worksOf,
} from '../src/road-machine-motion.ts';

// The road machines at work as the screen shows them (road-machine-motion.ts): how far their tools go down to meet the
// ground, when they are at work, and how far the road they make has come on the screen.
const size = (kind, scale) => [MODULES[kind].width * scale, MODULES[kind].height * scale];
const BLADE_CONTACT = TOOL_CONTACT.blade;
// How far down a tool of each kind goes at the least, as the core has it (game_construction.rs `Tool::least`), to its size.
const LEAST = Object.freeze({ blade: .52, paver: 1.15 });
// The rig of a machine `scale` times its size, as the screen works it out for its piece: its tool going down as far as the
// core has the least of it go, or `reach`.
const rigOf = (kind, scale, hang = null, reach = LEAST[kind] * scale) => machineRig(kind, ...size(kind, scale), hang, reach);
const rigFor = (kind, W, H) => machineRig(kind, W, H, null, LEAST[kind] * W / MODULES[kind].width);
// How long a ram of a rig draws out at the most, its stages all out (machine-art.ts `ramStages`), and the tow arm of a paver,
// its beams all out (`armBeams`).
const longest = ram => ram.barrel + (ram.shown.length + ram.hidden) * ram.most;
const armLongest = arm => arm.outer + arm.inner - arm.overlap + arm.hidden * (arm.inner - arm.overlap);
const near = (a, b, within, message) => assert(Math.abs(a - b) <= within, `${message}: ${a} against ${b}`);
// Level, and grades of 10, 20 and 30 % either way.
const GRADES = [0, .1, -.1, .2, -.2, .3, -.3].map(Math.atan);
// A machine drawn as the screen draws it at work, its parts plain, and where a place of one of them as it travels (`X`,
// `Y`, as its rig has them) is drawn, in its box: moved and turned about the pivot of its picture.
function drawing(kind, rig, W, H) {
  const view = new RoadMachineView(kind), boxes = Object.fromEntries(MOTION_PARTS[kind].map(part => [part, partBox(rig, part, W, H)])),
    textures = Object.fromEntries(MOTION_PARTS[kind].map(part => [part, Texture.WHITE])), paint = metalPaint(metalOf({ kind }).look);
  return { view, draw: pose => kind === 'blade' ? view.blade(rig, W, H, { textures, boxes, pose, earth: 0, phase: 0, tone: earthTone('soil'), pixel: .001, paint })
    : view.paver(rig, W, H, { textures, boxes, pose, run: 0, turn: 0, pixel: .001, paint }),
    drawn: (part, X, Y) => {
      const sprite = view.sprites[part], box = boxes[part], x = box.x + sprite.anchor.x * box.w, y = box.y + sprite.anchor.y * box.h,
        c = Math.cos(sprite.rotation), s = Math.sin(sprite.rotation);
      return { X: sprite.position.x + c * (X - x) - s * (Y - y), Y: sprite.position.y + s * (X - x) + c * (Y - y) };
    } };
}
// Ground along a straight slope rising `k` a metre towards +X, `under` metres below a point.
const slope = (k, point, under) => x => point.y - under + k * (x - point.x);
const profile = (height, corners = []) => ({ height,
  section: (a, b) => [a, ...corners.filter(x => x > a && x < b).sort((a, b) => a - b), b].map(x => ({ x, y: height(x) })),
});

test('a blade hangs by the column the core gives it, up to the metal over it, its rams from clevises under that', () => {
  const [W, H] = size('blade', 1), place = placeOf({ x: 12, y: 3, angle: 0 }, W, H), look = metalOf({ kind: 'blade' }).look,
    drawn = rig => { const g = new Graphics(); try { drawBladeSupports(g, rig, place, { pixel: .001, look }); return g.context.instructions.length; } finally { g.destroy({ context: true }); } };
  // Held otherwise, by metal beside it, its rams come down from over its frame, out of its picture, and nothing is drawn over it.
  const free = rigOf('blade', 1);
  assert.equal(free.hang, undefined); assert.equal(drawn(free), 0);
  assert.equal(bladeHang({ kind: 'blade', width: W, height: H, support: { host: 'wall', foot: [{ x: W / 2, y: 0 }, { x: W / 2, y: .1 }], normal: { x: -1, y: 0 } } }), null);
  // The metal 1.05 m over the middle of its box, rising .1 m over the column towards its front.
  for (const mirrored of [false, true]) {
    const support = { host: 'beam', foot: [{ x: -.24, y: H / 2 + 1 }, { x: .24, y: H / 2 + 1.1 }], normal: { x: 0, y: -1 }, reach: 1.05 },
      hang = bladeHang({ kind: 'blade', width: W, height: H, mirrored, support }), rig = rigOf('blade', 1, hang);
    near(hang.y, -1.05, 1e-9, 'its underside'); near(hang.slope, (mirrored ? 1 : -1) * .1 / .48, 1e-4, 'its slope'); near(hang.half, .24, 1e-9, 'its column');
    assert.equal(rigOf('blade', 1, { ...hang }), rig, 'worked out once');
    for (const name of ['lift', 'shift']) {
      const { top, foot, barrel, shown } = rig[name], travel = Math.hypot(foot.x - top.x, foot.y - top.y);
      near(top.y - rig.hang.clevis, rig.hang.under(top.x), 1e-12, `${name}: its clevis under the metal`);
      assert(Math.abs(top.x - W / 2) < hang.half, `${name}: under the flange of its column`);
      assert(barrel < travel && barrel >= travel / 2, `${name}: its barrel`); near(barrel + shown[0], travel, 1e-12, `${name}: and its rod`);
    }
    assert(drawn(rig) > 0);
  }
  // Right under it, the column reaches nowhere: the rams hang from its clevises at the top of the box.
  const flush = bladeHang({ kind: 'blade', width: W, height: H, support: { host: 'haste', foot: [{ x: -.24, y: H / 2 }, { x: .24, y: H / 2 }], normal: { x: 0, y: -1 }, reach: 0 } });
  near(flush.y, 0, 1e-12, 'flush');
});

test('a blade goes down plumb until its cutting edge, level across the way, meets the ground along all of it, and no further than it reaches', () => {
  for (const scale of [.5, 1, 1.5]) for (const mirror of [1, -1]) for (const angle of GRADES) for (const lie of [0, .04]) {
    const [W, H] = size('blade', scale), rig = rigOf('blade', scale), place = placeOf({ x: 40, y: 3, angle, mirrored: mirror < 0 }, W, H),
      stroke = rig.reach, name = `×${scale} ${mirror} ${angle.toFixed(3)} ${lie}`, { heel, toe } = cuttingEdge(rig),
      edge = pose => [0, .25, .5, .75, 1].map(u => place.world(heel.x + (toe.x - heel.x) * u + pose.dx, heel.y + pose.dy)), middle = place.world(W / 2, H),
      { view, draw, drawn } = drawing('blade', rig, W, H);
    for (const gap of [.04 * scale, stroke * .8, stroke]) {
      // The ground along the slope it stands on, or a little steeper, `gap` under the lowest of its cutting edge.
      const lowest = edge({ dx: 0, dy: 0 }).reduce((a, b) => a.y - Math.tan(angle + lie) * a.x < b.y - Math.tan(angle + lie) * b.x ? a : b),
        ground = slope(Math.tan(angle + lie), lowest, gap), { drop, contact } = bladeDrop(rig, place, profile(ground)), pose = bladePose(rig, place.down, drop),
        over = edge(pose).map(p => p.y - ground(p.x));
      assert(contact, name);
      assert(Math.min(...over) > -1e-6 && Math.min(...over) < 1e-3, `${name}: ${gap} m below, its edge ${Math.min(...over)} m over the ground`);
      // Down plumb: the middle of its cutting edge, where the field grades (`toolAt`), as far along the ground as it travels.
      draw(pose);
      const tool = drawn('assembly', W * TOOL_POINT.blade.x, H * TOOL_POINT.blade.y), at = place.world(tool.X, tool.Y);
      near(at.x, middle.x, 1e-9, `${name}: its middle`); near(at.x, toolAt('blade', place, W, H), 1e-9, `${name}: its middle`);
      near(middle.y - at.y, drop, 1e-9, name);
      // The neck of the drawbar reaches from the ball to the yoke, as far as it went down; its rams draw out to it, no
      // further than their stages go.
      near(rig.ball.x + (rig.pin.x - rig.ball.x) * pose.stretch, rig.pin.x + pose.dx, 1e-12, name);
      near(pose.shear * pose.stretch * (rig.pin.x - rig.ball.x), pose.dy, 1e-12, name);
      for (const ram of [rig.lift, rig.shift])
        assert(Math.hypot(ram.foot.x + pose.dx - ram.top.x, ram.foot.y + pose.dy - ram.top.y) <= longest(ram) + 1e-9, `${name}: a ram drawn out past its stages`);
    }
    view.destroy();
    const deep = bladeDrop(rig, place, profile(slope(Math.tan(angle), middle, stroke + 2)));
    assert(!deep.contact && Math.abs(deep.drop - stroke) < 1e-12, `${name}: over a ditch it goes down as far as it goes`);
    const low = Math.min(...edge({ dx: 0, dy: 0 }).map(p => p.y));
    const rise = bladeDrop(rig, place, profile(() => low + .1));
    assert.equal(rise.drop, 0, `${name}: on a rise it goes down no further`); assert(rise.contact, name);
  }
});

// The cutting edge of a blade as it travels, level across the way, in the world: from its heel to its toe (`cuttingEdge`),
// along the foot of its box, and where a share `u` of it is.
function levelEdge(rig, place) {
  const { heel, toe } = cuttingEdge(rig), from = place.world(heel.x, heel.y), to = place.world(toe.x, heel.y);
  return { from, to, at: u => ({ x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u }), uAt: x => (x - from.x) / (to.x - from.x) };
}
// Where a point drawn in the box of a blade lies along its cutting edge as painted (`u`, from heel to toe), and how far
// plumb (`down`, in its box) under the foot of the moldboard there as it travels (`h`).
function onEdge(rig, down, X, Y) {
  const { heel, toe } = cuttingEdge(rig), ex = toe.x - heel.x, ey = toe.y - heel.y, vx = X - heel.x, vy = Y - heel.y, det = ex * down.y - ey * down.x;
  return { u: (vx * down.y - vy * down.x) / det, h: (ex * vy - ey * vx) / det };
}
const REPOSE = Math.tan(35 * Math.PI / 180);
// How far plumb under the foot of the moldboard as painted at rest, a share `u` of its edge from the heel, the earth of a
// blade set as `pose` lies: on the foot gone down, or on the ground drawn plumb under it where that is lower.
function earthDepth(rig, place, pose, ground, u) {
  const { heel, toe } = cuttingEdge(rig), p = place.world(heel.x + (toe.x - heel.x) * u, heel.y + (toe.y - heel.y) * u);
  return Math.max(pose.drop, p.y - ground(p.x));
}
// The base of the first heap of earth drawn (`drawEarth`), each of its corners where it lies along the edge: exactly that deep.
function checkBase(g, rig, place, pose, ground, name) {
  const roll = g.shapes[0], base = [];
  for (let i = 0; i < roll.length / 2; i += 2) base.push(onEdge(rig, place.down, roll[i], roll[i + 1]));
  for (const { u, h } of base) near(h, earthDepth(rig, place, pose, ground, u), 1e-9, `${name}: its base at ${u}`);
  return base;
}
// The earth drawn for a blade set as `pose` over two grounds, the one it leaves (`graded`) and the one as it lies (`ground`),
// read on their own here: along its edge, on the foot of the moldboard or plumb under it on the ground where that is lower,
// none of it lower than that, raised only where the blade bites, and its heap no steeper at the ends of where it bites than
// loose earth stands. Returns how far along the edge it runs, and how thick its heap stands at most.
function checkEarth(g, rig, place, pose, graded, ground, name) {
  const edge = levelEdge(rig, place), { heel, toe } = cuttingEdge(rig), length = Math.hypot(toe.x - heel.x, toe.y - heel.y),
    under = u => { const p = edge.at(u); return p.y - ground(p.x); }, gap = u => { const p = edge.at(u); return p.y - graded(p.x); },
    foot = u => earthDepth(rig, place, pose, ground, u), bites = u => Math.min(gap(u), under(u)) - pose.drop <= BLADE_CONTACT + 1e-9,
    steps = 1e4, spans = [];
  // Where it bites, to a ten-thousandth of the edge: a place of it is within that of where it is found to.
  for (let i = 0, start = null; i <= steps; i++) {
    const u = i / steps;
    if (bites(u)) { start ??= u; if (i === steps) spans.push([start, 1]); } else if (start !== null) { spans.push([start, (i - 1) / steps]); start = null; }
  }
  const reach = u => {
    const span = spans.find(([a, b]) => u >= a - 1 / steps && u <= b + 1 / steps);
    return span ? (Math.max(0, Math.min(u - span[0], span[1] - u)) + 1 / steps) * length : 0;
  };
  let lo = Infinity, hi = -Infinity, thickest = 0;
  for (const shape of g.shapes) {
    // The clods (seven corners) roll on it: they keep to where it bites, but not to the slope of its heap.
    const clod = shape.length / 2 % 2 === 1;
    for (let i = 0; i < shape.length; i += 2) {
      const { u, h } = onEdge(rig, place.down, shape[i], shape[i + 1]), raised = foot(u) - h;
      assert(u >= -1e-9 && u <= 1 + 1e-9, `${name}: earth along the edge, at ${u}`);
      assert(raised >= -1e-9, `${name}: earth ${-raised} m under its foot at ${u}`);
      lo = Math.min(lo, u); hi = Math.max(hi, u);
      if (!(raised > 1e-7)) continue;
      assert(bites(u), `${name}: earth raised at ${u}, where the blade does not bite`);
      if (clod) continue;
      thickest = Math.max(thickest, raised);
      assert(raised <= REPOSE * reach(u) + 1e-9, `${name}: earth ${raised} m thick at ${u}, ${reach(u)} m from where it stops biting`);
    }
  }
  return { lo, hi, thickest };
}

test('the cutting edge cuts level across the way: the rise of its toe on the picture is how far off it is, not how high', () => {
  for (const scale of [.5, 1, 2]) for (const mirrored of [false, true]) for (const angle of [0, Math.atan(.3), Math.atan(-.2)]) {
    const [W, H] = size('blade', scale), rig = rigFor('blade', W, H), { foot } = moldboard(rig), { rise } = cuttingEdge(rig),
      place = placeOf({ x: 12, y: 3, angle, mirrored }, W, H), edge = levelEdge(rig, place),
      corner = .8414, under = .2 * scale, { view, draw, drawn } = drawing('blade', rig, W, H);
    assert(rise > .1 * H, `the toe of the moldboard painted ${rise} m higher by the perspective of its far end`);
    try {
      for (const bump of [0, .04 * scale]) {
        // Level ground under the level edge, or with a corner standing `bump` over it near the toe.
        const ground = x => {
          const u = edge.uAt(x), up = u <= corner ? u / corner : (1 - u) / (1 - corner);
          return edge.at(u).y - under + bump * up;
        }, set = bladeDrop(rig, place, profile(ground, bump ? [edge.at(corner).x] : [])),
          pose = bladePose(rig, place.down, set.drop, set.surface), name = `${scale} ${mirrored} ${angle} bump ${bump}`;
        draw(pose);
        // The points actually drawn by the moving assembly, independently of cuttingEdge(): the level edge along the foot of
        // the box, and the foot of the moldboard as painted.
        const world = p => { const q = drawn('assembly', p.x, p.y); return place.world(q.X, q.Y); },
          level = [0, .25, .5, .75, 1, corner].map(u => world({ x: foot(0).x + (foot(1).x - foot(0).x) * u, y: foot(0).y })).map(p => p.y - ground(p.x)),
          painted = [0, .25, .5, .75, 1, corner].map(u => world(foot(u))).map(p => p.y - ground(p.x));
        assert(set.contact, name); near(set.drop, under - bump, 1e-9, `${name}: the level edge meets the highest of the ground`);
        near(Math.min(...level), 0, 1e-9, `${name}: the level edge touches`);
        if (!bump) assert(level.every(gap => Math.abs(gap) < 1e-9), `${name}: on level ground the whole edge rests on it`);
        near(painted[0], level[0], 1e-9, `${name}: the heel is painted where it cuts`);
        assert(painted.every(gap => gap >= -1e-9), `${name}: the painted edge never crosses the ground`);
        assert(painted[4] > level[4] + .5 * rise, `${name}: the toe painted off, ${painted[4]} over the ground`);
        assert(set.drop <= rig.reach, `${name}: no further than it reaches`);
        // Each place of the surface is on the foot as painted, and tells how far the ground lies under the level edge there,
        // and under the foot as painted.
        for (const p of set.surface) {
          near(p.x, foot(0).x + (foot(1).x - foot(0).x) * p.u, 1e-12, name); near(p.y, foot(0).y + (foot(1).y - foot(0).y) * p.u, 1e-12, name);
          const q = edge.at(p.u), f = place.world(p.x, p.y);
          near(p.gap, q.y - ground(q.x), 1e-9, name); near(p.under, p.gap, 1e-12, name); near(p.low, f.y - ground(f.x), 1e-9, name);
        }
        const before = structuredClone(set.surface), g = outlines();
        drawEarth(g, rig, pose, .37, earthTone('soil'), .0001, 1);
        const earth = checkEarth(g, rig, place, pose, ground, ground, name);
        assert(g.shapes.length >= 3, `${name}: earth appears`);
        checkBase(g, rig, place, pose, ground, name);
        if (!bump) {
          near(earth.lo, 0, 1e-9, `${name}: the earth runs from the heel`); near(earth.hi, 1, 1e-9, `${name}: to the toe`);
          // Nothing of it in the air: the base of the heap on the ground drawn, under the toe painted off as under the heel.
          for (let i = 0; i < g.shapes[0].length / 2; i += 2) {
            const p = place.world(g.shapes[0][i], g.shapes[0][i + 1]); near(p.y, ground(p.x), 1e-9, `${name}: its base on the ground`);
          }
        }
        assert.deepEqual(set.surface, before, `${name}: drawing keeps the measured profile`);
      }
    } finally { view.destroy(); }
  }
});

test('a blade cuts the bumps of natural ground: it rests on the ground it leaves graded, and its earth fills the hollows', () => {
  for (const scale of [.5, 1, 2]) for (const mirrored of [false, true]) for (const angle of [0, Math.atan(.3), Math.atan(-.2)]) {
    const [W, H] = size('blade', scale), rig = rigFor('blade', W, H), place = placeOf({ x: 12, y: 3, angle, mirrored }, W, H),
      edge = levelEdge(rig, place), under = .2 * scale, name = `×${scale} ${mirrored} ${angle.toFixed(3)}`,
      // The ground it leaves along its slope, a little rough; the ground as it lies, a stone of rock and a hollow over it.
      knots = [[0, 0], [.2, .006], [.35, 0], [.42, .13], [.5, 0], [.7, -.005], [.78, -.06], [.86, 0], [1, .004]],
      bump = (v, k) => { const u = Math.min(1, Math.max(0, v)), i = Math.max(1, knots.findIndex(([at]) => at >= u)); const [a, ay] = knots[i - 1], [b, by] = knots[i]; return k(ay) + (k(by) - k(ay)) * (u - a) / (b - a); },
      graded = x => edge.at(edge.uAt(x)).y - under + bump(edge.uAt(x), y => Math.abs(y) < .01 ? y : 0),
      ground = x => edge.at(edge.uAt(x)).y - under + bump(edge.uAt(x), y => y),
      corners = knots.map(([u]) => edge.at(u).x), set = bladeDrop(rig, place, profile(graded, corners), profile(ground, corners)),
      pose = bladePose(rig, place.down, set.drop, set.surface), g = outlines();
    near(set.drop, under - .006, 1e-9, `${name}: it rests on the graded ground, not on the stone`);
    assert(set.surface.some(p => p.under < set.drop - .1), `${name}: the stone stands over its edge`);
    assert(set.surface.some(p => p.under > set.drop + .05), `${name}: the hollow lies under it`);
    drawEarth(g, rig, pose, .37, earthTone('soil'), .0001, 1);
    const earth = checkEarth(g, rig, place, pose, graded, ground, name);
    near(earth.lo, 0, 1e-9, `${name}: one heap from heel`); near(earth.hi, 1, 1e-9, `${name}: to toe`);
    // Over the stone its base is on the foot of the moldboard, which hides what it cuts; over the hollow, on the ground.
    const base = checkBase(g, rig, place, pose, ground, name);
    assert(base.some(({ u, h }) => Math.abs(h - pose.drop) < 1e-9 && pose.drop - earthDepth(rig, place, { drop: -Infinity }, ground, u) > .05), `${name}: on the foot over the stone`);
    assert(base.some(({ h }) => h > pose.drop + .05), `${name}: down in the hollow`);
  }
});

test('the roll of earth is a heap of loose earth: never taller than the stretch it bites allows, however short', () => {
  for (const scale of [.5, 1, 2]) for (const mirrored of [false, true]) for (const angle of [0, Math.atan(.3)]) for (const width of [.005, .03, .1, .5, 1]) {
    // The ground under its level edge, but for a step down out of its reach past `width` of it from the heel.
    const [W, H] = size('blade', scale), rig = rigFor('blade', W, H), place = placeOf({ x: 12, y: 3, angle, mirrored }, W, H),
      edge = levelEdge(rig, place), { heel, toe } = cuttingEdge(rig), length = Math.hypot(toe.x - heel.x, toe.y - heel.y),
      name = `×${scale} ${mirrored} ${angle.toFixed(3)} ${width}`, end = Math.min(1, width + .001),
      ground = x => { const u = edge.uAt(x), on = Math.min(1, u); return edge.at(u).y - .2 - (on <= width ? 0 : .3 * Math.min(1, (on - width) / .001)); },
      set = bladeDrop(rig, place, profile(ground, [edge.at(width).x, edge.at(end).x].filter((x, i) => i === 0 || end < 1))),
      pose = bladePose(rig, place.down, set.drop, set.surface), g = outlines();
    drawEarth(g, rig, pose, .37, earthTone('soil'), .0001, 1);
    const { thickest } = checkEarth(g, rig, place, pose, ground, ground, name),
      bites = width >= 1 ? 1 : width + .001 * BLADE_CONTACT / .3;
    assert(thickest <= REPOSE * length * bites / 2 + 1e-9, `${name}: ${thickest} m thick over ${bites * length} m`);
    const roll = rig.board.plate * .45;
    if (width >= .5) assert(thickest > .7 * roll && thickest < 1.5 * roll, `${name}: a full roll, ${thickest} m`);
    else {
      assert(thickest < .5 * roll, `${name}: a short stretch, well under a roll: ${thickest} m`);
      near(thickest, REPOSE * length * bites / 2, 1e-9, `${name}: a heap as high as the stretch allows, and no higher`);
    }
  }
});

test('a screed goes down plumb till its trailing edge, where the field paves, is on the ground, and sits on it with its auger and its arms', () => {
  for (const scale of [.5, 1, 1.5]) for (const mirror of [1, -1]) for (const angle of GRADES) for (const lie of [0, .06, -.06]) {
    const [W, H] = size('paver', scale), rig = rigFor('paver', W, H), { tow, pin, screed, lift, arm } = rig, name = `×${scale} ${mirror} ${angle.toFixed(3)} ${lie}`,
      { view, draw, drawn } = drawing('paver', rig, W, H);
    for (const over of [.05, .5, 1.1 * scale]) {
      // Set down from wherever the piece stands over ground along its slope, or a little steeper or gentler, the screed as the
      // screen draws it (RoadMachineView) has its trailing edge on the ground plumb under the rear end of the piece, where the
      // field lays the asphalt behind it (`toolAt`), its skid on the ground, and the auger it carries before it.
      const place = placeOf({ x: -12, y: 1, angle, mirrored: mirror < 0 }, W, H), from = place.world(screed.x0, screed.foot),
        ground = slope(Math.tan(angle + lie * mirror), from, over), set = screedDrop(rig, place, profile(ground)),
        pose = screedPose(rig, place.down, set.drop, set.tilt);
      draw(pose);
      const point = (part, p) => { const q = drawn(part, p.x, p.y); return place.world(q.X, q.Y); },
        edge = point('screed', { x: screed.x0, y: screed.foot }), skid = point('screed', { x: screed.x0 + screed.skid, y: screed.foot });
      assert(set.contact, `${name}: ${over} m up`);
      for (const p of [edge, skid]) near(p.y, ground(p.x), 1e-6, `${name}: ${over} m up, the skid on the ground`);
      near(edge.x, from.x, 1e-9, `${name}: ${over} m up, its trailing edge`); near(edge.x, toolAt('paver', place, W, H), 1e-9, `${name}: ${over} m up, its trailing edge`);
      // What it carries goes with it: the auger before it, the pin of the tow arm and the foot of the ram on it.
      for (const [part, p] of [['auger', rig.auger], ['slide', pin]]) {
        const at = drawn(part, p.x, p.y), on = drawn('screed', p.x, p.y);
        near(at.X, on.X, 1e-9, `${name}: the ${part}`); near(at.Y, on.Y, 1e-9, `${name}: the ${part}`);
      }
      const foot = screedPoint(rig, pose, lift.foot), on = drawn('screed', lift.foot.x, lift.foot.y), { turn, reach } = towArm(rig, pose);
      near(foot.x, on.X, 1e-9, name); near(foot.y, on.Y, 1e-9, name);
      // The tow arm turned down about the tow point and drawn out to that pin, no further than its beams reach; the ram drawn
      // out to that foot, no further than its stages reach, and no shorter than it travels.
      const to = drawn('slide', pin.x, pin.y), c = Math.cos(turn), s = Math.sin(turn), k = reach / arm.length;
      near(tow.x + k * (c * (pin.x - tow.x) - s * (pin.y - tow.y)), to.X, 1e-9, `${name}: the arm to the pin`);
      near(tow.y + k * (s * (pin.x - tow.x) + c * (pin.y - tow.y)), to.Y, 1e-9, `${name}: the arm to the pin`);
      const ram = Math.hypot(foot.x - lift.top.x, foot.y - lift.top.y);
      assert(reach <= armLongest(arm) + 1e-9 && ram <= longest(lift) + 1e-9 && ram >= lift.travel - 1e-9, `${name}: the arm ${reach}, the ram ${ram}`);
    }
    // It goes down far enough to pave from a deck, as far as it reaches, the ram and the arm drawn out to it.
    const place = placeOf({ x: -12, y: 1, angle, mirrored: mirror < 0 }, W, H), deep = screedDrop(rig, place, profile(slope(Math.tan(angle), place.world(screed.x0, screed.foot), 10))),
      pose = screedPose(rig, place.down, deep.drop, deep.tilt), { reach } = towArm(rig, pose), foot = screedPoint(rig, pose, lift.foot);
    assert(!deep.contact && deep.drop > 1.1 * scale, `${name}: ${deep.drop} m down at most`); near(deep.drop, rig.reach, 1e-12, `${name}: as far as it reaches`);
    assert(reach <= armLongest(arm) + 1e-9 && Math.hypot(foot.x - lift.top.x, foot.y - lift.top.y) <= longest(lift) + 1e-9, `${name}: at its lowest, the arm and the ram reach it`);
    view.destroy();
    // As it travels, all of it is in its box: the screed, the auger it carries, the beams of the tow arm, the ram.
    for (const [part, box] of Object.entries(rig.parts))
      assert(box.x >= 0 && box.y >= 0 && box.x + box.w <= W + 1e-9 && box.y + box.h <= H + 1e-9, `${name}: the ${part} out of its box`);
    assert(lift.top.y >= 0 && lift.foot.y <= H, name);
    const up = screedPose(rig, place.down, 0), travels = towArm(rig, up);
    assert(up.drop === 0 && up.dx === 0 && up.dy === 0 && up.tilt === 0, `${name}: up, as it travels`);
    near(travels.turn, 0, 1e-12, `${name}: up, as it travels`); near(travels.reach, arm.length, 1e-12, `${name}: up, as it travels`);
  }
});

// The factory grader hangs its blade 1.42 m under the metal over it and lowers it .72 m at most (game_construction.rs
// `toolReach`); one raised a metre hangs it .42 m under it and lowers it 1.72 m. The factory paver lowers its screed
// 1.84 m, and one raised 2.29 m.
const HANGS = Object.freeze({ factory: { y: -1.421, slope: 0, half: .24 }, raised: { y: -.421, slope: 0, half: .24 } });
const LEANS = Array.from({ length: 13 }, (_, i) => (i / 6 - 1) * Math.PI / 6);
test('the rams of a blade, and the ram and the tow arm of a paver, reach as far as the tool goes down, leant on any slope it works on', () => {
  for (const [name, rig] of [['factory blade', rigOf('blade', 1, HANGS.factory, .719)], ['raised blade', rigOf('blade', 1, HANGS.raised, 1.719)],
    ['free blade', rigOf('blade', 1, null, 1.8)], ['small raised blade', rigOf('blade', .5, { y: -.2, slope: 0, half: .12 }, 1.2)]])
    for (const angle of LEANS) for (const mirrored of [false, true]) {
      const [W, H] = size('blade', rig.s), place = placeOf({ x: 0, y: 0, angle, mirrored }, W, H),
        pose = bladePose(rig, place.down, rig.reach);
      for (const ram of [rig.lift, rig.shift]) {
        const length = Math.hypot(ram.foot.x + pose.dx - ram.top.x, ram.foot.y + pose.dy - ram.top.y), stages = ramStages(ram, length);
        assert(length <= longest(ram) + 1e-9, `${name} at ${angle.toFixed(2)}: ${length} m of ram, ${longest(ram)} at most`);
        assert(ram.hidden + ram.shown.length <= 6, `${name}: ${ram.hidden} stages hidden`);
        for (const [from, to] of stages.slice(1)) assert(to - from <= ram.most + 1e-9, `${name}: a stage out past what it may`);
        assert.equal(stageWidths(ram).length, stages.length);
        for (let i = 1; i < stages.length; i++) assert(stageWidths(ram)[i] < stageWidths(ram)[i - 1], `${name}: each stage thinner`);
      }
    }
  for (const [name, rig] of [['factory paver', rigOf('paver', 1, null, 1.838)], ['raised paver', rigOf('paver', 1, null, 2.288)], ['small paver', rigOf('paver', .5, null, 1)]])
    for (const angle of LEANS) for (const mirrored of [false, true]) for (const tilt of [-.2, -.1, 0, .1, .2]) {
      const [W, H] = size('paver', rig.s), place = placeOf({ x: 0, y: 0, angle, mirrored }, W, H), pose = screedPose(rig, place.down, rig.reach, tilt),
        foot = screedPoint(rig, pose, rig.lift.foot), ram = Math.hypot(foot.x - rig.lift.top.x, foot.y - rig.lift.top.y), { reach } = towArm(rig, pose);
      assert(ram <= longest(rig.lift) + 1e-9, `${name} at ${angle.toFixed(2)}, ${tilt}: ${ram} m of ram, ${longest(rig.lift)} at most`);
      assert(reach <= armLongest(rig.arm) + 1e-9, `${name} at ${angle.toFixed(2)}, ${tilt}: an arm ${reach} m long, ${armLongest(rig.arm)} at most`);
      const beams = armBeams(rig, reach);
      assert.equal(beams.length, reach > rig.arm.outer + rig.arm.inner - rig.arm.overlap ? rig.arm.hidden : 0, name);
      // Each comes out of the one before it, keeping their overlap, and the beam pinned to the screed out of the last.
      beams.forEach(([from, to], i) => { near(from, (i ? beams[i - 1][1] : rig.arm.outer) - rig.arm.overlap, 1e-12, name); assert(to - from <= rig.arm.inner + 1e-9, name); });
      if (beams.length) near(reach - rig.arm.inner, beams.at(-1)[1] - rig.arm.overlap, 1e-9, `${name}: the beam out of the last`);
    }
  // Its hidden stages and beams are hidden while it goes no further down than it did before it reached as far: the factory
  // blade has none, the factory paver shows none of them on level ground.
  const blade = rigOf('blade', 1, HANGS.factory, .719), raised = rigOf('blade', 1, HANGS.raised, 1.719);
  assert.deepEqual([blade.lift.hidden, blade.shift.hidden], [0, 0]);
  assert(raised.lift.hidden > 0 && raised.shift.hidden > 0, 'raised, its rams hide more than they show as it travels');
  const paver = rigOf('paver', 1, null, 1.838), [W, H] = size('paver', 1), place = placeOf({ x: 0, y: 0, angle: 0 }, W, H);
  assert(paver.lift.hidden > 0 && paver.arm.hidden > 0, 'its ram and its arm hide more than they show as it travels');
  for (const drop of [0, .5, 1.1]) {
    const pose = screedPose(paver, place.down, drop), foot = screedPoint(paver, pose, paver.lift.foot),
      stages = ramStages(paver.lift, Math.hypot(foot.x - paver.lift.top.x, foot.y - paver.lift.top.y));
    for (const [from, to] of stages.slice(1, 1 + paver.lift.hidden)) near(to, from, 1e-12, `${drop} m down: a hidden stage shows`);
    assert.deepEqual(armBeams(paver, towArm(paver, pose).reach), [], `${drop} m down: a hidden beam shows`);
  }
  // A free blade's rams come from further up out of its picture: what of them shows is where it was, as it travels.
  const free = rigOf('blade', 1, null, 1.8), plain = rigOf('blade', 1, null, 0);
  for (const name of ['lift', 'shift']) {
    const [a, b] = [free[name], plain[name]], barrelEnd = ram => ({ x: ram.top.x + (ram.foot.x - ram.top.x) * ram.barrel / Math.hypot(ram.foot.x - ram.top.x, ram.foot.y - ram.top.y),
      y: ram.top.y + (ram.foot.y - ram.top.y) * ram.barrel / Math.hypot(ram.foot.x - ram.top.x, ram.foot.y - ram.top.y) });
    assert(a.top.y < b.top.y && a.hidden === 0, `${name}: from further up`);
    near(barrelEnd(a).x, barrelEnd(b).x, 1e-12, name); near(barrelEnd(a).y, barrelEnd(b).y, 1e-12, name);
  }
});

// The field and the screen measure alike how far a tool goes down to meet the ground (road-tools.ts `toolNeed`): the screen
// sets it down as far as that, or as far as it reaches, and the field stops the machine where it does not reach.
test('the field stops a road machine where the screen shows its tool short of the ground, and nowhere else', () => {
  const terrain = new Terrain('rough');
  terrain.sectors = [{ start: -1600, end: 1600, surface: 'gravel' }];
  for (const point of terrain.points) point.y = .2 * (point.x - 32) + .05 * Math.cos(point.x * 2.3);
  const seen = { blade: new Set(), paver: new Set() };
  for (const kind of ['blade', 'paver']) for (const scale of [.5, 1]) for (const angle of [-.25, 0, .3]) for (const over of [.1, .4, .7, 1, 1.3]) {
    const [W, H] = size(kind, scale), rig = rigOf(kind, scale), probe = placeOf({ x: 32, y: 0, angle, mirrored: false }, W, H),
      point = probe.world(TOOL_POINT[kind].x * W, TOOL_POINT[kind].y * H), lift = terrain.height(point.x) + over * scale - point.y,
      piece = { id: kind, actorId: 'v', kind, x: 32, y: lift, angle, mirrored: false, width: W, height: H, health: 1, toolReach: rig.reach },
      place = placeOf(piece, W, H), graded = gradedGround(terrain), name = `${kind} ×${scale} ${angle} ${over}`,
      set = kind === 'blade' ? bladeDrop(rig, place, graded, underfootGround(terrain)) : screedDrop(rig, place, terrain),
      need = toolNeed(kind, place, kind === 'blade' ? graded : terrain), field = new Roadworks({ world: { terrain, modules: [piece] } });
    near(set.drop, Math.min(Math.max(0, need), rig.reach), 1e-12, `${name}: set down as far as the field measures`);
    assert.equal(set.contact, reaches(kind, need, rig.reach), name);
    assert.equal(field.short([piece]) > 0, !set.contact, `${name}: the field stops it where the screen shows it short`);
    seen[kind].add(set.contact);
  }
  assert.deepEqual([...seen.blade].sort(), [false, true]); assert.deepEqual([...seen.paver].sort(), [false, true]);
});

const laid = roads => roads.map(road => [road.x0, road.x1, road.kind]);

// A blade and a paver on a vehicle facing `facing` at x = 50, its pieces `scale` times their size, turned by `angle` with
// it on a slope, and the field they are on (server/road-works.ts).
function roadMachines(facing, scale, angle) {
  const x = 50, piece = (kind, along, y) => ({ id: kind, actorId: 'v', kind, x: x + facing * along, y, angle, mirrored: facing < 0, width: MODULES[kind].width * scale, height: MODULES[kind].height * scale, health: 10 }),
    blade = piece('blade', 1.2, 1), paver = piece('paver', -2, 2);
  return { tools: [[blade, 'grade'], [paver, 'pave']], vehicle: { id: 'v', x, facing }, field: new Roadworks({ position: actor => actor.x, world: { modules: [blade, paver] } }) };
}
const grade = (facing, scale, angle) => `facing ${facing}, ×${scale}, ${Math.round(Math.tan(angle) * 100)} %`;

test('on the level and on slopes, whichever way its vehicle faces, a tool works where the field has it', () => {
  for (const facing of [1, -1]) for (const scale of [.5, 1.5]) for (const angle of GRADES) {
    const { tools, vehicle, field } = roadMachines(facing, scale, angle);
    for (const [tool, part] of tools)
      near(toolAt(tool.kind, placeOf(tool, tool.width, tool.height), tool.width, tool.height), field.at(vehicle, part, facing), 1e-12,
        `${grade(facing, scale, angle)}: the ${tool.kind}`);
  }
});

test('on the level and on slopes, the screen draws a tool down on the ground where the field has it work', () => {
  for (const facing of [1, -1]) for (const scale of [.5, 1.5]) for (const angle of GRADES) {
    const { tools, vehicle, field } = roadMachines(facing, scale, angle), name = grade(facing, scale, angle);
    for (const [tool, part] of tools) {
      // Over ground along the slope the vehicle stands on, its tool drawn down on the ground meets it where the field has it.
      const W = tool.width, H = tool.height, rig = rigFor(tool.kind, W, H), place = placeOf(tool, W, H), { x, y } = TOOL_POINT[tool.kind],
        point = place.world(W * x, H * y), ground = slope(Math.tan(angle), point, .15 * scale), { view, draw, drawn } = drawing(tool.kind, rig, W, H),
        set = tool.kind === 'blade' ? bladeDrop(rig, place, profile(ground)) : screedDrop(rig, place, profile(ground));
      draw(tool.kind === 'blade' ? bladePose(rig, place.down, set.drop) : screedPose(rig, place.down, set.drop, set.tilt));
      const on = drawn(tool.kind === 'blade' ? 'assembly' : 'screed', W * x, H * y), meets = place.world(on.X, on.Y);
      near(meets.x, field.at(vehicle, part, facing), 1e-9, `${name}: the ${tool.kind} drawn`);
      if (tool.kind === 'blade') {
        const { foot } = moldboard(rig), gaps = [0, 1].map(u => {
          const p = foot(u), q = drawn('assembly', p.x, p.y), world = place.world(q.X, q.Y); return world.y - ground(world.x);
        });
        near(Math.min(...gaps), 0, 1e-6, `${name}: the painted cutting edge touches`);
        assert(gaps.every(gap => gap >= -1e-6), `${name}: the painted cutting edge stays above ground`);
      } else near(meets.y, ground(meets.x), 1e-6, `${name}: the ${tool.kind} drawn`);
      view.destroy();
    }
  }
});

test('reflecting a road machine reflects its tool and full working rig without changing the work done', () => {
  const reflect = piece => ({ ...piece, x: -piece.x, angle: -piece.angle, mirrored: !piece.mirrored });
  for (const kind of ['blade', 'paver']) for (const mirrored of [false, true]) for (const angle of GRADES) {
    const [W, H] = size(kind, 1), piece = { id: 'tool', actorId: 'v', kind, x: 12, y: 2, angle, mirrored, width: W, height: H, health: 1 },
      other = reflect(piece), place = placeOf(piece, W, H), opposite = placeOf(other, W, H), rig = rigFor(kind, W, H),
      ground = x => .1 * (x - 12), reflectedGround = x => ground(-x),
      original = kind === 'blade' ? bladeDrop(rig, place, profile(ground)) : screedDrop(rig, place, profile(ground)),
      reflected = kind === 'blade' ? bladeDrop(rig, opposite, profile(reflectedGround)) : screedDrop(rig, opposite, profile(reflectedGround));
    near(piece.x + toolOffset(kind, piece), toolAt(kind, place, W, H), 1e-12, `${kind}: common tool point`);
    near(other.x + toolOffset(kind, other), -toolAt(kind, place, W, H), 1e-12, `${kind}: reflected tool point`);
    near(original.drop, reflected.drop, 1e-12, `${kind}: stroke`);
    assert.equal(original.contact, reflected.contact);
    if (kind === 'paver') near(original.tilt, reflected.tilt, 1e-12, 'reflected screed seating');
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W * TOOL_POINT[kind].x, H * TOOL_POINT[kind].y]]) {
      const a = place.world(x, y), b = opposite.world(x, y);
      near(b.x, -a.x, 1e-12, `${kind}: rig point x`); near(b.y, a.y, 1e-12, `${kind}: rig point y`);
    }
    const roadworks = tool => new Roadworks({ position: actor => actor.x, world: { modules: [tool] } }),
      actor = { id: 'v', x: 10, facing: 1 }, reflectedActor = { ...actor, x: -actor.x, facing: -1 }, part = kind === 'blade' ? 'grade' : 'pave';
    near(roadworks(other).at(reflectedActor, part, -1), -roadworks(piece).at(actor, part, 1), 1e-12, `${kind}: server work point`);
  }
});

test('a moving machine part crops reflected native damage from its canonical picture without changing the native marks', () => {
  const box = { x: 0, y: 0, w: 1, h: 1 }, mark = { u: .125, v: .25, dx: .4, dy: .7, radiusU: .05, strength: 1 },
    mirror = { ...mark, u: 1 - mark.u, dx: -mark.dx }, unrelated = { ...mark, u: .125 },
    marks = [mirror, unrelated], before = structuredClone(marks), expected = partMarks([mark], box, 4, 2);
  assert.deepEqual(partMarks(marks, box, 4, 2, true), expected);
  assert.deepEqual(expected, [{ ...mark, u: .5, v: .5, radiusU: .2 }]);
  assert.deepEqual(marks, before);
});

test('the road shown made comes out from under its tool along the lane, no further than its end, the ground ahead as it was', () => {
  const blade = (at, from = 100, to = 150) => ({ tool: 'blade', from, to, at }), elsewhere = paved(NO_ROADS, 300, 320, 'asphalt');
  // A blade grading a lane from 100 to 150 over natural ground: graded behind its tool, and what the field laid ahead of it
  // is not shown yet.
  let shown = roadsAtWork(paved(elsewhere, 100, 120, 'graded'), [blade(112.5)]);
  assert.deepEqual(laid(shown.roads), [[100, 112.5, 'graded'], [300, 320, 'asphalt']]);
  assert.deepEqual(shown.windows, [[100, 150]]);
  assert.deepEqual(laid(roadsAtWork(NO_ROADS, [blade(153)]).roads), [[100, 150, 'graded']], 'no further than the end of its lane');
  assert.deepEqual(laid(roadsAtWork(NO_ROADS, [blade(90)]).roads), [], 'none before its tool is on its lane');
  shown = roadsAtWork(NO_ROADS, [blade(130, 150, 100)]);
  assert.deepEqual([laid(shown.roads), shown.windows], [[[130, 150, 'graded']], [[100, 150]]], 'the other way along');
  // A paver paves graded ground, and ahead of its screed the ground is graded still.
  const graded = paved(NO_ROADS, 0, 200, 'graded'), paver = at => ({ tool: 'paver', from: 100, to: 150, at });
  shown = roadsAtWork(paved(graded, 100, 130, 'asphalt'), [paver(115)]);
  assert.deepEqual(laid(shown.roads), [[0, 100, 'graded'], [100, 115, 'asphalt'], [115, 200, 'graded']]);
  // Two machines on one road, the blade ahead of the paver: one stretch of it is drawn anew as they go, from the paver's
  // lane to the blade's.
  shown = roadsAtWork(paved(paved(NO_ROADS, 0, 160, 'graded'), 0, 100, 'asphalt'), [paver(115), blade(165, 150, 200)]);
  assert.deepEqual(laid(shown.roads), [[0, 115, 'asphalt'], [115, 165, 'graded']]);
  assert.deepEqual(shown.windows, [[100, 200]]);
  // The rest of the roads is drawn as it was while the tools go along their lanes, and again when they change lanes.
  const key = (at, from) => roadsAtWork(graded, [{ tool: 'paver', from, to: from + 50, at }]).key;
  assert.equal(key(110, 100), key(140, 100));
  assert.notEqual(key(160, 150), key(140, 100));
  assert.deepEqual(roadsAtWork(graded, []), { roads: graded, windows: [], key: '' });
});

// A machine of a kind told what the field says of its vehicle, frame after frame at 60 a second from `time` on, with the
// roads of the field as `field.roads` has them.
function onScreen(kind = 'blade', roads = NO_ROADS) {
  const machine = {}, module = { kind, health: 10 }, field = { roads };
  let time = 10;
  const frame = (road, tools = null, actor = { field: road ? { road } : null }) => {
    const dt = followWork(machine, actor, module, time); lower(machine, dt);
    if (tools) advanceLanes(machine, tools, dt, field.roads);
    time += 1 / 60;
  };
  return { machine, module, field, frame, frames: (seconds, road, tools) => { for (let i = 0; i < Math.round(seconds * 60); i++) frame(road, tools); } };
}

test('a machine cycles only while the current field says so, retaining its lane briefly as the tool lifts', () => {
  const lane = { tool: 'blade', from: 100, to: 150 }, { machine, frame, frames } = onScreen();
  frame(lane);
  assert.equal(machine.working, true);
  assert.deepEqual(machine.lanes.map(({ tool, from, to, dir }) => [tool, from, to, dir]), [['blade', 100, 150, 1]]);
  frames(LOWER_SECONDS / 2, lane); near(machine.lowered, .5, .02, 'half way down');
  frames(LOWER_SECONDS / 2 + .1, lane); assert.equal(machine.lowered, 1);
  // Current inactivity stops cycles and raises the tool immediately; only its lane is retained briefly.
  frames(ROAD_HOLD - .2, null);
  assert.deepEqual([machine.working, machine.lowered, machine.lanes.length], [false, 0, 1]);
  frames(.3, null);
  assert.deepEqual([machine.working, machine.lane, machine.lanes.length], [false, null, 1], 'told nothing for longer, it is done with its lane');
  frames(LOWER_SECONDS, null); assert.equal(machine.lowered, 0);
  // At rest on its lane (`idle`, its vehicle held up, say), it raises its tool and keeps its lane.
  frames(1, lane); frames(ROAD_HOLD + LOWER_SECONDS, { ...lane, idle: true });
  assert.deepEqual([machine.working, machine.lowered, machine.lanes.length], [false, 0, 1]);
  // Another tool's lane, a broken tool, a ghost: none is at work.
  for (const [actor, module] of [[{ field: { road: { ...lane, tool: 'paver' } } }, { kind: 'blade', health: 10 }],
    [{ field: { road: lane } }, { kind: 'blade', health: 0 }], [{ field: { road: lane }, ghost: true }, { kind: 'blade', health: 10 }]]) {
    const fresh = {}; followWork(fresh, actor, module, 3);
    assert.deepEqual([fresh.working, fresh.lanes], [false, []]);
  }
  // Frames that go back in time begin it again.
  followWork(machine, { field: { road: lane } }, { kind: 'blade', health: 10 }, 1);
  assert.deepEqual([machine.lowered, machine.lanes.map(l => l.done)], [0, [null]]);
});

test('a paver or blade stops its work cycle on explicit idle or absent activity, and resumes with real work', () => {
  for (const kind of ['blade', 'paver']) for (const inactive of [null, { tool: kind, from: 100, to: 150, idle: true }]) {
    const lane = { tool: kind, from: 100, to: 150 }, { machine, frame, frames } = onScreen(kind);
    frames(LOWER_SECONDS + .2, lane);
    const run = machine.run, turn = machine.turn;
    assert.equal(machine.lowered, 1); assert(run > 0 && turn > 0);
    frame(inactive);
    assert.equal(machine.working, false); assert.equal(machine.making, false); assert(machine.lowered < 1);
    assert.equal(machine.run, run); assert.equal(machine.turn, turn);
    frames(.2, inactive); assert.equal(machine.run, run); assert.equal(machine.turn, turn);
    frame(lane); assert.equal(machine.working, true); assert(machine.run > run && machine.turn !== turn);
  }
});

test('a machine whose tool does not reach the ground keeps it down as far as it goes, and makes no road', () => {
  for (const kind of ['blade', 'paver']) {
    const lane = { tool: kind, from: 100, to: 150 }, { machine, frames } = onScreen(kind);
    frames(LOWER_SECONDS + 3, lane, [104]);
    const run = machine.run, done = machine.lanes[0].done;
    assert(done > 3, kind);
    frames(LOWER_SECONDS + 1, { ...lane, idle: true, short: true }, [110]);
    assert.deepEqual([machine.working, machine.making, machine.lowered], [true, false, 1], `${kind}: its tool down`);
    assert.equal(machine.run, run, `${kind}: its conveyor stands`); assert.equal(machine.lanes[0].done, done, `${kind}: the road comes no further`);
    frames(LOWER_SECONDS, lane, [110]); assert(machine.making && machine.lanes[0].done > done, `${kind}: reaching it again, it makes road`);
  }
});

test('a fast machine: the road shown keeps under its tool lane after lane, never ahead of it nor back, however fast it goes', () => {
  // Lanes of fifty metres from 100 on; the field tells the next one, and lays the one left, once the tool is at its end, or
  // a tenth of a second after (`late`): till then the screen knows of no lane further on.
  const lane = k => ({ tool: 'blade', from: 100 + 50 * k, to: 150 + 50 * k }), lags = {};
  for (const late of [0, .1]) for (const pace of [1, 4, 9, 20, 40]) {
    const { machine, field, frame, frames } = onScreen(), name = `${pace} m/s, told ${late} s late`,
      // How long the road takes to catch up with the tool after the field tells a lane late: three metres a second, and
      // half as fast again as the tool goes, faster than it.
      catching = pace * late / (3 + pace / 2) + 2 / 60;
    frames(LOWER_SECONDS + .1, lane(0), [100]);
    let at = 100, shown = 100, most = 0, told = 0, since = 0;
    while (at < 300 - pace / 60) {
      at += pace / 60; since += 1 / 60;
      const k = Math.min(3, Math.max(0, Math.floor((at - pace * late - 100) / 50)));
      if (k !== told) { told = k; since = 0; }
      field.roads = k ? paved(NO_ROADS, 100, 100 + 50 * k, 'graded') : NO_ROADS;
      frame(lane(k), [at]);
      const tip = Math.max(...worksOf(machine, 'blade').map(work => work.at)), behind = at - tip;
      assert(tip <= at + 1e-9, `${name}: never ahead of its tool (${tip} > ${at})`);
      assert(tip >= shown - 1e-9, `${name}: never back (${tip} < ${shown})`);
      if (since > catching && at < 100 + 50 * (k + 1)) assert(behind < 1e-6, `${name}: ${behind} m behind ${since} s after the lane was told`);
      shown = tip; most = Math.max(most, behind);
    }
    // At most as far behind as the field was late.
    assert(most <= pace * late + 1e-6, `${name}: ${most} m behind at the most`);
    lags[name] = +most.toFixed(3);
  }
  assert.deepEqual(Object.values(lags).slice(0, 5), [0, 0, 0, 0, 0], JSON.stringify(lags));
});

test('the road comes out behind the hindmost tool as it goes and never back, and as far as the field laid it on a lane it left', () => {
  const first = { tool: 'blade', from: 100, to: 150 }, second = { tool: 'blade', from: 150, to: 200 }, { machine, field, frame, frames } = onScreen(),
    done = () => machine.lanes.map(lane => +lane.done.toFixed(6));
  frames(LOWER_SECONDS * .9, first, [102]);
  assert.deepEqual(done(), [0], 'nothing while its tool goes down');
  frames(1, first, [102]);
  assert.deepEqual(done(), [2], 'as far as its tool');
  // Gone on as far in a frame — a frame late, say —, the road goes on with it.
  frame(first, [112]); assert.deepEqual(done(), [12], 'one frame');
  frames(1, first, [104]); assert.deepEqual(done(), [12], 'backing, it unmakes nothing');
  // Gone down past where it begins, the road catches up with the tool, three metres a second.
  const late = onScreen(); late.frames(LOWER_SECONDS * 1.1, first, [112]);
  const begun = late.machine.lanes[0].done; late.frame(first, [112]); near(late.machine.lanes[0].done, begun + 3 / 60, 1e-9, 'one frame');
  late.frames(1, first, [112]); near(late.machine.lanes[0].done, begun + 3 + 3 / 60, 1e-9, 'a second');
  late.frames(4, first, [112]); assert.equal(late.machine.lanes[0].done, 12);
  // Two of its kind on its vehicle: as far as the hindmost of them, behind which the field makes the road.
  frames(1, first, [118, 113]); assert.deepEqual(done(), [13]);
  // Its tool short of the end of the lane by less than it reaches, the field is done with it, lays all of it and tells the
  // next: the first comes on to its end and goes, and the road goes on into the next behind the tool.
  frames(13, first, [149.6]); assert.deepEqual(done(), [49.6]);
  field.roads = paved(NO_ROADS, 100, 150, 'graded');
  frame(second, [149.6]); assert.deepEqual(done(), [49.65, 0]);
  frames(.5, second, [150.4]); assert.deepEqual(done(), [.4]);
  assert.deepEqual(worksOf(machine, 'blade').map(work => ({ ...work, at: +work.at.toFixed(6) })), [{ tool: 'blade', from: 150, to: 200, at: 150.4 }]);
  // No further than the end of its lane.
  frames(30, second, [230]); assert.deepEqual(done(), [50]);
  // A lane left with the tool short of its end, for another: as far as the field laid it, and it goes once it comes no further.
  const left = onScreen();
  left.frames(16, first, [144]); left.field.roads = paved(NO_ROADS, 100, 144.5, 'graded');
  left.frames(1, second, [144]);
  assert.deepEqual(left.machine.lanes.map(lane => +lane.done.toFixed(6)), [44.5, 0]);
  left.frames(2.5, second, [144]);
  assert.deepEqual(left.machine.lanes.map(lane => lane.from), [150]);
  // Told it makes none of its lane (held up, say), or nothing more (gone for fuel): the road no longer follows its tool,
  // which is still down a moment, but comes on as far as the field laid it; and the lane goes once it comes no further.
  for (const [said, at] of [[{ ...first, idle: true }, 1], [null, ROAD_HOLD + .1]]) {
    const gone = onScreen(), name = JSON.stringify(said), shown = () => gone.machine.lanes.map(lane => +lane.done.toFixed(6));
    gone.frames(5, first, [110]); gone.field.roads = paved(NO_ROADS, 100, 110.4, 'graded');
    gone.frames(.5, said, [113]);
    near(gone.machine.lowered, .5, .02, name); assert.deepEqual(shown(), [10.4], name);
    gone.frames(at + 3, said, [113]);
    assert.deepEqual(shown(), said ? [10.4] : [], name);
  }
  // A machine back on a lane it left finds it laid as far as the field laid it, its tool short of that or past it — the
  // road comes on to a tool past it once it is down —, and only what runs on from where the lane begins.
  const graded = paved(NO_ROADS, 0, 300, 'graded');
  for (const [lane, roads, tools, at, then] of [
    [{ tool: 'paver', from: 100, to: 150 }, paved(graded, 100, 131.5, 'asphalt'), [129], 131.5, 131.5],
    [{ tool: 'paver', from: 100, to: 150 }, paved(graded, 100, 131.5, 'asphalt'), [133], 131.5, 133],
    [{ tool: 'paver', from: 150, to: 100 }, paved(graded, 122.25, 150, 'asphalt'), [118], 122.25, 118],
    [{ tool: 'paver', from: 100, to: 150 }, paved(graded, 101, 131.5, 'asphalt'), [103], 100, 103]]) {
    const back = onScreen('paver', roads), name = JSON.stringify([lane, tools]), shown = () => worksOf(back.machine, 'paver').map(work => +work.at.toFixed(6));
    back.frame(lane, tools);
    assert.deepEqual(shown(), [at], name);
    back.frames(LOWER_SECONDS + 2, lane, tools);
    assert.deepEqual(shown(), [then], name);
  }
});

// A drawing that keeps the outline of each shape it is given.
function outlines() {
  const shapes = [], chain = { fill: () => chain, stroke: () => chain };
  return { shapes, poly(points) { shapes.push(points); return chain; } };
}

// The earth a blade moves is drawn as its moldboard is (machine-art.ts `moldboard`), on the foot of the moldboard, from the
// heel at its near end, the lower, to the toe at its far one: a roll before its face all along it, the deeper towards the
// heel it is pushed to, a heap that comes down to its foot at either end, and a low ridge left off the heel. None of it is
// lower than the foot, nor over the top of the moldboard.
test('the earth a blade moves lies along its cutting edge: a roll before its face, deeper at its heel, a ridge off its heel, none of it under its foot', () => {
  for (const scale of [.5, 1, 2]) {
    const [W, H] = size('blade', scale), rig = rigFor('blade', W, H), { face, foot } = moldboard(rig), edge = cuttingEdge(rig), s = rig.s,
      length = Math.hypot(edge.toe.x - edge.heel.x, edge.toe.y - edge.heel.y);
    // Up, and down plumb, on ground that lies all along under the level edge.
    for (const drop of [0, .2])
    for (const phase of [0, .37, 1.9, 7.3]) for (const amount of [.2, .6, 1]) {
      const g = outlines(), name = `×${scale} ${drop} m down, ${phase} on, ${amount} of it`,
        surface = [0, .25, .5, .75, 1].map(u => ({ u, x: edge.heel.x + (edge.toe.x - edge.heel.x) * u, y: edge.heel.y + (edge.toe.y - edge.heel.y) * u, gap: drop, under: drop, low: drop })),
        pose = bladePose(rig, { x: 0, y: 1 }, drop, surface),
        heel = { x: edge.heel.x, y: edge.heel.y + drop }, toe = { x: edge.toe.x, y: edge.toe.y + drop },
        share = x => (x - heel.x) / (toe.x - heel.x), base = x => heel.y + (toe.y - heel.y) * Math.min(1, Math.max(0, share(x))),
        top = face(0, 0).y + pose.dy, over = (x, h) => base(x) - h;
      assert.deepEqual([edge.heel, edge.toe], [foot(0), foot(1)], name);
      drawEarth(g, rig, pose, phase, earthTone('soil'), .0005, amount);
      assert(g.shapes.length >= 5, name);
      for (const points of g.shapes) {
        assert.equal(points.length % 2, 0, name);
        for (let i = 0; i < points.length; i += 2) {
          const [x, h] = [points[i], points[i + 1]];
          assert(h <= base(x) + 1e-9 && h >= top, `${name}: a point ${base(x) - h} m over the foot, ${h - top} m under the top of the moldboard`);
          assert(x >= heel.x - 1e-9 && x <= toe.x + 1e-9, `${name}: a point at ${x}, the edge from ${heel.x} to ${toe.x}`);
        }
      }
      // The roll is all along the edge, on its foot, and comes down to it at either end as loose earth does.
      const roll = g.shapes[0], n = roll.length / 4, crest = i => over(roll[2 * i], roll[2 * i + 1]);
      for (const [x, y] of [[roll[0], roll[1]], [roll.at(-2), roll.at(-1)]]) { near(x, toe.x, 1e-12, `${name}: from the toe`); near(y, toe.y, 1e-12, name); }
      for (const [x, y] of [[roll[2 * n - 2], roll[2 * n - 1]], [roll[2 * n], roll[2 * n + 1]]]) { near(x, heel.x, 1e-12, `${name}: to the heel`); near(y, heel.y, 1e-12, name); }
      for (let i = 0; i < n; i++) near(over(roll[2 * i], roll[2 * i + 1]), 0, 1e-12, `${name}: its base on the foot`);
      for (let i = n; i < 2 * n; i++) {
        const u = share(roll[2 * i]);
        assert(crest(i) <= Math.tan(35 * Math.PI / 180) * length * Math.min(u, 1 - u) + 1e-9, `${name}: ${crest(i)} m thick at ${u}`);
        if (u > 1e-9 && u < 1 - 1e-9) assert(crest(i) > 0, `${name}: its crest ${crest(i)} m over the edge at ${u}`);
      }
      // The deeper at its heel.
      const deepest = (a, b) => Math.max(...Array.from({ length: n }, (_, i) => n + i).filter(i => share(roll[2 * i]) >= a && share(roll[2 * i]) <= b).map(crest));
      assert(deepest(0, .25) > deepest(.75, 1) * 1.2, `${name}: ${deepest(0, .25)} m deep by the heel, ${deepest(.75, 1)} m by the toe`);
      // And a low ridge near the heel, within the sampled part of the edge.
      assert(g.shapes.some(points => {
        const xs = points.filter((_, i) => i % 2 === 0);
        return Math.min(...xs) >= heel.x - 1e-9 && Math.max(...xs) <= heel.x + .3 * s + 1e-9 && Math.max(...xs) > heel.x + .1 * s;
      }), name);
    }
    // Too far to see it, it is not drawn.
    const g = outlines(); drawEarth(g, rig, bladePose(rig, { x: 0, y: 1 }, 0), 0, earthTone('soil'), 1, 1); assert.deepEqual(g.shapes, []);
  }
});

test('grader earth follows sampled rising and falling terrain, reflects with its tool and only appears where it bites', () => {
  for (const scale of [.5, 1.5]) for (const angle of [Math.atan(.3), Math.atan(-.2)])
  for (const mirrored of [false, true]) for (const difference of [0, .12]) {
    const [W, H] = size('blade', scale), rig = rigFor('blade', W, H), original = { x: 12, y: 3, angle, mirrored }, place = placeOf(original, W, H),
      grade = Math.tan(angle) + difference, edge = levelEdge(rig, place), ends = [edge.from, edge.to],
      low = ends.reduce((a, b) => a.y - grade * a.x < b.y - grade * b.x ? a : b), actual = slope(grade, low, .2 * scale),
      name = `×${scale} ${angle.toFixed(3)} ${mirrored} ${difference}`;
    let reads = 0;
    const ground = profile(x => { reads++; return actual(x); }), set = bladeDrop(rig, place, ground),
      pose = bladePose(rig, place.down, set.drop, set.surface), before = structuredClone(set), g = outlines();
    assert(set.contact); assert.equal(reads, 4, 'the ends of the ground under the level edge, and under the foot as painted');
    drawEarth(g, rig, pose, .37, earthTone('soil'), .0001, 1); assert(g.shapes.length >= 3);
    assert.equal(reads, 4, 'all clods reuse the contact profile'); assert.deepEqual(set, before);
    const earth = checkEarth(g, rig, place, pose, actual, actual, name);
    checkBase(g, rig, place, pose, actual, name);
    if (!difference) { near(earth.lo, 0, 1e-9, `${name}: along the whole edge`); near(earth.hi, 1, 1e-9, name); }
    else assert(earth.hi - earth.lo < .5, `${name}: only where the edge comes to the ground, ${earth.lo} to ${earth.hi}`);
    for (const shape of g.shapes) for (let i = 0; i < shape.length; i += 2) {
      const p = place.world(shape[i], shape[i + 1]); assert(p.y >= actual(p.x) - 1e-8, `${name}: earth stays over the real ground`);
    }
    const reflected = placeOf({ ...original, x: -original.x, angle: -angle, mirrored: !mirrored }, W, H),
      other = bladeDrop(rig, reflected, profile(x => actual(-x))), opposite = outlines();
    drawEarth(opposite, rig, bladePose(rig, reflected.down, other.drop, other.surface), .37, earthTone('soil'), .0001, 1);
    assert.equal(opposite.shapes.length, g.shapes.length);
    for (let k = 0; k < g.shapes.length; k++) for (let i = 0; i < g.shapes[k].length; i += 2) {
      const a = place.world(g.shapes[k][i], g.shapes[k][i + 1]), b = reflected.world(opposite.shapes[k][i], opposite.shapes[k][i + 1]);
      near(b.x, -a.x, 1e-8, 'reflected earth x'); near(b.y, a.y, 1e-8, 'reflected earth y');
    }
    const lowering = outlines(); drawEarth(lowering, rig, bladePose(rig, place.down, set.drop * .6, set.surface), .37, earthTone('soil'), .0001, 1);
    assert.equal(lowering.shapes.length, 0, 'no soil before the blade actually reaches');
    const unreachable = bladeDrop(rig, place, profile(slope(grade, low, rig.reach + 1))), empty = outlines();
    drawEarth(empty, rig, bladePose(rig, place.down, unreachable.drop, unreachable.surface), .37, earthTone('soil'), .0001, 1);
    assert(!unreachable.contact); assert.equal(empty.shapes.length, 0, 'no working soil over an unreachable ditch');
  }
});

test('grader soil never extrapolates its ridge onto an unknown step behind the heel', () => {
  const [W, H] = size('blade', 1), rig = rigFor('blade', W, H), { heel } = cuttingEdge(rig);
  for (const mirrored of [false, true]) for (const outside of [-2, 2]) for (const angle of [Math.atan(.3), Math.atan(-.3)])
  for (const grade of [0, Math.tan(angle)]) for (const phase of [0, .37]) {
    // The step is behind the heel, where the edge and the foot of the moldboard both begin; the ground under them is read.
    const place = placeOf({ x: 12, y: 3, angle, mirrored }, W, H), edge = levelEdge(rig, place), ends = [edge.from, edge.to],
      behind = edge.from.x, way = Math.sign(edge.to.x - edge.from.x),
      low = ends.reduce((a, b) => a.y - grade * a.x < b.y - grade * b.x ? a : b), baseline = slope(grade, low, .2),
      ground = x => baseline(x) + ((x - behind) * way < -1e-9 ? outside : 0), set = bladeDrop(rig, place, profile(ground)), g = outlines(),
      pose = bladePose(rig, place.down, set.drop, set.surface);
    drawEarth(g, rig, pose, phase, earthTone('soil'), .0001, 1);
    assert(g.shapes.length >= 3);
    checkEarth(g, rig, place, pose, baseline, baseline, 'the ground read'); checkBase(g, rig, place, pose, baseline, 'the ground read');
    near(place.world(heel.x, heel.y).x, behind, 1e-12, 'the heel is painted where it cuts');
    for (const shape of g.shapes) for (let i = 0; i < shape.length; i += 2) {
      const p = place.world(shape[i], shape[i + 1]);
      assert((p.x - behind) * way >= -1e-9, 'no earth behind the heel, on the step');
      assert(p.y >= ground(p.x) - 1e-9, 'earth over the ground it read');
    }
  }
});

test('grader dust and clods come only from endpoints that actually bite, off the earth there', () => {
  const [W, H] = size('blade', 1), rig = rigFor('blade', W, H), edge = cuttingEdge(rig), drop = .2;
  for (const mirrored of [false, true]) for (const ends of [[true, false], [false, true], [true, true], [false, false]]) for (const cut of [false, true]) {
    // The ground it leaves at either end within reach or off it; or the bumps it cuts there, of the ground as it lies.
    const off = u => (ends[0] ? 0 : .1) * (1 - u) + (ends[1] ? 0 : .1) * u,
      surface = [0, .25, .5, .75, 1].map(u => ({ u, x: edge.heel.x + (edge.toe.x - edge.heel.x) * u, y: edge.heel.y + (edge.toe.y - edge.heel.y) * u,
        gap: drop + (cut ? .1 : off(u)), under: drop + (cut ? off(u) - .05 : off(u)), low: drop + .03 * u })),
      place = placeOf({ x: 12, y: 2, angle: Math.atan(.3), mirrored }, W, H), pose = bladePose(rig, place.down, drop, surface),
      machine = { rig, place, pose, dt: 1, time: 1 }, particles = [];
    let reads = 0;
    const renderer = { scene: { frame: { actors: new Map([['v', { vehicle: { vx: 1 } }]]) } }, ground: { height() { reads++; return 0; } },
      effects: { add(kind, particle) { particles.push({ kind, ...particle }); } }, roadMachineDue: Renderer.prototype.roadMachineDue };
    Renderer.prototype.bladeDust.call(renderer, { actorId: 'v' }, machine, rig, place, pose, earthTone('soil'));
    assert.equal(reads, 0, 'dust reuses the same endpoint heights as the earth');
    assert.equal(particles.filter(p => p.kind === 'smoke').length, ends[0] ? 3 : 0);
    assert.equal(particles.filter(p => p.kind === 'dust').length, (ends[0] ? 10 : 0) + (ends[1] ? 4 : 0));
    assert.deepEqual([biting(pose, surface[0]), biting(pose, surface.at(-1))], ends);
    // Off the heel and the toe, where their earth lies on the ground.
    const world = p => { const q = earthFoot(pose, p); return place.world(q.x, q.y); }, back = world(surface[0]), front = world(surface.at(-1));
    for (const p of particles.filter(p => p.kind === 'smoke')) assert(Math.abs(p.y - .1 - back.y) < 1e-9 && Math.abs(p.x - back.x) <= .3 + 1e-9);
    if (ends[1]) near(front.y, place.world(surface.at(-1).x, surface.at(-1).y).y - drop - .03, 1e-9, 'the toe on the ground drawn under it');
  }
});

test('grader contact uses every corner of the ground drawn close by and of the ground it leaves, across bump cells and road changes', () => {
  const [W, H] = size('blade', 1.5), rig = rigFor('blade', W, H), edge = cuttingEdge(rig);
  for (const mirrored of [false, true]) for (const angle of [Math.atan(.3), Math.atan(-.2)]) {
    const terrain = new Terrain('rough');
    terrain.sectors = [{ start: -1600, end: 1600, surface: 'gravel' }];
    for (const point of terrain.points) point.y = Math.tan(angle) * (point.x - 32) + .04 * Math.cos(point.x * 3);
    const origin = placeOf({ x: 0, y: 0, angle, mirrored }, W, H), middle = origin.world((edge.heel.x + edge.toe.x) / 2, edge.heel.y),
      x = 32 - middle.x, initial = levelEdge(rig, placeOf({ x, y: 0, angle, mirrored }, W, H)), { from, to } = initial,
      left = Math.min(from.x, to.x), right = Math.max(from.x, to.x), ground = underfootGround(terrain), graded = gradedGround(terrain), leveled = [];
    for (const roads of [NO_ROADS, paved(NO_ROADS, 31.9, 32.2, 'asphalt'), paved(NO_ROADS, 20, 40, 'graded')]) {
      terrain.roads = roads;
      const drawn = new RoughGround(terrain, left, right), outline = ground.section(left, right), level = graded.section(left, right),
        gap = p => from.y + (to.y - from.y) * (p.x - from.x) / (to.x - from.x) - p.y,
        lift = .2 - Math.min(...level.map(gap)), place = placeOf({ x, y: lift, angle, mirrored }, W, H), set = bladeDrop(rig, place, graded, ground),
        along = levelEdge(rig, place), xs = set.surface.map(p => along.at(p.u).x), feet = set.surface.map(p => place.world(p.x, p.y)),
        under = drawn.section(...[feet[0].x, feet.at(-1).x].sort((a, b) => a - b));
      leveled.push(level);
      assert(outline.length > 5 && level.length > 2, 'bumps and map corners replace the five uniform samples');
      assert(outline.some(p => p.x === 32), 'the cached stretches join at their shared endpoint');
      for (const point of drawn.section(left, right)) {
        const sampled = outline.find(p => Math.abs(p.x - point.x) < 1e-10);
        assert(sampled, 'no drawn corner is omitted'); near(sampled.y, point.y, 1e-10, 'shared rough-ground authority');
      }
      // Graded earth is no rougher than it is (terrain.ts `BUMPS`), and lies on the line of the ground.
      for (const p of level) assert(Math.abs(p.y - terrain.height(p.x)) <= .0075 + 1e-12, `graded earth ${p.y - terrain.height(p.x)} m off the line`);
      for (const p of [...outline, ...level]) assert(xs.some(x => Math.abs(x - p.x) < 1e-9), `the corner at ${p.x} under the edge is read`);
      for (const p of under) assert(feet.some(f => Math.abs(f.x - p.x) < 1e-9), `the corner at ${p.x} under the foot is read`);
      near(set.drop, .2, 1e-10, 'the highest of the ground it leaves seats the level edge');
      assert(set.contact);
      for (const [i, p] of set.surface.entries()) {
        const at = along.at(p.u);
        near(p.gap, at.y - graded.height(at.x), 1e-9, 'the ground it leaves under the level edge');
        near(p.under, at.y - drawn.height(at.x), 1e-9, 'the ground as it lies, on the same authority as drawn');
        near(p.low, feet[i].y - drawn.height(feet[i].x), 1e-9, 'the ground drawn under the foot as painted');
      }
      // On natural gravel it cuts the bumps over what it leaves; over graded earth, nothing but what it leaves.
      if (!roads.length) assert(set.surface.some(p => p.under < set.drop - .005), 'the gravel stands over its edge');
      if (roads[0]?.kind === 'graded') for (const p of set.surface) near(p.under, p.gap, 1e-12, 'graded earth is what it leaves');
    }
    assert.deepEqual(leveled[0], leveled[1], 'the ground it leaves, whatever lies there now');
    assert.deepEqual(leveled[0], leveled[2], 'the ground it leaves, as the field lays it');
  }
});

test('separate curved contact patches never become a floating strip or emit earth before contact', () => {
  const [W, H] = size('blade', 1), rig = rigFor('blade', W, H),
    knots = [[0, .25], [.13, .2], [.3, .25], [.5, .25], [.67, .2], [.8, .25], [1, .25]],
    gapAt = v => {
      const u = Math.min(1, Math.max(0, v)), i = Math.max(1, knots.findIndex(([at]) => at >= u)), [a, ay] = knots[i - 1], [b, by] = knots[i];
      return ay + (by - ay) * (u - a) / (b - a);
    };
  for (const mirrored of [false, true]) for (const angle of [Math.atan(.3), Math.atan(-.3)]) {
    const place = placeOf({ x: 12, y: 3, angle, mirrored }, W, H), edge = levelEdge(rig, place), { uAt } = edge,
      actual = x => edge.at(uAt(x)).y - gapAt(uAt(x)),
      ground = profile(actual, knots.map(([u]) => edge.at(u).x)), set = bladeDrop(rig, place, ground),
      oldGap = Math.min(...[0, .25, .5, .75, 1].map(gapAt)), before = structuredClone(set);
    near(set.drop, .2, 1e-10, 'the two peaks seat the edge');
    assert(oldGap > set.drop + BLADE_CONTACT, 'five uniform samples would miss the real contact peaks');
    for (const phase of [0, .37, 1.9]) {
      const g = outlines(), pose = bladePose(rig, place.down, set.drop, set.surface);
      drawEarth(g, rig, pose, phase, earthTone('soil'), .0001, 1);
      assert(g.shapes.length >= 6, 'both contact patches are drawn');
      checkEarth(g, rig, place, pose, actual, actual, `${mirrored} ${angle} ${phase}`);
      for (const shape of g.shapes) {
        const us = [];
        for (let i = 0; i < shape.length; i += 2) {
          const p = place.world(shape[i], shape[i + 1]);
          us.push(onEdge(rig, place.down, shape[i], shape[i + 1]).u);
          assert(p.y >= actual(p.x) - 1e-9, 'no vertex enters the curved surface');
          const j = (i + 2) % shape.length, next = place.world(shape[j], shape[j + 1]),
            x = (p.x + next.x) / 2, y = (p.y + next.y) / 2;
          assert(y >= actual(x) - 1e-9, 'no polygon edge cuts across a terrain corner');
        }
        assert(!(Math.min(...us) < .5 && Math.max(...us) > .5), 'the valley between patches stays empty');
      }
    }
    assert.deepEqual(set, before, 'drawing never changes the contact profile');
    const lowering = outlines();
    drawEarth(lowering, rig, bladePose(rig, place.down, set.drop * .6, set.surface), 0, earthTone('soil'), .0001, 1);
    assert.equal(lowering.shapes.length, 0, 'the animation does not work before reaching the ground');
  }
});

test('a detached grader is removed without reading terrain or preparing its moving artwork', () => {
  const fail = () => assert.fail('a detached tool has no ground or artwork work'), ground = { roads: NO_ROADS, height: fail, section: fail },
    works = [], destroyed = [], renderer = { ground, standing: () => ground, camera: { zoom: 100 },
      roadMachines: new Map([['old', { view: { destroy: () => destroyed.push('old') } }]]),
      scene: { pose: fail, frame: { actors: new Map() } }, unseen: new Set(), roadMachineArt: fail,
      terrainScene: { showWork: value => works.push(value) } };
  Renderer.prototype.stepRoadMachines.call(renderer, { modules: [{ id: 'detached', kind: 'blade', attached: false }] }, 1);
  assert.deepEqual(destroyed, ['old']);
  assert.equal(renderer.roadMachines.size, 0);
  assert.deepEqual(works, [[]]);
});
