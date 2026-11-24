import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { compileBlueprint, validateBlueprint, serializeBlueprint, parseBlueprint } from '../src/persistence.ts';
import { constructionCost } from '../src/construction-cost.ts';
import { Editor } from '../src/editor.ts';
import { DetailEditor } from '../src/detail-editor.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { designFrame, sampleScene } from '../src/scene-frame.ts';
import { hullLayout } from '../src/hull-details.ts';
import { paintAuthoredDetails, hullArtwork } from '../src/hull-art.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { chassisFrame, chassisPlacement } from '../src/chassis-art.ts';
import { Renderer } from '../src/render.ts';
import { DETAIL_LIMIT, VEHICLE_DETAILS, detailGroup, detailAt, detailPose, detailCorners, detailHostAt, editableDetailHosts, plateDetails, detailInBasis,
  hostForDetail, pickDetail, legacyDetails } from '../src/vehicle-details.ts';
import { miningWorld } from './helpers/mining-mobility.js';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi(); await initNativeDynamics();
const near = (a, b, why = '') => assert(Math.abs(a - b) < 2e-5, `${a} ≠ ${b} ${why}`);
const sourceWith = (details, id = 'truck') => { const source = createConstruction(id); source.appearance.details = details; return source; };
const places = blueprint => blueprint.appearance.details.map(detail => {
  const host = hostForDetail(editableDetailHosts(blueprint), detail);
  assert(host, detail.host); return { id: detail.id, ...detailPose(host, detail) };
});

test('every factory finish starts automatic and is an admitted set of at most thirty-two editable catalogue details', () => {
  for (const { id } of CONSTRUCTION_TEMPLATES) {
    const source = createConstruction(id), blueprint = compileBlueprint(source);
    assert(Array.isArray(source.appearance.details), id);
    assert(source.appearance.details.length <= DETAIL_LIMIT, id);
    assert.equal(source.appearance.automaticDetails, true);
    assert.deepEqual(blueprint.appearance.details, source.appearance.details, id + ' does not discard a factory host');
    for (const detail of source.appearance.details) assert(VEHICLE_DETAILS[detail.kind]);
    places(blueprint);
  }
  // The trucks' door is the owner's: a crew door cut into the steel of the cab, its small window set in it.
  for (const id of ['chassis', 'truck', 'supply', 'tanker', 'tracked', 'mining-truck']) {
    assert(createConstruction(id).appearance.details.some(d => d.kind === 'armour-door'), id);
  }
});

test('thirty-two details do not change physical parts, mass, vision, propulsion or cost', () => {
  const plain = sourceWith([]), first = createConstruction('truck').appearance.details[0],
    source = sourceWith(Array.from({ length: DETAIL_LIMIT }, (_, i) => ({ ...first, id: `detail-${i}` }))),
    a = compileBlueprint(plain), b = compileBlueprint(source);
  for (const key of ['plates', 'modules', 'fixedAssembly', 'powertrain', 'sights', 'eyes', 'chassis', 'rooms']) assert.deepEqual(a[key], b[key], key);
  assert.deepEqual(constructionCost(a), constructionCost(b));
  const tooMany = structuredClone(source); tooMany.appearance.details.push({ ...first, id: 'thirty-three' });
  assert.throws(() => validateBlueprint(tooMany), error => error.reason === 'AUTHORING_LIMIT');
});

test('native admission refuses unsafe or unbounded appearance data while preserving missing cosmetic hosts', () => {
  const source = createConstruction('truck');
  for (const [field, value] of [['width', Infinity], ['height', 30], ['x', NaN], ['y', -25], ['angle', 7],
    ['mirrored', 1], ['kind', 'custom-image'], ['text', '<x>'], ['url', 'https://example.com/a.png']]) {
    const bad = structuredClone(source); bad.appearance.details[0][field] = value;
    assert.throws(() => validateBlueprint(bad), undefined, field);
  }
  for (const detail of [{ ...source.appearance.details[0], host: 'removed' },
    { ...source.appearance.details[0], surface: 'part', host: 'sensor-0' }]) {
    if (detail.surface === 'part') delete detail.space;
    assert.equal(validateBlueprint(sourceWith([detail])).appearance.details.length, 1);
  }
});

