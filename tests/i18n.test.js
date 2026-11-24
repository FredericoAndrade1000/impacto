import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLanguage, languagePreference, configureLanguage, language, locale, languageURL, phrase, phraseList, translate, LANGUAGE_KEY } from '../src/i18n.ts';
import { number } from '../src/format.ts';
import { userError, errorText } from '../src/user-message.ts';
import { ENGLISH } from '../src/locales/en.ts';
import { SPANISH } from '../src/locales/es.ts';
import { bill, billText, shortMessage, shortText, scantText } from '../src/economy.ts';

test('fractional fuel bills remain visible and use the selected language and decimal separator', t => {
  t.after(() => configureLanguage({ search: '?lang=pt-BR' }));
  configureLanguage({ search: '?lang=pt-BR' });
  assert.equal(billText(bill(0, 0, 0, .125)), 'Combustível 0,125 L');
  assert.equal(billText(bill(0, 0, 0, .00001)), 'Combustível < 0,001 L');
  assert.equal(shortText(bill(0, 0, 0, .125), bill(0, 0, 0, .25)), 'Falta Combustível: custa 0,25 L e a facção tem 0,125 L.');
  assert.equal(scantText(bill(0, 0, 0, .125), bill(0, 0, 0, .25), 'o combustível', 'que ele leva'), 'Os suprimentos que ele leva não pagam o combustível: Combustível 0,125 de 0,25 L.');
  configureLanguage({ search: '?lang=en' });
  assert.equal(billText(bill(0, 0, 0, .125)), 'Fuel 0.125 L');
  assert.equal(billText(bill(0, 0, 0, .00001)), 'Fuel < 0.001 L');
  assert.equal(shortText(bill(0, 0, 0, .125), bill(0, 0, 0, .25)), 'Missing Fuel: costs 0.25 L and the faction has 0.125 L.');
});

test('the first supported browser language is used, with English as the unsupported-language fallback', () => {
  assert.equal(browserLanguage(['es-ES', 'pt-PT', 'en-US']), 'es');
  assert.equal(browserLanguage(['ja-JP', 'es-MX', 'en-US']), 'es');
  assert.equal(browserLanguage(['pt-PT', 'es-419']), 'pt-BR');
  assert.equal(browserLanguage(['en-GB', 'pt-BR']), 'en');
  assert.equal(browserLanguage(['ja-JP']), 'en');
});

test('a saved manual choice overrides the browser and an explicit URL works with blocked storage', t => {
  t.after(() => configureLanguage({ search: '?lang=pt-BR' }));
  const storage = { getItem: () => 'pt-BR' };
  configureLanguage({ storage, languages: ['en-US'] });
  assert.equal(language(), 'pt-BR'); assert.equal(number(1234.5), '1.234,5');
  configureLanguage({ storage, search: '?lang=en', languages: ['pt-BR'] });
  assert.equal(language(), 'en'); assert.equal(locale(), 'en-US'); assert.equal(number(1234.5), '1,234.5');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(languagePreference({ storage: blocked }), 'auto');
  const url = languageURL('es', { url: 'https://game.invalid/?_impacto_build=123#project', storage: blocked });
  assert.equal(new URL(url).searchParams.get('lang'), 'es');
  assert.equal(new URL(url).searchParams.get('_impacto_build'), '123');
  assert.equal(new URL(url).hash, '#project');
  configureLanguage({ storage: blocked, search: new URL(url).search, languages: ['pt-BR'] });
  assert.equal(language(), 'es'); assert.equal(locale(), 'es-419'); assert.equal(number(1234.5), '1,234.5');
  configureLanguage({ storage: { getItem: () => 'es' }, languages: ['pt-BR'] });
  assert.equal(language(), 'es');
});

test('returning to automatic clears the URL override and stores the preference without erasing other settings', () => {
  const writes = [], storage = { setItem: (...values) => writes.push(values) };
  const url = languageURL('auto', { url: 'https://game.invalid/?lang=en&test=1', storage });
  assert(!new URL(url).searchParams.has('lang')); assert.equal(new URL(url).searchParams.get('test'), '1');
  assert.deepEqual(writes, [[LANGUAGE_KEY, 'auto']]);
  assert.throws(() => languageURL('xx', { url, storage }));
});

test('translation substitutes values without translating or interpreting player content', () => {
  const name = 'Ferro {0} <b>English</b>', message = phrase`Faltam recursos para a melhoria: ${name}.`;
  assert.equal(translate(message, 'en'), `Not enough resources for this upgrade: ${name}.`);
  assert.equal(translate(message, 'pt-BR'), `Faltam recursos para a melhoria: ${name}.`);
  assert.equal(translate(message, 'es'), `Faltan recursos para la mejora: ${name}.`);
  assert.equal(translate('Unknown custom design', 'en'), 'Unknown custom design');
  assert.equal(translate('constructor', 'en'), 'constructor', 'prototype properties are never dictionary entries');
});

test('public error phrases cross the wire as data and translate trusted catalogue labels, preserving canonical logs and plain player strings', t => {
  configureLanguage({ languages: ['en'] }); t.after(() => configureLanguage({ languages: ['pt-BR'] }));
  const error = userError`Requer ${phraseList([phrase('Oficina II'), phrase('Hangar I')])}. Veja as melhorias da base.`;
  assert.equal(error.constructor, Error);
  assert.equal(error.message, 'Requer Oficina II, Hangar I. Veja as melhorias da base.');
  assert.equal(errorText(JSON.parse(JSON.stringify({ error: error.message, userMessage: error.userMessage }))), 'Requires Workshop II, Hangar I. See base upgrades.');
  assert.equal(errorText({ error: 'Aguarde a conexão com o campo.', userMessage: { key: 9, values: [] } }), 'Wait for the field connection.');
  const recursive = { key: '{0}', values: [] }; recursive.values.push(recursive);
  assert.equal(errorText({ error: 'Safe fallback', userMessage: recursive }), 'Safe fallback');
  const named = userError`Este veículo está com ${'Ferro {0}'} até ser liberado.`;
  assert.equal(errorText({ error: named.message, userMessage: named.userMessage }), 'This vehicle is held by Ferro {0} until released.');
  const short = userError(shortMessage(bill(1, 2), bill(8, 9), phrase('fabricar')));
  configureLanguage({ languages: ['es-MX'] });
  const reply = JSON.parse(JSON.stringify({ error: short.message, userMessage: short.userMessage }));
  assert.equal(errorText(reply), 'Faltan Hierro y Aleaciones para fabricar: Hierro cuesta 8 y la facción tiene 1; Aleaciones cuesta 9 y la facción tiene 2.');
});

test('dictionary phrases retain every positional value and cannot introduce untranslated markup placeholders', () => {
  const indices = text => [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
  assert.deepEqual(Object.keys(SPANISH).sort(), Object.keys(ENGLISH).sort());
  for (const dictionary of [ENGLISH, SPANISH]) for (const [key, value] of Object.entries(dictionary)) assert.deepEqual(indices(value), indices(key), key);
});
