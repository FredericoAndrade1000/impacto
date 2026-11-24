import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.ts';
import { SquadMarks } from '../src/squad-marks.ts';
import { Terrain } from '../src/terrain.ts';

function scene(t, ground) {
  const before = globalThis.document, nodes = [];
  const create = tag => {
    const node = { tag, attributes: {}, children: [], writes: 0,
      append(child) { child.parent = this; this.children.push(child); },
      setAttribute(key, value) { this.attributes[key] = String(value); this.writes++; },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } };
    nodes.push(node); return node;
  };
  globalThis.document = { createElementNS: (_, tag) => create(tag) };
  t.after(() => { globalThis.document = before; });
  const root = create('svg'), marks = new SquadMarks(root), camera = new Camera(1000, 600), reading = { id: 'radar', x: 0, y: 2, range: 8000 };
  camera.x = 0; camera.y = 4000; camera.zoom = .05;
  const draw = () => { marks.begin(camera); marks.radar(reading, camera, ground); marks.end(); };
  const part = name => marks.marks.get('radar\0radar')?.parts.get(name)?.node.attributes;
  return { root, marks, camera, reading, draw, part, nodes };
}
const points = path => [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => ({ x: +x, y: +y }));
const crest = () => {
  const ground = new Terrain('hills');
  for (const p of ground.points) p.y = p.x >= 40 && p.x <= 80 ? (p.x < 60 ? p.x - 40 : 80 - p.x) * 1.5 : 0;
  return ground;
};

test('the selected radar guide stops at a real crest and shows the rising shadow above it', t => {
  const ground = crest(), before = JSON.stringify(ground.snapshot()), f = scene(t, ground); f.draw();
  const end = points(f.part('reach').d).at(-1), worldEnd = f.camera.toWorld(end.x, end.y);
  assert(worldEnd.x > 40 && worldEnd.x < 44, 'the level guide reaches the facing slope, not ground behind the crest');
  assert(Math.abs(worldEnd.y - 2) < 1.1);
  assert.equal(f.root.children[0].attributes['data-terrain'], 'true');
  assert.equal(f.part('terrain').class, 'arc', 'the terrain boundary uses the same faint dotted stroke as the range arc');
  const boundary = points(f.part('terrain').d).map(p => f.camera.toWorld(p.x, p.y));
  assert(boundary.some(p => p.x > 2000 && p.y > 1000), 'a crest hides low targets, while the air above its shadow remains covered');
  assert(f.marks.radarGround.figure.paths.flat().every(p => p.y >= 2 && p.y + 1e-6 >= ground.height(p.x)), 'the guide never continues under the surface');
  const arc = points(f.part('arc').d).map(p => f.camera.toWorld(p.x, p.y));
  assert(arc.filter(p => p.x > 0).every(p => (p.y - 2) / p.x > .44), 'the nominal circle is cut below the crest horizon');
  assert.equal(JSON.stringify(ground.snapshot()), before, 'the range illustration cannot change terrain or sensor rules');
});

test('flat terrain preserves the nominal upper range and never closes the visible sky', t => {
  const f = scene(t, new Terrain('flat')); f.draw();
  assert.equal(f.part('terrain').d, '');
  const reach = points(f.part('reach').d).map(p => f.camera.toWorld(p.x, p.y));
  assert.deepEqual(reach.map(p => p.x), [-8000, 8000]);
  assert(points(f.part('arc').d).some(p => Math.abs(f.camera.toWorld(p.x, p.y).y - 8002) < 1.1));
});

test('an instrument high over the ground has its whole circle where the ground leaves it open, down to the ground', t => {
  const f = scene(t, new Terrain('flat')), world = name => points(f.part(name)?.d || '').map(p => f.camera.toWorld(p.x, p.y));
  // On the ground the circle is cut at the ground at once: nothing of it under the level shows.
  f.draw(); assert(world('arc').every(p => p.y > -25), 'a radar on the ground draws nothing under the ground');
  // Two kilometres up the circle goes on under the level to each side as far down as the ground, 7.75 km off, and
  // the vertical reach from the ground under it up to the top of the circle. No line along the ground: the ground is drawn.
  f.reading.y = 2000; f.draw();
  const arc = world('arc'), off = Math.sqrt(8000 ** 2 - 2000 ** 2);
  assert(arc.every(p => p.y > -25 && Math.abs(Math.hypot(p.x, p.y - 2000) - 8000) < 25), 'the circle, over the ground');
  for (const side of [-1, 1]) assert(arc.some(p => Math.sign(p.x) === side && p.y < 100 && Math.abs(Math.abs(p.x) - off) < 60), 'down to where it meets the ground');
  assert.equal(f.part('terrain').d, '');
  const rise = world('rise'); assert(Math.abs(rise[0].y) < 25 && Math.abs(rise[0].x) < 25, 'the vertical reach stands on the ground under it');
  // Higher over the ground than it reaches: all of the circle, and a tick at its foot.
  f.reading.y = 9000; f.camera.y = 6000; f.draw();
  const whole = world('arc');
  assert(whole.some(p => p.y < 1100 && Math.abs(p.x) < 200), 'the foot of the circle, a kilometre over the ground');
  assert(world('limits').some(p => Math.abs(p.y - 1000) < 25), 'with its own tick');
});

