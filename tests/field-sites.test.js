import test from 'node:test';
import assert from 'node:assert/strict';
import { FieldSites } from '../src/field-sites.ts';
import { bill, load } from '../src/economy.ts';
import { workspaceDOM } from './helpers/dom.js';
import { veinRows, postRows } from '../src/faction-ui.ts';
import { initTouch } from '../src/touch.ts';

// A vein and a wreck as the panel tells them, and their marks as the field draws them: the words of the vein with the room
// of its button over them, the label of the wreck over the wreck.
const VEIN = { id: 'silica:1', x: 100, material: 'silica', name: 'Sílica · duna', share: .5, lines: ['Reserva 31 t de 62 t', 'Pronto 0 kg', 'A 183 m → da base'],
  collect: { ids: ['miner'], name: 'Extrair e transportar', label: 'Coletar', title: 'Extrai, leva o material à base ou ao posto mais perto e repete.', icon: 'i-haul' } };
const WRECK = { id: 'c3', x: 120, name: 'Destroços · Veículo construtor', lines: ['Vale Ferro 22.648', 'A 188 m → da base · somem em 1:17'],
  salvage: { text: 'Desmontar', icon: 'i-repair', title: 'O que resta dos destroços vai para os estoques da facção.', disabled: false } };
// What the panel tells of the places, with nothing of a kind it does not say.
const told = places => ({ veins: [], wrecks: [], works: [], heaps: [], roads: [], posts: [], ...places });
const VEIN_MARK = { kind: 'vein', id: VEIN.id, x: 300, area: { left: 240, right: 360, top: 150, bottom: 230 }, button: { x: 300, y: 178 } };
const wreckMark = (patch = {}) => ({ kind: 'wreck', id: WRECK.id, x: 520, area: { left: 480, right: 560, top: 200, bottom: 260 }, button: { x: 520, y: 196 }, ...patch });

function field(t, { picked = ['miner'], answer = async () => ({}), agree = async () => true } = {}) {
  const { create } = workspaceDOM(t), events = new Map(), requests = [], toasts = [], asked = [], choice = { picked },
    camera = { width: 667, height: 375, covered: { top: 20, bottom: 20, left: 0, right: 0 }, cover() { return this.covered; } };
  document.addEventListener = (type, listener) => events.set(type, listener);
  const viewport = create('div', 'viewport'), overlay = create('div', 'overlay', viewport), canvas = create('canvas', 'canvas', viewport);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const sites = new FieldSites(overlay, { view: viewport, canvas, camera, picked: () => choice.picked, refresh() {}, toast: (...said) => toasts.push(said),
    command: async (type, data) => { requests.push({ type, data }); return answer(type, data); }, measure: words => words.length * 7, confirm: async (...question) => { asked.push(question); return agree(); } });
  sites.card.offsetWidth = 150; sites.card.offsetHeight = 80;
  return { sites, overlay, viewport, canvas, camera, events, requests, toasts, asked, choice, buttons: () => overlay.querySelectorAll('.field-site-action'),
    press: (target, at = {}) => events.get('pointerdown')({ target, clientX: 0, clientY: 0, ...at }) };
}

