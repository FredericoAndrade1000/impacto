import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { World } from '../src/physics.ts';
import { plateCorners } from '../src/math.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileDraftConstruction, createStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { CHASSIS_MODELS, chassisGearSize, chassisSpec, suspensionHeight, suspensionZero } from '../src/chassis.ts';
import { CHASSIS_ID, withChassisGearScale, withChassisSuspension, withChassisThickness } from '../src/chassis-editing.ts';
import { applySettings, selectionSettings, steppedSettings } from '../src/piece-settings.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { projectRefusalMessage } from '../src/project-refusal.ts';
import { metresOf } from '../src/grid.ts';

await initNativeDynamics();

// The height of the suspension is how far the chassis hangs over where its model hangs gear of its size (chassis.ts
// `suspensionZero`), in cells of 5 cm (grid.ts), up to four either way; the gear stays on the ground and the whole
// construction goes up or down.
const near = (a, b, slack = 1e-9) => Math.abs(a - b) <= slack;
const at = height => design => withChassisSuspension(design, height);
// The stepper of the height of the suspension on the bar of the chassis, selected.
const stepper = editor => {
  editor.select(CHASSIS_ID);
  return selectionSettings([{ piece: editor.selected, part: editor.source.chassis }]).find(setting => setting.key === 'suspension');
};
// One press of it, up (1) or down (-1); false where the press asks nothing.
function press(editor, way) {
  const asked = steppedSettings(stepper(editor), way);
  if (!asked.size) return false;
  applySettings(editor, 'suspension', asked);
  return true;
}
// The gear of a compiled design: where each wheel or track stands.
const gear = blueprint => blueprint.modules.filter(part => part.kind === 'wheel' || part.kind === 'track').map(({ id, x, y }) => ({ id, x, y }));
// How many cells higher `after` stands than `before`, all of it: its nodes, the points of its chassis and its equipment,
// each as far up or down and none along.
function lifted(after, before) {
  const lift = after.chassis.points[0].y - before.chassis.points[0].y,
    by = (a, b) => assert(a.x === b.x && a.y === b.y + lift, `${a.x},${a.y} from ${b.x},${b.y}`);
  after.nodes.forEach((node, i) => by(node, before.nodes[i])); after.chassis.points.forEach((point, i) => by(point, before.chassis.points[i]));
  after.components.forEach((part, i) => by(part.pose, before.components[i].pose));
  assert.deepEqual(after.plates, before.plates);
  return lift;
}
// A pickup's chassis arched over both its wheels, as players build them (chassis-profile.test.js has the same), in cells.
function arched() {
  const base = createConstruction('chassis'), D = base.chassis.points[0].y, up = 6,
    points = [[-54, 0], [-48, up], [-22, up], [-16, 0], [16, -1], [23, up], [46, up], [52, 0], [54, 0]].map(([x, y]) => ({ x, y: D + y })),
    floor = points.map((p, i) => ({ id: `floor-${i}`, x: p.x, y: p.y })),
    top = [['rear-top', 54, D + 19], ['cab-low', -4, D + 19], ['cab-top', -10, D + 31], ['roof-front', -34, D + 31], ['front-top', -54, D + 19]].map(([id, x, y]) => ({ id, x, y })),
    ring = [...floor, ...top].map(node => node.id), { launcher: _, ...rest } = base;
  return { ...rest, chassis: { model: 'wheeled', points, axles: [-35, 34] }, nodes: [...floor, ...top],
    plates: ring.map((a, i) => ({ id: `hull:${i}`, a, b: ring[(i + 1) % ring.length], material: 'steel', thicknessMm: 10 })),
    components: [{ id: 'engine', kind: 'engine', pose: { x: -35, y: D + 15, angle: 0 }, sizeScale: .8 },
      { id: 'fuel', kind: 'fuel', pose: { x: 4, y: D + 9, angle: 0 }, sizeScale: 1 },
      { id: 'command', kind: 'command', pose: { x: -18, y: D + 22, angle: 0 }, sizeScale: 1 },
      { id: 'sensor-vision', kind: 'sensor', sensorMode: 'visual', pose: { x: -31, y: D + 26, angle: 0 }, sizeScale: 1 }] };
}
const DESIGNS = () => [['scout', createConstruction('scout')], ['arched pickup', arched()], ['tracked', createConstruction('tracked')]];

