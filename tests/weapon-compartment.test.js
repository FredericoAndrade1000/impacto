import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { weaponCompartment, weaponMountSize, weaponOf, weaponVariant } from '../src/weapons.ts';
import { weaponBarrelProfile } from '../src/weapon-geometry.ts';
import { compartmentBoxes, drumChamber, feedChambers, feedLook, routeAt, rotorLook, weaponCanvas, weaponLayout, weaponMoves, weaponPartBounds, weaponPiece } from '../src/weapon-paint.ts';
import { WeaponSprites } from '../src/weapon-sprites.ts';
import { SPIN_DOWN, advanceFeed, advanceWeaponSpin, followFeed, startWeaponSpin } from '../src/weapon-presentation.ts';

await initNativeDynamics();
const BELTS = ['m2hb', 'fnmag', 'minimi', 'mk19', 'm242', 'mk44', 'm230lf', 'rh202', 'mk35'];
const tank = weaponVariant('rh120', { magazine: 22 }), mortar = weaponVariant('m252', { magazine: 10 }), rotary = weaponVariant('m2hb', { barrels: 3 }),
  six = weaponVariant('m2hb', { barrels: 6 });
const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
// A mount's solids for a gun whose receiver box spans its whole mount width behind the trunnion, as the core gives it.
const enclosed = id => { const { width, height } = weaponMountSize(id), { end, radius } = weaponBarrelProfile({ weaponPreset: id });
  return [rect(-width, -height / 2, 0, height / 2), rect(.05, -radius, end, radius), rect(-.2, .7, .2, .74), rect(-.2, -.74, .2, -.7)]; };
const exposed = id => { const { width, height } = weaponMountSize(id), { end, radius } = weaponBarrelProfile({ weaponPreset: id });
  return [rect(-.6, -.04, 0, .04), rect(0, -radius, end, radius), rect(-width, -height / 2, 0, height / 2), rect(0, -.06, .096, .06)]; };

// A canvas that draws nothing, refuses non-finite numbers and keeps what it was asked and how far it painted, in pixels.
function recorder() {
  const calls = [], extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, stack = [];
  let m = [1, 0, 0, 1, 0, 0], path = [];
  const point = (x, y) => path.push([m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]),
    multiply = ([a, b, c, d, e, f]) => { const [A, B, C, D, E, F] = m; m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F]; },
    paint = () => { for (const [x, y] of path) { extent.x0 = Math.min(extent.x0, x); extent.x1 = Math.max(extent.x1, x); extent.y0 = Math.min(extent.y0, y); extent.y1 = Math.max(extent.y1, y); } },
    box = (x, y, w, h) => { point(x, y); point(x + w, y); point(x, y + h); point(x + w, y + h); };
  const ops = { moveTo: point, lineTo: point, quadraticCurveTo: (a, b, x, y) => { point(a, b); point(x, y); }, roundRect: box, rect: box,
    arc: (x, y, r) => box(x - r, y - r, 2 * r, 2 * r), ellipse: (x, y, a, b) => box(x - a, y - b, 2 * a, 2 * b), beginPath: () => { path = []; }, fill: paint,
    save: () => stack.push(m), restore: () => { m = stack.pop(); }, setTransform: (...v) => { m = v; }, translate: (x, y) => multiply([1, 0, 0, 1, x, y]),
    scale: (x, y) => multiply([x, 0, 0, y, 0, 0]), rotate: t => multiply([Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0]) };
  const ctx = new Proxy({}, {
    get: (_, name) => (...values) => {
      for (const value of values) if (typeof value === 'number') assert(Number.isFinite(value), `${String(name)} received ${value}`);
      calls.push(name); ops[name]?.(...values);
      return name === 'createLinearGradient' || name === 'createRadialGradient' ? { addColorStop() {} } : undefined;
    },
    set: (_, name, value) => { calls.push(name); if (name === 'lineWidth') assert(value > 0 && Number.isFinite(value)); return true; },
  });
  return { ctx, calls, extent, create: (width, height) => ({ width, height, getContext: () => ctx }) };
}
const metres = (art, painted) => ({ x0: (art.extent.x0 - painted.originX) / painted.scale, x1: (art.extent.x1 - painted.originX) / painted.scale,
  y0: (painted.originY - art.extent.y1) / painted.scale, y1: (painted.originY - art.extent.y0) / painted.scale });

