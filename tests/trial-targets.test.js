import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics } from 'pixi.js';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { MAIN_WORLD, TRIAL_WORLD, TRIAL_TARGETS } from '../src/battle-rules.ts';
import { pageWorld, wreckTrial } from '../src/trial-targets.ts';
import { localToWorld, plateCorners } from '../src/math.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { Renderer } from '../src/render.ts';
import { Editor } from '../src/editor.ts';
import { blueprintMass, blueprintPowertrain } from '../src/mass-properties.ts';
import { controlContext, screenModel, resolveArmament, pieceKey } from '../src/ui-model.ts';
import { snapshotCollisionIndex } from '../src/impact-preview.ts';
import { Terrain } from '../src/terrain.ts';
import { strikeAlong, strikeDirection } from '../src/armour-strike.ts';

test('the terrain test stands still targets of another side ahead of the vehicle, from close to far, on the real world terrain', t => {
  const world = pageWorld(createStructuredTemplate('ifv'), { terrain: TRIAL_WORLD.terrain, targets: true });
  t.after(() => world.dispose());
  const targets = world.actors.filter(actor => actor.id !== 'local');
  assert.deepEqual(targets.map(actor => actor.construction.name), TRIAL_TARGETS.map(({ template }) => createStructuredTemplate(template).name));
  assert(targets.every(actor => actor.ownerId === 'alvo' && actor.team !== world.actor('local').team && actor.facing === 1));
  // In front of the vehicle, which faces −X, each farther than the one before.
  const xs = targets.map(actor => actor.vehicle?.x ?? actor.x);
  assert(xs.every((x, i) => x < 12 && (i === 0 || x < xs[i - 1])), String(xs));
  assert.deepEqual(world.terrain.reference(), { seed: TRIAL_WORLD.seed, length: TRIAL_WORLD.mapLength, center: TRIAL_WORLD.center });
  // The close sites rise naturally; no per-actor Y override makes a target float above the contour.
  const closeHeights = xs.slice(0, 6).map(x => world.terrain.height(x));
  assert(closeHeights.every((y, i) => i === 0 || y > closeHeights[i - 1]), String(closeHeights));
  assert(targets.filter(actor => actor.vehicle).every(actor => actor.vehicle.brake === 1));
  // Nobody drives them: they stay where they were put.
  for (let i = 0; i < 120; i++) world.step();
  for (const [i, actor] of targets.entries()) assert(Math.abs((actor.vehicle?.x ?? actor.x) - xs[i]) < 1.5, `${actor.id} ${actor.vehicle?.x} ${xs[i]}`);
});

test('an unarmed terrain trial draws no trajectory or aiming indicators from its armed targets', t => {
  const world = pageWorld(createStructuredTemplate('truck'), { terrain: TRIAL_WORLD.terrain, targets: true });
  t.after(() => world.dispose());
  world.step();
  const state = world.snapshot(), view = { mode: 'test', weapon: { platform: 'vehicle' }, aim: { x: -180, y: 2 } },
    renderer = new Renderer({}, view);
  renderer.playback.state = state; renderer.scene = sampleScene(state); renderer.ground = world.terrain;
  assert(!state.modules.some(m => m.actorId === 'local' && m.kind === 'weapon'));
  assert(state.modules.some(m => m.actorId !== 'local' && m.kind === 'weapon' && m.health > 0));
  assert.equal(renderer.weapon.componentId, null);
  assert.equal(renderer.launcherOf(state), null);
  assert.equal(renderer.aimingSolution(state), null);
  assert.equal(renderer.impactPrediction(state), null);
  assert.equal(renderer.weaponObstruction(state), null);
  assert.equal(renderer.allyInLine(state), null);
  assert.deepEqual(renderer.linkedArcs(state), []);
  renderer.overlay = new Graphics(); t.after(() => renderer.overlay.destroy());
  for (const name of ['impactLabel', 'servoLabel', 'leadLabel', 'strikeWords', 'strikeDetail']) renderer[name] = { visible: true };
  renderer.drawDeposits = () => {}; // Deposit artwork is independent of the firing overlay.
  renderer.aimPreview = { path: ['previous trajectory'] };
  renderer.drawOverlay(state);
  assert.equal(renderer.aimPreview, null);
  for (const label of [renderer.impactLabel, renderer.servoLabel, renderer.leadLabel, renderer.strikeWords, renderer.strikeDetail]) assert.equal(label.visible, false);
});