test('each press of the suspension moves the whole construction a cell of five centimetres over its gear, which stays on the ground, up to twenty either way', () => {
  for (const [name, design] of DESIGNS()) {
    const editor = new Editor(validateStructuredConstruction(at(0)(design))), seated = editor.source, wheels = gear(editor.blueprint);
    assert.deepEqual(stepper(editor), { ...stepper(editor), label: 'Altura da suspensão', unit: 'cm', value: 0, min: -20, max: 20, step: 5 }, name);
    for (const way of [1, -1]) {
      for (let k = 1; k <= 4; k++) {
        const before = editor.source;
        assert(press(editor, way), `${name}: press ${k}`);
        assert.equal(lifted(editor.source, before), way, name);
        assert.deepEqual(gear(editor.blueprint), wheels, `${name}: the wheels stay where they stand`);
        assert(near(editor.blueprint.chassis.suspension, metresOf(way * k)) && stepper(editor).value === way * 5 * k, name);
        assert.equal(editor.past.length, k);
      }
      // At twenty a press asks nothing, and the bar says why.
      assert.equal(press(editor, way), false, name); assert.equal(editor.past.length, 4);
      assert.equal(stepper(editor).ends[way > 0 ? 1 : 0], way > 0 ? 'Essa é a suspensão mais alta.' : 'Essa é a suspensão mais baixa.');
      // Each press is undone at once, the last first.
      const top = editor.source;
      assert(editor.undo()); assert.equal(lifted(top, editor.source), way);
      while (editor.undo());
      assert.deepEqual(editor.source, seated, name);
    }
  }
});

test('the compiler refuses a suspension more than twenty centimetres from where the model hangs it, and says so; a stretch raised over a wheel does not count', () => {
  for (const [name, design] of DESIGNS()) {
    for (const height of [-4, 4]) assert(near(compileBlueprint(at(height)(design)).chassis.suspension, metresOf(height)), name);
    for (const height of [-5, 5, 20]) assert.throws(() => validateStructuredConstruction(at(height)(design)), error =>
      error.reason === 'SUSPENSION_REACH' && near(error.value, metresOf(height)) && error.range[0] === -.2 && error.range[1] === .2, `${name} ${height}`);
  }
  // The arches of the pickup stand 30 cm over its deck: its height is that of the deck, as its axles hang under it.
  assert(near(compileBlueprint(at(0)(arched())).chassis.suspension, 0));
  const high = (() => { try { validateStructuredConstruction(at(5)(arched())); } catch (error) { return error; } })(),
    low = (() => { try { validateStructuredConstruction(at(-6)(arched())); } catch (error) { return error; } })();
  assert.equal(projectRefusalMessage(high, at(5)(arched())),
    'O chassi fica 25 cm acima da altura da suspensão do modelo: a suspensão alcança as rodas até 20 cm para cima ou para baixo.');
  assert.equal(constructionEditMessage(high), 'A suspensão não alcança as rodas: o chassi ficaria alto demais sobre elas. Desça o veículo pela altura da suspensão.');
  assert.equal(constructionEditMessage(low), 'A suspensão não alcança as rodas: o chassi ficaria baixo demais sobre elas. Suba o veículo pela altura da suspensão.');
  const track = (() => { try { validateStructuredConstruction(at(5)(createConstruction('tracked'))); } catch (error) { return error; } })();
  assert.equal(constructionEditMessage(track), 'A suspensão não alcança a esteira: o chassi ficaria alto demais sobre ela. Desça o veículo pela altura da suspensão.');
  // Even a draft is no construction there: the editor stays where it was.
  assert.throws(() => compileDraftConstruction(at(5)(arched())), { reason: 'SUSPENSION_REACH' });
});

