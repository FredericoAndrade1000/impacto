import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_TASKS, fieldNavigation, compactStock, selectionText } from '../src/field-navigation.ts';

const faction = { name: 'Ana', nation: 'Vale Verde', count: 2, counts: { vehicles: 2, fixed: 0 }, base: { x: 100 },
  stock: { ferro: 60000, ligas: 10000, silica: 1500, combustivel: 1500 } };
const vehicle = (id, patch = {}) => ({ id, name: 'Veículo ' + id, selected: false, manual: false, defeated: false, ...patch });

test('the field has temporary task triggers and identifies the actual selected construction', () => {
  const panel = { squad: { units: [vehicle('a', { selected: true }), vehicle('b')] }, control: true },
    before = structuredClone(panel), view = fieldNavigation({ shared: true, panel, faction, testTools: true });
  assert.deepEqual(view.tasks, FIELD_TASKS); assert(!FIELD_TASKS.some(task => task.id === 'vehicle'));
  assert.deepEqual([view.mode, view.title, view.selectedCount, view.control, view.release],
    ['COMANDANDO', 'Veículo a', 1, true, false]);
  assert.deepEqual([view.dock, view.details], [true, true]);
  assert.deepEqual(panel, before);
});

test('manual control retains a way back to command without choosing a surface', () => {
  const view = fieldNavigation({ shared: true, faction, panel: { release: true, squad: { units: [vehicle('a'), vehicle('b', { manual: true, selected: true })] } } });
  assert.deepEqual([view.mode, view.title, view.release, view.vehicleEmpty, view.details, view.dock],
    ['CONDUZINDO', 'Veículo b', true, false, true, true]);
});

test('fixed construction selection and operation use their own labels without losing release or weapon controls', () => {
  const panel = { release: true, weapon: true, squad: { units: [vehicle('post', { mobile: false, manual: true })] } }, before = structuredClone(panel),
    view = fieldNavigation({ shared: true, faction, panel });
  assert.deepEqual([view.mode, view.controlLabel, view.mobile, view.detailsLabel], ['OPERANDO', 'Operar', false, 'Armamento']);
  assert.deepEqual([view.release, view.details, view.dock], [true, true, true]);
  assert.match(view.controlsHint, /Fogo/); assert.doesNotMatch(view.controlsHint, /conduzir|A\/D|freia/);
  assert.deepEqual(panel, before);
  const selection = fieldNavigation({ shared: true, panel: { control: true, squad: { units: [vehicle('post', { mobile: false, selected: true })] } } });
  assert.equal(selection.mode, 'COMANDANDO'); assert.equal(selection.controlLabel, 'Operar'); assert.equal(selection.control, true);
});

test('private tests offer their real controls without inventing a fleet, nor naming themselves again in the dock', () => {
  const view = fieldNavigation();
  assert.deepEqual([view.tasks, view.details, view.dock, view.release], [[], true, true, false]);
  assert.equal(view.detailsLabel, 'Ajustar teste');
  assert.deepEqual([view.mode, view.title], ['', ''], 'the name of the test is in the row at the top');
  // The keys are told in a few words; a finger has the buttons over the field, which need none.
  assert.equal(view.controlsHint, 'A/D conduzem · S freia · F dispara');
  assert.equal(fieldNavigation({ touch: true }).controlsHint, '');
});

test('the faction remains available without a selected vehicle, and the constructions have no page of their own', () => {
  const view = fieldNavigation({ shared: true, faction, panel: { faction: { invites: [{}, {}], requests: [{}] }, squad: { units: [vehicle('a'), vehicle('b', { defeated: true })] } } });
  assert.deepEqual(view.tasks.map(task => task.id), ['faction', 'infra'], 'the constructions are in the column over the field; veins and wrecks are told by their marks');
  assert.deepEqual([view.vehicleEmpty, 'fleetCount' in view], [true, false]);
  assert.equal(view.dock, false); assert.equal(view.details, false);
  assert.equal(view.stocks.find(stock => stock.id === 'ferro').text, '60.000');
  assert.equal(fieldNavigation({ shared: true, panel: { situation: 'offline' } }).mode, 'SEM CONEXÃO');
});

