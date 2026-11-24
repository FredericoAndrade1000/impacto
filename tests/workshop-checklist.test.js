import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { compileDraftConstruction, compileStructuredConstruction, createStructuredConstruction } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { Editor } from '../src/editor.ts';
import { workshopAdmissionMessage, workshopChecklist, workshopReviewPart } from '../src/workshop-checklist.ts';
import { power } from '../src/format.ts';

await initNativeDynamics();
const review = source => workshopChecklist(compileBlueprint(source));
const byId = (rows, id) => rows.find(row => row.id === id);
const without = (source, kind) => ({ ...source, components: source.components.filter(part => part.kind !== kind) });

test('an extractor is ready without a reservoir and the checklist opens its complete installed piece', () => {
  const source = without(createConstruction('mining-truck'), 'hopper'), blueprint = compileBlueprint(source),
    rows = workshopChecklist(blueprint), extraction = byId(rows, 'extraction');
  assert.equal(extraction.state, 'ready'); assert.match(extraction.detail, /outro veículo pode levar\. A ferramenta pede [\d.]+ hp; o motor dá [\d.]+ hp\.$/);
  assert.equal(rows.some(row => row.state === 'attention'), false, 'transport is a separate optional role');
  assert.equal(workshopReviewPart(blueprint, 'extraction'), blueprint.modules.find(module => module.kind === 'excavator').id);
  assert.equal(byId(review(createConstruction('truck')), 'extraction'), undefined, 'a carrier is not an extractor');
});

test('a compiled armed vehicle reports six observable items without treating optional equipment as publication requirements', () => {
  const blueprint = compileBlueprint(createConstruction('scout')), before = structuredClone(blueprint), rows = workshopChecklist(blueprint);
  assert.deepEqual(rows.map(({ id, state }) => [id, state]), [
    ['command', 'ready'], ['vision', 'ready'], ['engine', 'ready'], ['running-gear', 'ready'], ['fuel', 'ready'], ['armament', 'ready'],
  ]);
  assert.deepEqual(rows.map(({ target }) => target), ['adjust', 'adjust', 'adjust', 'adjust', 'adjust', 'adjust']);
  assert.match(byId(rows, 'fuel').detail, /^202 L no tanque\.$/);
  assert.match(byId(rows, 'armament').detail, /1 arma com munição compatível · 1\.930 tiros\.$/);
  assert.deepEqual(blueprint, before, 'review does not edit the compiled design');

  const truck = review(createConstruction('truck'));
  assert.deepEqual(truck.map(row => row.state), ['ready', 'ready', 'ready', 'ready', 'ready', 'info']);
  assert.equal(byId(truck, 'armament').detail, 'Sem arma (opcional).');
});

test('an empty vehicle has one real publication warning and neutral mobility and weapon guidance', () => {
  const rows = review(createStructuredConstruction({ preset: 'vehicle' }));
  assert.deepEqual(rows.map(({ state, target }) => [state, target]), [
    ['attention', 'build'], ['info', 'build'], ['info', 'build'], ['ready', 'adjust'], ['info', 'build'], ['info', 'build'],
  ]);
  assert.equal(byId(rows, 'command').detail, 'Sem Comando: não fabrica.');
  assert.match(byId(rows, 'armament').detail, /opcional/);
});

test('the checklist distinguishes absent equipment, a box too small for a round and mismatched weapon presets', () => {
  const scout = createConstruction('scout');
  assert.deepEqual([byId(review(without(scout, 'command')), 'command').state,
    byId(review(without(scout, 'engine')), 'engine').state], ['attention', 'info']);

  const compiled = compileBlueprint(scout);
  assert.equal(workshopReviewPart(compiled, 'running-gear'), 'chassis:frame-0', 'generated wheels open their common chassis');

  const noTank = byId(review(without(scout, 'fuel')), 'fuel');
  assert.deepEqual([noTank.state, noTank.target], ['attention', 'build']);
  // A tank is built full.
  const tank = byId(review(scout), 'fuel');
  assert.deepEqual([tank.state, tank.target], ['ready', 'adjust']);
  assert.match(tank.detail, /^[\d.]+ L no tanque\.$/);

  const noBox = byId(review(without(scout, 'ammo')), 'armament');
  assert.deepEqual([noBox.state, noBox.target, noBox.marked], ['attention', 'build', true]);
  // A box holds no round only when it is too small for one of its calibre: it is enlarged.
  const emptyBox = byId(workshopChecklist({ ...compiled, modules: compiled.modules.map(part => part.kind === 'ammo' ? { ...part, rounds: 0 } : part) }), 'armament');
  assert.deepEqual([emptyBox.state, emptyBox.target], ['attention', 'adjust']);
  assert.match(emptyBox.detail, /pequena demais para um tiro/);
  const wrongBox = byId(review({ ...scout, components: scout.components.map(part => part.kind === 'ammo' ? { ...part, ammoPreset: 'rh120' } : part) }), 'armament');
  // The box left of another calibre is the one to change.
  assert.deepEqual([wrongBox.state, wrongBox.target, wrongBox.marked], ['attention', 'adjust', true]);
  assert.match(wrongBox.detail, /^Arma sem caixa de munição do calibre dela: troque o calibre da caixa que sobrou/);
});

