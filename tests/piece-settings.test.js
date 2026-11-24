import { vehicleBox } from './helpers/designs.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction, createStructuredConstruction } from '../src/structured-construction.ts';
import { pieceSettings, selectionSettings, steppedSetting, steppedSettings, typedSetting, typedSettings, applySettings, pieceFigures, chassisFigures, enginePower, chassisMetalChoices, sensorChoices, mountChoices, ammunitionBoxChoice, materialChoices, metalChoices, steelWorth, weight } from '../src/piece-settings.ts';
import { MATERIALS, MATERIAL_NOTES, MATERIAL_ORDER, MATERIAL_TAGS, METALS, MODULES, PIECE_METALS, choosesMetal, pieceMetals, takesMetal } from '../src/materials.ts';
import { componentDimensions, componentSizeLimits } from '../src/component-size.ts';
import { CHASSIS_MODELS, CHASSIS_GEAR_SCALE, chassisSpec, chassisTrack, frameThicknessMm, frameThicknessRange, roadWheelPitch, suspensionHeight, suspensionZero, writtenTrack } from '../src/chassis.ts';
import { CHASSIS_ID, withChassisThickness } from '../src/chassis-editing.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { blueprintPowertrain, installedPower, pieceMass } from '../src/mass-properties.ts';
import { power, specificPower } from '../src/format.ts';
import { withPieceProperty } from '../src/structured-editing.ts';
import { constructionCost, formatCredits, pieceCost } from '../src/construction-cost.ts';
import { cellOf } from '../src/grid.ts';
import { STOCKS, STOCK_IDS, billTotal, piecesBill } from '../src/economy.ts';

await initNativeDynamics();

// A model of the catalogue open in the workshop with one of its pieces selected, as the bar over it sees it. Its
// chassis is told with what its author wrote of it.
function selected(template, kind, source = createStructuredTemplate(template)) {
  const editor = new Editor(source),
    piece = kind === 'plate' ? editor.blueprint.plates[0] : kind === 'chassis' ? { id: CHASSIS_ID } : editor.blueprint.modules.find(module => module.kind === kind),
    part = () => kind === 'chassis' ? editor.source.chassis : editor.source.plates.find(candidate => candidate.id === piece.id) || editor.source.components.find(candidate => candidate.id === piece.id) || null,
    settings = () => pieceSettings(editor.selected, part());
  editor.select(piece.id);
  return { editor, id: piece.id, part, settings, setting: key => settings().find(candidate => candidate.key === key) };
}
const shown = ({ key, label, unit, min, max, step }) => ({ key, label, unit, min, max, step });
// One setting of the selected piece put to a value as the bar shows it.
const put = ({ editor, id, setting }, key, value) => applySettings(editor, key, new Map([[id, value / setting(key).per]]));

test('free adjustment steppers expose sub-five-centimetre length and suspension changes', () => {
  const chassis = { model: 'wheeled', points: [{ x: -60, y: 0 }, { x: 60, y: 0 }] },
    piece = { chassis: { ...chassis, suspension: .0125 } },
    free = pieceSettings(piece, chassis, { snap: false }).find(setting => setting.key === 'suspension'),
    grid = pieceSettings(piece, chassis, { snap: true }).find(setting => setting.key === 'suspension');
  assert.equal(free.value, 1.25); assert.equal(free.step, 1); assert.equal(free.fine, .1);
  assert.equal(typedSetting(free, '1,3'), 1.3); assert.equal(grid.step, 5); assert.equal(grid.fine, 5);
  const plate = { material: 'steel', thicknessMm: 5, length: .503, angle: 0 },
    length = pieceSettings(plate, null, { snap: false }).find(setting => setting.key === 'length');
  assert.equal(length.step, .01); assert.equal(steppedSetting(length, 1), .51);
  assert.equal(typedSetting(length, '.507'), .507, 'numeric length remains exact to its published millimetre input precision');
  const tracked = { ...chassis, model: 'tracked' },
    fields = pieceSettings({ chassis: { ...tracked, suspension: .0125 } }, tracked, { snap: false }),
    measures = fields.filter(setting => setting.key.startsWith('track'));
  assert.deepEqual(measures.map(setting => setting.key), ['trackLength', 'trackHeight', 'trackX'], 'no vertical place: the track stays on the floor');
  assert.deepEqual(fields.find(setting => setting.key === 'suspension'), free, 'the hull rides over a track as over wheels');
  assert(measures.every(setting => setting.unit === 'm' && setting.step === .01 && setting.fine === 0));
  assert.equal(typedSetting(measures.find(setting => setting.key === 'trackLength'), '5,123456789'), 5.123456789,
    'typing a free track dimension does not quantize it to the grid or to wheel count');
});

test('frame gauge uses real metal millimetres and uniform gear size is separate from hull and gear armour', () => {
  for (const model of Object.keys(CHASSIS_MODELS)) for (const metal of ['steel', 'aluminum', 'titanium']) {
    const part = { model, metal, points: [{ x: -120, y: 0 }, { x: 120, y: 0 }] }, fields = pieceSettings({ chassis: { model } }, part),
      frame = fields.find(field => field.key === 'frameThicknessMm'), tracked = model === 'tracked',
      // Skids are sized as wheels are, and an aircraft is set how high it stands over them.
      skids = model === 'aircraft',
      gear = fields.find(field => field.key === (tracked ? 'trackHeight' : 'gearScale')),
      limits = frameThicknessRange(part);
    assert(Math.abs(frame.value - frameThicknessMm(part)) < 1e-9);
    assert.deepEqual([frame.min, frame.max], [limits.min, limits.max]);
    assert.equal(frame.unit, 'mm'); assert.equal(frame.fine, .1);
    const per = tracked ? chassisSpec(model).track : 100;
    if (skids) assert.deepEqual([fields.map(field => field.key), gear.label], [['frameThicknessMm', 'gearScale', 'suspension'], 'Tamanho dos esquis']);
    assert.deepEqual([gear.value, gear.min, gear.max, gear.step], [per, CHASSIS_GEAR_SCALE.min * per, CHASSIS_GEAR_SCALE.max * per, tracked ? .05 : 5]);
    if (tracked) assert(!fields.some(field => field.key === 'gearScale') && fields.some(field => field.key === 'suspension'),
      'track dimensions replace the percentage; the suspension stays, as on wheels');
    assert.equal(fields.some(field => field.key === 'thicknessMm'), false, 'a batch of hull plates never changes the frame gauge');
    assert.equal(typedSetting(frame, '12,8'), 12.8);
  }
  const source = createStructuredTemplate('chassis'), before = structuredClone(source);
  assert.throws(() => withPieceProperty(source, CHASSIS_ID, 'thicknessMm', 30), /chassi não tem esse ajuste/);
  assert.deepEqual(source, before, 'an unknown setting cannot silently change gear armour');
});

