import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { paintComponent, metalColor } from '../src/component-art.ts';
import { paintModuleCanvas } from '../src/textures.ts';
import { MACHINE_KINDS, machineCanvas, THRUSTER_NOZZLE } from '../src/machine-art.ts';
import { effectTilePixels, JET_ROOT, PLUME_RADIUS, CORE_RADIUS } from '../src/effect-art.ts';
import { Effects, thrusterJet } from '../src/effects.ts';
import { HeatHaze } from '../src/heat-haze.ts';
import { Renderer } from '../src/render.ts';
import { Terrain } from '../src/terrain.ts';
import { MODULES, METALS } from '../src/materials.ts';

// A context that keeps, in pixels of its canvas, the outline of everything filled with an opaque paint and the paint it
// was filled with: a colour, or the colours of a gradient's stops.
function recorder(width, height) {
  let m = [1, 0, 0, 1, 0, 0], subpaths = [], current = null, at = [0, 0];
  const saved = [], fills = [];
  const apply = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const multiply = (a, b, c, d, e, f) => {
    m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
  };
  const point = (x, y) => { if (!current) subpaths.push(current = []); current.push(apply(x, y)); at = [x, y]; };
  const gradient = () => { const stops = []; return { stops, addColorStop: (offset, color) => stops.push(color) }; };
  const alpha = color => typeof color === 'string' ? (color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1) : Math.min(...color.stops.map(alpha));
  const ctx = {
    canvas: { width, height }, fillStyle: '#000000',
    save() { saved.push(m); }, restore() { m = saved.pop(); },
    translate(x, y) { multiply(1, 0, 0, 1, x, y); }, scale(x, y) { multiply(x, 0, 0, y, 0, 0); },
    rotate(a) { multiply(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0); },
    beginPath() { subpaths = []; current = null; }, closePath() { current = null; },
    moveTo(x, y) { current = null; point(x, y); }, lineTo: point,
    quadraticCurveTo(cx, cy, x, y) {
      const [x0, y0] = at;
      for (let i = 1; i <= 8; i++) { const t = i / 8; point((1 - t) ** 2 * x0 + 2 * t * (1 - t) * cx + t * t * x, (1 - t) ** 2 * y0 + 2 * t * (1 - t) * cy + t * t * y); }
    },
    rect(x, y, w, h) { ctx.roundRect(x, y, w, h, 0); },
    roundRect(x, y, w, h, r = 0) {
      current = null;
      for (const [cx, cy, a] of [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]])
        for (let i = 0; i <= 4; i++) point(cx + Math.cos(a + i * Math.PI / 8) * r, cy + Math.sin(a + i * Math.PI / 8) * r);
      current = null;
    },
    arc(x, y, r, start, end) { for (let i = 0; i <= 24; i++) { const a = start + (end - start) * i / 24; point(x + Math.cos(a) * r, y + Math.sin(a) * r); } },
    ellipse() { throw new Error('an ellipse is a circle seen aslant'); },
    fill() { if (alpha(ctx.fillStyle) >= .5) fills.push({ polygons: subpaths.map(p => p.slice()), style: ctx.fillStyle }); },
    fillRect(x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); },
    clip() {}, stroke() {}, createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: text => ({ width: text.length * 7 }), fillText() {},
  };
  return { ctx, fills };
}
const inside = ([x, y], polygon) => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
// The thruster painted as the game paints it, on a canvas of its own shape, `scale` times its size.
function painted(scale, options = { metal: 'titanium' }) {
  const widthM = MODULES.thruster.width * scale, heightM = MODULES.thruster.height * scale, [width, height] = machineCanvas(widthM, heightM),
    record = recorder(width, height);
  paintComponent(record.ctx, 'thruster', widthM, heightM, options);
  const bounds = fill => { const xs = fill.polygons.flat().map(p => p[0]), ys = fill.polygons.flat().map(p => p[1]);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), foot: Math.max(...ys) }; };
  // What shows at a point: the last opaque paint laid over it.
  const shown = (u, v) => record.fills.findLast(fill => fill.polygons.some(polygon => inside([u * width, v * height], polygon)));
  return { ...record, width, height, perMetre: width / widthM, bounds, shown };
}
const stopsOf = fill => typeof fill.style === 'string' ? [fill.style] : fill.style.stops;
const hex = color => parseInt(color.slice(1, 7), 16);
const lightness = color => { const c = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)); return (Math.max(...c) + Math.min(...c)) / 510; };

