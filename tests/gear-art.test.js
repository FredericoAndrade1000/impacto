import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { paintGear, TREAD, tyreOutline } from '../src/gear-art.ts';
import { metalRgb, paintMetal } from '../src/component-art.ts';
import { METALS } from '../src/materials.ts';
import { SPROCKET_TEETH, SPROCKET_TIP } from '../src/running-gear.ts';

// Record the real painter's colours and radial paths, before the ordinary
// module texture's shared metal finish is applied. No renderer or raster mock.
function wheel(style, options = {}) {
  const records = [], gradient = () => ({ stops: [], addColorStop(at, colour) { this.stops.push(colour); } });
  const stack = []; let arc, path = [], pose = { x: 0, y: 0, angle: 0 };
  const point = ([x, y]) => [pose.x + Math.cos(pose.angle) * x - Math.sin(pose.angle) * y,
    pose.y + Math.sin(pose.angle) * x + Math.cos(pose.angle) * y],
    record = (operation, colour, polygon = path) => records.push({ operation,
      arc: arc && [...point(arc), ...arc.slice(2)], polygon: arc ? null : polygon.map(point), localPolygon: arc ? null : polygon.map(p => [...p]),
      transformed: pose.x !== 0 || pose.y !== 0 || pose.angle !== 0,
      composite: ctx.globalCompositeOperation, colour: colour?.stops ? { stops: [...colour.stops] } : colour });
  const ctx = { canvas: { width: 400, height: 400 },
    globalCompositeOperation: 'source-over',
    beginPath() { arc = null; path = []; }, arc(...args) { arc = args; },
    fill() { record('fill', this.fillStyle); }, stroke() { record('stroke', this.strokeStyle); },
    fillRect(x, y, width, height) { const held = arc; arc = null;
      record('rect', this.fillStyle, [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]); arc = held; },
    drawImage() { assert.fail('running-gear geometry must not depend on a bitmap'); },
    createLinearGradient: gradient, createRadialGradient: gradient,
    moveTo(...p) { path.push(p); }, lineTo(...p) { path.push(p); }, closePath() {}, clip() {},
    save() { stack.push({ pose: { ...pose }, composite: this.globalCompositeOperation }); },
    restore() { const held = stack.pop(); pose = held.pose; this.globalCompositeOperation = held.composite; },
    translate(x, y) { const [tx, ty] = point([x, y]); pose.x = tx; pose.y = ty; }, rotate(angle) { pose.angle += angle; } };
  paintGear(ctx, 'wheel', 1, 1, { ...options, style });
  assert.equal(ctx.globalCompositeOperation, 'source-over', 'hole cuts must not leak into the next layer');
  return records;
}
const rgb = colour => [1, 3, 5].map(at => parseInt(colour.slice(at, at + 2), 16));
const colours = records => records.flatMap(record => typeof record.colour === 'string' ? [record.colour] : record.colour?.stops || []);
const TAU = 2 * Math.PI, near = (a, b) => Math.abs(a - b) < 1e-8;
function regularCircles(records, count) {
  assert.equal(records.length, count);
  const radii = records.map(({ arc }) => Math.hypot(arc[0] - 200, arc[1] - 200)),
    phases = records.map(({ arc }) => (Math.atan2(arc[1] - 200, arc[0] - 200) + TAU) % TAU).sort((a, b) => a - b);
  for (const [i, record] of records.entries()) {
    assert(near(record.arc[2], records[0].arc[2]), 'every repeated opening or bolt has the same radius');
    assert(near(radii[i], radii[0]), 'every centre stands on the same circle about the actual rotation pivot');
    assert(near((phases[(i + 1) % count] - phases[i] + TAU) % TAU, TAU / count), 'angular gaps must all be equal');
  }
}