test('camera motion only reprojects the cached horizon, with bounded SVG work at mobile and desktop zooms', t => {
  const ground = crest(), height = ground.height.bind(ground); let heights = 0;
  ground.height = x => { heights++; return height(x); };
  ground.raycast = () => { throw new Error('A radar guide must not cast terrain rays during a frame'); };
  const f = scene(t, ground); f.draw(); const initial = heights, contour = f.marks.radarGround, count = f.nodes.length;
  assert(initial < 5000, 'one sweep covers the eight-kilometre range on both sides');
  for (const [width, height] of [[667, 375], [1600, 900]]) for (const zoom of [.025, .05, .1, 1, 12, 250]) {
    f.camera.width = width; f.camera.height = height; f.camera.zoom = zoom;
    f.camera.x = 60; f.camera.y = zoom > .1 ? 30 : 1500; f.draw();
    assert.equal(f.marks.radarGround, contour, 'pan and zoom never resweep terrain');
    assert.equal(f.nodes.length, count);
    for (const name of ['arc', 'terrain', 'reach', 'rise', 'limits']) {
      const path = f.part(name)?.d || '';
      assert(path.length < 6500 && !/NaN|Infinity/.test(path));
      assert(points(path).length <= 202, 'at most 96 arc chords and 98 terrain chords reach SVG');
      for (const p of points(path)) assert(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height);
    }
  }
  assert(heights <= initial + 12, 'each pan reads only whether the instrument is above its local surface');
  f.camera.x = 0; f.camera.y = 2; f.camera.zoom = 10;
  f.reading.x = 1; f.reading.y = 2.2; f.draw(); assert.equal(f.marks.radarGround, contour);
  const origin = f.camera.toScreen(1, 2.2);
  assert.deepEqual([+f.part('origin').cx, +f.part('origin').cy], [origin.x, origin.y], 'the origin follows the interpolated vehicle while the terrain cache is retained');
  assert.deepEqual([f.marks.radarGround.figure.x, f.marks.radarGround.figure.y], [1, 2.2], 'the shadow contour is also refitted to the moving origin');
  f.camera.x = 41.5; f.camera.y = 2.2; f.camera.zoom = 250; f.draw();
  const end = points(f.part('reach').d).at(-1), expected = f.camera.toScreen(40 + 2.2 / 1.5, 2.2);
  assert(Math.hypot(end.x - expected.x, end.y - expected.y) <= .1, 'even at zoom 250 the terrain endpoint follows current height within a tenth of a pixel');
  f.reading.x = 3; f.draw(); assert.notEqual(f.marks.radarGround, contour, 'vehicle travel refreshes the horizon at the same slack as optical fog');
});

test('a changed map and a changed instrument refresh the guide, and buried equipment draws no coverage', t => {
  const ground = crest(), f = scene(t, ground); f.draw(); const first = f.marks.radarGround;
  ground.points = ground.points.map(p => ({ ...p, y: 0 })); f.draw();
  assert.notEqual(f.marks.radarGround, first); assert.equal(f.part('terrain').d, '');
  const flat = f.marks.radarGround; f.reading.range = 4000; f.draw(); assert.notEqual(f.marks.radarGround, flat);
  f.reading.y = -.1; f.draw(); assert.equal(f.root.children.length, 0);
});

test('the horizon follows the exact landscape polyline at distant negative and positive world positions', t => {
  const ground = new Terrain('world', { seed: 711, length: 512000 }), f = scene(t, ground);
  for (const x of [-126000.3, -125100.9, -11.7, 124000.1, 125000.6]) {
    const y = ground.height(x) + 3;
    for (const shift of [0, 1]) {
      f.reading.x = x + shift; f.reading.y = y + shift * .2; f.camera.x = x; f.draw();
      for (const point of f.marks.radarGround.figure.paths.flat()) {
        const hit = ground.raycast(f.reading, point);
        if (point.blocked) assert(hit && Math.abs(hit.enter - 1) < 1e-5, 'a contour endpoint meets the first actual ground segment');
        else assert(!hit || hit.enter >= .99999, 'the arc never crosses ground before reaching eight kilometres');
      }
    }
  }
});