test('no review is inferred from an uncompiled document', () => {
  assert.deepEqual(workshopChecklist(null), []);
  assert.deepEqual(workshopChecklist(createConstruction('scout')), []);
});

test('a draft reports native chassis findings in Portuguese and opens the chassis without editing the projection', () => {
  const admitted = compileBlueprint(createConstruction('scout')), pending = { ...admitted, mechanicalAdmission: false, admissionIssues: [
    { code: 'CHASSIS_BALANCE', model: 'wheeled', direction: 'front' },
    { code: 'CHASSIS_OVERLOAD', loadedKg: 18000, limitKg: 13000 },
  ] }, before = structuredClone(pending), row = byId(workshopChecklist(pending), 'chassis');
  assert.deepEqual([row.state, row.target], ['attention', 'adjust']);
  assert.match(row.detail, /à frente.*rodagem/); assert.match(row.detail, /18 \/ 13 t/);
  assert.doesNotMatch(row.detail, /Canonical|loaded mass|weight falls/);
  assert.equal(workshopReviewPart(pending, row.id), 'chassis:frame-0');
  assert.equal(workshopAdmissionMessage(pending), row.detail);
  assert.deepEqual(pending, before);
  assert.equal(workshopAdmissionMessage(admitted), ''); assert.equal(byId(workshopChecklist(admitted), 'chassis'), undefined);
});

test('an unbridged chassis gap remains editable and explains its native zero-capacity manufacturing refusal', () => {
  const box = createStructuredConstruction({ length: 6, thicknessMm: 8 }), source = { ...box, nodes: [], plates: [], components: [],
    chassis: { ...box.chassis, points: [ // -3, -1, 1 and 3 m, .4 m down, in cells
      { x: -60, y: -8 }, { x: -20, y: -8, gap: true }, { x: 20, y: -8 }, { x: 60, y: -8 },
    ] } }, before = structuredClone(source), blueprint = compileDraftConstruction(source),
    row = byId(workshopChecklist(blueprint), 'chassis');
  assert.equal(blueprint.mechanicalAdmission, false);
  assert(blueprint.admissionIssues.some(issue => issue.code === 'CHASSIS_GAP_OPEN'));
  assert.equal(blueprint.chassis.limitKg, 0);
  assert.match(row.detail, /seção resistente.*vão/);
  assert.equal(row.detail, workshopAdmissionMessage(blueprint));
  assert.equal(workshopReviewPart(blueprint, row.id), 'chassis:frame-0');
  assert.throws(() => compileStructuredConstruction(source), { reason: 'CHASSIS_GAP_OPEN' });
  assert.deepEqual(source, before);
});

test('an empty fixed draft asks for construction material instead of a chassis', () => {
  const source = { ...createStructuredConstruction({ preset: 'bunker' }), nodes: [], plates: [], components: [] },
    blueprint = compileDraftConstruction(source), message = workshopAdmissionMessage(blueprint);
  assert.deepEqual(blueprint.admissionIssues, [{ code: 'FRAME_EMPTY' }]);
  assert.match(message, /chapa ou um componente/); assert.doesNotMatch(message, /chassi/i);
  assert.equal(byId(workshopChecklist(blueprint), 'chassis'), undefined);
  assert.equal(byId(workshopChecklist(blueprint), 'command').target, 'build');
});

test('a fixed defence reviews command, exposed vision and ammunition without suggesting a drivetrain', () => {
  const source = createConstruction('guard-post'), rows = review(source);
  assert.deepEqual(rows.map(row => row.id), ['command', 'vision', 'armament']);
  assert.equal(byId(rows, 'command').state, 'ready');
  assert.equal(byId(rows, 'armament').state, 'ready');
  assert.equal(byId(review(without(source, 'command')), 'command').state, 'attention');
  assert.equal(byId(review(without(source, 'ammo')), 'armament').detail, 'Arma sem caixa de munição do calibre dela: ponha uma para fabricar.');
});

