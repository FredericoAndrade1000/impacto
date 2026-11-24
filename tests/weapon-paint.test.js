import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Texture } from 'pixi.js';
import { WEAPON_FAMILIES, WEAPON_PRESETS, weaponMountSize } from '../src/weapons.ts';
import { weaponBarrelProfile } from '../src/weapon-geometry.ts';
import { TUBE_FITTINGS, tubeFittings } from '../src/weapon-fittings.ts';
import { arsenalScale, weaponCanvas, weaponFlip, weaponLayout, weaponPartBounds } from '../src/weapon-paint.ts';
import { WeaponSprites } from '../src/weapon-sprites.ts';
import { weaponContains, weaponShapes } from '../src/weapon-art.ts';
import { ConstructionUI } from '../src/construction-ui.ts';

const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const COLOUR = /^(#[0-9a-f]{6}([0-9a-f]{2})?|rgba\((\d{1,3},){3}(0|1|0?\.\d+)\))$/;
const PRESETS = Object.keys(WEAPON_PRESETS);
// A compact fixture for receiver, tube, fixed feet and two protection facets. Production
// projects export a variable number of convex facets from the curved shield.
const solids = (id, end = weaponBarrelProfile({ weaponPreset: id }).end) => {
  const { radius } = weaponBarrelProfile({ weaponPreset: id }), shield = Math.min(.4, end);
  return [rect(-.9, -.24, 0, .24), rect(.1, -radius, end, radius),
    rect(-.26, .7, .26, .74), rect(-.26, -.74, .26, -.7),
    rect(.12, -radius - .2, shield, -radius - .01), rect(.12, radius + .01, shield, radius + .2)];
};
// Exact native paths on the painter's canvas, whose y runs down. A null closes
// each material contour; empty gaps are never replaced by bounding rectangles.
const cut = polygons => polygons.flatMap(poly => [...poly.map(p => [p.x, -p.y]), null]);

// A canvas that draws nothing, refuses any value a real one would reject or silently drop, and keeps the calls made to
// it and, under the transforms in force, the extent of all it paints, in canvas pixels: a filled shape to its outline,
// a stroked one as far as half its line reaches past it.
function recorder() {
  const calls = [], clips = [], extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let matrix = [1, 0, 0, 1, 0, 0], path = [], lineWidth = 1, clipPath = [];
  const stack = [];
  const numbers = (name, values) => values.forEach(value =>
    typeof value === 'number' && assert(Number.isFinite(value), `${name} received ${value}`));
  const colour = (name, value) => typeof value === 'string' && assert.match(value, COLOUR, name);
  const gradient = { addColorStop(at, value) { numbers('addColorStop', [at]); colour('gradient stop', value); } };
  const multiply = ([a, b, c, d, e, f]) => { const [A, B, C, D, E, F] = matrix; matrix = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F]; };
  const point = (x, y) => { const [a, b, c, d, e, f] = matrix; path.push([a * x + c * y + e, b * x + d * y + f, Math.hypot(a, b)]); };
  const paint = (stroked = false) => {
    for (const [px, py, scale] of path) {
      const reach = stroked ? lineWidth * scale / 2 : 0;
      extent.x0 = Math.min(extent.x0, px - reach); extent.x1 = Math.max(extent.x1, px + reach);
      extent.y0 = Math.min(extent.y0, py - reach); extent.y1 = Math.max(extent.y1, py + reach);
    }
  };
  const box = (x, y, w, h) => { for (const [u, v] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) point(u, v); };
  const shapes = {
    moveTo: (x, y) => point(x, y), lineTo: (x, y) => point(x, y),
    quadraticCurveTo: (cx, cy, x, y) => { point(cx, cy); point(x, y); },
    bezierCurveTo: (ax, ay, bx, by, x, y) => { point(ax, ay); point(bx, by); point(x, y); },
    roundRect: (x, y, w, h) => box(x, y, w, h), rect: (x, y, w, h) => box(x, y, w, h),
    fillRect: (x, y, w, h) => { path = []; box(x, y, w, h); paint(); path = []; },
    beginPath: () => { path = []; }, fill: () => paint(), stroke: () => paint(true),
    arc: (x, y, r) => box(x - r, y - r, 2 * r, 2 * r), ellipse: (x, y, rx, ry) => box(x - rx, y - ry, 2 * rx, 2 * ry),
  };
  const transforms = {
    save: () => stack.push(matrix), restore: () => { matrix = stack.pop(); },
    setTransform: (...m) => { matrix = m; }, transform: (...m) => multiply(m),
    translate: (x, y) => multiply([1, 0, 0, 1, x, y]), scale: (x, y) => multiply([x, 0, 0, y, 0, 0]),
    rotate: angle => multiply([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]),
  };
  const ctx = new Proxy({}, {
    get: (_, name) => (...values) => {
      numbers(name, values); calls.push([name, ...values.map(v => typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : typeof v)]);
      if (name === 'beginPath') clipPath = [];
      if (name === 'moveTo' || name === 'lineTo') clipPath.push(values);
      if (name === 'closePath') clipPath.push(null);
      if (name === 'clip') clips.push(clipPath.slice());
      shapes[name]?.(...values); transforms[name]?.(...values);
      if (name === 'measureText') return { width: 10 * values[0].length };
      return name === 'createLinearGradient' || name === 'createRadialGradient' ? gradient : undefined;
    },
    set: (_, name, value) => {
      if (name === 'fillStyle' || name === 'strokeStyle') colour(name, value);
      if (name === 'lineWidth') { assert(value > 0 && Number.isFinite(value)); lineWidth = value; }
      calls.push([name, typeof value === 'object' ? 'gradient' : value]);
      return true;
    },
  });
  return { ctx, calls, clips, extent, create: (width, height) => ({ width, height, getContext: () => ctx }) };
}
// The extent a recorder saw, in the weapon's own metres: its pivot at the painted origin, +y up.
const metres = (art, painted) => ({ x0: (art.extent.x0 - painted.originX) / painted.scale, x1: (art.extent.x1 - painted.originX) / painted.scale,
  y0: (painted.originY - art.extent.y1) / painted.scale, y1: (painted.originY - art.extent.y0) / painted.scale });

