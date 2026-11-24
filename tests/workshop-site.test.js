import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera, FramedCamera } from '../src/camera.ts';
import { BOARD, boardSite, drawBoardFloor, fieldX } from '../src/workshop-site.ts';
import { FRAME_REACH } from '../src/frame-editing.ts';
import { Editor } from '../src/editor.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { plateCorners } from '../src/math.ts';
import { BASE_RADIUS } from '../src/economy.ts';
import { constructionSpan } from '../src/construction-placement.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { rehearsal } from '../server/room.ts';

await initNativeDynamics();

// The workshop of the shared field is a place of the base. The design keeps the frame it is made in, and
// that frame is stood in the field at one place, the site: these are the two things that say where, the
// site itself and the camera of the field as that frame has it.

test('a framed camera is the camera of the field, with every place counted from where the frame stands', () => {
  const camera = new Camera(1280, 720), site = { x: 125048, y: 238.75 }, framed = new FramedCamera(camera, () => site);
  Object.assign(camera, { x: 125060.25, y: 240.5, zoom: 96 });
  assert.deepEqual([framed.x, framed.y, framed.zoom, framed.width, framed.height, framed.minZoom], [12.25, 1.75, 96, 1280, 720, camera.minZoom]);
  // A pixel is one place, told two ways: the two differ by the site and by nothing else, 125 km out.
  for (const [sx, sy] of [[0, 0], [640, 360], [1279.5, 13.25], [333, 719]]) {
    const there = camera.toWorld(sx, sy), here = framed.toWorld(sx, sy), back = framed.toScreen(here.x, here.y);
    assert(Math.abs(here.x - (there.x - site.x)) < 1e-9 && Math.abs(here.y - (there.y - site.y)) < 1e-9);
    assert(Math.abs(here.x) < 30 && Math.abs(here.y) < 10, 'a place of the frame is a small number');
    assert(Math.abs(back.x - sx) < 1e-7 && Math.abs(back.y - sy) < 1e-7, 'and comes back to its pixel');
  }
  for (const [x, y] of [[12, 0], [5, 8], [19, 1.3]]) {
    const framedPixel = framed.toScreen(x, y), pixel = camera.toScreen(site.x + x, site.y + y);
    assert(Math.abs(framedPixel.x - pixel.x) < 1e-7 && Math.abs(framedPixel.y - pixel.y) < 1e-7);
  }
  // Moved, zoomed or framed through the frame, it is the camera that moves.
  framed.pan(96, -48);
  assert.deepEqual([camera.x, camera.y, framed.x, framed.y], [125059.25, 240, 11.25, 1.25]);
  const held = framed.toWorld(900, 200); framed.zoomAt(1.5, 900, 200);
  assert.equal(camera.zoom, 144);
  const kept = framed.toWorld(900, 200); assert(Math.abs(kept.x - held.x) < 1e-9 && Math.abs(kept.y - held.y) < 1e-9, 'the place under the pointer stays under it');
  framed.x = 12; framed.y = 2; assert.deepEqual([camera.x, camera.y], [125060, 240.75]);
  const design = new Editor(createConstruction('heavy')).blueprint, alone = new Camera(1280, 720);
  framed.fit(design, true); alone.fit(design, true);
  assert.equal(framed.zoom, alone.zoom);
  assert(Math.abs(framed.x - alone.x) < 1e-9 && Math.abs(framed.y - alone.y) < 1e-9, 'framed as on the bench');
  assert(Math.abs(camera.x - (site.x + alone.x)) < 1e-9 && Math.abs(camera.y - (site.y + alone.y)) < 1e-9, 'and shown at the site');
  // The frame is asked where it stands each time: stood elsewhere, the same view is of other places.
  const before = framed.x; site.x += 24;
  assert(Math.abs(framed.x - (before - 24)) < 1e-9);
});