test('terrain and shared previews stay on the controlled vehicle even when a target gun comes first', t => {
  const world = pageWorld(createStructuredTemplate('ifv'), { terrain: TRIAL_WORLD.terrain, targets: true });
  t.after(() => world.dispose()); world.step();
  const snapshot = world.snapshot(), own = snapshot.modules.find(m => m.actorId === 'local' && m.kind === 'weapon'),
    enemy = snapshot.modules.find(m => m.actorId !== 'local' && m.kind === 'weapon');
  for (const shared of [false, true]) {
    const state = { ...snapshot, shared, ...(shared && { controlledActor: 'local' }),
      modules: [enemy, ...snapshot.modules.filter(m => m.id !== enemy.id)] },
      view = { mode: 'test', weapon: { platform: 'vehicle', componentId: enemy.id }, aim: { x: -180, y: 2 } },
      renderer = new Renderer({}, view);
    renderer.playback.state = state;
    assert.equal(renderer.weapon.componentId, own.id, 'a stale selection resolves within the controlled vehicle');
    assert.equal(renderer.launcherOf(state), own);
    const solution = renderer.aimingSolution(state);
    assert(solution && Math.hypot(solution.x - own.x, solution.y - own.y) < 10);
    assert(Math.hypot(solution.x - enemy.x, solution.y - enemy.y) > 100);
    // The previous frame's solution must not survive losing the controlled gun.
    const unarmed = { ...state, modules: state.modules.filter(m => m.id !== own.id) };
    renderer.playback.state = unarmed;
    assert.equal(renderer.launcherOf(unarmed), null);
    assert.equal(renderer.aimingSolution(unarmed), null);
    assert.equal(renderer.impactPrediction(unarmed), null);
    for (const patch of [{ health: 0 }, { attached: false }, { barrelDisabled: true }]) {
      const disabled = { ...state, modules: state.modules.map(m => m.id === own.id ? { ...m, ...patch } : m) };
      renderer.playback.state = disabled;
      assert.equal(renderer.launcherOf(disabled), null);
      assert.equal(renderer.aimingSolution(disabled), null);
    }
  }
  const remote = { ...snapshot, shared: true, controlledActor: enemy.actorId },
    renderer = new Renderer({}, { mode: 'test', weapon: { platform: 'vehicle' }, aim: { x: -180, y: 2 } });
  renderer.playback.state = remote;
  assert.equal(renderer.weapon.componentId, enemy.id, 'shared control can belong to an actor other than local');
  assert.equal(renderer.launcherOf(remote), enemy);
  const solution = renderer.aimingSolution(remote);
  assert(solution && Math.hypot(solution.x - enemy.x, solution.y - enemy.y) < 10);
});

test('the gun of the test of armour is in no hand: no arc is worked out for it, nor is a gun of the design picked', t => {
  const world = pageWorld(createStructuredTemplate('truck')); t.after(() => world.dispose());
  const state = world.snapshot(), renderer = new Renderer({},
    { mode: 'test', weapon: { platform: 'ground', preset: 'fnmag' }, aim: { x: 12, y: 1 } });
  renderer.playback.state = state;
  assert.equal(renderer.launcherOf(state), null, 'it does not select a mounted gun');
  assert.equal(renderer.aimingSolution(state), null, 'it strikes along lines drawn (armour-strike.ts), not at an aim');
});

