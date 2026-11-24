import test from 'node:test';
import assert from 'node:assert/strict';
import { paintComponent, metalColor, metalRgb } from '../src/component-art.ts';
import { cargoLook, cargoCanvasSize, cargoOutline, CARGO_LEVELS, heapOver, heapCanvasSize, paintHeap, loadArches, pileLook, pileSize, pileCanvasSize, paintPile } from '../src/cargo-art.ts';
import { fenderOver } from '../src/hull-details.ts';
import { shade } from '../src/machine-art.ts';
import { DEPOSIT_TONES } from '../src/deposit-art.ts';
import { MODULES, METALS } from '../src/materials.ts';
import { componentSizeLimits } from '../src/component-size.ts';
import { paintModuleCanvas } from '../src/textures.ts';
import { CASING } from '../src/work-arm.ts';
import { clamp } from '../src/math.ts';

const css = tone => '#' + tone.toString(16).padStart(6, '0');
const TAU = Math.PI * 2;
// Whether a style covers what is under it: a colour at least half opaque, or a gradient with such a stop.
const opaque = style => typeof style === 'string' ? style.length !== 9 || parseInt(style.slice(7), 16) >= 128 : style?.stops?.some(opaque);
const within = (subpaths, [x, y]) => {
  let inside = false;
  for (const points of subpaths) for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if (ay > y !== by > y && x < ax + (y - ay) / (by - ay) * (bx - ax)) inside = !inside;
  }
  return inside;
};
// A context that paints into a coarse grid of a picture `width` by `height` pixels, as a canvas would: it keeps the
// transform, the paths and the clips, marks every cell an opaque fill covers, and keeps what was filled (its colour and
// its points, in the painter's own measure and in pixels of the picture, `at`), the rectangles and the lettering, with
// the way each line of it reads (`turns`: -1 for one turned about).
function recording(width, height, columns = 120) {
  const rows = Math.round(columns * height / width), covered = new Uint8Array(columns * rows), fills = [], rects = [], texts = [], turns = [];
  let matrix = [1, 0, 0, 1, 0, 0], stack = [], clips = [], path = [], local = [], open = null;
  const apply = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  const add = (x, y) => { if (!open) { open = []; path.push(open); } open.push(apply(x, y)); local.push([x, y]); };
  const cover = (shape, style) => {
    if (!opaque(style)) return;
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      const cell = [(c + .5) * width / columns, (r + .5) * height / rows];
      if (!covered[r * columns + c] && within(shape, cell) && clips.every(clip => within(clip, cell))) covered[r * columns + c] = 1;
    }
  };
  const state = {
    canvas: { width, height },
    save() { stack.push([matrix, clips]); }, restore() { [matrix, clips] = stack.pop(); },
    scale(sx, sy) { matrix = [matrix[0] * sx, matrix[1] * sx, matrix[2] * sy, matrix[3] * sy, matrix[4], matrix[5]]; },
    translate(tx, ty) { matrix = [...matrix.slice(0, 4), matrix[0] * tx + matrix[2] * ty + matrix[4], matrix[1] * tx + matrix[3] * ty + matrix[5]]; },
    beginPath() { path = []; local = []; open = null; }, moveTo(x, y) { open = null; add(x, y); }, lineTo: add, closePath() { open = null; },
    rect(x, y, w, h) { open = null; add(x, y); add(x + w, y); add(x + w, y + h); add(x, y + h); open = null; },
    roundRect(x, y, w, h) { state.rect(x, y, w, h); },
    ellipse(x, y, rx, ry, turn, from, to) {
      const end = to < from ? to + TAU : to;
      for (let i = 0; i <= 24; i++) {
        const a = from + (end - from) * i / 24, ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
        add(x + ex * Math.cos(turn) - ey * Math.sin(turn), y + ex * Math.sin(turn) + ey * Math.cos(turn));
      }
    },
    arc(x, y, r, from, to) { state.ellipse(x, y, r, r, 0, from, to); },
    fill() { fills.push({ color: state.fillStyle, points: local.slice(), at: path.flat() }); cover(path, state.fillStyle); },
    fillRect(x, y, w, h) {
      rects.push({ color: state.fillStyle, x, y, w, h, at: [apply(x, y), apply(x + w, y + h)] });
      cover([[apply(x, y), apply(x + w, y), apply(x + w, y + h), apply(x, y + h)]], state.fillStyle);
    },
    clip() { clips = [...clips, path]; },
    fillText(text) { texts.push(text); turns.push(Math.sign(matrix[0])); },
    measureText: text => ({ width: text.length * 55 }),
    createLinearGradient() { const g = { stops: [], addColorStop: (at, color) => g.stops.push(color) }; return g; },
    createRadialGradient() { return state.createLinearGradient(); },
  };
  const ctx = new Proxy(state, { get: (object, key) => key in object ? object[key] : () => {}, set: (object, key, value) => { object[key] = value; return true; } });
  return { ctx, width, height, fills, rects, texts, turns, covered, columns, rows };
}
// A piece of the catalogue so many times its size, painted.
function painted(kind, scale = 1, options = {}, columns = 120) {
  const W = MODULES[kind].width * scale, H = MODULES[kind].height * scale, drawing = recording(...cargoCanvasSize(W, H), columns), before = structuredClone(options);
  paintComponent(drawing.ctx, kind, W, H, options);
  assert.deepEqual(options, before);
  return { W, H, ...drawing };
}
// Every colour a drawing filled with, a gradient by its stops.
const colours = drawing => [...drawing.fills, ...drawing.rects].flatMap(fill => typeof fill.color === 'string' ? [fill.color] : fill.color?.stops || []);
// What of a drawing is of the ore of a vein: the heap, filled with a gradient of its tones, and the stones over it.
const ORE = Object.values(DEPOSIT_TONES).flatMap(tone => [css(tone.heap), css(tone.shade), css(tone.light)]),
  ofOre = color => ORE.includes(color) || Boolean(color?.stops?.length) && color.stops.every(stop => ORE.includes(stop)),
  ore = drawing => drawing.fills.filter(fill => ofOre(fill.color)),
  pileOf = drawing => ore(drawing).find(fill => typeof fill.color !== 'string'),
  stonesOf = drawing => ore(drawing).filter(fill => typeof fill.color === 'string');
