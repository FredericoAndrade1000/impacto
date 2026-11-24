import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, GpuGraphicsContext, Matrix, Mesh, ParticleContainer, buildContextBatches } from 'pixi.js';
import { anchorGraphics } from '../src/world-anchor.ts';
import { watchPosts, WATCH_RADAR } from '../src/base-art.ts';
import { radarAerial } from '../src/machine-art.ts';
import { Renderer } from '../src/render.ts';
import { GroundTrails } from '../src/terrain-art.ts';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint, validateBlueprint } from '../src/persistence.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { weaponSettings } from '../src/weapons.ts';
import { startWeaponRecoil, advanceWeaponRecoil, carried } from '../src/weapon-presentation.ts';
import { weaponAngle } from '../src/weapon-geometry.ts';
import { depositsOf, depositsNear } from '../src/deposits.ts';
import { knownVeins } from '../src/faction-ui.ts';
import { DEPOSIT_ART_REACH } from '../src/deposit-art.ts';
import { Editor } from '../src/editor.ts';
import { BOARD, boardSite, fieldX } from '../src/workshop-site.ts';
import { componentPolygon } from '../src/assembly.ts';
import { plateCorners } from '../src/math.ts';
import { chassisPlacement, chassisPoint, floorSegment } from '../src/chassis-art.ts';
import { groundSurfaces } from './helpers/ground-art.js';
import { ROUGH } from '../src/terrain-scene.ts';
import { CELL } from '../src/grid.ts';
import { MAIN_LIGHT } from '../src/main-light.ts';

// What an object hands Pixi as its own numbers, which the GPU takes in single precision: the vertices a
// drawing is built into, the corners of a mesh, the places of the particles of a container. A sprite or a
// text hands over none: it is a quad of its own size, moved by its place in double precision.
function ownNumbers(node) {
  if (node instanceof Graphics) { const gpu = new GpuGraphicsContext(); buildContextBatches(node.context, gpu); return gpu.geometryData.vertices; }
  if (node instanceof ParticleContainer) return node.particleChildren.flatMap(p => [p.x, p.y]);
  if (node instanceof Mesh) return node.geometry.getBuffer('aPosition').data;
  return null;
}
// Everything under a container that hands numbers over, each with the largest of them along either axis.
function handed(root) {
  const found = [];
  (function visit(node) {
    const numbers = ownNumbers(node);
    if (numbers) {
      let x = 0, y = 0;
      for (let i = 0; i < numbers.length; i += 2) { x = Math.max(x, Math.abs(numbers[i])); y = Math.max(y, Math.abs(numbers[i + 1])); }
      found.push({ node, count: numbers.length, x, y, most: Math.max(x, y) });
    }
    for (const child of node.children || []) visit(child);
  })(root);
  return found;
}
const largest = root => Math.max(0, ...handed(root).map(found => found.most));
// Where those numbers are in the frame of `root`: each taken through the place of the object and of
// whatever holds it, in double precision. This is the world place the object shows them at.
function places(node, root = null) {
  const matrix = new Matrix(), numbers = ownNumbers(node), out = [];
  if (!numbers) return node.children.flatMap(child => places(child, root));
  for (let at = node; at && at !== root; at = at.parent) { at.updateLocalTransform(); matrix.prepend(at.localTransform); }
  for (let i = 0; i < numbers.length; i += 2)
    out.push({ x: matrix.a * numbers[i] + matrix.c * numbers[i + 1] + matrix.tx, y: matrix.b * numbers[i] + matrix.d * numbers[i + 1] + matrix.ty });
  return out;
}
const distance = (points, x, y) => { let least = Infinity; for (const p of points) least = Math.min(least, Math.hypot(p.x - x, p.y - y)); return least; };
// Whether some of the points lie on the round of a radius about a place.
const around = (points, x, y, radius, slack) => points.some(p => Math.abs(Math.hypot(p.x - x, p.y - y) - radius) < slack);
const span = (points, of) => { let low = Infinity, high = -Infinity; for (const p of points) { const v = of(p); low = Math.min(low, v); high = Math.max(high, v); } return { low, high }; };

// One drawing with every family of call the renderer makes: paths, shapes and lines of a width.
function sample(g, x, y) {
  g.moveTo(x, y).lineTo(x + 1, y + .5).lineTo(x + 2, y - .25).stroke({ color: 1, width: .02 });
  g.moveTo(x, y + 1).quadraticCurveTo(x + .5, y + 2, x + 1, y + 1).stroke({ color: 1, width: .013, cap: 'round' });
  g.moveTo(x + 3, y).bezierCurveTo(x + 3.2, y + 1, x + 3.8, y + 1, x + 4, y).stroke({ color: 1, width: .05, join: 'round' });
  g.moveTo(x + 5, y).arc(x + 5, y + 1, .7, 0, 2).stroke({ color: 1, width: .03 });
  g.moveTo(x + 8, y).lineTo(x + 9, y).lineTo(x + 8.5, y + 1).closePath().fill(2);
  g.poly([x, y + 3, x + 1, y + 3, x + 1.2, y + 4, x - .2, y + 3.8]).fill(3).stroke({ color: 1, width: .018, join: 'round' });
  g.rect(x + 2, y + 3, 1.5, .4).fill(4).stroke({ color: 1, width: .012 });
  g.circle(x + 5, y + 3, .8).fill({ color: 5, alpha: .5 });
  g.ellipse(x + 7, y + 3, 3.1, .11).fill({ color: 6, alpha: .27 });
  g.roundRect(x + 9, y + 3, .5, .15, .035).fill(7).stroke({ color: 1, width: .018 });
  for (let i = 0; i < 40; i++) g.moveTo(x + i * .1, y + 5).lineTo(x + i * .1 + .05, y + 5.3);
  g.stroke({ color: 1, width: .01, alpha: .68 });
}

test('a drawing anchored far from the origin is built into the small vertices it has at the origin', () => {
  const X = 127000.375, Y = 1234.5, near = new Graphics(), far = new Graphics(), stated = new Graphics();
  sample(anchorGraphics(near, 0, 0), 0, 0); sample(anchorGraphics(far, X, Y), X, Y); sample(stated, X, Y);
  const here = ownNumbers(near), there = ownNumbers(far);
  assert(here.length > 400, 'past four hundred numbers Pixi sends the vertices of a drawing to the GPU as they are');
  assert.equal(there.length, here.length);
  for (const [i, value] of here.entries()) assert(Math.abs(value - there[i]) < 1e-9, `vertex number ${i}: ${there[i]} against ${value}`);
  assert(largest(far) < 13, 'what the anchored drawing hands over is the size of the drawing');
  assert(largest(stated) > 127000, 'while one that states the world as it is hands over the place itself');
  // The drawing stands at its anchor, and a vertex is where its place and its number put it.
  assert.deepEqual([far.x, far.y], [X, Y]);
  const shown = places(far), origin = places(near);
  for (const [i, p] of shown.entries()) assert(Math.abs(p.x - X - origin[i].x) < 1e-9 && Math.abs(p.y - Y - origin[i].y) < 1e-9);
  // The corners of the triangle, as they were asked for.
  for (const [x, y] of [[X + 8, Y], [X + 9, Y], [X + 8.5, Y + 1]]) assert(distance(shown, x, y) < 1e-9);
  for (const g of [near, far, stated]) g.destroy();
});

test('anchoring empties a drawing, leaves an empty one alone, and a plain clear loses the anchor', () => {
  const X = 127000.375, Y = 1234.5, g = new Graphics(); let updates = 0;
  g.context.on('update', () => updates++);
  anchorGraphics(g, 5, 7); anchorGraphics(g, X, Y);
  assert.equal(updates, 0, 'an empty drawing is not handed to Pixi to be built again');
  assert.deepEqual([g.x, g.y, g.context.getTransform().tx, g.context.getTransform().ty], [X, Y, -X, -Y], 'and its anchor is the last one given, not the sum of them');
  sample(g, X, Y); updates = 0;
  anchorGraphics(g, X + 20, Y);
  assert.equal(updates, 1); assert.equal(g.context.instructions.length, 0); assert.equal(g.x, X + 20);
  sample(g, X + 20, Y); assert(largest(g) < 13);
  // Emptied by `clear` the drawing keeps its place and forgets what to take from each call: it would be drawn
  // its whole anchor away. Both what it hands over and where that lands tell it.
  g.clear(); sample(g, X + 20, Y);
  assert(largest(g) > 127000); assert(distance(places(g), X + 28, Y) > 127000);
  g.destroy();
});

// The far field: the main world, a wheeled construction 173 km from its middle with a base beside it, and
// the renderer drawing whole frames of it. Nothing is shown: the canvas takes whatever is painted on it
// and the application renders nothing, so every object of the scene is the real one, as a frame leaves it.
await initNativeDynamics();

const SITE = -173225, ZOOM = 12, WIDTH = 1280, HEIGHT = 720;
const blueprint = createConstruction('recon'); blueprint.terrain = MAIN_WORLD.terrain;
const world = new World(blueprint, { scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } });
world.replaceActor(world.construction, { id: 'local', x: SITE, facing: -1 });
const view = { mode: 'test', testTool: 'fire', weapon: { platform: 'vehicle' }, aim: { x: SITE - 300, y: world.terrain.height(SITE - 300) + 20 } },
  renderer = new Renderer({ clientWidth: WIDTH, clientHeight: HEIGHT }, view), camera = renderer.camera,
  base = { x: SITE + 60, radius: 100, facing: 1 },
  marks = Array.from({ length: 6 }, (_, i) => ({ x: .25 + i * .12, y: 0, radius: .02 }));