test('the rotor of a rotary gun comes up to its rate in its spin-up, stops in SPIN_DOWN, and is drawn turning no faster than the eye follows', () => {
  assert.equal(startWeaponSpin(null, 'm2hb'), null, 'a gun of one barrel does not turn');
  const model = weaponOf(six), spin = startWeaponSpin(null, six), top = model.rate / 60 / model.steel.barrels, dt = 1 / 60;
  assert.equal(spin.top, top); assert.equal(spin.up, model.spinUp);
  let held = 0, angles = [];
  // Held firing, a muzzle event every interval of its rate.
  for (let time = 0; time < model.spinUp + .1; time += dt) {
    if (time - held >= 60 / model.rate) { startWeaponSpin(spin, six); held = time; }
    const before = spin.angle; advanceWeaponSpin(spin, dt);
    angles.push((spin.angle - before + 2 * Math.PI) % (2 * Math.PI));
  }
  assert(Math.abs(spin.speed - top) < 1e-9, `at its rate after its spin-up: ${spin.speed} of ${top}`);
  assert(Math.max(...angles) <= .3 * 2 * Math.PI / model.steel.barrels + 1e-9, 'never more than a share of a barrel\'s angle a frame');
  assert.equal(spin.blur, 1, 'six barrels at 600 turns a minute are a blur');
  // The shots stop: it is still within SPIN_DOWN, and stops with it.
  let time = 0;
  while (advanceWeaponSpin(spin, dt)) time += dt;
  assert(time <= spin.hold + SPIN_DOWN + 2 * dt, `stopped ${time} s after its last shot`);
  assert.equal(spin.speed, 0); assert.equal(spin.blur, 0);
  const slow = startWeaponSpin(null, rotary); for (let i = 0; i < 40; i++) { startWeaponSpin(slow, rotary); advanceWeaponSpin(slow, dt); }
  assert(slow.blur > 0 && slow.blur < 1, `three barrels at 600 a minute are half blurred: ${slow.blur}`);
});

test('a drum turns forward a place for every round fired or put back, emptying and filling the chambers that pass its rammer', () => {
  const m = 6, rounds = 22;
  let motion = followFeed(null, 4, { kind: 'magazine', rounds, chambers: m });
  assert.deepEqual(motion.chambers, [true, true, true, true, false, false], 'the next rounds to come to the rammer');
  const fire = () => { const before = motion.places; motion = followFeed(motion, motion.loaded - 1, { kind: 'magazine', rounds, chambers: m }); return motion.places - before; };
  assert.equal(fire(), 1); assert.deepEqual(motion.chambers, [false, true, true, true, false, false], 'the chamber at the rammer is emptied');
  assert.equal(fire(), 1); assert.equal(motion.chambers.filter(Boolean).length, 2);
  // Put back: the drum turns forward, and the chamber that last left the rammer empty is filled.
  const before = motion.places;
  motion = followFeed(motion, 3, { kind: 'magazine', rounds, chambers: m });
  assert.equal(motion.places, before + 1, 'a refill turns it forward too');
  assert.equal(motion.chambers.filter(Boolean).length, 3);
  assert(motion.chambers[(motion.places - 1 + m) % m], 'the chamber just past the rammer');
  // A magazine of more than go round the drum keeps it full from the rings within.
  motion = followFeed(motion, 22, { kind: 'magazine', rounds, chambers: m });
  assert(motion.chambers.every(Boolean));
  assert.equal(fire(), 1); assert(motion.chambers.every(Boolean), 'twenty-one left: still full');
  // Whatever it is told, the chambers it shows full are as many as it holds, up to all of them.
  for (const loaded of [0, 5, 1, 6, 2, 22, 0]) {
    const was = motion.places;
    motion = followFeed(motion, loaded, { kind: 'magazine', rounds, chambers: m });
    assert(motion.places >= was, 'never backwards');
    assert.equal(motion.chambers.filter(Boolean).length, Math.min(loaded, m), `${loaded}`);
  }
  assert.equal(feedChambers('m2hb'), 0); assert.equal(feedChambers('rh120'), 0);
  assert(feedChambers(tank) >= 3 && feedChambers(tank) <= 22 && feedChambers(mortar) >= 3, `${feedChambers(tank)} ${feedChambers(mortar)}`);
});

