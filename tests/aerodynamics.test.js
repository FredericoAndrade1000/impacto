import test from 'node:test';
import assert from 'node:assert/strict';
import { blueprintPowertrain } from '../src/mass-properties.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

test('the native drag follows the admitted hull slope and frontal size', () => {
  const hull = (frontInset, height = 2) => createStructuredConstruction({ length: 6, height,
      frontInset, rearInset: 0, thicknessMm: 5 }),
    box = hull(0), wedge = hull(4), tall = hull(0, 3),
    before = structuredClone([box, wedge, tall]),
    [wall, nose, taller] = [box, wedge, tall].map(source => blueprintPowertrain(source).drag);
  assert(nose > 0 && nose < wall, 'the sloping front has less native aerodynamic resistance');
  assert(taller > wall, 'a taller admitted hull shows more frontal area');
  assert.deepEqual([box, wedge, tall], before, 'reading mechanics does not change the authored frame');
});