renderer.app = { stage: new Container(), renderer: { render() {}, resize() {}, backBuffer: { useBackBuffer: false } } };
renderer.buildScene(groundSurfaces());
Object.assign(camera, { x: world.vehicle.x, y: world.vehicle.y + 1, zoom: ZOOM });
let now = 0, shown = null;
// A frame as the page draws one: the field steps, tells its state, and the renderer draws it.
function frame(follow = true) {
  world.step();
  const state = world.snapshot(), gun = state.modules.find(m => m.kind === 'weapon');
  // What the field is told beside the construction: the base of its faction, six more wheels like its own
  // three, and a barrel that has been hit six times. The arms and the marks of one construction are then a
  // drawing of the size Pixi does not batch.
  state.faction = { id: 'own', base, flag: { field: 'cross', colours: [4, 0, 8], emblem: 'ring' }, known: [] }; gun.barrelMarks = marks;
  for (const wheel of state.modules.filter(m => m.kind === 'wheel')) for (const k of [1, 2])
    state.modules.push({ ...wheel, id: wheel.id + ':more' + k, x: wheel.x + .66 * k, groundContact: null });
  renderer.receive(state, world.drainEvents(), { now });
  shown = renderer.draw({ now, follow: follow ? state.controlledActor || 'local' : null }); now += 1000 / 60;
  return shown;
}
for (let i = 0; i < 30; i++) frame();
world.controlVehicle(-1, 0); for (let i = 0; i < 240; i++) frame();
const gun = world.modules.find(m => m.kind === 'weapon'), config = weaponSettings('machinegun', { preset: gun.weaponPreset, platform: 'vehicle', componentId: gun.id });
view.aim = { x: world.vehicle.x - 300, y: world.terrain.height(world.vehicle.x - 300) + 20 };
world.controlVehicle(0, 1); world.aimWeapon(view.aim, config); for (let i = 0; i < 240; i++) frame();
// Three bursts on the ground beside it and four rounds from its gun, one a frame: the last frame holds the
// four rounds, the soot of the bursts, their sparks, fire, smoke and heat.
for (const away of [9, 13, 17]) world.explode(world.vehicle.x - away, world.terrain.height(world.vehicle.x - away) + .2, 240, 3);
const fired = [];
for (let i = 0; i < 4; i++) { fired.push(world.fire(view.aim, config, true)); frame(); }
// The field of these frames is not the shared one, which alone has diggings: they are asked for as it asks for them,
// once the last frame is drawn, and stand in the scene from here on.
// The faction knows a vein at every site of the stretch about the view but the last: that one is ground like any other.
// Every one of them is drawn, the vein under it as far as it is known.
const told = sites => ({ deposits: sites.map(site => ({ id: site.id, left: site.reserve, at: null, seen: true, loading: false, active: true })) }),
  about = depositsNear(depositsOf(renderer.ground), camera.x, WIDTH / ZOOM / 2 + 512 + DEPOSIT_ART_REACH), dug = about.slice(0, -1), bare = about.at(-1),
  veins = knownVeins(depositsOf(renderer.ground), told(dug)), laid = camera.x;
renderer.drawDeposits(veins);
// So near, the ground is drawn with the bumps its running gear stands on (terrain-scene.ts `BUMPS_ZOOM`): what stands on
// it stands on them (`underfoot`, render.ts `standing`, and `onFoot`), and the rest on its line (`over`).
const ground = renderer.ground, underfoot = renderer.standing(), scene = renderer.terrainScene, effects = renderer.effects, layers = renderer.actorLayers.get('local'),
  painted = scene.chunks.filter(chunk => chunk.earth?.visible), over = p => p.y - ground.height(p.x), onFoot = p => p.y - underfoot.height(p.x),
  seen = WIDTH / ZOOM, top = Math.max(...painted.flatMap(chunk => ground.points.filter(p => p.x >= chunk.left && p.x <= chunk.right).map(p => p.y)));

test('the frame is the far field of the main world, with everything the renderer draws in it', () => {
  assert.equal(ground.id, 'world'); assert.equal(ground.maxX - ground.minX, 512000);
  assert(Math.abs(camera.x - SITE) < 200 && camera.zoom === ZOOM, 'the camera is over the construction, 173 km out');
  assert(Math.abs(world.vehicle.x - camera.x) < 5);
  assert.deepEqual(fired, [true, true, true, true]);
  assert.equal(shown.shots.filter(shot => !shot.fragment).length, 4); assert(!Object.hasOwn(shown, 'traces'));
  assert(renderer.groundTrails.marks.length > 100); assert.equal(effects.scorches.length, 3);
  assert(effects.particles.length > 100 && effects.actorLayers.has('local')); assert(renderer.heatHaze.count > 0 && renderer.heatHaze.mesh.visible);
  assert(renderer.aimPreview.path.length > 2); assert(renderer.baseWorks.visible);
  assert(painted.length >= 1 && painted.every(chunk => chunk.fine && chunk.props && chunk.strata && chunk.grain && chunk.soil), 'the ground under the camera has its near detail');
  assert(painted.some(chunk => chunk.flora));
});

// How large a number each object under the world may hand over, and why. Whatever is not named here is a
// part of a construction, counted from the part: a plate, a wheel, a rim, a shadow, a hull. `near` is how
// far from the camera what a frame draws anew may be: on the screen or beside it while the camera looks at
// what goes on, and as far as the camera has gone from it once it looks elsewhere.
function allowances(near = seen) {
  const allowed = new Map(), allow = (node, most, why) => {
    for (const {node:drawn} of handed(node)) allowed.set(drawn,{most,why});
  }, clip = renderer.effectSurfaceClip;
  for (const chunk of scene.chunks.filter(chunk => chunk.earth)) {
    const long = chunk.right - chunk.left + 2;
    for (const name of ['earth', 'stones', 'fine', 'props', 'soil', 'flora', 'frontFlora', 'frontCover', 'ruins']) if (chunk[name])
      allow(chunk[name], Math.max(long, top + 10), 'a stretch of ground is counted from its left end, 512 m long at most, and its heights from zero');
    for (const name of ['strata', 'grain']) if (chunk[name])
      allow(chunk[name], Math.max(long, top, 100 - scene.floor), 'the earth goes down a hundred metres past its foot, four kilometres under the lowest ground');
  }
  for (const made of [renderer.baseWorks, renderer.baseArt, renderer.baseWatch]) allow(made, Math.max(base.radius + 12, top + 25), 'a base is counted from its middle, a hundred metres to each end, and its heights from zero');
  allow(renderer.groundMarks, 512.1, 'each small lot of marks is counted from its own first mark, at most 512 m from any endpoint');
  for (const made of [...renderer.depositSites.values()].flatMap(art => [art.works, art.front, ...art.vein ? Object.values(art.vein) : []]).concat(renderer.depositFading.flatMap(fading => fading.parts)))
    allow(made, DEPOSIT_ART_REACH + 30, 'a site is drawn from its place on the ground, thirty metres to each side, its vein under it and its works over it');
  allow(renderer.overlay, 300 + seen, 'the aim is 300 m from the gun, and the arc to it is drawn from the camera');
  for (const { mask } of clip.hosts.values()) allow(mask, Math.max(clip.bounds.right - clip.bounds.left, clip.bounds.top), 'the outline of the ground is counted from the left end of the stretch the view covers, and its heights from zero');
  for (const drawn of [renderer.shadows, renderer.scorchMarks.graphics, renderer.trails, renderer.heatHaze.mesh, renderer.surfaceLight.ground, layers.suspensionArms, layers.gun,
    ...[renderer.tails, renderer.markers, renderer.glows, renderer.specks, renderer.speckGlows].map(quads => quads.mesh),
    ...[effects, ...effects.actorLayers.values()].flatMap(group => [group.smoke, group.fire, group.sparks])])
    allow(drawn, near, 'what a frame draws anew is counted from its camera, and is on the screen or beside it');
  return { allowed, allow };
}
// Everything under the world that hands numbers over, each held to what it is allowed.
function withinAllowances(allowed) {
  const found = handed(renderer.world);
  assert(found.length > 60, 'the scene is all there');
  for (const { node, most, count } of found) {
    const { most: limit, why } = allowed.get(node) || { most: 16, why: 'a part of a construction is counted from itself' };
    assert(most <= limit, `${node.label || node.constructor.name} of ${count} numbers hands over ${most}, past ${limit}: ${why}`);
  }
  for (const node of allowed.keys()) assert(found.some(one => one.node === node), 'every object named is under the world');
  return found;
}

test('nothing under the world of the renderer hands Pixi a number of the size of the world', () => {
  // The construction of this frame is a vehicle.
  withinAllowances(allowances().allowed);
  // The largest of them all is the foot of the earth. It was the place itself: 125 000.
  assert(largest(renderer.world) < 4200);
  // The drawings that are past what Pixi batches, and so go to the GPU as they are.
  for (const drawn of [painted[0].earth, painted[0].fine, painted[0].props, renderer.groundMarks, renderer.baseWorks, renderer.baseArt,
    renderer.scorchMarks.graphics, renderer.trails, renderer.overlay, layers.gun]) {
    const count = handed(drawn).reduce((sum, part) => sum + part.count, 0), tiled = drawn === painted[0].fine || drawn === painted[0].props;
    assert(count > (tiled ? 0 : 400), (drawn.label || 'a drawing') + ' of ' + count);
  }
});

test('low foreground stands over vehicles while the scenery stays behind and aiming stays visible', () => {
  const order = node => renderer.world.getChildIndex(node), foreground = renderer.terrainScene.foreground;
  assert(order(renderer.scenery) < order(renderer.actorLayerRoot));
  assert(order(renderer.actorLayerRoot) < order(foreground));
  assert(order(foreground) < order(renderer.benchArt)); assert(order(foreground) < order(renderer.overlay));
  assert.equal(renderer.terrainScene.layers.frontFlora.parent, foreground);
  assert.equal(renderer.terrainScene.layers.frontCover.parent, foreground);
});