test('airdrop UI card and Transportar remain reachable by mouse and touch and preserve selection', async t => {
  let refused = false;
  const f = field(t, { picked: ['miner', 'oil', 'tank'], answer: async () => {
    if (refused) throw new Error('Coleta encerrada.'); return {};
  } }), drop = { id: 'airdrop:1', type: 'airdrop', x: 18000, material: 'ferro', stock: 4000, phase: 'collection',
    arrivesAt: 100, expiresAt: 500, active: true, guarded: true },
    row = (time, stock = drop.stock) => ({ ...veinRows([{ ...drop, stock }], 0, time)[0], collect: {
      ids: ['miner'], name: 'Transportar', label: 'Transportar', title: 'Transporta a carga à base, sem precisar extrair.', icon: 'i-haul' } }),
    mark = { ...VEIN_MARK, id: drop.id }, selection = [...f.choice.picked];
  f.sites.render(told({ veins: [row(null)], wrecks: [] })); f.sites.place([mark]); f.sites.toggle({ kind: 'vein', id: drop.id });
  assert.equal(f.sites.card.getAttribute('aria-label'), 'Airdrop · Ferro bruto');
  assert.equal(f.sites.card.children[1].textContent, 'Aguardando tempo do campo');
  assert.equal(f.sites.card.children.some(child => child.tagName === 'I'), false, 'a ready cargo is not a geological reserve bar');
  const details = f.sites.card.querySelector('details'); assert.equal(details.open, false);
  assert.equal(details.querySelector('summary').textContent, 'Detalhes');
  assert.match(details.textContent, /qualquer facção.*recipiente para sólidos/);
  details.open = true;
  f.sites.render(told({ veins: [row(221)], wrecks: [] }));
  assert.equal(f.sites.card.querySelector('details').open, true, 'a running countdown keeps the player’s disclosure open');
  const button = f.buttons()[0]; assert.equal(button.textContent, 'Transportar');
  document.documentElement = f.viewport;
  initTouch({ canvas: f.canvas, zoom() {}, pan() {} });
  const point = pointerType => f.events.get('pointerdown')({ pointerType, target: f.viewport });
  try {
    for (const [pointerType, height] of [['mouse', 28], ['touch', 40]]) {
      point(pointerType); f.sites.place([mark]);
      assert.equal(f.sites.size('vein', drop.id).height, height);
      assert.deepEqual(f.sites.at(300, 200), { kind: 'vein', id: drop.id });
      const position = [...f.sites.card.style.transform.matchAll(/-?[\d.]+/g)].map(match => Number(match[0]));
      assert(position[0] >= 8 && position[0] + 150 <= f.camera.width - 8);
      assert(position[1] >= f.camera.covered.top + 8 && position[1] + 80 <= f.camera.height - f.camera.covered.bottom - 8);
      f.sites.render(told({ veins: [row(220, 2500)], wrecks: [] })); f.sites.place([mark]);
      assert.equal(f.buttons()[0], button); assert.match(f.sites.card.textContent, /Pronto 2,5 t/);
      assert.doesNotMatch(f.sites.card.textContent, /Reserva|Jazida:/);
      refused = pointerType === 'touch';
      await button.onclick();
      assert.deepEqual(f.requests.at(-1), { type: 'squad', data: { order: 'haul', ids: ['miner'], depositId: drop.id } });
      assert.deepEqual(f.choice.picked, selection, 'accepted and refused commands preserve every selected unit');
      assert.deepEqual(f.toasts.at(-1), refused ? ['Coleta encerrada.', true] : ['Transportar: ordem iniciada · 1 de 3 selecionados.']);
      f.sites.toggle({ kind: 'vein', id: drop.id }); f.sites.place([mark]);
    }
  } finally { point('mouse'); }
  f.sites.render(told({ veins: [], wrecks: [] })); f.sites.place([]);
  const supplied = { id: 'airdrop:2', type: 'airdrop', x: 19000, supplies: bill(48000, 16000, 12000, 4000),
    refined: true, phase: 'collection', arrivesAt: 100, expiresAt: 28900, active: true },
    suppliedRow = (time, supplies = supplied.supplies) => ({ ...veinRows([{ ...supplied, supplies }], 0, time)[0], collect: {
      ids: ['supplier'], name: 'Transportar', label: 'Transportar', title: 'Transporta os recursos refinados em peças de Suprimentos para o estoque da base.', icon: 'i-haul' } }),
    suppliedMark = { ...mark, id: supplied.id };
  f.choice.picked = ['supplier', 'oil', 'tank'];
  const suppliedSelection = [...f.choice.picked];
  try {
    for (const [pointerType, height] of [['mouse', 28], ['touch', 40]]) {
      point(pointerType); f.sites.render(told({ veins: [suppliedRow(220)] })); f.sites.place([suppliedMark]);
      f.sites.toggle({ kind: 'vein', id: supplied.id });
      assert.equal(f.sites.card.hidden, false, 'the balance is inspected in an open card, not stale hidden markup');
      assert.equal(f.sites.card.getAttribute('aria-label'), 'Airdrop · Suprimentos');
      assert(f.sites.card.children[0].children[0].innerHTML.includes('i-haul'));
      assert(!f.sites.card.children[0].children[0].innerHTML.includes('r-undefined'));
      const more = f.sites.card.querySelector('details'); assert.equal(more.open, false);
      assert.match(more.textContent, /Ferro 48.000.*Ligas 16.000.*Sílica 12.000.*Combustível 4.000 L/);
      assert.match(more.textContent, /peça de Suprimentos.*espaço livre.*várias viagens.*estoque.*sem refinar/);
      assert.equal(f.sites.size('vein', supplied.id).height, height);
      more.open = true;
      f.sites.render(told({ veins: [suppliedRow(221, bill(24000, 8000, 6000, 2000))] })); f.sites.place([suppliedMark]);
      assert.equal(f.sites.card.querySelector('details').open, true);
      assert.match(f.sites.card.textContent, /Disponível · 21,1 m³ de suprimentos/);
      assert.doesNotMatch(f.sites.card.textContent, /80 t|80.000 Fe|Reserva|Jazida:/);
      refused = pointerType === 'touch';
      await f.buttons()[0].onclick();
      assert.deepEqual(f.requests.at(-1), { type: 'squad', data: { order: 'haul', ids: ['supplier'], depositId: supplied.id } });
      assert.deepEqual(f.choice.picked, suppliedSelection);
      assert.equal(f.sites.open, null, 'accepted and refused actions both close the card before the next pointer round');
      f.sites.place([suppliedMark]);
    }
  } finally { point('mouse'); }
  f.sites.render(told({ veins: [], wrecks: [] })); f.sites.place([]);
  assert.deepEqual([f.buttons().length, f.sites.card.hidden, f.sites.open, f.sites.rows.vein.size, f.sites.marks.length], [0, true, null, 0, 0]);
});

