import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('fresh Portuguese, English and Spanish clients admit identical physical catalogues and author the same ready designs', () => {
  // Configure before the real imports, as bootstrap does. Separate processes
  // prevent a Portuguese catalogue cache from hiding an English initialization bug.
  const program = `
    const { configureLanguage } = await import('./src/i18n.ts');
    configureLanguage({ languages: [process.argv[1]] });
    const { templateCatalogue, createStructuredTemplate } = await import('./src/structured-templates.ts');
    const { partName } = await import('./src/part-view.ts');
    process.stdout.write(JSON.stringify({ catalogue: templateCatalogue(), source: createStructuredTemplate('heavy'),
      label: partName({ kind: 'weapon', weaponPreset: 'm119' }) }));
  `;
  const read = language => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program, language],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  const portuguese = read('pt-BR'), english = read('en'), spanish = read('es');
  assert.deepEqual(english.catalogue, portuguese.catalogue);
  assert.deepEqual(english.source, portuguese.source, 'names, authored dimensions and decorative values are preserved');
  assert.deepEqual(spanish.catalogue, portuguese.catalogue);
  assert.deepEqual(spanish.source, portuguese.source);
  assert.equal(english.label, 'M119 howitzer · 105 mm');
  assert.equal(portuguese.label, 'Obuseiro M119 · 105 mm');
  assert.equal(spanish.label, 'Obús M119 · 105 mm');
});
