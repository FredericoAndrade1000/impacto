import test from 'node:test';
import assert from 'node:assert/strict';
import { firstObjectives, objectivesPreferenceKey, controlsGuide, FirstObjectives } from '../src/first-objectives.ts';
import { WorkspaceElement, workspaceDOM } from './helpers/dom.js';

const site = { id: 'ore', material: 'ferro', x: 100 },
  context = (completed = {}) => ({ faction: { objectives: { fieldId: 'field-a', completed },
    deposits: [{ id: 'ore', active: true, left: 1000, stock: 0 }], units: [{ id: 'miner', cargo: { ferro: 1000 } }], stock: { ferro: 999999 } },
    state: { squad: { units: [{ id: 'miner' }], manual: null }, actors: [{ id: 'miner', vehicle: {} }],
      modules: ['excavator', 'hopper'].map(kind => ({ actorId: 'miner', kind, health: 100 })) }, deposits: [site] });

test('first objectives require the field private record and never infer results from stock, cargo or starter units', () => {
  assert.equal(firstObjectives(), null);
  assert.equal(firstObjectives({ faction: { stock: { ferro: 100 } } }), null);
  const model = firstObjectives(context());
  assert.equal(model.count, 0); assert.equal(model.next, 'selectMiner');
  assert.equal(model.rows.every(row => !row.complete), true);
});

test('objectives present independent server results in a stable order, including out of order', () => {
  const model = firstObjectives(context({ fabricateVehicle: true, deliverOre: true, directControl: true }));
  assert.equal(model.count, 3); assert.equal(model.total, 6); assert.equal(model.next, 'selectMiner');
  assert.deepEqual(model.rows.filter(row => row.complete).map(row => row.id), ['deliverOre', 'directControl', 'fabricateVehicle']);
  assert.equal(firstObjectives(context({ selectMiner: true })).next, 'collectOre');
});

test('losing the fleet or connection preserves each reported completion and supplies actionable hints', () => {
  const input = context({ selectMiner: true, collectOre: true, deliverOre: true }); input.state = null; input.connected = false;
  const model = firstObjectives(input);
  assert.equal(model.count, 3); assert.equal(model.next, 'directControl');
  assert.match(model.rows.find(row => row.id === 'collectOre').hint, /entrou na caçamba/);
  assert.match(model.rows.find(row => row.id === 'directControl').hint, /conexão/);
});

test('collection guidance explains exploration without a known solid deposit and does not mistake petroleum for ore', () => {
  const input = context(); input.faction.deposits = [];
  assert.match(firstObjectives(input).rows.find(row => row.id === 'collectOre').hint, /reconhecimento.*Mover.*explorar/);
  input.deposits = [{ ...site, material: 'petroleo' }]; input.faction.deposits = [{ id: 'ore', active: true, left: 1000 }];
  assert.match(firstObjectives(input).rows.find(row => row.id === 'collectOre').hint, /Nenhuma jazida de minério conhecida/);
  input.deposits = [site];
  assert.match(firstObjectives(input).rows.find(row => row.id === 'collectOre').hint, /Coletar.*jazida/);
});

test('a selected miner reuses the command model explanation, while a busy miner waits for its service', () => {
  const input = context(), reason = 'A caçamba está danificada. Solicite reparo.';
  input.panel = { squad: { units: [{ id: 'miner', selected: true }] }, orders: [{ id: 'haul', reason }] };
  assert.equal(firstObjectives(input).rows.find(row => row.id === 'collectOre').hint, reason);
  input.panel = null; input.faction.units[0].service = { kind: 'repair' };
  assert.match(firstObjectives(input).rows.find(row => row.id === 'selectMiner').hint, /Aguarde o término/);
});

test('direct-control and fabrication hints describe the pending result', () => {
  const input = context(); input.state.squad.manual = 'miner'; input.faction.units[0].service = { kind: 'build' };
  const model = firstObjectives(input);
  assert.match(model.rows.find(row => row.id === 'directControl').hint, /Use Comandar/);
  assert.match(model.rows.find(row => row.id === 'fabricateVehicle').hint, /Aguarde.*disponível/);
  assert.equal(model.count, 0);
});

