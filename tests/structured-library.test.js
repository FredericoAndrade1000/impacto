import test from 'node:test';
import assert from 'node:assert/strict';
import { DesignLibrary, LIBRARY_KEY } from '../src/library.ts';
import { Editor } from '../src/editor.ts';
import { WORKING_KEY, writeWorkingCopy, clearWorkingCopy } from '../src/working-copy.ts';
import { constructionCardData, garageCard } from '../src/construction-ui.ts';
import { projectRefusalMessage } from '../src/project-refusal.ts';
import { constructionUI, descendants } from './helpers/dom.js';
import { CONSTRUCTION_TEMPLATES, createConstruction } from '../src/construction-templates.ts';
import { createStructuredConstruction, planStructuredComponent, compileStructuredConstruction } from '../src/structured-construction.ts';
import { DESIGN_VERSION, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { blueprintMass } from '../src/mass-properties.ts';
import { constructionCost } from '../src/construction-cost.ts';
import { designBill, billText } from '../src/economy.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

function store() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function library(storage) {
  let id = 0;
  return new DesignLibrary(storage, { id: () => 'design-' + ++id, now: () => '2026-10-08T21:00:00-03:00' });
}
const design = () => planStructuredComponent(createStructuredConstruction(), {
  id: 'engine', kind: 'engine', sizeScale: 1.3, pose: { x: 14, y: 6, angle: 0 }, // .7 m, .3 m, in cells
}).construction;
const DERIVED = ['modules', 'frame', 'rooms', 'derived', 'attachments', 'bodyPanels'];

test('garage creates, reloads and exports only the authored nodes and plates', () => {
  const storage = store(), garage = library(storage), source = design(), saved = garage.create(source);
  assert.deepEqual(saved.blueprint, source);
  const text = storage.getItem(LIBRARY_KEY), persisted = JSON.parse(text).entries[0].blueprint;
  assert.equal(persisted.version, DESIGN_VERSION); assert.deepEqual(persisted.plates, source.plates);
  for (const field of DERIVED) assert.equal(Object.hasOwn(persisted, field), false);
  assert.deepEqual(library(storage).active.blueprint, source);
  assert.deepEqual(parseBlueprint(serializeBlueprint(library(storage).active.blueprint)), source);
  const compiled = compileStructuredConstruction(source);
  assert.throws(() => garage.update(saved.id, compiled), /não pode ser salvo na garagem/);
  assert.equal(storage.getItem(LIBRARY_KEY), text);
});

test('canonical updates and copies preserve identities without derived arrays', () => {
  const storage = store(), garage = library(storage), saved = garage.create(design());
  const updated = garage.update(saved.id, { ...saved.blueprint, name: 'Blindado atualizado' });
  assert.equal(updated.id, saved.id); assert.deepEqual(updated.blueprint.components, saved.blueprint.components);
  const duplicate = garage.duplicate(saved.id);
  assert.notEqual(duplicate.id, saved.id); assert.equal(duplicate.blueprint.version, DESIGN_VERSION);
  assert.deepEqual(duplicate.blueprint.components, saved.blueprint.components); assert.equal(garage.active.id, saved.id);
  assert.deepEqual(garage.get(saved.id), updated);
  assert.deepEqual(library(storage).active.blueprint, updated.blueprint);
});

test('failed canonical validation and storage writes leave the saved design usable', () => {
  const storage = store(), garage = library(storage), saved = garage.create(design()), text = storage.getItem(LIBRARY_KEY),
    invalid = structuredClone(saved.blueprint);
  invalid.components[0].pose.x = 2000; // 100 m, in cells
  assert.throws(() => garage.update(saved.id, invalid), { reason: 'FIELD' });
  assert.equal(storage.getItem(LIBRARY_KEY), text); assert.deepEqual(garage.active, saved);
  storage.setItem = () => { throw new Error('Quota excedida'); };
  assert.throws(() => garage.update(saved.id, { ...saved.blueprint, name: 'Não foi salvo' }), /Quota/);
  assert.equal(storage.getItem(LIBRARY_KEY), text); assert.deepEqual(garage.active, saved);
});

test('gallery numbers and SVG derive from the same compiled construction', () => {
  const source = design(), before = structuredClone(source), compiled = compileStructuredConstruction(source), card = constructionCardData(source);
  assert.deepEqual(card.industry.measurement, compiled.manufacturing, 'eligibility reuses the same Native metrics as the card');
  assert.equal(card.massKg, blueprintMass(compiled)); assert.deepEqual(card.cost, constructionCost(compiled)); assert.deepEqual(card.bill, designBill(compiled));
  assert.match(card.svg, /^<svg/); assert.match(card.svg, /polygon/);
  assert.deepEqual(source, before); assert.equal(Object.hasOwn(source, 'modules'), false);
  const lab = createConstruction('plate'), labCard = constructionCardData(lab), labDTO = compileStructuredConstruction(lab);
  assert.equal(labCard.massKg, blueprintMass(labDTO));
});

test('canonical gallery opens the same saved identity without a conversion action', async t => {
  const storage = store(), garage = library(storage), canonical = garage.create(design()),
    before = storage.getItem(LIBRARY_KEY), opened = [];
  const { ui, nodes } = constructionUI(t, { library: garage, getProjectId: () => null, stopControls() {},
    onOpen: async (...args) => opened.push(args), onLibraryChange() {}, toast: message => assert.fail(message) });
  ui.refreshLibrary();
  const card = nodes.get('#library-grid').children[0], elements = descendants(card);
  assert(!elements.some(node => node.textContent === 'Converter cópia'));
  assert(!elements.some(node => /VEÍCULO|ESTRUTURA|trechos|componentes/.test(node.textContent || '')), 'a card has no type and no counts');
  await elements.find(node => node.textContent === 'Abrir').onclick();
  assert.deepEqual(opened[0], [canonical.blueprint, canonical.id]);
  assert.equal(storage.getItem(LIBRARY_KEY), before); assert.ok(nodes.get('#library-dialog').closed);
  // Fixed defences saved by an older installation become ordinary editable garage entries again.
  garage.create(createConstruction('bunker'), { activate: false }); ui.refreshLibrary();
  assert.equal(garage.entries.length, 2); assert.equal(nodes.get('#library-grid').children.length, 2);
  assert.match(nodes.get('#library-summary').textContent, /^2 construções na garagem$/);
});
test('a project is renamed on its garage card and in its open editor', async t => {
  const storage = store(), garage = library(storage), first = garage.create({ ...design(), name: 'Primeiro' }), second = garage.create({ ...design(), name: 'Segundo' }, { activate: false }),
    editor = new Editor(first.blueprint, first.id), renamed = [], changes = [], said = [];
  editor.onchange = event => { if (event.kind === 'document') garage.update(editor.projectId, editor.source); };
  const { ui, nodes } = constructionUI(t, { library: garage, getProjectId: () => first.id, stopControls() {}, onOpen() {},
    onRename: (id, name) => { renamed.push([id, name]); if (id === editor.projectId) editor.change(source => { source.name = name; }); },
    onLibraryChange: () => changes.push(garage.entries.map(entry => entry.blueprint.name).sort()), toast: message => said.push(message) });
  ui.refreshLibrary();
  const field = name => nodes.get('#library-grid').children.flatMap(descendants).find(node => node.className === 'design-name' && node.value === name),
    type = (name, text) => { const input = field(name); input.value = text; input.onchange(); };
  assert.equal(field('Segundo').maxLength, 80); assert.equal(nodes.get('#library-grid').children.flatMap(descendants).filter(node => node.tagName === 'h3').length, 0);
  // A confirmed name changes the project and is told to its editor.
  type('Segundo', '  Caça-tanques  ');
  assert.equal(garage.get(second.id).blueprint.name, 'Caça-tanques'); assert.deepEqual(renamed, [[second.id, 'Caça-tanques']]);
  assert.deepEqual(changes, [['Caça-tanques', 'Primeiro']]); assert(field('Caça-tanques'), 'the garage is drawn again with the new name');
  // Its authoring and the identity of the open project are preserved.
  assert.deepEqual({ ...garage.get(second.id).blueprint, name: 'Segundo' }, second.blueprint); assert.equal(garage.get(second.id).updatedAt, second.updatedAt);
  assert.equal(garage.active.id, first.id); assert.equal(JSON.parse(storage.getItem(LIBRARY_KEY)).entries.length, 2);
  // A name left empty, or the same one, changes nothing; the field shows the name again.
  type('Primeiro', '   '); type('Caça-tanques', 'Caça-tanques');
  assert.equal(renamed.length, 1); assert(field('Primeiro') && field('Caça-tanques'));
  type('Primeiro', 'Primeiro renomeado');
  assert.deepEqual(renamed.at(-1), [first.id, 'Primeiro renomeado']); assert.equal(editor.source.name, 'Primeiro renomeado');
  assert.equal(garage.get(first.id).blueprint.name, editor.source.name);
  // The models of the workshop have a name that is theirs: it is not a field.
  ui.tab = 'templates'; ui.refreshLibrary();
  const models = nodes.get('#library-grid').children.flatMap(descendants);
  assert(models.some(node => node.tagName === 'h3') && !models.some(node => node.className === 'design-name'));
  assert.throws(() => garage.rename('nenhuma', 'x'), /não encontrada/); assert.deepEqual(said, []);
});

test('removing a project notifies the editor only after persistence succeeds and confirmation is accepted', async t => {
  const garage = library(store()), kept = garage.create({ ...design(), name: 'Fica' }), open = garage.create({ ...design(), name: 'Vai' });
  const asked = [], changes = [], removed = []; let answer = false;
  const { ui, nodes } = constructionUI(t, { library: garage, getProjectId: () => open.id, stopControls() {}, onOpen() {},
    onRemove: async id => { assert.equal(garage.get(id), null); await Promise.resolve(); removed.push(id); },
    onLibraryChange: () => { assert.equal(removed.length, changes.length + 1); changes.push(garage.entries.length); }, toast: message => assert.fail(message),
    confirm: async (...said) => { asked.push(said); return answer; } });
  ui.refreshLibrary();
  const cards = () => nodes.get('#library-grid').children.map(descendants),
    card = name => cards().find(parts => parts.some(node => node.className === 'design-name' && node.value === name)),
    remove = name => card(name).find(node => node.className === 'card-remove');
  assert.deepEqual([remove('Vai').title, remove('Vai').innerHTML.includes('#i-trash')], ['Remover da garagem', true]);
  // The current project can also be copied before experimenting, without an explicit saved/unsaved split.
  assert.deepEqual(card('Vai').filter(node => node.tagName === 'button').map(node => node.textContent), ['Abrir', 'Duplicar', '']);
  // Asked, and answered no: the construction stays, and nothing is told of a change.
  await remove('Vai').onclick();
  assert.deepEqual(asked, [['Remover “Vai” da garagem?', 'Não dá para desfazer. A Oficina abre outro projeto.', 'Remover']]);
  assert.deepEqual([garage.entries.length, cards().length, changes, removed], [2, 2, [], []]);
  // Answered yes: it is gone from the garage and from the list, and the workshop is told.
  answer = true; await remove('Vai').onclick();
  assert.deepEqual([garage.entries.map(entry => entry.id), cards().length, changes, removed], [[kept.id], 1, [1], [open.id]]);
  assert.equal(card('Vai'), undefined);
  // One that is not open in the workshop is asked about without a word of the workshop.
  assert.deepEqual(card('Fica').filter(node => node.tagName === 'button').map(node => node.textContent), ['Abrir', 'Duplicar', '']);
  await remove('Fica').onclick();
  assert.deepEqual(asked.at(-1), ['Remover “Fica” da garagem?', 'Não dá para desfazer.', 'Remover']);
  assert.deepEqual([garage.entries, cards().flat().some(node => node.className === 'card-remove'), changes, removed], [[], false, [1, 0], [open.id, kept.id]]);
});

test('a failed project removal leaves the open project and garage list unchanged', async t => {
  const storage = store(), garage = library(storage), open = garage.create(design()), before = storage.getItem(LIBRARY_KEY),
    removed = [], changes = [], said = [];
  const { ui, nodes } = constructionUI(t, { library: garage, getProjectId: () => open.id, stopControls() {}, onOpen() {},
    onRemove: id => removed.push(id), onLibraryChange: () => changes.push(garage.entries.length), confirm: async () => true,
    toast: (...args) => said.push(args) });
  ui.refreshLibrary();
  storage.setItem = () => { throw new Error('Quota excedida'); };
  await nodes.get('#library-grid').children.flatMap(descendants).find(node => node.className === 'card-remove').onclick();
  assert.deepEqual(removed, []); assert.deepEqual(changes, []); assert.deepEqual(said, [['Quota excedida', true]]);
  assert.deepEqual(garage.active, open); assert.equal(storage.getItem(LIBRARY_KEY), before);
  assert.equal(nodes.get('#library-grid').children.length, 1);
});

test('templates and the faction shelf do not read or clone the saved projects', t => {
  const garage = library(store());
  Object.defineProperty(garage, 'entries', { get() { assert.fail('this tab does not consume the garage entries'); } });
  const { ui } = constructionUI(t, { library: garage, getProjectId: () => null,
    getFaction: () => ({ id: 'faction', library: [], members: [] }), getPlayerId: () => 'me',
    stopControls() {}, onOpen() {}, onLibraryChange() {}, toast: message => assert.fail(message) });
  ui.openLibrary('templates'); ui.openLibrary('faction');
});

test('a cached faction blueprint uses the latest author metadata without fetching or compiling another copy', async t => {
  const blueprint = createConstruction('scout'), metadata = { id: 'model', at: 10, name: blueprint.name, author: 'author', by: 'Antes' },
    faction = { id: 'faction', library: [metadata], members: [{ id: 'me', role: 'member' }] }, requests = [],
    { ui, nodes } = constructionUI(t, { library: library(store()), getProjectId: () => null, getFaction: () => faction,
      getPlayerId: () => 'me', getTime: () => 20, stopControls() {}, onOpen() {}, onLibraryChange() {},
      command: (type, data) => { requests.push(data); return Promise.resolve({ models: [{ ...metadata, blueprint }] }); },
      toast: message => assert.fail(message) });
  ui.openLibrary('faction'); await new Promise(resolve => setImmediate(resolve));
  const model = ui.kept.get('model'), byline = () => descendants(nodes.get('#library-grid')).find(node => node.className === 'card-meta').textContent;
  assert.match(byline(), /^Antes · /); assert.deepEqual(Object.keys(model).sort(), ['at', 'blueprint']);
  metadata.by = 'Depois'; ui.watchShelf();
  assert.match(byline(), /^Depois · /); assert.equal(requests.length, 1);
  assert.equal(ui.kept.get('model'), model); assert.equal(ui.shelfView(faction).models[0].blueprint, model.blueprint);
});
test('catalogue preview and opening use canonical vehicles and fixed defences, keeping physics fixtures out', async t => {
  const opened = [], { ui, nodes } = constructionUI(t, { library: library(store()), getProjectId: () => null, stopControls() {},
    onOpen: async (...args) => opened.push(args), onLibraryChange() {}, toast: message => assert.fail(message) });
  ui.tab = 'templates'; nodes.get('#library-search').value = 'Blindado de esteiras'; ui.refreshLibrary();
  const card = nodes.get('#library-grid').children[0], svg = descendants(card).find(node => node.className === 'design-preview').innerHTML;
  await descendants(card).find(node => node.textContent === 'Construir').onclick();
  const [source, id] = opened[0]; assert.equal(source.version, DESIGN_VERSION); assert.equal(id, null);
  assert.equal(svg, constructionCardData(source).svg); for (const field of DERIVED) assert.equal(Object.hasOwn(source, field), false);
  for (const name of ['Posto de defesa leve', 'Bunker de concreto', 'Posto fortificado']) {
    nodes.get('#library-search').value = name; ui.refreshLibrary();
    const card = nodes.get('#library-grid').children[0];
    await descendants(card).find(node => node.textContent === 'Construir').onclick();
    assert.equal(opened.at(-1)[0].preset, 'bunker');
    assert.equal(descendants(card).find(node => node.className === 'design-preview').innerHTML, constructionCardData(opened.at(-1)[0]).svg);
  }
  for (const name of ['Ensaio de blindagem', 'Construção livre']) {
    nodes.get('#library-search').value = name; ui.refreshLibrary();
    assert.equal(nodes.get('#library-grid').children.flatMap(descendants).some(node => node.textContent === 'Construir'), false, name);
  }
  assert(CONSTRUCTION_TEMPLATES.some(template => template.type === 'structure')); assert.equal(opened.length, 4);
});

test('on the shared field the garage says each bill in the stocks of the faction and what they are short of, the models it can pay first', t => {
  let stock = null;
  const { ui, nodes } = constructionUI(t, { library: library(store()), getProjectId: () => null, getStock: () => stock, stopControls() {}, onOpen() {}, onLibraryChange() {},
      toast: message => assert.fail(message) }),
    cards = () => nodes.get('#library-grid').children.map(card => {
      const within = descendants(card), said = name => within.find(node => node.className === name)?.textContent ?? null;
      return [within.find(node => node.tagName === 'h3').textContent, said('design-cost'), said('design-short')];
    });
  ui.tab = 'templates'; ui.refreshLibrary();
  const lab = cards();
  assert.equal(lab[0][0], 'Blindado de esteiras'); assert(lab.every(card => / cr$/.test(card[1]) && card[2] === null), 'the lab says a price, and has no stocks to be short of');
  stock = { ferro: 100000, ligas: 0, silica: 12000, combustivel: 1500 }; ui.refreshLibrary();
  const field = cards(), heavy = designBill(compileStructuredConstruction(createConstruction('heavy')));
  assert(heavy.ferro > stock.ferro, 'the compiled heavy tank exceeds these iron stocks');
  assert.deepEqual(field.find(card => card[0] === 'Blindado de esteiras'), ['Blindado de esteiras', billText(heavy), `Falta Ferro: custa ${heavy.ferro.toLocaleString('pt-BR')} e a facção tem 100.000.`]);
  const firstBlocked = field.findIndex(card => card[2] !== null), blocked = new Set(field.slice(firstBlocked).map(card => card[0]));
  assert(firstBlocked > 0); assert(field.slice(firstBlocked).every(card => card[2] !== null), 'all unaffordable designs come after the affordable ones and explain the shortage');
  for (const list of [field.slice(0, firstBlocked), field.slice(firstBlocked)])
    assert.deepEqual(list.map(card => card[0]), lab.filter(card => blocked.has(card[0]) === blocked.has(list[0][0])).map(card => card[0]), 'each group keeps catalogue order');
  assert.match(field.find(card => card[0] === 'Transportador aéreo de suprimentos')[2], /Falta Ligas/);
  for (const card of field) {
    const template = CONSTRUCTION_TEMPLATES.find(template => template.name === card[0]);
    assert.equal(card[1], billText(designBill(compileStructuredConstruction(createConstruction(template.id)))), 'each in the stocks it is paid from, including defences without fuel');
  }
});
test('an emergency copy is kept in every store that accepts it; total failure is reported', () => {
  const tab = store(), browser = store(), full = { getItem: () => null, setItem() { throw new Error('cheio'); } }, blueprint = { name: 'Blindado' };
  writeWorkingCopy([tab, null, browser], { projectId: 'p1', blueprint });
  assert.equal(tab.data.get(WORKING_KEY), browser.data.get(WORKING_KEY));
  assert.deepEqual(JSON.parse(tab.getItem(WORKING_KEY)), { projectId: 'p1', blueprint });
  writeWorkingCopy([full, browser], { projectId: 'p2', blueprint });
  assert.equal(JSON.parse(browser.getItem(WORKING_KEY)).projectId, 'p2');
  assert.throws(() => writeWorkingCopy([full], { projectId: 'p3', blueprint }), /cheio/);
});
test('successful autosave retires only its exact emergency copy, keeping other or malformed drafts', () => {
  const tab = { ...store(), removeItem(key) { this.data.delete(key); } }, browser = { ...store(), removeItem(key) { this.data.delete(key); } },
    blueprint = { name: 'Guardado' }, other = { name: 'Outro rascunho do mesmo projeto' };
  writeWorkingCopy([tab], { projectId: 'same', blueprint, changed: true });
  writeWorkingCopy([browser], { projectId: 'same', blueprint: other, changed: true });
  clearWorkingCopy([tab, browser], { projectId: 'same', blueprint });
  assert.equal(tab.getItem(WORKING_KEY), null); assert.deepEqual(JSON.parse(browser.getItem(WORKING_KEY)).blueprint, other);
  tab.setItem(WORKING_KEY, '{'); clearWorkingCopy([tab], { projectId: 'same', blueprint }); assert.equal(tab.getItem(WORKING_KEY), '{');
});
test('a project of the garage the core refuses says on its card that it does not open, and why; it is still exported and removed', async t => {
  const storage = store(), garage = library(storage), good = garage.create({ ...design(), name: 'Bom' }), spoiled = { ...structuredClone(good.blueprint), name: 'Grosso demais' };
  spoiled.plates[0].thicknessMm = 99999;
  const stored = JSON.parse(storage.getItem(LIBRARY_KEY));
  stored.entries.push({ id: 'refused', createdAt: 'a', updatedAt: '2026-10-07T00:00:00Z', blueprint: spoiled });
  storage.setItem(LIBRARY_KEY, JSON.stringify(stored)); garage.sync();
  // The reason is the sentence a file of the same project is refused with on import.
  let reason = null; try { parseBlueprint(JSON.stringify(spoiled)); } catch (error) { reason = projectRefusalMessage(error, spoiled); }
  assert.equal(reason, `A chapa "${spoiled.plates[0].id}": espessura 99999 mm fora de 5–1000 mm.`);
  const slips = t.mock.method(console, 'error', () => {}), blobs = [], revoked = [], said = [], removed = [], links = [];
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:projeto-' + blobs.length; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ui, nodes } = constructionUI(t, { library: garage, getProjectId: () => null, getBlueprint: () => good.blueprint, stopControls() {},
    onOpen: () => assert.fail('a project that does not open is not opened'), onLibraryChange() {}, onRemove: id => removed.push(id),
    confirm: async () => true, toast: (...args) => said.push(args) });
  const create = document.createElement; document.createElement = tag => { const node = create(tag); if (tag === 'a') links.push(node); return node; };
  ui.refreshLibrary();
  const card = name => nodes.get('#library-grid').children.find(card => descendants(card).some(node => node.textContent === name || node.value === name)),
    within = name => descendants(card(name)), buttons = name => within(name).filter(node => node.tagName === 'button').map(node => node.textContent),
    part = (name, className) => within(name).find(node => node.className === className);
  assert.match(nodes.get('#library-summary').textContent, /^2 construções na garagem$/);
  // Faded, it says that it does not open and why, in full under the pointer; it has no picture, weight or price, and its
  // name is no field to rename it by.
  assert.equal(card('Grosso demais').attributes['data-refused'], '');
  assert.equal(part('Grosso demais', 'card-category card-refused').textContent, 'NÃO ABRE');
  assert.deepEqual([part('Grosso demais', 'design-refusal').textContent, part('Grosso demais', 'design-refusal').title], [reason, reason]);
  assert.equal(part('Grosso demais', 'design-preview').innerHTML, undefined);
  assert(!within('Grosso demais').some(node => ['design-name', 'design-cost'].includes(node.className)));
  // It cannot be opened or copied; it is exported or removed. The others are as they were.
  assert.deepEqual(buttons('Grosso demais'), ['Exportar', '']);
  assert.deepEqual(buttons('Bom'), ['Abrir', 'Duplicar', '']);
  assert(!card('Bom').attributes['data-refused'] && part('Bom', 'design-preview').innerHTML.startsWith('<svg'));
  // Exported, it is the file as it is kept, to be put right by hand and imported again.
  await within('Grosso demais').find(node => node.textContent === 'Exportar').onclick();
  assert.equal(await blobs[0].text(), JSON.stringify(spoiled, null, 2));
  assert.deepEqual([links[0].href, links[0].download, links[0].clicks], ['blob:projeto-1', 'grosso-demais.json', 1]);
  t.mock.timers.tick(2000); assert.deepEqual(revoked, ['blob:projeto-1']);
  assert.deepEqual(said, [['Projeto exportado.']]);
  // The open project is exported from the foot of the garage as the core writes it.
  nodes.get('#export').onclick();
  assert.equal(await blobs[1].text(), serializeBlueprint(good.blueprint)); assert.equal(links[1].download, 'bom.json');
  // The check is made once for each version of a project: drawn again or read again from the storage, the card is the
  // same; a version put right in another tab opens.
  const before = garageCard(garage.get('refused'));
  ui.refreshLibrary(); garage.sync(); assert.equal(garageCard(garage.get('refused')), before);
  assert.equal(garageCard(garage.get(good.id)), garageCard(library(storage).get(good.id)));
  const fixed = JSON.parse(storage.getItem(LIBRARY_KEY)); fixed.entries[1].blueprint.plates[0].thicknessMm = 20;
  storage.setItem(LIBRARY_KEY, JSON.stringify(fixed)); ui.refreshLibrary();
  assert.deepEqual(buttons('Grosso demais'), ['Abrir', 'Duplicar', '']); assert.equal(garageCard(garage.get('refused')).refusal, undefined);
  storage.setItem(LIBRARY_KEY, JSON.stringify(stored)); ui.refreshLibrary();
  assert.equal(garageCard(garage.get('refused')).refusal, reason);
  // A write of another project keeps it as it is kept; removed, it is gone and nothing else is.
  garage.rename(good.id, 'Bom de novo');
  assert.deepEqual(JSON.parse(storage.getItem(LIBRARY_KEY)).entries.find(entry => entry.id === 'refused').blueprint, spoiled);
  ui.refreshLibrary(); await within('Grosso demais').find(node => node.className === 'card-remove').onclick();
  assert.deepEqual([removed, garage.entries.map(entry => entry.id), nodes.get('#library-grid').children.length], [['refused'], [good.id], 1]);
  // A refusal is not a slip of the code.
  assert.equal(slips.mock.callCount(), 0);
  // One of another version, or no project at all, says so.
  const old = garageCard({ id: 'old', blueprint: { ...good.blueprint, version: 4 } });
  assert.deepEqual([old, garageCard({ id: 'none', blueprint: null })].map(card => card.refusal), Array(2).fill('Esse não é um projeto desta versão do jogo. Exporte o original para preservá-lo e crie um projeto atual.'));
});
