import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileDraftConstruction, createStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { CHASSIS_MODELS, SKID_LEG, chassisLabel, chassisAxles, chassisSkids, chassisTrack, chassisGearSize, chassisSpec, frameThicknessMm, skidRange,
  straightChassis, suspensionHeight, suspensionZero, withTrackSpan } from '../src/chassis.ts';
import { CHASSIS_ID, FIXED, bedStretches, chassisPointRange, withChassisModel, withChassisPoint, withChassisSuspension, withConstructionKind } from '../src/chassis-editing.ts';
import { workshopChecklist } from '../src/workshop-checklist.ts';
import { stretchKey } from '../src/frame-points.ts';
import { LIMITS } from '../src/structured-editing.ts';
import { applySettings, kindChoices, chassisMetalChoices, selectionSettings, steppedSettings, typedSetting, typedSettings } from '../src/piece-settings.ts';
import { CELL, cellOf } from '../src/grid.ts';
import { VEHICLE_ORIGIN } from '../src/vehicle.ts';

await initNativeDynamics();

// Keep gesture coordinates independent of changes to the public truck recipes. This is an ordinary editable project,
// captured before the truck-family redesign; other scenarios use the current factory models.
const EDITOR_CHASSIS = JSON.parse(readFileSync(new URL('./fixtures/editor-chassis.json', import.meta.url), 'utf8'));
// An end given as `front` or `rear` (in cells, grid.ts) moves the first or the last point of its straight chassis.
// The construction is then hung where its model hangs it, as an edit in the Oficina keeps it.
const authored = (template, { front, rear, ...chassis } = {}, components = []) => {
  const source = template === 'chassis' ? structuredClone(EDITOR_CHASSIS) : createStructuredTemplate(template), { points } = source.chassis,
    ends = front === undefined && rear === undefined ? {} : { points: [{ x: front ?? points[0].x, y: points[0].y }, { x: rear ?? points.at(-1).x, y: points.at(-1).y }] };
  return validateStructuredConstruction(withChassisSuspension({ ...source, chassis: { ...source.chassis, ...ends, ...chassis },
    components: [...source.components, ...components] }, 0));
};
// A straight chassis where its model hangs its gear, as a construction put on wheels or tracks starts.
const hung = chassis => ({ ...chassis, points: chassis.points.map(point => ({ ...point, y: suspensionZero(chassis) })) });
const hopper = (x = 34, y = 10) => ({ id: 'hopper', kind: 'hopper', pose: { x, y, angle: 0 } });
// Keep this material-limit fixture clear of the independent chassis/armour intersection check.
const elevatedConcretePost = () => {
  const source = createStructuredTemplate('guard-post');
  return { ...source, nodes: source.nodes.map(node => ({ ...node, y: node.y + 40 })),
    components: source.components.map(part => ({ ...part, pose: { ...part.pose, y: part.pose.y + 40 } })) };
};
// One whole drag of an end of the chassis, kept: taken where it is and dropped over `x`, in the field, as high as it was.
function stretch(editor, end, x) {
  const hit = editor.pickChassisPoint(editor.chassisPoints().at(end === 'front' ? 0 : -1), 1e-6);
  editor.begin(); const went = editor.moveChassisPoint(hit, { x, y: hit.y }); editor.commit();
  return went;
}
const module = (editor, id) => editor.blueprint.modules.find(candidate => candidate.id === id);
// One whole drag of a grip of the gear, kept: taken where it is and dropped over `x`, in the field.
function shift(editor, key, x) {
  const hit = editor.gearHandle(key);
  editor.begin(); const went = editor.moveGear(hit, { x, y: hit.y }); editor.commit();
  return went;
}
// The settings the bar of the chassis selected shows, as it reads them.
const chassisSettings = editor => { editor.select(CHASSIS_ID); return selectionSettings([{ piece: editor.selected, part: editor.source.chassis }], { snap: editor.snap }); };

test('the chassis is one piece: any part of it picks it, and it is neither copied nor removed', () => {
  const editor = new Editor(authored('heavy')), deck = editor.blueprint.chassis.deck;
  assert.equal(editor.pick({ x: 12, y: deck - .3 }), CHASSIS_ID, 'the track');
  const selected = editor.selectBox({ x: 8, y: 0 }, { x: 16, y: deck + .1 });
  assert.equal(selected.filter(id => id === CHASSIS_ID).length, 1, 'a box over the whole chassis takes its frame once');
  assert(selected.includes(CHASSIS_ID));
  editor.select(CHASSIS_ID);
  assert.equal(editor.selected.chassis.model, 'tracked');
  assert.equal(editor.duplicate(), undefined); editor.remove();
  assert.equal(editor.past.length, 0); assert.equal(editor.selection, CHASSIS_ID);
  // Its grips stand on its two points, at its ends, halfway down from the deck to the foot of the frame: at the front
  // of the tub, halfway down its nose.
  const [front, rear] = editor.chassisPoints(), { depth } = editor.blueprint.chassis;
  assert.deepEqual([front.end, front.top.x, rear.end, rear.top.x, rear.x], ['front', 8.5, 'rear', 15.5, 15.5]);
  assert(Math.abs(front.foot.x - (8.5 + depth)) < 1e-9 && Math.abs(front.x - (8.5 + depth / 2)) < 1e-9);
  assert.equal(front.y, (front.top.y + front.foot.y) / 2);
});