test('a piece of a fixed defence left in the air is a support warning that opens it, as on a vehicle', () => {
  const editor = new Editor(createStructuredTemplate('guard-post'));
  assert.equal(byId(workshopChecklist(editor.blueprint, editor.reviewManufacture()), 'support'), undefined, 'nothing is said of a design that stands');
  const camera = editor.addModule('sensor', { x: 12, y: 8 }, { sensorMode: 'visual' }), issues = editor.reviewManufacture(),
    row = byId(workshopChecklist(editor.blueprint, issues), 'support');
  assert.deepEqual([row.label, row.state, row.target], ['Apoio físico', 'attention', 'adjust']);
  assert.match(row.detail, /uma chapa, o chão ou outra peça apoiada/, 'a fixed construction stands on the ground');
  assert.equal(workshopReviewPart(editor.blueprint, 'support', issues), camera.id);
  assert.equal(workshopAdmissionMessage(editor.blueprint, issues), row.detail, 'its works is not opened from the workshop');
  // A vehicle stands on its chassis.
  const vehicle = new Editor(createStructuredTemplate('chassis'));
  vehicle.addModule('sensor', { x: 12, y: 8 }, { sensorMode: 'visual' });
  const found = vehicle.reviewManufacture(), told = byId(workshopChecklist(vehicle.blueprint, found), 'support').detail;
  assert.match(told, /uma chapa, o chassi ou outra peça apoiada/);
  assert.equal(workshopAdmissionMessage(vehicle.blueprint, found), told);
});

test('reviewing compatible ammunition that holds no round opens its box instead of the earlier weapon', () => {
  const compiled = compileBlueprint(createConstruction('scout')),
    blueprint = { ...compiled, modules: compiled.modules.map(part => part.kind === 'ammo' ? { ...part, rounds: 0 } : part) },
    box = blueprint.modules.find(part => part.kind === 'ammo');
  assert.equal(workshopReviewPart(blueprint, 'armament'), box.id);
  assert.equal(workshopReviewPart({ modules: [] }, 'armament'), null);
});

test('vision checks actual optical exposure and opens the camera or the glazed command post', () => {
  const source = createConstruction('ifv'), camera = source.components.find(part => part.kind === 'sensor' && part.sensorMode === 'visual'),
    command = source.components.find(part => part.kind === 'command'), blueprint = compileBlueprint(source);
  assert.match(byId(workshopChecklist(blueprint), 'vision').detail, /4\.000 m/);
  assert.equal(workshopReviewPart(blueprint, 'vision'), camera.id);
  const blind = { ...source, components: source.components.filter(part => part.kind !== 'weapon' && !(part.kind === 'sensor' && part.sensorMode === 'visual')), plates: source.plates.map(plate => ({ ...plate, material: 'steel' })) }, compiledBlind = compileBlueprint(blind),
    noView = byId(workshopChecklist(compiledBlind), 'vision');
  assert.deepEqual([noView.state, noView.target], ['attention', 'build']);
  assert(!compiledBlind.modules.some(part => part.sensorMode === 'visual'), 'the blind design has no optical camera');
  const glazed = structuredClone(blind);
  for (const plate of glazed.plates) { plate.material = 'glass'; plate.thicknessMm = Math.max(plate.thicknessMm, 40); }
  const compiledGlass = compileBlueprint(glazed), row = byId(workshopChecklist(compiledGlass), 'vision');
  assert.deepEqual([row.state, row.target], ['ready', 'adjust']);
  assert.match(row.detail, /650 m/);
  assert.equal(workshopReviewPart(compiledGlass, 'vision'), command.id);
});

test('an installed camera behind opaque armour is reported as blocked rather than ready', () => {
  const source = createConstruction('ifv'), command = source.components.find(part => part.kind === 'command');
  source.components = source.components.filter(part => part.kind !== 'sensor' && part.kind !== 'weapon' && part.id !== command.id);
  source.plates = source.plates.map(plate => ({ ...plate, material: 'steel' }));
  source.components.push({ id: 'inside-camera', kind: 'sensor', sensorMode: 'visual', pose: { ...command.pose } });
  const blueprint = compileBlueprint(source), row = byId(workshopChecklist(blueprint), 'vision');
  assert.deepEqual([row.state, row.target], ['attention', 'adjust']);
  assert.equal(row.detail, 'O casco tapa a câmera.');
  assert.equal(workshopReviewPart(blueprint, 'vision'), 'inside-camera');
});