test('the ground is drawn from the left end of each stretch, on the outline a vehicle stands on', () => {
  assert(painted.every(chunk => chunk.step === ROUGH) && painted.some(chunk => ground.points.some(p => p.x > chunk.left && p.x < chunk.right && underfoot.height(p.x) !== p.y)),
    'so near, the ground is drawn with the bumps over its line');
  for (const chunk of painted) {
    for (const part of [chunk.earth, chunk.fine, chunk.props, chunk.strata, chunk.grain, chunk.soil]) assert.deepEqual([part.x, part.y], [chunk.left, 0]);
    // Every corner remains at the height the running gear stands on there, the bumps over the line. The Mesh hands
    // the GPU a Float32 local X and height, then its double-precision anchor places those numbers.
    const earth = places(chunk.earth, renderer.world), outline = ground.points.filter(p => p.x > chunk.left && p.x < chunk.right);
    assert(outline.length >= 2, 'the stretch contains multiple physical contact samples');
    assert(outline[0].x - chunk.left <= ground.spacing + 1e-9 && chunk.right - outline.at(-1).x <= ground.spacing + 1e-9,
      'physical samples cover the stretch up to its two end segments');
    for (const p of outline) assert(distance(earth, chunk.left + Math.fround(p.x - chunk.left), Math.fround(underfoot.height(p.x))) < 1e-9, `the outline at ${p.x}`);
    // It begins at the left end of the stretch and runs a little past the right one, under the stretch that follows.
    const along = span(earth, p => p.x); assert(Math.abs(along.low - chunk.left) < .01 && along.high > chunk.right && along.high < chunk.right + 2, `${along.low} to ${along.high}`);
    const depth = span(earth, onFoot); assert(depth.low > -2.4 && depth.high < .02);
    // Near decoration is local, but whole features and sprites can extend naturally across a chunk edge.
    const fine = places(chunk.fine, renderer.world), props = places(chunk.props, renderer.world), soil = places(chunk.soil, renderer.world);
    for (const part of chunk.details.filter(part => part.soil)) {
      assert(part.soil instanceof Container && part.soil.children.every(mesh => mesh instanceof Mesh));
      assert.deepEqual([part.soil.x + chunk.soil.x, part.soil.y + chunk.soil.y], [part.left, 0]);
      assert(part.soil.children.every(mesh => Object.values(scene.art.grains).includes(mesh.texture)));
      // Soil stays clipped to its tile; only the local end sent in Float32 may round past the physical end.
      const along = span(places(part.soil, renderer.world), p => p.x), right = Math.max(part.right, part.left + Math.fround(part.right - part.left));
      assert(along.low >= part.left && along.high <= right + 1e-9);
    }
    for (const [points, low, high] of [[fine, -3.5, 0], [props, -1, 6], [soil, -2.4, 0]]) {
      const up = span(points, onFoot);
      assert(up.low > low && up.high < high, `${up.low} to ${up.high}`);
    }
    if (chunk.flora) { const trees = span(places(chunk.flora, renderer.world), over); assert(trees.low > -3 && trees.high < 40); }
    // A ruin stands on its slab, about the middle it has in the stretch, its foot hidden by the earth before it.
    if (chunk.ruins) {
      assert.deepEqual([chunk.ruins.x, chunk.ruins.y], [chunk.left, 0]);
      const ruins = places(chunk.ruins, renderer.world), along = span(ruins, p => p.x), up = span(ruins, over);
      assert(along.low > chunk.left - 20 && along.high < chunk.right + 20 && up.low > -3 && up.high < 10, `${up.low} to ${up.high}`);
    }
  }
});

test('tyre marks have local anchors and lie on the ground the wheels ran over', () => {
  const g = renderer.groundMarks, made = renderer.groundTrails.marks, drawn = places(g, renderer.world);
  assert(g.children.length > 1 && g.children.every(child => Math.abs(child.x - camera.x) < 60));
  const along = span(drawn, p => p.x), ends = span(made.flatMap(mark => [mark.a, mark.b]), x => x);
  assert(Math.abs(along.low - ends.low) < .02 && Math.abs(along.high - ends.high) < .02, 'the marks start and end where the wheels did');
  assert(ends.high - ends.low > 20 && Math.abs(ends.low - camera.x) < 60);
  for (const mark of made) assert(distance(drawn, mark.a, mark.y1) < .02 && distance(drawn, mark.b, mark.y2) < .02);
  const lift = span(drawn, onFoot); assert(lift.low > -.01 && lift.high < .03);
});

test('the base stands at its own place, with its works on the ground it covers and its flag over them', () => {
  const works = places(renderer.baseWorks, renderer.world), front = places(renderer.baseArt, renderer.world), label = renderer.baseLabel;
  for (const made of [renderer.baseWorks, renderer.baseArt, renderer.baseWatch]) assert.deepEqual([made.x, made.y], [base.x, 0]);
  // Its radar and its microphones stand where its watch is: the turntable on the top of the mast, the aerial turning
  // over it within the round it turns in at constant height, a microphone on the head of each stake.
  const posts = watchPosts(base, ground), [turntable, aerial, ...ears] = renderer.watchPieces.children;
  assert(renderer.baseWatch.visible && renderer.watchPieces.visible);
  assert.deepEqual([turntable.x, turntable.y], [posts.radar.x, posts.radar.y]);
  assert(aerial.x === posts.radar.x && aerial.y > posts.radar.y && aerial.y < posts.radar.y + WATCH_RADAR.height);
  const shape = radarAerial(WATCH_RADAR.width, WATCH_RADAR.height);
  for (const side of aerial.children.filter(side => side.visible)) for (const dx of [-.5, .5]) for (const dy of [-.5, .5]) {
    const x = side.x + dx * side.width, y = side.y + dy * side.height;
    assert(Math.abs(x) <= Math.hypot(shape.width, shape.depth) / 2 + 1e-9, `${x}, ${y}`);
    assert(Math.abs(Math.abs(y) - shape.height / 2) < 1e-9, `${x}, ${y}`);
  }
  assert.deepEqual(ears.map(ear => [ear.visible, ear.x, ear.y]), posts.ears.map(ear => [true, ear.x, ear.y]));
  for (const points of [works, front]) {
    const along = span(points, p => p.x - base.x);
    assert(along.low > -101 && along.low < -99.8 && along.high < 101 && along.high > 99.8, 'from one end of its ground to the other');
  }
  const band = span(front, over), built = span(works, over);
  assert(band.low > -.5 && band.high < .2, 'the band lies on the ground'); assert(built.low > -5 && built.high < 25, 'the works stand on it');
  // The label is a text at its place in the world, a few pixels over the top of the flag that is drawn.
  assert.equal(label.x, base.x + 5.5);
  assert(works.some(p => Math.abs(p.y - (label.y - 3 / ZOOM)) < 1e-9 && Math.abs(p.x - label.x) < 3));
});

test('a base of another faction stands at its own place as the faction\'s does, named, without its watch, paler out of sight and drawn again only when it changes', () => {
  const bia = { id: 'f2', name: 'Bia', nation: 'Antártida', flag: { field: 'canton', colours: [4, 0, 8], emblem: 'ring' }, x: camera.x - 40, facing: -1, radius: 100, seen: true, at: null },
    far = { ...bia, id: 'f3', nation: null, x: camera.x + 9000, seen: false, at: 20 }, known = () => renderer.foreignBases;
  renderer.drawForeignBases([bia, far]);
  const art = known().get('f2');
  assert.deepEqual([...known().keys()], ['f2'], 'one far from the view is not drawn');
  for (const made of [art.works, art.front]) assert.deepEqual([made.x, made.y], [bia.x, 0]);
  const works = places(art.works, renderer.world), front = places(art.front, renderer.world);
  for (const points of [works, front]) {
    const along = span(points, p => p.x - bia.x);
    assert(along.low > -101 && along.low < -99.8 && along.high < 101 && along.high > 99.8, 'from one end of its ground to the other');
  }
  assert(largest(art.works) < Math.max(bia.radius + 12, top + 25) && largest(art.front) < Math.max(bia.radius + 12, top + 25), 'counted from its middle');
  const pivot = watchPosts(bia, ground).radar;
  assert(distance(works, pivot.x, pivot.y) > 1, 'no radar of its watch');
  // Its label names it, a few pixels over the top of its flag.
  assert.equal(art.label.text, 'Base · Antártida'); assert.equal(art.label.x, bia.x - 5.5);
  assert(works.some(p => Math.abs(p.y - (art.label.y - 3 / camera.zoom)) < 1e-9 && Math.abs(p.x - art.label.x) < 3));
  assert.deepEqual([art.works.alpha, art.front.alpha, art.label.alpha, art.works.visible], [1, 1, 1, true]);
  // Told of again as it was, it is the same drawing; out of sight it is the same drawing, paler.
  const drawn = art.drawn;
  renderer.drawForeignBases([{ ...bia }, far]); assert.equal(art.drawn, drawn);
  renderer.drawForeignBases([{ ...bia, seen: false, at: 30 }, far]); assert.equal(art.drawn, drawn);
  assert.deepEqual([art.works.alpha, art.front.alpha, art.label.alpha], [.6, .6, .6]);
  // With the view away from it, it is hidden and kept; off the field, every one is.
  const x = camera.x; camera.x = far.x;
  renderer.drawForeignBases([bia, far]);
  assert(!art.works.visible && !art.front.visible && !art.label.visible); assert(known().get('f3').works.visible);
  assert.equal(known().get('f3').label.text, 'Base · Facção de Bia');
  camera.x = x; renderer.drawForeignBases(null);
  assert.equal(known().size, 2); assert(![...known().values()].some(one => one.works.visible || one.front.visible || one.label.visible));
  // A base the faction no longer knows is let go.
  renderer.drawForeignBases([far]); assert.deepEqual([...known().keys()], ['f3']); assert(art.works.destroyed && art.front.destroyed && art.label.destroyed);
  renderer.drawForeignBases([]); assert.equal(known().size, 0);
});