test('the board is what the field takes of a construction, about the middle a construction is placed by', () => {
  assert.deepEqual({ ...BOARD }, { minX: 5, maxX: 19, minY: 0, maxY: 8, middle: 12 });
  // From end to end, the limits the editor keeps a frame in are inside it: whatever is made within them is over the board.
  const frame = new Editor(createConstruction('heavy')).blueprint.frame;
  assert(frame.origin.x + FRAME_REACH.minX >= BOARD.minX && frame.origin.x + FRAME_REACH.maxX <= BOARD.maxX);
});

test('a placement span follows rotated equipment and mirrors the same physical outline', () => {
  const design = { plates: [], modules: [{ kind: 'engine', x: 14, y: 2, width: 1, height: 4, angle: Math.PI / 2 }] };
  assert.deepEqual(constructionSpan(design, { x: 100, facing: -1 }), { minX: 100, maxX: 104 });
  assert.deepEqual(constructionSpan(design, { x: 100, facing: 1 }), { minX: 96, maxX: 100 });
});

const heavy = new Editor(createConstruction('heavy')).blueprint,
  reach = design => { const xs = [...design.plates.flatMap(plateCorners).map(p => p.x), ...design.modules.flatMap(m => [m.x - m.width / 2, m.x + m.width / 2])]; return { low: Math.min(...xs), high: Math.max(...xs) }; },
  // A construction standing in a field, as a frame tells it: one plate from one end of it to the other.
  standing = (id, from, to) => ({ id: id + ':plate', actorId: id, definition: { x: (from + to) / 2, y: 1, length: to - from, angle: 0, thicknessMm: 100 } });

test('a design that will face right is drawn turned about the middle of the board, and its frame counts so', () => {
  const camera = new Camera(1280, 720), site = { x: 125048, y: 238.75, mirror: true }, framed = new FramedCamera(camera, () => site, BOARD.middle);
  Object.assign(camera, { x: 125060.25, y: 240.5, zoom: 96 });
  assert.deepEqual([framed.turn, framed.x, framed.y], [-1, 11.75, 1.75], 'the middle of the view, counted from the other end of the board');
  assert.deepEqual([fieldX(site, 5), fieldX(site, 12), fieldX(site, 19)], [site.x + 19, site.x + 12, site.x + 5]);
  for (const [sx, sy] of [[0, 0], [640, 360], [1279.5, 13.25], [333, 719]]) {
    const there = camera.toWorld(sx, sy), here = framed.toWorld(sx, sy), back = framed.toScreen(here.x, here.y);
    assert(Math.abs(fieldX(site, here.x) - there.x) < 1e-9 && Math.abs(here.y - (there.y - site.y)) < 1e-9, 'one place, told two ways');
    assert(Math.abs(back.x - sx) < 1e-7 && Math.abs(back.y - sy) < 1e-7, 'and back to its pixel');
  }
  assert(framed.toScreen(5, 0).x > framed.toScreen(19, 0).x, 'the left of the board is at the right of the screen');
  // Moved through the frame, the view goes with the hand as the camera of the field does.
  framed.pan(96, -48);
  assert.deepEqual([camera.x, camera.y, framed.x, framed.y], [125059.25, 240, 12.75, 1.25]);
  const held = framed.toWorld(900, 200); framed.zoomAt(1.5, 900, 200); const after = framed.toWorld(900, 200);
  assert(Math.abs(after.x - held.x) < 1e-9 && Math.abs(after.y - held.y) < 1e-9, 'a zoom keeps the place under the pointer');
  // A framing puts the design in the part of the view the panels leave, turned or not.
  camera.cover = () => ({ top: 0, bottom: 0, left: 300, right: 0 });
  const plain = new Camera(1280, 720); plain.cover = camera.cover; plain.fit(heavy, true);
  const middle = plain.x + 150 / plain.zoom;
  framed.fit(heavy, true); assert(Math.abs(framed.toScreen(middle, 0).x - 790) < 1e-6);
  site.mirror = false; framed.fit(heavy, true); assert(Math.abs(framed.toScreen(middle, 0).x - 790) < 1e-6);
});

