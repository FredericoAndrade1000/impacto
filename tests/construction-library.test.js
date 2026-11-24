import test from 'node:test';
import assert from 'node:assert/strict';
import { DesignLibrary, LIBRARY_KEY } from '../src/library.ts';
import { garageCard } from '../src/construction-ui.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { structuredTemplateSource } from '../src/structured-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { labConstruction } from '../src/lab-constructions.ts';
import { Editor } from '../src/editor.ts';
import { PLACEMENT_FIELDS, TEST_FIELDS, fieldHTML } from '../src/ui-fields.ts';
import { pieceSettings } from '../src/piece-settings.ts';
import { partViews } from '../src/part-view.ts';
import { sceneFrame } from '../src/scene-frame.ts';
import { readFileSync } from 'node:fs';
import { createProjectWorkspace, createEditorView } from '../src/project-workspace.ts';
import { WORKING_KEY, writeWorkingCopy, clearWorkingCopy } from '../src/working-copy.ts';
import { captureProjectRecords } from '../src/project-originals.ts';
import { screenContext, screenModel, resolveArmament, driveIntent, lookIntent } from '../src/ui-model.ts';
import { parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { CONSTRUCTION_TEMPLATES, createConstruction } from '../src/construction-templates.ts';
import { World } from '../src/physics.ts';
import { allowedAmmo, fixedWeapon, WEAPON_PRESETS } from '../src/weapons.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { rehearsal } from '../server/room.ts';
import { FrameWriter, FrameReader, POSE_PRECISION } from '../src/network-protocol.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { setPart } from './mechanical-queries.js';
import { assertMountProjection } from './helpers/weapon-mount-shape.js';
import { localToWorld } from '../src/math.ts';

await initNativeDynamics();
const LEGACY_BENCH_KEY = 'impacto.oficina.bancada';
function store() { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
function library(storage) { let serial = 0; return new DesignLibrary(storage, { id: () => 'test-design-' + ++serial, now: () => '2026-10-04T12:00:00Z' }); }

// Exercise the page's real persistence callbacks with its real Editor and garage.
// UI intent cleanup and notices are supplied; real panel/framing journeys are browser checks.
function projectPage(garage, editor = new Editor(garage.active.blueprint, garage.active.id)) {
  const tab = store(), notices = [], projectVersions = new Map(garage.has(editor.projectId)
      ? [[editor.projectId, JSON.stringify(garage.get(editor.projectId).blueprint)]] : []),
    page = createProjectWorkspace({ library: garage, editor, projectVersions, workingStores: [tab, garage.storage],
      reportError() {}, toast: message => notices.push(message), opened() {} });
  createEditorView({ editor, renderer: { ready: false }, meter: {}, keepProject: page.keepProject, refreshUI() {} });
  return { editor, tab, notices, keep: page.keepProject, renamed: page.rename, open: page.openProject };
}

test('the garage reads only its own documents and does not infer legacy saves', () => {
  const storage = store(), key = 'impacto.blueprint.v1', b = createConstruction('heavy');
  storage.setItem(key, serializeBlueprint(b));
  // The garage of the format before this one is not read, migrated or removed either.
  const earlier = LIBRARY_KEY.replace(/\d+$/, version => version - 1), filled = library(store());
  filled.create(b); storage.setItem(earlier, filled.storage.getItem(LIBRARY_KEY));
  const legacy = storage.getItem(key), garage = storage.getItem(earlier), a = library(storage), second = library(storage);
  assert.notEqual(earlier, LIBRARY_KEY); assert.equal(a.error, null);
  assert.equal(a.entries.length, 0); assert.equal(a.active, null);
  assert.deepEqual(second.entries, a.entries); assert.equal(storage.getItem(key), legacy);
  assert.equal(storage.getItem(earlier), garage); assert.equal(storage.getItem(LIBRARY_KEY), null);
});

for (const remote of ['edit', 'remove']) test(`a same-project remote ${remote} never gets overwritten or resurrected by stale page autosave`, async () => {
  const storage = store(), a = library(storage), first = a.create(createConstruction('scout')), pageA = projectPage(a),
    b = library(storage), pageB = projectPage(b), before = structuredClone(pageB.editor.source);
  if (remote === 'edit') {
    pageA.editor.change(source => { source.seed += 1; });
    assert.notDeepEqual(a.get(first.id).blueprint, before);
  } else a.remove(first.id);
  const remoteText = storage.getItem(LIBRARY_KEY);
  b.sync(); // A storage event may refresh the library; it must not refresh this editor's write baseline.
  pageB.editor.change(source => { source.name = 'Nome da aba antiga'; });
  assert.equal(storage.getItem(LIBRARY_KEY), remoteText);
  assert.equal(pageB.editor.source.name, 'Nome da aba antiga'); assert.equal(pageB.editor.projectId, first.id);
  assert.equal(pageB.editor.past.length, 1); assert.match(pageB.notices.at(-1), /outra aba/);
  assert.deepEqual(JSON.parse(pageB.tab.getItem(WORKING_KEY)).blueprint, pageB.editor.source);
  assert.equal(await pageB.open(createConstruction('bunker')), false);
  assert.equal(storage.getItem(LIBRARY_KEY), remoteText);
});

for (const remote of [false, true]) test(`renaming another visited project advances only the known name, with remote edit=${remote}`, async () => {
  const storage = store(), garage = library(storage), first = garage.create(createConstruction('scout')), page = projectPage(garage),
    second = garage.create(createConstruction('bunker'));
  await page.open(second.blueprint, second.id);
  if (remote) {
    const other = library(storage), peer = projectPage(other, new Editor(other.get(first.id).blueprint, first.id));
    peer.editor.change(source => { source.seed += 1; });
  }
  garage.rename(first.id, 'Nome dado no cartão'); page.renamed(first.id, 'Nome dado no cartão');
  const saved = storage.getItem(LIBRARY_KEY);
  assert(page.editor.undo()); assert.equal(page.editor.projectId, first.id);
  if (remote) {
    assert.equal(storage.getItem(LIBRARY_KEY), saved); assert.match(page.notices.at(-1), /outra aba/);
    assert.deepEqual(JSON.parse(page.tab.getItem(WORKING_KEY)).blueprint, page.editor.source);
  } else assert.deepEqual(garage.get(first.id).blueprint, page.editor.source);
});
test('garage creates and updates independent projects and copies across reloads', () => {
  const storage = store(), a = library(storage), first = a.create(createConstruction('heavy')), second = a.create(createConstruction('bunker'));
  a.update(first.id, { ...first.blueprint, name: 'Tanque modificado' });
  assert.equal(a.get(second.id).blueprint.name, createConstruction('bunker').name);
  const copy = a.duplicate(first.id); assert.notEqual(copy.id, first.id); assert.equal(a.entries.length, 3);
  assert.equal(a.active.id, first.id, 'a copy is not opened'); assert.throws(() => a.activate('nenhuma'), /indisponível/);
  a.activate(second.id);
  const reloaded = library(storage); assert.equal(reloaded.active.id, second.id); assert.equal(reloaded.get(first.id).blueprint.name, 'Tanque modificado');
});

test('orphan tab and browser drafts remain literal originals without being installed over a garage project', () => {
  const browser = store(), tab = store(), garage = library(browser), original = garage.create(createConstruction('scout')),
    left = { ...original.blueprint, name: 'Rascunho da aba' }, right = { ...original.blueprint, name: 'Rascunho do navegador' };
  tab.setItem(LEGACY_BENCH_KEY, JSON.stringify({ projectId: original.id, blueprint: left }));
  browser.setItem(LEGACY_BENCH_KEY, JSON.stringify({ projectId: original.id, blueprint: right }));
  const records = captureProjectRecords({ local: browser, session: tab }), text = browser.getItem(LIBRARY_KEY);
  assert.deepEqual(records.records.filter(record => record.key === LEGACY_BENCH_KEY).map(record => record.raw),
    [JSON.stringify({ projectId: original.id, blueprint: right }), JSON.stringify({ projectId: original.id, blueprint: left })]);
  new DesignLibrary(browser); assert.equal(browser.getItem(LIBRARY_KEY), text);
  for (const record of records.records) {
    const storage = record.storage === 'local' ? browser : tab;
    assert.equal(storage.getItem(record.key), record.raw);
  }
  assert.equal(garage.entries.length, 1);
  assert.deepEqual(garage.get(original.id), original);
});
test('a construction removed from the garage is gone from it for good, the last one opened and another alike', () => {
  const storage = store(), a = library(storage), first = a.create(createConstruction('heavy')), second = a.create(createConstruction('scout'));
  assert.equal(a.active.id, second.id);
  a.remove(second.id);
  assert.deepEqual([a.entries.map(entry => entry.id), a.active, a.get(second.id)], [[first.id], null, null]);
  // It is no longer there to be removed again, nor to be saved over.
  assert.throws(() => a.remove(second.id), /não encontrada/); assert.throws(() => a.update(second.id, second.blueprint), /não está mais na garagem/);
  a.remove(first.id); assert.deepEqual(a.entries, []);
  // Nothing of either is left in the garage as it is stored.
  assert.deepEqual(JSON.parse(storage.getItem(LIBRARY_KEY)), { version: 4, activeId: null, entries: [] });
  assert.deepEqual(library(storage).entries, []);
  // A tab that still shows what another removed takes the removal before it writes anything.
  const b = library(storage), c = library(storage), kept = b.create(createConstruction('recon')), lost = b.create(createConstruction('ifv'));
  c.sync(); b.remove(lost.id); c.rename(kept.id, 'Batedor');
  assert.deepEqual(c.entries.map(entry => [entry.id, entry.blueprint.name]), [[kept.id, 'Batedor']]);
});
test('invalid imports, unreadable storage and quota errors preserve the current projects', () => {
  const storage = store(), a = library(storage), entry = a.create(createConstruction('heavy')), before = storage.getItem(LIBRARY_KEY), write = storage.setItem;
  assert.throws(() => a.update(entry.id, { ...entry.blueprint, plates: entry.blueprint.plates.map((p, i) => i ? p : { ...p, thicknessMm: NaN }) }), { reason: 'FIELD', field: 'thicknessMm', ids: ['hull:rear'] });
  assert.equal(storage.getItem(LIBRARY_KEY), before); assert.equal(a.active.id, entry.id);
  storage.setItem = () => { throw new Error('Quota excedida'); };
  assert.throws(() => a.create(createConstruction('bunker')), /Quota/); assert.equal(a.entries.length, 1);
  assert.throws(() => a.update(entry.id, { ...entry.blueprint, name: 'Edição ainda aberta' }), /Quota/);
  assert.deepEqual(a.active, entry); assert.equal(storage.getItem(LIBRARY_KEY), before);
  storage.setItem = write;
  // An unreadable garage is never replaced by the first autosave.
  for (const text of ['{broken', JSON.stringify({ ...JSON.parse(before), version: 3 })]) {
    storage.data.set(LIBRARY_KEY, text);
    const unread = library(storage); assert.match(unread.error.message, /não pôde ser lida/); assert.deepEqual([unread.entries.length, unread.active], [0, null]);
    assert.equal(storage.getItem(LIBRARY_KEY), text);
    assert.throws(() => a.sync(), /não pôde ser lida/); assert.equal(a.active.id, entry.id);
    assert.throws(() => unread.create(entry.blueprint), /não pôde ser lida/);
    assert.equal(storage.getItem(LIBRARY_KEY), text);
  }
  // One entry that is not an authored node-and-plate project does not close the garage: it stays in it as it is kept, and
  // its card says why it does not open; the others open.
  const pair = store(), both = library(pair), heavy = both.create(createConstruction('heavy')), bunker = both.create(createConstruction('bunker')), whole = JSON.parse(pair.getItem(LIBRARY_KEY)),
    other = 'Esse não é um projeto desta versão do jogo. Exporte o original para preservá-lo e crie um projeto atual.';
  for (const [spoil, reason] of [[next => next.entries[0].blueprint.version = 3, other], [next => next.entries[0].blueprint.hull = {}, 'Chave desconhecida "hull" no projeto.'],
    [next => next.entries[0].blueprint = compileBlueprint(heavy.blueprint), other]]) {
    const next = structuredClone(whole); spoil(next);
    const kept = store(), told = JSON.stringify(next); kept.setItem(LIBRARY_KEY, told);
    const part = library(kept);
    assert.deepEqual(part.entries.map(e => e.id), [heavy.id, bunker.id]); assert.equal(part.error, null); assert.equal(part.active.id, bunker.id);
    assert.deepEqual([garageCard(part.get(heavy.id)).refusal, garageCard(part.get(bunker.id)).refusal], [reason, undefined]);
    // Reading changes nothing of what is stored, and a save keeps it as it was.
    assert.equal(kept.getItem(LIBRARY_KEY), told);
    const added = part.create(createConstruction('recon'), { id: 'added' });
    assert.deepEqual(library(kept).entries.map(e => e.id), [heavy.id, bunker.id, added.id]);
    assert.deepEqual(JSON.parse(kept.getItem(LIBRARY_KEY)).entries[0], JSON.parse(told).entries[0]);
    // Another tab that reads the same garage reads it the same way.
    const tab = library(pair); pair.data.set(LIBRARY_KEY, told);
    tab.sync(); assert.deepEqual(tab.entries.map(e => e.id), [heavy.id, bunker.id]); pair.data.set(LIBRARY_KEY, JSON.stringify(whole));
  }
  // Two of them, and the one that was open among them: it is still the last one opened, and does not open.
  const two = structuredClone(whole); for (const stored of two.entries) stored.blueprint.version = 3;
  const none = store(); none.setItem(LIBRARY_KEY, JSON.stringify(two));
  const shut = library(none); assert.deepEqual([shut.entries.length, shut.active.id, garageCard(shut.active).refusal], [2, bunker.id, other]);
  storage.data.set(LIBRARY_KEY, before); assert.equal(library(storage).active.id, entry.id);
});
test('autosaves from multiple tabs retain each project and reload the latest entries before updates', () => {
  const storage = store(), a = new DesignLibrary(storage), b = new DesignLibrary(storage);
  const first = a.create(createConstruction('heavy')), second = b.create(createConstruction('bunker'));
  a.update(first.id, { ...first.blueprint, name: 'Tanque da aba A' });
  b.sync(); assert.equal(b.entries.length, 2); assert.equal(b.get(first.id).blueprint.name, 'Tanque da aba A');
  b.rename(second.id, 'Bunker da aba B'); a.sync();
  assert.deepEqual([a.get(first.id).blueprint.name, a.get(second.id).blueprint.name], ['Tanque da aba A', 'Bunker da aba B']);
});
test('an autosave failure retains the editor document and identity until the same update can be retried', () => {
  const storage = store(), garage = library(storage), entry = garage.create(createConstruction('scout')),
    page = projectPage(garage), { editor } = page, write = storage.setItem, before = storage.getItem(LIBRARY_KEY);
  storage.setItem = () => { throw new Error('Quota excedida'); };
  editor.change(blueprint => { blueprint.name = 'Documento ainda aberto'; });
  assert.equal(editor.projectId, entry.id); assert.equal(editor.source.name, 'Documento ainda aberto');
  assert.equal(editor.past.length, 1); assert.equal(storage.getItem(LIBRARY_KEY), before); assert.deepEqual(garage.active, entry);
  assert.deepEqual(JSON.parse(page.tab.getItem(WORKING_KEY)).blueprint, editor.source);
  assert.match(page.notices.at(-1), /cópia de recuperação/);
  storage.setItem = write; assert.equal(page.keep(), true);
  assert.equal(page.tab.getItem(WORKING_KEY), null);
  assert.deepEqual(library(storage).active.blueprint, editor.source);
  assert(editor.undo()); assert.equal(editor.projectId, entry.id); assert.deepEqual(library(storage).active.blueprint, entry.blueprint);
});
test('confirmed edits, undo and redo autosave under the identity assigned before opening', async () => {
  const storage = store(), garage = library(storage), first = garage.create(createConstruction('heavy')),
    page = projectPage(garage), { editor } = page;
  editor.change(blueprint => { blueprint.name = 'Tanque em edição'; });
  assert.deepEqual(library(storage).active.blueprint, editor.source);
  editor.begin(); editor.source.name = 'Meio traço'; editor.preview();
  assert.equal(garage.active.blueprint.name, 'Tanque em edição'); editor.cancel();
  const second = garage.create(createConstruction('bunker'));
  await page.open(second.blueprint, second.id); editor.change(blueprint => { blueprint.name = 'Bunker em edição'; });
  assert(editor.undo()); assert.equal(editor.projectId, second.id); assert.equal(garage.active.blueprint.name, second.blueprint.name);
  assert(editor.undo()); assert.equal(editor.projectId, first.id); assert.equal(garage.active.id, first.id);
  assert.equal(garage.get(second.id).blueprint.name, second.blueprint.name);
  assert(editor.redo()); assert.equal(editor.projectId, second.id); assert.equal(garage.active.id, second.id);
  // Import is a new project before it enters history; export round-trips its authoring only.
  const imported = garage.create(parseBlueprint(serializeBlueprint(editor.source)));
  await page.open(imported.blueprint, imported.id); assert.notEqual(imported.id, second.id);
  assert(editor.undo()); assert.equal(editor.projectId, second.id); assert.equal(garage.active.id, second.id);
  assert(editor.redo()); assert.equal(editor.projectId, imported.id); assert.equal(library(storage).active.id, imported.id);
});

test('opening projects and undoing across them autosaves each identity, without a discard confirmation', async () => {
  const garage = library(store()), first = garage.create(createConstruction('scout')), page = projectPage(garage), { editor } = page;
  editor.change(source => { source.name = 'Primeiro modificado'; });
  const before = structuredClone(editor.source);
  assert.equal(await page.open(createConstruction('bunker')), true);
  const second = editor.projectId;
  assert.notEqual(second, first.id); assert.deepEqual(garage.get(first.id).blueprint, before);
  assert.deepEqual(garage.get(second).blueprint, editor.source);
  assert(editor.undo()); assert.equal(editor.projectId, first.id); assert.deepEqual(garage.active.blueprint, before);
  assert(editor.redo()); assert.equal(editor.projectId, second); assert.deepEqual(garage.active.blueprint, editor.source);
});

test('page autosaves merge other tabs projects instead of replacing their latest edits', () => {
  const storage = store(), a = library(storage), first = a.create(createConstruction('scout')), pageA = projectPage(a),
    b = library(storage), second = b.create(createConstruction('bunker'), { id: 'second-tab' }), pageB = projectPage(b);
  pageA.editor.change(source => { source.name = 'Projeto da aba A'; });
  pageB.editor.change(source => { source.name = 'Projeto da aba B'; });
  const reloaded = library(storage);
  assert.equal(reloaded.get(first.id).blueprint.name, 'Projeto da aba A');
  assert.equal(reloaded.get(second.id).blueprint.name, 'Projeto da aba B');
  assert.deepEqual(reloaded.entries.map(entry => entry.id).sort(), [first.id, second.id].sort());
});

test('a failed autosave prevents switching away from the recoverable document', async () => {
  const storage = store(), garage = library(storage), first = garage.create(createConstruction('scout')), page = projectPage(garage), { editor } = page;
  storage.setItem = () => { throw new Error('Quota'); };
  editor.change(source => { source.name = 'Ainda aqui'; });
  const source = editor.source, past = editor.past.length;
  assert.equal(await page.open(createConstruction('bunker')), false);
  assert.equal(editor.source, source); assert.equal(editor.projectId, first.id); assert.equal(editor.past.length, past);
  assert.deepEqual(JSON.parse(page.tab.getItem(WORKING_KEY)).blueprint, source);
});

test('quota failures leave older or concurrently replaced emergency drafts untouched', async () => {
  const storage = store(), garage = library(storage), first = garage.create(createConstruction('scout')), page = projectPage(garage),
    oldTab = JSON.stringify({ projectId: 'old', blueprint: { version: 5 }, changed: true }), oldBrowser = '{unreadable';
  page.tab.setItem(WORKING_KEY, oldTab); storage.setItem(WORKING_KEY, oldBrowser);
  const write = storage.setItem;
  storage.setItem = (key, value) => { if (key === LIBRARY_KEY) throw new Error('Quota'); write(key, value); };
  page.editor.change(source => { source.name = 'Continua no editor'; });
  assert.equal(page.tab.getItem(WORKING_KEY), oldTab); assert.equal(storage.getItem(WORKING_KEY), oldBrowser);
  assert.match(page.notices.at(-1), /exporte o projeto/); assert.equal(await page.open(createConstruction('bunker')), false);
  assert.equal(page.editor.projectId, first.id); assert.equal(page.editor.source.name, 'Continua no editor');

  const slot = store(), source = createConstruction('scout');
  writeWorkingCopy([slot], { projectId: 'same', blueprint: source });
  const concurrent = JSON.stringify({ projectId: 'same', blueprint: { ...source, name: 'Outra aba' } });
  slot.setItem(WORKING_KEY, concurrent);
  assert.throws(() => writeWorkingCopy([slot], { projectId: 'same', blueprint: { ...source, name: 'Nova tentativa' } }), /outro rascunho/);
  clearWorkingCopy([slot], { projectId: 'same', blueprint: { ...source, name: 'Outra aba' } });
  assert.equal(slot.getItem(WORKING_KEY), concurrent);
});

test('project capacity blocks new identities without blocking edits to existing projects', () => {
  const storage = store(), garage = library(storage), source = createConstruction('scout'), first = garage.create(source),
    data = JSON.parse(storage.getItem(LIBRARY_KEY));
  data.entries = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(data.entries[0]), id: i ? 'full-' + i : first.id }));
  storage.setItem(LIBRARY_KEY, JSON.stringify(data)); garage.sync();
  const before = storage.getItem(LIBRARY_KEY);
  assert.throws(() => garage.create(source), /até 100/); assert.throws(() => garage.duplicate(first.id), /até 100/);
  assert.equal(storage.getItem(LIBRARY_KEY), before); assert.equal(garage.entries.length, 100);
  garage.update(first.id, { ...source, name: 'Editado com garagem cheia' });
  assert.equal(library(storage).get(first.id).blueprint.name, 'Editado com garagem cheia');
  garage.remove('full-99');
  const imported = garage.create(source);
  assert.notEqual(imported.id, first.id);
  assert.equal(garage.entries.length, 100);
});