test('every site about the view is drawn from its own place on the ground, and the vein under it as far as the faction knows it', () => {
  const sites = renderer.depositSites, at = site => sites.get(site.id);
  assert(dug.length >= 2 && bare.x > dug.at(-1).x + 2 * DEPOSIT_ART_REACH, 'the stretch about the view has sites, and the last of them stands clear of the others');
  assert.deepEqual([...sites.keys()].sort(), about.map(site => site.id).sort(), 'a drawing for each site of the stretch about the view, and for none other');
  for (const site of about) {
    const art = at(site), height = ground.height(site.x), works = places(art.works, renderer.world), front = places(art.front, renderer.world);
    for (const made of [art.works, art.front, ...art.vein ? Object.values(art.vein) : []]) assert.deepEqual([made.x, made.y], [site.x, height]);
    // The ground of a site is drawn whatever the faction knows: what stands on it and what lies on it, within its reach.
    assert(works.length + front.length > 40, 'the ground of ' + site.id);
    const along = span([...works, ...front], p => p.x), stood = span(works, over), lay = span(front, over);
    assert(along.low >= site.x - DEPOSIT_ART_REACH - .5 && along.high <= site.x + DEPOSIT_ART_REACH + .5, `${site.id} from ${along.low - site.x} to ${along.high - site.x}`);
    assert(stood.low > -2 && stood.high < 12, stood.low + ' to ' + stood.high); if (front.length) assert(lay.low > -1 && lay.high < 1, lay.low + ' to ' + lay.high);
    if (site === bare) {
      // A site the faction knows no vein at has no vein drawn, nothing under the ground and no post: it is ground like any other.
      assert.equal(art.vein, null); assert.deepEqual(art.drawn, { key: '-', plate: null });
      continue;
    }
    // The vein lies under the ground and within the reach of its site; its post rises from the ground at the site itself, its plate over it.
    const under = places(art.vein.under, renderer.world), standing = places(art.vein.works, renderer.world), deep = span(under, over), wide = span(under, p => p.x);
    assert(under.length > 40 && deep.high < .1 && deep.low > -40, `the vein of ${site.id}, from ${deep.low} to ${deep.high}`);
    assert(wide.low >= site.x - DEPOSIT_ART_REACH - .5 && wide.high <= site.x + DEPOSIT_ART_REACH + .5);
    assert.deepEqual(art.drawn.plate, { id: site.id, x: site.x, y: art.drawn.plate.y }); assert(art.drawn.plate.y > height + 2);
    assert(distance(standing, site.x, height) < .5, 'the post of ' + site.id);
  }
});

test('a site is drawn again when what the faction knows of its vein changes, or the scale, and only then', () => {
  const sites = renderer.depositSites, drawings = () => new Map([...sites].map(([id, art]) => [id, art.drawn])), grounds = () => new Map([...sites].map(([id, art]) => [id, art.laid])),
    zoom = camera.zoom, redrawn = (before, after = drawings()) => [...after].filter(([id, drawn]) => before.get(id) !== drawn).map(([id]) => id).sort();
  // The view goes about within the stretch laid out, and the faction is told again what it knew: nothing is drawn again.
  let kept = drawings(), laidOut = renderer.depositsLaid;
  const ground = grounds();
  camera.x = laid + 400; renderer.drawDeposits(veins); assert.equal(renderer.depositsLaid, laidOut);
  camera.x = laid; renderer.drawDeposits(knownVeins(depositsOf(renderer.ground), told(dug))); assert.notEqual(renderer.depositsLaid, laidOut); assert.deepEqual(redrawn(kept), []);
  // Less is left of every vein but the first: those veins are drawn again, the site with no vein known is not, and no ground is.
  const tell = changed => knownVeins(depositsOf(renderer.ground), { deposits: told(dug).deposits.map((vein, i) => i ? changed(vein) : vein) });
  renderer.drawDeposits(tell(vein => ({ ...vein, left: vein.left / 2 }))); assert.deepEqual(redrawn(kept), dug.slice(1).map(site => site.id).sort());
  // A little less left is drawn the same, for the ore is drawn by steps; being loaded from is drawn again.
  kept = drawings(); renderer.drawDeposits(tell(vein => ({ ...vein, left: vein.left / 2 - 1 }))); assert.deepEqual(redrawn(kept), []);
  renderer.drawDeposits(tell(vein => ({ ...vein, left: vein.left / 2 - 1, loading: true }))); assert.deepEqual(redrawn(kept), dug.slice(1).map(site => site.id).sort());
  renderer.drawDeposits(veins);
  assert.deepEqual(grounds(), ground, 'what the faction knows draws no ground again');
  // A little zoom keeps the drawings, which are drawn for steps of a third of an octave; a view twice as wide draws every one again, ground and vein.
  kept = drawings(); camera.zoom = zoom * 1.05; renderer.drawDeposits(veins); assert.deepEqual(redrawn(kept), []);
  camera.zoom = zoom / 2; renderer.drawDeposits(veins);
  assert(about.every(site => sites.get(site.id).drawn !== kept.get(site.id) && sites.get(site.id).laid !== ground.get(site.id)));
  camera.zoom = zoom; renderer.drawDeposits(veins); assert.deepEqual([...sites.keys()].sort(), about.map(site => site.id).sort());
  // The view comes to the end of the stretch: the sites still about it keep their drawings, the others are let go.
  kept = drawings(); laidOut = renderer.depositsLaid;
  camera.x = laid + 513; renderer.drawDeposits(veins); assert.notEqual(renderer.depositsLaid, laidOut);
  const now = depositsNear(depositsOf(renderer.ground), camera.x, WIDTH / ZOOM / 2 + 512 + DEPOSIT_ART_REACH);
  assert.deepEqual([...sites.keys()].sort(), now.map(site => site.id).sort());
  for (const site of now) if (kept.has(site.id)) assert.equal(sites.get(site.id).drawn, kept.get(site.id), site.id);
  for (const art of sites.values()) for (const made of [art.works, art.front, ...art.vein ? Object.values(art.vein) : []]) assert(!made.destroyed && made.parent);
  camera.x = laid; renderer.drawDeposits(veins); assert.deepEqual([...sites.keys()].sort(), about.map(site => site.id).sort());
  // Out of the shared field they are hidden, and nothing is drawn for them.
  kept = drawings(); laidOut = renderer.depositsLaid; renderer.drawDeposits(null);
  assert(!renderer.depositWorks.visible && !renderer.depositUnder.visible && !renderer.depositFront.visible); assert.equal(renderer.depositsLaid, laidOut);
  renderer.drawDeposits(veins); assert(renderer.depositWorks.visible && renderer.depositUnder.visible && renderer.depositFront.visible); assert.deepEqual(redrawn(kept), []);
  // The vein of the last site is found: it alone is drawn again, with its vein and its post.
  renderer.drawDeposits(knownVeins(depositsOf(renderer.ground), told(about)));
  assert.deepEqual(redrawn(kept), [bare.id]); assert(places(sites.get(bare.id).vein.under, renderer.world).length > 40 && sites.get(bare.id).drawn.plate);
  // Told as before, it is forgotten again, and its vein fades away.
  renderer.drawDeposits(veins); assert.equal(renderer.depositFading.length, 1); assert.equal(sites.get(bare.id).vein, null);
  renderer.drawDeposits(veins, performance.now() / 1000 + 2); assert.equal(renderer.depositFading.length, 0);
});

test('a vein the faction forgets fades out of its site over a second and a half; its ground stays as it was', () => {
  const sites = renderer.depositSites, art = sites.get(dug[0].id), ground = art.laid, parts = Object.values(art.vein), others = dug.slice(1).map(site => sites.get(site.id).drawn),
    forgot = knownVeins(depositsOf(renderer.ground), told(dug.slice(1))), alphas = list => list.map(made => made.alpha),
    // Whether what fades is these drawings, and only they (by identity: a drawing is too large to compare).
    fading = (...lists) => renderer.depositFading.length === lists.length && lists.every((list, i) => renderer.depositFading[i].parts.length === list.length && list.every((made, k) => renderer.depositFading[i].parts[k] === made));
  assert(fading());
  // The faction sees the first site bare: its vein is let go of at once, and goes on being drawn as it fades.
  renderer.drawDeposits(forgot, 100);
  assert.equal(art.vein, null); assert.deepEqual(art.drawn, { key: '-', plate: null }); assert.equal(art.laid, ground);
  assert(dug.slice(1).every((site, i) => sites.get(site.id).drawn === others[i]), 'no other site is drawn again');
  assert(fading(parts));
  for (const made of parts) assert(!made.destroyed && made.parent && made.visible);
  assert.deepEqual(alphas(parts), [1, 1, 1]);
  // Frame after frame, with nothing new told: it fades and nothing is drawn again; after a second and a half it is gone.
  const contexts = parts.map(made => made.context);
  renderer.drawDeposits(forgot, 100.75); assert(alphas(parts).every(alpha => Math.abs(alpha - .5) < 1e-9)); assert(parts.every((made, i) => made.context === contexts[i]));
  renderer.drawDeposits(forgot, 101.2); assert(alphas(parts).every(alpha => Math.abs(alpha - .2) < 1e-9));
  renderer.drawDeposits(forgot, 101.5); assert(fading()); assert(parts.every(made => made.destroyed));
  assert.equal(art.laid, ground); assert(!art.works.destroyed && !art.front.destroyed);
  // Found again as it fades, it is drawn anew at once, apart from the drawing that fades on.
  renderer.drawDeposits(veins, 102); const again = Object.values(art.vein);
  renderer.drawDeposits(forgot, 103); renderer.drawDeposits(veins, 103.5);
  assert(!Object.values(art.vein).some(made => again.includes(made))); assert.deepEqual(alphas(Object.values(art.vein)), [1, 1, 1]);
  assert(fading(again)); assert(alphas(again).every(alpha => Math.abs(alpha - 2 / 3) < 1e-9));
  // Out of the shared field what fades is gone at once, with the rest hidden.
  renderer.drawDeposits(null, 103.6); assert(fading()); assert(again.every(made => made.destroyed));
  // A faction that forgets every vein has none drawn when the fading is over: nothing under the ground, no post.
  renderer.drawDeposits(knownVeins(depositsOf(renderer.ground), told([])), 104);
  assert.equal(renderer.depositFading.length, dug.length);
  renderer.drawDeposits(knownVeins(depositsOf(renderer.ground), told([])), 106);
  assert(fading());
  for (const site of about) { const left = sites.get(site.id); assert.equal(left.vein, null); assert.equal(left.drawn.plate, null); assert(places(left.works, renderer.world).length > 0); }
  renderer.drawDeposits(veins, 107); assert.deepEqual([...sites.keys()].sort(), about.map(site => site.id).sort());
  assert(dug.every(site => sites.get(site.id).vein) && !sites.get(bare.id).vein);
});