test('what drives a vehicle or builds from one is pointed out on a fixed construction, and the review opens it', () => {
  const editor = new Editor(createStructuredTemplate('empty')), floor = editor.blueprint.plates.find(plate => plate.id === 'hull:floor').y;
  assert.equal(byId(workshopChecklist(editor.blueprint), 'fixed'), undefined);
  const engine = editor.addModule('engine', { x: 11, y: floor + .5 });
  assert.equal(byId(workshopChecklist(editor.blueprint), 'fixed').detail, 'Motor não serve numa construção fixa sem escavadeira ou perfuratriz.');
  editor.addModule('builder', { x: 12.5, y: floor + 2.1 });
  const fixed = byId(workshopChecklist(editor.blueprint), 'fixed');
  assert.equal(fixed.state, 'attention'); assert.equal(fixed.detail, 'Motor e braço construtor não servem numa construção fixa: ela não sai do lugar.');
  assert.equal(workshopReviewPart(editor.blueprint, 'fixed'), engine.id);
  // On a vehicle, they do their work.
  assert.equal(byId(review(createConstruction('construction-truck')), 'fixed'), undefined);
});

test('a structure takes an engine and a tank only for an excavator or a drill, which work on its power', () => {
  // The oil well: its drill works on its engine and its tank, and nothing of it is idle.
  const well = createConstruction('oil-well'), rows = review(well);
  assert.equal(byId(rows, 'fixed'), undefined);
  assert.deepEqual(['fuel', 'extraction'].map(id => byId(rows, id).state), ['ready', 'ready']);
  assert.equal(byId(rows, 'engine'), undefined, 'a structure has no row of what drives it');
  // Without its drill, the engine and the tank do nothing there.
  const idle = review(without(well, 'drill'));
  assert.deepEqual([byId(idle, 'fixed').state, byId(idle, 'fixed').detail], ['attention', 'Motor e combustível não servem numa construção fixa sem escavadeira ou perfuratriz.']);
  assert.equal(byId(idle, 'extraction'), undefined); assert.equal(byId(idle, 'fuel'), undefined);
  // Without its engine the drill does not work, and without its tank the engine does not turn.
  assert.deepEqual(['state', 'detail'].map(key => byId(review(without(well, 'engine')), 'extraction')[key]), ['attention', 'Sem motor: não extrai.']);
  assert.equal(byId(review(without(well, 'fuel')), 'fuel').state, 'attention');
  // An engine weaker than the drill asks has it pump at the share of its pace it gives.
  const weak = { ...well, components: well.components.map(part => part.kind === 'engine' ? { ...part, sizeScale: .7 } : part) },
    pumping = byId(review(weak), 'extraction'), engine = compileBlueprint(weak).modules.find(part => part.kind === 'engine');
  assert.equal(pumping.state, 'attention');
  assert.match(pumping.detail, new RegExp(`extrai a ${Math.floor(engine.powerKw / 150 * 100)} % do ritmo\\.$`));
});

test('a tool asks the engine for power by its size, and is told what it asks and what the engine gives', () => {
  // The bare tracked chassis, with a tool on its free bed, 2 m back and 2 m up (written in cells).
  const tracked = createConstruction('tracked'), fitted = (kind, sizeScale) => ({ ...tracked,
      components: [...tracked.components, { id: 'tool', kind, sizeScale, pose: { x: 40, y: 40, angle: 0 } }] }),
    given = compileBlueprint(tracked).modules.find(part => part.kind === 'engine').powerKw;
  for (const [kind, id, does] of [['excavator', 'extraction', 'extrai'], ['builder', 'building', 'monta']]) {
    // Of half the size, a quarter of the room, it asks 110 kW × 0.25^(5/6), which the engine gives: it is told so.
    const small = compileBlueprint(fitted(kind, .5)), asked = 110 * 4 ** (5 / 6), told = byId(workshopChecklist(small), id);
    assert(Math.abs(small.modules.find(part => part.id === 'tool').workKw - 110 * .25 ** (5 / 6)) < 1e-9);
    assert.equal(told.state, 'ready');
    assert(told.detail.endsWith(`A ferramenta pede ${power(110 * .25 ** (5 / 6))}; o motor dá ${power(given)}.`), told.detail);
    // Of twice the size, four times the room, it asks 110 kW × 4^(5/6), more than the engine gives: it works at the
    // share of its pace it gets.
    const large = byId(review(fitted(kind, 2)), id);
    assert(given < asked); assert.deepEqual([large.state, large.target], ['attention', 'adjust']);
    assert.match(large.detail, new RegExp(`${does} a ${Math.floor(given / asked * 100)} % do ritmo\\.$`));
    assert.equal(workshopReviewPart(compileBlueprint(fitted(kind, 2)), id), 'tool');
  }
});