test('the thruster is painted in its box by its own outline, the bell of its intake at the top and its nozzle at the foot', () => {
  assert(MACHINE_KINDS.has('thruster'));
  for (const scale of [.25, 1, 3.05]) {
    const art = painted(scale), { fills, width, height, bounds } = art, px = 1.5, name = `×${scale}`, all = fills.map(bounds);
    // Nothing goes out of the box; the lip reaches from side to side at its top, the nozzle its foot.
    assert(all.every(b => b.left >= -px && b.right <= width + px && b.top >= -px && b.foot <= height + px), name);
    assert(Math.min(...all.map(b => b.top)) < px && Math.max(...all.map(b => b.foot)) > height - px, name);
    assert(Math.min(...all.map(b => b.left)) < px && Math.max(...all.map(b => b.right)) > width - px, name);
    const lip = fills.filter((fill, i) => all[i].top < px && all[i].right - all[i].left > width * .97);
    assert(lip.length >= 1, `${name}: the lip of the bell spans the top`);
    // What reaches the foot is the nozzle: dark, about the middle and as wide as its exit.
    const foot = fills.filter((fill, i) => all[i].foot > height - px);
    assert(foot.length >= 1, name);
    for (const fill of foot) {
      const b = bounds(fill);
      assert(b.left > width * (.5 - THRUSTER_NOZZLE / 2) - px && b.right < width * (.5 + THRUSTER_NOZZLE / 2) + px, `${name}: ${b.left}…${b.right}`);
      const stops = stopsOf(fill);
      assert(stops.reduce((sum, color) => sum + lightness(color), 0) / stops.length < .3, `${name}: the nozzle is dark with the heat`);
    }
    assert(foot.some(fill => { const b = bounds(fill); return b.right - b.left > width * THRUSTER_NOZZLE - 2 * px; }), `${name}: the exit is as wide as the nozzle`);
    // It stands in the open: beside its nozzle and its bell the world shows; its middle is all engine.
    for (const [u, v] of [[.03, .97], [.97, .97], [.03, .1], [.97, .1]]) assert(!art.shown(u, v), `${name}: something at ${u}, ${v}`);
    for (const v of [.02, .1, .3, .5, .6, .8, .95]) assert(art.shown(.5, v), `${name}: nothing at the middle, ${v} down`);
  }
});

test('the thruster is of titanium: its metal takes the tone of it, its glass-fibre casing and its heat-tinted turbine and nozzle keep theirs', t => {
  const { titanium } = METALS, art = painted(1), turns = color => metalColor(hex(color), titanium.look) !== hex(color),
    // The light across a band round the axis: the lit stops in the middle of its gradient.
    lit = fill => stopsOf(fill).slice(2, 4);
  for (const [u, v, what] of [[.5, .02, 'the lip'], [.5, .62, 'the combustion chamber'], [.04, .515, 'a trunnion'], [.5, .127, 'a flange']]) {
    const fill = art.shown(u, v);
    assert(fill && stopsOf(fill).some(turns), what);
  }
  for (const [u, v, what] of [[.58, .3, 'the casing of glass fibre'], [.5, .79, 'the turbine'], [.5, .9, 'the nozzle']]) {
    const fill = art.shown(u, v);
    assert(fill && lit(fill).length && !lit(fill).some(turns), what);
  }
  // The texture turns what it paints to the tone of its metal: it reads its picture back for it.
  let read = 0;
  class Canvas {
    width = 1; height = 1;
    getContext() {
      return this.context ??= new Proxy({ canvas: this, measureText: () => ({ width: 0 }), getImageData: (x, y, w, h) => { read++; return { data: new Uint8ClampedArray(w * h * 4) }; },
        getTransform: () => ({}), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) },
      { get: (target, key) => key in target ? target[key] : () => {} });
    }
  }
  const old = ['document', 'HTMLCanvasElement'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'HTMLCanvasElement', { value: Canvas, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: () => new Canvas() } });
  t.after(() => { for (const [name, descriptor] of old) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  paintModuleCanvas('thruster', MODULES.thruster.width, MODULES.thruster.height, { metal: 'titanium' });
  assert(read > 0, 'the picture is read back and turned to titanium');
});

test('the nuts of its flanges keep their size on a bigger thruster: there are more of them, not bigger ones', () => {
  const nuts = scale => { const art = painted(scale); return art.fills.filter(fill => stopsOf(fill)[0] === '#c4c7af')
    .map(fill => { const b = art.bounds(fill); return (b.right - b.left) / art.perMetre; }); };
  const [one, two] = [nuts(1), nuts(2)];
  assert(two.length > one.length * 1.6, `${one.length} nuts, then ${two.length}`);
  assert.equal(Math.max(...two).toFixed(4), Math.max(...one).toFixed(4));
});