test('a button stands over a mark only where those picked can work there, and goes with the mark', t => {
  const f = field(t);
  f.sites.render(told({ veins: [VEIN], wrecks: [{ ...WRECK, salvage: null }] })); f.sites.place([VEIN_MARK, wreckMark()]);
  assert.equal(f.buttons().length, 1, 'nobody picked stands by the wreck');
  const [collect] = f.buttons();
  assert.deepEqual([collect.dataset.kind, collect.dataset.id, collect.textContent, collect.title, collect.getAttribute('aria-label'), collect.disabled],
    ['vein', VEIN.id, 'Coletar', VEIN.collect.title, 'Coletar: Sílica · duna', false]);
  assert.deepEqual([collect.style['--x'], collect.style['--y']], ['300px', '178px']);
  f.sites.place([{ ...VEIN_MARK, button: { x: 310.4, y: 170 } }]);
  assert.equal(f.buttons()[0], collect, 'the same button goes with its mark'); assert.deepEqual([collect.style['--x'], collect.style['--y']], ['310px', '170px']);
  // Its size is what the words of its mark leave room for: its words, its icon and the room about them.
  assert.deepEqual([f.sites.size('vein', VEIN.id), f.sites.size('wreck', WRECK.id)], [{ width: 7 * 7 + 42, height: 28 }, null]);
  // Nothing picked works there any more, or its mark has no room for it: the button goes.
  f.sites.render(told({ veins: [{ ...VEIN, collect: null }], wrecks: [] })); f.sites.place([VEIN_MARK]); assert.equal(f.buttons().length, 0);
  f.sites.render(told({ veins: [VEIN], wrecks: [] })); f.sites.place([{ ...VEIN_MARK, button: null }]); assert.equal(f.buttons().length, 0);
});

test('the button of a wreck rises over the mark of a vein, and the button over it, rather than cover them', t => {
  const f = field(t), under = wreckMark({ x: 330, area: { left: 300, right: 380, top: 236, bottom: 290 }, button: { x: 330, y: 232 } });
  f.sites.render(told({ veins: [VEIN], wrecks: [WRECK] })); f.sites.place([VEIN_MARK, under]);
  const [collect, salvage] = f.buttons();
  assert.deepEqual([collect.style['--y'], salvage.style['--y']], ['178px', '144px'], 'the vein keeps the room its words keep for it');
  // The card of the wreck stands over its button where it went.
  f.sites.toggle({ kind: 'wreck', id: WRECK.id }); f.sites.place([VEIN_MARK, under]);
  assert.equal(f.sites.card.style.transform, 'translate(255px, 30px)');
  f.sites.place([under]); assert.equal(salvage.style['--y'], '232px', 'alone, it stands over its own label');
});

