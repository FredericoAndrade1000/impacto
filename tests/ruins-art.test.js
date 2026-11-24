import test from 'node:test';
import assert from 'node:assert/strict';
import { Container } from 'pixi.js';
import { Terrain } from '../src/terrain.ts';
import { depositsOf } from '../src/deposits.ts';
import { drawGroundSurface, drawGroundDetail } from '../src/terrain-art.ts';
import { buildSoilGrain } from '../src/strata-art.ts';
import { TerrainScene, FLORA_ZOOM, DETAIL_ZOOM } from '../src/terrain-scene.ts';
import { drawSite, ORE_TONES } from '../src/deposit-art.ts';
import { SLAB, RUIN_SINK, RUIN_TONES, ruinPlan, rubbleAt, drawRuins, drawSlab, lineAt, inSlab } from '../src/ruins-art.ts';
import { GraphicsRecorder } from './scenery-canvas.js';
import { mineralTexture } from '../src/textures.ts';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();

test('a shared masonry material keeps every ruin outline and opening and repeats without a visible edge', () => {
  const shades = Float32Array.from({ length: 512 * 512 }, (_, i) => 1 + Math.sin(i * .017) * .06), texture = mineralTexture(shades);
  try {
    const terrain = new Terrain('rural-ridges', { seed: 6173, length: 4000 }), plain = new GraphicsRecorder(), painted = new GraphicsRecorder();
    drawRuins(terrain, plain); drawRuins(terrain, painted, false, texture);
    assert.deepEqual(painted.calls.filter(call => call[0] !== 'fill'), plain.calls.filter(call => call[0] !== 'fill'));
    assert(painted.fills().some(fill => fill.style.texture === texture));
    const data = texture.source.resource;
    for (let y = 0; y < 256; y++) assert.deepEqual(data.slice(y * 256 * 4, y * 256 * 4 + 4), data.slice((y * 256 + 255) * 4, (y * 256 + 256) * 4));
    for (let x = 0; x < 256; x++) assert.deepEqual(data.slice(x * 4, x * 4 + 4), data.slice((255 * 256 + x) * 4, (255 * 256 + x) * 4 + 4));
    assert.equal(texture.source.autoGenerateMipmaps, true);
    assert.equal(texture.source.style.addressMode, 'repeat');
  } finally { texture.destroy(true); }
});

// The world of the shared field, some of whose ruins are sites with a vein in them and some without; and banks of
// ruins whose ground has its corners one, two and four metres apart.
const field = new Terrain('world', { seed: 6173, length: 512000, center: 12 }),
  ridges = [new Terrain('rural-ridges', { seed: 6173, length: 2000 }), new Terrain('rural-ridges', { seed: 42, length: 8000 }), new Terrain('rural-ridges', { seed: 7, length: 16000 })],
  grounds = [field, ...ridges];
// The tones of concrete, which in a landscape is only ever the slab of a ruin (terrain-art.ts).
const CONCRETE = new Set([0xadb1a8, 0x858a82, 0x62675f, 0xbebdaf, 0xcfcec2]);

const pairs = points => points.flatMap((v, i) => i % 2 ? [] : [[v, points[i + 1]]]);
const toneOf = style => style?.color ?? style;
const ruinsOf = terrain => terrain.features.filter(f => f.kind === 'ruins');
// The corners of a filled outline and the middle of each of its sides.
const edge = fill => pairs(fill.points).flatMap((p, i, all) => { const q = all[(i + 1) % all.length]; return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]]; });
// A ground with one of its ruins on it and no other.
const alone = (terrain, f) => Object.create(terrain, { features: { value: [f] } });
// Places along a stretch of ground: every corner of its outline, and every ten centimetres between.
const along = (terrain, a, b) => {
  const { points } = terrain, xs = [b];
  let i = 0, step = 1 << 20;
  for (; step; step >>= 1) if (i + step < points.length && points[i + step].x <= a) i += step;
  for (i++; i < points.length && points[i].x < b; i++) xs.push(points[i].x);
  for (let x = a; x < b; x += .1) xs.push(x);
  return xs;
};
// What a drawing marks, each as the tone it is filled or stroked in and the places its path goes through.
const marks = g => {
  const out = []; let points = [];
  for (const [name, ...args] of g.calls) {
    if (name === 'poly') points.push(...pairs(args[0]));
    else if (name === 'moveTo' || name === 'lineTo') points.push([args[0], args[1]]);
    else if (name === 'quadraticCurveTo') points.push([args[0], args[1]], [args[2], args[3]]);
    else if (name === 'fill' || name === 'stroke') { out.push({ tone: toneOf(args[0]), points }); points = []; }
  }
  return out;
};
// The drawing of one ruin as its pieces: the face of each wall and the marks on it; the mass of each heap, the marks
// on it and the blocks and slabs lying in it; and, the last of what lies in the last heap, the pieces lying about.
function pieces(g) {
  const walls = [], heaps = [];
  for (const fill of g.fills()) {
    if (fill.style === RUIN_TONES.render) walls.push({ face: fill, marks: [] });
    else if (fill.style === RUIN_TONES.rubble) heaps.push({ mass: fill, marks: [], lying: [] });
    else if (heaps.length && typeof fill.style === 'number') heaps.at(-1).lying.push(fill);
    else (heaps.at(-1) ?? walls.at(-1)).marks.push(fill);
  }
  return { walls, heaps, loose: heaps.at(-1).lying.slice(-9) };
}

