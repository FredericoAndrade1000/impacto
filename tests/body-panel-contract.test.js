import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { coveredParts } from '../src/hull-coverage.ts';
import { designFrame, sampleScene, regionContains } from '../src/scene-frame.ts';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { partViews } from '../src/part-view.ts';
import { pickPiece } from '../src/editor.ts';
import { localToWorld } from '../src/math.ts';
import { Renderer } from '../src/render.ts';
import { hullLayout } from '../src/hull-details.ts';
import { componentReference } from '../src/component-size.ts';
import { CELL } from '../src/grid.ts';

await initNativeDynamics();
const polygon = [{ x: -2, y: -.5 }, { x: 2, y: -.5 }, { x: 2, y: .5 }, { x: -2, y: .5 }];
function frame(pose = { x: 12, y: 2, angle: 0 }) {
  const state = designFrame({ preset: 'vehicle', appearance: { paint: '#62737b' }, plates: [], modules: [] });
  state.actors[0].vehicle = { ...pose, chassisId: 'root' };
  state.bodyPanels = [{ id: 'paint', actorId: 'local', pose: { x: 12, y: 2, angle: 0 }, localPolygon: polygon }]; return state;
}

test('fixed backing persists through damage without a compartment packet and survives JSON transport', () => {
  const state = frame(), shape = bodyPanelSurfaces(state)[0], told = ({ fittings, ...surface }) => ({ ...surface, fittings: fittings() });
  assert.equal(shape.paint, 0x62737b); assert.equal(shape.artPolygon, polygon); assert.deepEqual(shape.marks, []);
  // What its fittings are placed by is asked for when its skin is painted, and is the same after the journey.
  assert.deepEqual(bodyPanelSurfaces(JSON.parse(JSON.stringify(state))).map(told), [told(shape)]);
  assert(!('compartments' in state));
});

test('a rotated vehicle carries the visual backing with constant side lengths', () => {
  const shape = bodyPanelSurfaces(frame({ x: 40, y: 5, angle: Math.PI / 2 }))[0],
    points = shape.artPolygon.map(p => localToWorld(shape.artPose, p.x, p.y));
  assert.deepEqual(points.map(p => [Math.round(p.x * 10), Math.round(p.y * 10)]), [[405,30],[405,70],[395,70],[395,30]]);
  assert(Math.abs(Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) - 4) < 1e-12);
});

test('an open plate construction never manufactures a closed backing', () => {
  // The backing is the outline of each compiled room and of nothing else. Open plates remain exposed.
  // The infantry carrier's open turret ring connects its tower and hull into one room.
  const box = createStructuredConstruction(), compiled = compileBlueprint(box), tank = compileBlueprint(createConstruction('ifv'));
  assert.deepEqual(compiled.bodyPanels, [{ id: 'room-1:panel', roomId: 'room-1', poly: compiled.rooms[0].polygon }]);
  assert.deepEqual(bodyPanelSurfaces(designFrame(compiled)).map(shape => shape.artPolygon), [compiled.rooms[0].polygon]);
  assert.equal(tank.rooms.length, 1);
  assert.deepEqual(tank.bodyPanels.map(panel => [panel.id, panel.poly]), tank.rooms.map(room => [room.id + ':panel', room.polygon]));
  const plates = box.plates.slice(0, 1), ends = new Set(plates.flatMap(plate => [plate.a, plate.b])),
    open = compileBlueprint({ ...box, nodes: box.nodes.filter(node => ends.has(node.id)), plates });
  assert.deepEqual(open.rooms, []); assert.deepEqual(open.bodyPanels, []);
  assert.deepEqual(bodyPanelSurfaces(designFrame(open)), []);
});

