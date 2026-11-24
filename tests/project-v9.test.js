import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint, parseBlueprint } from '../src/persistence.ts';
import { DesignLibrary, LIBRARY_KEY } from '../src/library.ts';
import { fromVersion9 } from '../src/project-v9.ts';

await initNativeDynamics();

function store(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
// A stock design as the format 9 wrote it: each gun naming the plate it fires through or stands on.
const v9 = project => {
  const compiled = compileBlueprint(project);
  return { ...structuredClone(project), version: 9, components: project.components.map(part => part.kind !== 'weapon' ? structuredClone(part)
    : { ...structuredClone(part), mount: { ...part.mount, hostId: compiled.modules.find(module => module.id === part.id).weaponMount.hostId } }) };
};

test('a project of the format 9 is read as the format 10, its guns naming no plate, and nothing else is', () => {
  const heavy = createConstruction('heavy'), old = v9(heavy);
  assert.equal(old.version, 9); assert.equal(old.components.find(part => part.kind === 'weapon').mount.hostId, 'turret:front');
  assert.deepEqual(fromVersion9(old), heavy);
  // The core finds the same plate from the pose alone.
  assert.equal(compileBlueprint(fromVersion9(old)).modules.find(part => part.kind === 'weapon').weaponMount.hostId, 'turret:front');
  // What is not of the format 9 is given back as it is.
  for (const value of [heavy, createConstruction('truck'), null, 'texto', { version: 9 }]) assert.equal(fromVersion9(value), value);
  // A file of the format 9 is not imported.
  assert.throws(() => parseBlueprint(JSON.stringify(old)));
});

test('the garage of the format 9 is read as the format 10 and kept so', () => {
  const heavy = createConstruction('heavy'), bunker = createConstruction('bunker');
  const browser = store({ [LIBRARY_KEY]: JSON.stringify({ version: 4, activeId: 'a', entries: [
    { id: 'a', createdAt: '2026-10-01', updatedAt: '2026-10-02', blueprint: v9(heavy) },
    { id: 'b', createdAt: '2026-10-01', updatedAt: '2026-10-01', blueprint: bunker }] }) });
  const garage = new DesignLibrary(browser);
  assert.equal(garage.error, null);
  assert.deepEqual(garage.get('a').blueprint, heavy); assert.deepEqual(garage.get('b').blueprint, bunker);
  assert.equal(garage.active.id, 'a');
  // Kept again at once in the format 10: another tab reads it so, and finds nothing to convert.
  const kept = JSON.parse(browser.getItem(LIBRARY_KEY));
  assert.deepEqual(kept.entries.map(entry => [entry.id, entry.blueprint.version]), [['a', 10], ['b', 10]]);
  assert.deepEqual(kept.entries.map(entry => [entry.createdAt, entry.updatedAt]), [['2026-10-01', '2026-10-02'], ['2026-10-01', '2026-10-01']]);
  assert(kept.entries.every(entry => entry.blueprint.components.every(part => !Object.hasOwn(part.mount ?? {}, 'hostId'))));
  const text = browser.getItem(LIBRARY_KEY);
  new DesignLibrary(browser); assert.equal(browser.getItem(LIBRARY_KEY), text);
  // A browser that will not take it now still opens it, and writes it at the next save.
  const full = store({ [LIBRARY_KEY]: JSON.stringify({ version: 4, activeId: 'a', entries: [
    { id: 'a', createdAt: '2026-10-01', updatedAt: '2026-10-02', blueprint: v9(heavy) }] }) });
  full.setItem = () => { throw new Error('cheio'); };
  assert.deepEqual(new DesignLibrary(full).get('a').blueprint, heavy);
});