test('the board stands where the design would come into the field facing right: the first free place of the row of the base', () => {
  const base = { x: 125000, y: 37.5, facing: -1, radius: 100 }, { minX, maxX } = constructionSpan(heavy, { x: 0, facing: 1 });
  // Before the field has shown itself the base alone says where, and how high. Whichever way the base faces, the board
  // is turned about its middle: the workshop shows every design with its front to the right.
  assert.deepEqual(boardSite(base, heavy), { x: base.x - 12, y: 37.5, mirror: true });
  assert.deepEqual(boardSite({ ...base, facing: 1 }, heavy), { x: base.x - 12, y: 37.5, mirror: true });
  const empty = { plates: [], modules: [] };
  assert.equal(boardSite(base, heavy, { state: empty }).x, base.x - 12);
  // Its stretch of the row is that of the construction facing right.
  const wide = maxX - minX; assert(wide > 6 && wide < 12);
  const place = taken => boardSite(base, heavy, { state: { plates: taken, modules: [] } }).x + 12;
  assert.equal(place([standing('a', base.x - 2, base.x + 2)]), base.x - 12, 'the middle is taken: one place to the left');
  assert.equal(place([standing('a', base.x - 2, base.x + 2), standing('b', base.x - 14, base.x - 10)]), base.x + 12, 'then one to the right');
  assert.equal(place([standing('a', base.x - 2, base.x + 2), standing('b', base.x - 14, base.x - 10), standing('c', base.x + 10, base.x + 14)]), base.x - 24);
  // What stands clear of the stretch by 0.8 m leaves the place free, and what does not takes it.
  const edge = base.x + maxX;
  assert.equal(place([standing('a', edge + .81, edge + 3)]), base.x);
  assert.equal(place([standing('a', edge + .79, edge + 3)]), base.x - 12);
  // Between two constructions there is a place if the design fits it with that clearance. The parts of
  // one construction are one stretch: between two of them there is none.
  assert.equal(place([standing('a', base.x - 9, base.x - 8), standing('b', base.x + 8, base.x + 9)]), base.x);
  assert.equal(place([standing('a', base.x - 9, base.x - 8), { ...standing('a', base.x + 8, base.x + 9), id: 'a:other' }]), base.x - 24);
  assert.equal(place([standing('a', base.x - 9, base.x - 4), standing('b', base.x + 4, base.x + 9)]), base.x - 24, 'nor between two constructions too near each other');
  // Turned to face right it is turned about its middle, and takes the stretch it has then: a design that reaches left of
  // its middle reaches right of it on the board.
  const lopsided = { plates: [{ x: 9, y: 1, length: 6, angle: 0, thicknessMm: 100 }], modules: [] };
  assert.equal(boardSite(base, lopsided, { state: { plates: [standing('a', base.x - 8, base.x - 5)], modules: [] } }).x + 12, base.x, 'turned, to the right of it');
  assert.equal(boardSite(base, lopsided, { state: { plates: [standing('a', base.x + 5, base.x + 8)], modules: [] } }).x + 12, base.x - 12, 'and kept off what stands there');
  // A row with no place left: the board stays at the middle of the base, where the field will refuse the design.
  const full = Array.from({ length: 41 }, (_, i) => standing('full' + i, base.x - 120 + i * 6, base.x - 116 + i * 6));
  assert.equal(place(full), base.x);
});

