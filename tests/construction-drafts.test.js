import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredConstruction, planStructuredComponent, compileStructuredConstruction,
  compileDraftConstruction, validateStructuredConstruction, validateDraftConstruction } from '../src/structured-construction.ts';
import { compileBlueprint, compileDraftBlueprint, validateBlueprint, validateDraftBlueprint,
  parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { DesignLibrary, LIBRARY_KEY } from '../src/library.ts';
import { Editor } from '../src/editor.ts';
import { constructionCardData } from '../src/construction-ui.ts';
import { constructionSVG } from '../src/construction-preview.ts';
import { constructionCost, pieceCost } from '../src/construction-cost.ts';
import { blueprintMass, blueprintPowertrain } from '../src/mass-properties.ts';
import { designBill } from '../src/economy.ts';
import { workshopAdmissionMessage } from '../src/workshop-checklist.ts';
import { withChassisGearScale, withChassisThickness } from '../src/chassis-editing.ts';
import { World } from '../src/physics.ts';
import { rehearsal } from '../server/room.ts';
import { metresOf } from '../src/grid.ts';

await initNativeDynamics();

const copy = value => structuredClone(value);
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const derivedFields = ['powertrain', 'derived', 'mechanicalAdmission', 'admissionIssues', 'modules', 'rooms', 'frame', 'attachments', 'bodyPanels'];
function store() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function library(storage) {
  let id = 0;
  return new DesignLibrary(storage, { id: () => `draft-${++id}`, now: () => '2026-10-19T00:00:00Z' });
}
function refused(action) {
  let error;
  try { action(); } catch (caught) { error = caught; }
  assert(error instanceof Error, 'the strict boundary must refuse the pending design');
  return error;
}
function authoredOnly(source) {
  for (const field of derivedFields) assert.equal(Object.hasOwn(source, field), false, field);
}

// Both documents are ordinary authored designs. The one native compiler supplies
// their pending findings, real structure, reserves and physical capacity.
const fixtures = ['overload', 'balance'].map(kind => {
  const base = planStructuredComponent(createStructuredConstruction({ length: kind === 'overload' ? 8 : 6,
    height: 1.4, thicknessMm: 8 }), { id: 'command', kind: 'command',
    pose: { x: 0, y: 6, angle: 0 } }).construction;
  base.appearance = { ...base.appearance, automaticDetails: false, details: [] };
  const pending = copy(base);
  let fixed = copy(base);
  if (kind === 'overload') {
    pending.plates.find(plate => plate.id === 'hull:roof').thicknessMm = 150;
    // Its frame and its wheels made larger, and all of it hung higher with its suspension; four axles evenly spread over
    // the frame, the outer ones on the first cells that keep their wheels whole under it.
    fixed = copy(withChassisGearScale(withChassisThickness(pending, 50), 1.5));
    fixed.chassis.axles = [-63, -21, 21, 63];
  } else {
    pending.chassis.axles = [14, 40];
    fixed.chassis.axles = [-40, 40];
  }
  return { kind, base, pending, fixed, issue: kind === 'overload' ? 'CHASSIS_OVERLOAD' : 'CHASSIS_BALANCE' };
});

for (const fixture of fixtures) {
  const { kind, base, pending, fixed, issue } = fixture;

  test(`${kind}: draft compilation preserves the authored design and reports actual pending mechanics`, () => {
    const source = copy(pending), before = copy(source), dto = compileDraftBlueprint(source);
    assert.equal(dto.mechanicalAdmission, false);
    assert(dto.admissionIssues.some(finding => finding.code === issue));
    assert(dto.admissionIssues.every(finding => typeof finding.code === 'string' && !Object.hasOwn(finding, 'message')));
    const strict = refused(() => compileBlueprint(source)), finding = dto.admissionIssues.find(finding => finding.code === strict.reason);
    assert(finding, 'draft findings and strict refusal use the same protocol');
    for (const [key, value] of Object.entries(finding)) if (key !== 'code') assert.deepEqual(strict[key], value, key);
    assert.deepEqual(validateDraftBlueprint(source), source);
    assert.deepEqual(validateDraftConstruction(source), source);
    assert.deepEqual(compileDraftConstruction(source), dto);
    assert.deepEqual(source, before);
    authoredOnly(source);
    assert(dto.plates.length >= source.plates.length && dto.modules.some(module => module.id === 'command'));
    for (const plate of source.plates) {
      const drawn = dto.plates.find(piece => piece.id === plate.id);
      assert.equal(drawn.thicknessMm, plate.thicknessMm);
      assert(drawn.physicalMass > 0);
    }
    assert.equal(dto.chassis.limitKg, Math.min(dto.chassis.frameLimitKg, dto.chassis.gearLimitKg));
    if (kind === 'overload') assert(dto.chassis.loadedKg > dto.chassis.limitKg);
    else assert(dto.chassis.balance[0] < dto.frame.origin.x + metresOf(source.chassis.axles[0]));
    assert(workshopAdmissionMessage(dto).length > 0);
    refused(() => compileBlueprint(source));
    refused(() => validateBlueprint(source));
  });

  test(`${kind}: garage, export and opening retain the pending source without derived fields`, () => {
    const storage = store(), garage = library(storage), saved = garage.create(pending);
    assert.deepEqual(saved.blueprint, pending);
    const persisted = JSON.parse(storage.getItem(LIBRARY_KEY)).entries[0].blueprint;
    authoredOnly(persisted);
    assert.deepEqual(persisted, pending);
    const reopened = library(storage).active;
    assert.deepEqual(reopened, saved);
    const opened = new Editor(reopened.blueprint, reopened.id);
    assert.equal(opened.projectId, saved.id);
    assert.deepEqual(opened.source, pending);
    assert.equal(opened.blueprint.mechanicalAdmission, false);
    const exported = serializeBlueprint(opened.source);
    authoredOnly(JSON.parse(exported));
    const imported = parseBlueprint(exported);
    assert.deepEqual(imported, pending);
    assert.equal(compileDraftBlueprint(imported).mechanicalAdmission, false);
    const duplicate = garage.duplicate(saved.id), renamed = garage.rename(saved.id, 'Ainda em ajuste');
    assert.deepEqual({ ...duplicate.blueprint, name: pending.name }, pending);
    assert.deepEqual({ ...renamed.blueprint, name: pending.name }, pending);
    assert.equal(garage.active.id, saved.id);
    assert.deepEqual(opened.source, pending, 'saving and renaming a garage entry do not redesign the open bench');
  });

  test(`${kind}: gallery mass, price, bill and SVG use the full pending geometry`, () => {
    const dto = compileDraftBlueprint(pending), before = copy(pending), mass = blueprintMass(dto),
      cost = constructionCost(dto), card = constructionCardData(pending);
    near(mass, dto.chassis.loadedKg);
    assert.equal(cost.total, [...dto.plates, ...dto.modules].reduce((sum, piece) => sum + pieceCost(piece), 0));
    assert(cost.total > 0 && mass > 0);
    const drive = blueprintPowertrain(pending);
    assert(Number.isFinite(drive.drag) && drive.drag > 0 && Number.isFinite(drive.maxSpeed));
    assert.deepEqual(constructionCost(pending), cost);
    assert.deepEqual(blueprintMass(pending), mass);
    assert.equal(card.massKg, mass);
    assert.deepEqual(card.cost, cost);
    assert.deepEqual(card.bill, designBill(dto));
    assert.equal(card.svg, constructionSVG(dto));
    assert.match(card.svg, /^<svg/);
    assert.match(card.svg, /polygon/);
    assert.deepEqual(pending, before);
  });

  test(`${kind}: draft input and canonical cache entries never bypass strict admission`, () => {
    const asked = copy(pending);
    delete asked.appearance;
    const canonical = validateDraftBlueprint(asked), expected = compileDraftBlueprint(canonical);
    assert.notDeepEqual(asked, canonical, 'exercise distinct input and canonical cache aliases');
    for (const source of [asked, canonical, copy(canonical)]) {
      const dto = compileDraftBlueprint(source);
      assert.equal(dto.mechanicalAdmission, false);
      for (const strict of [compileBlueprint, validateBlueprint, compileStructuredConstruction, validateStructuredConstruction])
        refused(() => strict(source));
    }
    const returned = compileDraftBlueprint(canonical);
    returned.mechanicalAdmission = true;
    returned.admissionIssues.length = 0;
    returned.chassis.limitKg = Infinity;
    returned.plates[0].thicknessMm = 1;
    const authored = validateDraftBlueprint(canonical);
    authored.plates[0].thicknessMm = 1;
    assert.deepEqual(compileDraftBlueprint(canonical), expected, 'returned draft results cannot mutate either cached answer');
    assert.equal(compileBlueprint(fixed).mechanicalAdmission, true);
    assert.deepEqual(compileDraftBlueprint(fixed), compileBlueprint(fixed));
    assert.equal(compileDraftBlueprint(pending).mechanicalAdmission, false);
    refused(() => compileBlueprint(pending));
  });

  test(`${kind}: a draft warmed in metadata still cannot enter a World or be published`, t => {
    compileDraftBlueprint(pending);
    constructionCardData(pending);
    const strictError = refused(() => compileBlueprint(pending));
    assert.equal(refused(() => new World(pending)).code, strictError.code);
    const world = new World(base);
    t.after(() => world.dispose());
    const before = copy(world.snapshot());
    assert.equal(refused(() => world.addActor(pending, { id: 'pending', x: 80 })).code, strictError.code);
    assert.deepEqual(world.snapshot(), before);
    assert.equal(refused(() => world.replaceActor(pending, { id: 'local' })).code, strictError.code);
    assert.equal(refused(() => world.load(pending)).code, strictError.code);
    assert.deepEqual(world.snapshot(), before);

    // This is an in-process rehearsal with the real World and abundant stocks;
    // no browser, socket, public seat or simulated compiler participates.
    const room = rehearsal();
    t.after(() => room.world.dispose());
    const { playerId } = room.join('Rascunho local'), player = room.players.get(playerId), faction = room.faction(player),
      stock = copy(faction.stock), scene = copy(room.world.snapshot()), topology = room.topology;
    const failed = refused(() => room.publish(playerId, pending));
    assert.equal(failed.code, strictError.code);
    assert.match(failed.message, /chassi|eixos|rodas|peso|rodagem/i);
    assert.deepEqual(faction.stock, stock);
    assert.deepEqual(room.world.snapshot(), scene);
    assert.equal(room.topology, topology);
    assert.equal(player.selected, null);
    assert.equal(player.builtAt, -Infinity);
    assert.equal(player.published.size, 0);
  });

  test(`${kind}: a manual chassis correction clears the pending finding and undo restores it`, () => {
    const editor = new Editor(pending), before = copy(editor.source);
    assert.equal(editor.blueprint.mechanicalAdmission, false);
    assert(workshopAdmissionMessage(editor.blueprint));
    // The chassis corrected, and the construction hung where its suspension then reaches its wheels.
    editor.change(source => { for (const key of ['chassis', 'nodes', 'components']) source[key] = copy(fixed[key]); });
    assert.deepEqual(editor.source, { ...fixed, appearance: before.appearance });
    assert.deepEqual(editor.source.plates, before.plates);
    assert(editor.source.nodes.every((node, i) => node.x === before.nodes[i].x));
    assert.equal(editor.blueprint.mechanicalAdmission, true);
    assert.deepEqual(editor.blueprint.admissionIssues, []);
    assert.equal(workshopAdmissionMessage(editor.blueprint), '');
    assert.deepEqual(compileBlueprint(editor.source), editor.blueprint);
    assert(editor.undo());
    assert.deepEqual(editor.source, before);
    assert.equal(editor.blueprint.mechanicalAdmission, false);
    assert(editor.blueprint.admissionIssues.some(finding => finding.code === issue));
    refused(() => compileBlueprint(editor.source));
    assert(editor.redo());
    assert.deepEqual(editor.source, fixed);
    assert.equal(workshopAdmissionMessage(editor.blueprint), '');
    assert.equal(compileBlueprint(editor.source).mechanicalAdmission, true);
  });
}

test('draft import and persistence still reject broken geometry, derived results and obsolete formats', () => {
  const source = fixtures[0].pending, storage = store(), garage = library(storage), saved = garage.create(source),
    stored = storage.getItem(LIBRARY_KEY), dto = compileDraftBlueprint(source), broken = copy(source);
  broken.plates[0].a = 'missing-node';
  for (const invalid of [broken, { ...source, version: 4 }, dto]) {
    assert.throws(() => compileDraftBlueprint(invalid));
    assert.throws(() => parseBlueprint(JSON.stringify(invalid)));
    assert.throws(() => serializeBlueprint(invalid));
    assert.throws(() => garage.update(saved.id, invalid));
    assert.equal(storage.getItem(LIBRARY_KEY), stored);
    assert.deepEqual(garage.active, saved);
  }
  assert.throws(() => parseBlueprint('{'), /corrompido/);
  assert.deepEqual(parseBlueprint(serializeBlueprint(source)), source);
});
