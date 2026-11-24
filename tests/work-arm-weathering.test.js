import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferImageSource, Texture, Matrix, Graphics, GpuGraphicsContext, buildContextBatches } from 'pixi.js';
import { MODULES } from '../src/materials.ts';
import { workLayout, workFigure, craneLayout, craneRoute, craneFigure, SCOOP_SECONDS, LIFT_SECONDS } from '../src/work-arm.ts';
import { drawWorkArm, createWorkArmWeathering, WORK_ARM_WEATHERING } from '../src/work-arm-art.ts';
import { anchorGraphics } from '../src/world-anchor.ts';
import { GraphicsRecorder, countingCanvas } from './scenery-canvas.js';

const matrixValues = m => [m.a, m.b, m.c, m.d, m.tx, m.ty];
function materials(t) {
  const fills = Object.fromEntries(Object.entries(WORK_ARM_WEATHERING).map(([name, profile]) => {
    const source = new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4).fill(255), width: 4, height: 4,
      addressMode: 'repeat', alphaMode: 'premultiplied-alpha' });
    return [name, { texture: new Texture({ source }), color: 0xffffff, alpha: 1, textureSpace: 'global',
      matrix: new Matrix().scale(profile.period / 4, profile.period / 4) }];
  }));
  t.after(() => { for (const fill of Object.values(fills)) fill.texture.destroy(true); });
  return fills;
}
function figure(kind, side = 1, share = .2) {
  const piece = { kind, x: 100, y: 1.6, angle: 0, width: MODULES[kind].width, height: MODULES[kind].height },
    layout = workLayout(piece, { left: -2.5, right: 2.3, bottom: -1.6 }, side);
  return workFigure(layout, { deployed: 1, sunk: 1, working: true, cycle: share * SCOOP_SECONDS }, () => 0);
}
function faceColors(set) {
  return new Map([[set.seat.fill, WORK_ARM_WEATHERING.seatSteel.color], [set.boom.fill, WORK_ARM_WEATHERING.armPaint.color],
    [set.stick.fill, WORK_ARM_WEATHERING.armPaint.color], [set.bucket.fill, WORK_ARM_WEATHERING.bucketSteel.color],
    [set.mast.fill, WORK_ARM_WEATHERING.mastSteel.color], [set.head.fill, WORK_ARM_WEATHERING.armPaint.color],
    [set.foot.fill, WORK_ARM_WEATHERING.seatSteel.color]]);
}

test('work-arm weathering shares four prepared materials and retains independent matrices for seven rigid faces', t => {
  const shared = materials(t), before = Object.values(shared).map(fill => matrixValues(fill.matrix)),
    first = createWorkArmWeathering(shared), second = createWorkArmWeathering(shared);
  assert.equal(Object.keys(WORK_ARM_WEATHERING).length, 4); assert.equal(Object.keys(first).length, 7);
  assert(Object.values(WORK_ARM_WEATHERING).every(profile => profile.material === 'painted' && !(profile.rust > 0)),
    'the shared mixed-metal finish cannot carry ferrous oxide onto aluminium or titanium');
  assert.equal(new Set(Object.values(first).map(face => face.fill.texture)).size, 4);
  assert.equal(new Set(Object.values(first).map(face => face.fill.matrix)).size, 7);
  for (const name of Object.keys(first)) {
    assert.equal(first[name].fill.texture, second[name].fill.texture, 'another extractor reuses the same material image');
    assert.notEqual(first[name].fill.matrix, second[name].fill.matrix, 'an extractor cannot change another extractor’s texture phase');
  }
  drawWorkArm(new GraphicsRecorder(), figure('drill'), { weatheringFills: first });
  assert.deepEqual(Object.values(shared).map(fill => matrixValues(fill.matrix)), before, 'shared material matrices stay untouched');
  assert.equal(createWorkArmWeathering(null), null);
});

test('weathering replaces only rigid-face fills, preserving every contour, stroke, polished rod, hose and particle at both LODs', t => {
  const shared = materials(t), set = createWorkArmWeathering(shared), colors = faceColors(set);
  for (const kind of ['excavator', 'drill']) for (const side of [-1, 1]) for (const share of [.05, .2, .6, .75, .8]) for (const pixel of [.01, .2]) {
    const shape = figure(kind, side, share), clean = new GraphicsRecorder(), worn = new GraphicsRecorder(), before = structuredClone(shape);
    drawWorkArm(clean, shape, { pixel, material: 'silica' });
    drawWorkArm(worn, shape, { pixel, material: 'silica', weatheringFills: set });
    const normalized = worn.calls.map(call => call[0] === 'fill' && colors.has(call[1]) ? ['fill', colors.get(call[1])] : call);
    assert.deepEqual(normalized, clean.calls, `${kind}, side ${side}, cycle ${share}, pixel ${pixel}`);
    assert.deepEqual(shape, before, 'the artwork cannot modify animation state or physical places');
    assert.equal(worn.calls.filter(call => call[0] === 'fill' && colors.has(call[1])).length, kind === 'drill' ? 6 : 4);
  }
});

