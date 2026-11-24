import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { Editor } from '../src/editor.ts';
import { ammunitionBoxChoice } from '../src/piece-settings.ts';
import { allowedAmmo, fedAmmo } from '../src/weapons.ts';
import { workshopAdmissionMessage, workshopChecklist, workshopReviewPart } from '../src/workshop-checklist.ts';
import { workshopContext } from '../src/workshop-context.ts';
import { createWeaponChoice } from '../src/workshop-ux.ts';
import { manufactureDesign } from '../server/field-construction.ts';

await initNativeDynamics();
// A gun fires the rounds of the boxes of its own calibre only (game_construction.rs `WEAPON_UNFED`).
const UNFED = 'Arma sem caixa de munição do calibre dela: ponha uma para fabricar.';
const of = (source, kind) => source.components.filter(part => part.kind === kind);
const made = (editor, id) => editor.blueprint.modules.find(part => part.id === id);
const told = editor => editor.reviewManufacture().filter(issue => ['WEAPON_UNFED', 'AMMUNITION_IDLE'].includes(issue.code));
const armament = editor => workshopChecklist(editor.blueprint, editor.reviewManufacture()).find(row => row.id === 'armament');
// A design whose boxes are of `preset`, as one is left when its gun is replaced and its box is not.
const boxedAs = (source, preset) => ({ ...source, components: source.components.map(part => part.kind === 'ammo' ? { ...part, ammoPreset: preset } : part) });
// The concrete bunker of the factory: a 30 mm gun over a box of its rounds. Its gun is replaced by the 12,7 mm one.
const BUNKER = createStructuredTemplate('bunker'), [GUN] = of(BUNKER, 'weapon'), [BOX] = of(BUNKER, 'ammo');
// A second gun of its calibre, out of the bunker, fed by the same box.
function twinned(editor) {
  const twin = editor.addModule('weapon', { x: 6, y: 2 }, { weaponPreset: GUN.weaponPreset });
  editor.select(null);
  return twin;
}

test('a gun replaced in the workshop takes the boxes that fed it alone to its calibre, with the rounds it fires and as many as they hold', () => {
  const editor = new Editor(BUNKER), before = structuredClone(editor.source);
  assert.equal(BOX.ammoPreset, GUN.weaponPreset); assert.notEqual(GUN.weaponPreset, 'm2hb');
  editor.select(GUN.id); editor.editProperty('weaponPreset', 'm2hb', true);
  const reserve = made(editor, BOX.id);
  assert.equal(reserve.ammoPreset, 'm2hb'); assert.equal(reserve.ammoType, fedAmmo(made(editor, GUN.id)));
  assert.equal(reserve.capacityRounds, ammunitionBoxChoice(reserve, 'm2hb', reserve.ammoType).rounds);
  assert(reserve.capacityRounds > made(new Editor(BUNKER), BOX.id).capacityRounds, 'more of the smaller rounds');
  assert.equal(reserve.rounds, reserve.capacityRounds, 'built full');
  assert.deepEqual(told(editor), []); assert.equal(armament(editor).state, 'ready');
  // One edit, undone at once.
  assert.equal(editor.past.length, 1); assert(editor.undo()); assert.deepEqual(editor.source, before);
});

test('a box another gun of the old calibre still takes stays, and the gun replaced is told it has none of its own', () => {
  const editor = new Editor(BUNKER), twin = twinned(editor);
  editor.select(GUN.id); editor.editProperty('weaponPreset', 'm2hb', true);
  assert.equal(made(editor, BOX.id).ammoPreset, GUN.weaponPreset);
  assert.deepEqual(told(editor), [{ code: 'WEAPON_UNFED', ids: [GUN.id] }]);
  const row = armament(editor);
  assert.deepEqual([row.state, row.target, row.marked, row.detail], ['attention', 'build', true, UNFED]);
  assert.equal(workshopContext([row], []).action, 'Instalar munição');
  assert.equal(workshopReviewPart(editor.blueprint, 'armament', editor.reviewManufacture()), GUN.id);
  assert.equal(made(editor, twin.id).weaponPreset, GUN.weaponPreset);
});

test('a gun replaced takes the ammunition the guns of its new calibre are fed', () => {
  const editor = new Editor(BUNKER), twin = twinned(editor), other = allowedAmmo('m242')[1];
  editor.select(twin.id); editor.editProperty('weaponPreset', 'm242', true); editor.editProperty('weaponAmmo', other, true);
  // The bunker's gun becomes one more of that calibre: the two are fed one ammunition, and its box goes with it.
  editor.select(GUN.id); editor.editProperty('weaponPreset', 'm242', true);
  assert.equal(made(editor, GUN.id).weaponAmmo, other);
  assert.deepEqual([made(editor, BOX.id).ammoPreset, made(editor, BOX.id).ammoType], ['m242', other]);
  assert.deepEqual(told(editor), []);
});