const thruster = (more = {}) => ({ kind: 'thruster', width: MODULES.thruster.width, height: MODULES.thruster.height, thrust: 1, health: 1, x: 10, y: 5, angle: 0, ...more });
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) < tolerance;

test('the jet leaves the nozzle along the thruster\'s own downward axis, as long as its thrust, and none from one stopped, destroyed or torn off', () => {
  const full = thrusterJet(thruster()), half = thrusterJet(thruster({ thrust: .5 })), little = thrusterJet(thruster({ thrust: .1 }));
  assert(full.length > 1 && near(half.length, full.length / 2) && near(little.length, full.length / 10));
  assert(near(half.core, full.core / 2) && near(half.thrust, .5));
  assert(near(full.nozzle, MODULES.thruster.width * THRUSTER_NOZZLE) && near(half.nozzle, full.nozzle), 'as wide as the exit whatever the thrust');
  for (const more of [{ thrust: 0 }, { thrust: undefined }, { thrust: -1 }, { health: 0 }, { health: -3 }, { attached: false }, { kind: 'engine' }])
    assert.equal(thrusterJet(thruster(more)), null, JSON.stringify(more));
  const h = MODULES.thruster.height / 2;
  for (const [angle, dx, dy] of [[0, 0, -1], [Math.PI / 2, 1, 0], [Math.PI, 0, 1], [-Math.PI / 4, -Math.SQRT1_2, -Math.SQRT1_2]]) {
    const jet = thrusterJet(thruster({ angle }));
    assert(near(jet.dx, dx) && near(jet.dy, dy), `${angle}: ${jet.dx}, ${jet.dy}`);
    assert(near(jet.x, 10 + dx * h) && near(jet.y, 5 + dy * h), `${angle}: out of the foot of the piece`);
    assert(near(Math.cos(jet.angle), dx) && near(Math.sin(jet.angle), dy));
  }
  // Where the piece is shown is told apart from what it is.
  const placed = thrusterJet(thruster(), { x: -4, y: 2, angle: Math.PI });
  assert(near(placed.x, -4) && near(placed.y, 2 + h) && near(placed.dy, 1));
});

test('the jet stops where it meets the ground, and tells where', () => {
  const flat = { height: () => 0 }, high = thrusterJet(thruster({ y: 20 }), undefined, flat), low = thrusterJet(thruster({ y: 2 }), undefined, flat);
  assert.equal(high.contact, null); assert(near(high.length, high.reach));
  const clearance = 2 - MODULES.thruster.height / 2;
  assert(low.contact && near(low.length, clearance, .02) && near(low.contact.y, 0, .02) && near(low.contact.x, 10) && near(low.contact.slope, 0));
  assert(low.reach > low.length && low.core <= low.length);
  const buried = thrusterJet(thruster({ y: .3 }), undefined, flat);
  assert.equal(buried.length, 0); assert.equal(buried.contact.distance, 0);
  // Turned up, it never meets the ground under it.
  assert.equal(thrusterJet(thruster({ y: 2, angle: Math.PI }), undefined, flat).contact, null);
});

function effects(t) {
  const white = Texture.WHITE, parent = new Container(), atlas = { smoke: Array(8).fill(white), fire: Array(4).fill(white), spark: white,
    dust: white, muzzle: white, glow: white, shockwave: white, plume: [white, white, white], jetcore: white }, fx = new Effects(parent, atlas);
  t.after(() => { fx.clear(); parent.destroy({ children: true }); });
  return fx;
}

test('a jet is drawn in the layer it is given, turned along it, as long and as bright as its thrust, and goes with it', t => {
  const fx = effects(t), jets = fx.jets, layer = new Container(), full = thrusterJet(thruster()), half = thrusterJet(thruster({ thrust: .5 }));
  const frame = jet => { jets.begin(); jets.draw('a:1:t', layer, jet); jets.end(); return jets.jets.get('a:1:t'); };
  const one = frame(full), { group, plume, core, glow } = one, before = { length: plume.width, alpha: plume.alpha, core: core.width, glow: glow.alpha };
  assert.equal(group.parent, layer); assert(group.visible);
  assert(near(group.x, full.x) && near(group.y, full.y) && near(group.rotation, full.angle));
  assert(plume.width > full.length * .96 && plume.width <= full.length + 1e-9);
  assert(near(plume.height * PLUME_RADIUS, full.nozzle, 1e-6) && near(core.height * CORE_RADIUS, full.nozzle, 1e-6), 'the jet is as wide as the nozzle where it leaves it');
  assert.deepEqual(jets.heat, [full]);
  frame(half);
  assert(near(plume.width, before.length / 2, 1e-9) && near(plume.alpha, before.alpha / 2, 1e-9) && near(core.width, before.core / 2, 1e-9) && near(glow.alpha, before.glow / 2, 1e-9));
  // Stopped, it shows nothing and is kept; no longer drawn, it is gone.
  frame(null);
  assert.equal(group.visible, false); assert.equal(jets.jets.get('a:1:t'), one); assert.deepEqual(jets.heat, []);
  jets.begin(); jets.end();
  assert(!jets.jets.has('a:1:t') && group.destroyed);
  // One its construction does not draw stays as it was.
  frame(full); jets.begin(); jets.keep('a:1:t'); jets.end();
  assert(jets.jets.get('a:1:t').group.visible);
});