// The stones over a heap: how many to a square metre of it, and the widest of them, in metres.
const stoneCount = (drawing, pile) => {
  const stones = stonesOf(drawing), area = Math.abs(pile.points.reduce((sum, [x, y], i, all) => { const [nx, ny] = all[(i + 1) % all.length]; return sum + x * ny - nx * y; }, 0)) / 2;
  return { density: stones.length / 2 / area, widest: Math.max(...stones.map(({ points }) => Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)))) };
};
// Wheels of the truck's (a radius of .625 m) under a hopper of the catalogue, 1.6 m by .9 m: their tops .26 m over its foot.
const UNDER = [{ x: -.55, y: -.815, r: .625 }, { x: .55, y: -.815, r: .625 }];

test('a hydraulic tool base has its own casing without a reservoir label or fake carried load', () => {
  for (const kind of ['excavator', 'drill', 'builder']) for (const scale of [.5, 1]) {
    const drawing = painted(kind, scale), again = painted(kind, scale, { level: 4, material: 'silica' });
    assert(drawing.covered.some(Boolean));
    assert.equal(JSON.stringify(drawing.fills), JSON.stringify(again.fills), 'cargo does not change the hydraulic base');
    assert.deepEqual(drawing.rects, again.rects);
    assert.deepEqual(drawing.texts, []); assert.deepEqual(again.texts, []);
    assert.equal(cargoLook({ kind }).level, 0);
  }
});

test('the casing of a hydraulic tool base begins where the seat of its arm stands, at either end', () => {
  for (const kind of ['excavator', 'drill', 'builder']) for (const scale of [.5, 1]) {
    const drawing = painted(kind, scale), { columns, rows, covered } = drawing;
    // The seat stands .34 of the length of the piece out of its middle, towards either end.
    for (const at of [.16, .84]) {
      const column = Math.floor(at * columns), top = Array.from({ length: rows }, (_, row) => covered[row * columns + column]).indexOf(1);
      assert(Math.abs(top - CASING[kind] * rows) <= 1, `${kind} at ${at}: ${top} of ${rows}`);
    }
  }
});

test('a hopper and a cistern show their load in steps: how full they are and what most of it is', () => {
  const hopper = cargo => cargoLook({ kind: 'hopper', capacityM3: 1, cargo }), cistern = cargo => cargoLook({ kind: 'cistern', capacityM3: 1, cargo });
  assert.equal(CARGO_LEVELS, 4);
  assert.deepEqual([hopper(undefined), hopper({}), hopper({ ferro: 0 })], Array(3).fill({ level: 0, material: '' }));
  assert.deepEqual(hopper({ ferro: 600 }), { level: 1, material: 'ferro' }, 'a quarter of a cubic metre of iron ore');
  assert.deepEqual(hopper({ silica: 1 }), { level: 1, material: 'silica' }, 'any load at all shows');
  assert.deepEqual(hopper({ ferro: 1200 }), { level: 2, material: 'ferro' });
  assert.deepEqual(hopper({ ligas: 900, ferro: 480 }), { level: 3, material: 'ligas' }, 'the most of it by volume, not by weight');
  assert.deepEqual(hopper({ ferro: 1200, ligas: 600 }), { level: 4, material: 'ferro' }, 'near enough to full');
  assert.deepEqual(hopper({ ferro: 2400 }), { level: 4, material: 'ferro' });
  assert.deepEqual([cistern({ petroleo: 500 }), cistern({ petroleo: 1000 })], [{ level: 2, material: 'petroleo' }, { level: 4, material: 'petroleo' }]);
  assert.deepEqual(cargoLook({ kind: 'fuel', fuelLitres: 200 }), { level: 0, material: '' }, 'no other piece carries');
  assert.equal(cargoLook({ kind: 'engine' }), cargoLook({ kind: 'hopper', capacityM3: 1 }), 'and nothing is made for one that shows nothing');
});

test('a supply piece shows its crates of materials and its cans of fuel apart, each against the room they are loaded into', () => {
  // A quarter of the room is for fuel (component-volume.ts `FUEL_SHARE`), the rest for the materials.
  const supply = cargo => cargoLook({ kind: 'supply', capacityM3: 1, cargo });
  assert.equal(supply({}), cargoLook({ kind: 'engine' }));
  assert.deepEqual(supply({ ferro: 1800 }), { level: 4, material: 'ferro', fuel: 0 }, 'three quarters of a cubic metre of iron fill the crates');
  assert.deepEqual(supply({ petroleo: 250 }), { level: 0, material: '', fuel: 4 }, 'and a quarter of one of petroleo the cans');
  assert.deepEqual(supply({ ferro: 240, silica: 400, petroleo: 60 }), { level: 2, material: 'silica', fuel: 1 }, 'what most of the crates hold, not counting the fuel');
  assert.deepEqual(supply({ ligas: 1, petroleo: 1 }), { level: 1, material: 'ligas', fuel: 1 }, 'any of either shows');
});