test('a group exposes its resolved eligibility summary and a single unit retains real service feedback', () => {
  const units = [vehicle('a', { selected: true }), vehicle('fixed', { selected: true, mobile: false })],
    group = fieldNavigation({ shared: true, panel: { squad: { units, note: '1 móvel · 1 estrutura' } } });
  assert.deepEqual([group.dock, group.details, group.title, group.status], [true, false, '2 construções selecionadas', '1 móvel · 1 estrutura · 2 aguardando ordens']);
  const single = fieldNavigation({ shared: true, panel: { services: [{}], squad: { units: [vehicle('a', { selected: true,
    feedback: { kind: 'waiting', text: 'Abastecer em 3 s · aguardando segurança' } })] } } });
  assert.equal(single.services, true); assert.equal(single.status, 'Abastecer em 3 s · aguardando segurança');
});

test('a selection of several counts attention once and separates those awaiting orders from those at work', () => {
  const selected = { selected: true, defeated: false }, units = [
    { ...selected, id: 'hauler', doing: 'haul', alert: true, trouble: true },
    { ...selected, id: 'extractor', doing: 'extract' },
    { ...selected, id: 'moving', doing: 'move' },
    { ...selected, id: 'idle', doing: '' },
  ], before = structuredClone(units);
  assert.equal(selectionText(units), '1 precisa de atenção · 1 aguardando ordens · 2 em atividade');
  assert.equal(selectionText([{ ...selected, trouble: true }, { ...selected, alert: true }]), '2 precisam de atenção');
  assert.equal(selectionText([{ ...selected, doing: 'halted' }, { ...selected, doing: '' }]), '1 precisa de atenção · 1 aguardando ordens');
  assert.equal(selectionText([{ ...selected, doing: 'haul' }, { ...selected, doing: 'repair' }]), '2 em atividade');
  assert.deepEqual(units, before);
  // The dock says it under the name of the selection, after what of it stays where it is.
  const group = fieldNavigation({ shared: true, panel: { squad: { units: [...units, { id: 'fallen', doing: 'out', defeated: true, selected: true }], note: '' } } });
  assert.equal(group.status, '1 precisa de atenção · 1 aguardando ordens · 2 em atividade');
});

test('compact HUD amounts preserve full stock figures in the faction panel', () => {
  assert.equal(compactStock(1500).replace(/\s/g, ' '), '1,5 mil');
  assert(compactStock(999978269).length < '999.978.269'.length);
  assert.deepEqual([compactStock(0), compactStock(-1), compactStock(undefined)], ['0', '0', '0']);
});

test('passive service refusals stay on the condition page while availability requires an enabled action', () => {
  const unit = vehicle('well', { selected: true, status: 'extraindo na jazida' }),
    held = 'Os suprimentos do veículo 4 não pagam o combustível: Combustível 0 de 3 L.',
    panel = { held, services: [], squad: { units: [unit] } }, before = structuredClone(panel),
    view = fieldNavigation({ shared: true, panel });
  assert.deepEqual([view.status, view.details, view.services], ['extraindo na jazida', true, false]);
  assert.equal(panel.held, held); assert.deepEqual(panel, before);
  const repair = disabled => fieldNavigation({ shared: true, panel: { ...panel,
    services: [{ id: 'repair', disabled }], squad: { units: [{ ...unit, status: 'parado · avariado 20%' }] } } });
  assert.deepEqual([repair(true).services, repair(true).status], [false, 'parado · avariado 20%']);
  assert.equal(repair(false).services, true, 'an enabled explicit repair still draws attention and opens its services');
});

test('resolved trouble precedes refill feedback without removing real receipts from healthy activity', () => {
  const feedback = { kind: 'received', text: 'Recebeu 2 L' },
    show = patch => fieldNavigation({ shared: true, panel: { held: 'Falta Ferro para o reparo.', services: [],
      squad: { units: [vehicle('a', { selected: true, feedback, ...patch })] } } });
  for (const patch of [
    { trouble: true, status: 'ferramenta sem combustível' },
    { trouble: true, status: 'sem munição · avariado 20%' },
    { alert: true, status: 'atacando o alvo · contato visual' },
    { doing: 'halted', status: 'caminho de volta bloqueado' },
  ]) assert.equal(show(patch).status, patch.status);
  assert.equal(show({ status: 'em movimento' }).status, feedback.text);
});