test('the renderer draws each jet in the layer of its thruster, keeps that of a construction it does not draw, and none for a wreck', t => {
  const fx = effects(t), layers = id => ({ moduleLayer: new Container(), outsideLayer: new Container(), still: id === 'wreck' }),
    actorLayers = new Map(['a', 'b', 'wreck'].map(id => [id, layers(id)])),
    modules = [thruster({ id: 'a:1', actorId: 'a' }), thruster({ id: 'a:2', actorId: 'a', exposed: true }), thruster({ id: 'b:1', actorId: 'b', angle: 1 }),
      thruster({ id: 'w:1', actorId: 'wreck' }), { id: 'a:3', actorId: 'a', kind: 'engine', x: 0, y: 0 }],
    view = { effects: fx, actorLayers, unseen: new Set(), scene: { pose: id => modules.find(m => m.id === id) }, ground: null },
    draw = state => Renderer.prototype.drawThrusterJets.call(view, state), jet = id => fx.jets.jets.get(id);
  draw({ modules });
  assert.equal(jet('a:1').group.parent, actorLayers.get('a').moduleLayer, 'within the hull, under its skin');
  assert.equal(jet('a:2').group.parent, actorLayers.get('a').outsideLayer, 'out in the open, over it');
  assert(near(jet('b:1').group.rotation, thrusterJet(modules[2]).angle));
  assert.equal(jet('w:1'), undefined); assert.equal(fx.jets.heat.length, 3);
  view.unseen.add('b'); draw({ modules });
  assert(jet('b:1').group.visible, 'kept as it was'); assert.equal(fx.jets.heat.length, 2);
  draw(null);
  assert.equal(fx.jets.jets.size, 0); assert.equal(fx.jets.heat.length, 0);
});

test('a jet that meets the ground splashes there and blows its dust out to both sides, as the time of the effects goes by', t => {
  const fx = effects(t), terrain = new Terrain('sand'), layer = new Container(), x = 30;
  fx.terrain = terrain;
  const jet = thrusterJet(thruster({ x, y: terrain.height(x) + 1.2 }), undefined, terrain), frame = () => { fx.jets.begin(); fx.jets.draw('t', layer, jet); fx.jets.end(); };
  assert(jet.contact);
  frame();
  assert(fx.jets.jets.get('t').splash.visible);
  assert.equal(fx.particles.length, 0, 'no time has gone by');
  fx.jets.update(.5); frame();
  const dust = fx.particles.filter(p => p.groundDust);
  assert(dust.length >= 3, `${dust.length} puffs`);
  assert(dust.some(p => p.vx < 0) && dust.some(p => p.vx > 0));
  frame();
  assert.equal(fx.particles.filter(p => p.groundDust).length, dust.length, 'the time is spent once');
  // High over the ground it neither splashes nor blows.
  const high = thrusterJet(thruster({ x, y: terrain.height(x) + 40 }), undefined, terrain);
  fx.jets.update(.5); fx.jets.begin(); fx.jets.draw('t', layer, high); fx.jets.end();
  assert.equal(fx.jets.jets.get('t').splash.visible, false); assert.equal(fx.particles.filter(p => p.groundDust).length, dust.length);
});

