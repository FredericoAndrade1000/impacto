import test from 'node:test';
import assert from 'node:assert/strict';
import { captureProjectRecords, openProjectOriginals } from '../src/project-originals.ts';
import { DESIGN_VERSION, parseBlueprint } from '../src/persistence.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { workspaceDOM, WorkspaceElement } from './helpers/dom.js';

const GARAGE = 'impacto.garagem.v4', WORKING = 'impacto.oficina.aberto', BENCH = 'impacto.oficina.bancada';
class DialogElement extends WorkspaceElement {
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
}
function store(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { data, getItem: key => data.get(key) ?? null,
    setItem() { assert.fail('export must not write storage'); }, removeItem() { assert.fail('export must not remove an original'); } };
}

test('capture keeps all five literal records before readers, independent of later writes and unavailable stores', () => {
  const local = store({ [GARAGE]: ' { invalid garage', [WORKING]: '\n{"projectId":"p"}\n', [BENCH]: '' }),
    session = store({ [WORKING]: '{"projectId":"another"}', [BENCH]: 'old bench' }), capture = captureProjectRecords({ local, session });
  assert.deepEqual(capture.records.map(({ storage, key, raw }) => [storage, key, raw]), [
    ['local', GARAGE, ' { invalid garage'], ['local', WORKING, '\n{"projectId":"p"}\n'],
    ['session', WORKING, '{"projectId":"another"}'], ['local', BENCH, ''], ['session', BENCH, 'old bench']]);
  local.data.clear(); session.data.clear();
  assert.equal(capture.records[0].raw, ' { invalid garage');
  assert.equal(capture.records[4].raw, 'old bench');
  const refused = captureProjectRecords({ local: { getItem() { throw new Error('acesso negado'); } } });
  assert.equal(refused.records.length, 5);
  assert.deepEqual(refused.records.map(record => record.error), ['acesso negado', 'acesso negado', 'Armazenamento indisponível.', 'acesso negado', 'Armazenamento indisponível.']);
});

test('the originals dialog exports literal malformed and retired records without a converter or storage writes', async t => {
  const { body } = workspaceDOM(t, DialogElement), blobs = [], revoked = [],
    local = store({ [GARAGE]: ' {garagem ilegível', [WORKING]: '\n{"version":5,"unknown":true}\n' }),
    session = store({ [BENCH]: '' }), capture = captureProjectRecords({ local, session }), before = structuredClone(capture);
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return `blob:original-${blobs.length}`; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dialog = openProjectOriginals(capture), buttons = dialog.querySelectorAll('button');
  assert.equal(dialog.open, true); assert.equal(dialog.querySelectorAll('input').length, 0);
  assert.equal(dialog.querySelectorAll('article').length, 3);
  assert.equal(buttons.some(button => /Preparar|Converter/.test(button.textContent)), false);
  buttons.find(button => button.textContent === 'Baixar todos os originais').click();
  assert.deepEqual(JSON.parse(await blobs[0].text()), capture);
  const individual = buttons.filter(button => button.textContent === 'Baixar este original');
  for (const button of individual) button.click();
  assert.deepEqual(await Promise.all(blobs.slice(1).map(blob => blob.text())), [' {garagem ilegível', '\n{"version":5,"unknown":true}\n', '']);
  assert.deepEqual(capture, before);
  buttons.find(button => button.textContent === 'Fechar').click(); assert.equal(body.contains(dialog), false);
  t.mock.timers.tick(2000); assert.deepEqual(revoked, ['blob:original-1', 'blob:original-2', 'blob:original-3', 'blob:original-4']);
});

test('a current emergency edition downloads as a normal importable project while its literal record and unsupported editions stay intact', async t => {
  await initNativeDynamics();
  workspaceDOM(t, DialogElement);
  const source = createStructuredTemplate('empty');
  source.name = 'Edição recuperada';
  source.nodes = [{ id: 'a', x: -20, y: 40 }, { id: 'b', x: 20, y: 40 }];
  source.plates = [{ id: 'floor', a: 'a', b: 'b', material: 'steel', thicknessMm: 11 }];
  const raw = '\n' + JSON.stringify({ projectId: 'saved-project', blueprint: source }) + '\n',
    old = JSON.stringify({ projectId: 'older-project', blueprint: { ...source, version: DESIGN_VERSION - 1 } }),
    local = store({ [GARAGE]: ' {garage untouched', [WORKING]: raw }), session = store({ [WORKING]: old }),
    capture = captureProjectRecords({ local, session }), before = structuredClone(capture), blobs = [];
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:recovery-' + blobs.length; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dialog = openProjectOriginals(capture), rows = dialog.querySelectorAll('article'),
    recovery = dialog.querySelectorAll('button').filter(button => button.textContent === 'Baixar projeto desta edição');
  assert.equal(recovery.length, 1, 'only the validated current edition offers a project download');
  recovery[0].click();
  const downloaded = await blobs[0].text();
  assert.deepEqual(parseBlueprint(downloaded), source, 'the existing importer accepts the authored project without recognizing an envelope');
  assert.equal(Object.hasOwn(JSON.parse(downloaded), 'projectId'), false, 'normal import creates a copy rather than adopting the original identity');
  for (const row of rows) row.querySelectorAll('button').find(button => button.textContent === 'Baixar este original').click();
  assert.deepEqual(await Promise.all(blobs.slice(1).map(blob => blob.text())), [' {garage untouched', raw, old]);
  assert.deepEqual(capture, before);
  assert.equal(local.getItem(WORKING), raw); assert.equal(session.getItem(WORKING), old);
  assert.equal(local.getItem(GARAGE), ' {garage untouched');
  t.mock.timers.tick(2000);
});