test('every catalogue weapon is laid out from its own receiver and barrel, paints with finite geometry and reaches exactly its muzzle', () => {
  for (const id of PRESETS) {
    const L = weaponLayout(id), art = recorder(), painted = weaponCanvas(L, 'all', { create: art.create }),
      box = weaponPartBounds(L), { width, height } = weaponMountSize(id);
    assert.equal(L.mounted, false); assert.equal(L.family, WEAPON_PRESETS[id].family);
    assert.deepEqual(L.receiver, { x0: -width, x1: 0, y0: -height / 2, y1: height / 2 }, `${id} lies on the bench from its receiver`);
    assert.equal(box.x1, weaponBarrelProfile({ weaponPreset: id }).end, id);
    assert(art.calls.filter(([name]) => name === 'fill' || name === 'stroke').length >= 30, `${id} is drawn as more than plain boxes`);
    assert(!art.calls.some(([name]) => name === 'clip'), 'free artwork is not clipped');
    // The pivot lands inside the bitmap and the bitmap covers the whole weapon, as fine as a texture may be.
    assert(painted.originX > 0 && painted.originX < painted.canvas.width, id);
    assert(painted.originY > 0 && painted.originY < painted.canvas.height, id);
    assert(painted.canvas.width >= (box.x1 - box.x0) * painted.scale, id);
    assert(painted.scale <= 900 && Math.max(painted.canvas.width, painted.canvas.height) <= 2048 + 4, id);
  }
});