test('disclosure preferences distinguish both seat and field without ambiguous concatenation', () => {
  assert.notEqual(objectivesPreferenceKey('field-a', 'p1'), objectivesPreferenceKey('field-a', 'p2'));
  assert.notEqual(objectivesPreferenceKey('field-a', 'p1'), objectivesPreferenceKey('field-b', 'p1'));
  assert.notEqual(objectivesPreferenceKey('a.b', 'c'), objectivesPreferenceKey('a', 'b.c'));
});

const goal = (input, id) => firstObjectives(input).rows.find(row => row.id === id);
test('every pending connected goal has a useful action without inferring completion from that action', () => {
  const input = context(), before = structuredClone(input), model = firstObjectives(input);
  assert.equal(model.rows.every(row => row.action?.kind && row.action?.label), true);
  assert.deepEqual(input, before); assert.equal(model.count, 0);
  assert.equal(goal(input, 'selectMiner').action.kind, 'pick'); assert.match(goal(input, 'selectMiner').hint, /na coluna à esquerda/);
  input.workspace = { picked: ['miner'] };
  const collect = goal(input, 'collectOre').action;
  assert.deepEqual([collect.kind, collect.actorId, collect.depositId, collect.x], ['collect', 'miner', 'ore', 100], 'it shows the vein, whose button gives the order');
  input.connected = false;
  assert.equal(firstObjectives(input).rows.every(row => !row.action && !row.alternate), true);
});

test('delivery follows the automatic haul instead of suggesting a move that replaces it', () => {
  const input = context(); input.state.squad.units[0].haul = { depositId: 'ore', phase: 'home' };
  const row = goal(input, 'deliverOre');
  assert.deepEqual(row.action, { kind: 'follow', label: 'Acompanhar a entrega', actorId: 'miner' });
  assert.match(row.hint, /automaticamente.*sem substituir a ordem por Mover/);
  assert.equal(row.complete, false); assert.equal(goal(input, 'collectOre').complete, false);
});

test('direct-control guidance first selects a vehicle, then points to control and explicit return', () => {
  const input = context();
  assert.equal(goal(input, 'directControl').action.kind, 'pick');
  input.workspace = { picked: ['miner'] };
  assert.equal(goal(input, 'directControl').action.kind, 'control');
  input.state.squad.manual = 'miner';
  assert.equal(goal(input, 'directControl').action.kind, 'release');
  assert.equal(goal(input, 'selectMiner').action.kind, 'release');
  assert.equal(goal(input, 'collectOre').action.kind, 'release');
  assert.equal(goal(input, 'directControl').complete, false);
});

test('fabrication guidance survives Project and Garage and distinguishes opening a model from fabrication', () => {
  const input = context();
  assert.equal(goal(input, 'fabricateVehicle').action.kind, 'project');
  input.workspace = { edit: true, sourcePreset: 'scout' };
  assert.equal(goal(input, 'fabricateVehicle').action.kind, 'publish');
  assert.equal(goal(input, 'fabricateVehicle').alternate.kind, 'models');
  input.workspace.libraryOpen = true;
  assert.equal(goal(input, 'fabricateVehicle').action.kind, 'model');
  input.workspace.libraryOpen = false; input.workspace.task = 'publish';
  assert.equal(goal(input, 'fabricateVehicle').action.kind, 'fabricate');
  input.workspace.sourcePreset = 'bunker';
  assert.equal(goal(input, 'fabricateVehicle').action.kind, 'models');
  assert.equal(goal(input, 'fabricateVehicle').complete, false);
});

function withBuilder(input, x = 0) {
  input.faction.base = { x: 0, radius: 100 };
  input.state.squad.units.push({ id: 'builder' });
  input.state.actors.push({ id: 'builder', vehicle: { x } });
  input.state.modules.push({ actorId: 'builder', kind: 'builder', health: 100 });
  input.faction.units.push({ id: 'builder', builder: { ready: true, reach: 30 } });
  return input;
}