test('every ruin stands on its slab: its walls and heaps reach under the ground all along them and stand over it, whatever its slope', () => {
  let ruins = 0, sloped = 0;
  for (const terrain of grounds) for (const f of ruinsOf(terrain)) {
    const plan = ruinPlan(terrain, f), { slab } = plan, g = new GraphicsRecorder(), at = x => terrain.height(x), where = `ruin at ${f.peak.toFixed(1)}`;
    assert(slab.start < f.peak && f.peak < slab.end, where);
    drawRuins(alone(terrain, f), g);
    const drawn = pieces(g), low = Math.min(...along(terrain, slab.start, slab.end).map(at));
    assert.equal(drawn.walls.length, plan.walls.length); assert.equal(drawn.heaps.length, 3); assert(plan.walls.length >= 1);
    for (const [i, wall] of plan.walls.entries()) {
      const { face, marks: on } = drawn.walls[i], under = along(terrain, wall.west, wall.east), heights = under.map(at);
      assert(wall.west >= slab.start + 1 && wall.east <= slab.end - 1, `${where}: a wall stands clear of the broken ends of its slab`);
      for (let k = 1; k < wall.line.length; k++) assert(wall.line[k][0] > wall.line[k - 1][0], `${where}: its break runs from west to east`);
      if (Math.max(...heights) - Math.min(...heights) > .1) sloped++;
      // Its foot is under the ground at every point, as deep as it needs to be under the lowest of it and no deeper:
      // the earth before it hides it, and it stands on the ground line.
      assert(Math.abs(wall.foot - Math.min(...heights) + RUIN_SINK) < 1e-9, where);
      for (const x of under) {
        assert(wall.foot <= at(x) - RUIN_SINK + 1e-9, `${where}: a wall shows its foot at ${x.toFixed(2)}`);
        assert(lineAt(wall.line, x) >= at(x) + .1, `${where}: a wall is broken down under its ground at ${x.toFixed(2)}`);
      }
      assert.deepEqual(pairs(face.points).slice(0, 2), [[wall.west, wall.foot], [wall.east, wall.foot]]);
      // Whatever is drawn on it is on it: its brick, its frame, its windows, its scars.
      for (const mark of on) for (const [x, y] of pairs(mark.points))
        assert(x >= wall.west - 1e-9 && x <= wall.east + 1e-9 && y >= wall.foot - 1e-9 && y <= lineAt(wall.line, x) + .02, `${where}: a mark off its wall at ${x.toFixed(2)}, ${(y - at(x)).toFixed(2)}`);
    }
    for (const [i, heap] of plan.heaps.entries()) {
      const { lying } = drawn.heaps[i];
      assert(heap.west >= slab.start + .4 - 1e-9 && heap.east <= slab.end - .4 + 1e-9, `${where}: a heap lies on the slab`);
      assert.equal(heap.top[0][1], at(heap.west)); assert.equal(heap.top.at(-1)[1], at(heap.east));
      for (const x of along(terrain, heap.west, heap.east)) {
        assert(heap.foot <= at(x) - RUIN_SINK + 1e-9, `${where}: a heap shows its foot at ${x.toFixed(2)}`);
        assert(lineAt(heap.top, x) >= at(x) - .01, `${where}: a heap sinks under its ground at ${x.toFixed(2)}`);
      }
      // What lies in a heap is in its rubble, or on the ground beside it, somewhere along its edge: none of it floats.
      for (const piece of i === 2 ? lying.slice(0, -9) : lying)
        assert(edge(piece).some(([x, y]) => y <= rubbleAt(plan, terrain, x) + .01), `${where}: a block floats over its heap`);
    }
    // What lies about the slab is bedded in it, and shows over it.
    assert.equal(drawn.loose.length, 9);
    for (const piece of drawn.loose) {
      const corners = pairs(piece.points);
      assert(corners.some(([x, y]) => y < at(x)) && corners.some(([x, y]) => y > at(x)), `${where}: a piece lying about is not on its ground`);
    }
    // All of it is over the slab, and nothing reaches deeper under the ground than the foot of what stands there.
    for (const { points } of marks(g)) for (const [x, y] of points)
      assert(x >= slab.start && x <= slab.end && y >= low - RUIN_SINK - 1e-9, `${where}: drawn at ${(x - f.peak).toFixed(2)}, ${(y - at(x)).toFixed(2)}`);
    ruins++;
  }
  assert(ruins > 250, `${ruins} ruins`); assert(sloped > 20, 'ruins lie on the crown of a bank, which falls away under them');
});