test('the air shimmers along a jet from its nozzle, within the budget of the quality', t => {
  const air = new HeatHaze(), camera = { x: 10, y: 4, width: 1280, height: 720, zoom: 130 };
  t.after(() => air.destroy());
  for (const angle of [0, Math.PI / 2, Math.PI / 4]) {
    const jet = { ...thrusterJet(thruster({ angle })), seed: 2 }, [source] = air.collect({ jets: { heat: [jet] } }, camera);
    assert.equal(source.mode, 0);
    // The column's own upward axis lies along the jet, from its nozzle out past the end of its plume.
    assert(near(-Math.sin(source.rotation), jet.dx) && near(Math.cos(source.rotation), jet.dy));
    assert(near(source.x - source.ry * jet.dx, jet.x) && near(source.y - source.ry * jet.dy, jet.y));
    assert(source.ry * 2 > jet.length && source.rx < jet.nozzle && source.strength > 0);
  }
  const jets = Array.from({ length: 12 }, (_, i) => thrusterJet(thruster({ x: 4 + i })));
  assert.equal(air.collect({ quality: 'high', jets: { heat: jets } }, camera).length, 8);
  assert.equal(air.collect({ quality: 'balanced', jets: { heat: jets } }, camera).length, 4);
  assert.equal(air.collect({ quality: 'low', jets: { heat: jets } }, camera).length, 0);
  // The flames come first, and the jets share their columns: never more than the buffers hold.
  const burns = Array.from({ length: 22 }, (_, i) => ({ key: 'burn:w:' + i, x: 8 + i % 5, y: .7, size: 1.25, age: .04, life: .16, strength: .22, effectActorId: 'w' })),
    waves = Array.from({ length: 12 }, () => ({ age: .08, displayAge: .075, life: .2, frontRadius: 2.1, opacity: .18, refraction: 1, displayAlpha: .17,
      sprite: { visible: true, x: 10, y: 3, width: 5.25, height: .735, alpha: .17, rotation: 0 } })),
    sources = air.collect({ quality: 'high', lights: burns, jets: { heat: jets }, blastWaves: { waves } }, camera);
  assert.equal(sources.filter(source => source.mode === 0 && source.actorId === null).length, 2);
  assert.equal(sources.length, 32); assert.doesNotThrow(() => air.writeGeometry());
});

const SIZE = 128, alphaAt = (data, x, y) => data[(y * SIZE + x) * 4 + 3],
  across = (data, x, least = 32) => Array.from({ length: SIZE }, (_, y) => alphaAt(data, x, y)).filter(a => a > least).length;
test('the non-afterburning jet leaves the nozzle at its width and disperses without an orange flame', () => {
  const root = Math.round(JET_ROOT * SIZE);
  for (let variant = 0; variant < 3; variant++) {
    const plume = effectTilePixels('plume', variant);
    for (let x = 0; x < root - 1; x++) assert.equal(across(plume, x, 0), 0, 'nothing behind the nozzle');
    const born = across(plume, root + 6);
    assert(Math.abs(born - PLUME_RADIUS * SIZE) < SIZE * .12, `${born} px where it leaves the nozzle`);
    assert(across(plume, 70, 8) > born * 1.3, 'the gas mixed with the air spreads');
    assert(across(plume, 90, 100) < across(plume, root + 6, 100) / 2, 'the hot tongue closes');
    for (let i = 0; i < plume.length; i += 4) if (plume[i + 3] > 32)
      assert(plume[i + 2] >= plume[i] && plume[i + 2] >= plume[i + 1], 'pale gas rather than an afterburner');
    assert(alphaAt(plume, root + 10, 64) > alphaAt(plume, 110, 64) * 2 && across(plume, 124, 8) === 0, 'and thins to nothing');
  }
  const core = effectTilePixels('jetcore');
  assert(Math.abs(across(core, root + 4) - CORE_RADIUS * SIZE) < SIZE * .15);
  assert(across(core, 40) > across(core, 100) * 2 && across(core, 120) < 10, 'a cone that closes');
  for (let i = 0; i < core.length; i += 4) if (core[i + 3] > 32) assert(core[i + 2] >= core[i] && core[i + 2] >= core[i + 1], 'pale and bluish');
});

test('jets fade between cached frames nearby, simplify on low quality and do no work below a pixel', t => {
  const fx = effects(t), layer = new Container(), jet = thrusterJet(thruster()),
    frame = zoom => { fx.jets.begin(); fx.jets.draw('lift', layer, jet, zoom); fx.jets.end(); };
  frame(.1);
  assert.equal(fx.jets.jets.size, 0); assert.equal(fx.jets.heat.length, 0);
  frame(100);
  const entry = fx.jets.jets.get('lift'), sprite = entry.plume, before = sprite.alpha;
  assert(entry.plumeNext.visible && entry.plumeNext.alpha > 0 && fx.jets.heat.length === 1);
  fx.jets.update(1 / 60); frame(100);
  assert.equal(entry.plume, sprite); assert.notEqual(sprite.alpha, before);
  frame(.1);
  assert(!entry.group.visible); assert.equal(fx.jets.heat.length, 0);
  fx.quality = 'low'; frame(100);
  assert(entry.group.visible && !entry.plumeNext.visible); assert.equal(fx.jets.heat.length, 0);
});