test('defense guidance prepares and waits for a constructor, then opens the light defence in the workshop, wherever the builder stands', () => {
  const input = context();
  assert.equal(goal(input, 'buildDefense').action.kind, 'prepareDefense');
  input.workspace = { edit: true, projectBuilder: true };
  assert.equal(goal(input, 'buildDefense').action.kind, 'publish');
  input.workspace.task = 'publish';
  assert.equal(goal(input, 'buildDefense').action.kind, 'fabricate');
  withBuilder(input); input.workspace = {};
  // A works is opened from the workshop, at a place chosen on the field: the builder need not go anywhere first.
  assert.deepEqual([goal(input, 'buildDefense').action.kind, goal(input, 'buildDefense').action.label], ['defense', 'Abrir o posto de defesa leve']);
  assert.match(goal(input, 'buildDefense').hint, /^Abra o posto de defesa leve na Oficina e escolha o local da obra no campo\. Um construtor em automático/);
  input.faction.units[1].builder = { ready: false, reach: 30, reason: 'Pare o construtor para montar ou desmontar.', working: null };
  assert.equal(goal(input, 'buildDefense').action.kind, 'defense', 'opening a works asks nothing of the builder');
  assert.equal(goal(input, 'buildDefense').complete, false);
});

test('defense guidance asks for a known point far enough from the base, then follows the works to the builder until the field says it stands', () => {
  const input = withBuilder(context(), 150);
  input.workspace = { edit: true, sourcePreset: 'bunker' };
  assert.equal(goal(input, 'buildDefense').action.kind, 'placeDefense');
  input.workspace.placing = true;
  assert.equal(goal(input, 'buildDefense').action.kind, 'chooseDefensePoint');
  assert.match(goal(input, 'buildDefense').hint, /chão já visto, a 150 m ou mais da base/);
  input.workspace.pointChosen = true;
  assert.equal(goal(input, 'buildDefense').action.kind, 'confirmDefense');
  assert.match(goal(input, 'buildDefense').hint, /use Abrir obra\. Abrir a obra não custa nada/);
  // A works open: the builder is taken to it, waits there for its material, and puts it up.
  input.workspace = {}; input.faction.works = [{ id: 'c9', name: 'Posto leve', x: 400, waiting: false, from: null }];
  assert.deepEqual([goal(input, 'buildDefense').action.kind, goal(input, 'buildDefense').action.actorId], ['moveBuilder', 'builder']);
  assert.match(goal(input, 'buildDefense').hint, /a até 7 m da obra/);
  input.state.squad.units[1].move = { x: 400 };
  assert.equal(goal(input, 'buildDefense').action.kind, 'follow');
  input.state.squad.units[1].move = null; input.faction.works[0].waiting = true;
  assert.deepEqual([goal(input, 'buildDefense').action.kind, /Falta material/.test(goal(input, 'buildDefense').hint)], ['follow', true]);
  input.faction.works[0].waiting = false; input.faction.units[1].builder.working = 'c9';
  assert.match(goal(input, 'buildDefense').hint, /sendo montada/);
  input.faction.units[1].builder = { ready: false, reach: 30, reason: 'Saia de combate para montar ou desmontar.', working: null };
  assert.deepEqual([goal(input, 'buildDefense').action.kind, goal(input, 'buildDefense').hint], ['condition', 'Saia de combate para montar ou desmontar.']);
  assert.equal(goal(input, 'buildDefense').complete, false);
  input.faction.objectives.completed.buildDefense = true;
  assert.equal(goal(input, 'buildDefense').complete, true); assert.equal(goal(input, 'buildDefense').action, null);
  input.state.squad.units = []; input.state.actors = []; input.faction.units = [];
  assert.equal(goal(input, 'buildDefense').complete, true);
});