test('a press on a mark opens its card by it; a second press, or a press anywhere else, puts it away', t => {
  const f = field(t, { picked: [] }), card = () => f.sites.card;
  f.sites.render(told({ veins: [{ ...VEIN, collect: null }], wrecks: [WRECK] })); f.sites.place([VEIN_MARK, wreckMark()]);
  assert.deepEqual([f.sites.at(300, 200), f.sites.at(420, 200)], [{ kind: 'vein', id: VEIN.id }, null]);
  f.sites.place([VEIN_MARK, wreckMark({ x: 380, area: { left: 340, right: 420, top: 200, bottom: 260 } })]);
  assert.deepEqual(f.sites.at(355, 210), { kind: 'wreck', id: WRECK.id }, 'where two marks meet, the nearest across');
  f.sites.place([VEIN_MARK, wreckMark()]);
  // The card of the vein: its name under the mark of its material, a line of each thing to know, and a bar of what is left under the first.
  f.sites.toggle(f.sites.at(300, 200));
  const [head, ...lines] = card().children;
  assert.deepEqual([card().hidden, card().getAttribute('aria-label'), card().dataset.kind, head.textContent], [false, 'Jazida: Sílica · duna', 'vein', 'Sílica · duna']);
  assert.deepEqual([lines.map(line => line.tagName), lines.map(line => line.textContent), lines[1].style['--fill']],
    [['P', 'I', 'P', 'P'], ['Reserva 31 t de 62 t', '', 'Pronto 0 kg', 'A 183 m → da base'], '50%']);
  // Over its mark, where the view has room for it; under it, or over the panels, where it has not.
  assert.equal(card().style.transform, 'translate(225px, 64px)');
  f.camera.covered = { top: 140, bottom: 20, left: 0, right: 0 }; f.sites.place([VEIN_MARK, wreckMark()]);
  assert.equal(card().style.transform, 'translate(225px, 236px)');
  f.camera.covered = { top: 140, bottom: 120, left: 0, right: 0 }; f.sites.place([VEIN_MARK, wreckMark()]);
  assert.equal(card().style.transform, 'translate(225px, 64px)', 'a card with no room in the field covers the panels until the next press');
  // A press on the card, or on its own mark, keeps it — the mark's press is the toggle —; any other press puts it away.
  f.press(lines[0]); f.press(f.canvas, { clientX: 300, clientY: 200 }); assert.equal(card().hidden, false);
  f.press(f.canvas, { clientX: 520, clientY: 230 }); assert.equal(card().hidden, true);
  f.sites.toggle({ kind: 'vein', id: VEIN.id }); f.press(f.viewport); assert.equal(card().hidden, true);
  f.sites.toggle({ kind: 'vein', id: VEIN.id }); f.sites.toggle({ kind: 'vein', id: VEIN.id }); assert.equal(card().hidden, true);
  // The card of a wreck has its name as it is; one of a place no longer told of goes with it, and one whose mark left the view waits for it.
  f.sites.toggle({ kind: 'wreck', id: WRECK.id });
  assert.deepEqual([card().hidden, card().getAttribute('aria-label'), card().children.slice(1).map(line => line.textContent)], [false, WRECK.name, WRECK.lines]);
  f.sites.place([VEIN_MARK]); assert.equal(card().hidden, true); f.sites.place([VEIN_MARK, wreckMark()]); assert.equal(card().hidden, false);
  f.sites.render(told({ veins: [VEIN], wrecks: [] })); assert.deepEqual([card().hidden, f.sites.open], [true, null]);
});

test('the button over a vein sends only those picked that work it, and a stale one sends nobody', async t => {
  const f = field(t, { picked: ['miner', 'tanker', 'tank'] });
  f.sites.render(told({ veins: [VEIN], wrecks: [] })); f.sites.place([VEIN_MARK]); f.sites.toggle({ kind: 'vein', id: VEIN.id });
  await f.buttons()[0].onclick();
  assert.deepEqual(f.requests, [{ type: 'squad', data: { order: 'haul', ids: ['miner'], depositId: VEIN.id } }]);
  assert.deepEqual([f.toasts.at(-1), f.sites.card.hidden], [['Extrair e transportar: ordem iniciada · 1 de 3 selecionados.'], true]);
  f.choice.picked = ['tank']; await f.buttons()[0].onclick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.toasts.at(-1), ['Selecione um veículo com equipamento compatível com esta jazida.']);
});