test('soot, rounds and sparks are drawn where the bursts and the rounds are', () => {
  const scorched = renderer.scorchMarks.graphics, soot = places(scorched, renderer.world), bodies = places(renderer.trails, renderer.world),
    sparks = [effects.sparks, ...[...effects.actorLayers.values()].map(layer => layer.sparks)].flatMap(layer => places(layer, renderer.world));
  for (const drawn of [renderer.shadows, renderer.trails]) assert.deepEqual([drawn.x, drawn.y], [camera.x, camera.y]);
  // The marks of the bursts are drawn once they are in view, and stand where the camera was then: within the view.
  assert(Math.abs(scorched.x - camera.x) < seen / 2 && renderer.world.getChildIndex(scorched) === renderer.world.getChildIndex(renderer.shadows) + 1);
  assert.equal(scorched.context.instructions.length, 2 * effects.scorches.length, 'soot and core of every mark, all in view');
  for (const scorch of effects.scorches) {
    assert(Math.abs(scorch.x - camera.x) < 30);
    for (const end of [-1, 1]) assert(distance(soot, scorch.x + end * scorch.width, underfoot.height(scorch.x + end * scorch.width)) < 1e-9, 'a mark ends on the ground');
  }
  for (const p of soot) assert(onFoot(p) > -.2 && onFoot(p) < .02 &&effects.scorches.some(scorch => Math.abs(p.x - scorch.x) <= scorch.width + 1e-9));
  const rounds = shown.shots.filter(shot => !shot.fragment);
  for (const round of rounds) { assert(Math.abs(round.x - camera.x) < seen / 2); assert(distance(bodies, round.x, round.y) < 1, 'a body at its round'); }
  for (const p of bodies) assert(Math.min(...rounds.map(round => Math.hypot(p.x - round.x, p.y - round.y))) < 3);
  assert(sparks.length > 0);
  // Renderer samples effects at 1 after stepping them to the displayed time; the scene alpha belongs to rigid poses.
  const particles = effects.particles.filter(p => p.layer === effects.sparks || [...effects.actorLayers.values()].some(layer => p.layer === layer.sparks));
  for (const p of sparks) assert(distance(particles, p.x, p.y) < .0001, 'impact and explosion sparks remain at their sampled world position');
});

test('the aim, its arc and the muzzle are marked where they are', () => {
  renderer.aimPresentation?.clear(); renderer.drawOverlay(shown.state);
  const drawn = places(renderer.overlay, renderer.world), path = renderer.aimPreview.path, last = path.at(-1), solution = renderer.aimingSolution();
  assert.deepEqual([renderer.overlay.x, renderer.overlay.y], [camera.x, camera.y]);
  assert(distance(drawn, view.aim.x, view.aim.y) < 1e-9, 'the centre of the cross is the aim');
  assert(Math.abs(view.aim.x - camera.x) > 250);
  for (const p of path.slice(0, -1)) assert(distance(drawn, p.x, p.y) < .15, 'the arc passes through the path of the round');
  assert(around(drawn, last.x, last.y, 5 / ZOOM, .1), 'a ring where it ends');
  // The muzzle is where the frame draws the gun, between two states: the solution's is where the state of the forecast has it.
  const muzzle = carried(solution, shown.state.modules.find(m => m.id === gun.id), renderer.scene.pose(gun.id), weaponAngle);
  assert(around(drawn, muzzle.x, muzzle.y, 3 / ZOOM, 1e-9) && Math.hypot(muzzle.x - world.vehicle.x, muzzle.y - world.vehicle.y) < 8, 'a dot on the muzzle');
  assert(Math.hypot(path[0].x - muzzle.x, path[0].y - muzzle.y) < 1e-9, 'the arc leaves from it');
});

test('the arms, barrel marks and shadows of a construction are drawn on the construction', () => {
  const arms = places(layers.suspensionArms, renderer.world), struck = places(layers.gun, renderer.world),
    wheels = shown.state.modules.filter(m => m.kind === 'wheel'), barrel = renderer.scene.pose(gun.id);
  for (const drawn of [layers.suspensionArms, layers.gun]) assert.deepEqual([drawn.x, drawn.y], [camera.x, camera.y]);
  assert.equal(wheels.length, 9);
  for (const wheel of wheels) { const pose = renderer.scene.pose(wheel.id); assert(Math.abs(pose.x - camera.x) < 8); assert(distance(arms, pose.x, pose.y) < wheel.height / 2, 'its strut, or the bracket of one under the floor, stands over the wheel'); }
  for (const p of arms) assert(Math.hypot(p.x - world.vehicle.x, p.y - world.vehicle.y) < 5);
  const c = Math.cos(barrel.barrelAngle), s = Math.sin(barrel.barrelAngle), previous = renderer.weaponRecoil.get(gun.id),
    checkMarks = (drawn, recoil) => {
      const centres = marks.map(mark => ({ x: barrel.x + (mark.x - recoil) * c - mark.y * s,
        y: barrel.y + (mark.x - recoil) * s + mark.y * c }));
      for (const centre of centres) assert(Math.abs(distance(drawn, centre.x, centre.y) - .02) < 1e-9, 'a mark keeps its radius about its place on the recoiling tube');
      for (const p of drawn) assert(Math.min(...centres.map(centre => Math.hypot(p.x - centre.x, p.y - centre.y))) < .02 + 1e-9);
    },
    redrawMarks = () => { anchorGraphics(layers.gun, camera.x, camera.y); renderer.drawArmament(shown.state); };
  // Native marks are local to the resting tube; its one visual displacement
  // applies to both the tube and its marks, even 173 km from the world origin.
  assert(Math.abs(barrel.x - SITE) < 200);
  checkMarks(struck, previous?.value || 0);
  try {
    for (const recoil of [0, .02]) {
      if (recoil) {
        const motion = startWeaponRecoil(null, recoil, gun.weaponPreset);
        advanceWeaponRecoil(motion, motion.attack);
        assert.equal(motion.value, recoil);
        renderer.weaponRecoil.set(gun.id, motion);
      } else renderer.weaponRecoil.delete(gun.id);
      redrawMarks();
      assert.deepEqual([layers.gun.x, layers.gun.y], [camera.x, camera.y]);
      assert(largest(layers.gun) < 16, 'the marks still hand the GPU only numbers near their camera anchor');
      checkMarks(places(layers.gun, renderer.world), recoil);
    }
  } finally {
    if (previous) renderer.weaponRecoil.set(gun.id, previous); else renderer.weaponRecoil.delete(gun.id);
    redrawMarks();
  }
  // A shadow stands where its part was when it was laid out, and lies on the ground under it; where a wheel bears on
  // the ground, a few pixels deep and a pixel over the line.
  assert(layers.shade.children.length >= 3);
  const contact = new Set(wheels.map(wheel => renderer.drawables.get(wheel.id).shade));
  for (const shade of layers.shade.children) {
    assert(Math.hypot(shade.x - world.vehicle.x, shade.y - world.vehicle.y) < 5);
    // Stroke widths are quantized to retain their caches: allow a pixel about the configured contact footprint.
    const [low, high] = contact.has(shade) ? [-Math.max(MAIN_LIGHT.contactDepth, (MAIN_LIGHT.contactPixels + 1) / ZOOM) - .01, .01 + 1.5 / ZOOM] : [-.1, .01];
    for (const p of places(shade, renderer.world)) assert(onFoot(p) > low && onFoot(p) < high && Math.abs(p.x - world.vehicle.x) < 5,
      `${contact.has(shade) ? 'contact' : 'cast'} shadow: height ${onFoot(p)}, expected (${low}, ${high}), x offset ${p.x - world.vehicle.x}`);
  }
  for (const wheel of world.modules.filter(m => m.kind === 'wheel')) { const item = renderer.drawables.get(wheel.id); assert.deepEqual([item.shade.x, item.shade.y], [item.shade.cast.x, item.shade.cast.y]); }
});

test('the chassis is drawn on its frame, over the structure and under the skin of the hull, its shadow on the ground', () => {
  const frame = renderer.scene.frame.actorParts.get('local').find(part => part.data.definition?.chassis?.profile), chassis = frame.data.definition.chassis,
    place = chassisPlacement(renderer.scene.pose(frame.id), chassis, renderer.scene.actor('local').angle), art = layers.chassisArt, [sprite] = art.children,
    order = kind => layers[kind].parent.getChildIndex(layers[kind]);
  assert.equal(art.parent, layers.chassis); assert(art.visible && order('chassis') < order('hullSkins'));
  // From its front end at the top of its deck, along it to its rear: the picture as long as the frame, and a little more.
  assert(Math.hypot(art.x - place.origin.x, art.y - place.origin.y) < 1e-9 && Math.abs(art.rotation - Math.atan2(place.along.y, place.along.x)) < 1e-9);
  assert(sprite.x <= 0 && sprite.x + sprite.width >= chassis.length && sprite.y === 0 && sprite.scale.y < 0);
  assert(layers.chassisKeys.some(key => key.startsWith(`chassis:${chassis.model}:5.2:`)), 'its picture is kept while it is drawn');
  const shade = layers.chassisShadow.under, rear = chassisPoint(place, chassis.length, 0);
  assert.equal(shade.parent, layers.shade);
  for (const p of places(shade, renderer.world)) assert(onFoot(p) > -.1 && onFoot(p) < .01 && Math.abs(p.x - (place.origin.x + rear.x) / 2) < 3.5);
});

