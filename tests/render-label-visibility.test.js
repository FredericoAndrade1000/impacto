import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { Terrain } from '../src/terrain.ts';
import { countingCanvas } from './scenery-canvas.js';
import { Silhouette } from '../src/silhouette.ts';

const flag = { field: 'plain', colours: [4, 0, 8], emblem: 'ring' };
function scene(t) {
  const renderer = new Renderer({}, { mode: 'test' }), stage = new Container({ isRenderGroup: true });
  renderer.app = { stage }; renderer.world = stage.addChild(new Container());
  renderer.actorLayerRoot = renderer.world.addChild(new Container()); renderer.actorLayerRoot.sortableChildren = true;
  renderer.fxLayer = renderer.world.addChild(new Container()); renderer.labels = renderer.world.addChild(new Container());
  renderer.shadows = renderer.world.addChild(new Graphics());
  renderer.terrainScene = { layers: { works: renderer.world.addChild(new Container()) } };
  renderer.ground = new Terrain('flat'); renderer.flagTexture = () => null; renderer.labelWidth = text => text.length * 6;
  Object.assign(renderer.camera, { x: 0, y: 0, zoom: 10, width: 900, height: 550 });
  t.after(() => {
    renderer.effectSurfaceClip.destroy(); stage.destroy({ children: true, context: true });
    renderer.labelIcons.clear();
    for (const context of renderer.flagArts.values()) context.destroy();
  });
  return renderer;
}
function stateAt(a, b, edits = {}) {
  return { shared: true, localPlayerId: 'player', controlledActor: null, time: 5,
    faction: { id: 'own', flag, known: [] }, modules: [], plates: [],
    actors: [a, b].map((x, i) => ({ id: ['a', 'b'][i], ownerId: 'player', playerName: 'Ada', team: 'own', name: 'Caminhão',
      color: 0xa4ba91, preset: 'vehicle', vehicle: { x, y: 0, angle: 0 }, ...edits[['a', 'b'][i]] })) };
}
function labels(renderer, state, previous = null, alpha = 1) {
  renderer.scene = sampleScene(state, previous, alpha); renderer.syncActorLayers(state); renderer.cullActors(state); renderer.drawStructure(state);
}
function watch(nodes) {
  const changes = [];
  for (const node of nodes) node.on('visibleChanged', value => changes.push({ node, value }));
  return changes;
}
function stable(renderer, draw, changes) {
  changes.length = 0; renderer.app.stage.renderGroup.structureDidChange = false; draw();
  assert.equal(renderer.app.stage.renderGroup.structureDidChange, false, 'unchanged visibility does not invalidate Pixi stage structure');
  assert.deepEqual(changes, []);
}

test('individual and grouped vehicle labels and flags change visibility only when the final group changes', t => {
  const renderer = scene(t), individual = stateAt(-22, 22), grouped = stateAt(-1, 1);
  labels(renderer, individual);
  const a = renderer.actorLayers.get('a'), b = renderer.actorLayers.get('b'), changes = watch([a.label, a.flag, b.label, b.flag]);
  assert(a.label.visible && a.flag.visible && b.label.visible && b.flag.visible);
  for (let frame = 0; frame < 3; frame++) stable(renderer, () => labels(renderer, individual), changes);
  labels(renderer, grouped);
  assert(a.label.visible && a.flag.visible && !b.label.visible && !b.flag.visible);
  assert.equal(a.label.text, '2'); assert.deepEqual(a.label.content.chips, [{ icon: 'i-wheel', count: 2, text: '2' }]);
  assert.deepEqual(changes.map(change => change.value), [false, false]);
  for (const x of [0, .1, -.1]) {
    renderer.camera.x = x; stable(renderer, () => labels(renderer, grouped), changes);
  }
  labels(renderer, individual);
  assert(a.label.visible && a.flag.visible && b.label.visible && b.flag.visible);
  assert.deepEqual(changes.map(change => change.value), [true, true]);
  assert.equal(b.flag.x, b.label.x); assert.equal(b.flag.x, 22, 'a newly individual flag already has the displayed vehicle pose');
  assert.equal(b.label.text, ''); assert.equal(b.label.content.chips[0].icon, 'i-wheel');
  stable(renderer, () => labels(renderer, individual), changes);
  const reversed = stateAt(1, -1); labels(renderer, reversed);
  assert(!a.label.visible && !a.flag.visible && b.label.visible && b.flag.visible, 'the leftmost group representative can change');
  stable(renderer, () => labels(renderer, reversed), changes);
});