test('the inspector changes frame gauge and running-gear height atomically and with one undo', () => {
  for (const template of ['chassis', 'tracked']) {
    const source = createStructuredTemplate(template);
    if (template === 'chassis') source.chassis.axles = [-40, 40];
    // A track a road wheel shorter than the factory's and written 8 cm over the floor comes into the Oficina on it,
    // the hull 8 cm lower with it.
    if (template === 'tracked') {
      const track = chassisTrack(source.chassis);
      source.chassis.track = writtenTrack(source.chassis, track.front, track.rear - roadWheelPitch(source.chassis.model, source.chassis), track.y + .08);
    }
    const chassis = selected(template, 'chassis', source), { editor } = chassis, before = structuredClone(editor.source),
      base = editor.blueprint, gauge = chassis.setting('frameThicknessMm').value;
    if (template === 'tracked') {
      const track = chassisTrack(before.chassis);
      assert(Math.abs(track.y - track.height / 2 - (chassisTrack(source.chassis).y - .08 - track.height / 2)) < 1e-9, 'on the floor');
      assert.deepEqual(before.chassis.points, source.chassis.points.map(point => ({ ...point, y: point.y - 2 })));
    }
    put(chassis, 'frameThicknessMm', gauge + 2);
    assert.equal(editor.source.chassis.thicknessMm, gauge + 2);
    assert(editor.blueprint.chassis.emptyKg > base.chassis.emptyKg);
    assert.equal(editor.source.chassis.armorMm, before.chassis.armorMm, 'structural gauge is not running-gear armour');
    assert.equal(editor.past.length, 1); assert.equal(editor.selection, CHASSIS_ID);
    editor.undo(); assert.deepEqual(editor.source, before); editor.select(CHASSIS_ID);
    const gear = base.modules.filter(part => ['wheel', 'track'].includes(part.kind));
    const tracked = template === 'tracked', key = tracked ? 'trackHeight' : 'gearScale',
      height = chassisSpec(source.chassis.model).track * 1.2;
    put(chassis, key, tracked ? height : 120);
    const changed = editor.blueprint.modules.filter(part => ['wheel', 'track'].includes(part.kind));
    assert.equal(editor.source.chassis.gearScale, 1.2);
    if (tracked) {
      const track = chassisTrack(editor.source.chassis), was = chassisTrack(before.chassis),
        lift = suspensionZero(editor.source.chassis) - suspensionZero(before.chassis);
      assert.deepEqual([track.front, track.rear], [was.front, was.rear], 'height keeps both ends');
      assert(Math.abs(track.y - track.height / 2 - (was.y - was.height / 2)) < 1e-9, 'its belt stays on the floor');
      assert(lift > 0); assert.equal(suspensionHeight(editor.source.chassis), suspensionHeight(before.chassis));
      assert.deepEqual(editor.source.chassis.points, before.chassis.points.map(point => ({ ...point, y: point.y + lift })), 'the hull rises with it');
      assert.deepEqual(editor.source.nodes, before.nodes.map(node => ({ ...node, y: node.y + lift })));
    }
    assert.equal(new Set(changed.map(part => part.kind)).size, 1, 'the chassis keeps only its own type of running gear');
    // At 120 % of the size of the model, from the size the factory gave them.
    assert(changed.every(part => Math.abs(part.height - gear[0].height / (before.chassis.gearScale ?? 1) * 1.2) < 1e-8), 'all wheels have the same new diameter');
    assert.equal(editor.past.length, 1); assert.equal(editor.selection, CHASSIS_ID);
    editor.undo(); assert.deepEqual(editor.source, before); editor.select(CHASSIS_ID);
    for (const [key, value] of [['frameThicknessMm', 500], [tracked ? 'trackHeight' : 'gearScale', tracked ? chassisSpec(source.chassis.model).track * 1.51 : 151]]) {
      assert.throws(() => put(chassis, key, value), error => error.code === 'STRUCTURED_CONSTRUCTION');
      assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
    }
    editor.editProperty('frameThicknessMm', gauge + 1, true);
    assert.equal(editor.source.chassis.thicknessMm, gauge + 1, 'the Editor property path admits the same real adjustment');
    editor.undo(); assert.deepEqual(editor.source, before);
  }
});

test('chassis material previews quote the real structure and running gear without changing their gauge', () => {
  for (const template of ['chassis', 'tracked']) {
    const source = withChassisThickness(createStructuredTemplate(template), 40);
    const editor = new Editor(source), before = structuredClone(editor.source), choices = chassisMetalChoices(editor.source);
    assert.deepEqual(editor.source, before, 'opening the material menu does not edit the project');
    let changes = 0;
    for (const choice of choices) {
      let changed;
      try { changed = editor.setChassisMetal(choice.id); }
      catch (error) {
        assert(['CHASSIS_OVERLOAD', 'STRUCTURED_CONSTRUCTION'].includes(error.code));
        assert.equal(choice.disabled, true);
        assert(choice.detail.length > 0, 'a refused material explains the actual compiler refusal');
        assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
        continue;
      }
      assert(!choice.disabled, 'an admitted metal is available in the preview');
      assert.equal(editor.source.chassis.thicknessMm, 40, 'material changes keep the authored millimetres');
      const made = editor.blueprint, bill = constructionCost(made), ids = new Set(made.chassis.plates);
      assert(made.plates.filter(plate => ids.has(plate.id) && !plate.id.startsWith('chassis:top-')).every(plate => plate.material === choice.id));
      const gear = made.modules.filter(part => made.chassis.gear.includes(part.id));
      assert(gear.length > 0 && gear.every(part => (part.metal ?? 'steel') === choice.id), 'the same material reaches every wheel or the entire track');
      // The frame, its floor and the gear with its rubber and armour, by the stocks that pay them: that of the metal for
      // what is of it, Ferro for the rest (`kept`).
      const paid = piecesBill([...made.plates.filter(plate => ids.has(plate.id)), ...gear]),
        stocks = [METALS[choice.id].stock, ...STOCK_IDS.filter(id => id !== METALS[choice.id].stock)].filter(id => paid[id] > 0);
      assert.equal(billTotal(paid), bill.chassis + gear.reduce((n, p) => n + pieceCost(p), 0) + made.plates.filter(p => p.id.startsWith('chassis:top-')).reduce((n, p) => n + pieceCost(p), 0), 'both installed assemblies');
      assert(choice.detail.includes(`· ${stocks.map(id => `${formatCredits(paid[id])} em ${STOCKS[id]}`).join(' e ')} · limite:`), choice.detail);
      assert(choice.detail.endsWith('limite: ' + weight(made.chassis.limitKg)), 'capacity is read from this compiled material and gauge');
      if (changed) { changes++; assert.equal(editor.past.length, 1); editor.undo(); }
      assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
    }
    assert(changes > 0, 'the fixture admits at least one alternative material');
  }
});

test('an engine line tells its power and the hp/t of all the engines with everything full, whatever fuel there is', () => {
  const engine = selected('scout', 'engine'), { editor } = engine, compiled = editor.blueprint, piece = editor.selected,
    all = compiled.modules.filter(part => part.kind === 'engine').reduce((sum, part) => sum + part.powerKw, 0);
  assert.equal(installedPower(compiled), all);
  assert.equal(enginePower(compiled, piece), `${power(piece.powerKw)} · ${specificPower(all, compiled.chassis.loadedKg / 1000)}`);
  assert.match(enginePower(compiled, piece) + ' · ' + pieceFigures(piece), /^\d+ hp · [\d,]+ hp\/t · [\d.,]+ (kg|t) · [\d.]+ cr$/);
  // With no fuel to burn the drivetrain gives nothing, but the engines are as strong as installed.
  const dry = compileStructuredConstruction({ ...editor.source, components: editor.source.components.filter(part => part.kind !== 'fuel') });
  assert.equal(blueprintPowertrain(dry).powerKw, 0);
  assert.equal(installedPower(dry), all);
  assert.equal(enginePower({ ...compiled, chassis: null }, piece), power(piece.powerKw), 'a design with no chassis has no vehicle weight to tell');
});

test('a free track-end grip keeps the exact physical length change and undo preserves the height and centre', () => {
  const source = createStructuredTemplate('tracked');
  const originalTrack = chassisTrack(source.chassis);
  // The enlarged belt clears the floor by 7 mm without exceeding the suspension's 0.2 m reach.
  source.chassis.track = writtenTrack(source.chassis, originalTrack.front, originalTrack.rear - roadWheelPitch(source.chassis.model, source.chassis), originalTrack.y + .08);
  const chassis = selected('tracked', 'chassis', source), { editor } = chassis;
  put(chassis, 'trackHeight', chassisSpec(source.chassis.model).track * 1.2);
  const before = structuredClone(editor.source), track = chassisTrack(before.chassis),
    distance = .137123, hit = editor.gearHandle('track-rear');
  editor.snap = false;
  editor.begin();
  assert.equal(editor.moveGear(hit, { x: hit.x - distance, y: hit.y }), true);
  editor.commit();
  const shortened = chassisTrack(editor.source.chassis);
  assert(Math.abs(track.rear - shortened.rear - distance) < 1e-9);
  assert.equal(shortened.front, track.front); assert.equal(shortened.y, track.y); assert.equal(shortened.height, track.height);
  assert(!Number.isInteger(editor.source.chassis.track.rear), 'a free drag keeps a fractional authored end');
  assert.equal(editor.source.chassis.gearScale, 1.2);
  editor.undo(); assert.deepEqual(editor.source, before);
});