test('an empty editable layer leaves automatic finish active by default, including legacy files', () => {
  const source = createConstruction('truck'); delete source.appearance.details; delete source.appearance.automaticDetails;
  const original = structuredClone(source), b = compileBlueprint(source), adopted = legacyDetails(b);
  assert.deepEqual(source, original); assert(!('details' in validateBlueprint(source).appearance));
  assert(adopted.some(d => d.kind === 'cab-door')); assert(adopted.length <= DETAIL_LIMIT);
  const canonical = validateBlueprint(sourceWith(adopted));
  assert.deepEqual(validateBlueprint(canonical), canonical);
  for (let i = 0; i < adopted.length; i++) near(canonical.appearance.details[i].angle, adopted[i].angle);
  const bare = sourceWith([]); delete bare.appearance.automaticDetails;
  const empty = compileBlueprint(bare), [surface] = bodyPanelSurfaces(designFrame(empty), empty.bodyPanels);
  assert.equal(surface.fittings().manualDetails, true);
  assert.equal(bodyPanelSurfaces(designFrame(empty))[0].fittings().manualDetails, true, 'local faces use the same appearance path');
  assert.equal(surface.fittings().automaticDetails, true);
  assert(hullLayout(surface.artPolygon, { ...surface.fittings(), side: 'outside' }).fittings.length > 0);
});

test('disabling automatic finish freezes its stamps; enabling regenerates only automatic stamps and clear is undoable', () => {
  const source = createConstruction('truck'), before = compileBlueprint(source),
    layouts = b => bodyPanelSurfaces(designFrame(b), b.bodyPanels).map(surface => hullLayout(surface.artPolygon, { ...surface.fittings(), side: 'outside' })),
    active = layouts(before);
  assert(source.appearance.details.some(detail => detail.automatic));
  for (const layout of active) for (const detail of layout.details)
    assert(!layout.fittings.some(f => f.kind === detail.kind), 'authored kinds are not repeated automatically in the same room');
  const editor = new Editor(source), physics = editor.blueprint, errors = [], controller = Object.assign(Object.create(DetailEditor.prototype), {
    editor: () => editor, render() {}, changed() {}, toast: text => errors.push(text),
  });
  controller.setAutomatic(false);
  assert.equal(editor.source.appearance.automaticDetails, false);
  assert.deepEqual(editor.blueprint.modules, physics.modules, 'committing appearance changes no mechanics');
  assert.deepEqual(editor.source.appearance.details, source.appearance.details);
  assert(layouts(editor.blueprint).every(layout => layout.fittings.length === 0));
  assert.deepEqual(parseBlueprint(serializeBlueprint(editor.source)), editor.source);
  assert.equal(editor.past.length, 1); assert.deepEqual(errors, []);
  assert(editor.undo()); assert.equal(editor.source.appearance.automaticDetails, true);
  assert(editor.redo()); assert.equal(editor.source.appearance.automaticDetails, false);
  for (const bad of [0, 'false', null]) {
    const invalid = structuredClone(source); invalid.appearance.automaticDetails = bad;
    assert.throws(() => validateBlueprint(invalid));
  }
  const disabled = compileBlueprint(editor.source);
  for (const key of ['plates', 'modules', 'fixedAssembly', 'powertrain', 'sights', 'eyes', 'chassis']) assert.deepEqual(disabled[key], before[key], key);
  assert.deepEqual(constructionCost(disabled), constructionCost(before));
  controller.setAutomatic(true);
  assert.equal(editor.source.appearance.automaticDetails, true);
  assert.deepEqual(editor.source.appearance.details.filter(detail => !detail.automatic), source.appearance.details.filter(detail => !detail.automatic));
  const regenerated = structuredClone(editor.source);
  controller.clearAll(); assert.deepEqual(editor.source.appearance.details, []); assert.equal(editor.source.appearance.automaticDetails, false);
  assert(layouts(editor.blueprint).every(layout => !layout.fittings.length && !layout.details.length));
  assert(editor.undo()); assert.deepEqual(editor.source, regenerated);
});