test('a hopper, a cistern and a supply piece are painted over their whole box, at every size and load', () => {
  for (const kind of ['hopper', 'cistern', 'supply']) {
    const { max } = componentSizeLimits({ kind });
    for (const scale of [.25, 1, max]) for (const options of [{}, { cargoLevel: 4, cargoMaterial: 'ferro', cargoFuel: 4 },
      { cargoLevel: 2, cargoMaterial: 'ferro', cargoFuel: 2, paint: 0xc2b280, side: 'outside', arches: loadArches(MODULES[kind].width * scale, MODULES[kind].height * scale, UNDER) }]) {
      const { covered, columns, rows } = painted(kind, scale, options), empty = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) if (!covered[r * columns + c]) empty.push([(c + .5) / columns, (r + .5) / rows]);
      const name = `${kind} at ${scale}`;
      // Nothing is left out but the rounding of a corner: the heads of a cistern, small on a hopper or a cage.
      assert(empty.length <= covered.length * (kind === 'cistern' ? .02 : .002), `${name}: ${empty.length} of ${covered.length} cells bare`);
      assert(empty.every(([u, v]) => (u < .15 || u > .85) && (v < .35 || v > .6)), `${name}: bare away from the corners at ${empty.find(([u, v]) => !((u < .15 || u > .85) && (v < .35 || v > .6)))}`);
    }
  }
});

test('the outline of such a piece goes round its picture, never out over a corner of its box the picture leaves bare', () => {
  for (const kind of ['hopper', 'cistern', 'supply']) {
    const { max } = componentSizeLimits({ kind });
    for (const scale of [.25, 1, 1.6, max]) for (const options of [{}, { cargoLevel: 4, cargoMaterial: 'ferro', cargoFuel: 4, paint: 0xc2b280, side: 'outside' },
      { paint: 0xc2b280, side: 'outside', arches: loadArches(MODULES[kind].width * scale, MODULES[kind].height * scale, UNDER) }]) {
      // The outline as the renderer has it at a fine line, in pixels of the picture: up is up in it, down in the picture.
      // The drawing here cuts an arc in 24 sides: a cell within a millimetre of the outline may fall between the two.
      const { W, H, width, height, covered, columns, rows } = painted(kind, scale, options, 240),
        outline = [cargoOutline(kind, W, H, .002).map(({ x, y }) => [(x / W + .5) * width, (.5 - y / H) * height])],
        near = ([x, y]) => outline[0].some(([ax, ay], i) => {
          const [bx, by] = outline[0][(i + 1) % outline[0].length], dx = bx - ax, dy = by - ay,
            t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
          return Math.hypot(ax + t * dx - x, ay + t * dy - y) * W / width < .001;
        }),
        name = `${kind} at ${scale}${options.arches ? ' over its wheels' : ''}`;
      let bare = 0, beyond = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
        const cell = [(c + .5) * width / columns, (r + .5) * height / rows], inside = within(outline, cell);
        if (inside && !covered[r * columns + c] && !near(cell)) bare++;
        if (!inside && covered[r * columns + c]) beyond++;
      }
      assert.equal(bare, 0, `${name}: the outline goes over ${bare} bare cells`);
      // And it is the edge of the picture, not within it: what is painted past it is the odd bolt, or the well of a fender
      // reaching up over the whole of a small piece.
      if (!options.arches) assert(beyond <= covered.length * .001, `${name}: ${beyond} painted cells past the outline`);
    }
  }
  // The box of a cistern is not its outline: over the upper corners of the box the heads leave bare.
  const { width: W, height: H } = MODULES.cistern, outline = [cargoOutline('cistern', W, H, .002).map(({ x, y }) => [x, y])];
  for (const side of [-1, 1]) assert(!within(outline, [side * (W / 2 - .01), H / 2 - .01]), `the corner at ${side}`);
  assert(within(outline, [0, H / 2 - .01]) && within(outline, [0, -H / 2 + .01]));
});

test('the picture of such a piece has its proportions, and a piece smaller than the catalogue one is a model of it', () => {
  for (const kind of ['hopper', 'cistern', 'supply']) for (const scale of [.25, 1, 2]) {
    const W = MODULES[kind].width * scale, H = MODULES[kind].height * scale, [width, height] = cargoCanvasSize(W, H);
    assert(Math.abs(width / height - W / H) < .01 * W / H && width <= 1024 && width >= 192, `${kind} at ${scale}: ${width}×${height}`);
  }
  // A crate and a can are of their real size: a cage twice as long holds more of them; one half as long, as many smaller.
  const counts = scale => { const { texts, fills } = painted('supply', scale, { cargoLevel: 4, cargoMaterial: 'ligas', cargoFuel: 4 });
    return [texts.filter(text => text === 'LIGAS').length, fills.filter(fill => fill.color === '#4b5739').length]; };
  const [crates, cans] = counts(1);
  assert(crates >= 3 && cans >= 2, `${crates} crates, ${cans} cans`);
  assert.deepEqual(counts(.5), [crates, cans]);
  const [moreCrates, moreCans] = counts(2);
  assert(moreCrates > crates * 2 && moreCans > cans * 2, `${moreCrates} crates, ${moreCans} cans`);
});