test('an end of the chassis dragged rests on the grid, within the lengths of its model and the limit of construction', () => {
  // A reinforced frame can extend to the construction bounds while keeping its support count.
  const source = authored('tanker', { thicknessMm: 100 }), editor = new Editor(source), cistern = module(editor, 'cistern').x;
  assert.equal(editor.source.chassis.model, 'wheeled'); assert.equal(editor.source.chassis.points.at(-1).x - editor.source.chassis.points[0].x, 160);
  assert.deepEqual([chassisPointRange(editor.source, 1).minX, chassisPointRange(editor.source, 1).maxX], [-30, 120]);
  assert.equal(stretch(editor, 'rear', 12 + 4.32), true);
  assert.deepEqual(editor.source.chassis, { ...source.chassis, points: [source.chassis.points[0], { x: 86, y: source.chassis.points[1].y }] });
  assert.equal(editor.blueprint.chassis.length, 8.3);
  // Past the limit of construction it stops there, and says which limit it was.
  assert.equal(stretch(editor, 'rear', 40), false);
  assert.equal(editor.source.chassis.points.at(-1).x, 120); assert.equal(editor.blockedEdit.message, LIMITS.reach);
  // Both ends can reach the construction bounds without changing its supports.
  assert.equal(stretch(editor, 'front', -40), false);
  assert.deepEqual(editor.source.chassis, { ...source.chassis, points: [{ x: -120, y: source.chassis.points[0].y }, { x: 120, y: source.chassis.points[1].y }] });
  assert.equal(editor.blueprint.chassis.length, 12);
  assert.equal(editor.blockedEdit.message, LIMITS.reach);
  // What stands on the bed keeps its place on the field; each drag is one edit.
  assert(Math.abs(module(editor, 'cistern').x - cistern) < 1e-6);
  assert.equal(editor.past.length, 3); editor.undo(); editor.undo(); editor.undo();
  assert.deepEqual(editor.source, source);
});

test('a horizontal chassis drag preserves the tracked deck height between grid lines', () => {
  const editor = new Editor(createStructuredTemplate('tracked')), before = editor.source.chassis.points.map(point => point.y);
  assert.equal(stretch(editor, 'rear', 15.5), true);
  assert.deepEqual(editor.source.chassis.points.map(point => point.y), before,
    'snapping horizontal movement must not introduce vertical movement of the stable profile');
});

test('shortening a chassis leaves overhanging hull geometry and explicit equipment poses unchanged', () => {
  const ahead = new Editor(authored('chassis', { front: -70 })), before = ahead.source;
  assert.equal(stretch(ahead, 'front', 12 - 2.3), true);
  assert.equal(ahead.source.chassis.points[0].x, -46);
  assert.deepEqual(ahead.source.nodes, before.nodes);
  assert.deepEqual(ahead.source.components, before.components);
  assert.equal(ahead.blockedEdit, null);
  assert.equal(ahead.past.length, 1);
  const loaded = new Editor(authored('chassis', { rear: 66 }, [hopper()])), x = module(loaded, 'hopper').x,
    pose = structuredClone(loaded.source.components.find(part => part.id === 'hopper').pose);
  assert.equal(stretch(loaded, 'rear', 12 + 2.3), true);
  assert.equal(loaded.source.chassis.points.at(-1).x, 46);
  assert(Math.abs(module(loaded, 'hopper').x - x) < 1e-6);
  assert.deepEqual(loaded.source.components.find(part => part.id === 'hopper').pose, pose);
  assert(loaded.undo());
  assert.equal(loaded.source.chassis.points.at(-1).x, 66);
});

test('gap geometry is editable while material-dependent structural limits still block manufacturing', () => {
  const y = cellOf(chassisSpec('wheeled').deck - 1.3),
    points = [-48, -28, -8, 48].map(x => ({ x, y })), source = authored('scout', { points });
  // A stretch removed is a gap, and the gap removed is chassis again; it stays selected.
  const editor = new Editor(source), gapped = target => { target.select(stretchKey(1)); target.remove(); };
  gapped(editor);
  assert.deepEqual(editor.source.chassis.points[1], { ...source.chassis.points[1], gap: true });
  assert.deepEqual(editor.blueprint.chassis.segments.map(segment => segment.gap), [false, true, false]);
  assert.deepEqual([...editor.selectionIds], [stretchKey(1)]); assert.equal(editor.past.length, 1);
  gapped(editor); assert.deepEqual(editor.source.chassis, source.chassis);
  // An end stretch stays chassis, as the compiler says.
  editor.select(stretchKey(0)); assert.throws(() => editor.remove(), /Um vão fica entre dois trechos/); assert.deepEqual(editor.source.chassis, source.chassis);
  // The draft remains editable; ceramic still cannot carry structural load over a gap.
  const brittle = new Editor(validateStructuredConstruction({ ...source, plates: source.plates.map(plate => ({ ...plate, material: 'ceramic' })) }));
  gapped(brittle);
  assert.equal(brittle.blueprint.mechanicalAdmission, false);
  assert(brittle.blueprint.admissionIssues.some(issue => issue.code === 'CHASSIS_GAP_OPEN'));
  assert.throws(() => validateStructuredConstruction(brittle.source), { reason: 'CHASSIS_GAP_OPEN' });
  assert.equal(brittle.source.chassis.points[1].gap, true); assert.equal(brittle.past.length, 1);
  assert(brittle.undo()); assert.deepEqual(brittle.source.chassis, source.chassis);
});