test('an allied builder cannot become the player tutorial constructor or complete the defense objective', () => {
  const input = withBuilder(context(), 150); input.state.squad.units = input.state.squad.units.filter(unit => unit.id !== 'builder');
  assert.equal(goal(input, 'buildDefense').action.kind, 'prepareDefense');
  assert.equal(goal(input, 'buildDefense').complete, false);
});

test('a works placed with no constructor still guides the point, and the constructor comes after', () => {
  const input = context(); input.workspace = { placing: true, pointChosen: false };
  assert.equal(goal(input, 'buildDefense').action.kind, 'chooseDefensePoint');
  input.workspace = {}; input.faction.works = [{ id: 'c9', name: 'Posto leve', x: 400, waiting: false, from: null }];
  assert.equal(goal(input, 'buildDefense').action.kind, 'prepareDefense');
  assert.equal(goal(input, 'buildDefense').complete, false);
});

test('defense first returns from manual control before selecting or moving a builder without disrupting a project or ongoing work', () => {
  const input = withBuilder(context()); input.state.squad.manual = 'miner';
  assert.equal(goal(input, 'buildDefense').action.kind, 'release');
  input.workspace = { edit: true, sourcePreset: 'bunker' };
  assert.equal(goal(input, 'buildDefense').action.kind, 'placeDefense');
  input.workspace = { placing: true, pointChosen: true };
  assert.equal(goal(input, 'buildDefense').action.kind, 'confirmDefense');
});

test('direct control never points at a fixed structure, empty selection or a vehicle held by service', () => {
  const input = context(); input.state.squad.units.push({ id: 'post' }); input.state.actors.push({ id: 'post' });
  input.workspace = { picked: ['post'] };
  assert.equal(goal(input, 'directControl').action.kind, 'pick');
  assert.equal(goal(input, 'directControl').action.actorId, 'miner');
  input.workspace.picked = [];
  assert.equal(goal(input, 'directControl').action.kind, 'pick');
  input.workspace.picked = ['miner']; input.faction.units[0].service = { kind: 'repair' };
  assert.equal(goal(input, 'directControl').action.kind, 'condition');
  input.faction.units[0].service = null; input.panel = { control: false, controlTitle: 'Aguarde o serviço.' };
  assert.equal(goal(input, 'directControl').hint, 'Aguarde o serviço.');
});

test('recovering a missing miner progresses from Garage model to the ordinary fabrication instead of reopening Garage', () => {
  const input = context(); input.state.squad.units = []; input.state.actors = []; input.state.modules = []; input.faction.units = [];
  assert.equal(goal(input, 'collectOre').action.kind, 'models');
  input.workspace = { edit: true, libraryOpen: true };
  assert.equal(goal(input, 'collectOre').action.kind, 'model');
  assert.equal(goal(input, 'collectOre').action.templateId, 'mining-truck');
  input.workspace.libraryOpen = false; input.workspace.projectMiner = true;
  assert.equal(goal(input, 'collectOre').action.kind, 'publish');
  input.workspace.task = 'publish';
  assert.equal(goal(input, 'collectOre').action.kind, 'fabricate');
  assert.equal(goal(input, 'collectOre').complete, false);
});

test('a miner already being fabricated is awaited instead of suggesting another model or fabrication', () => {
  const input = context(); input.faction.units[0].service = { kind: 'build' };
  assert.equal(goal(input, 'selectMiner').action.kind, 'follow');
  assert.equal(goal(input, 'collectOre').action.kind, 'follow');
  assert.equal(goal(input, 'collectOre').action.actorId, 'miner');
  assert.match(goal(input, 'collectOre').hint, /não é preciso pedir outro/);
  assert.equal(goal(input, 'collectOre').complete, false);
});

