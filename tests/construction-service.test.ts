import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bill } from '../src/economy-contract.ts';
import { buildService, repairService, turnService, dismantleService, advanceService, actorService, factionService } from '../src/construction-service.ts';
import { serviceText, serviceWaitText } from '../src/service-presentation.ts';
import { typeDiagnostics } from './helpers/type-diagnostics.ts';

test('hits cancel turns even at their deadline, while paid manufacture and repair finish on time', () => {
  const build = buildService(20, true), repair = repairService(20, {
    levels: { tank: { fuelLitres: 12 }, hopper: { cargo: { ferro: 30 } } }, cost: bill(200), payer: 'supplier', pieces: null,
  });
  for (const hit of [false, true]) {
    assert.equal(advanceService(build, 19, hit), null);
    assert.equal(advanceService(repair, 19, hit), null);
    assert.deepEqual(advanceService(build, 20, hit), { kind: 'finish-build', objective: true });
    assert.deepEqual(advanceService(repair, 20, hit), { kind: 'finish-repair' });
  }
  for (const aloft of [false, true]) {
    const turn = turnService(20, aloft);
    assert.equal(advanceService(turn, 19, false), null);
    assert.deepEqual(advanceService(turn, 20, false), { kind: 'finish-turn' });
    assert.deepEqual(advanceService(turn, 19, true), { kind: 'cancel-turn' });
    assert.deepEqual(advanceService(turn, 20, true), { kind: 'cancel-turn' });
  }
  const dismantle = dismantleService(20, 'relocation');
  dismantle.progress = .6;
  assert.equal(advanceService(dismantle, 200, true), null, 'elapsed time never replaces work supplied by builders');
  assert.equal(advanceService(null, 200, true), null);
});

test('actor and faction projections preserve their precision and keep paid repair data private', () => {
  const dismantle = dismantleService(30, 'relocation'), sent = { phase: 'go' };
  dismantle.progress = .45789;
  assert.deepEqual(actorService(dismantle), { kind: 'dismantle', progress: .45 });
  const view = factionService(dismantle, { building: true, sent });
  assert.deepEqual(view, { kind: 'dismantle', progress: .457, seconds: 30, to: 'relocation', building: true, sent });
  assert.equal(serviceText(view, 100), 'desmontando · 45%');
  assert.equal(serviceWaitText(view), 'Essa estrutura está sendo desmontada.');
  const repair = repairService(40, { levels: { tank: { fuelLitres: 12 } }, cost: bill(200), payer: 'supplier', pieces: [{ id: 'engine', share: .5 }] });
  assert.deepEqual(actorService(repair), { kind: 'repair', until: 40 });
  assert.deepEqual(factionService(repair), { kind: 'repair', until: 40, cost: bill(200), payer: 'supplier', partial: true });
  assert.deepEqual(factionService(turnService(20)), { kind: 'turn', until: 20, cost: undefined, payer: undefined, partial: false });
  assert.deepEqual(factionService(turnService(20, true)), { kind: 'turn', until: 20, cost: undefined, payer: undefined, partial: false, aloft: true });
  assert.deepEqual(buildService(20), { kind: 'build', until: 20 }, 'absent optional flags retain the saved and wire shape');
  assert.equal(actorService(null), null);
  assert.equal(factionService(null), null);
});

test('the service contract rejects invented deadlines, unpaid repairs and incomplete dismantling projections', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), file = join(root, 'tests/construction-service.fixture.ts'),
    rows = [
      "import { bill } from '../src/economy-contract.ts';",
      "import { buildService, repairService, turnService, dismantleService, advanceService, actorService, factionService } from '../src/construction-service.ts';",
      "import type { ConstructionService } from '../src/construction-service.ts';",
      "import { serviceText } from '../src/service-presentation.ts';",
      'const down = dismantleService(30, null);',
      'down.progress = .5;',
      'const build = buildService(20, true);',
      'const repair = repairService(20, { levels: { tank: { fuelLitres: 1 }, hopper: { cargo: {} } }, cost: bill(10), payer: null, pieces: null });',
      'advanceService(repair, 20, true); serviceText(build, 10); actorService(build);',
      'factionService(down, { building: false, sent: null });',
      "const clock: ConstructionService = { kind: 'dismantle', progress: 0, seconds: 30, to: null, until: 30 }; // invalid",
      "const unpaid: ConstructionService = { kind: 'repair', until: 20 }; // invalid",
      'repairService(20, { levels: {}, cost: bill(10), pieces: null }); // invalid',
      'factionService(down); // invalid',
      'factionService(down, { building: false }); // invalid',
      "serviceText({ kind: 'turn', progress: .5 }, 10); // invalid",
    ], errors = typeDiagnostics(file, rows.join('\n')),
    expected = rows.flatMap((row, index) => row.endsWith('// invalid') ? [index + 1] : []),
    actual = errors.map(diagnostic => {
      assert.equal(resolve(diagnostic.file?.fileName ?? ''), file, String(diagnostic.messageText));
      assert.notEqual(diagnostic.start, undefined);
      return diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
    }).filter((line): line is number => line !== undefined).map(line => line + 1);
  assert.deepEqual([...new Set(actual)].sort((a, b) => a - b), expected);
});