test('labels and flags leave and reenter the FOV without an extra toggle, and wrecks have no flag', t => {
  const renderer = scene(t), grouped = stateAt(-1, 1);
  labels(renderer, grouped);
  const a = renderer.actorLayers.get('a'), b = renderer.actorLayers.get('b'), changes = watch([a.label, a.flag, b.label, b.flag]);
  renderer.camera.x = 52; labels(renderer, grouped);
  assert.equal(renderer.unseen.size, 0, 'the body can still be in the actor culling margin while its label leaves the FOV');
  assert(!a.label.visible && !a.flag.visible && !b.label.visible && !b.flag.visible);
  assert.deepEqual(changes.map(change => change.value), [false, false]);
  stable(renderer, () => labels(renderer, grouped), changes);
  renderer.camera.x = 1000; labels(renderer, grouped);
  assert.equal(renderer.unseen.size, 2); assert.deepEqual(changes, [], 'the unseen branch leaves already hidden labels alone');
  stable(renderer, () => labels(renderer, grouped), changes);
  renderer.camera.x = 0; labels(renderer, grouped);
  assert(a.label.visible && a.flag.visible && !b.label.visible && !b.flag.visible);
  assert.deepEqual(changes.map(change => change.value), [true, true]);
  stable(renderer, () => labels(renderer, grouped), changes);
  const wreck = stateAt(-1, 1, { a: { defeated: true } }); labels(renderer, wreck);
  assert(a.label.visible && !a.flag.visible && b.label.visible && b.flag.visible);
  assert.match(a.label.text, /Destroços/);
  stable(renderer, () => labels(renderer, wreck), changes);
});

test('a selected or manually controlled vehicle keeps the icon of its kind, never its name', t => {
  const renderer = scene(t), state = stateAt(-1, 1);
  renderer.opened = new Set(['a']); labels(renderer, state);
  const a = renderer.actorLayers.get('a'), b = renderer.actorLayers.get('b'), changes = watch([a.label, a.flag, b.label, b.flag]);
  assert.equal(a.label.text, '2'); assert(a.label.visible && !b.label.visible);
  renderer.camera.x = .1; stable(renderer, () => labels(renderer, state), changes);
  renderer.opened.clear(); const manual = { ...state, controlledActor: 'b' }; labels(renderer, manual);
  assert.equal(a.label.text, '2'); assert(a.label.visible && !b.label.visible);
  stable(renderer, () => labels(renderer, manual), changes);
});

test('phone-width labels keep clocks below the icon and place the flag above it', t => {
  const renderer = scene(t), state = stateAt(30, -30, { a: { field: { service: { kind: 'repair', until: 8 } } } });
  renderer.camera.width = 667; renderer.opened = new Set(['a']); labels(renderer, state);
  const { label, flag } = renderer.actorLayers.get('a'), at = renderer.camera.toScreen(label.x, label.y).x;
  assert.equal(label.caption.text, ''); assert.equal(label.chips[0].icon.visible, true);
  assert.equal(label.status.text, 'em reparo · 3 s'); assert.equal(label.content.statusIcon, 'i-repair');
  assert(label.layout.width <= 260); assert(label.layout.lift > 10);
  assert(at - label.layout.width / 2 >= 0 && at + label.layout.width / 2 <= 667);
  assert.equal(Math.round((flag.y - label.y) * renderer.camera.zoom), label.layout.lift);
  assert(-label.layout.lift < label.layout.top, 'the lower flag edge clears the icon');
  assert(label.status.y > 8, 'the clock has its own line below the icon');
  const children = [...label.children], changes = watch([label, flag]);
  renderer.camera.x = .2; stable(renderer, () => labels(renderer, state), changes); assert.deepEqual(label.children, children);
});