test('resizing an engine changes its line, and undo restores it', () => {
  const engine = selected('heavy', 'engine', vehicleBox({height: 3, components: [{id:'engine', kind:'engine', pose:{x:0,y:1,angle:0}}]})), { editor } = engine, piece = () => editor.blueprint.modules.find(part => part.id === engine.id),
    line = () => enginePower(editor.blueprint, piece()), before = line(), power = piece().powerKw, size = engine.setting('sizeScale');
  put(engine, 'sizeScale', steppedSetting(size, 1));
  assert(piece().powerKw > power); assert.notEqual(line(), before);
  editor.undo(); assert.equal(line(), before);
});

test('the bar over a piece has a stepper for each thing a player sets on it, and nothing for the rest', () => {
  const keys = (template, kind) => selected(template, kind).settings().map(setting => setting.key);
  assert.deepEqual(keys('heavy', 'plate'), ['thicknessMm', 'length', 'angle']);
  // A track exposes independent physical dimensions; wheels their common size. Both keep the suspension over them.
  assert.deepEqual(keys('heavy', 'chassis'), ['frameThicknessMm', 'trackLength', 'trackHeight', 'trackX', 'suspension', 'armorMm', 'topPlateThicknessMm']);
  assert.deepEqual(keys('scout', 'chassis'), ['axleCount', 'frameThicknessMm', 'gearScale', 'suspension', 'armorMm', 'topPlateThicknessMm']);
  assert.deepEqual(keys('heavy', 'engine'), ['sizeScale', 'angle']);
  for (const kind of ['fuel', 'ammo']) assert.deepEqual(keys('heavy', kind), ['sizeScale', 'angle'], kind);
  for (const kind of ['command', 'sensor']) assert.deepEqual(keys('heavy', kind), ['angle'], kind);
  // A gun is made over in the workshop: its barrel, its calibre, its charge, its projectile and its magazine; a cannon turns
  // no barrels and has no rate to set (weapon-variants.test.js).
  assert.deepEqual(keys('heavy', 'weapon'), ['barrelLength', 'calibre', 'charge', 'projectile', 'magazine', 'angle']);
  assert.deepEqual(pieceSettings(null), []);

  // Up to what the gear of its model may wear: a track more than wheels.
  const tracked = selected('heavy', 'chassis'), wheeled = selected('scout', 'chassis'), engine = selected('heavy', 'engine'), size = componentSizeLimits(engine.part());
  assert.deepEqual([tracked.part(), wheeled.part()].map(part => chassisSpec(part.model).kind), ['tracked', 'wheeled']);
  assert.deepEqual(shown(tracked.setting('armorMm')), { key: 'armorMm', label: 'Blindagem da rodagem', unit: 'mm', min: 0, max: CHASSIS_MODELS.tracked.armourMm, step: 5 });
  assert.deepEqual(shown(wheeled.setting('armorMm')), { key: 'armorMm', label: 'Blindagem da rodagem', unit: 'mm', min: 0, max: 40, step: 5 });
  assert.equal(CHASSIS_MODELS.tracked.armourMm, 80);
  assert.deepEqual(shown(engine.setting('sizeScale')), { key: 'sizeScale', label: 'Tamanho', unit: '%', min: Math.round(size.min * 100), max: Math.round(size.max * 100), step: 10 });
  assert.deepEqual(shown(selected('heavy', 'plate').setting('thicknessMm')), { key: 'thicknessMm', label: 'Espessura', unit: 'mm', min: 5, max: 1000, step: 5 });
  // A plate goes down to what its armour stands as a plate, and says so at that end.
  assert.deepEqual(Object.keys(MATERIALS).map(material => { const [{ min, ends }] = pieceSettings({ material, thicknessMm: 60 }); return [material, min, ends[0]]; }), [
    ['steel', 5, 'Uma chapa de aço tem ao menos 5 mm.'], ['aluminum', 8, 'Uma chapa de alumínio tem ao menos 8 mm.'],
    ['ceramic', 8, 'Uma chapa de cerâmica tem ao menos 8 mm.'], ['concrete', 50, 'Uma chapa de concreto tem ao menos 50 mm.'],
    ['hha', 5, 'Uma chapa de aço de alta dureza tem ao menos 5 mm.'], ['titanium', 6, 'Uma chapa de titânio tem ao menos 6 mm.'],
    ['fiberglass', 10, 'Uma chapa de fibra de vidro tem ao menos 10 mm.'], ['glass', 15, 'Uma chapa de vidro blindado tem ao menos 15 mm.']]);
  // Each says, in a line, why a press at either end of its range changes nothing.
  for (const setting of [...tracked.settings(), ...wheeled.settings(), ...engine.settings(), ...selected('heavy', 'ammo').settings(), ...selected('heavy', 'plate').settings()]) {
    assert.equal(setting.ends.length, 2, setting.key);
    for (const line of setting.ends) assert.match(line, /^[A-ZÀ-Ú].*\.$/, setting.key);
  }
  assert.match(tracked.setting('armorMm').ends[1], /rodagem deste chassi vai até 80 mm/); assert.match(wheeled.setting('armorMm').ends[0], /rodagem já está sem blindagem/);
  // What a piece weighs and costs is one line beside them; of the chassis, its length too, and all of its frame and gear.
  for (const kind of ['plate', 'engine', 'sensor']) assert.match(pieceFigures(selected('heavy', kind).editor.selected), /^[\d.,]+ (kg|t) · [\d.]+ cr$/, kind);
  assert.match(chassisFigures(tracked.editor.blueprint), /^7 m · [\d,]+ t · [\d.]+ cr$/);
});

test('the length field uses physical stock limits and changes the whole plate without moving its centre', () => {
  const blank = { ...createStructuredTemplate('empty'), components: [], nodes: [{id:'a',x:-30,y:20},{id:'b',x:30,y:20}], plates:[{id:'blank',a:'a',b:'b',material:'steel',thicknessMm:10,ends:{start:1,end:0}}] };
  const hull = selected('empty', 'plate', blank), { editor, setting } = hull,
    before = structuredClone(editor.source), piece = editor.selected, stock = (hull.part().ends.start + (hull.part().ends.end ?? 0)) / 20,
    length = setting('length'), history = editor.past.length;
  assert.equal(stock, .05, 'the factory floor has real stock past its first joint');
  assert.deepEqual(shown(length), { key: 'length', label: 'Comprimento', unit: 'm', min: .13, max: 12.05, step: .05 });
  assert.equal(length.fine, .001); assert.equal(length.value, Number(piece.length.toFixed(6)));
  const values = typedSettings({ ...length, each: [length], ids: [hull.id] }, '2,617');
  assert.deepEqual(applySettings(editor, 'length', values), { refused: [] });
  assert(Math.abs(editor.selected.length - 2.617) < 1e-9);
  assert(Math.hypot(editor.selected.x - piece.x, editor.selected.y - piece.y) < 1e-9, 'numeric length keeps the physical centre');
  assert.deepEqual(editor.source.plates.find(plate => plate.id === hull.id).ends, before.plates.find(plate => plate.id === hull.id).ends);
  assert.deepEqual(editor.source.components, before.components);
  assert.deepEqual(editor.source.plates.filter(plate => plate.id !== hull.id), before.plates.filter(plate => plate.id !== hull.id));
  assert.equal(editor.past.length, history + 1); assert(editor.undo()); assert.deepEqual(editor.source, before);
});