test('the button over a wreck works on it, waits while a fight goes on beside it, and takes up the load of one dismantled', async t => {
  let refusal = null;
  const f = field(t, { answer: async () => { if (refusal) throw new Error(refusal); return { value: bill(22648), cargo: load(), left: load() }; } });
  f.sites.render(told({ veins: [], wrecks: [WRECK] })); f.sites.place([wreckMark()]);
  const [salvage] = f.buttons();
  assert.deepEqual([salvage.textContent, salvage.children[0].dataset.icon, salvage.disabled, salvage.getAttribute('aria-label')],
    ['Desmontar', 'i-repair', false, 'Desmontar: Destroços · Veículo construtor']);
  await salvage.onclick();
  assert.deepEqual([f.requests, f.toasts.at(-1)], [[{ type: 'salvage', data: { wreckId: WRECK.id } }], ['Destroços desmontados · Ferro 22.648 para a facção.']]);
  f.sites.render(told({ veins: [], wrecks: [{ ...WRECK, salvage: { ...WRECK.salvage, disabled: true, title: 'Em combate: desmonte em 7 s.' } }] })); f.sites.place([wreckMark()]);
  assert.deepEqual([salvage.disabled, salvage.title], [true, 'Em combate: desmonte em 7 s.']);
  await f.sites.act('wreck', WRECK.id); assert.equal(f.requests.length, 1, 'a held button asks nothing');
  f.sites.render(told({ veins: [], wrecks: [{ ...WRECK, salvage: { text: 'Retirar os materiais', icon: 'i-haul', title: 'A carga vai para as caçambas.', disabled: false } }] })); f.sites.place([wreckMark()]);
  assert.deepEqual([salvage.textContent, salvage.children[0].dataset.icon], ['Retirar os materiais', 'i-haul'], 'the icon follows the action metadata even when its words change');
  refusal = 'Destroços fora de alcance.'; await salvage.onclick();
  assert.deepEqual(f.toasts.at(-1), ['Destroços fora de alcance.', true], 'what the field refuses is said');
});

test('a works and a heap have cards and no button over their marks; a works is given up from its card once the player says so', async t => {
  const WORK = { id: 'c9', x: 140, name: 'Obra · Posto de defesa leve', share: .25, lines: ['Montada 25%', 'Chegou 40% do material'],
      cancel: { text: 'Cancelar obra', title: 'O material que chegou fica num monte no local; a montagem se perde.', question: 'Cancelar esta obra?' } },
    HEAP = { id: 'c2', x: 160, name: 'Material', lines: ['Ferro 800'] },
    mark = (kind, id, x) => ({ kind, id, x, area: { left: x - 30, right: x + 30, top: 200, bottom: 240 }, button: null });
  let agree = false;
  const f = field(t, { answer: async () => ({ cancelled: 'c9', heap: { id: 'c9', stock: bill(1686) } }), agree: async () => agree });
  f.sites.render(told({ works: [WORK], heaps: [HEAP] })); f.sites.place([mark('work', 'c9', 300), mark('heap', 'c2', 450)]);
  assert.equal(f.buttons().length, 0, 'the faction works on these by itself');
  assert.deepEqual(f.sites.at(305, 220), { kind: 'work', id: 'c9' });
  f.sites.toggle({ kind: 'heap', id: 'c2' });
  assert.deepEqual([f.sites.card.dataset.kind, f.sites.card.children.map(child => child.textContent)], ['heap', ['Material', 'Ferro 800']]);
  assert.equal(f.sites.card.children[0].children[0].innerHTML.includes('i-haul'), true);
  f.sites.toggle({ kind: 'work', id: 'c9' });
  const [head, first, bar, second, give] = f.sites.card.children;
  assert.deepEqual([head.textContent, first.textContent, bar.style['--fill'], second.textContent, give.textContent, give.title],
    ['Obra · Posto de defesa leve', 'Montada 25%', '25%', 'Chegou 40% do material', 'Cancelar obra', WORK.cancel.title]);
  // Asked and refused, nothing is asked of the field; agreed, the works is given up and what came of it stays there.
  await give.onclick();
  assert.deepEqual([f.asked.length, f.requests], [1, []]); assert.equal(f.asked[0][0], 'Cancelar esta obra?');
  agree = true; f.sites.toggle({ kind: 'work', id: 'c9' }); await f.sites.card.children.at(-1).onclick();
  assert.deepEqual(f.requests, [{ type: 'cancel-work', data: { workId: 'c9' } }]);
  assert.deepEqual(f.toasts.at(-1), ['Obra cancelada: o material que chegou ficou no local.']);
  // A works no longer told of takes its card with it.
  f.sites.toggle({ kind: 'work', id: 'c9' }); f.sites.render(told({ heaps: [HEAP] })); assert.deepEqual([f.sites.card.hidden, f.sites.open], [true, null]);
});