test('an untouched initial model does not block opening an existing project when the garage is full', async () => {
  const storage = store(), garage = library(storage), first = garage.create(createConstruction('scout')),
    data = JSON.parse(storage.getItem(LIBRARY_KEY));
  data.entries = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(data.entries[0]), id: i ? 'full-' + i : first.id }));
  storage.setItem(LIBRARY_KEY, JSON.stringify(data)); garage.sync();
  const page = projectPage(garage, new Editor(createConstruction('scout')));
  assert.equal(await page.open(first.blueprint, first.id), true);
  assert.equal(page.editor.projectId, first.id); assert.equal(garage.entries.length, 100);
});
test('document transactions restore geometry, identity and branches atomically', () => {
  const editor = new Editor(createConstruction('chassis'), 'saved-a');
  const key = editor.documentKey, original = structuredClone(editor.document);
  editor.begin(); editor.source.name = 'Preview'; editor.cancel();
  assert.deepEqual(editor.document, original); assert.equal(editor.past.length, 0);
  editor.change(b => b.name = 'One'); editor.change(b => b.name = 'Two');
  assert(editor.undo()); editor.change(b => b.name = 'A new branch');
  assert.equal(editor.documentKey, key); assert.equal(editor.projectId, 'saved-a');
  assert.equal(editor.future.length, 0); assert(!editor.redo());
  assert(editor.past.every(document => document.key === key && document.projectId === 'saved-a' && document.blueprint));
  assert(!('pastIds' in editor)); assert(!('pastDocs' in editor));
});
for (const template of CONSTRUCTION_TEMPLATES) test(template.id+': source persists stable local IDs while documents own independent identities',()=>{
 const source=createConstruction(template.id),other=createConstruction(template.id),first=new Editor(source),second=new Editor(other),
  dto=compileBlueprint(source),ids=[...dto.plates,...dto.modules].map(p=>p.id);
 assert.deepEqual(parseBlueprint(serializeBlueprint(source)),source);assert.equal(new Set(ids).size,ids.length);
 assert.notEqual(first.documentKey,second.documentKey);assert.deepEqual(first.source,second.source);
 assert.equal(dto.mechanicalAdmission,true);assert(dto.rooms.every(room=>room.polygon.length>=4&&room.walls.length===room.polygon.length));
});
test('chosen armament is natively installed with actual receiver, port, mount and catalogue restrictions',()=>{
 for(const [id,model] of Object.entries(WEAPON_PRESETS)){
  const source=structuredTemplateSource('scout',{preset:id}),editor=new Editor(source),gun=editor.blueprint.modules.find(m=>m.kind==='weapon'),
   settings=fixedWeapon({platform:'vehicle',componentId:gun.id,preset:'rh120',ammo:'ap',power:999},editor.blueprint.modules);
  assert.equal(settings.preset,id);assert.equal(settings.power,model.power);assert.equal(settings.caliberMm,model.caliberMm);
  assert(allowedAmmo(id).includes(settings.ammo));assertMountProjection(gun);
  assert.deepEqual(parseBlueprint(serializeBlueprint(editor.source)),editor.source);
  assert.throws(()=>serializeBlueprint(editor.blueprint),/não é um projeto desta versão/);
 }
 assert.deepEqual(allowedAmmo('m230lf'),['he']);
});
test('painted backing follows the compiled closed rooms', t => {
  // The infantry carrier: two rooms, its tower shut from its hull by the floor of the tower.
  const b = createConstruction('ifv'), w = new World(b), compiled = compileBlueprint(b); t.after(() => w.dispose());
  const state = w.snapshot(), surfaces = bodyPanelSurfaces(state);
  assert.equal(compiled.rooms.length, 1); assert.equal(surfaces.length, compiled.rooms.length); assert.equal(surfaces[0].paint, 0x6d7863);
  assert.deepEqual(compiled.bodyPanels, compiled.rooms.map(room => ({ id: room.id + ':panel', roomId: room.id, poly: room.polygon })));
  for (const [i, room] of compiled.rooms.entries()) {
    const surface = surfaces[i], points = surface.artPose ? surface.artPolygon.map(p => localToWorld(surface.artPose, p.x, p.y)) : surface.artPolygon;
    assert.equal(surface.id, `local:0:${room.id}:panel`); assert.equal(points.length, room.polygon.length);
    for (const [j, point] of room.polygon.entries()) assert(Math.hypot(points[j].x - point.x, points[j].y - point.y) < 1e-6);
  }
  // Loose plates remain real geometry; only closed regions receive a backing panel.
  const box = createStructuredConstruction(), one = compileBlueprint(box),
    mast = { ...box, nodes: [...box.nodes, { id: 'mast', x: box.nodes[2].x, y: box.nodes[2].y + 20 }],
      plates: [...box.plates, { id: 'mast:plate', a: 'hull-2', b: 'mast', material: 'steel', thicknessMm: 20 }] };
  assert.equal(one.rooms.length, 1); assert.deepEqual(one.bodyPanels, [{ id: 'room-1:panel', roomId: 'room-1', poly: one.rooms[0].polygon }]);
  const original = structuredClone(mast), withMast = compileBlueprint(mast);
  assert(withMast.plates.some(plate => plate.id === 'mast:plate'));
  assert.deepEqual(withMast.bodyPanels, one.bodyPanels);
  assert.deepEqual(mast, original, 'deriving rooms does not rewrite free authoring');
  const open = compileBlueprint({ ...box, plates: box.plates.filter(plate => plate.id !== 'hull:roof') });
  assert.deepEqual(open.bodyPanels, []);
  assert.equal(bodyPanelSurfaces({ ...state, appearance: b.appearance, actors: [], bodyPanels: [{ poly: [] }] }).length, 0);
});
test('published construction preserves native weapon mounts, appearance and binary snapshot identities',t=>{
 for(const preset of ['minimi','rh202','m230lf','mk35','carlgustaf']){
  const source=structuredTemplateSource('scout',{preset});source.appearance.paint='#62737b';
  const room=rehearsal();t.after(()=>room.world.dispose());const player=room.join('Oficina'),
   result=room.publish(player.playerId,source),native=room.world.snapshot(),
   installed=native.modules.find(m=>m.actorId===result.actor.id&&m.kind==='weapon'),
   state=new FrameReader().decode(new FrameWriter().encode({type:'frame',state:native,events:[],profile:{}},true)).state,
   gun=state.modules.find(m=>m.actorId===result.actor.id&&m.kind==='weapon');
  assert.equal(gun.weaponPreset,preset);assertMountProjection(installed);
  assert.deepEqual(gun.weaponMount.shield,installed.weaponMount.shield);
  assert.deepEqual(gun.materialPolygons,installed.materialPolygons.map(polygon=>polygon.map(point=>({
   x:Math.round(point.x*1e4)/1e4,y:Math.round(point.y*1e4)/1e4
  }))), 'the binary frame carries every native contour to its published tenth of a millimetre');
  const appearance={...source.appearance,details:source.appearance.details.map(detail=>({...detail,
   x:Math.round(detail.x*POSE_PRECISION.position)/POSE_PRECISION.position||0,
   y:Math.round(detail.y*POSE_PRECISION.position)/POSE_PRECISION.position||0,
   angle:Math.round(detail.angle*POSE_PRECISION.angle)/POSE_PRECISION.angle||0,
  }))};
  assert.deepEqual(state.actors.find(a=>a.id===result.actor.id).appearance,appearance,
   'cosmetic poses use the same published position/angle precision; catalogue ids, dimensions and text stay exact');
 }
});
test('inspector resize uses one validated canonical transaction and rejects impossible sizes atomically',()=>{
 const e=new Editor(createStructuredConstruction({length:8,height:3})),module=e.addModule('engine',{x:12,y:e.blueprint.frame.origin.y+1}),
  original=structuredClone(e.selected),originalScale=e.source.components.find(part=>part.id===module.id).sizeScale??1,
  history=e.past.length;
 e.editProperty('sizeScale',1.1);e.editProperty('sizeScale',1.25);e.commit();
 assert.equal(e.past.length,history+1);assert.equal(e.selected.width,original.width/originalScale*1.25);
 assert(e.undo());assert.deepEqual(e.blueprint.modules.find(m=>m.id===module.id),original);
 assert(e.redo());e.select(module.id);const before=structuredClone(e.document),count=e.past.length;
 assert.throws(()=>e.editProperty('sizeScale',100,true));
 assert.deepEqual(e.document,before);assert.equal(e.past.length,count);assert.equal(e.before,null);
});
test('placement preview and commit use the same requested pose and physical overlap check', () => {
  const e = new Editor(createStructuredConstruction()), before = structuredClone(e.document), point = { x: 12, y: 1.3 };
  const plan = e.planModule('fuel', point, { sizeScale: .5 });
  assert.deepEqual(e.document, before, 'a hover preview cannot mutate the document');
  assert.equal(plan.overlap, false);
  const actual = e.addModule('fuel', point, { sizeScale: .5 });
  for (const key of ['kind', 'width', 'height', 'x', 'y', 'fuelLitres'])
    assert.deepEqual(actual[key], plan.module[key]);
  const occupied = e.planModule('fuel', point, { sizeScale: .5 });
  assert.equal(occupied.overlap, true);
  assert.match(occupied.reason, /ocupariam o mesmo espaço/);
  const unchanged = structuredClone(e.document);
  const count = e.past.length;
  assert.throws(() => e.addModule('fuel', point, { sizeScale: .5 }), { reason: 'CONSTRUCTION_OVERLAP' });
  assert.deepEqual(e.document, unchanged); assert.equal(e.before, null);
  assert.equal(e.past.length, count); assert.equal(e.blueprint.modules.filter(m => m.x === actual.x && m.y === actual.y).length, 1);
});

