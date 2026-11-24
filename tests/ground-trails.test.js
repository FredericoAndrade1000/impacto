import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, GpuGraphicsContext, buildContextBatches } from 'pixi.js';
import { GroundTrails } from '../src/terrain-art.ts';

function scene(t, { positions = [0], width = 900 } = {}) {
  const root = new Container(), emissions = [],
    trails = new GroundTrails(root, { surfaceTrail: event => emissions.push(event), surfaceSpray: event => emissions.push(event) }),
    terrain = { height: x => x * .002, groundAt: () => 'soil' },
    state = { actors: positions.map((_, i) => ({ id: `truck-${i}`, vehicle: { vx: 6, slip: 0 } })),
      modules: positions.map((x, i) => ({ id: `wheel-${i}`, actorId: `truck-${i}`, kind: 'wheel', attached: true, groundContact: { x } })) },
    view = { x: positions[0], y: terrain.height(positions[0]), zoom: 10, width, height: 550 };
  let time = 0;
  trails.update(state, terrain, time, view);
  t.after(() => { trails.clear(); root.destroy({ children: true }); });
  return { root, trails, emissions, state, terrain, view,
    step(dx = .2) { for (const wheel of state.modules) wheel.groundContact.x += dx; trails.update(state, terrain, time += 1 / 30, view); },
    pan(patch) { Object.assign(view, patch); trails.update(state, terrain, time, view); } };
}
const drawingOrder = f => assert.deepEqual(f.root.children, f.trails.chunks.filter(chunk => chunk.graphics).map(chunk => chunk.graphics));

test('new marks retain complete drawings; FIFO trimming and clearing release their contexts', t => {
  const f = scene(t);
  for (let i = 0; i < 80; i++) f.step();
  assert(f.trails.chunks.length >= 3);
  const complete = f.trails.chunks.slice(0, -1).map(chunk => [chunk, chunk.graphics, chunk.graphics.context, chunk.graphics.context.instructions[0]]);
  f.step();
  for (const [chunk, graphics, context, first] of complete) {
    assert.equal(chunk.graphics, graphics); assert.equal(graphics.context, context); assert.equal(context.instructions[0], first);
  }
  for (let i = 0; i < 400; i++) f.step();
  assert.equal(f.trails.marks.length, 600);
  assert.deepEqual(f.trails.chunks.flatMap(chunk => chunk.marks), f.trails.marks);
  assert(f.trails.chunks.every(chunk => chunk.marks.length > 0 && chunk.marks.length <= 64));
  for (const [, graphics, context] of complete) assert(graphics.destroyed && context.destroyed);
  f.pan({ x: 80, width: 9000 });
  const head = f.trails.chunks[0], headGraphics = head.graphics, headContext = headGraphics.context;
  f.step(); assert.equal(f.trails.chunks[0], head); assert.equal(head.graphics, headGraphics); assert.equal(headGraphics.context, headContext);
  assert.equal(headContext.instructions.filter(instruction => instruction.action === 'stroke').length, head.marks.length);
  assert.equal(f.root.children.reduce((count, graphics) => count + graphics.context.instructions.filter(instruction => instruction.action === 'stroke').length, 0), 600,
    'trimmed marks disappear from the drawing as well as from its history');
  const retained = f.root.children.map(graphics => [graphics, graphics.context]);
  assert(retained.length > 0); drawingOrder(f);
  f.trails.clear();
  assert.equal(f.root.children.length, 0); assert.equal(f.trails.chunks.length, 0); assert.equal(f.trails.marks.length, 0);
  assert.equal(f.trails.previous.size, 0); assert.equal(f.trails.time, null);
  for (const [graphics, context] of retained) assert(graphics.destroyed && context.destroyed);
});

test('offscreen lots build on entry and paused pans preserve history, cached pictures and dust counts', t => {
  const f = scene(t, { width: 40 });
  for (let i = 0; i < 80; i++) f.step();
  const hidden = f.trails.chunks.filter(chunk => !chunk.graphics), marks = f.trails.marks.slice(), emitted = f.emissions.length,
    first = f.trails.chunks[0].graphics, picture = first.context.instructions[0];
  assert(hidden.length > 0);
  f.pan({ x: 12 }); assert(hidden.some(chunk => chunk.graphics?.visible)); assert.equal(first.visible, false); drawingOrder(f);
  f.pan({ x: 7 }); assert(f.trails.chunks[1].graphics.visible); drawingOrder(f);
  f.pan({ y: 500 }); assert(f.root.children.every(graphics => !graphics.visible));
  f.pan({ x: 2, y: 0 }); assert(first.visible); assert.equal(first.context.instructions[0], picture); drawingOrder(f);
  assert.deepEqual(f.trails.marks, marks); assert.equal(f.emissions.length, emitted);
});

test('interleaved sources 256 km apart retain small GPU coordinates and their actual world endpoints', t => {
  const f = scene(t, { positions: [128000, -128000], width: 40 });
  for (let i = 0; i < 30; i++) f.step();
  assert(f.trails.chunks.length > 2);
  for (const chunk of f.trails.chunks) for (const mark of chunk.marks)
    assert(Math.max(Math.abs(mark.a - chunk.x), Math.abs(mark.b - chunk.x), Math.abs(mark.y1 - chunk.y), Math.abs(mark.y2 - chunk.y)) <= 512);
  for (const x of [128003, -127997, 128003]) {
    f.pan({ x, y: f.terrain.height(x) }); drawingOrder(f);
    const visible = f.trails.chunks.filter(chunk => chunk.graphics?.visible); assert(visible.length > 0);
    for (const chunk of visible) {
      const gpu = new GpuGraphicsContext(); buildContextBatches(chunk.graphics.context, gpu);
      const values = gpu.geometryData.vertices, points = [];
      assert(values.length > 0 && values.every(value => Math.abs(value) < 513));
      for (let i = 0; i < values.length; i += 2) points.push({ x: chunk.graphics.x + Math.fround(values[i]), y: chunk.graphics.y + Math.fround(values[i + 1]) });
      for (const mark of chunk.marks) for (const [px, py] of [[mark.a, mark.y1], [mark.b, mark.y2]])
        assert(points.some(point => Math.hypot(point.x - px, point.y - py) < .02), 'float vertices stay beside the recorded contact');
    }
  }
});

test('translucent overlapping marks keep chronological colour, alpha and track strokes across lots', t => {
  const f = scene(t);
  for (let i = 0; i < 100; i++) {
    f.terrain.groundAt = () => ['sand', 'mud', 'soil'][i % 3];
    f.state.modules[0].kind = i % 2 ? 'wheel' : 'track';
    f.step(i % 2 ? -.2 : .2);
  }
  assert(f.trails.chunks.length >= 3); drawingOrder(f);
  const expected = f.trails.marks.flatMap(mark => [[mark.surface === 'sand' ? 0x917b4f : 0x3b412f, mark.surface === 'mud' ? .6 : .32, mark.track ? .032 : .022],
    ...(mark.track ? [[0x3b412f, .32, .013]] : [])]),
    painted = f.root.children.flatMap(graphics => graphics.context.instructions.filter(instruction => instruction.action === 'stroke')
      .map(instruction => { const style = instruction.data.style; return [style.color, style.alpha, style.width]; }));
  assert.deepEqual(painted, expected);
});
