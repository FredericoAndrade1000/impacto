import test from 'node:test';
import assert from 'node:assert/strict';
import { damageTone, partViews } from '../src/part-view.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { designFrame } from '../src/scene-frame.ts';

// How a piece on the field colours the picture of its construction in the column of the field (squad-ux.ts): by its
// condition, as the Condição tells it.
test('a piece colours the picture of its construction as damaged or lost by its condition, and a few holes in a plate are nothing', () => {
  const piece = patch => ({ id: 'a:1:engine', kind: 'engine', health: 100, maxHealth: 100, attached: true, ...patch }),
    plate = patch => ({ id: 'a:1:hull:roof', definition: {}, integrity: 1, marks: [], attached: true, ...patch });
  assert.deepEqual([piece(), piece({ health: 96 }), piece({ health: 94 }), piece({ health: 0 }), piece({ attached: false }), piece({ kind: 'fuel', detonated: true, health: 40 })].map(damageTone),
    ['', '', 'hurt', 'lost', 'lost', 'lost']);
  assert.deepEqual([piece({ kind: 'weapon', barrelDisabled: true }), piece({ kind: 'weapon', elevationDisabled: true })].map(damageTone), ['hurt', 'hurt'], 'a gun that does not fire or lay');
  assert.deepEqual([plate(), plate({ integrity: .9 }), plate({ integrity: .66 }), plate({ integrity: .64 }), plate({ integrity: .02 }), plate({ attached: false })].map(damageTone),
    ['', '', '', 'hurt', 'lost', 'lost']);
  // A plate is damaged where the Condição says it is shot through over a good share of it, and lost where its material is spent.
  const frame = designFrame(compileBlueprint(createConstruction('recon'))), roof = frame.plates.find(p => p.id === 'hull:roof'),
    told = integrity => [damageTone({ ...roof, integrity }), partViews(frame, { ...frame, plates: [{ ...roof, integrity }] }, ['hull:roof'])[0].health.status];
  assert.deepEqual([.9, .64, .02].map(told), [['', 'Perfuração parcial'], ['hurt', 'Perfuração extensa'], ['lost', 'Material esgotado']]);
});
