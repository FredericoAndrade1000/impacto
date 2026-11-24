import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint, DESIGN_VERSION, parseBlueprint, serializeBlueprint, validateBlueprint } from '../src/persistence.ts';
import { DesignLibrary, LIBRARY_KEY } from '../src/library.ts';
import { Editor } from '../src/editor.ts';

await initNativeDynamics();

const REFUSED = /não é um projeto desta versão/, DERIVED = ['modules', 'frame', 'rooms', 'bodyPanels', 'attachments', 'derived'];

test('authoring round-trips nodes, plate material, component poses and weapon settings', () => {
  const blueprint = createConstruction('heavy'), before = structuredClone(blueprint);
  assert.deepEqual(parseBlueprint(serializeBlueprint(blueprint)), blueprint);
  assert.deepEqual(blueprint, before);
  assert.equal(blueprint.version, DESIGN_VERSION); for (const field of DERIVED) assert(!Object.hasOwn(blueprint, field), field);
});
test('bad JSON, identities and nonfinite geometry are rejected by the one compiler', () => {
  assert.throws(() => parseBlueprint('not-json'), /corrompido ou é de outro tipo/);
  const blueprint = createConstruction('heavy'); blueprint.nodes[0].x = Infinity;
  assert.throws(() => validateBlueprint(blueprint), error => error.reason === 'FIELD' && ["hull-0"].every(id => error.nodeIds?.includes(id)) && error.field === "x");
  const duplicate = createConstruction('heavy'); duplicate.components[1].id = duplicate.components[0].id;
  assert.throws(() => validateBlueprint(duplicate), { reason: 'COMPONENT_IDENTITY' });
});
for (const version of [5, 6]) test(`obsolete version${version} is refused at all public construction boundaries`, () => {
  const source = createConstruction('heavy'), old = { ...source, version }, before = structuredClone(old),
    data = new Map(), storage = { setItem: (k, v) => data.set(k, v), getItem: k => data.get(k) ?? null },
    library = new DesignLibrary(storage), saved = library.create(source), text = storage.getItem(LIBRARY_KEY);
  for (const operation of [validateBlueprint, compileBlueprint, serializeBlueprint, value => parseBlueprint(JSON.stringify(value)),
    value => new Editor(value), value => library.update(saved.id, value)]) assert.throws(() => operation(old), REFUSED);
  assert.deepEqual(old, before); assert.equal(storage.getItem(LIBRARY_KEY), text); assert.deepEqual(library.active, saved);
  const editor = new Editor(source, saved.id), previous = structuredClone(editor.source), history = editor.past.length;
  assert.throws(() => editor.replace(old), REFUSED);
  assert.deepEqual(editor.source, previous); assert.equal(editor.projectId, saved.id); assert.equal(editor.past.length, history);
});
test('derived read-only geometry cannot become authoring state or a saved document', () => {
  const source = createConstruction('heavy'), dto = compileBlueprint(source), editor = new Editor(source);
  assert.throws(() => serializeBlueprint(dto), REFUSED);
  assert.throws(() => { editor.blueprint = dto; }, /não pode ser editado/);
  assert.deepEqual(editor.source, source);
});
test('static templates use the same authoring and compiler instead of a laboratory fallback', () => {
  for (const id of ['plate', 'empty', 'bunker', 'outpost']) {
    const source = createConstruction(id), compiled = compileBlueprint(source);
    assert.equal(source.version, DESIGN_VERSION); assert(!Object.hasOwn(source, 'chassis')); assert.equal(compiled.vehicle.enabled, false);
    assert.equal(compiled.mechanicalAdmission, true); assert.equal(compiled.rooms.length, 1);
    assert.deepEqual(new Editor(source).source, source);
  }
});
test('fixed authors store signed coordinates and refuse retired ride-height settings unchanged', () => {
  for (const id of ['plate', 'empty']) {
    const source = createConstruction(id); assert.equal(Object.hasOwn(source, 'rideHeight'), false);
    assert(source.nodes.some(node => node.y < 0));
    const invalid = { ...source, rideHeight: .05 }, before = structuredClone(invalid);
    assert.throws(() => validateBlueprint(invalid), { reason: 'AUTHORING_FIELDS' });
    assert.throws(() => compileBlueprint(invalid), { reason: 'AUTHORING_FIELDS' });
    assert.deepEqual(invalid, before);
  }
});