test('the skin of a hull seen from outside covers what stands within it, and nothing of what is outside', t => {
  const world = new World(createStructuredTemplate('ifv')); t.after(() => world.dispose());
  // The other one faces the other way.
  world.addActor(createStructuredTemplate('ifv'), { id: 'other', ownerId: 'other', x: 60, facing: 1 });
  const state = world.snapshot(), scene = sampleScene(state), closed = new Set(['other']),
    kinds = (ids, told = state) => [...ids].map(id => told.modules.find(module => module.id === id)).map(module => module.actorId + ':' + module.kind).sort();
  // Nothing is closed: nothing is covered, and every hull has its skin.
  assert.equal(coveredParts(state, new Set(), scene).size, 0); assert.equal(coveredParts(state, null, scene).size, 0);
  assert.deepEqual(new Set(bodyPanelSurfaces(state, null, null, 1, scene).map(surface => surface.actorId)), new Set(['local', 'other']));
  // Closed, the engine, the tank, the rack and the computer are under the skin;
  // the track, the gun and what sits on the roof are not.
  const covered = coveredParts(state, closed, scene);
  assert.deepEqual(kinds(covered), ['other:ammo', 'other:command', 'other:engine', 'other:fuel']);
  // The same closed skin must not decorate itself differently when an audience is not told its hidden equipment.
  const observer = structuredClone(state); observer.modules = observer.modules.filter(module => !covered.has(module.id));
  const observerScene = sampleScene(observer), observerCovered = coveredParts(observer, closed, observerScene),
    surfaces = bodyPanelSurfaces(state, null, null, 1, scene).filter(surface => surface.actorId === 'other'),
    observerSurfaces = bodyPanelSurfaces(observer, null, null, 1, observerScene).filter(surface => surface.actorId === 'other');
  for (const surface of surfaces) {
    const sprite = {}, publicSprite = {}, publicSurface = observerSurfaces.find(other => other.id === surface.id),
      fit = side => Renderer.prototype.fitted.call({ covered }, sprite, surface, state, side),
      outside = fit('outside'), publicOutside = Renderer.prototype.fitted.call({ covered: observerCovered }, publicSprite, publicSurface, observer, 'outside');
    assert.deepEqual(outside.scene, publicOutside.scene); assert.equal(outside.key, publicOutside.key);
    assert.deepEqual(hullLayout(surface.artPolygon, outside.scene), hullLayout(publicSurface.artPolygon, publicOutside.scene));
    // Opening is a separate cached side and keeps the real equipment; closing restores the public artwork.
    const inside = fit('inside');
    assert.deepEqual(inside.scene.pieces, surface.fittings().pieces);
    assert(inside.scene.pieces.length > outside.scene.pieces.length);
    assert.equal(fit('outside'), outside); assert.equal(fit('inside'), inside);
  }
  // The hull carries what is within it wherever it goes, however it stands.
  const turned = structuredClone(state), hull = turned.actors.find(actor => actor.id === 'other').vehicle, c = Math.cos(1.1), s = Math.sin(1.1);
  for (const module of turned.modules.filter(module => module.actorId === 'other')) {
    const dx = module.x - hull.x, dy = module.y - hull.y;
    Object.assign(module, { x: hull.x + 300 + c * dx - s * dy, y: hull.y + 40 + s * dx + c * dy, angle: (module.angle || 0) + 1.1 });
  }
  Object.assign(hull, { x: hull.x + 300, y: hull.y + 40, angle: (hull.angle || 0) + 1.1 });
  assert.deepEqual(kinds(coveredParts(turned, closed, sampleScene(turned))), kinds(covered));
  // What came loose is no longer within, and an actor nobody looks at has nothing worked out for it.
  const loose = structuredClone(state); loose.modules.find(module => module.actorId === 'other' && module.kind === 'fuel').attached = false;
  assert.deepEqual(kinds(coveredParts(loose, closed, sampleScene(loose))), ['other:ammo', 'other:command', 'other:engine']);
  assert.equal(coveredParts(state, closed, scene, new Set(['other'])).size, 0);
  // An explicit internal camera rests on the real Command box, clear of the fuel behind it and below the hull roof.
  const within = createStructuredTemplate('ifv'), command = within.components.find(part => part.kind === 'command'),
    inner = { id: 'inner', kind: 'sensor', sensorMode: 'visual' },
    rise = (componentReference(command).height + componentReference(inner).height) / (2 * CELL);
  within.components.push({ ...inner, pose: { ...command.pose, y: command.pose.y + rise } });
  world.addActor(within, { id: 'third', ownerId: 'other', x: 120 });
  const more = world.snapshot();
  assert.deepEqual(kinds(coveredParts(more, new Set(['third']), sampleScene(more)), more), ['third:ammo', 'third:command', 'third:engine', 'third:fuel', 'third:sensor']);
});