test('changing running kind preserves shape and chosen resources even when capacity becomes pending', () => {
  const template = createStructuredTemplate('heavy'), tracked = { ...template,
    chassis: { model: 'tracked', points: template.chassis.points, armorMm: 60 } };
  assert.equal(withChassisModel(tracked, 'tracked'), tracked);
  // The suspension stays as high as it was: the whole construction goes up or down by what the other model hangs.
  const kept = (before, after, expected) => {
    const lift = after.chassis.points[0].y - before.chassis.points[0].y;
    assert.deepEqual(after.chassis, { ...expected, points: expected.points.map(point => ({ ...point, y: point.y + lift })) });
    assert.equal(suspensionHeight(after.chassis), suspensionHeight(before.chassis));
    assert(after.nodes.every((node, i) => node.y === before.nodes[i].y + lift && node.x === before.nodes[i].x));
  };
  kept(tracked, withChassisModel(tracked, 'wheeled'), { model: 'wheeled', points: template.chassis.points, armorMm: 60, thicknessMm: 20 });
  const light = { ...tracked, chassis: { model: 'wheeled', points: [{ x: -20, y: 0 }, { x: 50, y: 0 }] } };
  kept(light, withChassisModel(light, 'tracked'), { model: 'tracked', points: [{ x: -20, y: 0 }, { x: 50, y: 0 }], thicknessMm: 8 });
  const editor = new Editor(createStructuredTemplate('tanker')), cistern = module(editor, 'cistern').x, before = editor.source;
  assert.equal(editor.setConstructionKind('wheeled'), false);
  assert.equal(editor.source, before); assert.equal(editor.past.length, 0);
  assert.equal(editor.setConstructionKind('tracked'), true);
  assert.equal(editor.source.chassis.axles, undefined);
  assert.equal(frameThicknessMm(editor.source.chassis), frameThicknessMm(before.chassis));
  assert.equal(editor.selection, CHASSIS_ID); assert.equal(editor.past.length, 1);
  assert(Math.abs(module(editor, 'cistern').x - cistern) < 1e-6);
  assert.equal(editor.setConstructionKind('tracked'), false); assert.equal(editor.past.length, 1);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  // A heavy hull can be designed on two wheels without gaining other supports.
  const heavy = new Editor(createStructuredConstruction({ length: 7, height: 2.2, thicknessMm: 150, chassis: 'tracked' })), heavyBefore = heavy.source;
  assert.equal(heavy.setConstructionKind('wheeled'), true);
  assert.equal(heavy.source.chassis.model, 'wheeled');
  assert.equal(frameThicknessMm(heavy.source.chassis), frameThicknessMm(heavyBefore.chassis));
  assert.equal(chassisAxles(heavy.source.chassis).length, 2);
  assert.equal(heavy.blueprint.mechanicalAdmission, false);
  // Hung as high over its wheels as it was over its track, the hull goes up with its chassis, its shape as it was.
  const lift = heavy.source.chassis.points[0].y - heavyBefore.chassis.points[0].y;
  assert(heavy.source.nodes.every((node, i) => node.x === heavyBefore.nodes[i].x && node.y === heavyBefore.nodes[i].y + lift));
  assert.deepEqual(heavy.source.plates, heavyBefore.plates);
  assert.equal(heavy.past.length, 1); assert(heavy.undo()); assert.deepEqual(heavy.source, heavyBefore);
  const armoured = new Editor(validateStructuredConstruction(tracked)), armouredBefore = armoured.source;
  assert.throws(() => armoured.setConstructionKind('wheeled'), /A blindagem da rodagem deste chassi vai até 40 mm/);
  assert.equal(armoured.source, armouredBefore); assert.equal(armoured.past.length, 0);
});

test('running-kind choices report structural capacity and retain the concrete material limit', () => {
  const choices = kindChoices(createStructuredTemplate('heavy'));
  assert.deepEqual(choices.map(choice => [choice.id, choice.name]), [...Object.keys(CHASSIS_MODELS).map(id => [id, chassisLabel(id)]), [FIXED, 'Fixa']]);
  for (const choice of choices) {
    assert(!/leve|médio|pesado|até [\d,]+ t/.test(choice.name + ' ' + choice.detail));
    assert(choice.detail.length > 0); assert(!choice.disabled);
    if (choice.id !== FIXED) assert.match(choice.detail, /Cheio: .*limite:/);
  }
  // Concrete remains a material limit; equipment no longer requires a chassis bed.
  const post = kindChoices(elevatedConcretePost());
  assert.deepEqual(post.map(choice => [choice.id, Boolean(choice.disabled)]), [['wheeled', true], ['tracked', true], ['aircraft', true], [FIXED, false]]);
  assert.match(post[0].detail, /Concreto só serve numa construção fixa/);
  const truck = kindChoices(createStructuredTemplate('truck')).find(choice => choice.id === FIXED);
  assert(!truck.disabled); assert.match(truck.detail, /Sem chassi/);
});

test('changing between fixed and mobile preserves authored geometry and equipment poses', () => {
  const heavy = new Editor(createStructuredTemplate('heavy')), before = heavy.source;
  assert.equal(heavy.setConstructionKind(FIXED), true);
  const fixed = heavy.source;
  assert.equal(fixed.preset, 'bunker'); assert.equal(fixed.chassis, undefined); assert.equal(fixed.rideHeight, undefined);
  assert.deepEqual([fixed.nodes, fixed.plates, fixed.components], [before.nodes, before.plates, before.components]);
  assert.equal(heavy.blueprint.vehicle.enabled, false); assert.equal(heavy.selection, null);
  // What only a vehicle uses is pointed out, not refused.
  const told = workshopChecklist(heavy.blueprint).find(item => item.id === 'fixed');
  assert.equal(told.state, 'attention'); assert.equal(told.detail, 'Motor e combustível não servem numa construção fixa sem escavadeira ou perfuratriz.');
  assert.equal(heavy.setConstructionKind(FIXED), false); assert.equal(heavy.past.length, 1);
  // Running gear starts where its model hangs it, without moving the existing hull.
  assert.equal(heavy.setConstructionKind('tracked'), true);
  assert.deepEqual(heavy.source.chassis, hung(straightChassis('tracked', before.chassis.points[0].x, before.chassis.points.at(-1).x)));
  assert.deepEqual([heavy.source.nodes, heavy.source.plates, heavy.source.components], [before.nodes, before.plates, before.components]);
  assert.equal(heavy.source.rideHeight, undefined); assert.equal(heavy.selection, CHASSIS_ID);
  assert(heavy.undo() && heavy.undo()); assert.deepEqual(heavy.source, before);
  // A floor shorter than the model is made centres the shortest chassis under it, on the grid.
  const empty = createStructuredTemplate('empty'), wheeled = withConstructionKind(empty, 'wheeled');
  assert.deepEqual(wheeled.chassis, hung(straightChassis('wheeled', -54, 54)));
  const short = { ...empty, nodes: empty.nodes.map(node => ({ ...node, x: node.x / 3 })) };
  assert.deepEqual(withConstructionKind(short, 'tracked').chassis, hung(straightChassis('tracked', -30, 30)));
  // A truck can also become fixed without deleting equipment that had stood outside its hull.
  const truck = new Editor(createStructuredTemplate('truck')), loaded = truck.source;
  assert.equal(truck.setConstructionKind(FIXED), true);
  assert.deepEqual(truck.source.components, loaded.components); assert.equal(truck.past.length, 1);
  assert(truck.undo()); assert.deepEqual(truck.source, loaded);
  const post = new Editor(elevatedConcretePost());
  assert.throws(() => post.setConstructionKind('wheeled'), /Concreto só serve numa construção fixa/); assert.equal(post.past.length, 0);
});