test('nothing is drawn over the earth a ruin was built on but its slab, and the slab is no deeper than a slab', () => {
  // The stretches of the field's world about some of its ruins, as the scene draws them, and the banks whole.
  const scene = Object.create(TerrainScene.prototype, { terrain: { value: field } }),
    stretches = ruinsOf(field).filter((_, i) => i % 24 === 0).map(f => scene.local({ left: f.peak - 260, right: f.peak + 252, biome: field.biomeAt(f.peak) }));
  let slabs = 0;
  for (const terrain of [...stretches, ...ridges]) {
    const surface = new GraphicsRecorder(), fine = new GraphicsRecorder(), props = new GraphicsRecorder(), at = x => terrain.height(x),
      left = terrain.points[0].x, right = terrain.points.at(-1).x, floors = terrain.sectors.filter(s => s.surface === 'concrete' && s.end > left && s.start < right),
      onFloor = (x, reach = 0) => floors.some(s => x >= s.start - reach && x <= s.end + reach);
    drawGroundSurface(terrain, surface); drawGroundDetail(terrain, fine, props);
    assert(floors.length >= 1);
    // The ground under a ruin is the earth about it, and over it lies the slab: its body, its wearing course and its
    // foot, from the outline down to no deeper than a slab, a little past the east end of the stretch.
    const concrete = surface.fills().filter(fill => CONCRETE.has(toneOf(fill.style)));
    assert.equal(concrete.length, 3 * floors.length);
    for (const fill of concrete) for (const [x, y] of pairs(fill.points)) {
      assert(onFloor(x) && x >= left - 1e-9 && x <= right + .2 + 1e-9, `a slab at ${x.toFixed(2)}`);
      assert(y <= at(x) + 1e-9 && y >= at(x) - SLAB - 1e-9, `a slab ${(at(x) - y).toFixed(3)} m deep`);
    }
    slabs += concrete.length / 3;
    // A near view marks the slab with its aggregate and its cracks, and the earth under it and past its broken ends
    // with the earth's; none of the slab's marks is out in the earth.
    for (const { tone, points } of marks(fine)) {
      if (CONCRETE.has(tone)) for (const [x, y] of points) assert(onFloor(x, .2) && y >= at(x) - SLAB - .02, `the slab's aggregate ${(at(x) - y).toFixed(3)} m deep`);
      else if (![0x3d534b, 0x304a3b, RUIN_TONES.steel].includes(tone))
        assert(!inSlab(terrain, points[0][0], at(points[0][0]) - points[0][1]), `a mark of the earth in the slab at ${points[0][0].toFixed(2)}`);
    }
    // No piece of scenery stands in front of the cut under a ruin.
    for (const { points } of marks(props)) for (const [x, y] of points) if (onFloor(x)) assert(y >= at(x) - .01, `scenery under the slab at ${x.toFixed(2)}`);
    // The grain of the earth begins under the slab.
    const grains = buildSoilGrain(terrain, left, right);
    assert.deepEqual(Object.keys(grains), ['soil', 'rock', 'concrete']);
    for (const [kind, grain] of Object.entries(grains)) {
      assert.deepEqual([grain.x, grain.y], [left, 0]);
      assert.equal(grain.uvs.length, grain.positions.length);
      assert(grain.indices.every(index => index < grain.positions.length / 2));
      for (let i = 0; i < grain.positions.length; i += 2) {
        const x = grain.positions[i] + grain.x, y = grain.positions[i + 1] + grain.y;
        if (inSlab(terrain, x, .01)) assert(y <= at(x) - SLAB - 1e-9, `${kind} grain in the slab at ${x.toFixed(2)}`);
      }
    }
  }
  assert(slabs >= 12, `${slabs} slabs`);
  // A pad laid as a slab keeps its joints, and nothing of a ruin.
  const pad = new Terrain('flat'), surface = new GraphicsRecorder(), fine = new GraphicsRecorder(), props = new GraphicsRecorder();
  drawGroundSurface(pad, surface); drawGroundDetail(pad, fine, props);
  assert(marks(fine).some(m => m.tone === 0xd3ceb3) && !marks(fine).some(m => m.tone === RUIN_TONES.steel));
});