test('the player\'s own and those another member holds, nearly coincident, have separate phone-width labels without pan or bobbing visibility churn', t => {
  const renderer = scene(t), state = stateAt(-1, 1), by = { id: 'ally', name: 'QA Proprietário aliado' };
  renderer.camera.width = 667; renderer.camera.height = 375; renderer.camera.zoom = .4;
  state.actors.push(...state.actors.map((a, i) => ({ ...a, id: 'ally-' + i, ownerId: 'ally', playerName: 'QA Proprietário aliado' })));
  state.squad = { manual: null, out: [], units: [{ id: 'ally-0', by }, { id: 'ally-1', by }] };
  const original = JSON.stringify(state); labels(renderer, state);
  const entries = [...renderer.actorLayers.values()], changes = watch(entries.flatMap(layer => [layer.label, layer.flag])),
    rect = layer => { const label = layer.label, at = renderer.camera.toScreen(label.x, label.y);
      return { left: at.x - label.layout.width / 2, right: at.x + label.layout.width / 2,
        top: at.y + Math.min(label.layout.top, layer.flag?.visible ? -label.layout.lift - 15 : 0), bottom: at.y + label.layout.bottom }; },
    assertSeparate = () => {
      const shown = entries.filter(layer => layer.label.visible).map(rect); assert.equal(shown.length, 2);
      for (const box of shown) assert(box.left >= 0 && box.right <= 667);
      for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i], b = shown[j]; assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      }
    };
  assertSeparate();
  const ally = renderer.actorLayers.get('ally-0').label, own = renderer.actorLayers.get('a').label, sign = Math.sign(ally.y - own.y);
  for (let frame = 0; frame < 24; frame++) {
    const bob = Math.sin(frame / 4) * .05, moving = { ...state, actors: state.actors.map(a => ({ ...a, vehicle: { ...a.vehicle, y: a.ownerId === 'ally' ? bob : -bob } })) };
    renderer.camera.x = frame % 2 ? .1 : -.1; stable(renderer, () => labels(renderer, moving), changes); assertSeparate();
    assert.equal(Math.sign(ally.y - own.y), sign, 'small suspension changes cannot swap owner rows');
  }
  assert.equal(JSON.stringify(state), original);
});

test('removing one actor preserves shared icon contexts until the renderer clears its remaining labels', t => {
  const renderer = scene(t), state = stateAt(-22, 22); labels(renderer, state);
  const a = renderer.actorLayers.get('a'), b = renderer.actorLayers.get('b'), context = a.label.chips[0].icon.context;
  assert.equal(b.label.chips[0].icon.context, context);
  renderer.pruneActorLayers({ ...state, actors: [state.actors[0]] });
  assert.equal(b.label.destroyed, true); assert.equal(context.destroyed, false);
  assert.equal(a.label.chips[0].icon.context, context);
  renderer.clearLayers(); assert.equal(context.destroyed, true); assert.equal(renderer.labelIcons.contexts.size, 0);
  assert.equal(renderer.labels.children.length, 0);
});

test('the workshop board owns its icon cache and clearing it cannot destroy the field icons', t => {
  const renderer = scene(t); labels(renderer, stateAt(-22, 22));
  const fieldIcon = renderer.actorLayers.get('a').label.chips[0].icon.context;
  renderer.benchArt = renderer.world.addChild(new Container());
  const board = renderer.buildBoard(), boardIcon = board.labelIcons.get('i-wheel');
  assert.notEqual(board.labelIcons, renderer.labelIcons); assert.notEqual(boardIcon, fieldIcon);
  board.clearConstructions(); assert.equal(boardIcon.destroyed, true); assert.equal(fieldIcon.destroyed, false);
  assert.equal(renderer.actorLayers.get('a').label.chips[0].icon.context, fieldIcon);
});

test('clearing construction art releases external hull fittings and detached outlines while shared art survives', t => {
  const renderer = scene(t); labels(renderer, stateAt(-22, 22));
  const skin = renderer.actorLayer('a', 'hullSkins').addChild(new Sprite(Texture.WHITE)),
    rim = skin.rim = renderer.actorLayer('a', 'bodyPanels').addChild(new Graphics().rect(0, 0, 2, 1).stroke(0xffffff)),
    rimContext = rim.context,
    fittings = skin.fittings = renderer.actorLayer('a', 'hullSkins').addChild(new Container()),
    fitting = fittings.addChild(new Sprite(Texture.WHITE)),
    made = renderer.silhouettes.wanted('test-hull', () => ({ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }] }), 'dark', .1),
    other = renderer.actorLayer('b', 'outline').addChild(new Silhouette(made));
  // A glint hidden at a lower LOD is detached, so destroying actor layers alone cannot release it.
  skin.glint = new Silhouette(made);
  renderer.hullSprites.set('skin', skin);
  renderer.clearParts();
  assert([skin, rim, fittings, fitting, skin.glint].every(part => part.destroyed));
  assert(rimContext.destroyed, 'the owned rim context is released with its drawing');
  assert.equal(other.destroyed, false); assert.equal(made.context.destroyed, false);
  assert.equal(made.users, 1, 'only the surviving construction retains the shared outline');
  assert.equal(Texture.WHITE.destroyed, false, 'clearing artwork never destroys shared textures');
  renderer.clearLayers(); renderer.silhouettes.sweep();
  assert(made.context.destroyed, 'the last user can release its shared artwork normally');
});

