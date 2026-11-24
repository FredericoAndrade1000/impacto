import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { CHASSIS_ID, chassisPart } from '../src/chassis-editing.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { everyPiece, projectParts, plateMiddleHit } from '../src/workshop-selection.ts';
import { selectionSettings, applySettings, typedSettings, steppedSettings, metalChoices, weight, selectionFigures } from '../src/piece-settings.ts';
import { MATERIALS, takesMetal } from '../src/materials.ts';
import { pieceMass } from '../src/mass-properties.ts';
import { pieceCost, formatCredits } from '../src/construction-cost.ts';
import { piecesBill } from '../src/economy.ts';

await initNativeDynamics();

test('overlapping end grips leave the middle of a short plate available for moving it', () => {
  const plate = { aId: 'a', bId: 'b', a: { x: 0, y: 0 }, b: { x: .1, y: .1 } },
    node = { kind: 'node', id: 'a' };
  assert(plateMiddleHit({ x: .05, y: .05 }, node, plate));
  assert(plateMiddleHit({ x: .05, y: .05 }, { ...node, id: 'b' }, plate));
  assert(!plateMiddleHit(plate.a, node, plate));
  assert(!plateMiddleHit(plate.b, { ...node, id: 'b' }, plate));
  assert(!plateMiddleHit({ x: .05, y: .05 }, { ...node, id: 'other-joint' }, plate));
  assert(!plateMiddleHit({ x: .05, y: .05 }, { kind: 'vertex', index: 0 }, plate));
});

const selected = editor => selectionSettings(editor.selectedPieces.map(piece => ({ piece,
  part: piece.chassis ? editor.source.chassis : editor.source.plates.find(part => part.id === piece.id) || editor.source.components.find(part => part.id === piece.id) || null })));
const field = (editor, key) => selected(editor).find(setting => setting.key === key);
const selectAll = editor => editor.select(everyPiece(editor.blueprint));

test('selecting every piece covers the actual project once without editing it', () => {
  const editor = new Editor(createStructuredTemplate('heavy')), before = structuredClone(editor.source), ids = everyPiece(editor.blueprint);
  assert.deepEqual([...ids].sort(), [CHASSIS_ID, ...editor.pieces.filter(piece => !chassisPart(piece.id)).map(piece => piece.id)].sort());
  assert.equal(new Set(ids).size, ids.length);
  editor.select(ids); assert.equal(editor.selectionIds.size, ids.length);
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
  assert.deepEqual(everyPiece({}), []);
});

test('the list beside the project names the chassis and each component once, and no plate or running gear', () => {
  const editor = new Editor(createStructuredTemplate('heavy')), parts = projectParts(editor.blueprint),
    components = editor.blueprint.modules.filter(piece => !chassisPart(piece.id));
  assert.deepEqual(parts.map(part => part.id), [CHASSIS_ID, ...components.map(piece => piece.id)]);
  assert.deepEqual(parts[0], { id: CHASSIS_ID, kind: 'chassis', name: 'Chassi de esteiras' });
  assert.equal(parts.find(part => part.kind === 'weapon').name, 'Canhão Rheinmetall · 120 mm');
  assert(parts.every(part => part.name && !editor.source.plates.some(plate => plate.id === part.id)));
  for (const part of parts) { editor.select(part.id); assert.deepEqual([...editor.selectionIds], [part.id], part.name); }
  assert.deepEqual(projectParts({}), []);
});

test('the list numbers the pieces that share a name, in the order installed, and leaves a name of one piece alone', () => {
  const parts = projectParts({ modules: [{ id: 'a', kind: 'sensor', sensorMode: 'visual' }, { id: 'b', kind: 'engine' },
    { id: 'c', kind: 'sensor', sensorMode: 'radar' }, { id: 'd', kind: 'sensor', sensorMode: 'visual' }, { id: 'e', kind: 'fuel' },
    { id: 'f', kind: 'fuel' }, { id: 'chassis:wheel:0', kind: 'wheel' }] });
  assert.deepEqual(parts.map(part => [part.id, part.name]), [['a', 'Câmera óptica 1'], ['b', 'Motor'], ['c', 'Radar móvel'],
    ['d', 'Câmera óptica 2'], ['e', 'Combustível 1'], ['f', 'Combustível 2']]);
});