test('collection shows the known vein of ore nearest the miner that has something left, or else the nearest, which comes back', () => {
  const input = context(); input.workspace = { picked: ['miner'] };
  input.deposits.push({ ...site, id: 'near-ore', x: 520 }, { ...site, id: 'spent-ore', x: 610 });
  input.faction.deposits.push({ id: 'near-ore', active: true, left: 1000, stock: 0 }, { id: 'spent-ore', active: true, left: 0, stock: 0 });
  input.state.actors[0].vehicle.x = 600;
  assert.deepEqual([goal(input, 'collectOre').action.depositId, goal(input, 'collectOre').action.x], ['near-ore', 520]);
  input.state.actors[0].vehicle.x = 0;
  assert.equal(goal(input, 'collectOre').action.depositId, 'ore');
  // With none the faction knows to have anything left, it is the nearest that no base stills all the same.
  input.faction.deposits = input.faction.deposits.map(vein => ({ ...vein, left: 0 })); input.state.actors[0].vehicle.x = 600;
  assert.deepEqual([goal(input, 'collectOre').action.depositId, goal(input, 'collectOre').action.x], ['spent-ore', 610]);
  // With every one beside a base, there is another to find.
  input.faction.deposits = input.faction.deposits.map(vein => ({ ...vein, active: false }));
  assert.equal(goal(input, 'collectOre').hint, 'As jazidas de minério conhecidas ficam junto de bases. Explore com a viatura de reconhecimento para encontrar outra.');
});


test('the controls are those of where the player is, in a few short lines for the mouse and keys or for a finger', () => {
  const workshop = controlsGuide({ edit: true }), field = controlsGuide(), fingers = [controlsGuide({ edit: true, touch: true }), controlsGuide({ touch: true })];
  assert.equal(workshop.title, 'Controles da Oficina'); assert.equal(field.title, 'Controles do campo');
  assert.equal(fingers[0].title, workshop.title); assert.equal(fingers[1].title, field.title);
  for (const guide of [workshop, field, ...fingers]) assert(guide.lines.length >= 3 && guide.lines.length <= 5, guide.title);
  const keys = workshop.lines.join(' ');
  for (const told of [/X remove a seleção/, /C cancela/, /categoria aberta em Adicionar/, /Ctrl\+Z desfaz/, /Enter vai ao campo/]) assert.match(keys, told);
  const orders = field.lines.join(' ');
  for (const told of [/1–9 escolhem/, /com Ctrl, bombardeia/, /Home enquadra/, /Enter escreve na conversa/, /C assume o veículo/, /Esc devolve/]) assert.match(orders, told);
  for (const guide of fingers) assert.doesNotMatch(guide.lines.join(' '), /Ctrl|Shift|Esc\b|\bX\b|Enter|Home|clique/, 'a finger is told of no keys');
});

// The panel on the shared tree double: what it shows and keeps is real; layout belongs to the browser checks.
class Element extends WorkspaceElement {
  constructor(tag) {
    super(tag); const classes = this.classList;
    this.classList = { ...classes, add: name => classes.toggle(name, true), remove: name => classes.toggle(name, false) };
  }
  removeAttribute(name) { this.attributes.delete(name); }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 320, height: 600, right: 320, bottom: 600 }; }
}
function panel(t, options = {}) {
  const { create } = workspaceDOM(t, Element), style = globalThis.getComputedStyle, opened = [];
  globalThis.getComputedStyle = () => ({ top: '54px' });
  t.after(() => { globalThis.getComputedStyle = style; });
  const host = create('div', 'viewport'), tools = create('div', 'field-tools'), restore = create('button', 'objectives-restore'), kept = new Map(),
    storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) },
    make = (extra = {}) => new FirstObjectives({ host, tools, restore, storage, onOpen: () => opened.push('open'), ...options, ...extra }),
    objectives = make(), show = (extra = {}, view = objectives) => view.render({ active: true, playerId: 'p1', ...context(), ...extra });
  return { objectives, show, make, restore, kept, opened, tools, create };
}
const texts = list => list.children.map(child => child.textContent);