test('body details keep their project positions when a room opens and its original plate is replaced or moved', () => {
  const source = createConstruction('truck'), original = compileBlueprint(source),
    detail = source.appearance.details.find(d => d.surface === 'body' && d.kind === 'armour-door'),
    before = detailPose(hostForDetail(editableDetailHosts(original), detail), detail),
    opened = structuredClone(source), plate = opened.plates.find(p => p.id === detail.host);
  assert.equal(detail.space, 'project');
  opened.plates = opened.plates.filter(p => p.id !== detail.host);
  const admitted = validateBlueprint(opened);
  assert.deepEqual(admitted.appearance.details, source.appearance.details);
  assert.deepEqual(detailPose(hostForDetail(editableDetailHosts(compileBlueprint(admitted)), detail), detail), before);
  admitted.plates.push({ ...plate, id: 'replacement-roof' });
  const rebuilt = compileBlueprint(admitted);
  assert.deepEqual(detailPose(hostForDetail(editableDetailHosts(rebuilt), detail), detail), before);
  const visible = bodyPanelSurfaces(designFrame(rebuilt), rebuilt.bodyPanels).flatMap(surface => surface.fittings().details);
  assert(visible.some(d => d.kind === detail.kind && Math.abs(d.x - before.x) < 1e-8 && Math.abs(d.y - before.y) < 1e-8));
  const raised = structuredClone(admitted);
  for (const n of raised.nodes.filter(n => [plate.a, plate.b].includes(n.id))) n.y -= 2;
  assert.deepEqual(detailPose(hostForDetail(editableDetailHosts(compileBlueprint(raised)), detail), detail), before);
  assert.deepEqual(parseBlueprint(serializeBlueprint(admitted)), validateBlueprint(admitted));
});

test('details use the actual host frame, including component reflection and off-surface selection', () => {
  const b = compileBlueprint(createConstruction('supply')), hosts = editableDetailHosts(b),
    body = hosts.find(h => h.surface === 'body'), part = hosts.find(h => h.surface === 'part' && h.host === 'supply'),
    chassis = hosts.find(h => h.surface === 'chassis');
  for (const host of [body, part, chassis]) {
    assert(host?.polygon.length >= 3);
    const point = { x: host.pose.x + .05, y: host.pose.y }, detail = detailAt(host, point, 'marker', 'chosen'), pose = detailPose(host, detail);
    near(pose.x, point.x); near(pose.y, point.y); near(pose.angle, 0); assert.equal(pose.mirrored, false);
    assert.equal(detailCorners(host, detail).length, 4);
  }
  assert.equal(detailHostAt(hosts, { x: part.pose.x, y: part.pose.y }).host, 'supply');
  const engine = hosts.find(h => h.host === 'engine');
  assert.equal(detailHostAt(hosts, engine.pose).surface, 'body', 'hidden internals do not steal exterior clicks');
  assert.equal(detailHostAt(editableDetailHosts(b, false), engine.pose).host, 'engine', 'cutaway makes internals editable');
  const detail = detailAt(body, { x: 40, y: 20 }, 'cab-door', 'off-surface');
  assert.equal(pickDetail(hosts, [detail], { x: 40, y: 20 }), null);
});