test('a hull endpoint dragged takes the plates ending at it only, without fitting the chassis or moving equipment', () => {
  const source = authored('heavy'), editor = new Editor(source), origin = structuredClone(editor.blueprint.frame.origin),
    node = id => editor.nodes().find(candidate => candidate.id === id), drag = (id, to) => {
      const hit = editor.pickNode(node(id), 1e-6); editor.begin(); const moved = editor.moveNode(hit, to); editor.commit(); return moved;
    };
  const roof = source.plates.find(plate => plate.id === 'hull:roof'), sharing = source.plates.filter(plate => [plate.a, plate.b].includes(roof.a));
  assert(sharing.length > 1, 'the corner is shared');
  const corner = node(roof.a);
  assert.equal(drag(roof.a, { x: corner.x + 1, y: corner.y + .5 }), true);
  const endpoint = editor.source.nodes.find(candidate => candidate.id === roof.a);
  assert(endpoint.x > source.chassis.points.at(-1).x, 'the endpoint may extend beyond the unchanged chassis');
  assert(endpoint.y > source.nodes.find(candidate => candidate.id === roof.a).y);
  assert.deepEqual(editor.source.plates, source.plates, 'every plate still ends at the one point it shared');
  assert.deepEqual(editor.source.nodes.filter(candidate => candidate.id !== roof.a), source.nodes.filter(candidate => candidate.id !== roof.a));
  assert.deepEqual(editor.source.chassis, source.chassis);
  assert.deepEqual(editor.source.components, source.components);
  assert.deepEqual(editor.blueprint.frame.origin, origin);
  assert.equal(editor.blockedEdit, null);
  assert.equal(editor.past.length, 1);
  assert(editor.undo()); assert.deepEqual(editor.source, source);
});