test('the design on the bench seen from outside has the same parts under its skin as on the field', () => {
  const compiled = compileBlueprint(createStructuredTemplate('ifv')), design = designFrame(compiled), scene = sampleScene(design),
    kinds = ids => [...ids].map(id => design.modules.find(module => module.id === id).kind).sort();
  assert.equal(coveredParts(design, new Set(), scene, null, compiled.bodyPanels).size, 0, 'seen from inside, nothing is covered');
  assert.deepEqual(kinds(coveredParts(design, new Set(['local']), scene, null, compiled.bodyPanels)), ['ammo', 'command', 'engine', 'fuel']);
  // Its skin is the construction's own, to be laid over all it holds.
  assert.deepEqual(new Set(bodyPanelSurfaces(design, compiled.bodyPanels, null, 1, scene).map(surface => surface.actorId)), new Set(['local']));
});

test('inspection reads plate material and failed component health from the installed presentation frame', () => {
  const blueprint = compileBlueprint(createConstruction('heavy')), state = designFrame(blueprint), plate = state.plates[0],
    engine = state.modules.find(m => m.kind === 'engine');
  plate.integrity = .72; engine.health = 0; engine.detonated = true;
  const fuel = state.modules.find(m => m.kind === 'fuel'); fuel.health = 0; fuel.detonated = true;
  const parts = partViews(blueprint, state), plateView = parts.find(p => p.id === plate.id),
    engineView = parts.find(p => p.id === engine.id);
  assert.equal(plateView.physical, plate); assert.equal(plateView.health.fraction, .72);
  assert.match(plateView.health.status, /perfuração/i);
  assert.equal(engineView.physical, engine); assert.equal(engineView.health.fraction, 0);
  assert.equal(engineView.health.status, 'Inutilizado');
  assert.equal(parts.find(p => p.id === fuel.id).health.status, 'Inutilizado · reserva perdida');
});

test('part views resolve ordered intentions without losing complete inspection or physical health', () => {
  const blueprint = compileBlueprint(createConstruction('heavy')), state = designFrame(blueprint), plate = state.plates[0],
    engine = state.modules.find(m => m.kind === 'engine');
  plate.integrity = .72; engine.health = 0;
  const all = partViews(blueprint, state), ids = [engine.id, 'missing', plate.id], selected = partViews(blueprint, state, new Set(ids));
  assert.equal(all.length, state.plates.length + state.modules.length, 'omitting IDs still reads every installed part');
  assert.deepEqual(selected.map(part => part.id), [engine.id, plate.id]);
  for (const part of selected) {
    const complete = all.find(other => other.id === part.id);
    assert.equal(part.definition, complete.definition); assert.equal(part.physical, complete.physical);
    assert.deepEqual(part.health, complete.health);
  }
  assert.deepEqual(partViews(blueprint, state, ids).map(part => part.id), [engine.id, plate.id], 'arrays retain the same order as a Set');
  assert.deepEqual(partViews(blueprint, state, []), []);
  assert.deepEqual(partViews(blueprint, null, new Set()), []);
  assert.deepEqual(partViews(blueprint).map(part => part.id), [...blueprint.plates, ...blueprint.modules].map(part => part.id));
});

test('damage inspection picks installed material around a ballistic opening without a detached-body registry', () => {
  const state = designFrame({ plates: [{ id: 'plate', material: 'steel', x: 0, y: 1, angle: 0,
    length: 2, thicknessMm: 100, anchors: [] }], modules: [] });
  state.plates[0].solidRegions = [{ minX: -1, maxX: -.2, minY: -.05, maxY: .05 },
    { minX: .2, maxX: 1, minY: -.05, maxY: .05 }];
  const inspect = point => pickPiece(state.plates, state.modules, point, 0,
    part => part.material ? regionContains(part, point) : undefined);
  assert.equal(inspect({ x: 0, y: 1 }), null); assert.equal(inspect({ x: .6, y: 1 }), 'plate');
});