test('the heap in a hopper cut open is in the tones of its ore and rises a step at a time, over the rim on the last, as soft as over it', () => {
  const heap = (level, material, scale = 1) => painted('hopper', scale, { cargoLevel: level, cargoMaterial: material });
  assert.deepEqual(ore(heap(0, '')), [], 'an empty bin has nothing of the ore in it'); assert.deepEqual(ore(painted('hopper')), []);
  let above = Infinity;
  for (let level = 1; level <= CARGO_LEVELS; level++) {
    const drawing = heap(level, 'ferro'), pile = pileOf(drawing), top = Math.min(...pile.points.map(([, y]) => y)), over = heapOver(drawing.W, drawing.H, level);
    // Lit at its top, going down to the tone of the ore: the same light and the same few small stones as the heap over the rim.
    assert.deepEqual(pile.color.stops, [css(DEPOSIT_TONES.ferro.light), css(DEPOSIT_TONES.ferro.heap)]);
    const { density, widest } = stoneCount(drawing, pile);
    assert(density < 45 && widest < .05, `step ${level}: ${density.toFixed(0)} stones to the square metre, the widest ${widest.toFixed(3)} m`);
    assert(top < above - .1, `step ${level} tops at ${top.toFixed(3)} m`); above = top;
    // Its crest is the crest of the heap over the rim (heapOver), where there is one, as high.
    assert.equal(top < 0, Boolean(over), `step ${level} over the rim`);
    if (over) assert(Math.abs(top + over.height) < .005, `step ${level}: ${top.toFixed(3)} m, ${over.height.toFixed(3)} m over the rim`);
    assert(pile.points.every(([x, y]) => x > .3 && x < drawing.W - .3 && y < drawing.H - .05), 'within the cut, between the stiffeners and over the floor');
  }
  for (const material of ['ferro', 'ligas', 'silica']) assert.equal(pileOf(heap(2, material)).color.stops[1], css(DEPOSIT_TONES[material].heap), material);
  assert.equal(new Set(['ferro', 'ligas', 'silica'].map(material => pileOf(heap(2, material)).color.stops[1])).size, 3, 'each ore is told from the others');
  // A bigger hopper holds its heap about as high, in proportion, at the same step.
  const big = heap(2, 'ferro', 2), pile = pileOf(big), small = pileOf(heap(2, 'ferro'));
  assert(Math.abs(Math.min(...pile.points.map(([, y]) => y)) / big.H - Math.min(...small.points.map(([, y]) => y)) / (big.H / 2)) < .05);
});

test('the cut in a cistern shows the petroleum as high as it stands in a round tank so full', () => {
  const oil = css(DEPOSIT_TONES.petroleo.light), level = step => painted('cistern', 1, { cargoLevel: step }).rects.filter(rect => rect.color === oil);
  assert.deepEqual(level(0), []);
  // The cut and the sight glass beside it: the same height in both, standing on the inside of the shell's foot.
  const heights = [1, 2, 3, 4].map(step => {
    const [cut, glass, ...rest] = level(step);
    assert.deepEqual(rest, []); assert(Math.abs(cut.y - glass.y) < 1e-9, 'the glass tells what the cut shows');
    return [cut.y + cut.h, cut.h];
  });
  assert(heights.every(([foot]) => Math.abs(foot - heights[0][0]) < 1e-9), 'from the same foot');
  const depth = heights[3][1];
  assert(heights.every(([, h], i) => !i || h > heights[i - 1][1]), 'each step higher');
  // A lying round tank fills fast at its middle and slowly at its foot and its top: so many tenths of it stand as
  // high as a circle's segment of that share of its area. The last step leaves a tenth of it for the petroleum to swell.
  const segment = share => { let low = 0, high = 1; for (let i = 0; i < 40; i++) { const h = (low + high) / 2, half = Math.acos(1 - 2 * h);
    if ((2 * half - Math.sin(2 * half)) / TAU < share) low = h; else high = h; } return low; };
  for (const [i, [, h]] of heights.entries()) assert(Math.abs(h / depth - segment(.9 * (i + 1) / 4) / segment(.9)) < .01, `step ${i + 1} at ${h / depth} of the full`);
  assert(depth > .6 && depth < .75, `full at ${depth} m of a cistern .9 m tall`);
});

test('a supply piece keeps its crates and cans from the floor up, stencilled with what they hold', () => {
  const at = (level, fuel, material = 'ferro') => {
    const { texts, fills } = painted('supply', 1, { cargoLevel: level, cargoMaterial: material, cargoFuel: fuel });
    return { crates: texts.filter(text => ['FERRO', 'LIGAS', 'SÍLICA'].includes(text)), cans: fills.filter(fill => fill.color === '#4b5739').length, texts };
  };
  assert.deepEqual([at(0, 0).crates, at(0, 0).cans], [[], 0], 'an empty cage');
  const crates = [0, 1, 2, 3, 4].map(level => at(level, 0).crates.length), cans = [0, 1, 2, 3, 4].map(fuel => at(0, fuel).cans);
  assert(crates.every((n, i) => !i || n >= crates[i - 1]) && crates[1] >= 1 && crates[4] > crates[2], `crates ${crates}`);
  assert(cans.every((n, i) => !i || n >= cans[i - 1]) && cans[1] >= 1 && cans[4] > cans[1], `cans ${cans}`);
  assert.deepEqual(new Set(at(3, 0, 'silica').crates), new Set(['SÍLICA']));
  assert(at(4, 4).texts.includes('SUPRIMENTOS') && at(4, 4).texts.every(text => /^[A-ZÁÉÍÓÚÇÃÕÂÊÔ0-9 ]+$/.test(text)), 'its lettering is in Portuguese capitals');
});

