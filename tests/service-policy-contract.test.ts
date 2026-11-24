import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { typeDiagnostics } from './helpers/type-diagnostics.ts';

test('a repair without a provider cannot carry a partial repair, and offers retain the provider type', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), file = join(root, 'tests/service-policy.fixture.ts'),
    rows = [
      "import { repairOffer, serviceOffers } from '../server/service-policy.ts';",
      "import type { RepairPoint, RepairQuote, RepairOffer, PartialRepair } from '../server/service-policy.ts';",
      "import { bill } from '../src/economy-contract.ts';",
      'declare const point: RepairPoint & { id: string };',
      'declare const quote: RepairQuote;',
      'declare const partial: PartialRepair;',
      'const whole: RepairOffer<typeof point> = [point, null];',
      'const part: RepairOffer<typeof point> = [point, partial];',
      'const absent: RepairOffer<typeof point> = [null, null];',
      'const result = repairOffer([point], quote);',
      'if (result[0] === null) { const noPartial: null = result[1]; }',
      'if (result[0]) { const id: string = result[0].id; }',
      'const offers = serviceOffers({ blueprint: { modules: [] } },',
      '  { ...quote, rearm: bill(), full: {}, levels: {} }, [{ ...point, held: "", note: "nearest" }]);',
      'const note: string | undefined = offers.point?.note;',
      'const impossible: RepairOffer<typeof point> = [null, partial]; // invalid',
    ], errors = typeDiagnostics(file, rows.join('\n')),
    expected = rows.flatMap((row, index) => row.endsWith('// invalid') ? [index + 1] : []),
    actual = errors.map(diagnostic => {
      assert.equal(resolve(diagnostic.file?.fileName ?? ''), file, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      assert.notEqual(diagnostic.start, undefined);
      return diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
    }).filter((line): line is number => line !== undefined).map(line => line + 1);
  assert.deepEqual([...new Set(actual)].sort((a, b) => a - b), expected);
});