test('the tyre, rim and hub use concentric circular geometry without a supplied image', () => {
  const rings = wheel().filter(record => record.arc && !record.transformed);
  assert(rings.length >= 10, 'the tyre, bead, rim and hub have their own geometry');
  for (const { arc } of rings) {
    assert(near(arc[0], 200) && near(arc[1], 200), 'every principal circle shares the renderer rotation pivot');
    assert(arc[2] > 0 && arc[2] <= 200);
    assert(near(arc[3], 0) && near(arc[4], TAU), 'each ring describes a whole circle');
  }
  assert(rings.some(({ arc }) => near(arc[2], 120)), 'the rim follows the reference proportions');
  assert(rings.some(({ arc }) => near(arc[2], 26)), 'the broad central cap remains visible');
});

test('tread blocks repeat identical geometry and finish at equal turns', () => {
  const blocks = wheel().filter(record => record.operation === 'fill' && record.polygon?.length === 4 &&
    Math.max(...record.polygon.map(([x, y]) => Math.hypot(x - 200, y - 200))) > 190);
  assert.equal(blocks.length, 32);
  const phases = blocks.map(record => {
    assert.deepEqual(record.localPolygon, blocks[0].localPolygon, 'no individual lug changes its shape');
    assert.equal(record.colour, blocks[0].colour, 'no individual lug carries a different baked light');
    assert(record.polygon.every(([x, y]) => Math.hypot(x - 200, y - 200) < 200));
    for (const [i, [x, y]] of record.polygon.entries()) assert(near(Math.hypot(x - 200, y - 200),
      Math.hypot(blocks[0].polygon[i][0] - 200, blocks[0].polygon[i][1] - 200)), 'each corresponding lug vertex stays at the same radius');
    const x = record.polygon.reduce((sum, point) => sum + point[0], 0) / 4 - 200,
      y = record.polygon.reduce((sum, point) => sum + point[1], 0) / 4 - 200;
    return (Math.atan2(y, x) + TAU) % TAU;
  }).sort((a, b) => a - b);
  for (let i = 0; i < phases.length; i++) assert(near((phases[(i + 1) % phases.length] - phases[i] + TAU) % TAU, TAU / phases.length));
});