test('a heap of the field is a pile of crates of its materials on a pallet, a crate more for each doubling, and cans for its fuel', () => {
  const stock = (ferro = 0, ligas = 0, silica = 0, combustivel = 0) => ({ ferro, ligas, silica, combustivel });
  assert.deepEqual(pileLook(stock()), { crates: [], cans: 0 });
  assert.deepEqual(pileLook(stock(500)), { crates: ['ferro'], cans: 0 }, 'any material at all is a crate');
  assert.deepEqual(pileLook(stock(4216)), { crates: ['ferro', 'ferro', 'ferro'], cans: 0 }, 'a light post given up');
  assert.deepEqual(pileLook(stock(46784, 3000, 900)), { crates: ['ferro', 'ferro', 'ferro', 'ferro', 'ligas', 'silica'], cans: 0 },
    'six at most, the most of it lowest, and one for each material while there are crates enough');
  assert.deepEqual(pileLook(stock(1e6, 1e6, 1e6, 1e6)).crates.length, 6); assert.equal(pileLook(stock(0, 0, 0, 1e6)).cans, 4);
  assert.deepEqual(pileLook(stock(.4, 0, 0, 900)), { crates: [], cans: 2 }, 'less than a unit is nothing');
  const sizes = [stock(500), stock(4216), stock(46784)].map(one => pileSize(pileLook(one)));
  assert(sizes[0].width < sizes[1].width && sizes[1].width === sizes[2].width && sizes[1].height < sizes[2].height, 'it grows along the pallet, then up');
  for (const one of [stock(500, 0, 0, 40), stock(46784, 3000, 900, 5000), stock(0, 0, 0, 300)]) {
    const look = pileLook(one), [width, height] = pileCanvasSize(look), size = pileSize(look), drawing = recording(width, height, 60);
    paintPile(drawing.ctx, look);
    assert(Math.abs(width / height - size.width / size.height) < .02, 'the picture has the proportions of the pile');
    assert.deepEqual(drawing.texts.filter(text => text !== 'MATERIAIS'), look.crates.map(id => ({ ferro: 'FERRO', ligas: 'LIGAS', silica: 'SÍLICA' })[id]),
      'each crate is stencilled with what it holds');
    assert.equal(drawing.fills.filter(fill => fill.color === '#4b5739').length, look.cans, 'and each can stands with its spout');
    // By the foot of the picture the deck of the pallet runs from end to end.
    const across = row => Array.from({ length: drawing.columns }, (_, c) => drawing.covered[row * drawing.columns + c]).filter(Boolean).length / drawing.columns,
      low = Array.from({ length: drawing.rows - Math.floor(drawing.rows * .8) }, (_, i) => across(Math.floor(drawing.rows * .8) + i));
    assert(Math.max(...low) > .9, `the deck covers ${Math.max(...low)}`);
  }
});

test('a piece of aluminium or titanium is drawn in the tone of its metal: the olive of the steel turns, the rubber, the load and the brass do not', () => {
  const { aluminum, titanium } = METALS, hue = tone => { const [r, g, b] = [tone >> 16 & 255, tone >> 8 & 255, tone & 255];
      return b > r && b > g; }, light = tone => (tone >> 16 & 255) + (tone >> 8 & 255) + (tone & 255);
  assert.equal(METALS.steel.look, null);
  for (const olive of [0x68776b, 0x546a68, 0x667457, 0x8a977c]) {
    // Steel stays as it is painted; the other two go blue and violet greys, aluminium the lighter of them.
    assert.equal(metalColor(olive, null), olive);
    const al = metalColor(olive, aluminum.look), ti = metalColor(olive, titanium.look);
    assert(hue(al) && hue(ti) && light(al) > light(olive) && light(al) > light(ti), css(olive));
  }
  // What has a colour of its own keeps it: brass, the ore of every vein, a dark grey of rubber within a step.
  for (const own of [0xd1c18e, ...Object.values(DEPOSIT_TONES).flatMap(tone => [tone.plate, tone.heap]).filter(tone => tone !== 0x1f1e20 && tone !== 0x3f4442)])
    for (const metal of [aluminum, titanium]) assert.equal(metalColor(own, metal.look), own, css(own));
  for (const rubber of [0x0b110e, 0x1d2620]) assert(Math.abs(light(metalColor(rubber, aluminum.look)) - light(rubber)) < 40, css(rubber));
  assert.deepEqual(metalRgb(0, 0, 0, aluminum.look), [0, 0, 0]);
  // The heap of a hopper is painted in the tones of its ore alone, so that none of it turns with the metal.
  const tones = Object.values(DEPOSIT_TONES).flatMap(tone => [tone.heap, tone.shade, tone.light]);
  for (const material of ['ferro', 'ligas', 'silica'])
    for (const tone of [DEPOSIT_TONES[material].heap, DEPOSIT_TONES[material].shade, DEPOSIT_TONES[material].light])
      for (const metal of [aluminum, titanium]) assert.equal(metalColor(tone, metal.look), tone, `${material} ${css(tone)}`);
  const { fills } = painted('hopper', 1, { cargoLevel: 3, cargoMaterial: 'ligas' }), lumps = fills.filter(fill => typeof fill.color === 'string' && tones.some(tone => fill.color.startsWith(css(tone))));
  assert(lumps.length > 10 && lumps.every(fill => fill.color.length === 7), 'every lump of it whole, none of it blended');
  // The heap goes from the light of its ore to its tone, whole at either end and of their hue between: no blend of the two turns.
  const hex = color => parseInt(color.slice(1), 16), blend = (a, b, t) => [16, 8, 0].reduce((sum, shift) => sum | Math.round((a >> shift & 255) * (1 - t) + (b >> shift & 255) * t) << shift, 0);
  for (const material of ['ferro', 'ligas', 'silica']) {
    const [lit, deep] = pileOf(painted('hopper', 1, { cargoLevel: 3, cargoMaterial: material })).color.stops.map(hex);
    for (let i = 0; i <= 50; i++) for (const metal of [aluminum, titanium]) assert.equal(metalColor(blend(lit, deep, i / 50), metal.look), blend(lit, deep, i / 50), `${material} at ${i / 50}`);
  }
});