test('selecting everything exposes fields only on the pieces that own each property', () => {
  const editor = new Editor(createStructuredTemplate('heavy')); selectAll(editor);
  const before = structuredClone(editor.source), expected = {
    angle: [...editor.source.plates, ...editor.source.components].map(part => part.id),
    thicknessMm: [...editor.source.plates.map(part => part.id), 'chassis:top-0'],
    length: editor.source.plates.map(part => part.id),
    sizeScale: editor.source.components.filter(part => ['engine', 'fuel', 'ammo'].includes(part.kind)).map(part => part.id),
    armorMm: [CHASSIS_ID],
    frameThicknessMm: [CHASSIS_ID],
    trackLength: [CHASSIS_ID], trackHeight: [CHASSIS_ID], trackX: [CHASSIS_ID], suspension: [CHASSIS_ID],
    topPlateThicknessMm: [CHASSIS_ID],
  };
  assert.deepEqual(selected(editor).map(setting => setting.key).sort(), Object.keys(expected).sort());
  for (const setting of selected(editor)) assert.deepEqual([...setting.ids].sort(), expected[setting.key].sort(), setting.key);
  assert.equal(field(editor, 'thicknessMm').value, null);
  assert.deepEqual(field(editor, 'thicknessMm').range, [Math.min(...before.plates.map(plate => plate.thicknessMm)), Math.max(...before.plates.map(plate => plate.thicknessMm))]);
  assert.deepEqual(editor.source, before);
  assert.deepEqual(selectionSettings([]), []);
  const selection = [...editor.selectionIds];
  applySettings(editor, 'thicknessMm', typedSettings(field(editor, 'thicknessMm'), '5'));
  assert(editor.source.plates.every(plate => plate.thicknessMm === Math.max(5, MATERIALS[plate.material].minThicknessMm)));
  assert.deepEqual(editor.source.chassis, { ...before.chassis, topPlate: { ...before.chassis.topPlate, thicknessMm: 5 } }, 'the selected deck armour changes while the structural frame and running gear retain their gauge');
  assert.deepEqual(editor.source.components, before.components);
  assert.deepEqual([...editor.selectionIds], selection); assert.equal(editor.past.length, 1);
  editor.undo(); assert.deepEqual(editor.source, before);
});

test('selecting the chassis counts all its generated pieces once in the selection price and mass', () => {
  const editor = new Editor(createStructuredTemplate('heavy')), b = editor.blueprint, before = structuredClone(b),
    figures = pieces => weight(pieces.reduce((sum, piece) => sum + pieceMass(piece), 0)) +
      ' · ' + formatCredits(pieces.reduce((sum, piece) => sum + pieceCost(piece), 0));
  editor.select(CHASSIS_ID);
  const representative = editor.selectedPieces, all = [...b.plates, ...b.modules],
    generated = all.filter(piece => b.chassis.plates.includes(piece.id) || b.chassis.gear.includes(piece.id));
  assert.equal(selectionFigures(b, representative), selectionFigures(b, generated));
  assert.equal(selectionFigures(b, representative), figures(generated));
  selectAll(editor);
  assert.equal(selectionFigures(b, editor.selectedPieces), selectionFigures(b, all));
  assert.equal(selectionFigures(b, editor.selectedPieces), figures(all));
  assert.equal(selectionFigures(b, []), figures([]));
  assert.deepEqual(b, before);
});