test('a press goes to the next multiple of the step and stops at the ends of the range', () => {
  const armour = { value: 12, step: 5, min: 0, max: 80 };
  assert.deepEqual([steppedSetting(armour, 1), steppedSetting(armour, -1)], [15, 10], 'a value off the grid goes to it');
  assert.deepEqual([steppedSetting({ ...armour, value: 15 }, 1), steppedSetting({ ...armour, value: 15 }, -1)], [20, 10]);
  assert.deepEqual([steppedSetting({ ...armour, value: 78 }, 1), steppedSetting({ ...armour, value: 3 }, -1)], [80, 0], 'the last press stops at the end');
  assert.deepEqual([steppedSetting({ ...armour, value: 80 }, 1), steppedSetting({ ...armour, value: 0 }, -1)], [null, null]);
  // Sizes are kept as fractions and shown in percent: the rounding of one never loses a step of the other.
  const size = selected('heavy', 'engine').setting('sizeScale'), up = steppedSetting(size, 1), down = steppedSetting(size, -1);
  assert.equal(up % 10, 0); assert.equal(down % 10, 0); assert(down < size.value && size.value < up && up - down <= 20);
  assert.deepEqual([steppedSetting({ value: 110, step: 10, min: 25, max: 235 }, 1), steppedSetting({ value: 230, step: 10, min: 25, max: 235 }, 1),
    steppedSetting({ value: 30, step: 10, min: 25, max: 235 }, -1), steppedSetting({ value: 25, step: 10, min: 25, max: 235 }, -1)], [120, 235, 25, null]);
});

test('a typed value rests on the fine grid of its setting, inside its range, and what is no number is not taken', () => {
  const armour = selected('heavy', 'chassis').setting('armorMm'), size = selected('heavy', 'engine').setting('sizeScale');
  assert.deepEqual(['37', ' 12,4 ', '12.6', '900', '-3'].map(text => typedSetting(armour, text)), [37, 12, 13, 80, 0]);
  assert.deepEqual(['123', '127.5', '5', '1000'].map(text => typedSetting(size, text)), [125, 130, size.min, size.max]);
  for (const text of ['', '   ', 'abc', '1e999']) assert(Number.isNaN(typedSetting(armour, text)), JSON.stringify(text));
});

test('a setting put to a value is one edit of the project, undone in one step', () => {
  for (const [template, kind, key, value, kept] of [['heavy', 'chassis', 'armorMm', 25, 25], ['scout', 'chassis', 'armorMm', 40, 40],
    ['heavy', 'fuel', 'sizeScale', 80, .8]]) {
    const { editor, id, part, setting } = selected(template, kind), before = structuredClone(editor.source), history = editor.past.length;
    assert.deepEqual(put({ editor, id, setting }, key, value), { refused: [] });
    assert.equal(part()[key], kept, key); assert.equal(setting(key).value, value); assert.equal(editor.selection, id);
    assert.equal(editor.past.length, history + 1); editor.undo(); assert.deepEqual(editor.source, before);
  }
  // The armour of the gear taken back to none is not written.
  const chassis = selected('heavy', 'chassis'); put(chassis, 'armorMm', 25); put(chassis, 'armorMm', 0);
  assert.equal(Object.hasOwn(chassis.part(), 'armorMm'), false); assert.equal(chassis.setting('armorMm').value, 0);
  const plate = selected('heavy', 'plate'); put(plate, 'thicknessMm', 40);
  assert.equal(plate.editor.source.plates.find(candidate => candidate.id === plate.id).thicknessMm, 40); assert.equal(plate.setting('thicknessMm').value, 40);
});

test('what the compiler refuses is not kept: the project, its history and the selection stay as they were', () => {
  for (const [template, kind, key, value] of [['heavy', 'chassis', 'armorMm', 85], ['scout', 'chassis', 'armorMm', 45],
    ['heavy', 'plate', 'thicknessMm', 1005], ['heavy', 'fuel', 'sizeScale', 500]]) {
    const { editor, id, setting } = selected(template, kind), before = structuredClone(editor.source), history = editor.past.length;
    assert.throws(() => put({ editor, id, setting }, key, value),
      error => ['STRUCTURED_CONSTRUCTION', 'CONSTRUCTION_OVERLAP', 'COMPONENT_NO_SPACE'].includes(error.code), `${kind} ${key} ${value}`);
    assert.deepEqual(editor.source, before); assert.equal(editor.past.length, history); assert.equal(editor.selection, id);
  }
});

test('an interior part grows in its authored cell as one reversible edit without moving neighbours', () => {
  const reserve = selected('heavy', 'ammo', vehicleBox({height: 3, components: [{id:'ammo', kind:'ammo', ammoPreset:'rh120', pose:{x:0,y:1,angle:0}}]})), before = structuredClone(reserve.editor.source),
    grown = steppedSetting(reserve.setting('sizeScale'), 1), deck = reserve.editor.blueprint.frame.origin.y,
    history = reserve.editor.past.length;
  assert.deepEqual(put(reserve, 'sizeScale', grown), { refused: [] });
  assert.equal(reserve.setting('sizeScale').value, grown); assert.equal(reserve.editor.selection, reserve.id);
  assert.deepEqual(reserve.part().pose, before.components.find(part => part.id === reserve.id).pose);
  assert.deepEqual(reserve.editor.source.components.filter(part => part.id !== reserve.id), before.components.filter(part => part.id !== reserve.id));
  assert.equal(reserve.editor.blueprint.frame.origin.y, deck, 'the hull stays on its chassis');
  assert.equal(reserve.editor.past.length, history + 1); assert(reserve.editor.undo()); assert.deepEqual(reserve.editor.source, before);
});

