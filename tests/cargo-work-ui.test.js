import test from 'node:test';
import assert from 'node:assert/strict';
import { cargoWorkText, carriedText, cargoGauge, haulText } from '../src/faction-ui.ts';
import { load } from '../src/economy.ts';

const cargo = patch => ({ cargo: load(1200), fill: { solid: .38, liquid: 0 }, loading: 'ferro:1', ...patch });

test('loading uses only an authoritative finite world deadline and never a cargo-derived estimate', () => {
  const work = { kind: 'load', until: 105.1 }, before = structuredClone(work);
  assert.equal(cargoWorkText(work, 100), 'carregando · 6 s');
  assert.equal(cargoWorkText(work, 104.5), 'carregando · 1 s');
  assert.equal(cargoWorkText(work, 106), 'carregando · 0 s', 'elapsed time does not invent a completed transfer');
  assert.equal(cargoWorkText(work), 'carregando', 'no world clock means no countdown');
  for (const until of [undefined, Infinity, NaN, '105']) assert.equal(cargoWorkText({ kind: 'load', until }, 100), 'carregando');
  for (const work of [null, {}, { kind: 'unload', until: 110 }, { kind: 'build', until: 110 }]) assert.equal(cargoWorkText(work, 100), '');
  assert.deepEqual(work, before);
});

test('waiting or production-limited loading suppresses even a stale deadline', () => {
  assert.equal(cargoWorkText({ kind: 'load', waiting: true, until: 110 }, 100), 'aguardando material');
  assert.equal(cargoWorkText({ kind: 'load', limited: true, until: 110 }, 100), 'carregando · depende da extração');
  assert.equal(cargoWorkText({ kind: 'load', waiting: true, limited: true, until: 110 }, 100), 'aguardando material');
});

test('the existing cargo gauge keeps its useful share and names loading or waiting accessibly', () => {
  const loading = cargo({ cargoWork: { kind: 'load', until: 105 } }), gauge = cargoGauge(loading);
  assert.equal(gauge.text, '38%'); assert.equal(gauge.share, .38); assert.match(gauge.title, /38% · carregando$/);
  assert.doesNotMatch(gauge.title, /\d+ s/, 'a title without the displayed world time does not extrapolate');
  const waiting = cargo({ cargo: load(), loading: null, fill: { solid: 0, liquid: 0 }, cargoWork: { kind: 'load', waiting: true } });
  assert.equal(carriedText(waiting), 'Carga: vazia · aguardando material');
  assert.equal(cargoGauge(waiting).text, 'vazia'); assert.match(cargoGauge(waiting).title, /aguardando material/);
});

test('the haul line shares the clock but preserves extraction, trip direction and immediate unloading semantics', () => {
  const unit = cargo({ cargoWork: { kind: 'load', until: 105.1 } }), order = { phase: 'load' };
  assert.equal(haulText(order, unit, { time: 100 }), 'transportando · carregando · 6 s · 38%');
  assert.equal(haulText(order, { ...unit, extracting: 'ferro:1' }, { extracts: true, time: 100 }), 'extração e transporte · extraindo e carregando · 6 s · 38%');
  assert.equal(haulText(order, { ...unit, cargoWork: { kind: 'load', waiting: true } }, { time: 100 }), 'transportando · aguardando material · 38%');
  assert.equal(haulText({ phase: 'home' }, unit, { time: 100 }), 'transportando · voltando à base · 38%');
  assert.equal(haulText({ phase: 'unload' }, unit, { time: 100 }), 'transportando · descarregando · 38%', 'base unloading gains no invented deadline');
});