test('a crane has seven faces of its own, and its weathering too replaces only their fills', t => {
  const shared = materials(t), set = createWorkArmWeathering(shared, 'builder'),
    colors = new Map([[set.column.fill, WORK_ARM_WEATHERING.seatSteel.color], [set.block.fill, WORK_ARM_WEATHERING.seatSteel.color],
      ...['boom', 'jib', 'first', 'second', 'third'].map(name => [set[name].fill, WORK_ARM_WEATHERING.armPaint.color])]);
  assert.deepEqual(Object.keys(set), ['column', 'boom', 'jib', 'first', 'second', 'third', 'block']);
  assert.equal(new Set(Object.values(set).map(face => face.fill.matrix)).size, 7);
  for (const side of [-1, 1]) {
    const piece = { kind: 'builder', x: 100, y: 1.6, angle: 0, width: MODULES.builder.width, height: MODULES.builder.height },
      layout = craneLayout(piece, { left: -2.5, right: 2.3, bottom: -1.6 }, side), route = craneRoute(layout, [piece], () => 0, null);
    const shapes = [craneFigure(layout), ...[.05, .4, .8].map(share => craneFigure(layout, { deployed: 1, working: true, cycle: share * LIFT_SECONDS }, route))];
    assert.deepEqual(shapes.map(shape => shape.run > .01), [false, false, true, true]);
    for (const shape of shapes) for (const pixel of [.01, .2]) {
      // The rest (post, foot and saddle), the slewing base, the turntable, the column, the two booms and the block.
      const faces = shape.run > .01 ? 12 : 9, clean = new GraphicsRecorder(), worn = new GraphicsRecorder(), before = structuredClone(shape);
      drawWorkArm(clean, shape, { pixel, material: 'ligas' });
      drawWorkArm(worn, shape, { pixel, material: 'ligas', weatheringFills: set });
      assert.deepEqual(worn.calls.map(call => call[0] === 'fill' && colors.has(call[1]) ? ['fill', colors.get(call[1])] : call), clean.calls);
      assert.deepEqual(shape, before, 'the artwork cannot modify animation state or physical places');
      assert.equal(worn.calls.filter(call => call[0] === 'fill' && colors.has(call[1])).length, faces, 'the sections are drawn only run out');
    }
  }
});

test('each rigid face keeps its texture phase when translated, rotated, mirrored, and drawn far from the world origin', t => {
  const shared = materials(t), textures = new Set(Object.values(shared).map(fill => fill.texture));
  function uvs(shape) {
    const g = anchorGraphics(new Graphics(), shape.mount.x, shape.mount.y), set = createWorkArmWeathering(shared), gpu = new GpuGraphicsContext();
    drawWorkArm(g, shape, { pixel: .01, weatheringFills: set }); buildContextBatches(g.context, gpu);
    const result = gpu.batches.filter(batch => textures.has(batch.texture)).map(batch =>
      gpu.geometryData.uvs.slice(batch.attributeOffset * 2, (batch.attributeOffset + batch.attributeSize) * 2));
    g.destroy({ context: true }); return result;
  }
  for (const kind of ['excavator', 'drill']) for (const side of [-1, 1]) {
    const base = { ...figure(kind, side), spill: null, dust: null, dig: null, flow: null }, original = uvs(base);
    for (const angle of [0, .31, -.62]) {
      const c = Math.cos(angle), s = Math.sin(angle), transformed = structuredClone(base);
      for (const [name, point] of Object.entries(base)) if (point && typeof point === 'object' && 'x' in point && 'y' in point) {
        transformed[name] = { x: c * point.x - s * point.y + (name === 'open' ? 0 : 125000),
          y: s * point.x + c * point.y + (name === 'open' ? 0 : 1234) };
      }
      const moved = uvs(transformed);
      assert.equal(moved.length, original.length);
      for (const [i, coordinates] of moved.entries()) {
        assert.equal(coordinates.length, original[i].length);
        for (const [j, value] of coordinates.entries()) assert(Math.abs(value - original[i][j]) < 1e-6,
          `${kind} side ${side} angle ${angle} face ${i} UV ${j}: texture moved over its own metal`);
      }
    }
  }
});

test('120 articulated frames reuse prepared fills, matrices and sources without Canvas work or material invalidation', t => {
  const { counters } = countingCanvas(t), shared = materials(t), set = createWorkArmWeathering(shared), g = new Graphics(),
    faces = Object.values(set), fills = faces.map(face => face.fill), matrices = faces.map(face => face.fill.matrix),
    sources = Object.values(shared).map(fill => fill.texture.source), started = { ...counters };
  let invalidated = 0;
  for (const source of sources) source.on('update', () => { invalidated++; });
  for (const fill of Object.values(shared)) fill.matrix.clone = () => { throw Error('Material was prepared during an articulated frame'); };
  for (let i = 0; i < 120; i++) {
    const shape = figure(i % 2 ? 'drill' : 'excavator', i % 3 ? 1 : -1, i / 120);
    anchorGraphics(g, shape.mount.x, shape.mount.y); drawWorkArm(g, shape, { pixel: .01, weatheringFills: set });
    assert(faces.every((face, i) => face === Object.values(set)[i] && face.fill === fills[i] && face.fill.matrix === matrices[i]),
      'articulation retains the exact face, fill and matrix objects');
    assert(faces.every(face => matrixValues(face.fill.matrix).every(Number.isFinite)));
  }
  assert.deepEqual(counters, started); assert.equal(invalidated, 0);
  g.destroy({ context: true });
});