test('several pieces are set together in what all of them have, each from the value it has, as one edit', () => {
  // Three tanks in the stock box, as the bar over them reads them, and an engine.
  const editor = new Editor(createStructuredConstruction({ thicknessMm: 10 })), deck = editor.blueprint.frame.origin.y,
    authored = id => editor.source.components.find(part => part.id === id) || null,
    tanks = [10.4, 11.6, 12.8].map(x => editor.addModule('fuel', { x, y: deck + .6 }).id), engine = editor.addModule('engine', { x: 14, y: deck + .6 }).id,
    told = () => editor.selectedPieces.map(piece => ({ piece, part: authored(piece.id) })),
    shared = key => selectionSettings(told()).find(setting => setting.key === key), sizes = () => tanks.map(id => authored(id).sizeScale ?? 1);
  editor.select(tanks);
  assert.deepEqual(selectionSettings(told()).map(setting => setting.key), ['sizeScale', 'angle']);
  assert.equal(shared('sizeScale').value, 100); assert.deepEqual(shared('sizeScale').ids, editor.selectedPieces.map(piece => piece.id));
  // One press takes all three a step up: one edit, undone in one, the selection as it was.
  const before = structuredClone(editor.source), history = editor.past.length;
  assert.deepEqual(applySettings(editor, 'sizeScale', steppedSettings(shared('sizeScale'), 1)), { refused: [] });
  assert.deepEqual(sizes(), [1.1, 1.1, 1.1]);
  assert.equal(editor.past.length, history + 1); assert.deepEqual([...editor.selectionIds].sort(), [...tanks].sort());
  editor.undo(); assert.deepEqual(editor.source, before);
  // Tanks of different sizes show no value, and each steps from its own.
  applySettings(editor, 'sizeScale', new Map([[tanks[0], .8]])); editor.select(tanks);
  assert.equal(shared('sizeScale').value, null);
  applySettings(editor, 'sizeScale', steppedSettings(shared('sizeScale'), 1)); assert.deepEqual(sizes(), [.9, 1.1, 1.1]);
  // A typed value is that of every one of them, and a piece that has it already is asked nothing.
  const typed = typedSettings(shared('sizeScale'), '110'); assert.deepEqual([...typed], [[tanks[0], 1.1]]);
  applySettings(editor, 'sizeScale', typed); assert.equal(shared('sizeScale').value, 110);
  assert.equal(typedSettings(shared('sizeScale'), 'abc').size, 0); assert.equal(typedSettings(shared('sizeScale'), '110').size, 0);
  // With every one of them at the end of its range a press asks nothing, and the bar says why.
  applySettings(editor, 'sizeScale', typedSettings(shared('sizeScale'), '25')); assert.equal(shared('sizeScale').value, 25);
  assert.equal(steppedSettings(shared('sizeScale'), -1).size, 0); assert.match(shared('sizeScale').ends[0], /^Nenhuma das peças selecionadas/);
  // A setting belongs only to the pieces that own it, including a mixed selection.
  editor.select([tanks[0], engine]); assert.deepEqual(selectionSettings(told()).map(setting => setting.key), ['sizeScale', 'angle']);
  const plateId = editor.blueprint.plates[0].id;
  editor.select([tanks[0], plateId]);
  const mixed = selectionSettings(told());
  assert.deepEqual(mixed.map(setting => setting.key).sort(), ['angle', 'length', 'sizeScale', 'thicknessMm']);
  assert.deepEqual(mixed.find(setting => setting.key === 'sizeScale').ids, [tanks[0]]);
  assert.deepEqual(mixed.find(setting => setting.key === 'thicknessMm').ids, [plateId]);
  assert.deepEqual(selectionSettings([]), []);
  // The range of plates of several armours takes in that of each, and their thickness is stepped as any setting.
  const hull = new Editor(createStructuredTemplate('heavy')), plates = hull.blueprint.plates.slice(0, 3).map(plate => plate.id),
    armour = () => selectionSettings(hull.selectedPieces.map(piece => ({ piece })))[0], thick = () => plates.map(id => hull.source.plates.find(plate => plate.id === id).thicknessMm);
  hull.select(plates); const was = thick();
  assert.deepEqual([armour().key, armour().value, armour().min], ['thicknessMm', null, 5]); assert.equal(new Set(was).size, 2);
  applySettings(hull, 'thicknessMm', steppedSettings(armour(), 1)); assert.deepEqual(thick(), was.map(mm => Math.floor(mm / 5) * 5 + 5));
  // Their armour is chosen for all at once: a list that tells what the three would weigh and cost, and one edit.
  const choices = materialChoices(hull.selectedPieces), alone = hull.selectedPieces.map(plate => materialChoices([plate]));
  assert.deepEqual(choices.map(choice => choice.id), alone[0].map(choice => choice.id));
  for (const choice of choices) assert.match(choice.detail, /^[\d.,]+ (kg|t) · [\d.]+ cr em (Ferro|Ligas|Sílica)( e [\d.]+ cr em Ferro)?$/,
    'plates of several thicknesses are told by weight and cost alone, with the stocks that pay it');
  const credits = detail => Number(detail.match(/([\d.]+) cr em/)[1].replaceAll('.', ''));
  assert.equal(credits(choices[2].detail), alone.reduce((sum, own) => sum + credits(own[2].detail), 0));
  const steps = hull.past.length;
  assert.deepEqual(applySettings(hull, 'material', new Map(plates.map(id => [id, 'aluminum']))), { refused: [] });
  assert.deepEqual(plates.map(id => hull.source.plates.find(plate => plate.id === id).material), ['aluminum', 'aluminum', 'aluminum']);
  assert.equal(hull.past.length, steps + 1); assert.equal(hull.selectionIds.size, 3);
});

test('of several pieces asked for more than there is room for, those that have it change and the others stay as they were', () => {
  // Two tanks in a hull 1.6 m high, one of them half as large again: pressed up together until the hull is too low for the larger.
  const editor = new Editor(createStructuredConstruction({ thicknessMm: 10 })), ride = Math.min(...editor.blueprint.frame.nodes.map(node => node.y)),
    large = editor.addModule('fuel', { x: 10.5, y: ride + .8 }, { sizeScale: 1.5 }).id, small = editor.addModule('fuel', { x: 13.6, y: ride + .8 }).id,
    size = id => editor.source.components.find(part => part.id === id).sizeScale,
    shared = () => selectionSettings(editor.selectedPieces.map(piece => ({ piece, part: editor.source.components.find(part => part.id === piece.id) })))[0];
  editor.select([large, small]);
  let out, before, history, presses = 0;
  do {
    before = { large: size(large), small: size(small) }; history = editor.past.length;
    out = applySettings(editor, 'sizeScale', steppedSettings(shared(), 1));
  } while (!out.refused.length && ++presses < 40);
  assert.deepEqual(out.refused, [large], `after ${presses} presses`);
  assert.equal(size(large), before.large, 'the one with no room is as it was'); assert(Math.abs(size(small) - before.small - .1) < 1e-9, 'the other went its step');
  assert.equal(editor.past.length, history + 1, 'what changed is one edit'); assert.equal(editor.selectionIds.size, 2);
  // Asked for what neither has room for, nothing is kept and the refusal is the compiler's.
  const kept = structuredClone(editor.source);
  assert.throws(() => applySettings(editor, 'sizeScale', new Map([[large, 4.5], [small, 4.5]])), error => ['STRUCTURED_CONSTRUCTION', 'CONSTRUCTION_OVERLAP'].includes(error.code));
  assert.deepEqual(editor.source, kept); assert.equal(editor.past.length, history + 1);
});

test('a plate is given its armour from a list that says what it would weigh, be worth in steel and cost in each', () => {
  // A real front of a closed hull: the core supplies its end joints, length and installed mass.
  // What does not drive may be of any armour; a hull that drives, of any but concrete. It is 1.7 m, 34 cells, the
  // nearest the grid writes to the 1.7033 m it once was: what it weighs and costs is .2 % less than it was.
  const source = createStructuredConstruction({ preset: 'bunker', chassis: null, length: 1.7, height: 1.7,
      thicknessMm: 5, frontInset: 0, rearInset: 0 }),
    frontOf = source => compileStructuredConstruction(source).plates.find(plate => plate.id === 'hull:front'),
    plate = frontOf(source), choices = materialChoices([plate], true);
  assert(Math.abs(plate.length - 1.7) < 1e-9, 'a new free plate has the authored blank length without automatic end caps');
  assert(Math.abs(pieceMass(plate) - 1.7 * 2.4 * .005 * MATERIALS.steel.density) < 1e-8);
  assert.deepEqual(choices.map(choice => choice.id), MATERIAL_ORDER);
  assert.deepEqual(materialChoices([plate]).map(choice => choice.id), MATERIAL_ORDER.filter(id => id !== 'concrete'));
  assert.deepEqual(materialChoices([plate]), choices.slice(0, -1));
  for (const choice of choices) assert.deepEqual([choice.name, choice.tag, choice.note], [MATERIALS[choice.id].name, MATERIAL_TAGS[choice.id], MATERIAL_NOTES[choice.id]]);
  // No armour but steel stands as a plate of 5 mm: each of the others is told at the least thickness of its own,
  // which the plate would take with it. Each is told in the stock it is paid from; concrete in Sílica, for its sand,
  // gravel and cement, and in Ferro for its bar, the stock that pays the most first.
  assert.deepEqual(choices.map(choice => choice.detail), ['159 kg · ≈ 5,0 mm de aço · 223 cr em Ferro', '160 kg · ≈ 6,2 mm de aço · 417 cr em Ferro',
    'com 8 mm · 88 kg · ≈ 3,1 mm de aço · 283 cr em Ligas', 'com 6 mm · 110 kg · ≈ 5,4 mm de aço · 1.322 cr em Ligas', 'com 8 mm · 114 kg · ≈ 8,3 mm de aço · 686 cr em Sílica',
    'com 10 mm · 80 kg · ≈ 2,4 mm de aço · 255 cr em Sílica', 'com 15 mm · 153 kg · ≈ 2,4 mm de aço · 1.377 cr em Sílica',
    'com 50 mm · 479 kg · ≈ 7,2 mm de aço · 384 cr em Sílica e 29 cr em Ferro']);
  // A plate thick enough for all of them is told at the thickness it has, in every one.
  const thickSource = structuredClone(source);
  for (const plate of thickSource.plates) plate.thicknessMm = 60;
  const thick = frontOf(thickSource);
  assert(Math.abs(thick.length - plate.length) < 1e-9, 'changing gauge cannot grow the authored blank');
  assert(Math.abs(pieceMass(thick) - 1.7 * 2.4 * .06 * MATERIALS.steel.density) < 1e-8);
  assert.deepEqual(materialChoices([thick], true).map(choice => choice.detail), ['1,9 t · ≈ 60 mm de aço · 2.674 cr em Ferro', '1,9 t · ≈ 74 mm de aço · 4.997 cr em Ferro',
    '661 kg · ≈ 23 mm de aço · 2.116 cr em Ligas', '1,1 t · ≈ 54 mm de aço · 13.220 cr em Ligas', '857 kg · ≈ 62 mm de aço · 5.141 cr em Sílica',
    '477 kg · ≈ 14 mm de aço · 1.528 cr em Sílica', '612 kg · ≈ 9,6 mm de aço · 5.508 cr em Sílica', '575 kg · ≈ 8,6 mm de aço · 461 cr em Sílica e 34 cr em Ferro']);
  // Whatever the plate is made of now, the list is the same.
  const concreteSource = structuredClone(thickSource);
  for (const plate of concreteSource.plates) plate.material = 'concrete';
  assert.deepEqual(materialChoices([frontOf(concreteSource)], true), materialChoices([thick], true));
  // Under ten millimetres the steel is told to the tenth, where whole numbers would make two armours look alike; from ten on, whole.
  assert.deepEqual([steelWorth(8, 'steel'), steelWorth(8, 'hha'), steelWorth(10, 'steel'), steelWorth(100, 'concrete'), steelWorth(260, 'concrete'), steelWorth(1000, 'steel')],
    ['8,0', '9,9', '10', '14', '37', '1.000']);
});

