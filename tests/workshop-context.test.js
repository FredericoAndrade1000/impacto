import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { workshopChecklist } from '../src/workshop-checklist.ts';
import { PART_CATEGORIES, SUMMARY_FIGURES, categoryOf, workshopContext } from '../src/workshop-context.ts';

await initNativeDynamics();
const review = source => workshopChecklist(compileBlueprint(source));

test('semantic groups retain every existing component exactly once, including optional cargo and weapons', () => {
  const kinds = PART_CATEGORIES.flatMap(category => category.kinds);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.deepEqual([...kinds].sort(), ['engine', 'fuel', 'ammo', 'command', 'sensor', 'thruster', 'hopper', 'cistern', 'supply', 'weapon', 'excavator', 'drill', 'builder', 'blade', 'paver'].sort());
  assert.equal(categoryOf('ammo'), categoryOf('weapon'));
  assert.equal(categoryOf('sensor'), 'base'); assert.equal(categoryOf('thruster'), 'base'); assert.equal(categoryOf('cistern'), 'cargo');
  assert.equal(categoryOf('excavator'), 'cargo'); assert.equal(categoryOf('drill'), 'cargo'); assert.equal(categoryOf('builder'), 'cargo');
  assert.equal(categoryOf('blade'), 'cargo'); assert.equal(categoryOf('paver'), 'cargo');
});

test('a ready vehicle and an intentionally unarmed hauler receive no distracting suggestion', () => {
  for (const name of ['scout', 'truck', 'bunker']) {
    const context = workshopContext(review(createConstruction(name)), []);
    assert.deepEqual([context.suggestion, context.remaining], [null, 0], name);
  }
});

test('the assist prioritizes an actual missing requirement and retains the other actionable findings for review', () => {
  const source = createConstruction('scout');
  source.components = source.components.filter(part => !['command', 'fuel'].includes(part.kind));
  const rows = review(source), before = structuredClone(rows), context = workshopContext(rows, []);
  assert.deepEqual([context.suggestion.id, context.suggestion.target, context.remaining], ['command', 'build', 1]);
  assert.equal(context.action, 'Instalar comando');
  assert.deepEqual(rows, before);
  // A tank and a box are built full: none is to be filled. A box too small for a round of its calibre is enlarged.
  const tankless = createConstruction('scout');
  tankless.components = tankless.components.filter(part => part.kind !== 'fuel');
  const tank = workshopContext(review(tankless), []);
  assert.deepEqual([tank.suggestion.id, tank.suggestion.target, tank.action], ['fuel', 'build', 'Instalar tanque']);
  const small = workshopContext([{ id: 'armament', state: 'attention', target: 'adjust', detail: 'Caixa pequena.' }], []);
  assert.equal(small.action, 'Aumentar caixa');
});

test('the canvas summary keeps weight, power and range while the other readings stay in Revisão', () => {
  const figures = [{ label: 'PESO', value: '5 t' }, { label: 'POTÊNCIA', value: '300 hp' }, { label: 'AUTONOMIA', value: '400 km' },
    { label: 'MÁXIMA ESTIMADA', value: '80 km/h' }, { label: 'CARGA', value: '4 m³' }], before = structuredClone(figures);
  assert.deepEqual(SUMMARY_FIGURES, ['PESO', 'POTÊNCIA', 'AUTONOMIA']);
  assert.deepEqual(workshopContext([], figures).summary, figures.slice(0, 3));
  assert.deepEqual(workshopContext([], [figures[0], figures[4]]).summary, [figures[0]], 'a structure that does not drive tells its weight alone');
  assert.deepEqual(figures, before);
});

test('the draft chassis finding offers its existing adjustment rather than installing another component', () => {
  const rows = [{ id: 'chassis', state: 'attention', target: 'adjust', detail: 'A capacidade precisa de ajuste.' },
    { id: 'armament', state: 'attention', target: 'adjust', detail: 'Caixa pequena.' }], before = structuredClone(rows), context = workshopContext(rows, []);
  assert.equal(context.suggestion, rows[0]); assert.equal(context.action, 'Ajustar chassi'); assert.equal(context.remaining, 1);
  assert.deepEqual(rows, before);
});