test('the swap says the box went with the gun, and that a gun left with no round of its calibre has none', () => {
  const swap = editor => {
    const notices = [], button = () => ({ addEventListener() {}, click() {} }),
      ux = createWeaponChoice({ editor, view: { mode: 'edit' }, renderer: {}, openTask() {}, arsenal: button(), testArsenal: button(),
        arsenalDialog: { dataset: {}, addEventListener() {} }, refresh() {}, toast: text => notices.push(text) });
    ux.beginWeaponChoice('replace', GUN.id); assert.equal(ux.replaceWeapon('m2hb'), true);
    return notices.at(-1);
  };
  assert.equal(swap(new Editor(BUNKER)), 'Arma trocada por Metralhadora M2 · 12,7 mm · a caixa de munição passou para o calibre dela.');
  const shared = new Editor(BUNKER); twinned(shared);
  assert.equal(swap(shared), 'Arma trocada por Metralhadora M2 · 12,7 mm · falta munição do calibre dela.');
});

test('the casamata of the field: marked on its gun and its box, refused where fabricated, kept where it was made, put right in the workshop', () => {
  // The bunker with the 12,7 mm gun over its box of 5,56 mm, as the one of the public field.
  const stock = new Editor(BUNKER); stock.select(GUN.id); stock.editProperty('weaponPreset', 'm2hb', true);
  const casamata = boxedAs(stock.source, 'minimi');
  // As the field keeps it, it comes back as it was made.
  assert.doesNotThrow(() => compileStructuredConstruction(casamata));
  const editor = new Editor(casamata), issues = editor.reviewManufacture();
  assert.deepEqual(told(editor), [{ code: 'WEAPON_UNFED', ids: [GUN.id] }, { code: 'AMMUNITION_IDLE', ids: [BOX.id] }]);
  const row = armament(editor);
  assert.deepEqual([row.state, row.target, row.marked], ['attention', 'adjust', true]);
  assert.equal(row.detail, 'Arma sem caixa de munição do calibre dela: troque o calibre da caixa que sobrou para fabricar.');
  assert.equal(workshopContext([row], []).action, 'Trocar calibre');
  assert.equal(workshopReviewPart(editor.blueprint, 'armament', issues), BOX.id, 'the review opens the box to change');
  assert.equal(workshopAdmissionMessage(editor.blueprint, issues), UNFED, 'fabrication is refused in the workshop');
  // The calibre of its box made that of its gun, it is fabricated.
  editor.select(BOX.id); editor.editProperty('ammoPreset', 'm2hb', true);
  assert.deepEqual(told(editor), []); assert.equal(workshopAdmissionMessage(editor.blueprint, editor.reviewManufacture()), '');
  assert.equal(armament(editor).state, 'ready');
});

test('a box no gun takes is marked and told, and refuses nothing', () => {
  // Over the floor of the bunker, beside its box.
  const editor = new Editor(BUNKER), spare = { ...BOX, id: 'spare', ammoPreset: 'minimi', pose: { ...BOX.pose, x: BOX.pose.x - 24 } };
  editor.change(source => { source.components.push(spare); });
  assert.deepEqual(told(editor), [{ code: 'AMMUNITION_IDLE', ids: [spare.id] }]);
  const row = armament(editor);
  assert.deepEqual([row.state, row.target, row.marked, row.detail], ['attention', 'adjust', true, 'Caixa de munição de um calibre que nenhuma arma usa.']);
  assert.equal(workshopReviewPart(editor.blueprint, 'armament', editor.reviewManufacture()), spare.id);
  assert.equal(workshopAdmissionMessage(editor.blueprint, editor.reviewManufacture()), '');
});

test('the field refuses to fabricate a gun with no round of its calibre aboard, in the words of the workshop', () => {
  const scout = createStructuredTemplate('scout'), [gun] = of(scout, 'weapon');
  assert.doesNotThrow(() => manufactureDesign(scout));
  for (const source of [boxedAs(scout, 'minimi'), { ...scout, components: scout.components.filter(part => part.kind !== 'ammo') }])
    assert.throws(() => manufactureDesign(source), { reason: 'WEAPON_UNFED', ids: [gun.id], message: UNFED });
  assert.equal(constructionEditMessage({ code: 'WEAPON_UNFED', ids: [gun.id, 'box'] }),
    'A caixa de munição da arma é pequena demais para um tiro: aumente-a para fabricar.');
});
