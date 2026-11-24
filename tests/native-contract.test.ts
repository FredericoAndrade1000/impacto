import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { typeDiagnostics } from './helpers/type-diagnostics.ts';

test('the vehicle projection consumes the generated Rust contract without accepting malformed state', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), file = join(root, 'tests/native-contract.fixture.ts'),
    rows = [
      "import { applyNativeVehicle, VEHICLE_STATE } from '../src/native-vehicle.ts';",
      "import type { NativeVehicle, NativePowertrain, NativePoint } from '../src/native-contract.gen.ts';",
      'declare const state: NativeVehicle;',
      'const target = { config: { enabled: true }, mass: 4000 };',
      'applyNativeVehicle(target, state);',
      'const key: keyof NativeVehicle = VEHICLE_STATE[0];',
      'const point: NativePoint = state.localCenter;',
      'const drivetrain: NativePowertrain = state.drivetrain;',
      "applyNativeVehicle(target, { ...state, grounded: 'yes' }); // invalid",
      'applyNativeVehicle(target, { ...state, localCenter: { x: 0 } }); // invalid',
      'applyNativeVehicle(target, { ...state, station: [0] }); // invalid',
      'applyNativeVehicle(target, { ...state, drivetrain: { ...state.drivetrain, gearedSpeed: false } }); // invalid',
      'applyNativeVehicle(target, { ...state, groundPressureKPA: 1 }); // invalid',
      'applyNativeVehicle({ config: { enabled: 1 }, mass: 4000 }, state); // invalid',
      "const unknown = 'inventedState' satisfies keyof NativeVehicle; // invalid",
    ], errors = typeDiagnostics(file, rows.join('\n')),
    expected = rows.flatMap((row, index) => row.endsWith('// invalid') ? [index + 1] : []),
    actual = errors.map(diagnostic => {
      assert.equal(resolve(diagnostic.file?.fileName ?? ''), file, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      assert.notEqual(diagnostic.start, undefined);
      return diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
    }).filter((line): line is number => line !== undefined).map(line => line + 1);
  assert.deepEqual([...new Set(actual)].sort((a, b) => a - b), expected);
});