test('the particles of every layer are counted from the camera, and each is shown where its effect has it', () => {
  const groups = [effects, ...effects.actorLayers.values()], own = effects.actorLayers.get('local');
  assert.deepEqual(effects.origin, { x: camera.x, y: camera.y });
  for (const group of groups) for (const layer of [group.smoke, group.fire, group.sparks]) assert.deepEqual([layer.x, layer.y], [camera.x, camera.y]);
  assert(own.smoke.particleChildren.length > 0, 'the smoke of the gun belongs to the construction');
  assert(effects.smoke.particleChildren.length + effects.fire.particleChildren.length + effects.sparks.particleChildren.length > 50, 'that of the bursts to the field');
  let dust = 0;
  for (const p of effects.particles) {
    assert(Math.abs(p.x - camera.x) < seen, 'the effect is beside the camera, 173 km out');
    // The frame is drawn at the end of its step, so a particle is shown where the step left it.
    assert(Math.abs(p.layer.x + p.sprite.x - p.x) < 1e-9, `${p.kind} along`);
    if (!p.groundDust) { assert(Math.abs(p.layer.y + p.sprite.y - p.y) < 1e-9, `${p.kind} up`); continue; }
    dust++; assert(Math.abs(p.layer.y + p.sprite.y - ground.height(p.x) - p.dustLift) < 1e-9, 'the dust of a burst lies on the ground');
  }
  assert(dust > 0);
  // Between two steps it is shown between where the two left it.
  effects.sample(.25);
  for (const p of effects.particles) assert(Math.abs(p.layer.x + p.sprite.x - (p.previousX + (p.x - p.previousX) * .25)) < 1e-9);
  effects.sample(1);
});

test('the heat over the bursts and the outline that clips the effects are counted from beside the view', () => {
  const haze = renderer.heatHaze, corners = places(haze.mesh, renderer.world), clip = renderer.effectSurfaceClip;
  assert.deepEqual([haze.mesh.x, haze.mesh.y], [haze.bounds.left, haze.bounds.bottom]); assert.deepEqual([haze.area.x, haze.area.y], [haze.bounds.left, haze.bounds.bottom]);
  assert(Math.abs(haze.bounds.left - camera.x) < seen);
  for (const [i, source] of haze.sources.entries()) {
    const quad = corners.slice(i * 4, i * 4 + 4), middle = { x: (quad[0].x + quad[2].x) / 2, y: (quad[0].y + quad[2].y) / 2 };
    // A corner is kept in single precision, a few metres from where it is counted from.
    assert(Math.hypot(middle.x - source.x, middle.y - source.y) < 1e-5, 'a field of heat is centred on its source');
    assert(Math.abs(Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) - 2 * source.rx) < 1e-5);
  }
  for (const corner of corners.slice(haze.count * 4)) assert(Math.hypot(corner.x - haze.sources[0].x, corner.y - haze.sources[0].y) < 1e-5, 'a field not in use is folded on the first');
  assert.equal(clip.hosts.size, 3, 'the effects of the field, those of the construction and the heat');
  for (const [host, { mask }] of clip.hosts) {
    assert.deepEqual([host.x, host.y], [0, 0], 'what is clipped stays where it is');
    assert.deepEqual([mask.x, mask.y], [clip.bounds.left, 0]); assert(clip.bounds.left < camera.x - seen / 2 && clip.bounds.right > camera.x + seen / 2);
    const outline = places(mask, renderer.world);
    assert.deepEqual(span(outline, p => p.x), { low: clip.bounds.left, high: clip.bounds.right });
    for (const p of outline) assert(p.y === clip.bounds.top || Math.abs(over(p)) < 1e-9, 'the outline is the ground');
    for (const p of ground.points.filter(p => p.x > clip.bounds.left && p.x < clip.bounds.right)) assert(distance(outline, p.x, p.y) < 1e-9);
  }
});

test('tyre marks keep small world vertices and reuse their drawings when the camera leaves and returns', () => {
  // On their own first: a wheel rolls 30 m along the far ground while the camera stays over it.
  const g = new Container(), trails = new GroundTrails(g, { surfaceTrail() {} }), wheel = { id: 'wheel', kind: 'wheel', attached: true, groundContact: { x: SITE } },
    state = { actors: [], modules: [wheel] }, eye = { x: SITE + 3, y: ground.height(SITE) + 2, zoom: 10, width: WIDTH, height: HEIGHT };
  for (let i = 0; i <= 150; i++) { wheel.groundContact.x = SITE + i * .2; trails.update(state, ground, i / 30, eye); }
  assert(trails.marks.length > 100 && g.children.length > 1);
  const laid = () => { const drawn = places(g); for (const mark of trails.marks) assert(distance(drawn, mark.a, mark.y1) < .02 && distance(drawn, mark.b, mark.y2) < .02); return largest(g); };
  assert(laid() < 40);
  const drawings = g.children.slice(), kept = drawings.map(child => child.context.instructions[0]);
  for (const [dx, dy] of [[500, -300], [513, 0], [513, 600], [-50000, 0]]) {
    trails.update(state, ground, 5, { ...eye, x: eye.x + dx, y: eye.y + dy });
    assert(drawings.every(child => !child.visible));
    assert.deepEqual(drawings.map(child => child.context.instructions[0]), kept);
    assert(laid() < 40, 'an offscreen lot keeps its own small vertices');
  }
  wheel.groundContact.x += .2; trails.update(state, ground, 5.1, { ...eye, x: eye.x - 49990 });
  assert(drawings.every(child => !child.visible));
  trails.update(state, ground, 5.1, eye);
  assert(drawings.every(child => child.visible)); assert(laid() < 40);
  g.destroy({ children: true, context: true });
});