test('a tyre is outlined round each of its tread blocks and down on its carcass between them, never across the open', () => {
  const { blocks, carcass, edge } = TREAD, pitch = TAU / blocks, radius = .5, reach = Math.cos(Math.PI / 48);
  // The blocks as the tyre is painted, in its radius, in the frame of the wheel (up the picture is up).
  const painted = wheel().filter(record => record.operation === 'fill' && record.polygon?.length === 4 &&
    Math.max(...record.polygon.map(([x, y]) => Math.hypot(x - 200, y - 200))) > 190).map(record => record.polygon.map(([x, y]) => ({ x: (x - 200) / 200, y: (200 - y) / 200 })));
  assert.equal(painted.length, blocks);
  const inside = (p, polygon) => polygon.reduce((odd, a, i) => { const b = polygon[(i + 1) % polygon.length];
    return (a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x ? !odd : odd; }, false);
  const off = (p, polygon) => inside(p, polygon) ? 0 : Math.min(...polygon.map((a, i) => { const b = polygon[(i + 1) % polygon.length], dx = b.x - a.x, dy = b.y - a.y,
    t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); }));
  // A block with the edge it is painted with: each side out by half of it, met at its corners as a canvas joins them.
  const edged = block => block.map((_, i) => {
    const middle = block.reduce((sum, p) => ({ x: sum.x + p.x / block.length, y: sum.y + p.y / block.length }), { x: 0, y: 0 }),
      side = (a, b) => { const length = Math.hypot(b.x - a.x, b.y - a.y), n = { x: (b.y - a.y) / length, y: (a.x - b.x) / length },
        out = n.x * (a.x - middle.x) + n.y * (a.y - middle.y) > 0 ? 1 : -1; return { a: { x: a.x + n.x * out * edge / 2, y: a.y + n.y * out * edge / 2 }, d: { x: b.x - a.x, y: b.y - a.y } }; },
      one = side(block[(i + block.length - 1) % block.length], block[i]), two = side(block[i], block[(i + 1) % block.length]),
      t = ((two.a.x - one.a.x) * two.d.y - (two.a.y - one.a.y) * two.d.x) / (one.d.x * two.d.y - one.d.y * two.d.x);
    return { x: one.a.x + t * one.d.x, y: one.a.y + t * one.d.y };
  });
  for (const zoom of [100, 300, 1300]) {
    const width = 2 ** (Math.round(Math.log2(1 / zoom) * 4) / 4), outline = tyreOutline(radius, width, reach).map(p => ({ x: p.x / radius, y: p.y / radius })),
      polar = outline.map(p => ({ r: Math.hypot(p.x, p.y), a: (Math.atan2(p.y, p.x) + TAU) % TAU }));
    assert(polar.every(p => p.r > carcass - 1e-9 && p.r < reach + 1e-9), 'never into the carcass, nor out of where the picture is drawn');
    // Out round every block once, and down on the carcass across the open between two of them.
    const out = polar.map(p => p.r > carcass + 1e-6);
    assert.equal(out.filter((rises, i) => rises && !out[(i + out.length - 1) % out.length]).length, blocks);
    for (const p of polar) if (Math.abs((p.a + pitch / 2) % pitch - pitch / 2) > .075) assert(near(p.r, carcass), `zoom ${zoom}: on the carcass across the open`);
    // Every block as it is painted is within the line, and the line stands off none: it lies on the carcass or on a block
    // with its edge, where the picture is drawn.
    for (const block of painted) for (const corner of block) assert(inside(corner, outline), `zoom ${zoom}: the line goes round the blocks`);
    for (const p of outline) assert(Math.hypot(p.x, p.y) < carcass + 1e-9 || painted.some(block => off(p, edged(block)) < 1e-9), `zoom ${zoom}: the line keeps to the tread`);
    // Its arcs are cut close enough that no side falls a tenth of the line inside them.
    for (const [i, p] of polar.entries()) {
      const q = polar[(i + 1) % polar.length];
      if (near(p.r, q.r)) assert(p.r * radius * (1 - Math.cos(((q.a - p.a + TAU) % TAU) / 2)) <= width / 10 + 1e-12);
    }
  }
  // Blocks under two lines tall stand out of the carcass as a fringe the picture shows as a tone: the line goes round the carcass.
  for (const zoom of [6, 30]) assert(tyreOutline(radius, 1 / zoom, reach).every(p => near(Math.hypot(p.x, p.y), carcass * radius)));
});

test('eight rim openings reveal the brake drum and the hub bolts keep their regular spacing', () => {
  const records = wheel(), holes = records.filter(record => record.operation === 'fill' && record.composite === 'destination-out'),
    bolts = records.filter(record => record.operation === 'fill' && record.arc && record.colour === '#1b2c20'),
    heads = records.filter(record => record.operation === 'fill' && record.polygon?.length === 6 && record.colour === '#bcc3a8');
  regularCircles(holes, 8); regularCircles(bolts, 8);
  assert(holes.every(({ arc }) => near(arc[2], 13.4) && near(Math.hypot(arc[0] - 200, arc[1] - 200), 72)));
  assert(bolts.every(({ arc }) => near(Math.hypot(arc[0] - 200, arc[1] - 200), 37.6)));
  assert.equal(heads.length, 8);
  for (const head of heads) assert.deepEqual(head.localPolygon, heads[0].localPolygon, 'the hexagonal bolt heads are identical');
  const drum = records.filter(record => record.composite === 'destination-over'),
    face = drum.find(record => record.operation === 'fill' && record.arc);
  assert(face, 'a cast drum is painted behind the rim in the same wheel picture');
  assert(holes.every(({ arc }) => Math.hypot(arc[0] - face.arc[0], arc[1] - face.arc[1]) + arc[2] < face.arc[2]),
    'the drum covers each opening so neither the suspension nor the sky shows through');
  assert(face.arc[2] < 120, 'the drum stays inside the rim, leaving the tyre outline and its transparent surroundings intact');
  assert(drum.some(record => record.operation === 'stroke'), 'cast cooling rings remain visible through the openings');
  for (const style of ['road', 'idler']) assert(wheel(style).every(record => record.composite !== 'destination-out'),
    `${style} keeps the track's opaque recesses`);
});

