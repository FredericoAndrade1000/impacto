import test from 'node:test';
import assert from 'node:assert/strict';
import { paintComponent } from '../src/component-art.ts';
import { FACED_KINDS, MACHINE_KINDS, machineCanvas, moldboard } from '../src/machine-art.ts';
import { MODULES } from '../src/materials.ts';
import { MOTION_PARTS, machineRig, partBox } from '../src/road-machine-motion.ts';
import { TOOL_POINT } from '../src/road-tools.ts';

// A context that keeps, in pixels of its canvas, the outline of what is filled with an opaque paint (through the
// transforms it was filled under), the circles drawn and how far the transform squashes them, and the lettering.
function recorder(width, height) {
  let m = [1, 0, 0, 1, 0, 0], subpaths = [], current = null;
  const saved = [], fills = [], circles = [], texts = [];
  const apply = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const multiply = (a, b, c, d, e, f) => {
    m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
  };
  const point = (x, y) => { if (!current) subpaths.push(current = []); current.push(apply(x, y)); };
  const gradient = () => { const stops = []; return { stops, addColorStop: (at, color) => stops.push(color) }; };
  const alpha = color => typeof color === 'string' ? (color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1) : Math.min(...color.stops.map(alpha));
  const ctx = {
    canvas: { width, height }, fillStyle: '#000000',
    save() { saved.push(m); }, restore() { m = saved.pop(); },
    translate(x, y) { multiply(1, 0, 0, 1, x, y); }, scale(x, y) { multiply(x, 0, 0, y, 0, 0); },
    rotate(a) { multiply(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0); },
    beginPath() { subpaths = []; current = null; }, closePath() { current = null; },
    moveTo(x, y) { current = null; point(x, y); }, lineTo: point, quadraticCurveTo(cx, cy, x, y) { point(x, y); },
    rect(x, y, w, h) { ctx.roundRect(x, y, w, h, 0); },
    roundRect(x, y, w, h, r = 0) {
      current = null;
      for (const [cx, cy, a] of [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]])
        for (let i = 0; i <= 4; i++) point(cx + Math.cos(a + i * Math.PI / 8) * r, cy + Math.sin(a + i * Math.PI / 8) * r);
      current = null;
    },
    arc(x, y, r, start, end) {
      for (let i = 0; i <= 24; i++) { const a = start + (end - start) * i / 24; point(x + Math.cos(a) * r, y + Math.sin(a) * r); }
      if (end - start >= Math.PI * 2 - 1e-9) {
        const [cx, cy] = apply(x, y);
        circles.push({ r: r * Math.hypot(m[0], m[1]), x: cx, y: cy, squash: Math.hypot(m[2], m[3]) / Math.hypot(m[0], m[1]) });
      }
    },
    ellipse() { throw new Error('an ellipse is a circle seen aslant'); },
    fill() { if (alpha(ctx.fillStyle) >= .5) fills.push({ polygons: subpaths.map(p => p.slice()), style: ctx.fillStyle }); },
    fillRect(x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); },
    clip() {}, stroke() {}, createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: text => ({ width: text.length * 7 }), fillText(text) { texts.push(text); },
  };
  return { ctx, fills, circles, texts };
}
const inside = ([x, y], polygon) => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
function painted(kind, scale, options = {}) {
  const widthM = MODULES[kind].width * scale, heightM = MODULES[kind].height * scale, [width, height] = machineCanvas(widthM, heightM),
    record = recorder(width, height), before = { ...options };
  paintComponent(record.ctx, kind, widthM, heightM, options);
  assert.deepEqual(options, before, 'the art does not touch what it is given');
  return { ...record, width, height, perMetre: width / widthM };
}
const KINDS = ['blade', 'paver'], SCALES = [.25, .5, 1, 2], RECESS = '#141f1a';

test('the blade and the paver are machines painted in metres, facing along their construction', () => {
  for (const kind of KINDS) assert(MACHINE_KINDS.has(kind) && FACED_KINDS.has(kind), kind);
  assert.deepEqual([...FACED_KINDS].sort(), KINDS);
});