test('a plate shared by two rooms carries clipped details on both', () => {
  // Two rooms side by side, the wall between them standing on the floor and under the roof, which meet it at its ends.
  const points = [[0, 2], [0, 0], [-4, 2], [4, 2], [4, 0], [-4, 0]],
    source = { version: 10, preset: 'bunker', nodes: points.map(([x, y], i) => ({ id: `n${i}`, x: x * 20, y: y * 20 })),
      plates: [[0, 1], [2, 0], [0, 3], [3, 4], [4, 1], [1, 5], [5, 2]].map(([a, b], i) => ({
        id: i ? `wall-${i}` : 'shared-wall', a: `n${a}`, b: `n${b}`, material: 'steel', thicknessMm: 20 })), components: [],
      appearance: { paint: '#68765a', details: [-1, 1].map((y, i) => ({ id: `mark-${i}`, kind: 'marker', surface: 'body',
        host: 'shared-wall', x: 0, y, angle: 0, width: .07, height: .04 })) } },
    blueprint = compileBlueprint(source), surfaces = bodyPanelSurfaces(designFrame(blueprint), blueprint.bodyPanels);
  assert.equal(blueprint.rooms.length, 2);
  for (const surface of surfaces) assert.equal(surface.fittings().details.length, 2, 'each backing clips the shared stamps to its own real room');
});

test('cosmetic drag retains physical projection and manufacture review, commits once and supports undo/export/reload', () => {
  const editor = new Editor(createConstruction('truck')), original = structuredClone(editor.source), physical = editor.blueprint;
  editor.reviewManufacture(); const review = editor.compiled.manufacture, events = [];
  const validate = editor.validateConstruction.bind(editor); let admissions = 0;
  editor.validateConstruction = source => { admissions++; return validate(source); };
  editor.onchange = event => events.push(event.kind);
  for (let i = 0; i < 40; i++) {
    editor.previewAppearance({ ...editor.source.appearance, details: editor.source.appearance.details.map((d, k) => k ? d : { ...d, x: i / 100 }) });
    assert.equal(editor.blueprint.modules, physical.modules); assert.equal(editor.blueprint.rooms, physical.rooms);
    assert.equal(editor.compiled.manufacture, review);
  }
  assert.equal(admissions, 0); assert.equal(editor.past.length, 0);
  assert(editor.commit()); assert.equal(admissions, 1); assert.equal(events.filter(kind => kind === 'document').length, 1);
  const edited = structuredClone(editor.source); assert.deepEqual(parseBlueprint(serializeBlueprint(edited)), edited);
  assert(editor.undo()); assert.deepEqual(editor.source, original); assert(editor.redo()); assert.deepEqual(editor.source, edited);
  editor.change(source => { source.appearance = { ...source.appearance, paint: '#889966' }; });
  assert.deepEqual(editor.source.appearance.details, edited.appearance.details, 'repainting preserves the cosmetic layer');
});

test('the actual detail pointer gesture reattaches to cargo without moving physical pieces and cancellation restores it', () => {
  const editor = new Editor(createConstruction('supply')), original = structuredClone(editor.source), physics = editor.blueprint.modules,
    detail = editor.source.appearance.details[0], host = hostForDetail(editableDetailHosts(editor.blueprint), detail), start = detailPose(host, detail),
    cargo = editor.blueprint.modules.find(p => p.kind === 'supply'), errors = [], view = { mode: 'edit', exterior: true },
    controller = Object.assign(Object.create(DetailEditor.prototype), { editor: () => editor, view, enabled: true,
      canvas: { setPointerCapture() {}, hasPointerCapture: () => false, style: {} }, at: event => event.point, renderer: { board: { camera: { zoom: 100 } } },
      toast: message => errors.push(message), render() { this.syncSelection(); } }),
    // Shift: free of the lines a moved detail settles on, so that it goes exactly where it is taken.
    event = (type, point) => ({ type, point, pointerId: 1, button: 0, shiftKey: true, preventDefault() {}, stopImmediatePropagation() {} });
  controller.pointer(event('pointerdown', start));
  controller.pointer(event('pointermove', cargo));
  assert.equal(controller.picked.host, 'supply'); assert.equal(controller.picked.surface, 'part');
  assert.equal(editor.blueprint.modules, physics); assert.equal(editor.past.length, 0);
  near(detailPose(hostForDetail(controller.hosts, controller.picked), controller.picked).x, cargo.x);
  controller.pointer(event('pointercancel', cargo)); assert.deepEqual(editor.source, original);
  controller.pointer(event('pointerdown', start)); controller.pointer(event('pointermove', cargo)); controller.pointer(event('pointerup', cargo));
  assert.equal(editor.past.length, 1); assert.deepEqual(editor.blueprint.modules, physics); assert.deepEqual(errors, []);
  assert(editor.undo()); assert.deepEqual(editor.source, original);
});