test('a sensor is given its way of detecting from a list that says how far each reaches and what it costs', () => {
  const choices = sensorChoices(); assert.deepEqual(choices.map(choice => choice.id), Object.keys(SENSOR_MODES));
  for (const choice of choices) { assert.equal(choice.name, SENSOR_MODES[choice.id].name); assert.match(choice.detail, /^até [\d.]+ m · [\d.]+ cr$/); }
  // The camera becomes a microphone, of its size: a radar is larger, and the camera's place has no room for one beside the radar.
  const { editor, part } = selected('heavy', 'sensor'), other = choices.find(choice => !['radar', part().sensorMode].includes(choice.id)).id;
  editor.editProperty('sensorMode', other, true); assert.equal(part().sensorMode, other);
});

test('a camera inside keeps the complete sensor catalogue without editing its pose', () => {
  const editor = new Editor(createStructuredConstruction()), camera = editor.addModule('sensor', { x: 10.5, y: 1.6 }, { sensorMode: 'visual' }),
    part = editor.source.components.find(candidate => candidate.id === camera.id), before = structuredClone(editor.source);
  assert.deepEqual(part.pose, { x: -30, y: 6, angle: 0 }); // -1.5 m, .3 m, in cells
  assert.deepEqual(sensorChoices(editor.source, part).map(choice => choice.id), Object.keys(SENSOR_MODES));
  assert.deepEqual(sensorChoices().map(choice => choice.id), Object.keys(SENSOR_MODES), 'the catalogue remains complete without placement context');
  assert.deepEqual(editor.source, before, 'checking choices leaves the project alone');
});

test('a weapon offers compatible mounts independently of its current position', () => {
  const scout = selected('scout', 'weapon'), before = structuredClone(scout.editor.source);
  assert.deepEqual(mountChoices('m2hb').map(choice => choice.id), ['light-trunnion', 'pintle']);
  assert.deepEqual(mountChoices('m2hb', scout.editor.source, scout.part()).map(choice => choice.id), ['light-trunnion', 'pintle']);
  assert.deepEqual(scout.editor.source, before, 'checking mounts does not edit the weapon or its firing sector');

  const roof = new Editor(createStructuredConstruction()), gun = roof.addModule('weapon', { x: 12, y: 3.6 }, { weaponPreset: 'm2hb', mountPreset: 'pintle' }),
    part = roof.source.components.find(candidate => candidate.id === gun.id);
  assert.equal(part.mount.preset, 'pintle');
  assert(mountChoices('m2hb', roof.source, part).some(choice => choice.id === 'pintle'));
});

test('an ammunition box offers each calibre with the rounds it holds of it full, and refuses those of which none fits', () => {
  const { editor, id } = selected('heavy', 'ammo');
  const box = editor.blueprint.modules.find(module => module.id === id), before = structuredClone(box),
    original = ammunitionBoxChoice(box, 'rh120', 'apfsds'), alternate = ammunitionBoxChoice(box, 'm2hb', 'ap');
  assert.deepEqual([original.rounds, original.fits], [box.capacityRounds, true]); assert(original.rounds > 0 && original.mass > 0);
  assert(alternate.rounds > original.rounds && alternate.fits && alternate.mass > 0);
  const changed = structuredClone(editor.source);
  changed.components.find(piece => piece.id === id).ammoPreset = 'm2hb';
  const admitted = compileStructuredConstruction(changed).modules.find(piece => piece.id === id);
  assert.equal(alternate.rounds, admitted.capacityRounds, 'the alternate calibre preview agrees with its own fresh admission');
  assert.deepEqual(ammunitionBoxChoice({ ...box, rounds: 0 }, 'rh120', 'apfsds'), original,
    'the offered calibre is built full even when the current box was spent');

  const small = { ...box, width: box.width * .25, height: box.height * .25 };
  assert.deepEqual([ammunitionBoxChoice(small, 'rh120', 'apfsds').fits, ammunitionBoxChoice(small, 'm2hb', 'ap').fits], [false, true],
    'physical capacity can still reject a large round');
  assert.deepEqual(box, before, 'examining other calibres leaves the installed box alone');
});