test('the fittings of each gun stand at their real distances within its tube, and those past its muzzle are left out', () => {
  for (const id of PRESETS) {
    const table = TUBE_FITTINGS[id], real = Math.max(...table.fittings.map(f => f.to)) + table.muzzle.length;
    for (const barrel of [weaponBarrelProfile({ weaponPreset: id }).end, real, Math.max(.2, real * .5), .4]) {
      const { muzzle, fittings } = tubeFittings(id, barrel, .1);
      assert.equal(muzzle.to, barrel, `${id} ${barrel}: the muzzle device ends at the muzzle`);
      assert(muzzle.from > .1 && muzzle.to - muzzle.from <= table.muzzle.length + 1e-12, `${id} ${barrel}`);
      for (const f of fittings) {
        assert(f.from >= .1 && f.from < f.to && f.to <= muzzle.from + 1e-9, `${id} ${barrel}: ${f.kind} stands within the tube`);
        const own = table.fittings.find(g => g.kind === f.kind && g.to === f.to);
        assert(own && (own.from === f.from || f.from === .1), `${id}: ${f.kind} keeps its real place, cut only where the tube begins`);
      }
      assert.deepEqual(fittings.map(f => f.to), table.fittings.filter(f => f.to > .1 && f.to <= muzzle.from + 1e-9).map(f => f.to), `${id} ${barrel}: none other is left out`);
    }
    // On the real barrel every fitting is there, and painted where it stands, within the tube's own solid.
    assert.equal(tubeFittings(id, real, 0).fittings.length, table.fittings.length, id);
    const art = recorder(), L = weaponLayout(id, solids(id, real)), painted = weaponCanvas(L, 'moving', { create: art.create }), seen = metres(art, painted);
    assert(seen.x0 >= L.tube.x0 - .002 && seen.x1 <= Math.max(real, ...L.mantlets.map(m => m.x1)) + .002, `${id} on its real barrel paints from ${seen.x0} to ${seen.x1}`);
  }
  // The 120 mm gun: its evacuator 1.75 to 2.51 m from the trunnion shows on a barrel of 4.25 m, and not on one of 1.8 m.
  assert(tubeFittings('rh120', 4.25).fittings.some(f => f.kind === 'evacuator'));
  assert(!tubeFittings('rh120', 1.8).fittings.some(f => f.kind === 'evacuator'));
  // Painted, the tube and what it carries stand between the trunnion and the muzzle.
  for (const id of PRESETS) {
    const L = weaponLayout(id), art = recorder(), painted = weaponCanvas(L, 'moving', { create: art.create }), seen = metres(art, painted);
    assert(seen.x0 >= -.002 && seen.x1 <= L.b + .002, `${id} paints its tube from ${seen.x0} to ${seen.x1}`);
    assert(seen.y0 >= -L.r - L.proud.down - .004 && seen.y1 <= L.r + L.proud.up + .004, `${id} stands proud by its fittings only`);
  }
});

test('each receiver is drawn inside its own box, the solid the mechanism is', () => {
  for (const id of PRESETS) for (const L of [weaponLayout(id), weaponLayout(id, solids(id))]) {
    const art = recorder(), painted = weaponCanvas(L, 'receiver', { create: art.create }), seen = metres(art, painted), box = L.receiver;
    const slack = .002 + 1 / painted.scale;
    assert(seen.x0 >= box.x0 - slack && seen.x1 <= box.x1 + slack, `${id}: ${seen.x0}..${seen.x1} along ${box.x0}..${box.x1}`);
    assert(seen.y0 >= box.y0 - slack && seen.y1 <= box.y1 + slack, `${id}: ${seen.y0}..${seen.y1} across ${box.y0}..${box.y1}`);
  }
});

test('no gun carries lettering, which a mount pointing the other way would show mirrored', () => {
  for (const id of PRESETS) for (const polygons of [null, solids(id)]) {
    const art = recorder(); weaponCanvas(weaponLayout(id, polygons, -1), 'all', { create: art.create });
    assert(!art.calls.some(([name]) => name === 'fillText' || name === 'strokeText'), id);
  }
  for (const id of ['m2hb', 'fnmag', 'minimi', 'mk19']) {
    const { end, radius } = weaponBarrelProfile({ weaponPreset: id }), art = recorder();
    weaponCanvas(weaponLayout(id, [rect(-.564, -.04, 0, .04), rect(0, -radius, end, radius), rect(-.52, -.12, 0, .12), rect(0, -.06, .096, .06)], 1, 0, true), 'moving', { create: art.create });
    assert(!art.calls.some(([name]) => name === 'fillText' || name === 'strokeText'), id);
  }
});

test('a gun is painted the same every time', t => {
  const random = Math.random;
  Math.random = () => assert.fail('the picture does not depend on chance');
  t.after(() => { Math.random = random; });
  for (const id of PRESETS) for (const polygons of [null, solids(id)]) {
    const first = recorder(), second = recorder();
    weaponCanvas(weaponLayout(id, polygons), 'all', { create: first.create }); weaponCanvas(weaponLayout(id, polygons), 'all', { create: second.create });
    assert.deepEqual(second.calls, first.calls, id);
  }
});