test('batch plate material preserves thicknesses, excludes components, and is undone in one step', () => {
  const editor = new Editor(createStructuredTemplate('heavy')); selectAll(editor);
  const before = structuredClone(editor.source), ids = [...editor.selectionIds], history = editor.past.length;
  applySettings(editor, 'material', new Map(field(editor, 'thicknessMm').ids.map(id => [id, 'aluminum'])));
  for (const plate of editor.source.plates) {
    assert.equal(plate.material, 'aluminum');
    assert.equal(plate.thicknessMm, Math.max(before.plates.find(old => old.id === plate.id).thicknessMm, MATERIALS.aluminum.minThicknessMm));
  }
  assert.deepEqual(editor.source.components, before.components);
  assert.deepEqual([...editor.selectionIds], ids); assert.equal(editor.past.length, history + 1);
  editor.undo(); assert.deepEqual(editor.source, before);
  editor.redo(); assert(editor.source.plates.every(plate => plate.material === 'aluminum'));
});

test('a typed thickness equalizes plates while stepping preserves differences and material minimums', () => {
  const editor = new Editor(createStructuredTemplate('heavy')); selectAll(editor);
  const components = structuredClone(editor.source.components), plates = editor.source.plates.slice(0, 2);
  editor.select(plates.map(plate => plate.id));
  applySettings(editor, 'material', new Map([[plates[0].id, 'glass']]));
  applySettings(editor, 'thicknessMm', typedSettings(field(editor, 'thicknessMm'), '10'));
  assert.deepEqual(editor.selectedPieces.map(plate => plate.thicknessMm), [15, 10]);
  assert.deepEqual(field(editor, 'thicknessMm').range, [10, 15]); assert.equal(field(editor, 'thicknessMm').value, null);
  applySettings(editor, 'thicknessMm', steppedSettings(field(editor, 'thicknessMm'), 1));
  assert.deepEqual(editor.selectedPieces.map(plate => plate.thicknessMm), [20, 15]);
  applySettings(editor, 'thicknessMm', typedSettings(field(editor, 'thicknessMm'), '25'));
  assert.deepEqual(editor.selectedPieces.map(plate => plate.thicknessMm), [25, 25]);
  assert.equal(field(editor, 'thicknessMm').value, 25);
  assert.deepEqual(editor.source.components, components);
});

test('armour can be edited from a mixed selection without writing it on unrelated parts', () => {
  const editor = new Editor(createStructuredTemplate('heavy')); selectAll(editor);
  const before = structuredClone(editor.source);
  applySettings(editor, 'armorMm', typedSettings(field(editor, 'armorMm'), '20'));
  assert.deepEqual(editor.source.plates, before.plates);
  assert.equal(editor.source.chassis.armorMm, 20);
  for (const part of editor.source.components) {
    if (['wheel', 'track'].includes(part.kind)) assert.equal(part.armorMm, 20);
    else assert.deepEqual(part, before.components.find(old => old.id === part.id));
  }
});

test('batch metals show total cost and mass, change eligible components together, and preserve plates and equipment', () => {
  const editor = new Editor(createStructuredTemplate('tanker')); selectAll(editor);
  const before = structuredClone(editor.source), parts = editor.source.components.filter(part => takesMetal(part, 'titanium')),
    ids = new Set(parts.map(part => part.id)), choices = metalChoices(editor.source, parts);
  assert(parts.length > 1);
  const titanium = choices.find(choice => choice.id === 'titanium');
  applySettings(editor, 'metal', new Map(parts.map(part => [part.id, 'titanium'])));
  // What titanium pays from Ligas, and from Ferro what it does not change: the equipment of the command post.
  const changed = editor.blueprint.modules.filter(part => ids.has(part.id)), paid = piecesBill(changed),
    mass = weight(changed.reduce((sum, part) => sum + pieceMass(part), 0));
  assert(titanium.detail.startsWith(mass + ' ·'));
  assert(titanium.detail.includes(`${formatCredits(paid.ligas)} em Ligas e ${formatCredits(paid.ferro)} em Ferro`), titanium.detail);
  assert.deepEqual(editor.source.plates, before.plates);
  assert.deepEqual(editor.source.components.filter(part => !ids.has(part.id)), before.components.filter(part => !ids.has(part.id)));
  assert(editor.source.components.filter(part => ids.has(part.id)).every(part => part.metal === 'titanium'));
  assert.equal(editor.past.length, 1); editor.undo(); assert.deepEqual(editor.source, before);
});