for (const snap of [false, true]) test(`the bed draws a detached room without rewriting existing plates with grid assistance ${snap ? 'on' : 'off'}`, () => {
  const editor = new Editor(authored('chassis')); editor.snap = snap;
  const stretches = bedStretches(editor.blueprint),
    free = stretches.find(stretch => stretch.x0 < 13.2 && stretch.x1 > 13.2);
  assert(free);
  const bed = editor.pickBed({ x: 13.2, y: free.y }), before = editor.source;
  assert(bed);
  editor.begin();
  const room = editor.drawRoom(bed, { x: 13.2, y: bed.a.y }, { x: 13.2, y: bed.a.y + 1.213 });
  assert(room); assert.equal(editor.commit(), true);
  const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`), depth = snap ? 1.2 : 1.213;
  // Continuous endpoints are compared in physical space; 1.8 m minus an origin can differ by one ulp.
  near(room.length, 1.8); near(room.depth, depth);
  const [a, highA, highB, b] = room.polygon;
  near(Math.hypot(b.x - a.x, b.y - a.y), 1.8);
  near(Math.hypot(highB.x - highA.x, highB.y - highA.y), 1.8);
  for (const [foot, top] of [[a, highA], [b, highB]]) { near(top.x, foot.x); near(top.y - foot.y, depth); }
  assert.equal(editor.blueprint.rooms.length, 2);
  assert.deepEqual(editor.source.plates.filter(plate => before.plates.some(old => old.id === plate.id)), before.plates);
  assert.deepEqual(editor.source.components, before.components);
  assert.equal(editor.past.length, 1); assert(editor.undo()); assert.deepEqual(editor.source, before);
});

test('removing a cab preserves its equipment and a separately drawn room', () => {
  const editor = new Editor(authored('chassis')), free = bedStretches(editor.blueprint).find(stretch => stretch.x0 < 13.2 && stretch.x1 > 13.2),
    bed = editor.pickBed({ x: 13.2, y: free.y }), components = structuredClone(editor.source.components);
  editor.begin(); const room = editor.drawRoom(bed, { x: 13.2, y: bed.a.y }, { x: 13.2, y: bed.a.y + 1.2 }); editor.commit();
  assert(room);
  assert.equal(editor.removeRoom('hull:roof'), 1);
  assert.deepEqual(editor.source.plates.map(plate => plate.id).sort(), [...room.plates].sort());
  assert.equal(editor.blueprint.rooms.length, 1);
  assert.deepEqual(editor.source.components, components);
});

test('an axle drag moves in grid steps within frame and neighbour bounds, and reports what held it', () => {
  // The factory chassis is 5.4 m long on three explicitly authored axles, with 1.1 m tyres.
  const source = authored('chassis'), editor = new Editor(source);
  assert.deepEqual(editor.chassisGear().map(({ key, x, y }) => [key, x, y]),
    // The middle axle is written on the cell nearest to the middle of the frame, a little ahead of it.
    [['axle-0', 10.25, .56], ['axle-1', 11.95, .56], ['axle-2', 13.7, .56]], 'a grip on the hub of each axle');
  assert.equal(shift(editor, 'axle-0', 10.03), true);
  assert.deepEqual(editor.source.chassis, { ...source.chassis, axles: [-39, -1, 34] });
  // Ahead, it stops with its wheel whole under the frame; back, 1.2 m from the next axle.
  assert.equal(shift(editor, 'axle-0', 8), false);
  assert.deepEqual(editor.source.chassis.axles, [-43, -1, 34]);
  assert.equal(editor.blockedEdit.message, 'Cada roda fica inteira embaixo do chassi, entre as pontas dele.');
  assert.deepEqual(editor.blockedEdit.ids, ['chassis:wheel-0']);
  assert.equal(shift(editor, 'axle-0', 13), false);
  assert.deepEqual(editor.source.chassis.axles, [-25, -1, 34]);
  assert.equal(editor.blockedEdit.message, 'Os eixos ficariam perto demais para esse tamanho de roda. Afaste os eixos ou reduza a rodagem.');
  assert.deepEqual(editor.blockedEdit.ids, ['chassis:wheel-0', 'chassis:wheel-1'], 'the axle it would come too near is shown too');
  // Each drag is one edit; undo restores the exact authored support positions.
  assert.equal(editor.past.length, 3); editor.undo(); editor.undo(); editor.undo();
  assert.deepEqual(editor.source, source);
  // Balance is a draft diagnostic, so the chosen axle can move behind the COM.
  const two = new Editor(source); applySettings(two, 'axleCount', new Map([[CHASSIS_ID, 2]]));
  assert.equal(shift(two, 'axle-0', 12.5), true);
  assert.deepEqual(two.source.chassis.axles, [10, 38]);
  assert.equal(two.blueprint.mechanicalAdmission, false);
  assert.equal(two.blockedEdit, null);
});

test('the axle bar keeps its range and undo while capacity follows the actual frame and supports', () => {
  const source = authored('chassis'), editor = new Editor(source), settings = chassisSettings(editor),
    axles = settings.find(setting => setting.key === 'axleCount'), armour = settings.find(setting => setting.key === 'armorMm');
  assert.deepEqual([axles.key, axles.label, axles.value, axles.min, axles.max, armour.key], ['axleCount', 'Eixos', 3, 2, 8, 'armorMm']);
  assert.deepEqual(chassisSettings(new Editor(createStructuredTemplate('tracked'))).map(setting => setting.key),
    ['frameThicknessMm', 'trackLength', 'trackHeight', 'trackX', 'suspension', 'armorMm', 'topPlateThicknessMm'],
    'a track exposes independent measures and the suspension over it, with no wheel-count, uniform resize or vertical place');
  const originalCapacity = editor.blueprint.chassis.limitKg;
  // One more: four axles do not fit where the model puts its first and last, and spread over the whole frame.
  applySettings(editor, 'axleCount', steppedSettings(chassisSettings(editor)[0], 1));
  assert.equal(chassisAxles(editor.source.chassis).length, 4);
  assert.equal(editor.blueprint.chassis.limitKg, Math.min(editor.blueprint.chassis.frameLimitKg, editor.blueprint.chassis.gearLimitKg));
  assert(editor.blueprint.chassis.limitKg > originalCapacity, 'the extra support increases this frame capacity');
  const atLimit = new Editor(authored('chassis', { front: -120, rear: 120,
    axles: Array.from({ length: 8 }, (_, i) => cellOf(-5.45 + i * 10.9 / 7)) }));
  assert.equal(steppedSettings(chassisSettings(atLimit)[0], 1).size, 0);
  assert.equal(chassisSettings(atLimit)[0].ends[1], 'O chassi de rodas leva no máximo 8 eixos.');
  // Two supports leave a longer unsupported span.
  applySettings(editor, 'axleCount', new Map([[CHASSIS_ID, 2]]));
  assert.deepEqual(chassisAxles(editor.source.chassis).map(x => Number(x.toFixed(9))), [-1.9, 1.9]);
  assert.equal(editor.blueprint.chassis.limitKg, Math.min(editor.blueprint.chassis.frameLimitKg, editor.blueprint.chassis.gearLimitKg));
  assert(editor.blueprint.chassis.limitKg < originalCapacity);
  assert.equal(editor.past.length, 2); editor.undo(); editor.undo();
  assert.deepEqual(editor.source, source);
  // Reducing the support count does not reinforce other physical properties.
  const heavySource = createStructuredConstruction({ thicknessMm: 80, chassis: 'wheeled' }),
    heavy = new Editor(validateStructuredConstruction({ ...heavySource, chassis: { ...heavySource.chassis, thicknessMm: 8, axles: [-42, -14, 14, 42] } })), before = heavy.source;
  assert.deepEqual(applySettings(heavy, 'axleCount', new Map([[CHASSIS_ID, 2]])).refused, []);
  assert.equal(chassisAxles(heavy.source.chassis).length, 2);
  assert.equal(heavy.blueprint.mechanicalAdmission, false);
  assert.equal(frameThicknessMm(heavy.source.chassis), frameThicknessMm(before.chassis));
  assert.equal(chassisGearSize(heavy.source.chassis), chassisGearSize(before.chassis));
  assert.deepEqual(heavy.source.plates, before.plates);
  assert.equal(heavy.past.length, 1); assert(heavy.undo()); assert.deepEqual(heavy.source, before);
});

test('track grips edit continuous length, place along the design and height with the belt on the floor, and undo the whole gesture', () => {
  const source = authored('tracked'), editor = new Editor(source), track = () => chassisTrack(editor.source.chassis),
    near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`),
    // The hull and all it carries, as many cells higher than in the source as `lift`.
    unchanged = (lift = 0) => assert.deepEqual([editor.source.nodes, editor.source.plates, editor.source.components, editor.source.chassis.points],
      [source.nodes.map(node => ({ ...node, y: node.y + lift })), source.plates,
        source.components.map(part => ({ ...part, pose: { ...part.pose, y: part.pose.y + lift } })),
        source.chassis.points.map(point => ({ ...point, y: point.y + lift }))]),
    floor = () => near(track().y - track().height / 2, original.y - original.height / 2),
    drag = (key, dx, dy) => {
      const hit = editor.gearHandle(key); editor.begin();
      const moved = editor.moveGear(hit, { x: hit.x + dx, y: hit.y + dy }); editor.commit(); return moved;
    };
  assert.deepEqual(editor.chassisGear().map(grip => grip.key), ['track-front', 'track-rear', 'track-position', 'track-height']);
  const original = track(); editor.snap = false;
  near(original.y - original.height / 2, .01 - VEHICLE_ORIGIN.y);
  assert(drag('track-rear', -.237, 0));
  near(track().front, original.front); near(track().rear, original.rear - .237);
  near(track().y, original.y); near(track().height, original.height); unchanged();
  const shorter = track();
  // The centre goes along the design only: a pull up or down moves nothing up or down.
  assert(drag('track-position', .07123, .04321));
  near(track().front, shorter.front + .07123); near(track().rear, shorter.rear + .07123);
  near(track().y, shorter.y); near(track().height, shorter.height); unchanged();
  const moved = track(), suspension = suspensionHeight(editor.source.chassis);
  // Its top, where the grip is, comes down as far as the pointer; its belt stays on the floor and the hull as high over it.
  for (const [dy, way] of [[-.1, -1], [.3378915, 1]]) {
    const before = track(), zero = suspensionZero(editor.source.chassis);
    assert(drag('track-height', 0, dy));
    near(track().height, before.height + dy); floor();
    near(track().front, moved.front); near(track().rear, moved.rear);
    assert.equal(suspensionHeight(editor.source.chassis), suspension);
    assert.equal(Math.sign(suspensionZero(editor.source.chassis) - zero), way, 'the hull goes as its model hangs it over this gear');
  }
  unchanged(suspensionZero(editor.source.chassis) - suspensionZero(source.chassis));
  assert.equal(editor.blueprint.chassis.limitKg, Math.min(editor.blueprint.chassis.frameLimitKg, editor.blueprint.chassis.gearLimitKg));
  assert.equal(editor.past.length, 4); while (editor.past.length) editor.undo();
  assert.deepEqual(editor.source, source);
  editor.snap = true;
  assert(drag('track-rear', -.237, 0));
  near(track().rear / CELL, Math.round(track().rear / CELL)); unchanged();
  const beyondFrame = editor.chassisPoints().at(-1).top.x + .1 - track().height / 2;
  assert.equal(shift(editor, 'track-rear', beyondFrame), false);
  assert.equal(editor.blockedEdit.message, 'A esteira fica embaixo do chassi, sem passar das pontas dele.');
  assert.deepEqual(editor.blockedEdit.ids, ['chassis:track']); unchanged();
  assert(track().rear <= editor.source.chassis.points.at(-1).x * CELL + 1e-9, 'the invalid request stops within the real frame');
});