test('mounted weapons paint only inside their native material contours', () => {
  for (const id of PRESETS) {
    const polygons = solids(id), before = structuredClone(polygons), L = weaponLayout(id, polygons);
    assert.equal(L.mounted, true); assert.equal(L.mantlets.length, 2);
    assert.deepEqual(weaponPartBounds(L, 'receiver'), L.receiver);
    const moving = weaponPartBounds(L, 'moving');
    assert.equal(moving.x0, .1); assert.equal(moving.x1, L.b);
    assert.equal(moving.y0, L.tube.y0); assert.equal(moving.y1, L.tube.y1);
    for (const [part, contours] of [['receiver', [[L.contours.receiver]]], ['moving', [[L.contours.tube]]], ['cradle', [L.contours.mantlets]]]) {
      const art = recorder(); weaponCanvas(L, part, { create: art.create });
      assert.equal(art.calls.filter(([name]) => name === 'clip').length, contours.length, `${id} ${part}`);
      assert.deepEqual(art.clips, contours.map(cut));
    }
    assert.deepEqual(polygons, before, 'native geometry is read, never edited');
  }
});

test('a mounted recoil cradle paints an open full-stroke slide and a fixed shield with finite geometry', () => {
  for (const [id, model] of Object.entries(WEAPON_PRESETS)) if (model.recoil > 0) for (const flip of [1, -1]) {
    const L = weaponLayout(id, solids(id), flip, model.recoil), art = recorder(),
      painted = weaponCanvas(L, 'cradle', { create: art.create }), bounds = weaponPartBounds(L, 'cradle'),
      rails = art.calls.filter(([name]) => name === 'roundRect').slice(0, 3), height = L.receiver.y1 - L.receiver.y0;
    assert(painted.canvas.width > 0 && painted.canvas.height > 0);
    assert.equal(bounds.x0, L.receiver.x0 - model.recoil);
    assert.equal(rails.length, 3);
    for (const [, , , w, h] of rails) assert(w < model.recoil / 2 || h < height / 2, 'the slide leaves its middle open');
    assert.deepEqual(art.clips, [cut(L.contours.mantlets)], 'the shield is clipped separately from the open slide');
    for (const [name, value] of art.calls) if (name === 'globalAlpha') assert(Number.isFinite(value) && value > 0 && value < 1);
    const tube = recorder(); weaponCanvas(L, 'moving', { create: tube.create });
    assert.deepEqual(weaponPartBounds(L, 'moving'), L.tube);
  }
});

test('a mount whose axis points left is mirrored so its lit side stays up', () => {
  const polygons = [rect(-1.1, -.3, 0, .2), rect(0, -.078, 1.8, .078), ...solids('rh120').slice(2, 4),
      rect(.1, -.32, .4, -.08), rect(.1, .08, .4, .3)],
    upright = weaponLayout('rh120', polygons, 1), mirrored = weaponLayout('rh120', polygons, -1);
  assert.deepEqual([mirrored.receiver.y0, mirrored.receiver.y1], [-upright.receiver.y1, -upright.receiver.y0]);
  assert.deepEqual([mirrored.mantlets[1].y0, mirrored.mantlets[1].y1], [-upright.mantlets[0].y1, -upright.mantlets[0].y0]);
  assert(mirrored.mantlets[0].y0 < mirrored.mantlets[1].y0, 'mantlets stay ordered from the lower one up');
  assert.equal(weaponFlip({ weaponMount: {}, angle: Math.PI }), -1);
  assert.equal(weaponFlip({ weaponMount: {}, angle: .3 }), 1);
  assert.equal(weaponFlip({ angle: Math.PI }), 1, 'a free weapon is never mirrored');
  assert.equal(weaponFlip(null), 1);
});