test('editor, lab and network inspectors project one actor context without copying the document', () => {
  const e = new Editor(createConstruction('heavy')), module = e.blueprint.modules[0], gun = e.blueprint.modules.find(part => part.kind === 'weapon'); e.select(module.id);
  const network = { enabled: false, connected: false, designs: new Map() }, view = { mode: 'edit', weapon: fixedWeapon() };
  const state = { actors: [{ id: 'local', vehicle: { x: 12 } }, { id: 'b', vehicle: { x: 30 } }],
    plates: [], attachments: [], modules: [{ ...gun, id: 'a-gun', actorId: 'local' }, { ...gun, id: 'b-gun', actorId: 'b' }] };
  let c = screenContext(view, e, state, network);
  assert.equal(c.blueprint, e.blueprint); assert.equal(c.modules, e.blueprint.modules);
  assert.equal(c.selected.definition, e.selected); assert.equal(c.vehicle, null);
  view.mode = 'test'; c = screenContext(view, e, state, network);
  assert.equal(c.vehicle, state.actors[0].vehicle); assert.deepEqual(c.weapons.map(m => m.id), ['a-gun']);
  assert.equal(c.manual, true, 'the construction of the lab is in the player\'s hands');
  network.enabled = network.connected = true; network.selected = network.manualActorId = 'b'; network.designs.set('b', { blueprint: e.source });
  c = screenContext(view, e, state, network);
  assert.equal(c.vehicle, state.actors[1].vehicle); assert.deepEqual(c.weapons.map(m => m.id), ['b-gun']);
  assert.equal(c.manual, true); assert.equal(c.shared, true);
  network.connected = false; assert.equal(screenContext(view, e, state, network).manual, false, 'a field that does not answer is driven by nobody');
  network.connected = true; state.squad = { manual: null, units: state.actors.map(({ id }) => ({ id })) };
  const commanding = screenContext(view, e, state, network);
  assert.equal(commanding.vehicle, null); assert.equal(commanding.actor, undefined);
  assert.deepEqual(commanding.weapons, []); assert.equal(commanding.manual, false);
  assert.equal(network.selected, 'b', 'commanding keeps selection without taking the selected vehicle over');
  delete state.squad; network.selected = 'gone';
  assert.equal(screenContext(view, e, state, network).vehicle, null, 'a missing actor supplies no other vehicle');
});