test('engines, tanks, cargo containers, extraction and construction mechanisms offer their permitted metals with mass and price', () => {
  const truck = selected('truck', 'hopper'), choices = metalChoices(truck.editor.source, truck.part());
  assert.deepEqual(choices.map(choice => [choice.id, choice.name, choice.tag]), PIECE_METALS.hopper.map(id => METALS[id]).map(metal => [metal.id, metal.name, metal.tag]));
  for (const choice of choices) assert.match(choice.detail, /^[\d.,]+ (kg|t) · vida \d+ % · [\d.]+ cr em (Ferro|Ligas)$/, choice.detail);
  // The engine of the scout, to the kilogram.
  const engine = selected('scout', 'engine'), kg = detail => Number(detail.match(/^([\d.]+) kg/)[1].replaceAll('.', '')),
    [steel, aluminium, titanium] = metalChoices(engine.editor.source, engine.part()).map(choice => kg(choice.detail));
  assert(steel > 0);
  assert(Math.abs(aluminium - steel * .65) <= 1 && Math.abs(titanium - steel * .6) <= 1, choices.map(choice => choice.detail).join(' / '));
  assert.deepEqual(choices.map(choice => choice.detail.match(/em (\w+)$/)[1]), ['Ferro', 'Ligas', 'Ligas']);
  // Chosen, the piece is written of that metal; steel is the one that is not written.
  truck.editor.editProperty('metal', 'aluminum', true);
  assert.equal(truck.part().metal, 'aluminum'); assert.equal(truck.editor.selected.metal, 'aluminum');
  truck.editor.editProperty('metal', 'steel', true); assert.equal('metal' in truck.part(), false);
  // Of the pieces it is set on, and of a material there is.
  const gun = selected('heavy', 'weapon'), camera = selected('heavy', 'sensor'), before = structuredClone(gun.editor.source);
  assert.throws(() => gun.editor.editProperty('metal', 'aluminum', true), { message: 'O armamento é só de aço.' });
  assert.throws(() => truck.editor.editProperty('metal', 'fiberglass', true), { message: 'Só tanque de combustível, cisterna, suprimentos e sensor podem ser de fibra de vidro.' });
  assert.throws(() => camera.editor.editProperty('metal', 'titanium', true), { message: 'A câmera e a escuta são de aço, de fibra de vidro ou de plástico.' });
  assert.throws(() => truck.editor.editProperty('metal', 'plastic', true), { message: 'Só tanque de combustível, cisterna, suprimentos, câmera e escuta podem ser de plástico.' });
  assert.deepEqual(gun.editor.source, before);
  // A camera of plastic is no radar: it is refused that way of detecting, and stays what it was.
  camera.editor.editProperty('metal', 'plastic', true); assert.equal(camera.part().metal, 'plastic');
  const cased = structuredClone(camera.editor.source);
  assert.throws(() => camera.editor.editProperty('sensorMode', 'radar', true), { message: 'O radar é de aço ou de fibra de vidro.' });
  assert.deepEqual(camera.editor.source, cased);
  camera.editor.editProperty('sensorMode', 'sound', true); assert.deepEqual([camera.part().sensorMode, camera.part().metal], ['sound', 'plastic']);
  // Nor is a radar made of it; glass fibre it may be.
  const recon = new Editor(createStructuredTemplate('recon')), radar = () => recon.source.components.find(part => part.id === 'sensor-1');
  recon.select('sensor-1'); assert.equal(radar().sensorMode, 'radar');
  assert.throws(() => recon.editProperty('metal', 'plastic', true), { message: 'O radar é de aço ou de fibra de vidro.' });
  recon.editProperty('metal', 'fiberglass', true); assert.equal(radar().metal, 'fiberglass');
  assert.throws(() => truck.editor.editProperty('metal', 'ceramic', true), error => error.code === 'STRUCTURED_CONSTRUCTION');
  // A tool has the same metal controls and compiler validation as the other metallic equipment, without becoming
  // a cargo container. Exercise the builder on its own model, and swap only the miner's mechanism to try the drill.
  for (const kind of ['excavator', 'drill', 'builder']) {
    const source = createStructuredTemplate(kind === 'builder' ? 'construction-truck' : 'mining-truck'),
      part = source.components.find(part => part.kind === (kind === 'builder' ? 'builder' : 'excavator')),
      oldHeight = componentDimensions(part, part.sizeScale ?? 1).height;
    part.kind = kind;
    part.pose.y += cellOf((componentDimensions(part, part.sizeScale ?? 1).height - oldHeight) / 2);
    const editor = new Editor(source), authored = () => editor.source.components.find(candidate => candidate.id === part.id);
    editor.select(part.id);
    const offered = metalChoices(editor.source, authored());
    assert.deepEqual(offered.map(choice => choice.id), ['steel', 'aluminum', 'titanium'], kind);
    for (const choice of offered) assert.match(choice.detail, /^[\d.,]+ (kg|t) · vida \d+ % · [\d.]+ cr em (Ferro|Ligas)$/, kind);
    editor.editProperty('metal', 'aluminum', true);
    assert.equal(authored().metal, 'aluminum', kind); assert.equal(editor.selected.metal, 'aluminum', kind);
    assert.equal(editor.selected.health, METALS.aluminum.health * (kind === 'drill' ? 130 : 140));
    editor.editProperty('metal', 'steel', true); assert.equal(Object.hasOwn(authored(), 'metal'), false, kind);
    const before = structuredClone(editor.source);
    assert.throws(() => editor.editProperty('metal', 'ceramic', true), error => error.code === 'STRUCTURED_CONSTRUCTION', kind);
    assert.deepEqual(editor.source, before, `${kind}: an invalid metal leaves the source intact`);
    assert.deepEqual(pieceSettings(editor.selected, authored()).map(setting => setting.key), ['sizeScale', 'angle'], kind);
  }
});

test('every component but the gun and the thruster has its materials: the road tools, the boxes and the command post the metals, the tank, the cistern, the crates and the sensor glass fibre besides, and all of them but the radar plastic', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PIECE_METALS).map(([kind, metals]) => [kind, metals.join(' ')])), {
    sensor: 'steel fiberglass plastic', command: 'steel aluminum titanium', engine: 'steel aluminum titanium', weapon: 'steel',
    fuel: 'steel aluminum titanium fiberglass plastic', ammo: 'steel aluminum titanium', hopper: 'steel aluminum titanium',
    cistern: 'steel aluminum titanium fiberglass plastic', supply: 'steel aluminum titanium fiberglass plastic', excavator: 'steel aluminum titanium',
    drill: 'steel aluminum titanium', builder: 'steel aluminum titanium', blade: 'steel aluminum titanium', paver: 'steel aluminum titanium',
    wheel: 'steel aluminum titanium', track: 'steel aluminum titanium', thruster: 'titanium' });
  assert.deepEqual(Object.keys(PIECE_METALS).sort(), Object.keys(MODULES).sort(), 'every piece is told');
  assert(Object.keys(MODULES).every(kind => choosesMetal({ kind }) === !['weapon', 'thruster'].includes(kind)));
  // A camera and a microphone, or a sensor that says nothing, may be of plastic; a radar may not.
  for (const sensorMode of [undefined, 'visual', 'sound']) assert.equal(pieceMetals({ kind: 'sensor', sensorMode }), PIECE_METALS.sensor, sensorMode);
  assert.deepEqual(pieceMetals({ kind: 'sensor', sensorMode: 'radar' }), ['steel', 'fiberglass']);
  assert(!takesMetal({ kind: 'sensor', sensorMode: 'radar' }, 'plastic') && takesMetal({ kind: 'sensor', sensorMode: 'sound' }, 'plastic'));
  // The laminate is light and weak, and paid in Sílica, as its plates are; the moulding the lightest and the weakest of
  // all, paid in Combustível, as plastic is made of petroleum.
  assert.deepEqual([METALS.fiberglass.name, METALS.fiberglass.stock, METALS.fiberglass.health], ['Fibra de vidro', 'silica', .5]);
  assert.deepEqual([METALS.plastic.name, METALS.plastic.short, METALS.plastic.stock, METALS.plastic.health, METALS.plastic.tag],
    ['Plástico', 'PLÁSTICO', 'combustivel', .35, 'a mais leve e barata · frágil']);
  assert(Object.values(METALS).every(metal => metal.id === 'plastic' || metal.health > METALS.plastic.health));
  const stocks = { ferro: 'Ferro', ligas: 'Ligas', silica: 'Sílica', combustivel: 'Combustível' }, cost = piece => pieceCost(piece), lightest = {};
  for (const [template, kind] of [['grader', 'blade'], ['paver', 'paver'], ['supply', 'supply'], ['heavy', 'ammo'], ['heavy', 'command'],
    ['tanker', 'cistern'], ['truck', 'fuel'], ['recon', 'sensor']]) {
    const { editor, part } = selected(template, kind), offered = metalChoices(editor.source, part()), steel = structuredClone(editor.selected);
    assert.deepEqual(offered.map(choice => choice.id), pieceMetals(part()), `${template} ${kind}`);
    for (const choice of offered) {
      assert(!choice.disabled, `${kind} of ${choice.id}: ${choice.detail}`);
      // Its own stock first, and Ferro for what of it its material does not change and for its rounds.
      assert.match(choice.detail, new RegExp(`^[\\d.,]+ (kg|t) · vida ${Math.round(METALS[choice.id].health * 100)} % · [\\d.]+ cr em ${stocks[METALS[choice.id].stock]}( e [\\d.]+ cr em Ferro)?( · capacidade pendente)?$`), choice.detail);
      editor.editProperty('metal', choice.id, true);
      assert.equal(part().metal, choice.id === 'steel' ? undefined : choice.id, 'steel is the one that is not written');
      const made = editor.selected;
      // As heavy, as strong and as dear as its share of the steel one; what it holds is what it was. Plastic alone is
      // cheaper than steel.
      assert(Math.abs(made.maxHealth - steel.maxHealth * METALS[choice.id].health) < 1e-9, `${kind} of ${choice.id}`);
      if (choice.id !== 'steel') assert(pieceMass(made) < pieceMass(steel) && (cost(made) < cost(steel)) === (choice.id === 'plastic'),
        `${kind} of ${choice.id}: ${pieceMass(made)} kg, ${cost(made)} cr`);
      assert.equal(made.rounds, steel.rounds); assert.equal(made.fuelLitres, steel.fuelLitres);
      if (!lightest[kind] || pieceMass(made) < lightest[kind].mass) lightest[kind] = { id: choice.id, mass: pieceMass(made) };
    }
    editor.editProperty('metal', 'steel', true);
  }
  assert.deepEqual(Object.entries(lightest).filter(([, { id }]) => id === 'plastic').map(([kind]) => kind).sort(), ['cistern', 'fuel', 'sensor', 'supply']);
  // Of a sensor and of a command post only the housing is of the material: the radar of glass fibre, the camera of plastic
  // and the command post of titanium pay their housing from Sílica, Combustível and Ligas and their equipment from Ferro,
  // as on a steel one.
  const detail = (template, kind, id) => { const { editor, part } = selected(template, kind); return metalChoices(editor.source, part()).find(choice => choice.id === id).detail; },
    sensor = (mode, id) => { const source = createStructuredTemplate('recon'), part = source.components.find(part => part.kind === 'sensor' && part.sensorMode === mode);
      return metalChoices(source, part).find(choice => choice.id === id)?.detail; };
  assert.match(sensor('radar', 'fiberglass'), /^[\d.,]+ kg · vida 50 % · 660 cr em Sílica e 11\.400 cr em Ferro$/);
  assert.match(sensor('radar', 'steel'), /^[\d.,]+ kg · vida 100 % · 12\.000 cr em Ferro$/);
  assert.equal(sensor('radar', 'plastic'), undefined, 'a radar is offered no plastic');
  assert.match(sensor('visual', 'plastic'), /^[\d.,]+ kg · vida 35 % · 60 cr em Combustível e 1\.350 cr em Ferro$/);
  assert.match(detail('heavy', 'command', 'titanium'), /^[\d.,]+ kg · vida 110 % · 240 cr em Ligas e 720 cr em Ferro$/);
  // A box of aluminium pays its rounds from Ferro, as they are.
  assert.match(detail('heavy', 'ammo', 'aluminum'), / cr em Ligas e [\d.]+ cr em Ferro$/);
});