test('seen from outside a hopper and a cistern are whole: their load shows through a cut only when they are seen cut open', () => {
  // The far wall of a hopper's bin and of a cistern's tank, in the shade behind the cut.
  const far = ['#1b2621', '#1d2722'];
  for (const kind of ['hopper', 'cistern']) for (const level of [0, 2, 4]) {
    const load = { cargoLevel: level, cargoMaterial: kind === 'hopper' ? 'ferro' : 'petroleo' }, what = `${kind} at step ${level}`;
    assert(colours(painted(kind, 1, load)).some(colour => far.includes(colour)), `${what}: cut open`);
    for (const paint of [undefined, 0xc2b280]) assert(!colours(painted(kind, 1, { ...load, paint, side: 'outside' })).some(colour => far.includes(colour)), `${what}: whole`);
  }
  // From outside the ore of a hopper shows only over its rim (heapOver); the sight glass of a cistern tells its load either way.
  assert.deepEqual(ore(painted('hopper', 1, { cargoLevel: 4, cargoMaterial: 'ferro', side: 'outside' })), []);
  const oil = options => painted('cistern', 1, options).rects.filter(rect => rect.color === css(DEPOSIT_TONES.petroleo.light)).map(rect => rect.y),
    [cut, glass] = oil({ cargoLevel: 3 });
  assert(Math.abs(cut - glass) < 1e-9); assert.deepEqual(oil({ cargoLevel: 3, side: 'outside' }), [glass]);
});

test('the closed supply side hides its crates and fuel and stays the same while unloading', () => {
  const load = { cargoLevel: 4, cargoMaterial: 'ligas', cargoFuel: 4 },
    opened = painted('supply', 1, { ...load, side: 'inside' }),
    closed = painted('supply', 1, { ...load, side: 'outside' }), empty = painted('supply', 1, { side: 'outside' });
  assert(opened.texts.includes('LIGAS'));
  assert.deepEqual(closed.texts, ['SUPRIMENTOS']);
  assert.equal(JSON.stringify([closed.rects, closed.fills]), JSON.stringify([empty.rects, empty.fills]));
  assert(closed.covered.every(Boolean), 'the closed lateral panel covers the existing component box');
  const module = { kind: 'supply', capacityM3: 1, cargo: { ligas: 1200, petroleo: 250 } };
  assert.deepEqual(cargoLook(module, 'outside'), cargoLook({ ...module, cargo: {} }, 'outside'));
  assert.equal(cargoLook(module, 'inside').level, 4);
});

test('a body out in the open is in the paint of its construction, a piece within a compartment in the olive of the machinery', t => {
  const olive = '#67756a', tones = hex => [shade(hex, .15), shade(hex, -.5)];
  for (const kind of ['hopper', 'cistern', 'supply']) for (const side of ['inside', 'outside']) {
    const load = { cargoLevel: 2, cargoMaterial: 'ferro', cargoFuel: 2, side }, sand = colours(painted(kind, 1, { ...load, paint: 0xc2b280 })),
      grey = colours(painted(kind, 1, { ...load, paint: 0x5a6876 })), within = colours(painted(kind, 1, load));
    for (const [what, own, others] of [['sand', sand, [grey, within]], ['grey', grey, [sand, within]], ['olive', within, [sand, grey]]]) {
      const hex = { sand: '#c2b280', grey: '#5a6876', olive }[what];
      assert(tones(hex).every(tone => own.includes(tone)), `${kind} ${side} in ${what}`);
      for (const other of others) assert(!tones(hex).some(tone => other.includes(tone)), `${kind} ${side}: no ${what} on another`);
    }
  }
  // The paint covers the metal it is made of: the tone of titanium is laid over a piece within (paintMetal reads the
  // picture back to turn it), and not over one in paint. A canvas that keeps no paint stands in for the browser's.
  let read = 0;
  class Canvas {
    width = 1; height = 1;
    getContext() {
      return this.context ??= new Proxy({ canvas: this, measureText: () => ({ width: 0 }), getImageData: (x, y, w, h) => { read++; return { data: new Uint8ClampedArray(w * h * 4) }; },
        createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) }, { get: (target, key) => key in target ? target[key] : () => {} });
    }
  }
  const old = ['document', 'HTMLCanvasElement'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'HTMLCanvasElement', { value: Canvas, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: () => new Canvas() } });
  t.after(() => { for (const [name, descriptor] of old) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  for (const kind of ['hopper', 'cistern', 'supply']) for (const paint of [undefined, 0xc2b280]) {
    read = 0;
    paintModuleCanvas(kind, MODULES[kind].width, MODULES[kind].height, { metal: 'titanium', paint, side: 'outside' });
    assert.equal(read > 0, paint === undefined, `${kind} ${paint === undefined ? 'within' : 'in paint'}`);
  }
});