test('armour stays a separate guard over the same procedural tyre and rim', () => {
  assert.deepEqual(wheel(undefined, { armorMm: 40 }), wheel(), 'the base texture never contains its own guard');
  assert.deepEqual(wheel('guard'), []);
  const guard = wheel('guard', { armorMm: 40 });
  assert(guard.length > 0 && guard.every(record => record.composite === 'source-over'));
  assert(guard.some(({ arc, operation }) => operation === 'fill' && arc && near(arc[0], 200) && near(arc[1], 200) && near(arc[2], 129)),
    'the steel guard covers the full rim and all of its openings');
});

test('tyres retain rubber tones while their procedural rim and hub take the chassis metal', () => {
  const records = wheel(), bead = records.findIndex(record => record.arc?.[2] === 200 * .62),
    rubber = colours(records.slice(0, bead + 1)), rim = records.slice(bead + 1).find(record => record.colour?.stops);
  assert(bead > 0 && rubber.length > 20 && rim);
  for (const material of [METALS.aluminum, METALS.titanium]) {
    for (const colour of rubber) assert.deepEqual(metalRgb(...rgb(colour), material.look), rgb(colour), colour);
    assert(rim.colour.stops.some(colour => metalRgb(...rgb(colour), material.look).some((value, i) => value !== rgb(colour)[i])),
      'the actual rim still receives the metal finish');
  }
});

test('the rim material finish preserves surrounding rubber pixels and existing transparency', () => {
  for (const material of [METALS.aluminum, METALS.titanium]) {
    const pixels = new Uint8ClampedArray([60, 65, 62, 255, 100, 120, 95, 255, 100, 120, 95, 0, 60, 65, 62, 255]),
      before = pixels.slice(), ctx = { canvas: { width: 4, height: 1 },
        getImageData: () => ({ data: pixels }), putImageData(image) { assert.equal(image.data, pixels); } };
    paintMetal(ctx, material.look, .6);
    assert.deepEqual(pixels.slice(0, 4), before.slice(0, 4));
    assert.deepEqual(pixels.slice(12), before.slice(12));
    assert.deepEqual(pixels.slice(8, 12), before.slice(8, 12));
    assert.notDeepEqual(pixels.slice(4, 7), before.slice(4, 7));
    assert.equal(pixels[7], 255);
  }
});

test('a sprocket has as many teeth as it is told, evenly round, half a tooth on from the gaps the pins of the links come round it in, their tips on the line of those pins', () => {
  for (const teeth of [6, 11, 17]) {
    const records = wheel('sprocket', { teeth }).filter(record => record.operation === 'fill' && record.colour === '#6c7c5d' && record.polygon);
    assert.equal(records.length, teeth);
    const phases = records.map(({ polygon }) => {
      const x = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length - 200, y = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length - 200;
      return (Math.atan2(y, x) + TAU) % TAU;
    }).sort((a, b) => a - b);
    phases.forEach((phase, i) => assert(Math.abs((phases[(i + 1) % teeth] - phase + TAU) % TAU - TAU / teeth) < 1e-9, 'evenly round'));
    // Unturned, the pins come round it at its angle naught and every tooth on (running-gear.ts `linkStart`): each tooth
    // stands between two of them, in the middle of a link.
    for (const phase of phases) assert(Math.abs(phase / (TAU / teeth) % 1 - SPROCKET_TEETH) < 1e-9, 'in the middle of a link');
    for (const { polygon } of records) assert(near(Math.max(...polygon.map(p => Math.hypot(p[0] - 200, p[1] - 200))), 200 * SPROCKET_TIP));
  }
});