test('a selection of several components is offered every material one of them takes, each for those that take it', () => {
  const { editor } = selected('supply', 'supply'), parts = editor.source.components.filter(part => choosesMetal(part)),
    choices = metalChoices(editor.source, parts), many = parts.length, fibre = parts.filter(part => takesMetal(part, 'fiberglass')),
    plastic = parts.filter(part => takesMetal(part, 'plastic'));
  assert.deepEqual(choices.map(choice => choice.id), ['steel', 'aluminum', 'titanium', 'fiberglass', 'plastic']);
  assert.deepEqual(fibre.map(part => part.kind).sort(), ['fuel', 'sensor', 'supply']);
  assert.deepEqual(plastic, fibre, 'the camera, the tank and the crates take either');
  assert(choices.find(choice => choice.id === 'fiberglass').detail.endsWith(` · em ${fibre.length} de ${many} componentes`));
  // Steel is any piece's; the metals every one's but the camera's.
  assert(!choices[0].detail.includes(' de ' + many));
  assert(choices.slice(1, 3).every(choice => choice.detail.includes(` · em ${many - 1} de ${many} componentes`)));
  applySettings(editor, 'metal', new Map(plastic.map(part => [part.id, 'plastic'])));
  assert.deepEqual(editor.source.components.filter(part => part.metal === 'plastic').map(part => part.kind).sort(), ['fuel', 'sensor', 'supply']);
});

test('metal menus preview pending capacity and apply the chosen metal without other support edits', () => {
  const source = createStructuredTemplate('truck');
  // This heavy cab admits its aluminium engine, but the steel engine overloads
  // the front supports. A component's own proposed COM determines its limit.
  source.plates.find(plate => plate.id === 'hull:roof').thicknessMm = 280;
  source.components.find(part => part.id === 'sensor-0').pose.y += 6; // .3 m, in cells
  source.components.find(part => part.kind === 'engine').metal = 'aluminum';
  const editor = new Editor(source), part = editor.source.components.find(part => part.kind === 'engine'), before = structuredClone(editor.source);
  assert(editor.blueprint.chassis.loadedKg < editor.blueprint.chassis.limitKg, 'the current design passes the real compiler');
  const component = metalChoices(editor.source, part), frame = chassisMetalChoices(editor.source);
  for (const choices of [component, frame]) assert.deepEqual(choices.map(choice => choice.id), ['steel', 'aluminum', 'titanium']);
  assert(!component[0].disabled);
  assert.match(component[0].detail, /capacidade pendente/);
  assert.throws(() => compileStructuredConstruction(withPieceProperty(editor.source, part.id, 'metal', 'steel')), error => {
    return error.code === 'CHASSIS_OVERLOAD';
  });
  assert(component.slice(1).every(choice => !choice.disabled), 'lighter component alternatives remain available');
  assert(!frame[0].disabled, 'the current steel structure remains available');
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0, 'opening either menu is only a preview');
  editor.select(part.id);
  editor.editProperty('metal', 'steel', true);
  assert.equal(editor.source.components.find(candidate => candidate.id === part.id).metal, undefined, 'steel is the canonical default');
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  assert.deepEqual(editor.source.chassis, before.chassis);
  assert.equal(editor.past.length, 1);
  editor.undo(); assert.deepEqual(editor.source, before);
  for (const choice of frame.slice(1)) {
    assert(!choice.disabled, 'capacity does not disable geometrically valid material choices');
    assert.equal(editor.setChassisMetal(choice.id), true);
    assert.equal(editor.source.chassis.metal, choice.id);
    assert.equal(frameThicknessMm(editor.source.chassis), frameThicknessMm(before.chassis));
    assert.equal(editor.past.length, 1);
    assert(choice.detail.includes('limite: ' + weight(editor.blueprint.chassis.limitKg)), 'menu previews the actual physical capacity');
    editor.undo(); assert.deepEqual(editor.source, before);
  }
  editor.select(part.id);
  editor.editProperty('metal', 'titanium', true); assert.equal(editor.selected.metal, 'titanium');
  editor.undo(); assert.deepEqual(editor.source, before);

  editor.select(CHASSIS_ID); applySettings(editor, 'frameThicknessMm', new Map([[CHASSIS_ID, 30]]));
  const reinforced = structuredClone(editor.source), steelMass = editor.blueprint.chassis.loadedKg;
  assert(!chassisMetalChoices(editor.source).find(choice => choice.id === 'titanium').disabled,
    'reinforcing the structure makes the actual titanium alternative viable');
  assert.equal(editor.setChassisMetal('titanium'), true); assert.equal(editor.source.chassis.metal, 'titanium');
  assert.equal(editor.source.chassis.thicknessMm, 30, 'changing metal keeps the authored structural gauge');
  assert(editor.blueprint.chassis.loadedKg < steelMass, 'the real structural and gear mass respond to the chosen metal');
  assert(editor.blueprint.chassis.loadedKg <= editor.blueprint.chassis.limitKg);
  editor.undo(); assert.deepEqual(editor.source, reinforced);
  editor.undo(); assert.deepEqual(editor.source, before);
  assert.throws(() => metalChoices(null, part), 'invalid preview sources must remain visible to the caller');
  assert.throws(() => chassisMetalChoices(null), TypeError);
});