test('the paver covers the whole of its box at every size, with little of it only recess, and says nothing in words', () => {
  for (const scale of SCALES) {
    const { fills, width, height, perMetre, texts } = painted('paver', scale), corner = .016 * perMetre, holes = [],
      parts = fills.filter(fill => fill.style !== RECESS), name = `paver ×${scale}`;
    let samples = 0, recessed = 0;
    for (let j = 0; j < 30; j++) for (let i = 0; i < 60; i++) {
      const p = [(i + .5) * width / 60, (j + .5) * height / 30], dx = Math.min(p[0], width - p[0]), dy = Math.min(p[1], height - p[1]);
      if (dx < corner && dy < corner) continue;
      samples++;
      if (!fills.some(({ polygons }) => polygons.some(polygon => inside(p, polygon)))) holes.push(p.map(Math.round));
      else if (!parts.some(({ polygons }) => polygons.some(polygon => inside(p, polygon)))) recessed++;
    }
    assert.deepEqual(holes, [], name);
    assert(recessed / samples < .15, `${name}: ${Math.round(recessed / samples * 100)} % is only recess`);
    assert.deepEqual(texts, [], name);
  }
});

// The blade of a grader stands in the open, as a sensor does: no dark ground of a box behind it, the world shows between
// its parts — under the circle, about the struts the moldboard hangs by, and under the ball, past the far end of the
// moldboard —, and it reaches its box from side to side, by the saddle it hangs by and the ball at its front, and from
// its top to its foot, by the cutting edge.
test('the blade stands in the open, reaching its box from side to side and from top to foot, and says nothing in words', () => {
  for (const scale of SCALES) {
    const { fills, width, height, perMetre, texts } = painted('blade', scale), name = `blade ×${scale}`,
      points = fills.flatMap(({ polygons }) => polygons.flat()), xs = points.map(p => p[0]), ys = points.map(p => p[1]),
      covers = p => fills.some(({ polygons }) => polygons.some(polygon => inside(p, polygon))), at = (u, v) => [u * width, v * height];
    assert(fills.every(fill => fill.style !== RECESS), name);
    assert(Math.min(...xs) < width * .04 && Math.max(...xs) > width * .96, `${name}: from ${Math.min(...xs)} to ${Math.max(...xs)} of ${width}`);
    assert(Math.min(...ys) <= 0 && Math.abs(Math.max(...ys) - height) < .004 * perMetre, `${name}: from ${Math.min(...ys)} to ${Math.max(...ys)} of ${height}`);
    let samples = 0, covered = 0;
    for (let j = 0; j < 30; j++) for (let i = 0; i < 60; i++) {
      samples++;
      if (covers([(i + .5) * width / 60, (j + .5) * height / 30])) covered++;
    }
    assert(covered / samples < .7, `${name}: ${Math.round(covered / samples * 100)} % of its box covered`);
    for (const [u, v] of [[.1, .32], [.45, .32], [.9, .45], [.95, .9], [.7, .95]]) assert(!covers(at(u, v)), `${name}: open at ${u}, ${v} of its box`);
    assert.deepEqual(texts, [], name);
  }
});

// Seen square on from the side: only what turns across the vehicle is round, and nothing round is squashed.
test('only what turns across the vehicle is round: the ball of the drawbar, and the sprockets, the auger and the push roller', () => {
  for (const kind of KINDS) for (const scale of SCALES) {
    const { circles } = painted(kind, scale);
    for (const { squash } of circles) assert(Math.abs(squash - 1) < .02, `${kind} ×${scale}: a circle squashed ${squash}`);
  }
  // The blade: its biggest round is the ball of the drawbar, at the front end; the paver: the conveyor's sprockets and the
  // push roller at its foot, the auger at the rear, low, the biggest of them.
  {
    const blade = painted('blade', 1), ball = blade.circles.reduce((a, b) => b.r > a.r ? b : a),
      front = ball.x > blade.width * .8;
    assert(front && ball.y < blade.height * .3, `the ball at ${ball.x}, ${ball.y}`);
    const paver = painted('paver', 1), big = paver.circles.filter(c => c.r / paver.perMetre > .04),
      auger = big.reduce((a, b) => b.r > a.r ? b : a), atRear = auger.x < paver.width * .3;
    assert(big.length >= 4 && big.every(c => c.y > paver.height * .75), `${big.map(c => [c.x, c.y].map(Math.round))}`);
    assert(atRear, `the auger at ${auger.x}`);
  }
});