// The smallest aircraft: a box of steel two and a half metres long on its frame, made an aircraft, standing over its
// skids where its model hangs them or as high as their legs need.
const smallAircraft = () => withConstructionKind(createStructuredConstruction({ length: 2.5, thicknessMm: 8 }), 'aircraft');

test('skid grips move a leg, an end of the runner and the skids whole along the design, on the floor, and say what holds them', () => {
  const source = smallAircraft(), editor = new Editor(source), skids = () => chassisSkids(editor.source.chassis),
    near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`),
    // The hull and all it carries, and the points of the chassis, where they were.
    unchanged = () => assert.deepEqual([editor.source.nodes, editor.source.plates, editor.source.components, editor.source.chassis.points],
      [source.nodes, source.plates, source.components, source.chassis.points]),
    told = message => { assert.equal(editor.blockedEdit.message, message); return editor.blockedEdit.ids; };
  assert.equal(source.chassis.skids, undefined, 'nothing is written of skids where the model puts them');
  // Its frame from 1.25 m ahead of the middle to as far behind: the runner from 30 cm in from its front to 10 cm in from its
  // rear, a leg 80 cm in from either end. Each grip stands on what it moves: the runner's on it, a leg's halfway up it.
  const grips = Object.fromEntries(editor.chassisGear().map(grip => [grip.key, grip])), origin = editor.blueprint.frame.origin.x,
    runner = editor.blueprint.chassis.skids;
  assert.deepEqual(Object.keys(grips), ['skid-front', 'skid-rear', 'skid-position', 'skid-leg-0', 'skid-leg-1']);
  near(grips['skid-front'].x - origin, -.95); near(grips['skid-rear'].x - origin, 1.15); near(grips['skid-position'].x - origin, .1);
  near(grips['skid-leg-0'].x - origin, -.45); near(grips['skid-leg-1'].x - origin, .45);
  assert(['skid-front', 'skid-rear', 'skid-position'].every(key => grips[key].y === runner.y));
  assert(grips['skid-leg-0'].y > runner.y + runner.tube / 2 && grips['skid-leg-0'].y < editor.blueprint.chassis.deck);
  // On the grid, a leg dragged 13 cm ahead rests on the nearest cell; the skids are written whole, nothing else moves.
  assert(shift(editor, 'skid-leg-0', grips['skid-leg-0'].x - .13));
  assert.deepEqual(editor.source.chassis.skids, { front: -19, rear: 23, legs: [-12, 9] }); unchanged();
  // Further ahead it stops 20 cm behind the front of the runner, and says why, the runner shown with it.
  assert.equal(shift(editor, 'skid-leg-0', editor.gearHandle('skid-leg-0').x - .5), false);
  near(skids().legs[0], -.75);
  assert.deepEqual(told('A perna da frente dos esquis fica em cima do patim, a pelo menos 20 cm das pontas dele: afaste a perna da ponta ou estique o patim.'),
    ['chassis:leg-0', 'chassis:skid-0']);
  // Back, past the other leg, it stops half a metre ahead of it: the two legs are shown.
  assert.equal(shift(editor, 'skid-leg-0', editor.gearHandle('skid-leg-0').x + 2), false);
  near(skids().legs[0], -.05); near(skids().legs[1], .45);
  assert.deepEqual(told('As pernas dos esquis ficam a pelo menos 50 cm uma da outra.'), ['chassis:leg-0', 'chassis:leg-1']);
  // The front of the runner goes as far as the front of the frame, and no further.
  assert.equal(shift(editor, 'skid-front', editor.gearHandle('skid-front').x - .5), false);
  near(skids().front, -1.25); assert.deepEqual(told('O patim dos esquis fica embaixo do chassi, sem passar das pontas dele.'), ['chassis:skid-0']);
  // Its rear comes in as far as 20 cm behind the rear leg.
  assert.equal(shift(editor, 'skid-rear', editor.gearHandle('skid-rear').x - 1), false);
  near(skids().rear, .65);
  told('A perna de trás dos esquis fica em cima do patim, a pelo menos 20 cm das pontas dele: afaste a perna da ponta ou estique o patim.');
  // Whole, the runner goes with both legs, by whole cells, as far as the frame lets the runner go.
  const before = skids();
  assert(shift(editor, 'skid-position', editor.gearHandle('skid-position').x + .1));
  near(skids().front, before.front + .1); near(skids().rear, before.rear + .1); near(skids().legs[0], before.legs[0] + .1); near(skids().legs[1], before.legs[1] + .1);
  assert(Object.values(editor.source.chassis.skids).flat().every(Number.isInteger));
  assert.equal(shift(editor, 'skid-position', editor.gearHandle('skid-position').x + 3), false);
  near(skids().rear, 1.25); near(skids().legs[1] - skids().legs[0], .5);
  assert.deepEqual(editor.blockedEdit.ids, ['chassis:skid-0', 'chassis:leg-0', 'chassis:leg-1']); unchanged();
  // Free of the grid, a leg goes where it is dragged, to the millimetre and less.
  editor.snap = false;
  const free = skids().legs[0] - .01234;
  assert(shift(editor, 'skid-leg-0', editor.gearHandle('skid-leg-0').x - .01234));
  near(skids().legs[0], free);
  // The drags it made are the edits it made, undone one by one to the design it was, with nothing written of its skids.
  while (editor.past.length) editor.undo();
  assert.deepEqual(editor.source, source);
});

test('skids are sized as wheels are: slim and light under the smallest aircraft, the hull raised over larger ones as far as their legs need', () => {
  const source = smallAircraft(), editor = new Editor(source), size = () => chassisSettings(editor).find(setting => setting.key === 'gearScale'),
    kg = () => editor.blueprint.chassis.frameKg, tube = () => editor.blueprint.chassis.skids.tube,
    legs = () => editor.blueprint.plates.find(plate => plate.id === CHASSIS_ID).chassis.skids.legs;
  assert.deepEqual([size().label, size().value, size().min, size().max, size().unit, size().step], ['Tamanho dos esquis', 100, 50, 150, '%', 5]);
  const model = kg(), placed = chassisSkids(source.chassis);
  applySettings(editor, 'gearScale', typedSettings(size(), '50'));
  assert.equal(editor.source.chassis.gearScale, .5);
  assert(Math.abs(tube() - .04) < 1e-12 && kg() < model, `${tube()} m · ${kg()} kg of ${model}`);
  assert.deepEqual(chassisSkids(editor.source.chassis).legs, placed.legs, 'the legs stand where they stood');
  assert.equal(steppedSettings(size(), -1).size, 0); assert.equal(size().ends[0], 'Esse é o menor tamanho dos esquis.');
  // As low over them as their legs let it, it is stood higher over larger ones, by as much as their legs need; over
  // slimmer ones it stays where it is.
  applySettings(editor, 'suspension', new Map([[CHASSIS_ID, skidRange(editor.source.chassis).min]]));
  const low = suspensionHeight(editor.source.chassis);
  applySettings(editor, 'gearScale', typedSettings(size(), '150'));
  assert(Math.abs(tube() - .12) < 1e-12 && kg() > model);
  assert.equal(suspensionHeight(editor.source.chassis), skidRange(editor.source.chassis).min);
  assert(suspensionHeight(editor.source.chassis) > low && legs().every(leg => leg.top - leg.foot >= SKID_LEG - 1e-9), JSON.stringify(legs()));
  const high = suspensionHeight(editor.source.chassis);
  applySettings(editor, 'gearScale', typedSettings(size(), '100'));
  assert.equal(suspensionHeight(editor.source.chassis), high);
  assert.equal(Object.hasOwn(editor.source.chassis, 'gearScale'), false, 'the size of the model is not written');
  while (editor.past.length) editor.undo();
  assert.deepEqual(editor.source, source);
});

test('the frame is made of another metal: lighter in aluminium, dearer in titanium, its gear and its shape kept', () => {
  const source = authored('chassis', { thicknessMm: 20, axles: [-40, -1, 34] }),
    // What it weighs, what it costs by the stocks that pay it — that of its metal, and Ferro for the rubber of its gear —,
    // and what it carries.
    choices = chassisMetalChoices(source), [steel, aluminium, titanium] = choices.map(choice => {
    const match = choice.detail.match(/^([\d.,]+) (t|kg) · ([\d.]+) cr em (Ferro|Ligas)(?: e ([\d.]+) cr em Ferro)? · limite: ([\d.,]+) (t|kg)$/);
    assert(match, choice.detail);
    const [, mass, unit, own, stock, iron = '0', capacity] = match, credits = text => Number(text.replaceAll('.', ''));
    assert.equal(stock, choice.id === 'steel' ? 'Ferro' : 'Ligas', choice.detail);
    assert(choice.id === 'steel' || credits(iron) > 0, 'the rubber of its gear is paid from Ferro');
    assert(Number(capacity.replaceAll('.', '').replace(',', '.')) > 0, 'the material choice shows actual capacity');
    return { tonnes: Number(mass.replaceAll('.', '').replace(',', '.')) / (unit === 'kg' ? 1000 : 1), credits: credits(own) + credits(iron) };
  });
  assert.deepEqual(choices.map(choice => [choice.id, choice.name]), [['steel', 'Aço'], ['aluminum', 'Alumínio'], ['titanium', 'Titânio']]);
  assert(aluminium.tonnes < titanium.tonnes && titanium.tonnes < steel.tonnes, 'aluminium is the lightest');
  // Titanium the dearest. An aluminium frame costs about what a steel one does: its gear a little more, but for its rubber,
  // which is as on steel.
  assert(Math.max(steel.credits, aluminium.credits) < titanium.credits, 'titanium the dearest');
  // In the editor: one edit, the chassis selected, its axles where they were; moving an end or another model keeps it.
  const editor = new Editor(source), empty = editor.blueprint.chassis.emptyKg;
  assert.equal(editor.setChassisMetal('aluminum'), true);
  assert.deepEqual(editor.source.chassis, { ...source.chassis, metal: 'aluminum' });
  assert.equal(editor.selection, CHASSIS_ID); assert(editor.blueprint.chassis.emptyKg < empty);
  assert.equal(editor.setChassisMetal('aluminum'), false, 'the metal it has is no change');
  assert.equal(withChassisPoint(editor.source, 1, { x: 60, y: 0 }).chassis.metal, 'aluminum');
  assert.equal(withChassisModel(editor.source, 'tracked').chassis.metal, 'aluminum');
  // Steel is not written.
  assert.equal(editor.setChassisMetal('steel'), true); assert.equal(editor.source.chassis.metal, undefined);
  assert.equal(editor.past.length, 2);
});


test('the settings bar keeps eight axles through a resize and refuses an impossible one without history changes', () => {
  const draft = createStructuredConstruction({ length: 12, height: 1.2, thicknessMm: 8 }),
    source = validateStructuredConstruction({ ...draft, chassis: { ...draft.chassis,
      axles: Array.from({ length: 8 }, (_, i) => cellOf(-5.1 + i * 10.2 / 7)) } }), editor = new Editor(source);
  chassisSettings(editor);
  applySettings(editor, 'gearScale', new Map([[CHASSIS_ID, 1.2]]));
  assert.equal(chassisAxles(editor.source.chassis).length, 8);
  assert.equal(editor.blueprint.chassis.gear.length, 8);
  assert(Math.abs(chassisGearSize(editor.source.chassis) - 1.32) < 1e-9);
  assert.deepEqual(chassisAxles(editor.source.chassis), chassisAxles(source.chassis));
  assert(editor.blueprint.chassis.loadedKg <= editor.blueprint.chassis.limitKg);
  assert.equal(editor.past.length, 1);
  const before = editor.source, blueprint = editor.blueprint;
  assert.throws(() => applySettings(editor, 'gearScale', new Map([[CHASSIS_ID, 1.5]])),
    error => ['AXLE_EXTENT', 'AXLE_SPACING'].includes(error.reason));
  assert.equal(editor.source, before); assert.equal(editor.blueprint, blueprint); assert.equal(editor.past.length, 1);
  assert.equal(editor.selection, CHASSIS_ID); assert.equal(chassisAxles(editor.source.chassis).length, 8);
  assert(editor.undo()); assert.deepEqual(editor.source, source);
});

test('track measurements keep the belt on the floor and the hull as high over it, with free decimals, suspension and atomic refusal', () => {
  const draft = createStructuredConstruction({ length: 4.5, height: 1.2, thicknessMm: 8, chassis: 'tracked' }),
    source = validateStructuredConstruction({ ...draft, chassis: withTrackSpan(draft.chassis, -1.75, 1.75) }),
    editor = new Editor(source), track = () => chassisTrack(editor.source.chassis), original = track(),
    near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`),
    set = (key, value) => applySettings(editor, key, new Map([[CHASSIS_ID, value]])),
    onFloor = () => near(track().y - track().height / 2, .01 - VEHICLE_ORIGIN.y),
    hull = design => [design.nodes, design.plates, design.components, design.chassis.points],
    lifted = (design, lift) => [design.nodes.map(node => ({ ...node, y: node.y + lift })), design.plates,
      design.components.map(part => ({ ...part, pose: { ...part.pose, y: part.pose.y + lift } })),
      design.chassis.points.map(point => ({ ...point, y: point.y + lift }))];
  editor.snap = false; onFloor();
  const length = chassisSettings(editor).find(setting => setting.key === 'trackLength');
  assert.equal(length.unit, 'm'); assert.equal(length.fine, 0);
  const precise = typedSetting(length, '3,2134567'); assert.equal(precise, 3.2134567);
  set('trackLength', precise);
  near(track().rear - track().front, precise); near((track().front + track().rear) / 2, 0);
  set('trackX', .10321);
  const { front, rear } = editor.source.chassis.track, suspension = suspensionHeight(editor.source.chassis), placed = editor.source;
  set('trackHeight', original.height * .95);
  assert.deepEqual([editor.source.chassis.track.front, editor.source.chassis.track.rear], [front, rear], 'height changes no endpoint');
  near(track().height, original.height * .95); onFloor();
  assert.equal(suspensionHeight(editor.source.chassis), suspension, 'the hull rides as high over the smaller track');
  assert.deepEqual(hull(editor.source), lifted(placed, suspensionZero(editor.source.chassis) - suspensionZero(placed.chassis)));
  // The suspension takes the hull and all it carries a cell higher over the track, which stays where it is.
  const suspended = withChassisSuspension(editor.source, suspension + 1);
  assert.deepEqual(suspended.chassis.track, editor.source.chassis.track);
  assert.deepEqual(hull(suspended), lifted(editor.source, 1));
  assert.equal(Object.hasOwn(editor.source.chassis.track, 'wheels'), false, 'support count is derived, never authored');
  const before = editor.source, compiled = editor.blueprint, past = editor.past.length,
    highest = chassisSettings(editor).find(setting => setting.key === 'trackHeight').max;
  assert.throws(() => set('trackHeight', highest + .1), { reason: 'FIELD', field: 'gearScale' });
  assert.equal(editor.source, before); assert.equal(editor.blueprint, compiled); assert.equal(editor.past.length, past);
  while (editor.past.length) assert(editor.undo()); assert.deepEqual(editor.source, source);
  // A taller band grows up from the floor and the hull rises with it, during either typed edit.
  const ready = editor.source;
  for (const snap of [true, false]) {
    editor.snap = snap;
    const height = chassisSettings(editor).find(setting => setting.key === 'trackHeight'), values = typedSettings(height, '1.013');
    assert.equal(height.step, snap ? CELL : .01, 'the buttons retain their assisted or free step');
    assert.equal(values.get(CHASSIS_ID), 1.013, `typing keeps the precise height with snap ${snap ? 'on' : 'off'}`);
    applySettings(editor, 'trackHeight', values);
    near(track().height, 1.013); onFloor();
    assert.deepEqual([editor.source.chassis.track.front, editor.source.chassis.track.rear], [ready.chassis.track.front, ready.chassis.track.rear]);
    assert.equal(suspensionHeight(editor.source.chassis), suspensionHeight(ready.chassis));
    assert.deepEqual(hull(editor.source), lifted(ready, suspensionZero(editor.source.chassis) - suspensionZero(ready.chassis)));
    assert(suspensionZero(editor.source.chassis) > suspensionZero(ready.chassis), 'the hull rises over the taller track');
    assert(editor.undo()); assert.deepEqual(editor.source, ready, 'one undo restores the exact authoring');
  }
});