test('a road wheel and a roller of a track are each the outer of a pair: a thick tyre of rubber, the inner wheel through the holes of the dish, a cap bolted over the hub', () => {
  for (const [style, holes, bolts, rim] of [['road', 8, 8, .8], ['roller', 5, 6, .76], ['idler', 6, 6, .86]]) {
    const records = wheel(style), arcs = (colour, operation = 'fill') => records.filter(record => record.operation === operation && record.colour === colour && record.arc);
    // The tyre all round out to the edge of the wheel, a fifth of its radius and more thick, before the dish.
    if (style !== 'idler') {
      assert.deepEqual(records[0].arc.slice(0, 3), [200, 200, 200]); assert.equal(records[0].colour, '#16150f');
      const dish = records.findIndex(record => record.operation === 'fill' && record.arc && near(record.arc[2], 200 * rim));
      assert(dish > 0 && records.slice(0, dish).every(record => !record.arc || record.arc[2] > 200 * rim - 1e-9), `${style}: the dish over the tyre`);
    }
    // Through each hole of the dish, evenly round, the dish of the inner wheel and, a quarter of a hole round, its hole.
    const inner = arcs('#2b3927'), behind = arcs('#0b130e'), round = 200 * rim * .58;
    assert.equal(inner.length, holes, style); assert.equal(behind.length, holes, style);
    for (const [k, record] of inner.entries()) {
      const angle = Math.atan2(record.arc[1] - 200, record.arc[0] - 200), next = behind[k].arc;
      assert(near(Math.hypot(record.arc[0] - 200, record.arc[1] - 200), round));
      assert(near(Math.atan2(next[1] - 200, next[0] - 200), angle + TAU / holes / 4) || near(Math.abs(Math.atan2(next[1] - 200, next[0] - 200) - angle - TAU / holes / 4), TAU));
    }
    // The cap: its nuts, each a hexagon, evenly round the hub.
    const nuts = records.filter(record => record.operation === 'fill' && record.colour === '#bcc3a8' && record.polygon?.length === 6);
    assert.equal(nuts.length, bolts, style);
  }
});

test('a track road wheel keeps its rubber band while the sprocket and idler remain metallic', () => {
  const records = wheel('road'), band = colours(records.slice(0, 3));
  assert.equal(band.length, 3);
  for (const material of [METALS.aluminum, METALS.titanium]) {
    for (const colour of band) assert.deepEqual(metalRgb(...rgb(colour), material.look), rgb(colour));
    for (const style of ['sprocket', 'idler']) assert(colours(wheel(style)).some(colour =>
      metalRgb(...rgb(colour), material.look).some((value, i) => value !== rgb(colour)[i])), style);
  }
});

test('metal conversion preserves the byte colours across the RGB cube and all six hue sectors', () => {
  // Recorded from the original painter: this checks rounding and protected
  // colours without retaining a second implementation of the HSL conversion.
  const looks = [null, METALS.aluminum.look, METALS.titanium.look,
    ...Array.from({ length: 6 }, (_, i) => ({ hue: i * 60 + 25, saturation: .12, lift: -.08 }))],
    expected = [
      '2163a4097f6fb9c65610491bbbc71b12e579df1572e686a0e1e2513efaeeb980',
      '4394ff799f64a774fe9a8ca0525c9cb26ce6e2228b4ee75f4a50105f02554960',
      'a4d6dedc9af7a593f4559122d65c98a42160a24b85ca62c849a85466445ba79b',
      '0dbb08c97ed5ef5cf0a7e870e824afac7e6a5023751b93abf56e91ee262a9206',
      'e6d09e907431c02a9e7ae98fbbc00776e997779646bf228e7a17bc01a0e92f56',
      'f7b4ff15ead58339bec2eb264a8bcd69a2d96ba1e2840742133adba22cc1533f',
      '5a083c7b108987b81b82ff83deaf87a38c7220aa74a79a3cdfdc7d90d5585639',
      '87aee476d1cc694f68ac60d914800339cbb7662ba6522a57ca6b7424503e69bb',
      '52c428460e9a2e4d4cf022412c5a044f7d73be50e3589702fdb92ca22da5a81d',
    ];
  for (const [index, look] of looks.entries()) {
    const bytes = [];
    for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17)
      bytes.push(...metalRgb(r, g, b, look));
    assert.equal(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), expected[index], JSON.stringify(look));
  }
});