test('the page\'s own world is an open field: a design driven into a target goes through it, neither is shoved, and its rounds still strike it', t => {
  // A flat collision fixture isolates pass-through from unrelated terrain traversal and long artillery sites.
  const world = pageWorld(createStructuredTemplate('heavy'));
  world.addActor(createStructuredTemplate('recon'), { id: 'alvo-0', ownerId: 'alvo', x: -138, facing: 1 });
  world.addActor(createStructuredTemplate('ifv'), { id: 'alvo-1', ownerId: 'alvo', x: -288, facing: 1 });
  world.game();
  t.after(() => world.dispose());
  const design = world.actor('local').vehicle, target = world.actor('alvo-0').vehicle;
  for (let i = 0; i < 30; i++) world.step();
  const stood = { x: target.x, y: target.y, angle: target.angle };
  // Flat out at the nearest target, 150 m ahead, and on past it.
  world.controlVehicle(-1, 0, 'local');
  let steps = 0;
  while (design.x > stood.x - 15 && steps++ < 60 * 40) world.step();
  assert(design.x < stood.x - 15, `the design is held at ${design.x}, short of the target at ${stood.x}`);
  assert(Math.abs(target.x - stood.x) < .05 && Math.abs(target.y - stood.y) < .05 && Math.abs(target.angle - stood.angle) < .01,
    `the target stood at ${JSON.stringify(stood)} and is at ${target.x} ${target.y} ${target.angle}`);
  assert.equal(world.dynamics.recoveries, 0);
  // Back inside the target, the gun fires into it and its rounds strike it.
  world.controlVehicle(0, 1, 'local');
  world.command('setVehicleState', { actorId: 'local', state: { x: stood.x + 2, y: design.y, angle: design.angle, vx: 0, vy: 0, omega: 0 } });
  for (let i = 0; i < 30; i++) world.step();
  const gun = world.modules.find(m => m.actorId === 'local' && m.kind === 'weapon'),
    config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id }),
    struck = () => world.plates.filter(p => p.actorId === 'alvo-1').reduce((sum, p) => sum + (p.marks?.length || 0), 0),
    aim = { x: world.actor('alvo-1').vehicle.x, y: world.actor('alvo-1').vehicle.y + .4 };
  world.setTrigger(true, aim, config);
  for (let i = 0; i < 60 * 4 && !struck(); i++) world.step();
  world.setTrigger(false);
  assert(world.stats.shots > 0 && struck() > 0, `shots ${world.stats.shots}, marks on the next target ${struck()}`);
});

test('a construction that stands fixed on high ground is drawn where its walls stand, and in sight when the camera holds it', t => {
  const world = new World({ ...createStructuredTemplate('ifv'), terrain: MAIN_WORLD.terrain },
    { scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 }, enclosed: true });
  t.after(() => world.dispose());
  const x = -1188, ground = world.terrain.height(x);
  world.addActor(createStructuredTemplate('bunker'), { id: 'bunker', ownerId: 'alvo', x, facing: 1 });
  world.step();
  assert(ground > 100, 'the ground of the field stands high here');
  const state = world.snapshot(), walls = world.plates.filter(p => p.actorId === 'bunker').flatMap(p => plateCorners(p.definition)),
    span = points => ({ bottom: Math.min(...points.map(p => p.y)), top: Math.max(...points.map(p => p.y)) }),
    stands = span(walls), faces = span(bodyPanelSurfaces(state).filter(f => f.actorId === 'bunker')
      .flatMap(f => f.artPose ? f.artPolygon.map(p => localToWorld(f.artPose, p.x, p.y)) : f.artPolygon));
  assert(stands.bottom > ground - .1 && stands.bottom < ground + 1, 'its walls stand on the ground');
  assert(faces.bottom >= stands.bottom - .01 && faces.top <= stands.top + .01 && faces.top - faces.bottom > 1,
    `its faces ${JSON.stringify(faces)} are within its walls ${JSON.stringify(stands)}`);
  const r = new Renderer({}); r.actorLayerRoot = new Container(); r.moduleLayer = new Container(); r.plateLayer = new Container(); r.fxLayer = new Container();
  t.after(() => { r.actorLayerRoot.destroy({ children: true }); r.fxLayer.destroy({ children: true }); });
  r.view.mode = 'test'; r.syncActorLayers(state); r.scene = sampleScene(state);
  r.camera.width = 1280; r.camera.height = 800; Object.assign(r.camera, { x, y: ground + 2, zoom: 40 });
  r.cullActors(state);
  assert(r.actorLayers.get('bunker').container.visible, 'the camera that holds it shows it');
});