test('cold detail groups retain their key and arrays for all visible parts and cropped machine pictures', t => {
  const source = createConstruction('grader'), b = compileBlueprint(source), tool = b.modules.find(p => p.kind === 'blade'),
    hosts = editableDetailHosts(b), host = hosts.find(h => h.host === tool.id), detail = detailAt(host, tool, 'marker', 'blade-mark');
  source.appearance.details.push(detail); const compiled = compileBlueprint(source), state = designFrame(compiled), actor = state.actors[0],
    renderer = new Renderer({}, { mode: 'edit' }), requests = [];
  renderer.scene = sampleScene(state); renderer.texturePainter = { available: false };
  const original = renderer.progressiveTexture.bind(renderer);
  renderer.progressiveTexture = (key, describe, options) => original(key, () => { const request = describe(); requests.push(request); return request; }, options);
  t.after(() => { for (const entry of renderer.textures.values()) entry.texture.destroy(true); });
  const group = detailGroup(actor.appearance, 'part', tool.id);
  assert.equal(detailGroup(actor.appearance, 'part', tool.id), group);
  for (const part of [undefined, 'frame', 'assembly']) {
    const module = { ...tool, actorId: 'local', part, ...(part === 'assembly' ? { crop: { x: .2, y: .1, W: tool.width, H: tool.height } } : {}) };
    for (let i = 0; i < 30; i++) renderer.moduleTexture(module);
  }
  assert.equal(requests.length, 3, 'one cached picture for each real machine part');
  for (const request of requests) assert.equal(request.options.details, group.details);
});