test('a slab drawn by two stretches of ground is one slab, its top the ground line', () => {
  const tones = { body: 0x858a82, top: 0xadb1a8, deep: 0x62675f, rim: 0xcfcec2 };
  for (const terrain of ridges) for (const f of ruinsOf(terrain).slice(0, 6)) {
    const { slab } = ruinPlan(terrain, f), middle = (slab.start + slab.end) / 2, west = new GraphicsRecorder(), east = new GraphicsRecorder(), whole = new GraphicsRecorder();
    drawSlab(west, terrain, slab, slab.start - 5, middle, tones); drawSlab(east, terrain, slab, middle, slab.end + 5, tones); drawSlab(whole, terrain, slab, slab.start - 5, slab.end + 5, tones);
    const reach = g => g.fills().map(fill => { const xs = pairs(fill.points).map(p => p[0]); return [Math.min(...xs), Math.max(...xs)]; });
    // The west part runs a little past the seam, over the earth its stretch leans under the next; the east part starts at it.
    for (const [a, b] of reach(west)) assert(b > middle + .15 && a < middle);
    for (const [a] of reach(east)) assert(Math.abs(a - middle) < 1e-9);
    assert.deepEqual(reach(whole).map(([a]) => a), reach(west).map(([a]) => a));
    for (const g of [west, east, whole]) for (const [x, y] of pairs(g.fills()[1].points)) assert(y <= terrain.height(x) + 1e-9 && y >= terrain.height(x) - SLAB);
  }
});

test('a ruin is drawn the same every time, from its ground alone, in whichever stretch of it', () => {
  const copy = new Terrain(field.descriptor()), scene = Object.create(TerrainScene.prototype, { terrain: { value: field } }),
    drawn = (terrain, f) => { const g = new GraphicsRecorder(); drawRuins(alone(terrain, f), g); return g.calls; };
  for (const [i, f] of ruinsOf(field).entries()) {
    if (i % 8) continue;
    const twin = copy.features.find(o => o.kind === 'ruins' && o.peak === f.peak), calls = drawn(field, f);
    assert.notEqual(twin, f);
    assert.deepEqual(ruinPlan(copy, twin), ruinPlan(field, f)); assert.deepEqual(drawn(copy, twin), calls); assert.deepEqual(drawn(field, f), calls);
    // A stretch of ground holds the ruins whose middle is in it, and draws them as the whole ground does.
    for (const [left, right] of [[f.peak - 400, f.peak + 112], [f.peak - 1e-3, f.peak + 512]]) {
      const local = scene.local({ left, right, biome: field.biomeAt(f.peak) }), g = new GraphicsRecorder();
      assert(local.features.includes(f));
      drawRuins(local, g);
      const others = local.features.filter(o => o.kind === 'ruins' && o !== f).map(o => drawn(field, o)), at = local.features.filter(o => o.kind === 'ruins').indexOf(f);
      assert.deepEqual(g.calls, [...others.slice(0, at), calls, ...others.slice(at)].flat());
    }
  }
});

