import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fieldStore, FIELD_SAVE } from '../server/field-save.ts';

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-save-envelope-'));
  t.after(() => { assert(dir.startsWith(join(tmpdir(), 'impacto-save-envelope-'))); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('the store preserves the factory return type and leaves the room payload to its owner', t => {
  const dir = directory(t), file = join(dir, 'field.json'), store = fieldStore(dir), created = new Map([['generation', 1]]);
  assert.equal(store.open(kept => { assert.equal(kept, null); return created; }), created);
  const state = { scene: { tick: 12 }, extraDomainData: ['the room owns this'] };
  assert.equal(store.save({ keep: () => state }), true);
  assert.deepEqual(store.open(kept => new Map([['state', kept]])).get('state'), state);
  // Existing labels and absent dates are metadata, not another version of the room schema.
  for (const metadata of [{ at: 'fixture49' }, {}]) {
    const text = JSON.stringify({ save: FIELD_SAVE, room: state, ...metadata });
    writeFileSync(file, text);
    assert.deepEqual(store.open(kept => kept), state);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('invalid JSON envelopes are refused before the room factory and keep their original bytes', t => {
  const dir = directory(t), file = join(dir, 'field.json'), store = fieldStore(dir);
  let opens = 0;
  for (const text of ['null', '[]', 'true', '"field"', '{}', '{"save":"29","room":{}}',
    '{"save":29}', '{"save":29,"room":null}', '{"save":29,"room":[]}', '{"save":29,"room":1}']) {
    writeFileSync(file, text);
    const version = text.startsWith('{"save":29'),
      message = version ? 'O arquivo salvo não contém o estado do campo.' : 'O campo salvo é de outra versão do jogo.';
    assert.throws(() => store.open(() => ++opens), { message });
    assert.equal(readFileSync(file, 'utf8'), text);
  }
  assert.equal(opens, 0);
});

test('a failed keep leaves the good checkpoint intact and reports arbitrary thrown values without throwing again', t => {
  const dir = directory(t), file = join(dir, 'field.json'), store = fieldStore(dir), said: unknown[][] = [];
  t.mock.method(console, 'error', (...words: unknown[]) => { said.push(words); });
  assert.equal(store.save({ keep: () => ({ scene: {} }) }), true);
  const before = readFileSync(file, 'utf8');
  for (let attempt = 0; attempt < 2; attempt++) assert.equal(store.save({ keep() { throw null; } }), false);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(said.length, 1, 'the same failure is reported once');
  assert.equal(store.save({ keep: () => ({ scene: { tick: 1 } }) }), true);
  assert.notEqual(readFileSync(file, 'utf8'), before);
});

test('save 29 opens unchanged and receives an exact backup before the current format is written', t => {
  const dir = directory(t), file = join(dir, 'field.json'), store = fieldStore(dir),
    room = { scene: { tick: 777 }, factions: [{ stock: { ferro: 12345 } }] },
    before = JSON.stringify({ save: 29, at: 'before commanders', room }, null, 2) + '\n';
  writeFileSync(file, before);
  assert.deepEqual(store.open(kept => kept), room);
  assert.equal(readFileSync(file, 'utf8'), before, 'opening never rewrites an older checkpoint');
  assert.deepEqual(readdirSync(dir), ['field.json']);
  assert.equal(store.save({ keep: () => room }), true);
  const backups = readdirSync(dir).filter(name => name.startsWith('field.before-commanders-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]!), 'utf8'), before);
  const current = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(current.save, FIELD_SAVE);
  assert.deepEqual(current.room, room, 'admission changes no economy or physical payload');
  assert.equal(store.save({ keep: () => room }), true);
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('field.before-commanders-')), backups);
  unlinkSync(file);
  assert.throws(() => fieldStore(dir).open(() => null), /há dados do campo preservados/);
  assert.equal(readFileSync(join(dir, backups[0]!), 'utf8'), before, 'a backup alone never becomes a fresh world');
});

test('save 29 cannot hide commander metadata under its previous format tag', t => {
  const dir = directory(t), file = join(dir, 'field.json'),
    before = JSON.stringify({ save: 29, room: { scene: {}, commanders: [] } });
  writeFileSync(file, before);
  assert.throws(() => fieldStore(dir).open(() => assert.fail('not a legacy field')), /Controladores exigem o formato atual/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('save 30 preserves an exact checkpoint before admitting definitive duel metadata', t => {
  const dir = directory(t), file = join(dir, 'field.json'), store = fieldStore(dir), room = { scene: { time: 5229 } },
    before = JSON.stringify({ save: 30, room });
  writeFileSync(file, before);
  assert.deepEqual(store.open(kept => kept), room);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert(store.save({ keep: () => room }));
  const backup = readdirSync(dir).find(name => name.startsWith('field.before-duel-save30-'));
  assert(backup); assert.equal(readFileSync(join(dir, backup), 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).save, FIELD_SAVE);
  unlinkSync(file);
  assert.throws(() => fieldStore(dir).open(() => null), /há dados do campo preservados/);
  writeFileSync(file, JSON.stringify({ save: 30, room: { ...room, duel: { phase: 'playing' } } }));
  assert.throws(() => fieldStore(dir).open(() => null), /Duelos exigem o formato atual/);
});

test('save 31 retains the duel and receives an exact backup before commander repair intentions are written', t => {
  const dir = directory(t), file = join(dir, 'field.json'), store = fieldStore(dir),
    room = { scene: { time: 11754 }, duel: { phase: 'won', winner: 'f1' }, commanders: [['j2', { history: [] }]] },
    before = JSON.stringify({ save: 31, room });
  writeFileSync(file, before);
  assert.deepEqual(store.open(kept => kept), room); assert.equal(readFileSync(file, 'utf8'), before);
  assert(store.save({ keep: () => room }));
  const backup = readdirSync(dir).find(name => name.startsWith('field.before-economy-save31-'));
  assert(backup); assert.equal(readFileSync(join(dir, backup), 'utf8'), before);
  unlinkSync(file); assert.throws(() => fieldStore(dir).open(() => null), /há dados do campo preservados/);
  writeFileSync(file, JSON.stringify({ save: 31, room: { ...room, commanders: [['j2', { deferredRepairs: [] }]] } }));
  assert.throws(() => fieldStore(dir).open(() => null), /Reparos adiados.*formato atual/);
});