test('the drawing of a drum or a belt eases forward to where it is told, skipping whole turns, never past them nor backwards', () => {
  const belt = followFeed(null, 100, { kind: 'belt', rounds: 100 });
  followFeed(belt, 99, { kind: 'belt', rounds: 100 }); assert.equal(belt.places, 1);
  followFeed(belt, 0, { kind: 'belt', rounds: 100 }); assert.equal(belt.places, 100);
  followFeed(belt, 100, { kind: 'belt', rounds: 100 }); assert(belt.places > 100 && belt.places <= 106, 'a new belt runs in as far as is seen');
  let last = belt.turned;
  for (let i = 0; i < 120; i++) {
    advanceFeed(belt, 1 / 60);
    assert(belt.turned >= last && belt.turned <= belt.places, 'forward, never past');
    assert(belt.turned - last <= .35 + 1e-9 || i === 0, `a frame moves it ${belt.turned - last}`);
    last = belt.turned;
  }
  assert.equal(belt.turned, belt.places);
  const drum = followFeed(null, 22, { kind: 'magazine', rounds: 22, chambers: 6 });
  followFeed(drum, 0, { kind: 'magazine', rounds: 22, chambers: 6 });
  advanceFeed(drum, 1 / 60);
  assert(drum.places - drum.turned <= 6, 'more than a turn behind is skipped by whole turns');
});

test('the compartment stands in the receiver box the core gives: a belt\'s can beside and behind, a magazine behind, the gun\'s own receiver at the front', () => {
  for (const id of [...BELTS, tank, mortar]) {
    const told = weaponCompartment(id), size = weaponMountSize(id);
    assert(told, id);
    for (const L of [weaponLayout(id), weaponLayout(id, enclosed(id)), ...(id === tank || id === mortar ? [] : [weaponLayout(id, exposed(id), 1, 0, true)])]) {
      const boxes = compartmentBoxes(L), box = L.exposed ? L.body : L.receiver;
      assert(Math.abs(boxes.own.x1 - boxes.own.x0 - weaponOf(id).receiver.length) < 1e-9, `${id}: its own receiver keeps its length`);
      assert(Math.abs(box.x1 - box.x0 - size.width) < 1e-9);
      if (told.kind === 'belt') {
        assert(Math.abs(boxes.can.x1 - boxes.can.x0 - told.lengthM - told.besideM) < 1e-9, `${id}: the can beside and behind`);
        const look = feedLook(L), at = { x: 0, y: 0, angle: 0 };
        assert.equal(look.kind, 'belt');
        for (let s = 0; s <= look.length; s += look.pitch / 3) {
          routeAt(look, s, at);
          assert(at.x >= box.x0 && at.x <= box.x1 && -at.y >= box.y0 + look.width / 2 - 1e-9 && -at.y <= box.y1 - look.width / 2 + 1e-9, `${id}: its belt stays in the box at ${s}`);
        }
      } else {
        const look = feedLook(L);
        assert.equal(look.kind, 'magazine'); assert.equal(boxes.can, null);
        assert(Math.abs(boxes.behind.x1 - boxes.behind.x0 - told.lengthM) < 1e-9);
        for (let j = 0; j < look.chambers; j++) for (const turned of [0, .5, 3.25]) {
          const { y } = drumChamber(look, 2 * Math.PI * (turned - j) / look.chambers);
          assert(Math.abs(y - look.cy) + look.d * .56 <= look.drum + 1e-9, `${id}: a round stays within the cut of its box`);
        }
        assert(look.x0 > box.x0 && look.x1 < boxes.own.x0, `${id}: the drum between the walls behind the receiver`);
      }
    }
  }
  assert.equal(compartmentBoxes(weaponLayout('rh120')), null, 'a gun loaded a round at a time has none');
  assert.equal(weaponMoves('rh120'), false); assert(weaponMoves('m2hb') && weaponMoves(rotary) && weaponMoves(tank));
});