test('a bigger machine keeps its fittings and its slats of their size: there are more of them', () => {
  // A bolt, a stud, the head of a plough bolt, a button: what is smaller than 16 mm every way, and its largest side.
  const fittings = (kind, scale) => { const art = painted(kind, scale); return art.fills.flatMap(f => f.polygons).map(p => {
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / art.perMetre;
  }).filter(side => side < .016); };
  for (const kind of KINDS) {
    const [one, two] = [fittings(kind, 1), fittings(kind, 2)];
    assert(one.length > 10 && two.length > one.length * 1.5, `${kind}: ${one.length} fittings, then ${two.length}`);
    assert(Math.abs(Math.max(...two) - Math.max(...one)) < .001, `${kind}: ${Math.max(...one)} m, then ${Math.max(...two)} m`);
  }
  const slats = scale => { const art = painted('paver', scale); return art.fills.filter(f => f.style === '#8d907e').length; };
  assert(slats(2) > slats(1) * 1.8, `${slats(1)} slats, then ${slats(2)}`);
});

// A part of a machine painted on its own, as the field paints it at work (render.ts `roadMachineArt`): as it travels, its
// front at the right, the stretch of the picture of its whole box that its box takes. Its fills in metres of that picture.
function paintedPart(kind, scale, part) {
  const W = MODULES[kind].width * scale, H = MODULES[kind].height * scale, box = part === 'frame' ? { x: 0, y: 0, w: W, h: H } : partBox(machineRig(kind, W, H), part, W, H),
    crop = part === 'frame' ? null : { x: box.x, y: box.y, W, H }, [width, height] = machineCanvas(box.w, box.h, crop),
    record = recorder(width, height);
  paintComponent(record.ctx, kind, box.w, box.h, { part, ...(crop ? { crop } : {}) });
  return inMetres(record.fills, box.w / width, box.h / height, box.x, box.y);
}
const inMetres = (fills, sx, sy, x = 0, y = 0) => fills.map(({ polygons, style }) => ({ style, polygons: polygons.map(p => p.map(([px, py]) => [x + px * sx, y + py * sy])) }));
const sameFill = (a, b) => JSON.stringify(a.style) === JSON.stringify(b.style) && a.polygons.length === b.polygons.length &&
  a.polygons.every((p, i) => p.length === b.polygons[i].length && p.every(([x, y], k) => Math.abs(x - b.polygons[i][k][0]) < .002 && Math.abs(y - b.polygons[i][k][1]) < .002));