test('a road asked for has its card by its label, with a bar of how far it is made, and is given up from it once the player says so', async t => {
  const ROAD = { id: 'r1', x: 1550, x0: 1500, x1: 1600, name: 'Estrada · Asfalto', share: .3, lines: ['100 m · nivelada 50% · asfaltada 10%', 'Niveladora trabalhando'],
    cancel: { text: 'Cancelar estrada', title: 'O que já foi feito fica no campo; as máquinas param.', question: 'Cancelar esta estrada?' } };
  const f = field(t, { answer: async () => ({ cancelled: 'r1' }) });
  f.sites.render(told({ roads: [ROAD] })); f.sites.place([{ kind: 'road', id: 'r1', x: 300, area: { left: 260, right: 340, top: 250, bottom: 266 }, button: null }]);
  assert.equal(f.buttons().length, 0, 'the faction makes it by itself');
  assert.deepEqual([f.sites.at(300, 258), f.sites.at(300, 200)], [{ kind: 'road', id: 'r1' }, null], 'its mark is its label alone');
  f.sites.toggle({ kind: 'road', id: 'r1' });
  const [head, first, bar, second, give] = f.sites.card.children;
  assert.deepEqual([f.sites.card.dataset.kind, head.textContent, first.textContent, bar.style['--fill'], second.textContent, give.textContent],
    ['road', 'Estrada · Asfalto', ROAD.lines[0], '30%', 'Niveladora trabalhando', 'Cancelar estrada']);
  assert.equal(head.children[0].innerHTML.includes('i-road'), true);
  await give.onclick();
  assert.deepEqual(f.asked, [['Cancelar esta estrada?', ROAD.cancel.title, 'Cancelar estrada']]);
  assert.deepEqual(f.requests, [{ type: 'cancel-road', data: { roadId: 'r1' } }]);
  assert.deepEqual(f.toasts.at(-1), ['Estrada cancelada: o que já foi feito fica.']);
});

test('a post of the faction has its card by its label, says what it serves, and is taken down or kept from it once the player says so', async t => {
  const faction = { base: { x: 1000 }, posts: [{ id: 'p1', x: 2750, facing: 1, radius: 50, takedown: null, siege: null }] },
    f = field(t, { answer: async type => type === 'keep-post' ? { kept: 'p1' } : { dismantling: 'p1', seconds: 60, value: bill() } }),
    mark = { kind: 'post', id: 'p1', x: 300, area: { left: 250, right: 350, top: 150, bottom: 240 }, button: null };
  f.sites.render(told({ posts: postRows(faction) })); f.sites.place([mark]);
  assert.equal(f.buttons().length, 0, 'the faction serves at it by itself');
  assert.deepEqual(f.sites.at(300, 200), { kind: 'post', id: 'p1' });
  f.sites.toggle({ kind: 'post', id: 'p1' });
  const [head, first, second, give] = f.sites.card.children;
  assert.deepEqual([f.sites.card.dataset.kind, head.textContent, first.textContent, second.textContent, give.textContent],
    ['post', 'Posto', 'Descarga, rearme, abastecimento, reparo e abrigo a até 50 m', 'A 1,8 km → da base', 'Desmontar posto']);
  assert.equal(head.children[0].innerHTML.includes('i-flag'), true);
  await give.onclick();
  assert.deepEqual([f.asked.at(-1)[0], f.requests], ['Desmontar este posto?', [{ type: 'remove-post', data: { postId: 'p1' } }]]);
  assert.deepEqual(f.toasts.at(-1), ['Desmontagem do posto iniciada: um construtor em automático vai até ele.']);
  // Being taken down, its card says how far that has gone and who does it, and keeps it instead.
  faction.posts[0].takedown = { progress: .25, seconds: 60, building: false, sent: null };
  f.sites.render(told({ posts: postRows(faction) })); f.sites.place([mark]); f.sites.toggle({ kind: 'post', id: 'p1' });
  const card = f.sites.card.children;
  assert.deepEqual([card[1].textContent, card[2].style['--fill'], card.at(-1).textContent], ['Desmontando 25%', '25%', 'Manter posto']);
  await card.at(-1).onclick();
  assert.deepEqual(f.requests.at(-1), { type: 'keep-post', data: { postId: 'p1' } });
  assert.deepEqual(f.toasts.at(-1), ['Posto mantido.']);
});
