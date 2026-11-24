import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredConstruction, planStructuredComponent, compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { Editor } from '../src/editor.ts';

await initNativeDynamics();

const refusal = action => {
  try { action(); } catch (error) { return error; }
  assert.fail('the proposal must be refused');
};

test('overlap codes and IDs keep Portuguese feedback and both highlights independent of diagnostic text', () => {
  let source = createStructuredConstruction();
  for (const [id, x] of [['command-a', 0], ['command-b', 20]]) source = planStructuredComponent(source,
    { id, kind: 'command', pose: { x, y: 6, angle: 0 } }).construction;
  const editor = new Editor(source), before = structuredClone(source), candidate = structuredClone(source);
  candidate.components[1].pose = structuredClone(candidate.components[0].pose);
  const error = refusal(() => compileStructuredConstruction(candidate));
  assert.equal(error.reason, 'CONSTRUCTION_OVERLAP'); assert.equal(error.code, 'CONSTRUCTION_OVERLAP');
  assert.deepEqual(new Set(error.ids), new Set(['command-a', 'command-b']));
  error.message = 'diagnóstico de suporte sem nomes de peças';
  const message = 'As peças ocupariam o mesmo espaço. Afaste as peças destacadas.';
  assert.equal(constructionEditMessage(error), message);
  editor.select('command-a'); editor.rejectEdit(error);
  assert.equal(editor.blockedEdit.message, message);
  assert.deepEqual(new Set(editor.blockedEdit.ids), new Set(['command-a', 'command-b']));
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
});

test('a translated edit refusal retains component and field metadata through the ordinary editor boundary', () => {
  const source = planStructuredComponent(createStructuredConstruction(),
    { id: 'engine', kind: 'engine', pose: { x: 0, y: 6, angle: 0 } }).construction,
    editor = new Editor(source), candidate = structuredClone(source);
  candidate.components[0].sizeScale = 100;
  const error = refusal(() => editor.admitted(candidate));
  assert.equal(error.code, 'STRUCTURED_CONSTRUCTION'); assert.equal(error.reason, 'FIELD');
  assert.equal(error.field, 'sizeScale'); assert.deepEqual(error.ids, ['engine']);
  assert.equal(error.message, 'Tamanho fora do que a peça admite.');
  assert.deepEqual(editor.source, source); assert.equal(editor.past.length, 0);
});

test('malformed existing equipment remains a typed refusal at the installation boundary', () => {
  const source = createStructuredConstruction(), component = { id: 'reserve', kind: 'fuel', sizeScale: .5 },
    malformed = { ...source, components: [{ ...component, derivedMass: 1, pose: { x: 0, y: 6, angle: 0 } }] };
  assert.throws(() => planStructuredComponent(malformed, { ...component, id: 'copy', pose: { x: 20, y: 6, angle: 0 } }),
    { reason: 'AUTHORING_FIELDS', ids: ['reserve'] });
});
test('structured data alone supplies breech angle, surface and chassis capacity to Portuguese feedback', () => {
  const physical = { code: 'BREECH_PLATE', ids: ['hull:roof', 'gun'], surface: 'roof', angleDegrees: -12 };
  assert.equal(constructionEditMessage(physical),
    'A culatra, que gira com o cano, bateria no teto com o cano a 12° para baixo. Reduza o setor ou mude a arma de lugar.');
  // A gun fed by a belt or a magazine carries its ready rounds with its breech: a smaller one takes less room.
  assert.equal(constructionEditMessage({ ...physical, ready: true }), 'A culatra e o compartimento da munição atrás dela, que giram com o cano, ' +
    'bateriam no teto com o cano a 12° para baixo. Reduza o setor, use uma cinta ou um pente menor ou mude a arma de lugar.');
  assert.equal(constructionEditMessage({ code: 'CHASSIS_OVERLOAD', loadedKg: 18000, limitKg: 13000 }),
    'Passaria do peso que o chassi aguenta: 18 / 13 t com tudo cheio. Reforce a estrutura, ajuste a rodagem ou tire peso.');
  assert.equal(constructionEditMessage(new TypeError('defeito interno'), { quiet: true }),
    'Essa mudança não pôde ser feita; o projeto continua como estava.');
  assert.equal(constructionEditMessage(new Error('Escolha outra chapa.')), 'Escolha outra chapa.');
  assert.equal(constructionEditMessage(Object.assign(new Error('Posição inválida.'), { code: 'STRUCTURED_CONSTRUCTION' })), 'Posição inválida.');
  assert.equal(constructionEditMessage(Object.assign(new Error('diagnóstico de uma regra desconhecida'),
    { code: 'STRUCTURED_CONSTRUCTION', reason: 'NEW_RULE' }), { quiet: true }),
    'Essa mudança não pôde ser feita; o projeto continua como estava.');
});
