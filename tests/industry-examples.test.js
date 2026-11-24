import test from 'node:test';
import assert from 'node:assert/strict';
import { INDUSTRY_EXAMPLES, industryExample, industryExampleSource } from '../src/industry-examples.ts';
import { BASIC_INDUSTRY, INDUSTRY_UPGRADES, missingIndustry } from '../src/industry.ts';
import { compileManufacture } from '../src/structured-construction.ts';
import { constructionSVG } from '../src/construction-preview.ts';
import { configureLanguage, tr } from '../src/i18n.ts';

test('each upgrade example is manufacturable with that facility and the basic levels of the others', () => {
  for (const upgrade of INDUSTRY_UPGRADES) {
    const data = industryExample(upgrade.id), installed = { ...BASIC_INDUSTRY, [upgrade.facility]: upgrade.level };
    assert.equal(data.admission.oversized, null, upgrade.id);
    assert.deepEqual(missingIndustry(data.admission, installed), [], upgrade.id + ' has no hidden second-facility prerequisite');
    assert(missingIndustry(data.admission, { ...installed, [upgrade.facility]: upgrade.level - 1 })
      .some(need => need.facility === upgrade.facility && need.level === upgrade.level), upgrade.id + ' demonstrates this level');
    assert(data.cost.ferro + data.cost.ligas + data.cost.silica > 0);
    assert.match(constructionSVG(data.compiled), /<svg/);
    assert.doesNotThrow(() => compileManufacture(structuredClone(data.source)), upgrade.id);
  }
});

test('examples can be edited independently and have translated names', t => {
  const copy = industryExampleSource('hangar-i'), initial = JSON.stringify(copy);
  copy.components[0].pose.x += 10; copy.name = 'Personal';
  assert.equal(JSON.stringify(industryExampleSource('hangar-i')), initial);
  configureLanguage({ languages: ['en'] }); t.after(() => configureLanguage({ languages: ['pt-BR'] }));
  for (const example of Object.values(INDUSTRY_EXAMPLES)) assert.notEqual(tr(example.name), example.name);
});