test('cargo has one canonical picture with its tailgate and load panel at the left and upright lettering', () => {
    const hopper = painted('hopper', 1), gate = hopper.rects.find(rect => Math.abs(rect.h - hopper.H) < 1e-9 && Math.abs(rect.w - .045) < 1e-9),
      cistern = painted('cistern', 1, { cargoLevel: 2 }), panel = cistern.fills.find(fill => fill.color === '#d9822b'),
      middle = (points, width) => points.reduce((sum, [x]) => sum + x, 0) / points.length / width;
    assert(middle(gate.at, hopper.width) < .5);
    assert(middle(panel.at, cistern.width) < .5);
    for (const drawing of [cistern, painted('supply', 1, { cargoLevel: 4, cargoMaterial: 'ligas' })])
      assert(drawing.turns.length > 2 && drawing.turns.every(turn => turn > 0), 'its lettering is not turned about');
});

test('the heap of a hopper shows over its rim on the last step of its load, wide and low over its bin, smooth and soft', () => {
  const { width: W, height: H } = MODULES.hopper;
  assert.deepEqual([0, 1, 2, 3].map(level => heapOver(W, H, level)), [null, null, null, null], 'the lower steps stay within the rim');
  const full = heapOver(W, H, 4);
  assert(full.height > .05 && full.height < .12, `${full.height} m over the rim`);
  // Over the bin, between the tailgate and the front post; higher on a bigger hopper.
  assert(full.x0 > .05 && full.x1 < W - .05 && full.x1 - full.x0 > W * .8);
  assert(heapOver(2 * W, 2 * H, 4).height > 1.5 * full.height);
  // Painted as the heap in the bin is, its crest at the top of its picture and its foot at the rim, as fine as its hopper:
  // over the rim along most of the bin (the more of it, the longer the bin), its crown low over it; its outline no steeper
  // than broken ore lies and turning a little at a time, with no corner; lit along its crown and going down to the tone
  // of its ore, with a few small stones.
  for (const [w, h, most] of [[W, H, .78], [2.4, 1.35, .85]]) for (const material of ['ferro', 'silica']) {
    const over = heapOver(w, h, 4), size = heapCanvasSize(over), drawing = recording(...size), what = `${w} m ${material}`;
    paintHeap(drawing.ctx, over, material);
    const pile = pileOf(drawing), long = over.x1 - over.x0, crest = pile.points.slice(1, -1), lifted = crest.filter(([, y]) => y < over.height - 1e-6),
      slopes = crest.slice(1).map(([x, y], i) => (y - crest[i][1]) / (x - crest[i][0]));
    assert.deepEqual(pile.color.stops, [css(DEPOSIT_TONES[material].light), css(DEPOSIT_TONES[material].heap)], what);
    assert(Math.abs(Math.min(...pile.points.map(([, y]) => y))) < .01 && Math.max(...pile.points.map(([, y]) => y)) >= over.height - 1e-9, what);
    assert(pile.points.every(([x]) => x >= -1e-9 && x <= long + 1e-9), what);
    assert((lifted.at(-1)[0] - lifted[0][0]) / long > most && over.height < .07 * long, `${what}: over ${((lifted.at(-1)[0] - lifted[0][0]) / long).toFixed(2)} of the bin, ${over.height.toFixed(3)} m high`);
    assert(slopes.every(slope => Math.abs(slope) < Math.tan(39 * Math.PI / 180)) && slopes.slice(1).every((slope, i) => Math.abs(slope - slopes[i]) < .12), what);
    // A strip so thin is told by the stones along it.
    const stones = stonesOf(drawing), { widest } = stoneCount(drawing, pile);
    assert(stones.every(stone => [DEPOSIT_TONES[material].heap, DEPOSIT_TONES[material].light].map(css).includes(stone.color)), what);
    assert(stones.length / 2 < 4 * long && widest < .05, `${what}: ${stones.length / 2} stones along ${long.toFixed(2)} m, the widest ${widest.toFixed(3)} m`);
    assert(Math.abs(size[0] / long - cargoCanvasSize(w, h)[0] / w) < 2, what);
  }
});

