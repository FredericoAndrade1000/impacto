import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { typeDiagnostics } from './helpers/type-diagnostics.ts';
import { checkTranslations } from '../scripts/check-translations.ts';
import { ENGLISH } from '../src/locales/en.ts';
import { SPANISH } from '../src/locales/es.ts';
import { isWireMessage } from '../src/message-contract.ts';
import { configureLanguage, phrase, translate } from '../src/i18n.ts';
import { userError, errorText } from '../src/user-message.ts';
import { constructionEditError } from '../src/structured-editing.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('TypeScript rejects unknown authored keys, incorrect arity and nonserializable values', () => {
  const file = join(root, 'tests/translation-contract.fixture.ts'),
    rows = [
      "import { tr, phrase } from '../src/i18n.ts';",
      "import { userError } from '../src/user-message.ts';",
      "tr('Ferro');",
      "tr('Faltam recursos para a melhoria: {0}.', 7);",
      "userError(phrase('Ferro'));",
      "tr(null); tr(undefined);",
      "tr('This key does not exist'); // invalid",
      "tr('Ferro', 7); // invalid",
      "phrase('Faltam recursos para a melhoria: {0}.'); // invalid",
      "phrase('Faltam recursos para a melhoria: {0}.', new Date()); // invalid",
      "userError('Ferro', false); // invalid",
      "phrase(null); // invalid",
      "userError(undefined); // invalid",
    ], errors = typeDiagnostics(file, rows.join('\n')),
    expected = rows.flatMap((row, index) => row.endsWith('// invalid') ? [index + 1] : []),
    actual = errors.map(diagnostic => {
      assert.equal(resolve(diagnostic.file?.fileName ?? ''), file, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      assert.notEqual(diagnostic.start, undefined);
      return diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
    }).filter((line): line is number => line !== undefined).map(line => line + 1);
  assert.deepEqual([...new Set(actual)].sort((a, b) => a - b), expected);
});

test('the authoring gate catches missing static/tagged/catalogue text, mutations, raw data and forged structured messages', t => {
  const folder = mkdtempSync(join(tmpdir(), 'impacto-translations-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const sourceFile = join(folder, 'messages.ts'), modulePath = (name: string) => relative(folder, join(root, 'src', name)).replaceAll('\\', '/'),
    lines = [
      `import { tr as say, phrase } from ${JSON.stringify(modulePath('i18n.ts'))};`,
      `import { userError } from ${JSON.stringify(modulePath('user-message.ts'))};`,
      `import type { WireMessage } from ${JSON.stringify(modulePath('message-contract.ts'))};`,
      'const player = JSON.parse("{}");',
      "const catalogue = Object.freeze({ a: { name: 'Ferro' }, b: { name: 'Sílica' } });",
      'Object.entries(catalogue).map(([, item]) => say(item.name));',
      "function unrelated(say) { say('not our translation function'); }",
      "const good = phrase`Faltam recursos para a melhoria: ${7}.`; userError(good);",
      'say(null); say(undefined);',
      "say('Not translated yet'); // reject",
      'say`Not translated ${player.name}`; // reject',
      "say('Faltam recursos para a melhoria: {0}.'); // reject",
      "say('Ferro', player.name); // reject",
      'say(player.name); // reject',
      "const next = Object.freeze({ a: { name: 'New catalogue label' } }); say(next[player.id].name); // reject",
      "const changed = ['Ferro']; changed[0] = player.name; say(changed[0]); // reject",
      "const original = ['Ferro']; const alias = original; alias.push(player.name); say(original[0]); // reject",
      "const viaCall = ['Ferro']; const identity = item => item; const returned = identity(viaCall); returned[0] = player.name; say(viaCall[0]); // reject",
      "const overwritten = { name: 'Ferro', ...player }; say(overwritten.name); // reject",
      "const preserved = { ...player, name: 'Ferro' }; say(preserved.name);",
      "let stale = 'Ferro'; stale = player.name; say(stale); // reject",
      "userError({ key: 'Forged authored message', values: [] }); // reject",
      'userError(JSON.parse("{}") as WireMessage); // reject',
      'phrase(null); // reject',
      'userError(undefined); // reject',
      "say('Faltam recursos para a melhoria: {0}.', ...player.values); // reject",
    ];
  writeFileSync(sourceFile, lines.join('\n'));
  const { Ferro: _missing, ...spanish } = SPANISH;
  const report = checkTranslations(root, [sourceFile], {
    en: { ...ENGLISH, '{1}': '{1}', 'English-only fixture': 'English-only fixture', Sílica: '' },
    es: { ...spanish, 'Spanish-only fixture': 'Frase de prueba', 'Faltam recursos para a melhoria: {0}.': 'Faltan recursos para la mejora.' },
  }),
    own = report.issues.filter(issue => resolve(root, issue.file) === sourceFile),
    expected = lines.flatMap((line, index) => line.endsWith('// reject') ? [index + 1] : []);
  const missingSpanish = 'Missing Spanish phrase: "Ferro"';
  assert(own.some(issue => issue.text === missingSpanish));
  assert.deepEqual([...new Set(own.filter(issue => issue.text !== missingSpanish).map(issue => issue.line))].sort((a, b) => a - b), expected, JSON.stringify(own, null, 2));
  assert(report.issues.some(issue => issue.file === 'src/locales/es.ts' && issue.text.includes('Translation changes positional values')));
  assert(report.issues.some(issue => issue.text === 'Missing Spanish phrase: "English-only fixture"'));
  assert(report.issues.some(issue => issue.text === 'Missing English phrase: "Spanish-only fixture"'));
  assert(report.issues.some(issue => issue.text.includes('Empty English phrase')));
  assert(report.issues.some(issue => issue.text.includes('Catalogue phrase has invalid slots')));
  assert(report.calls > 2500); assert(report.cataloguePhrases > 250); assert(report.htmlPhrases > 300);
});

test('structured messages keep canonical replay text and reject malformed wire data before presentation', t => {
  configureLanguage({ languages: ['en'] }); t.after(() => configureLanguage({ languages: ['pt-BR'] }));
  const message = phrase`Requer ${phrase('Oficina II')}. Veja as melhorias da base.`, error = userError(message);
  assert.equal(error.constructor, Error); assert.equal(error.message, 'Requer Oficina II. Veja as melhorias da base.');
  assert.equal(errorText(JSON.parse(JSON.stringify({ error: error.message, userMessage: message }))), 'Requires Workshop II. See base upgrades.');
  configureLanguage({ languages: ['es-419'] });
  const spanishText = 'Requiere Taller II. Consulta las mejoras de la base.';
  assert.equal(errorText(JSON.parse(JSON.stringify({ error: error.message, userMessage: message }))), spanishText);
  assert.equal(errorText(new Error(spanishText)), spanishText);
  const breech = constructionEditError({ code: 'BREECH_PLATE', ready: true, surface: 'roof', angleDegrees: 15 });
  assert('userMessage' in breech && isWireMessage(breech.userMessage));
  assert.match(errorText(breech), /La culata .*con el cañón a 15° hacia arriba/);
  assert.equal(translate(message, 'pt-BR'), error.message);
  for (const malformed of [{ key: 'Ferro', values: [NaN] }, { key: 'Ferro', values: [undefined] }, { key: 'Ferro', values: Array(21).fill(1) }, { key: 7, values: [] }]) {
    assert.equal(isWireMessage(malformed), false);
    assert.equal(errorText({ userMessage: malformed, error: 'fallback from an older field' }), 'fallback from an older field');
  }
});