test('the compartment paints within the receiver box, sound or wrecked, the same every time, and the field leaves its moving parts to their own pictures', () => {
  for (const id of [...BELTS, tank, mortar, rotary]) for (const polygons of [null, enclosed(id)]) for (const look of [{}, { animated: true }, { cut: true }]) {
    const L = weaponLayout(id, polygons), part = polygons ? 'receiver' : 'all', art = recorder(), again = recorder(),
      painted = weaponCanvas(L, part, { create: art.create, ...look }), seen = metres(art, painted), box = weaponPartBounds(L, part), slack = .003;
    weaponCanvas(L, part, { create: again.create, ...look });
    assert.deepEqual(again.calls, art.calls, `${id} is painted the same every time`);
    assert(seen.x0 >= box.x0 - slack && seen.x1 <= box.x1 + slack && seen.y0 >= box.y0 - slack && seen.y1 <= box.y1 + slack, `${id} ${JSON.stringify(look)}: ${JSON.stringify(seen)} in ${JSON.stringify(box)}`);
    assert(!art.calls.includes('fillText'), 'no lettering');
  }
  // Animated, the rounds of a drum and a belt and the barrels of a rotor are not painted in: they are pictures over it.
  for (const id of [tank, 'm2hb', rotary]) {
    const L = weaponLayout(id), still = recorder(), field = recorder();
    weaponCanvas(L, 'all', { create: still.create }); weaponCanvas(L, 'all', { create: field.create, animated: true });
    assert(field.calls.filter(name => name === 'fill').length < still.calls.filter(name => name === 'fill').length, id);
  }
  // Wrecked, the compartment is painted otherwise.
  const sound = recorder(), wrecked = recorder();
  weaponCanvas(weaponLayout('m242'), 'all', { create: sound.create }); weaponCanvas(weaponLayout('m242'), 'all', { create: wrecked.create, cut: true });
  assert.notDeepEqual(wrecked.calls, sound.calls);
});

test('blow-out panels are painted as the roof of the compartment, and open where they blew when it is wrecked', () => {
  for (const [plain, vented] of [[tank, weaponVariant('rh120', { magazine: 22, vent: 1 })], ['m2hb', weaponVariant('m2hb', { vent: 1 })]]) {
    assert.equal(weaponLayout(plain).compartment.vented, false); assert.equal(weaponLayout(vented).compartment.vented, true);
    for (const polygons of [null, enclosed(vented)]) for (const look of [{}, { animated: true }, { cut: true }]) {
      const L = weaponLayout(vented, polygons), part = polygons ? 'receiver' : 'all', art = recorder(), painted = weaponCanvas(L, part, { create: art.create, ...look }),
        seen = metres(art, painted), box = weaponPartBounds(L, part), slack = .003, other = recorder();
      assert(seen.x0 >= box.x0 - slack && seen.x1 <= box.x1 + slack && seen.y0 >= box.y0 - slack && seen.y1 <= box.y1 + slack, `${vented} ${JSON.stringify(look)}: ${JSON.stringify(seen)} in ${JSON.stringify(box)}`);
      weaponCanvas(weaponLayout(plain, polygons), part, { create: other.create, ...look });
      assert.notDeepEqual(art.calls, other.calls, `${vented} ${JSON.stringify(look)} is painted with its panels`);
    }
  }
});

test('each moving picture of a gun is painted once, finite, in its own small box', () => {
  for (const [id, pieces] of [[tank, ['round', 'cell', 'axle']], ['m2hb', ['link']], [rotary, ['barrel', 'rings', 'blur', 'link']], ['rh120', []]]) {
    const L = weaponLayout(id);
    for (const name of ['round', 'cell', 'axle', 'link', 'barrel', 'rings', 'blur']) {
      const art = recorder(), painted = weaponPiece(L, name, { create: art.create });
      if (!pieces.includes(name)) { assert.equal(painted, null, `${id} has no ${name}`); continue; }
      assert(painted.canvas.width > 2 && painted.canvas.height > 2 && painted.canvas.width <= 2052, `${id} ${name}`);
      assert(art.calls.filter(call => call === 'fill').length >= 1, `${id} ${name} is painted`);
      assert(painted.originX >= 0 && painted.originY >= 0);
    }
  }
});