test('a body out in the open has an arch cut into its foot round the axles of each group of wheels the well behind its fender reaches the foot of', () => {
  const { width: W, height: H } = MODULES.hopper, wheel = (x, top, r = .3) => ({ x, y: top - r, r });
  // Two wheels under it, their tops into its foot, so close that one fender is over the two; one further along the same
  // row, past its end, whose well does not reach it; one under it, its top a hand short of its foot, in a row of its own.
  const arches = loadArches(W, H, [wheel(-.45, -.35), wheel(.45, -.35), wheel(2.1, -.35), wheel(0, -H / 2 - .5)]);
  assert.deepEqual(arches, [{ x: 0, y: -.65, r: .3, half: .45 }]);
  // One beside it, alone, whose well reaches the corner of its foot.
  assert.deepEqual(loadArches(W, H, [wheel(1.05, -.35)]), [{ x: 1.05, y: -.65, r: .3, half: 0 }]);
  // Each a well round the axles under its fender, as square as the fender and straight down at its sides, all but black
  // up under the fender and a little lighter down towards the axles, as far out from the end axles as the fender's gap
  // and a little of its band, the whole box painted all the same (above): one over two wheels close together, or one
  // over each.
  const steel = tone => shade('#c2b280', tone);
  for (const kind of ['hopper', 'cistern', 'supply']) for (const under of [loadArches(MODULES[kind].width, MODULES[kind].height, UNDER), UNDER.map(axle => ({ ...axle, half: 0 }))]) {
    const drawing = painted(kind, 1, { paint: 0xc2b280, side: 'outside', arches: under }),
      wells = drawing.fills.filter(fill => fill.color?.stops?.join() === [steel(-.86), steel(-.72), steel(-.66)].join() && fill.points.length > 20);
    assert.equal(wells.length, under.length, kind);
    for (const [i, well] of wells.entries()) {
      const xs = well.points.map(([px]) => px), ys = well.points.map(([, py]) => py), x = (Math.min(...xs) + Math.max(...xs)) / 2,
        y = (Math.min(...ys) + Math.max(...ys)) / 2, reach = (Math.max(...xs) - Math.min(...xs)) / 2, { inner, band } = fenderOver(under[i].r);
      assert(Math.abs(x - (drawing.W / 2 + under[i].x)) < .01 && Math.abs(y - (drawing.H / 2 - under[i].y)) < .01
        && Math.abs(reach - (under[i].half + inner + .4 * band)) < .01, `${kind}: ${x} ${y} ${reach}`);
    }
  }
});

// How far a piece's picture reaches in its box of 400 by 260, from all it fills where it is moved to, and the words
// written on it.
function reach(kind, options = {}) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, words = [], gradient = () => ({ addColorStop() {} });
  let points = [], at = [0, 0];
  const kept = [], take = (x, y) => points.push([x + at[0], y + at[1]]),
    state = { canvas: { width: 400, height: 260 }, createLinearGradient: gradient, createRadialGradient: gradient,
      measureText: text => ({ width: text.length * 8 }), fillText: text => words.push(text),
      save() { kept.push(at); }, restore() { at = kept.pop(); }, translate(x, y) { at = [at[0] + x, at[1] + y]; },
      beginPath() { points = []; }, moveTo: take, lineTo: take, roundRect(x, y, w, h) { take(x, y); take(x + w, y + h); },
      fill() { for (const [x, y] of points) Object.assign(box, { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) }); },
      fillRect(x, y, w, h) { points = []; take(x, y); take(x + w, y + h); state.fill(); } },
    ctx = new Proxy(state, { get: (object, key) => key in object ? object[key] : () => {}, set: (object, key, value) => { object[key] = value; return true; } });
  paintComponent(ctx, kind, MODULES[kind].width, MODULES[kind].height, options);
  return { ...box, words };
}

test('the fuel tank keeps its fittings within its physical box and its four fasteners round at every admitted scale', () => {
  const bounds = points => ({ x0: Math.min(...points.map(p => p[0])), x1: Math.max(...points.map(p => p[0])),
    y0: Math.min(...points.map(p => p[1])), y1: Math.max(...points.map(p => p[1])) });
  // The actual fuel canvas and admitted scales: four equal round fasteners, all fittings inside the installed box.
  for (const scale of [.25, 1, componentSizeLimits({ kind: 'fuel' }).max]) {
    const widthM = MODULES.fuel.width * scale, heightM = MODULES.fuel.height * scale,
      height = Math.max(128, Math.min(1024, Math.round(400 * heightM / widthM))), drawing = recording(400, height, 24);
    paintComponent(drawing.ctx, 'fuel', widthM, heightM);
    const box = bounds([...drawing.fills, ...drawing.rects].flatMap(fill => fill.at));
    assert(box.x0 > 0 && box.x1 < 400 && box.y0 >= 0 && box.y1 <= height + 1e-9, `${scale}: inside its installed box`);
    assert(Math.abs(box.y1 - height) < 1e-9, `${scale}: the seated foot reaches its support without being clipped`);
    const bolts = drawing.fills.filter(fill => fill.color === '#14221dd9');
    assert.equal(bolts.length, 4);
    for (const bolt of bolts) {
      const b = bounds(bolt.at), across = (b.x1 - b.x0) / 400 * widthM, up = (b.y1 - b.y0) / height * heightM;
      assert(Math.abs(across - up) < 1e-9, `${scale}: the four equal fasteners remain round in metres`);
    }
    assert.deepEqual(drawing.texts, []);
  }
});

test('what is written on a piece is written in Portuguese', () => {
  assert.deepEqual(reach('fuel').words, []);
  const written = [...['command', 'engine', 'ammo', 'supply'].map(kind => reach(kind)), ...['visual', 'radar', 'sound'].map(sensorMode => reach('sensor', { sensorMode }))]
    .flatMap(art => art.words);
  assert.deepEqual(written, ['FILTRO DE AR', 'MUNIÇÃO', 'SUPRIMENTOS', 'ESCUTA']);
});