test('a design whose track is off the floor comes into the Oficina with it on the floor and the hull as high over it', () => {
  const stock = authored('tracked'), track = chassisTrack(stock.chassis),
    off = lift => ({ ...stock, chassis: { ...stock.chassis, track: { front: track.front / CELL, rear: track.rear / CELL, y: (track.y + lift) / CELL } } });
  for (const lift of [.15, -.1, .0371]) {
    const written = off(lift), editor = new Editor(written), at = chassisTrack(editor.source.chassis), cells = Math.round(-lift / CELL);
    assert(Math.abs(at.y - at.height / 2 - (.01 - VEHICLE_ORIGIN.y)) < 1e-9, `${lift}: the belt on the floor`);
    assert.deepEqual(editor.source.chassis.points, written.chassis.points.map(point => ({ ...point, y: point.y + cells })), `${lift}`);
    assert.deepEqual(editor.source.nodes, written.nodes.map(node => ({ ...node, y: node.y + cells })), `${lift}`);
    assert(Math.abs(editor.blueprint.chassis.suspension - compileDraftConstruction(written).chassis.suspension) <= CELL / 2 + 1e-9,
      `${lift}: as high over it within half a cell`);
    assert.equal(editor.past.length, 0, 'nothing to undo');
  }
  // One on the floor comes in as it is.
  assert.deepEqual(new Editor(stock).source, stock);
});