test('place obstacles read only current visible base Text bounds after updating both base presentations once', t => {
  const renderer = scene(t), calls = [], caption = { visible: false, left: 0, reads: 0,
    getBounds() { this.reads++; return { minX: this.left, maxX: this.left + 80, minY: 260, maxY: 276 }; } },
    foreign = { ...caption }, hidden = { visible: false, getBounds() { throw new Error('Hidden captions must not be measured'); } };
  renderer.baseLabel = caption; renderer.foreignBases = new Map([['other', { label: foreign }], ['hidden', { label: hidden }]]);
  renderer.drawBase = base => { calls.push('base'); caption.visible = Boolean(base); caption.left = base?.x ?? 0; };
  renderer.drawForeignBases = bases => { calls.push('foreign'); foreign.visible = Boolean(bases?.length); foreign.left = bases?.[0]?.x ?? 0; };
  renderer.camera.width = 667; renderer.camera.height = 375;
  const state = stateAt(-1, 1); state.faction = { ...state.faction, base: { x: 300 }, bases: [{ x: 500 }] };
  let obstacles = renderer.drawPlaceLabels(state);
  assert.deepEqual(calls, ['base', 'foreign']); assert.deepEqual(obstacles.map(item => item.x), [340, 540]);
  state.faction.base.x = 350; state.faction.bases[0].x = 1000; calls.length = 0;
  obstacles = renderer.drawPlaceLabels(state);
  assert.deepEqual(calls, ['base', 'foreign']); assert.deepEqual(obstacles.map(item => item.x), [390], 'current projected bounds replace old ones; offscreen captions reserve nothing');
  state.faction.base = null; state.faction.bases = []; const reads = [caption.reads, foreign.reads];
  assert.deepEqual(renderer.drawPlaceLabels(state), []); assert.deepEqual([caption.reads, foreign.reads], reads);
});

test('drawDesign updates place captions before vehicle structure and forwards only that frame obstacles', t => {
  const renderer = scene(t), state = stateAt(-1, 1), calls = [], obstacles = [{ x: 300, y: 260, width: 80, top: 0, bottom: 16 }];
  Object.defineProperty(renderer, 'designState', { value: state });
  renderer.drawPlaceLabels = seen => { assert.equal(seen, state); calls.push('places'); return obstacles; };
  renderer.drawStructure = (seen, passed) => { assert.equal(seen, state); assert.equal(passed, obstacles); calls.push('structure'); };
  renderer.drawOverlay = () => calls.push('overlay');
  for (const name of ['drawSurfaces', 'drawBodyPanels', 'drawChassisArt', 'drawGun', 'drawWorkArms']) renderer[name] = () => {};
  renderer.drawDesign(); assert.deepEqual(calls, ['places', 'structure', 'overlay']);
});