test('in the field the barrels of a rotor turn, the rounds of a drum go round and a belt runs in, all by transforms of pictures painted once', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  const asked = new Map(), sprites = new WeaponSprites((key, create) => {
    if (!asked.has(key)) { const painted = { canvas: { width: 100, height: 40 }, originX: 10, originY: 20, scale: 400 }; asked.set(key, { key, texture: Texture.WHITE, art: painted }); }
    return asked.get(key);
  }), layer = new Container();
  t.after(() => { sprites.clear(); layer.destroy({ children: true }); });
  // A rotary gun on its mount: its barrels lie at the heights of their turn, and move as the rotor turns.
  const gun = { x: 1, y: 2, angle: 0, weaponMount: { exposed: false }, materialPolygons: enclosed(rotary) };
  sprites.begin(); sprites.place('gun', layer, gun, .1, rotary, { spin: { angle: 0, blur: 0 } }); sprites.end();
  const item = sprites.items.get('gun'), look = rotorLook(weaponLayout(rotary, gun.materialPolygons));
  assert(item.rotor && item.feed, 'a rotor and a belt move on it');
  const heights = () => item.rotor.sprites.slice(0, look.n).map(sprite => sprite.position.y);
  const rest = heights();
  sprites.begin(); sprites.place('gun', layer, gun, .1, rotary, { spin: { angle: .4, blur: .5 } }); sprites.end();
  assert.notDeepEqual(heights(), rest, 'the barrels have moved round');
  assert.equal(item.rotor.sprites[look.n].alpha, .5, 'and run together');
  assert(layer.getChildIndex(item.rotor.container) === layer.getChildIndex(item.sprites[1]) + 1 ||
    layer.getChildIndex(item.feed.container) === layer.getChildIndex(item.sprites[1]) + 1, 'over the tube, under the mantlet');
  const paintedKeys = asked.size;
  for (let i = 0; i < 10; i++) { sprites.begin(); sprites.place('gun', layer, gun, .1, rotary, { spin: { angle: i, blur: 0 }, feed: { places: i, turned: i - .5, loaded: 100 - i, chambers: null, cut: false } }); sprites.end(); }
  assert.equal(asked.size, paintedKeys, 'turning and feeding paint nothing new');
  // The tail of a belt: as few links show as rounds are left, and none from a wrecked can.
  const links = loaded => { sprites.begin(); sprites.place('gun', layer, gun, .1, rotary, { feed: { places: 50, turned: 50, loaded, chambers: null, cut: false } }); sprites.end();
    return item.feed.sprites.filter(sprite => sprite.visible).length; };
  assert(links(100) > links(1) && links(1) === 1 && links(0) === 0, `${links(100)} ${links(1)} ${links(0)}`);
  sprites.begin(); sprites.place('gun', layer, gun, .1, rotary, { feed: { places: 50, turned: 50, loaded: 100, chambers: null, cut: true } }); sprites.end();
  assert.equal(item.feed.sprites.filter(sprite => sprite.visible).length, 0);
  assert(item.parts[0].key.endsWith(':cut'), 'the receiver that holds the compartment is painted wrecked');
  // A drum: a chamber at its turn, with its round or empty, as its frame tells.
  const turret = { x: 0, y: 0, angle: 0, weaponMount: { exposed: false }, materialPolygons: enclosed(tank) }, m = feedChambers(tank),
    fill = Array.from({ length: m }, (_, j) => j % 2 === 0);
  sprites.begin(); sprites.place('turret', layer, turret, 0, tank, { feed: { places: 0, turned: 0, loaded: 3, chambers: fill, cut: false } }); sprites.end();
  const drum = sprites.items.get('turret').feed, roundKey = drum.pieces.round.key;
  assert.equal(drum.sprites.filter(sprite => sprite.visible).length, m + 1, 'each chamber and the axle');
  assert.deepEqual(drum.sprites.slice(0, m).map(sprite => sprite.texture === asked.get(roundKey).texture), fill.map(() => true), 'one texture stands in for both in this stub');
  const ys = drum.sprites.slice(0, m).map(sprite => sprite.position.y);
  sprites.begin(); sprites.place('turret', layer, turret, 0, tank, { feed: { places: 1, turned: .5, loaded: 2, chambers: fill, cut: false } }); sprites.end();
  assert.notDeepEqual(drum.sprites.slice(0, m).map(sprite => sprite.position.y), ys, 'the drum has turned');
  // A gun that moves nothing has no overlay.
  sprites.begin(); sprites.place('plain', layer, { x: 0, y: 0, angle: 0, weaponMount: { exposed: false }, materialPolygons: enclosed('rh120') }, 0, 'rh120'); sprites.end();
  assert.equal(sprites.items.get('plain').feed, null); assert.equal(sprites.items.get('plain').rotor ?? null, null);
});