// The workshop of the shared field. The player is on the tab of the design and the page has stood the board
// in the base: the renderer goes on drawing the field it is told, frame after frame, and the design is drawn
// by the board, in the frame it is made in, with its layers at the site.
test('in the workshop of the field the design stands on the ground of the base, 173 km out, in the numbers of its own frame', t => {
  const editor = new Editor(createConstruction('heavy')), design = editor.blueprint, home = { x: camera.x, y: camera.y, zoom: camera.zoom },
    // The design is shown with its front to the right, as every design is in the workshop: the board turned about its middle.
    site = boardSite(base, design, { ground, state: shown.state }), at = p => ({ x: fieldX(site, p.x), y: site.y + p.y });
  // Whatever this test comes to, the tests after it find the field on its own tab.
  t.after(() => { Object.assign(view, { mode: 'test', editor: undefined }); renderer.marquee = null; renderer.stand(null); Object.assign(camera, home); });
  assert.equal(site.x, base.x - BOARD.middle, 'the middle of the base is free, and the design would come into the field there');
  assert.equal(site.y, Math.max(...Array.from({ length: 57 }, (_, i) => ground.height(site.x + BOARD.minX + i * .25))), 'on the highest ground under the board');
  assert(Math.abs(site.x) > 170000 && Math.abs(site.x - world.vehicle.x) > 30); assert.equal(site.mirror, true);
  Object.assign(view, { mode: 'edit', buildTool: 'select', editor }); renderer.design(design); renderer.stand(site);
  const board = renderer.board, lens = board.camera;
  assert.equal(board, renderer.fieldBoard); assert.notEqual(board, renderer);
  assert.deepEqual([renderer.mode, board.mode, renderer.watching, board.watching], ['test', 'edit', true, false]);
  lens.fit(design, true);
  const zoom = camera.zoom, clock = shown.time;
  assert(Math.abs(camera.x - (site.x + BOARD.middle)) < 3 && Math.abs(lens.x - BOARD.middle) < 3 && zoom > 60, 'the camera of the field is over the board');
  frame(false); frame(false);

  // The field goes on about the board: its frames are told and drawn as on its own tab, and nothing of it was made again.
  assert(shown.time > clock && shown.state.actors.some(actor => actor.id === 'local'));
  assert.equal(renderer.ground, ground); assert.equal(renderer.actorLayers.get('local'), layers);
  assert(renderer.baseWorks.visible && scene.chunks.some(chunk => chunk.earth?.visible), 'the base and its ground are on the screen');
  // It is only looked at: no part of it is selected and no aim is marked over it.
  assert.equal(ownNumbers(renderer.overlay).length, 0); assert.equal(renderer.aimPreview, null);
  for (const label of [renderer.impactLabel, renderer.servoLabel, renderer.leadLabel]) assert(!label.visible);

  // The layers of the board stand at the site, among the constructions of the field and over its marks.
  for (const layer of [board.body, board.marks]) {
    assert.deepEqual([layer.x, layer.y, layer.scale.x], [site.x + 2 * BOARD.middle, site.y, -1], 'turned about the middle of the board');
    assert.equal(layer.parent, renderer.world); assert(layer.visible);
  }
  assert.equal(renderer.world.getChildIndex(board.body), renderer.world.getChildIndex(renderer.benchArt) + 1);
  assert(renderer.world.getChildIndex(board.body) < renderer.world.getChildIndex(renderer.trails), 'under the rounds and the smoke of the field');
  assert(renderer.world.getChildIndex(board.marks) > renderer.world.getChildIndex(renderer.overlay));
  // The field behind the design is under a shade, the first thing of the board and as large as the screen, and the
  // names and marks of what stands there are faded: nothing of the field is taken for a part of the design.
  const shade = board.body.children[0], held = renderer.camera;
  assert.equal(shade, board.shade); assert(shade.alpha > .4 && shade.alpha < .7 && shade.tint < 0x202020);
  assert(fieldX(site, shade.x + shade.width) <= held.x - held.width / held.zoom / 2 && fieldX(site, shade.x) >= held.x + held.width / held.zoom / 2);
  assert(site.y + shade.y <= held.y - held.height / held.zoom / 2 && site.y + shade.y + shade.height >= held.y + held.height / held.zoom / 2);
  assert.deepEqual([renderer.labels.alpha, renderer.overlay.alpha], [.25, .25]);

  // Every part of the design is drawn where the board has it: the site, and its place in the design.
  const own = board.actorLayers.get('local'), state = renderer.designState, fitted = state.modules.filter(module => module.kind !== 'weapon'),
    authored = state.plates.filter(plate => !plate.definition.chassis && floorSegment(plate.definition) === null), generated = state.plates.filter(plate => plate.definition.chassis),
    floors = state.plates.filter(plate => floorSegment(plate.definition) !== null);
  assert.notEqual(own, layers); assert.equal(own.container.parent, board.actorLayerRoot);
  assert.deepEqual([...board.drawables.keys()].sort(), [...authored, ...fitted].map(part => part.id).sort());
  assert(state.plates.length > 4 && fitted.length > 4 && generated.length >= 2);
  assert(floors.length && floors.every(plate => !board.drawables.has(plate.id)), 'the floor over the frame is painted with its picture');
  for (const plate of generated) {
    assert.equal(board.scene.frame.byId.get(plate.id).data, plate, 'the chassis plates remain in the physical frame');
    assert(!board.drawables.has(plate.id), 'their dedicated chassis picture has no redundant material mesh');
  }
  const framePlate = generated.find(plate => plate.definition.chassis.profile),
    framePlace = chassisPlacement({ ...framePlate.definition, definition: framePlate.definition }, framePlate.definition.chassis), chassisShape = own.chassisShape,
    chassisArt = own.chassisArt, [chassisSprite] = chassisArt.children, chassisTexture = chassisSprite.texture;
  assert(chassisArt.visible && chassisArt.parent === own.chassis);
  assert(Math.hypot(chassisArt.x - framePlace.origin.x, chassisArt.y - framePlace.origin.y) < 1e-9,
    'the dedicated picture stays in design coordinates, translated only by the board at the distant site');
  assert(chassisSprite.x <= 0 && chassisSprite.x + chassisSprite.width >= framePlate.definition.chassis.length);
  for (const plate of authored) {
    const drawn = places(board.drawables.get(plate.id).mesh, renderer.world), corners = plateCorners(plate.definition).map(at);
    for (const axis of ['x', 'y']) {
      const told = span(corners, p => p[axis]), there = span(drawn, p => p[axis]);
      // A plate is drawn with the joints it makes with its neighbours, a little past its own corners.
      assert(there.low > told.low - 1 && there.high < told.high + 1 && there.high - there.low > (told.high - told.low) * .5, `the plate ${plate.id} along ${axis}`);
    }
  }
  for (const module of fitted) {
    const drawn = places(board.drawables.get(module.id).mesh, renderer.world);
    for (const corner of componentPolygon(module).map(at)) assert(distance(drawn, corner.x, corner.y) < 1e-4, `a corner of the ${module.kind} ${module.id}`);
  }
  // It stands on the floor of the board, inside what the field takes of a construction, and nothing of it is in the ground.
  const parts = [...board.drawables.values()].flatMap(item => places(item.mesh, renderer.world)), stood = span(parts, p => p.y - site.y), along = span(parts, p => p.x - site.x);
  assert(stood.low > -.05 && stood.low < .3, 'its running gear is on the floor: ' + stood.low); assert(stood.high > 2 && stood.high < BOARD.maxY);
  assert(along.low >= BOARD.minX && along.high <= BOARD.maxX && along.high - along.low > 6);
  for (const p of parts) assert(over(p) > -.05);
  // The floor is level, its top where the design stands, from one end of the board to the other, and its body goes down to the ground.
  const floor = places(board.floor, renderer.world), deck = span(floor, p => p.y - site.y), ends = span(floor, p => p.x - site.x);
  assert(Math.abs(deck.high) < 1e-9 && deck.low <= -.14); assert(Math.abs(ends.low - (BOARD.minX - .6)) < .02 && Math.abs(ends.high - (BOARD.maxX + .6)) < .02);
  for (let u = 6; u <= 18; u += 2) assert(distance(floor, site.x + u, Math.min(site.y, ground.height(site.x + u)) - .14) < .011, 'the seam at ' + u + ' ends a little under the ground');
  assert.deepEqual([board.floor.x, board.floor.y], [BOARD.middle, 0], 'counted from the middle of the board');

  // The handles of the editor are where the authored nodes are.
  const handles = places(board.overlay, renderer.world);
  assert(design.frame.nodes.length >= 4);
  for (const node of design.frame.nodes.map(at)) assert(distance(handles, node.x, node.y) < 7 / zoom, 'a handle on its node');
  const marked = span(handles, p => p.x - site.x); assert(marked.low > BOARD.minX - 1 && marked.high < BOARD.maxX + 1, 'and no mark is away from the board');
  for (const drawn of [board.overlay, board.shadows, own.suspensionArms, own.gun]) assert.deepEqual([drawn.x, drawn.y], [lens.x, lens.y], 'counted from the camera as the board has it');

  // The pointer is the same place to the editor: the pixel a handle is drawn at is its node, and comes back to that pixel.
  for (const node of design.frame.nodes) {
    const pixel = camera.toScreen(fieldX(site, node.x), site.y + node.y), point = lens.toWorld(pixel.x, pixel.y), back = lens.toScreen(point.x, point.y);
    assert(Math.abs(point.x - node.x) < 1e-8 && Math.abs(point.y - node.y) < 1e-8); assert(Math.abs(back.x - pixel.x) < 1e-6 && Math.abs(back.y - pixel.y) < 1e-6);
    const picked = editor.pickNode(point, 9 / zoom);
    assert(Math.hypot(picked.x - node.x, picked.y - node.y) < 1e-8, 'coincident chassis and hull handles pick the same position');
  }
  const engine = design.modules.find(module => module.kind === 'engine'), pixel = camera.toScreen(fieldX(site, engine.x), site.y + engine.y),
    picked = editor.pick(lens.toWorld(pixel.x, pixel.y), 5 / zoom);
  assert(picked); assert.equal(picked, editor.pick(engine, 5 / zoom));
  // What the gestures leave on the renderer is drawn by the board: the outline of the selection and the area being dragged.
  editor.select(engine.id); renderer.marquee = { start: { x: 8, y: 1 }, end: { x: 10, y: 2.5 } }; frame(false);
  assert.equal(own.chassisShape, chassisShape, 'selection preserves the chassis layout');
  assert.equal(chassisArt.children[0].texture, chassisTexture, 'selection does not repaint the chassis');
  const outlined = places(board.overlay, renderer.world);
  for (const corner of componentPolygon(engine).map(at)) assert(distance(outlined, corner.x, corner.y) < 3 / zoom, 'the selected engine is outlined');
  for (const corner of [[8, 1], [10, 1], [10, 2.5], [8, 2.5]]) assert(distance(outlined, fieldX(site, corner[0]), site.y + corner[1]) < 2 / zoom, 'a corner of the area');
  assert.equal(ownNumbers(renderer.overlay).length, 0, 'and still nothing of the field is');
  renderer.marquee = null;

  // Nothing under the world hands Pixi a number of the size of the world: the board is 173 km out and holds the numbers of its frame.
  const { allowed, allow } = allowances(Math.abs(camera.x - world.vehicle.x) + seen), drop = site.y - Math.min(...Array.from({ length: 32 }, (_, i) => ground.height(site.x + BOARD.minX - .6 + i * .5)));
  allow(board.floor, Math.max(BOARD.maxX + .6 - BOARD.middle, drop + .2), 'the floor is counted from the middle of the board, and goes down to the ground under it');
  for (const drawn of [board.overlay, board.shadows, own.suspensionArms, own.gun])
    allow(drawn, BOARD.maxX - BOARD.minX + WIDTH / zoom, 'what the board draws anew is counted from the camera over it, in the frame of the board');
  const found = withinAllowances(allowed), inside = node => { for (let up = node; up; up = up.parent) if (up === board.body || up === board.marks) return true; return false; };
  assert(found.filter(one => inside(one.node) && one.count).length > 30, 'the design is all there');
  assert(largest(board.body) < 16 && largest(board.marks) < 16, 'the largest number of the design is the length of the board');
  assert(largest(renderer.world) < 4200);

  // Back on the tab of the field the board is put away, and the field is as it was: nothing of it was made again.
  view.mode = 'test'; view.editor = undefined; renderer.stand(null); Object.assign(camera, home);
  assert.equal(renderer.board, renderer); assert.equal(renderer.board.camera, camera); assert.equal(renderer.mode, 'test');
  assert.equal(board.drawables.size + board.actorLayers.size + board.hullSprites.size, 0); assert.equal(board.actorLayerRoot.children.length, 0);
  frame(false);
  assert(!board.body.visible && !board.marks.visible); assert.deepEqual([renderer.labels.alpha, renderer.overlay.alpha], [1, 1]);
  assert.equal(renderer.actorLayers.get('local'), layers); assert(layers.container.visible && renderer.aimPreview.path.length > 2, 'the aim is marked again');
  assert(ownNumbers(renderer.overlay).length > 400);
});

test('in the frames of the renderer the marks are hidden 50 km away and reused on return', () => {
  const g = renderer.groundMarks, made = renderer.groundTrails.marks, count = made.length, last = made.at(-1), home = { x: camera.x, y: camera.y };
  const kept = g.children.map(child => child.context.instructions[0]);
  camera.x += 50000; frame(false);
  assert(Math.abs(camera.x - (home.x + 50000)) < 1e-6); assert(g.children.every(child => !child.visible));
  assert.equal(made.length, count); assert.equal(made.at(-1), last, 'no mark was added by moving the camera');
  const far = places(g, renderer.world);
  for (const mark of made) assert(distance(far, mark.a, mark.y1) < .02);
  assert(largest(g) < 512.1); assert.deepEqual(g.children.map(child => child.context.instructions[0]), kept);
  // The terrain and clipping outline follow the camera; the old marks keep their local anchors.
  const there = scene.chunks.filter(chunk => chunk.earth?.visible), clip = renderer.effectSurfaceClip,
    high = Math.max(...there.flatMap(chunk => ground.points.filter(p => p.x >= chunk.left && p.x <= chunk.right).map(p => p.y)));
  assert(there.length >= 1 && there.every(chunk => !painted.includes(chunk) && Math.abs(chunk.left - camera.x) < 600));
  for (const chunk of there) for (const part of [chunk.earth, chunk.fine, chunk.props]) { assert.equal(part.x, chunk.left); assert(largest(part) < Math.max(514, high + 10)); }
  // The outline starts within two of its tiles of the left edge of the view.
  for (const { mask } of clip.hosts.values()) {
    assert.equal(mask.x, clip.bounds.left); assert(camera.x - mask.x > seen / 2 && camera.x - mask.x < seen / 2 + 129);
    assert(largest(mask) <= Math.max(clip.bounds.right - clip.bounds.left, clip.bounds.top));
  }
  camera.x = home.x; frame(false);
  assert(g.children.some(child => child.visible)); assert(largest(g) < seen);
  assert.deepEqual(g.children.map(child => child.context.instructions[0]), kept);
  world.dispose();
});