test('a target put out of action on the proving ground is the wreck it would be on the field, and stands until the test is restored', t => {
  const world = pageWorld(createStructuredTemplate('ifv'), { terrain: TRIAL_WORLD.terrain, targets: true }), game = world.game();
  t.after(() => world.dispose());
  world.step(); wreckTrial(world);
  assert(world.actors.every(actor => !actor.defeated && !actor.field), 'whole, nothing is a wreck');
  // Its command post destroyed, as on the field (wreck.ts): nobody's, the core told so, and every screen told of it.
  for (const post of world.modules.filter(m => m.actorId === 'alvo-0' && m.kind === 'command')) game.call({ op: 'setPartState', owner: game.handle(post), state: { health: 0 } });
  world.step(); wreckTrial(world);
  const wrecked = world.time, target = world.actor('alvo-0');
  assert.deepEqual([target.defeated, target.ownerId, target.field], [true, null, { wreck: { until: Infinity } }]);
  assert(world.actors.filter(actor => actor !== target).every(actor => !actor.defeated && !actor.field), 'the design and the other targets stand');
  for (let i = 0; i < 30; i++) { world.step(); wreckTrial(world); }
  assert.equal(target.field.wreck.until, Infinity, 'a wreck is made once');
  // The frame tells it as the field does: the screen darkens it and the core alone decides whether it burns.
  const state = world.snapshot(), told = state.actors.find(actor => actor.id === 'alvo-0');
  assert.deepEqual([told.defeated, told.field], [true, target.field]);
  assert.equal(told.burning, state.modules.some(m => m.actorId === 'alvo-0' && m.burning));
  const r = new Renderer({}); r.actorLayerRoot = new Container(); r.fxLayer = new Container();
  t.after(() => { r.actorLayerRoot.destroy({ children: true }); r.fxLayer.destroy({ children: true }); });
  r.view.mode = 'test'; r.syncActorLayers(state);
  const layers = id => r.actorLayers.get(id);
  assert.deepEqual([layers('alvo-0').tint, layers('alvo-1').tint, layers('local').tint], [0x8d938c, 0xffffff, 0xffffff]);
  assert.deepEqual([layers('alvo-0').fade, layers('alvo-0').still], [1, true]);
});