test('larger gear lifts the whole construction with it and a thicker frame keeps it as high over its gear, in the Oficina', () => {
  for (const [name, design] of DESIGNS()) {
    const editor = new Editor(validateStructuredConstruction(at(2)(design))), wheeled = chassisSpec(design.chassis.model).kind === 'wheeled',
      scale = design.chassis.gearScale ?? 1;
    // Smaller, then back as large: a track keeps its ends and grows up from the floor.
    for (const [key, value] of [['gearScale', .8 * scale], ['gearScale', scale], ['frameThicknessMm', wheeled ? 30 : 60]]) {
      const before = editor.source;
      applySettings(editor, key, new Map([[CHASSIS_ID, value]]));
      const lift = lifted(editor.source, before), grows = chassisGearSize(editor.source.chassis) - chassisGearSize(before.chassis);
      assert.equal(lift, suspensionZero(editor.source.chassis) - suspensionZero(before.chassis), `${name} ${key}`);
      assert(near(editor.blueprint.chassis.suspension, metresOf(2)) && stepper(editor).value === 10, `${name} ${key}: as high over its gear as it was`);
      // Wheels as much higher as their radius grows, or more where the deck of the model rises to clear larger axles; a
      // track as much as it grows; within the cell the height is told on.
      if (key === 'gearScale') assert(Math.sign(lift) === Math.sign(grows) && Math.abs(metresOf(lift) - (wheeled ? grows / 2 : grows)) < .05 + (wheeled && grows > 0 ? grows : 0), `${name}: ${lift} for ${grows}`);
    }
  }
});

test('where a model hangs its gear is the same in the Oficina as in the compiler, for every model, size, frame and length', () => {
  let compared = 0;
  for (const [model, spec] of Object.entries(CHASSIS_MODELS).filter(([, spec]) => spec.kind === 'wheeled'))
    for (const length of [spec.length[0], (spec.length[0] + spec.length[1]) / 2, spec.length[1]])
      for (const scale of [.6, 1, 1.4]) for (const thicknessMm of [6, 20, 60]) {
        const made = createStructuredConstruction({ length, height: 1.2, thicknessMm: 8, chassis: model }),
          design = withChassisGearScale(withChassisThickness(made, thicknessMm), scale);
        let compiled;
        try { compiled = compileDraftConstruction(design); }
        catch (error) { assert.notEqual(error.reason, 'SUSPENSION_REACH', `${model} ${length} ${scale} ${thicknessMm}`); continue; }
        assert(near(compiled.chassis.suspension, metresOf(suspensionHeight(design.chassis))) && suspensionHeight(design.chassis) === 0,
          `${model} ${length} ${scale} ${thicknessMm}: ${compiled.chassis.suspension}`);
        compared++;
      }
  assert(compared >= 24, `${compared} compared`);
});

test('standing on the ground, the hull is as much higher or lower as its suspension is, its gear on the ground', () => {
  for (const [name, design] of DESIGNS().slice(0, 2)) {
    const clearance = height => {
      const world = new World({ ...at(height)(design), terrain: 'flat' }, { visualEvents: false });
      try {
        for (let step = 0; step < 240; step++) world.step();
        for (const wheel of world.modules.filter(part => part.kind === 'wheel'))
          assert(Math.abs(wheel.y - wheel.height / 2 - world.terrain.height(wheel.x)) < .002, `${name}: the tyre rests on the ground`);
        assert.equal(world.dynamics.recoveries, 0);
        return Math.min(...world.plates.filter(plate => !plate.definition.chassis).flatMap(plate => plateCorners(plate.definition))
          .map(corner => corner.y - world.terrain.height(corner.x)));
      } finally { world.dispose(); }
    };
    const level = clearance(0);
    for (const height of [-4, 4]) assert(Math.abs(clearance(height) - level - metresOf(height)) < .01, `${name} at ${height}`);
  }
});