test('mirrored and elevated, the painted muzzle lands on the gun\'s own muzzle and its fittings keep their places', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  for (const id of ['rh120', 'm2hb', 'm777', 'hydra70']) for (const [angle, flip] of [[0, 1], [Math.PI, -1], [.4, 1], [Math.PI - .2, -1]]) {
    const polygons = solids(id), L = weaponLayout(id, polygons, flip), art = recorder(), painted = weaponCanvas(L, 'moving', { create: art.create }),
      launcher = { id: 'gun', x: 3, y: 2, angle, weaponMount: {}, materialPolygons: polygons },
      sprites = new WeaponSprites(key => ({ texture: Texture.WHITE, art: painted, key })), layer = new Container();
    // Each picture is laid by its own art: the moving part's picture is the one asked for here.
    sprites.texture = (key, create) => ({ texture: Texture.WHITE, art: key.includes(':moving:') ? painted : weaponCanvas(weaponLayout(id, polygons, flip), 'receiver', { create: recorder().create }) });
    for (const elevation of [0, .35, -.2]) {
      const aim = angle + elevation;
      sprites.begin(); sprites.place('gun', layer, launcher, aim, id); sprites.end();
      const moving = layer.children[1], { width, height } = painted.canvas,
        // Where the picture's pixel at the muzzle, on the bore, lands in the world.
        u = painted.originX + L.b * painted.scale - moving.anchor.x * width, v = painted.originY - moving.anchor.y * height,
        lx = u * moving.scale.x, ly = v * moving.scale.y, c = Math.cos(moving.rotation), s = Math.sin(moving.rotation),
        world = { x: moving.position.x + c * lx - s * ly, y: moving.position.y + s * lx + c * ly };
      assert(Math.hypot(world.x - (3 + L.b * Math.cos(aim)), world.y - (2 + L.b * Math.sin(aim))) < 1e-9, `${id} at ${angle}+${elevation}`);
    }
    // Mirrored, the same fittings stand at the same distances along the bore.
    const upright = weaponLayout(id, polygons, 1);
    assert.deepEqual(tubeFittings(id, L.b, L.tube.x0), tubeFittings(id, upright.b, upright.tube.x0));
  }
});

test('integrated feet stay solid and fixed through aim and recoil, then leave with their weapon', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document'); globalThis.document = {};
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  const polygons = solids('rh120'), L = weaponLayout('rh120', polygons), painted = weaponCanvas(L, 'moving', { create: recorder().create }),
    asked = [], sprites = new WeaponSprites(key => { asked.push(key); return { key, texture: Texture.WHITE, art: painted }; }),
    layer = new Container(), launcher = { x: 3, y: 2, angle: .4, weaponMount: { exposed: false }, materialPolygons: polygons };
  sprites.begin(); sprites.place('gun', layer, launcher, .7, 'rh120', { recoil: .2, alpha: .6, tint: 0x899582 }); sprites.end();
  const base = layer.children.find(child => child instanceof Graphics);
  assert(base?.visible); assert.equal(base.rotation, .4); assert.equal(base.x, 3); assert.equal(base.y, 2);
  assert.equal(base.alpha, .6); assert.equal(base.tint, 0x899582);
  assert.equal(L.contours.base.length, 2); assert.equal(L.contours.mantlets.length, 2);
  sprites.begin(); sprites.place('gun', layer, launcher, .1, 'rh120', { recoil: .05 }); sprites.end();
  assert.equal(base.rotation, .4); assert.equal(base.x, 3); assert.equal(base.y, 2);
  assert(asked.every(key => !key.includes(':base:')), 'fixed solids allocate no bitmap for their empty middle');
  sprites.clear(); assert.equal(base.destroyed, true);
});

test('a gun carried whole on a post paints the post in its fixed solid and the gun in the blocks it turns with', () => {
  for (const id of ['m2hb', 'fnmag', 'minimi', 'mk19']) {
    // The pintle's solids for a box 0.52 m long and 0.24 m high: the post under the trunnion, the tube, the receiver
    // behind the trunnion and the barrel support before it — listed either way round, as a turned construction has them.
    // The native role order and explicit exposed flag identify the post,
    // receiver and cradle; no inference from a piece reaching behind the pivot.
    const { end, radius } = weaponBarrelProfile({ weaponPreset: id }), post = rect(-.564, -.04, 0, .04), tube = rect(0, -radius, end, radius),
      body = rect(-.52, -.12, 0, .12), support = rect(0, -.06, .096, .06);
    for (const polygons of [[post, tube, body, support]]) {
      const L = weaponLayout(id, polygons, 1, 0, true);
      assert.equal(L.exposed, true);
      assert.deepEqual([L.body, L.support], [{ x0: -.52, x1: 0, y0: -.12, y1: .12 }, { x0: 0, x1: .096, y0: -.06, y1: .06 }]);
      // Whole, the post stands square under the level gun.
      assert.deepEqual(weaponPartBounds(L, 'all'), { x0: -.52, x1: end, y0: -.564, y1: .12 });
      for (const [part, contours] of [['receiver', [L.contours.receiver]], ['moving', [L.contours.tube, ...L.contours.mantlets]]]) {
        const art = recorder(); weaponCanvas(L, part, { create: art.create });
        assert.deepEqual(art.clips, [cut(contours)], `${id} ${part}`);
        assert(art.calls.filter(([name]) => name === 'fill').length >= 10, `${id} ${part} is drawn in detail`);
      }
    }
  }
});