test('changing between fixed and vehicle workshops releases retired artwork and keeps the board anchored, turned to the right', () => {
  renderer.clearScene(); renderer.setTerrain('flat'); Object.assign(view, { mode: 'edit', buildTool: 'select' }); Object.assign(camera, { x: 14, y: 3, zoom: 60 });
  const design = (id, fitted = made => made) => {
    const blueprint = fitted(compileBlueprint(validateBlueprint(createConstruction(id))));
    view.editor = { blueprint, revision: id, selection: null, selectionIds: [] };
    renderer.design(blueprint);
    // The first frame of a design must show it right, and the one after it too.
    for (const frame of ['first', 'second']) {
      renderer.draw({ now });
      const drawing = renderer.board, g = drawing.actorLayers.get('local').gun;
      if (frame === 'second') return { g, lens: drawing.camera, preset: renderer.designState.actors[0].preset };
    }
  };
  // Every design is drawn by the board, turned about its middle with its front to the right: a fixed one standing on the ground.
  const standsAtCamera = ({ g, lens }) => {
    assert.deepEqual([g.x, g.y, g.pivot.x, g.pivot.y, g.scale.x, g.rotation], [lens.x, lens.y, 0, 0, 1, 0]);
    assert.equal(lens.turn, -1); assert.equal(renderer.board.body.scale.x, -1); assert.equal(renderer.board.body.x, 2 * BOARD.middle);
  };
  const bunker = design('bunker'); assert.equal(bunker.preset, 'bunker'); standsAtCamera(bunker);
  // Nothing stands beside the design: no gun stands where the bench of the test of armour stood, nor its shadow.
  const launcher = renderer.designState.launcher, cast = [...places(renderer.shadows, renderer.world), ...places(renderer.board.shadows, renderer.world)];
  assert.equal(renderer.gun, undefined); assert(camera.x - launcher.x > 10);
  assert(cast.every(p => Math.abs(p.x - launcher.x) > 5), 'no shadow where a bench stood');
  const oldParts = [...renderer.board.drawables], oldPaint = [...renderer.textures].filter(([, entry]) => !entry.persistent);
  const tracked = design('heavy'); assert.equal(tracked.preset, 'vehicle'); standsAtCamera(tracked);
  const kept = new Set(renderer.board.drawables.keys());
  assert(oldParts.filter(([id]) => !kept.has(id)).every(([, item]) => item.group.destroyed), 'the parts the new design has not are released');
  assert(oldPaint.filter(([key]) => !renderer.usedTextures.has(key)).every(([, entry]) => entry.texture.destroyed), 'unused transient textures are released after the frame');
  assert(largest(tracked.g) < 8, 'counted from the camera over it');
  const bare = design('recon', made => ({ ...made, modules: made.modules.filter(module => module.kind !== 'sensor') }));
  assert.equal(bare.preset, 'vehicle'); standsAtCamera(bare);
  standsAtCamera(design('bunker'));
  const hull = design('empty'); assert.equal(hull.preset, 'bunker');
  standsAtCamera(design('mortar')); standsAtCamera(design('outpost'));
  // A retained vehicle drawing clears a previous transform when it is shown on the bench again.
  const retained = design('recon').g;
  retained.pivot.set(12, 1.3); retained.position.set(SITE, 40); retained.scale.set(-1, 1); retained.rotation = .2;
  standsAtCamera(design('recon'));
  // All of it was drawn by the board, on the bench: the field has none standing in it, and the renderer draws no design of its own.
  assert.equal(renderer.board, renderer.fieldBoard); assert.equal(renderer.site, null);
  assert(renderer.fieldBoard.body.visible && renderer.actorLayers.size === 0);
});

test('fixed workshops settle the complete drawing with its pointer frame, standalone and mirrored far in the field', t => {
  renderer.clearScene(); renderer.setTerrain('flat');
  Object.assign(view, { mode: 'edit', buildTool: 'select', weapon: { platform: 'vehicle' } }); renderer.stand(null);
  t.after(() => { renderer.clearScene(); renderer.stand(null); Object.assign(view, { mode: 'test', editor: undefined }); });
  for (const model of ['bunker', 'guard-post']) {
    renderer.setTerrain('flat');
    const editor = new Editor(createConstruction(model)), original = JSON.stringify(editor.source), design = editor.blueprint;
    view.editor = editor; renderer.design(design);
    const board = renderer.board, lens = board.camera;
    assert.notEqual(board, renderer); assert.equal(renderer.site, null);
    assert.equal(renderer.designState.plates[0].definition, design.plates[0], 'presentation retains the authored geometry');
    lens.fit(design, true); renderer.draw({ now });
    assert(!renderer.actorLayerRoot.visible && board.body.visible && board.marks.visible, 'only the grounded copy of the design is shown');
    assert(!board.shade.visible && !board.floor.visible, 'the ordinary standalone scenery has no extra dimmer or raised deck');
    assert.deepEqual([renderer.labels.alpha, renderer.overlay.alpha], [1, 1]);
    // Its walls may run past its floor down to the next cell of the grid (a guard post's by 1 cm): the lowest of its plates
    // rests two centimetres above the flat ground, and its floor within half a cell of that.
    const floor = design.plates.find(plate => plate.id === 'hull:floor'), minimum = Math.min(...plateCorners(floor).map(p => p.y)),
      lowest = Math.min(...design.plates.flatMap(plate => plateCorners(plate).map(p => p.y)));
    assert(Math.abs(lowest + renderer.boardFrame.y - .02) < 1e-9 && minimum - lowest < CELL / 2, `${model}: its floor rests two centimetres above the flat ground`);
    for (const module of design.modules.filter(module => module.kind !== 'weapon')) {
      const item = board.drawables.get(module.id), drawn = places(item.mesh, renderer.world);
      for (const corner of componentPolygon(module)) assert(distance(drawn, fieldX(renderer.boardFrame, corner.x), corner.y + renderer.boardFrame.y) < 1e-4,
        `${model}: the equipment moves with its hull, turned with it to the right`);
    }
    for (const node of design.frame.nodes) {
      const pixel = lens.toScreen(node.x, node.y), here = lens.toWorld(pixel.x, pixel.y), shown = camera.toWorld(pixel.x, pixel.y);
      assert.equal(editor.pickNode(here, 1e-6)?.id, node.id, 'a visible grip picks its authored node');
      assert(Math.abs(shown.y - node.y - renderer.boardFrame.y) < 1e-9);
      assert(around(places(board.overlay, renderer.world), shown.x, shown.y, 5 / lens.zoom, 1e-5), 'the grip itself is drawn at that pixel');
    }
    const selected = design.modules.find(module => module.kind === 'command'), pixel = lens.toScreen(selected.x, selected.y);
    assert.equal(editor.pick(lens.toWorld(pixel.x, pixel.y)), selected.id, 'a visible component picks the corresponding authored piece');
    const held = lens.toWorld(pixel.x, pixel.y); lens.zoomAt(1.2, pixel.x, pixel.y);
    const kept = lens.toWorld(pixel.x, pixel.y); assert(Math.hypot(kept.x - held.x, kept.y - held.y) < 1e-9);
    assert.equal(JSON.stringify(editor.source), original, 'framing and zooming do not rewrite the project');

    // Edit the selected floor away from the equipment. Raising a roof alone
    // can legitimately meet a camera that was explicitly left where it stood.
    // Down 15 cm, to the floor of the workshop: a cell further would be past it, and held there.
    const authoredFloor = editor.source.plates.find(plate => plate.id === 'hull:floor'),
      node = design.frame.nodes.find(node => node.id === authoredFloor.a), start = lens.toScreen(node.x, node.y);
    editor.select(authoredFloor.id);
    const grip = editor.pickNode(lens.toWorld(start.x, start.y)), end = lens.toScreen(node.x, node.y - .15),
      target = lens.toWorld(end.x, end.y), rested = editor.restNode(grip, target);
    editor.begin(); assert(editor.moveNode(grip, target)); assert(editor.commit());
    const changed = editor.source.plates.find(plate => plate.id === authoredFloor.id),
      moved = editor.blueprint.frame.nodes.find(node => node.id === changed.a);
    assert(Math.abs(moved.x - rested.x) < 1e-9 && Math.abs(moved.y - rested.y) < 1e-9);
    assert(editor.undo()); assert.equal(JSON.stringify(editor.source), original);

    renderer.setTerrain(world.terrain.id, world.terrain.reference()); renderer.design(editor.blueprint);
    // Whichever way its base faces, the board stands turned to the right.
    for (const facing of [-1, 1]) {
      const site = boardSite({ x: SITE + 60, y: renderer.ground.height(SITE + 60), radius: 0, facing }, editor.blueprint, { ground: renderer.ground });
      assert.equal(site.mirror, true);
      renderer.stand(site); lens.fit(editor.blueprint, true); renderer.drawBoard();
      assert(!board.floor.visible && board.shade.visible, 'a fixed building uses its ground rather than a raised workshop deck');
      for (const part of editor.blueprint.modules.filter(module => module.kind !== 'weapon')) {
        const drawn = places(board.drawables.get(part.id).mesh, renderer.world), target = componentPolygon(part).map(p => ({
          x: site.mirror ? site.x + 2 * BOARD.middle - p.x : site.x + p.x, y: site.y + p.y,
        }));
        for (const corner of target) assert(distance(drawn, corner.x, corner.y) < 1e-4, `${model}: reflection and distant placement apply to the complete piece`);
        const pixel = lens.toScreen(part.x, part.y), here = lens.toWorld(pixel.x, pixel.y);
        assert(Math.hypot(here.x - part.x, here.y - part.y) < 1e-9, 'the distant mirrored pointer returns to the authored frame');
      }
      for (const u of [5, 12, 19]) assert(Math.abs(board.ground.height(u) + site.y - renderer.ground.height(site.mirror ? site.x + 24 - u : site.x + u)) < 1e-9,
        'shadows and sight consult the same transformed ground');
      assert(largest(board.body) < 16 && largest(board.marks) < 20, 'world coordinates never become mesh or overlay vertices');
    }
    renderer.stand(null);
    assert.equal(JSON.stringify(editor.source), original);
  }
});