test('a ruins site is drawn alike wherever it lies and however rich its vein, its steel jutting from the heaps of its ruin and its rust on the slab', () => {
  // Every site holds a vein: some sites of the ruins from one end of the ground to the other, the leaner in the middle
  // and the richer towards the ends.
  const sites = depositsOf(field).filter(site => site.feature === 'ruins'), spread = sites.filter((site, i) => i % 2 === 0),
    reserves = spread.map(site => site.reserve), kinds = calls => calls.map(c => [c[0], c[0] === 'fill' || c[0] === 'stroke' ? toneOf(c[1]) : null]);
  assert(spread.length >= 12 && Math.max(...reserves) > 2 * Math.min(...reserves), `${spread.length} sites of ${Math.min(...reserves)} to ${Math.max(...reserves)}`);
  for (const pixel of [1 / 45, 1 / 4, 2]) {
    let first = null;
    for (const site of spread) {
      const parts = { works: new GraphicsRecorder(), front: new GraphicsRecorder() }, f = field.features.find(o => o.kind === 'ruins' && o.peak === site.x),
        plan = ruinPlan(field, f), at = x => field.height(x);
      drawSite(parts, site, field, pixel);
      // The same pieces in the same tones, wherever the site and whatever lies under it; none in the tones of the ore.
      const look = { works: kinds(parts.works.calls), front: kinds(parts.front.calls) };
      if (first) assert.deepEqual(look, first, `${site.id}: drawn otherwise`); else first = look;
      for (const part of ['works', 'front']) for (const { tone } of marks(parts[part])) for (const name of ['body', 'halo', 'band']) assert.notEqual(tone, ORE_TONES.ruins[name], `${site.id}: the ${name} of the ore`);
      // A beam stands out of each heap, its foot on the rubble and its top in the air.
      const fills = parts.works.fills();
      assert.equal(fills.length, 9);
      for (const [i, heap] of plan.heaps.entries()) {
        const beam = pairs(fills[3 * i].points);
        for (const [x, y] of beam.slice(0, 2)) assert((pixel > .2 || x > heap.west && x < heap.east) && Math.abs(y - rubbleAt(plan, field, x)) < 1e-9, `${site.id}: a beam off its heap`);
        assert(beam[2][1] + beam[3][1] > beam[0][1] + beam[1][1] + 1.6, `${site.id}: a beam lies down`);
      }
      // Its rust is a stain on the slab, inside its broken ends.
      for (const fill of parts.front.fills()) for (const [x, y] of pairs(fill.points))
        assert(inSlab(field, x, at(x) - y) && at(x) - y >= 0, `${site.id}: rust off the slab at ${(x - site.x).toFixed(2)}, ${(at(x) - y).toFixed(3)} m deep`);
    }
  }
});

test('the ruins of a stretch stand behind its ground, among its trees, and stay in view as long as the stretch does', () => {
  const terrain = ridges[2], roots = [new Container(), new Container()], scene = new TerrainScene(...roots), f = ruinsOf(terrain)[7];
  try {
    scene.rebuild(terrain);
    for (const zoom of [FLORA_ZOOM * .5, 1, DETAIL_ZOOM, 40]) {
      // As many frames as the partition of the zoom takes to paint the view (terrain-scene.ts `handOver`), and the
      // ruins show in the one shown on each.
      for (let frame = 0; frame < 32; frame++) {
        scene.update({ x: f.peak, width: 1200, zoom });
        assert(scene.activeChunks.find(c => c.left <= f.peak && f.peak < c.right).ruins?.visible);
      }
      const chunk = scene.activeChunks.find(c => c.left <= f.peak && f.peak < c.right);
      assert(chunk.ruins?.visible && chunk.ruins.parent === scene.layers.flora, `at ${zoom} px a metre`);
      assert.deepEqual([chunk.ruins.x, chunk.ruins.y], [chunk.left, 0]);
    }
    const order = roots[0].children;
    assert(order.indexOf(scene.layers.flora) < order.indexOf(scene.layers.surface) && order.indexOf(scene.layers.flora) < order.indexOf(scene.layers.strata));
    for (const chunk of scene.chunks.filter(c => c.earth)) assert.equal(Boolean(chunk.ruins), ruinsOf(terrain).some(o => o.peak >= chunk.left && o.peak < chunk.right));
    const drawn = scene.chunks.filter(c => c.ruins).map(c => c.ruins);
    scene.clear();
    assert(drawn.length && drawn.every(g => g.destroyed));
  } finally { scene.clear(); for (const root of roots) root.destroy(); }
});