test('the floor of the board is level, at the highest ground under what the field takes of a construction', () => {
  const base = { x: 125000, y: 40, facing: 1, radius: 100 },
    slope = { height: x => 40 + (x - base.x) * .2 }, dip = { height: x => 40 - Math.max(0, 3 - Math.abs(x - base.x)) },
    step = { height: x => x > base.x + 6.9 ? 43 : 40 };
  assert.deepEqual(boardSite(base, heavy, { ground: slope }), { x: base.x - 12, y: 40 + 7 * .2, mirror: true }, 'on a slope, the ground at its upper end');
  assert.deepEqual(boardSite(base, heavy, { ground: dip }), { x: base.x - 12, y: 40, mirror: true }, 'over a hollow, its rims');
  assert.equal(boardSite(base, heavy, { ground: step }).y, 43, 'a step under its last metre lifts all of it');
  assert.equal(boardSite({ ...base, x: base.x - 1 }, heavy, { ground: step }).y, 40, 'and one metre away it stands below the step');
  // The deck is drawn in the frame of the board: its top at zero from end to end, its body down to the ground. The base
  // faces right, and so does the design: the board is turned about its middle, and its floor with it.
  const site = boardSite(base, heavy, { ground: slope }), polys = [], lines = [];
  const g = { poly(points) { polys.push(points); return g; }, rect(...box) { polys.push(box); return g; }, fill() { return g; }, stroke() { return g; },
    moveTo(x, y) { lines.push([{ x, y }]); return g; }, lineTo(x, y) { lines.at(-1).push({ x, y }); return g; } };
  drawBoardFloor(g, site, slope);
  const deck = polys[0], points = Array.from({ length: deck.length / 2 }, (_, i) => ({ x: deck[i * 2], y: deck[i * 2 + 1] })), top = points.filter(p => p.y === 0);
  assert.deepEqual(top.map(p => p.x), [BOARD.minX - .6, BOARD.maxX + .6]);
  for (const p of points.filter(p => p.y !== 0)) {
    assert(p.x >= BOARD.minX - .6 && p.x <= BOARD.maxX + .6);
    assert(Math.abs(p.y - (Math.min(0, slope.height(fieldX(site, p.x)) - site.y) - .14)) < 1e-9, 'the foot is a little under the ground, or under the deck where the ground is over it');
  }
  assert(Math.min(...points.map(p => p.y)) < -2.5, 'at the lower end of the slope the body is as deep as the ground is low');
  assert(Math.max(...deck.map(Math.abs)) < 21 && lines.flat().every(p => Math.abs(p.x) < 21 && Math.abs(p.y) < 5), 'and every number of it is of the board, not of the field');
  assert(lines.length >= 7, 'with a seam every two metres');
});

test('the place of the board is the place the server gives the construction when it is published facing right', t => {
  const room = rehearsal([-100]); t.after(() => room.world.dispose());
  const joined = room.join('Oficina'), player = room.players.get(joined.playerId), base = joined.base, ground = room.world.terrain;
  assert.deepEqual([base.x, base.radius, base.y], [-100, BASE_RADIUS, ground.height(-100)]);
  const published = [];
  for (const [model, facing] of [['scout', 1], ['heavy', 1], ['recon', -1], ['tracked', 1], ['chassis', -1], ['mortar', 1], ['heavy', -1], ['scout', -1]]) {
    const source = createStructuredTemplate(model), design = compileStructuredConstruction(source), state = room.world.snapshot(),
      site = boardSite(base, design, { ground, state }), at = room.placement(player, source, null, facing);
    // Facing right, as the board shows it, it comes in over the board; facing left, at the place of the row it takes then.
    if (facing === 1) assert.equal(site.x + BOARD.middle, at, `${model} facing ${facing}, after ${published.join(', ') || 'nothing'}`);
    player.builtAt = -Infinity;
    const id = room.publish(joined.playerId, source, { facing }).actor.id, bounds = room.world.actorBounds(id), { low, high } = reach(design);
    published.push(model);
    // It came in where the field placed it, turned as asked about the middle.
    const from = at + Math.min(-facing * (low - 12), -facing * (high - 12)), to = at + Math.max(-facing * (low - 12), -facing * (high - 12));
    assert(Math.abs(bounds.minX - from) < .6 && Math.abs(bounds.maxX - to) < .6, `${model}: ${bounds.minX} to ${bounds.maxX} against ${from} to ${to}`);
    for (let i = 0; i < 30; i++) room.step();
  }
  assert.equal(new Set(room.world.actors.map(actor => Math.round(room.position(actor)))).size, 8, 'eight constructions, eight places of the row');
  // The page asks the field for no place: the row is the only one a player gets. A rehearsal may still ask for one, inside the base.
  const source = createStructuredTemplate('scout');
  assert.equal(room.placement(player, source, -163, 1), -163); assert.throws(() => room.placement(player, source, -500, 1), /Fabrique dentro da base/);
});