test('foreign base visibility is final per frame while FOV, state changes and retirement retain existing artwork rules', t => {
  countingCanvas(t);
  const renderer = scene(t), base = { id: 'foreign', name: 'Bia', nation: null, flag, x: 0, facing: 1, radius: 100, seen: true, at: null };
  renderer.drawForeignBases([base]);
  const art = renderer.foreignBases.get(base.id), parts = [art.works, art.front, art.label], changes = watch(parts), drawn = art.drawn;
  assert(parts.every(part => part.visible));
  for (let frame = 0; frame < 3; frame++) stable(renderer, () => renderer.drawForeignBases([{ ...base }]), changes);
  assert.equal(art.drawn, drawn);
  const unseen = { ...base, name: 'Cris', seen: false, at: 5 };
  stable(renderer, () => renderer.drawForeignBases([unseen]), changes);
  assert.equal(art.label.text, 'Base · Facção de Cris'); assert(parts.every(part => part.alpha === .6));
  assert.equal(art.drawn, drawn, 'an updated label or visibility does not repaint the static works');
  const moved = { ...unseen, x: 15 }; renderer.drawForeignBases([moved]);
  assert.notEqual(art.drawn, drawn); assert.equal(art.works.x, moved.x);
  stable(renderer, () => renderer.drawForeignBases([moved]), changes);
  const reflagged = { ...moved, flag: { ...flag, colours: [1, 2, 3] } }, beforeFlag = art.drawn;
  renderer.drawForeignBases([reflagged]); assert.notEqual(art.drawn, beforeFlag, 'a new flag still redraws the works');
  const shifted = art.drawn;
  stable(renderer, () => renderer.drawForeignBases([reflagged]), changes);
  renderer.camera.x = 10000; renderer.drawForeignBases([reflagged]);
  assert(parts.every(part => !part.visible)); assert.deepEqual(changes.map(change => change.value), [false, false, false]);
  stable(renderer, () => renderer.drawForeignBases([reflagged]), changes);
  renderer.camera.x = 0; renderer.drawForeignBases([reflagged]);
  assert(parts.every(part => part.visible)); assert.equal(art.drawn, shifted);
  assert.deepEqual(changes.map(change => change.value), [true, true, true]);
  stable(renderer, () => renderer.drawForeignBases([reflagged]), changes);
  renderer.drawForeignBases(null); assert(parts.every(part => !part.visible)); assert.equal(renderer.foreignBases.size, 1);
  stable(renderer, () => renderer.drawForeignBases(null), changes);
  renderer.drawForeignBases([]); assert.equal(renderer.foreignBases.size, 0); assert(parts.every(part => part.destroyed));
});

test('towing draws only known own endpoints at Native anchors and clears culling, ghost and detached cables through the normal overlay', t => {
  const renderer = scene(t), state = stateAt(-5, 5), actors = state.actors;
  renderer.view.testTool = 'inspect'; renderer.playback.state = state;
  renderer.overlay = renderer.world.addChild(new Graphics());
  // The existing firing-overlay setup leaves unrelated labels/deposit artwork out.
  for (const name of ['impactLabel', 'servoLabel', 'leadLabel', 'strikeWords', 'strikeDetail']) renderer[name] = { visible: false };
  renderer.drawDeposits = () => {};
  state.tows = [{ actorId: 'a', targetId: 'b', anchorA: { x: -3, y: 1.5 }, anchorB: { x: 3, y: 1.5 },
    length: 6, tension: 0, limit: 10000 }];
  const draw = () => { renderer.scene = sampleScene(state); renderer.drawOverlay(state); return renderer.overlay.context.instructions.length; };
  assert(draw() > 0, 'the actual overlay includes the delivered cable');
  const bounds = renderer.overlay.getLocalBounds();
  assert(bounds.minX > -4 && bounds.maxX < 4, 'the line follows Native anchors, not the actor origins at -5/+5');
  const previous = structuredClone(state);
  for (const actor of previous.actors) { actor.vehicle.x += 20; actor.vehicle.y += 10; actor.vehicle.angle = Math.PI / 2; }
  renderer.scene = sampleScene(state, previous, .5); renderer.drawOverlay(state);
  const moving = renderer.overlay.getLocalBounds();
  assert(moving.minX > 5 && moving.maxX < 13 && moving.minY > 4 && moving.maxY < 8,
    'translation and rotation use the same sampled chassis poses as the vehicles, between authoritative frames');
  assert(draw() > 0);
  renderer.camera.x = 1000; assert.equal(draw(), 0, 'a cable wholly outside the view does not persist');
  renderer.camera.x = 0; assert(draw() > 0);
  state.actors = [actors[0]]; assert.equal(draw(), 0, 'a missing endpoint discloses no current attachment position');
  state.actors = actors; actors[1].ghost = true; assert.equal(draw(), 0, 'a remembered actor cannot receive a live cable');
  actors[1].ghost = false; actors[1].team = 'foreign'; assert.equal(draw(), 0, 'foreign links are not drawn even if accidentally delivered');
  actors[1].team = 'own'; assert(draw() > 0);
  state.tows = []; assert.equal(draw(), 0, 'the next empty authoritative array clears the cable without a separate teardown cache');
});