test('the Controles row is no objective: it shows the controls of the workshop or the field, for the way the player plays', t => {
  const f = panel(t), o = f.objectives;
  f.show(); o.toggle.click();
  assert.equal(o.root.hidden, false); assert.equal(o.toggleCount.textContent, '0/6'); assert.equal(o.count.textContent, '0 de 6');
  const list = o.controls.parentNode.parentNode, row = o.controls.parentNode;
  assert.equal(list.children[0], row, 'it leads the list'); assert.equal(list.children.length, 7);
  assert.match(o.controls.children[0].innerHTML, /i-controls/); assert.equal(o.controls.children[0].textContent, '', 'its own mark, never ○ or ✓');
  assert.equal(o.hint.hidden, false); assert.equal(o.lines.hidden, true);
  o.controls.click();
  assert.equal(o.hintTitle.textContent, 'Controles do campo'); assert.deepEqual(texts(o.lines), controlsGuide().lines);
  assert.equal(o.hint.hidden, true); assert.equal(o.lines.hidden, false); assert.equal(o.action.hidden, true); assert.equal(o.alternate.hidden, true);
  assert.equal(o.controls.getAttribute('aria-pressed'), 'true');
  assert([...o.rows.values()].every(({ button }) => button.getAttribute('aria-pressed') === 'false'));
  f.show({ workspace: { edit: true } });
  assert.equal(o.hintTitle.textContent, 'Controles da Oficina'); assert.deepEqual(texts(o.lines), controlsGuide({ edit: true }).lines);
  f.show({ workspace: { edit: true }, touch: true });
  assert.deepEqual(texts(o.lines), controlsGuide({ edit: true, touch: true }).lines);
  f.show({ touch: true });
  assert.equal(o.hintTitle.textContent, 'Controles do campo'); assert.deepEqual(texts(o.lines), controlsGuide({ touch: true }).lines);
  o.rows.get('collectOre').button.click();
  assert.equal(o.hintTitle.textContent, 'Começar a coletar'); assert.equal(o.hint.hidden, false); assert.equal(o.lines.hidden, true);
  assert.equal(o.action.hidden, false); assert.equal(o.controls.getAttribute('aria-pressed'), 'false');
});

test('dismissed after a short confirmation, the objectives leave the top row of that field and seat until the settings bring them back', async t => {
  let answer = false, asked = 0;
  const f = panel(t, { ask: async () => { asked++; return answer; } }), o = f.objectives, settle = () => new Promise(resolve => setImmediate(resolve)),
    key = objectivesPreferenceKey('field-a', 'p1');
  f.show(); assert.equal(f.restore.hidden, true, 'nothing to bring back while the objectives are there');
  o.toggle.click(); o.dismissal.click(); await settle();
  assert.equal(asked, 1); assert.equal(o.toggle.hidden, false); assert.equal(o.root.hidden, false, 'refused, nothing changes');
  answer = true; o.dismissal.click(); await settle();
  assert.equal(o.toggle.hidden, true); assert.equal(o.root.hidden, true); assert.equal(f.restore.hidden, false);
  assert.equal(f.kept.get(key), 'dismissed');
  f.show({ workspace: { edit: true } }); assert.equal(o.toggle.hidden, true, 'in the workshop as on the field');
  // Other pages of the same browser, each with its own settings.
  const later = f.make({ restore: f.create('button', 'later-restore') }); f.show({}, later);
  assert.equal(later.toggle.hidden, true); assert.equal(later.root.hidden, true, 'a later visit keeps them dismissed');
  const other = f.make({ restore: f.create('button', 'other-restore') }); f.show({ playerId: 'p2' }, other);
  assert.equal(other.toggle.hidden, false, 'another seat has its own choice');
  f.show(); f.opened.length = 0; f.restore.click();
  assert.equal(o.dismissed, false); assert.equal(o.toggle.hidden, false); assert.equal(o.root.hidden, false); assert.equal(f.restore.hidden, true);
  assert.deepEqual(f.opened, ['open']); assert.equal(f.kept.get(key), 'open');
  assert.equal(o.hintTitle.textContent, 'Controles do campo', 'brought back from the settings, it opens on the controls');
  f.show({ active: false }); assert.equal(f.restore.hidden, true, 'away from the shared field there is nothing to bring back');
});