for (const facing of [-1, 1]) test(`the field carries the same body details while driving facing ${facing}; cold appearance is not resent with motion`, t => {
  const source = createConstruction('truck'), compiled = compileBlueprint(source), host = editableDetailHosts(compiled).find(h => h.surface === 'chassis');
  source.appearance.details.push(detailAt(host, host.pose, 'number', 'chassis-number'));
  source.appearance.automaticDetails = false;
  const world = miningWorld(source, { facing, direction: facing, grade: 0, cargo: null });
  t.after(() => world.dispose());
  const first = structuredClone(world.snapshot()), [surface] = bodyPanelSurfaces(first), scene = surface.fittings(),
    writer = new FrameWriter(), reader = new FrameReader(), packet = state => ({ type: 'frame', state, events: [], profile: {} });
  assert.equal(scene.details.filter(d => d.kind === 'armour-door').length, 1);
  assert.equal(scene.seed, 'authored', 'instance identity does not defeat sharing identical manual finishes');
  assert.equal(scene.details.find(d => d.kind === 'armour-door').mirrored, facing > 0);
  const sampled = sampleScene(first), actor = first.actors[0], parts = sampled.frame.actorParts.get(actor.id), frame = chassisFrame(parts),
    place = chassisPlacement(sampled.pose(frame.id), frame.data.definition.chassis, actor.vehicle.angle),
    at = detailInBasis(plateDetails(parts, actor, 'chassis', part => sampled.pose(part.id))[0], place);
  near(at.angle, 0, 'the chassis number stays upright in its cached picture for either facing');
  assert.equal(at.mirrored, false, 'the actor mirror is applied by the chassis container only once');
  const whole = writer.encode(packet(first), true), decoded = reader.decode(whole);
  const networkDetails = decoded.state.actors[0].appearance.details;
  assert.equal(decoded.state.actors[0].appearance.automaticDetails, false);
  assert.equal(networkDetails.length, source.appearance.details.length);
  for (let i = 0; i < networkDetails.length; i++) {
    assert.equal(networkDetails[i].host, source.appearance.details[i].host);
    near(networkDetails[i].angle, source.appearance.details[i].angle);
  }
  world.controlVehicle(facing, 0); for (let i = 0; i < 60; i++) world.step();
  const next = world.snapshot(), [nextSurface] = bodyPanelSurfaces(next), details = nextSurface.fittings().details;
  const halfway = sampleScene(next, first, .5), moving = next.actors[0], halfParts = halfway.frame.actorParts.get(moving.id), halfFrame = chassisFrame(halfParts),
    halfPlace = chassisPlacement(halfway.pose(halfFrame.id), halfFrame.data.definition.chassis, halfway.actor(moving.id).angle),
    halfAt = detailInBasis(plateDetails(halfParts, moving, 'chassis', part => halfway.pose(part.id), halfway.actor(moving.id))[0], halfPlace);
  near(halfAt.x, at.x, 'project chassis detail shares the interpolated body pose'); near(halfAt.y, at.y);
  for (let i = 0; i < details.length; i++) {
    near(details[i].x, scene.details[i].x, 'local rigid x'); near(details[i].y, scene.details[i].y, 'local rigid y');
  }
  const delta = writer.encode(packet(next)); reader.decode(delta);
  assert(delta.byteLength < whole.byteLength / 2, 'only motion changes; appearance stays cold');
  assert.deepEqual(reader.state.actors[0].appearance.details, networkDetails);
});

test('thirty-two stamps compose into a bounded existing host texture, with clipping and no new GPU sprites or frame-time painting', t => {
  const renderer = new Renderer({}, { mode: 'edit' }); renderer.texturePainter = { available: false };
  t.after(() => { for (const entry of renderer.textures.values()) entry.texture.destroy(true); });
  const b = compileBlueprint(createConstruction('truck')), [surface] = bodyPanelSurfaces(designFrame(b), b.bodyPanels),
    scene = surface.fittings(), details = Array.from({ length: DETAIL_LIMIT }, (_, i) => ({ ...scene.details[0], x: 9 + i * .03 })),
    shape = hullArtwork(surface.artPolygon, surface.paint, 'outside', JSON.stringify(details)),
    request = { type: 'hull', shape, layout: hullLayout(surface.artPolygon, { ...scene, details }), options: { paint: surface.paint } };
  let descriptions = 0;
  const first = renderer.progressiveTexture(shape.key, () => { descriptions++; return request; });
  assert(first.texture.source.resource.width <= 1536); assert(first.texture.source.resource.height <= 768);
  for (let i = 0; i < 60; i++) assert.equal(renderer.progressiveTexture(shape.key, () => { descriptions++; return request; }).texture, first.texture);
  assert.equal(descriptions, 1); assert.equal(renderer.textures.size, 1);
  const ctx = document.createElement('canvas').getContext('2d'), operations = [];
  ctx.canvas.width = 800; ctx.canvas.height = 200;
  ctx.clip = () => operations.push('clip'); ctx.drawImage = () => operations.push(ctx.globalCompositeOperation);
  paintAuthoredDetails(ctx.canvas, { left: 0, bottom: 0, width: 4, height: 1, polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 1 }] }, details, surface.paint);
  assert.equal(operations.filter(op => op === 'clip').length, DETAIL_LIMIT);
  assert.equal(operations.filter(op => op === 'source-atop').length, DETAIL_LIMIT);
});