test('from afar a construction a few pixels long is a mark of its paint under its label, its effects kept, and in full again nearer', t => {
  const renderer = scene(t), plate = (id, actorId, x) => ({ id, actorId, definition: { x, y: 1, angle: 0, length: 6, thicknessMm: 200 } }),
    state = { ...stateAt(-200, 200, { a: { appearance: { paint: '#64788c' }, revision: 1 }, b: { revision: 1 } }), plates: [plate('pa', 'a', -200), plate('pb', 'b', 200)] };
  // Six metres long: a mark under ten pixels, art again over twelve and a half; the gap does not switch it.
  for (const [zoom, dotted] of [[10, false], [1.7, false], [1.65, true], [1.9, true], [2.1, false], [1.8, false]]) {
    renderer.camera.zoom = zoom; labels(renderer, state);
    assert.equal(renderer.dotted.has('a'), dotted, `${zoom} px/m`);
  }
  renderer.camera.zoom = .5; labels(renderer, state);
  const a = renderer.actorLayers.get('a'), dots = renderer.actorDots;
  assert(renderer.dotted.has('a') && renderer.dotted.has('b') && renderer.unseen.has('a'));
  assert(a.container.visible && a.container.children.every(layer => layer.visible === (layer === a.fxLayer)), 'only the effects of its layers show');
  assert(a.label.visible, 'its label stays');
  // The mark covers the plates, never under a pixel, in the paint darkened; one with no paint told is in olive.
  const fills = dots.context.instructions.filter(instruction => instruction.action === 'fill');
  assert.equal(fills.length, 2); assert.equal(fills[0].data.style.color, 0x3c4854);
  assert.deepEqual(dots.getLocalBounds().rectangle.width > 0, true);
  // Still, or only the camera moving, the marks are not drawn again.
  const context = dots.context, drawn = context.instructions.slice();
  renderer.camera.x += 300; labels(renderer, state); assert.deepEqual(context.instructions, drawn);
  // Near, the layers show again and no mark is drawn.
  renderer.camera.zoom = 4; renderer.camera.x = -200; labels(renderer, state);
  assert.equal(renderer.dotted.size, 0); assert(!dots.visible && a.container.children.every(layer => layer.visible));
});

test('a compact body keeps its gun and effects until their own scale is unreadable, including return from offscreen', t => {
  const renderer = scene(t), state = stateAt(0, 200);
  state.plates = state.actors.map(actor => ({ id: actor.id + ':plate', actorId: actor.id,
    definition: { x: actor.vehicle.x, y: 1, angle: 0, length: 8, thicknessMm: 200 } }));
  renderer.camera.zoom = 1; labels(renderer, state);
  const a = renderer.actorLayers.get('a');
  assert(renderer.dotted.has('a') && renderer.unseen.has('a'));
  assert(a.gun.visible && a.gunArt.visible && a.fxLayer.visible && !a.outerSkin.visible);
  renderer.camera.x = 2000; labels(renderer, state); assert(!a.container.visible);
  renderer.camera.x = 0; labels(renderer, state); assert(a.container.visible && a.gun.visible);
  renderer.camera.zoom = .5; labels(renderer, state); assert(!a.gun.visible && !a.gunArt.visible && a.fxLayer.visible);
  renderer.camera.zoom = 1; labels(renderer, state); assert(a.gun.visible && a.gunArt.visible);
  renderer.camera.zoom = 2; labels(renderer, state); assert(!renderer.dotted.has('a') && a.outerSkin.visible);
});

test('a distant mark follows body pitch without rebuilding its extent, and a tall construction does not become a tiny mark', t => {
  const renderer = scene(t), state = stateAt(0,200);
  state.plates = [{id:'a:plate',actorId:'a',definition:{x:0,y:0,angle:0,length:8,thicknessMm:200}},
    {id:'b:plate',actorId:'b',definition:{x:200,y:0,angle:Math.PI/2,length:20,thicknessMm:200}}];
  renderer.camera.zoom = 1; labels(renderer,state);
  const extent = renderer.actorLayers.get('a').extent, before = renderer.actorDots.getLocalBounds().rectangle.height;
  const pitched = {...state,actors:state.actors.map(actor=>actor.id==='a' ? {...actor,vehicle:{...actor.vehicle,angle:.5}} : actor)};
  labels(renderer,pitched);
  assert.strictEqual(renderer.actorLayers.get('a').extent,extent);
  assert(renderer.actorDots.getLocalBounds().rectangle.height > before+2, 'the compact body rotates with the vehicle');
  assert(!renderer.dotted.has('b'), 'height counts as projected size too');
});