test('the design under test that loses its command post is the wreck a target is, in either test: out of the player\'s hands, struck still, and whole when the test begins again', t => {
  const source = createStructuredTemplate('ifv'), editor = new Editor(source), b = editor.blueprint,
    construction = { mass: blueprintMass(b), drivetrain: blueprintPowertrain(b) }, ground = new Terrain('flat');
  for (const trial of ['terrain', 'armour']) {
    const options = trial === 'terrain' ? { terrain: TRIAL_WORLD.terrain, targets: true } : {}, world = pageWorld(source, options), game = world.game();
    t.after(() => world.dispose());
    const design = world.actor('local'), gun = world.modules.find(m => m.actorId === 'local' && m.kind === 'weapon'),
      config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id }), aim = { x: -60, y: world.terrain.height(-60) + 3 },
      run = steps => { for (let i = 0; i < steps; i++) { world.step(); wreckTrial(world); } };
    // Driven flat out, its trigger held, until its command post is destroyed.
    world.controlVehicle(-1, 0, 'local'); world.setTrigger(true, aim, config, 'local'); run(60);
    assert(!design.defeated && !design.field && world.stats.shots > 0, trial);
    for (const post of world.modules.filter(m => m.actorId === 'local' && m.kind === 'command')) game.call({ op: 'setPartState', owner: game.handle(post), state: { health: 0 } });
    run(1);
    const wrecked = world.time;
    assert.deepEqual([design.defeated, design.ownerId, design.field], [true, null, { wreck: { until: Infinity } }], trial);
    // Its controls are let go and it takes no more: it comes to a stand, and its gun is silent.
    const shots = world.stats.shots;
    world.controlVehicle(-1, 0, 'local'); world.setTrigger(true, aim, config, 'local'); run(180);
    const body = design.vehicle, stood = body.x; run(30);
    assert(Math.abs(body.x - stood) < .01 && Math.hypot(body.vx, body.vy) < .05 && world.stats.shots === shots, `${trial}: ${body.x - stood} ${body.vx} ${world.stats.shots - shots}`);
    assert.equal(design.field.wreck.until, Infinity, 'a wreck is made once');
    // Every screen is told it as a target's: darkened, standing, burning where its engine, fuel and ammunition are.
    const state = world.snapshot();
    // The live target gallery can also contain a target destroyed by the shots above.
    assert.equal(state.actors.find(a => a.id === 'local').burning, state.modules.some(m => m.actorId === 'local' && m.burning), trial);
    const r = new Renderer({}, { mode: 'test', linked: new Set([pieceKey(gun.id)]), weapon: { platform: 'vehicle', componentId: gun.id }, aim });
    r.actorLayerRoot = new Container(); r.fxLayer = new Container();
    t.after(() => { r.actorLayerRoot.destroy({ children: true }); r.fxLayer.destroy({ children: true }); });
    r.syncActorLayers(state);
    assert.deepEqual([r.actorLayers.get('local').tint, r.actorLayers.get('local').fade, r.actorLayers.get('local').still], [0x8d938c, 1, true]);
    // Nothing of it is in hand: no gun to aim, no arc of it nor of the guns switched on to fire with it.
    r.playback.state = state; r.scene = sampleScene(state); r.ground = world.terrain;
    assert.deepEqual([r.weapon.componentId, r.launcherOf(state), r.aimingSolution(state), r.linkedArcs(state)], [null, null, null, []]);
    // Nor on the page: no pedals, no Fogo, a pointer that fires nothing on the proving ground; the line of the gun says
    // what became of the design, and how to have it whole. The test of armour is struck along its lines as before.
    const weapon = trial === 'armour' ? { preset: 'rh120', platform: 'ground', ammo: 'apfsds' } : { platform: 'vehicle', componentId: gun.id },
      view = { mode: 'test', trial, buildTool: 'select', testTool: 'fire', weapon, placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' } },
      model = (patch = {}) => screenModel({ view: { ...view, ...patch }, editor, state, construction, terrainId: trial === 'terrain' ? TRIAL_WORLD.terrain : 'flat', touch: true,
        network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 10 }, sound: { enabled: false, volume: .4 } }),
      out = model(), inspected = model({ testTool: 'inspect' });
    assert.equal(controlContext(view, state, { enabled: false }).manual, false);
    assert.deepEqual([out.gunTold, out.fires, out.bindings['touch-pad'].hidden, out.bindings.viewport.data.tool],
      [false, trial === 'armour', true, trial === 'armour' ? 'fire' : 'drive'], trial);
    assert.deepEqual(out.wreck, { title: 'Fora de combate', detail: 'Comando destruído · Restaurar recomeça' });
    if (trial === 'terrain') assert.deepEqual([out.bindings['touch-fire'].hidden, out.bindings['weapon-runtime'].text, out.bindings['weapon-runtime'].data.state],
      [true, 'Fora de combate', 'blocked']);
    // Inspected, the line tells the piece picked, as ever.
    assert.deepEqual([inspected.wreck, Boolean(inspected.inspection), inspected.bindings.viewport.data.tool], [null, true, 'inspect']);
    if (trial === 'armour') {
      // A wreck remains visible but no longer intercepts weapon queries.
      const post = state.modules.find(m => m.actorId === 'local' && m.kind === 'command'), from = { x: post.x - 4, y: post.y + 1.2 },
        strike = strikeAlong({ state, index: snapshotCollisionIndex(state), ground, hull: null, weapon: resolveArmament(weapon, []), distance: 10 }, from, strikeDirection(from, post)),
        marks = () => world.plates.filter(p => p.actorId === 'local').reduce((sum, p) => sum + (p.marks?.length || 0), 0), before = marks();
      game.call({ op: 'projectile', projectile: game.projectile(strike.round) }); run(20);
      assert.equal(marks(), before);
      assert.equal(strike.impact?.owner.type, 'ground', 'the preview passes through the wreck to the terrain');
    }
    // Restaurar loads the test again (simulation-worker.ts): the design whole, in hand, with its gun.
    const again = pageWorld(source, options); t.after(() => again.dispose());
    again.step(); wreckTrial(again);
    assert(!again.actor('local').defeated && controlContext(view, again.snapshot(), { enabled: false }).manual);
  }
  // A design that has no command post at all is no wreck: it is being worked on, and is tested as it is.
  const headless = createStructuredTemplate('ifv'); headless.components = headless.components.filter(part => part.kind !== 'command');
  const bare = pageWorld(headless, { terrain: TRIAL_WORLD.terrain, targets: true }); t.after(() => bare.dispose());
  for (let i = 0; i < 10; i++) { bare.step(); wreckTrial(bare); }
  assert(!bare.actor('local').defeated && !bare.actor('local').field && bare.actors.every(actor => !actor.defeated));
});