test('painted in parts for the field to move at work, each is its whole picture as it travels, but for what the field draws itself', () => {
  for (const kind of KINDS) for (const scale of [.5, 1, 2]) {
    const whole = painted(kind, scale), W = MODULES[kind].width * scale, H = MODULES[kind].height * scale, rig = machineRig(kind, W, H),
      fills = inMetres(whole.fills, W / whole.width, H / whole.height), parts = ['frame', ...MOTION_PARTS[kind]].map(part => ({ part, fills: paintedPart(kind, scale, part), next: 0 })),
      left = [];
    // Every fill of every part is in the whole picture where it is in the part's, in the order the whole has them.
    for (const fill of fills) {
      const owner = parts.find(part => part.next < part.fills.length && sameFill(part.fills[part.next], fill));
      if (owner) owner.next++; else left.push(fill);
    }
    for (const { part, fills: own, next } of parts) assert.equal(next, own.length, `${kind} ×${scale}: ${part}, ${own.length - next} of its fills not in the whole`);
    // What is left is what the field draws on every frame: the rams that lower a blade, the ram that lifts a screed and
    // the slats of a paver's conveyor.
    const rams = kind === 'blade' ? [rig.lift, rig.shift] : [rig.lift], slack = rig.d,
      onRam = ([x, y]) => rams.some(({ top, foot }) => x >= Math.min(top.x, foot.x) - slack && x <= Math.max(top.x, foot.x) + slack &&
        y >= Math.min(top.y, foot.y) - slack && y <= Math.max(top.y, foot.y) + slack),
      onConveyor = ([x, y]) => kind === 'paver' && x >= rig.conveyor.x0 - .001 && x <= rig.conveyor.x1 + .001 && y >= rig.conveyor.top - .001 && y <= rig.base + .001;
    for (const fill of left)
      assert(fill.polygons.every(p => p.every(point => onRam(point) || onConveyor(point))), `${kind} ×${scale}: ${JSON.stringify(fill.style)} left`);
    assert(left.length > (kind === 'blade' ? 6 : 10), `${kind} ×${scale}: ${left.length} left`);
  }
});

// The moldboard of a blade lies aslant across the way under the circle, as a grader works it, and the side of the vehicle
// shows its face, drawn as the eye sees it (machine-art.ts `moldboard`): its near end, at the rear, larger than its far one
// and lower, its top level and its cutting edge rising to its far end as the ground does going away from the eye. Its face is
// hollow under its lip at either end. The bottom of its cutting edge stands at the foot of the box at its near end, and the
// middle of its length, as the eye sees it, is where the blade works (road-tools.ts); its cutting edge is painted there.
test('the moldboard of a blade lies aslant, its near end larger and lower, its face hollow, the middle of its cutting edge where it works', () => {
  for (const scale of SCALES) {
    const { fills, width, height } = painted('blade', scale), name = `×${scale}`, W = MODULES.blade.width * scale, H = MODULES.blade.height * scale,
      { face, foot, k } = moldboard(machineRig('blade', W, H)), edges = fills.filter(fill => fill.style.stops?.[0] === '#5d6459');
    assert.equal(edges.length, 1, name);
    const [edge] = edges[0].polygons, drawn = p => [p.x * width / W, p.y * height / H];
    [face(0, 1), face(1, 1), foot(1), foot(0)].forEach((p, i) =>
      assert(Math.hypot(edge[i][0] - drawn(p)[0], edge[i][1] - drawn(p)[1]) < 1e-6, `${name}: its cutting edge at ${edge[i]}, not ${drawn(p)}`));
    const tall = u => foot(u).y - face(u, 0).y;
    assert(foot(0).x < foot(1).x && foot(0).y === H, `${name}: its near end at the rear, on the foot of the box`);
    assert(tall(1) < tall(0) * .9 && tall(1) > tall(0) * .6 && Math.abs(k(1) - tall(1) / tall(0)) < 1e-9, `${name}: ${tall(0)} m tall near, ${tall(1)} m far`);
    assert(foot(1).y < H - tall(0) * .1 && Math.abs(face(1, 0).y - face(0, 0).y) < 1e-9, `${name}: its foot rises to its far end, its top level`);
    const middle = foot(0).x + (foot(1).x - foot(0).x) * k(0) / (k(0) + k(1));
    assert(Math.abs(middle - TOOL_POINT.blade.x * W) < 1e-9 && Math.abs(foot(.5).x - middle) < 1e-9, `${name}: the middle of its length at ${middle}, the tool at ${TOOL_POINT.blade.x * W}`);
    for (const u of [0, 1]) {
      const [lip, hollow, toe] = [0, .42, 1].map(t => face(u, t).x);
      assert(hollow < lip && hollow < toe, `${name}: its face at ${u} at ${[lip, hollow, toe]}`);
    }
  }
});