test('the side panel generates what is chosen before a piece exists; an installed piece is set on the bar over it', () => {
  const e = new Editor(createConstruction('heavy'));
  const plate = e.blueprint.plates[0], engine = e.blueprint.modules.find(m => m.kind === 'engine');
  assert.deepEqual(pieceSettings(engine, e.source.components.find(part => part.id === engine.id)).map(setting => setting.key), ['sizeScale', 'angle']);
  assert.deepEqual(pieceSettings(plate, e.source.plates.find(part => part.id === plate.id)).map(setting => setting.key), ['thicknessMm', 'length', 'angle']);
  assert.deepEqual(PLACEMENT_FIELDS.map(field => field.key), ['weaponPreset', 'ammoPreset', 'sensorMode']);
  const html = [...PLACEMENT_FIELDS, ...TEST_FIELDS].map(fieldHTML).join('');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'each generated control has one identity');
});

test('screen bindings are complete and painting leaves the document and weapon intent unchanged', () => {
  const e = new Editor(createConstruction('heavy'));
  e.select(e.blueprint.modules.find(m => m.kind === 'engine').id);
  const view = { mode: 'edit', buildTool: 'select', testTool: 'fire', follow: 'flight', weapon: fixedWeapon(),
    placement: { kind: 'engine', material: 'steel', thicknessMm: 90, weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual', snap: true } };
  const network = { enabled: false, connected: false, designs: new Map() };
  const session = { paused: true, speed: 1, testDistance: 0, physicsMs: 0 };
  const blueprint = e.blueprint, before = JSON.stringify({ blueprint, view });
  const c = screenModel({ view, editor: e, state: null, network, session, terrainId: 'flat',
    particles: 0, sound: { enabled: true, volume: .4 } });
  assert.equal(JSON.stringify({ blueprint, view }), before);
  assert.equal(e.blueprint, blueprint);
  assert.equal(c.selected.definition, e.selected);
  assert.deepEqual(c.figures.map(figure => figure.label), ['PESO', 'POTÊNCIA', 'AUTONOMIA', 'MÁXIMA ESTIMADA'], 'the figures of the design stand over it');
  assert(c.figures.every(figure => /\d/.test(figure.value) && !/NaN/.test(figure.value)));
  assert.equal(c.weapon.trajectory, 'low', 'old intent is resolved to the UI low arc without mutating it');
  assert.equal(c.bindings['component-placement-cost'].text, '', 'the selection tool has no installation price to show');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8') +
    [...PLACEMENT_FIELDS, ...TEST_FIELDS].map(fieldHTML).join('');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const id of Object.keys(c.bindings)) assert.ok(ids.has(id), 'binding has control: ' + id);
});

test('manual driving is the held keys and nothing else: A and D drive, S brakes', () => {
  const input = { driveKeys: new Set() };
  assert.deepEqual(driveIntent(input), { left: false, right: false, brake: 0, throttle: 0 });
  input.driveKeys.add('a'); assert.equal(driveIntent(input).throttle, -1);
  input.driveKeys.add('d'); assert.equal(driveIntent(input).throttle, 0);
  input.driveKeys.add('s'); assert.deepEqual(driveIntent(input), { left: true, right: true, brake: 1, throttle: 0 });
  assert.deepEqual(driveIntent({ driveKeys: new Set(['d']), throttle: .4, drivePointer: 'brake' }),
    { left: false, right: true, brake: 0, throttle: 1 }, 'no slider and no button stand behind the keys');
});

test('the arrow keys look around and leave the driving to A, D and S', () => {
  const input = { driveKeys: new Set(['arrowleft', 'arrowright', 'arrowdown', 'arrowup']), lookKeys: new Set() };
  assert.deepEqual(driveIntent(input), { left: false, right: false, brake: 0, throttle: 0 }, 'an arrow is no driving key');
  assert.deepEqual(lookIntent(input), { x: 0, y: 0 }); assert.deepEqual(lookIntent(), { x: 0, y: 0 });
  input.lookKeys.add('arrowright'); assert.deepEqual(lookIntent(input), { x: 1, y: 0 });
  input.lookKeys.add('arrowup'); assert.deepEqual(lookIntent(input), { x: 1, y: 1 }, 'two arrows go diagonally');
  input.lookKeys.add('arrowleft'); assert.deepEqual(lookIntent(input), { x: 0, y: 1 }, 'opposite arrows cancel');
  input.lookKeys = new Set(['arrowleft', 'arrowdown', 'a', 'd', 's']); assert.deepEqual(lookIntent(input), { x: -1, y: -1 });
  assert.deepEqual(driveIntent(input), { left: false, right: false, brake: 0, throttle: 0 }, 'looking around never drives');
});

test('destroyed mounted armament keeps its preset and immutable catalogue values', () => {
  const intent = fixedWeapon({ preset: 'rh120', platform: 'vehicle', componentId: 'mortar' });
  const gun = { id: 'mortar', kind: 'weapon', weaponPreset: 'm252', health: 0, attached: false, barrelDisabled: true };
  const preset = Object.keys(WEAPON_PRESETS).find(id => WEAPON_PRESETS[id].family === 'mortar'); gun.weaponPreset = preset;
  const before = structuredClone({ intent, gun });
  const resolved = resolveArmament(intent, [gun]);
  assert.equal(resolved.componentId, gun.id); assert.equal(resolved.preset, preset);
  assert.equal(resolved.speed, WEAPON_PRESETS[preset].speed);
  assert.deepEqual({ intent, gun }, before);
  assert.equal(resolveArmament(intent, [], true).platform, 'vehicle', 'missing armament cannot become an unlimited bench');
});

test('laboratory inspection reads real native material and fixed mass after perforating its front wall',t=>{
 const source=labConstruction({thicknessMm:50}),dto=compileBlueprint(source),world=new World(source);t.after(()=>world.dispose());
 const material=world.plates.find(p=>p.definition.id==='hull:front'),id=material.id,mass=material.physicalMass;
 let state=world.snapshot(),selected=partViews(dto,state).find(p=>p.id===id);
 assert(selected);assert(selected.health.fraction>0);assert(!Object.hasOwn(sceneFrame(state),'bodiesBySource'));
 world.cutBody(material,{x:material.definition.x,y:material.definition.y},{x:material.definition.x,y:material.definition.y},.08);state=world.snapshot();selected=partViews(dto,state).find(p=>p.id===id);
 assert(material.integrity>0&&material.integrity<1);assert.equal(selected.health.fraction,material.integrity);
 assert.equal(material.physicalMass,mass);assert(!Object.hasOwn(state, 'fragments'));
});
test('the inspector projects native functional damage from the installed component without a casing body', t => {
  const blueprint = createConstruction('heavy'), world = new World(blueprint); t.after(() => world.dispose());
  const engine = world.modules.find(m => m.kind === 'engine');
  setPart(world, engine, { health: 0 });
  const state = world.snapshot(), selected = partViews(compileBlueprint(blueprint), state).find(part => part.id === engine.id);
  assert.equal(selected.physical.health, 0); assert.equal(selected.health.status, 'Inutilizado');
  assert.equal(selected.health.fraction, 0); assert.equal(selected.physical.attached, true);
  assert.equal(sceneFrame(state).byId.get(engine.id).type, 'module'); assert(!Object.hasOwn(state, 'fragments'));
});