test('the arsenal shows the guns of a tab at one scale, the longest across its whole card', () => {
  const { longest, shares } = arsenalScale(['m119', 'm777']), length = id => { const box = weaponPartBounds(weaponLayout(id)); return box.x1 - box.x0; };
  assert.equal(longest, Math.max(length('m119'), length('m777')));
  assert.deepEqual(shares, [length('m119') / longest, length('m777') / longest]);
  assert.equal(Math.max(...shares), 1);
  const guns = arsenalScale(['minimi', 'fnmag', 'm2hb']);
  assert(guns.shares.every(share => share > 0 && share <= 1));
});

test('a gun off any mount is picked wherever its bench picture paints it, and nowhere else', () => {
  for (const id of PRESETS) {
    const L = weaponLayout(id), shapes = weaponShapes(id), xs = shapes.flatMap(s => s.points.filter((_, i) => !(i % 2))),
      ys = shapes.flatMap(s => s.points.filter((_, i) => i % 2));
    const outline = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }, painted = weaponPartBounds(L);
    for (const side of ['x0', 'x1', 'y0', 'y1']) assert(Math.abs(outline[side] - painted[side]) < 1e-12, `${id} ${side}`);
    // Pointing left, as a bench weapon lies by default: the middle of its receiver and a point on its muzzle pick it.
    const gun = { x: 4, y: 1, weaponPreset: id }, at = (x, y) => ({ x: 4 - x, y: 1 - y });
    assert(weaponContains(gun, at((L.receiver.x0 + L.receiver.x1) / 2, 0)), id);
    assert(weaponContains(gun, at(L.b - .005, 0)), id);
    assert(!weaponContains(gun, at(L.b + .05, 0)), id);
    assert(!weaponContains(gun, at(L.receiver.x0 - .05, 0)), id);
  }
});

test('each tab of the arsenal draws its guns at one scale, every picture its share of the longest', t => {
  // Just enough of a page for the arsenal to fill its grid: elements that hold their children, canvases that draw nothing.
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.classList = { toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener() {}
    setAttribute() {}
    getContext() { return recorder().ctx; }
  }
  const previous = globalThis.document, nodes = new Map();
  globalThis.document = { createElement: tag => new Element(tag), querySelectorAll: () => [],
    querySelector: selector => { if (!nodes.has(selector)) nodes.set(selector, new Element('div')); return nodes.get(selector); } };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const ui = new ConstructionUI({ stopControls() {}, toast: message => assert.fail(message) }), find = (node, tag) => node.tagName === tag ? node : node.children.map(child => find(child, tag)).find(Boolean);
  for (const [family] of WEAPON_FAMILIES) {
    ui.family = family; ui.refreshArsenal();
    const pictures = nodes.get('#arsenal-grid').children.map(card => find(card, 'canvas')),
      ids = Object.keys(WEAPON_PRESETS).filter(id => WEAPON_PRESETS[id].family === family).sort((a, b) => WEAPON_PRESETS[a].caliberMm - WEAPON_PRESETS[b].caliberMm),
      lengths = ids.map(id => { const box = weaponPartBounds(weaponLayout(id)); return box.x1 - box.x0; }), longest = Math.max(...lengths);
    assert.equal(pictures.length, ids.length, family);
    pictures.forEach((picture, index) => {
      assert.equal(picture.style.width, `${(lengths[index] / longest * 100).toFixed(2)}%`, `${family}: ${ids[index]} takes its share of the card`);
      // Every picture of the tab is painted as finely, a metre the same number of pixels.
      assert(Math.abs((picture.width - 4) / lengths[index] - (pictures[0].width - 4) / lengths[0]) <= 2 / Math.min(...lengths), `${family}: ${ids[index]}`);
    });
    assert(pictures.some(picture => picture.style.width === '100.00%'), family);
  }
});
