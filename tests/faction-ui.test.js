import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { constructionCost } from '../src/construction-cost.ts';
import { screenModel } from '../src/ui-model.ts';
import { WRECK_FADE_SECONDS, SALVAGE_REACH, CALM_SECONDS, UNCOMMANDED, UNBASED, bill, billText, stockText, shortText, scantText, fillName, fillThing, stocked, load, loadText, supplied, designBill, buildSeconds } from '../src/economy.ts';
import { TRIAL_TARGET_OWNER } from '../src/battle-rules.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { standing, holderOf, seenFromOutside, wreckFade, ghostFade, stockFigures, heardText, carriedText, suppliesGauge, damageText, yardText, unitServices, cancelledText, dumpedText, dismantleQuote, returnedText, dismantleHold, dismantlePlan, dismantleQuestion, dismantledNews, publishQuote, obraQuote, publishedText, wreckRows, workRows, heapRows, roadRows, abandonedText, salvagedText,
  knownVeins, veinRows, depositMarks, veinMarks, farText, haulText, cargoText, mixGauge, factionName, factionSaid, arrivals, joinWarning,
  recoveryText, emptyText, strandedText, fellText, recoveredText, takenText, serviceText, jobText, jobAdvice } from '../src/faction-ui.ts';

await initNativeDynamics();
const base = { x: 1234, y: 153.4, facing: -1, radius: 100 };
// A construction as the faction tells it: in its base, which is the point that serves it, gives all it is short of and mends it, unless told otherwise.
const quoted = (patch = {}) => { const unit = { id: 'tank', vehicle: true, value: bill(21147), built: bill(21148), repair: bill(), repairSeconds: 0, rearm: bill(), atBase: true, calm: true, still: true,
  service: null, cargo: load(), fill: { solid: 0, liquid: 0, supplies: 0 }, loading: null, supplies: null, load: null, mend: null, ...patch };
  return { point: unit.atBase ? { supplier: null, stock: null, held: '', resupply: unit.rearm } : null, mender: unit.atBase ? { supplier: null, stock: null, held: '' } : null, ...unit }; };
const founded = (patch = {}) => ({ id: 'green', name: 'Ana', stock: bill(60000, 0, 0, 1500), yard: load(), base, members: [{ id: 'ana', name: 'Ana', connected: true }],
  known: [], strangers: [], ranking: [], invites: [], request: null, requests: [], library: [], recovery: null, fell: null, recovered: null, count: 1, counts: { vehicles: 1, fixed: 0 }, units: [quoted()], wrecks: [], deposits: [], ...patch });
// The job of whatever carries something away from its base: to tip part of it out.
const DUMP = { id: 'dump', text: 'Despejar ¼ da carga', disabled: false, title: 'Alivia o peso: o que sai fica no chão e se perde.' };

test('a construction of the shared field is the player\'s while it is of the faction and no other member holds it, an ally\'s while one does, an enemy\'s or nobody\'s', () => {
  const beto = { id: 'beto', name: 'Beto' }, state = (units = []) => ({ localPlayerId: 'ana', faction: { id: 'green' }, squad: { units } });
  assert.equal(standing({ id: 'a', ownerId: 'ana', team: 'green' }, state()), 'own');
  assert.equal(standing({ id: 'b', ownerId: 'beto', team: 'green' }, state()), 'own', 'one of the faction nobody holds is the player\'s to take');
  assert.equal(standing({ id: 'b', ownerId: 'beto', team: 'green' }, state([{ id: 'b', by: beto }])), 'ally');
  assert.deepEqual([holderOf({ id: 'b' }, state([{ id: 'b', by: beto }])), holderOf({ id: 'a' }, state([{ id: 'a', reserved: true }]))], [beto, null]);
  assert.equal(standing({ id: 'c', ownerId: 'caio', team: 'red' }, state()), 'enemy');
  assert.equal(standing({ ownerId: null, team: 'green', defeated: true }, state()), 'wreck', 'a wreck of the faction is nobody\'s too');
  // Before the faction is known the player's own are those in the player's squad, and nobody is an ally.
  assert.equal(standing({ ownerId: 'ana', team: 'green' }, { localPlayerId: 'ana' }), 'own');
  assert.equal(standing({ ownerId: 'caio', team: undefined }, { localPlayerId: 'ana' }), 'enemy');
});

test('on the field every construction is seen from outside but the player\'s own that is picked', () => {
  // Away from the field the design is seen into while the page opens it (ui-model.ts `trialOpened`), and from outside
  // when it does not: driven on the proving ground. The targets there are seen from outside, standing or wrecked.
  const design = { id: 'local', ownerId: 'local' }, targets = [{ id: 'alvo-3', ownerId: TRIAL_TARGET_OWNER }, { id: 'alvo-4', ownerId: null, defeated: true }];
  assert.deepEqual([new Set(['local']), new Set(), null].map(opened => seenFromOutside(design, { actors: [] }, opened)), [false, true, true]);
  for (const target of targets) assert.equal(seenFromOutside(target, { actors: [] }, new Set(['local'])), true);
  // On the shared field the player's own, the side's and the others' are seen from outside, standing or wrecked.
  const field = { shared: true, localPlayerId: 'me', faction: { id: 'f1' }, controlledActor: null, squad: { units: [{ id: 'b', by: { id: 'friend', name: 'Amigo' } }] } },
    actors = [{ id: 'a', ownerId: 'me', team: 'f1' }, { id: 'b', ownerId: 'friend', team: 'f1' }, { id: 'c', ownerId: 'foe', team: 'f2' },
      { id: 'd', ownerId: null, team: 'f2', defeated: true }, { id: 'e', ownerId: 'me', team: 'f1' }, { id: 'f', ownerId: 'friend', team: 'f1' }];
  assert.deepEqual(actors.map(actor => seenFromOutside(actor, field)), [true, true, true, true, true, true]);
  // Picked, the player's own is opened — one of the faction no other member holds —; picking another's opens nothing.
  const opened = new Set(['a', 'b', 'c', 'd', 'f']);
  assert.deepEqual(actors.map(actor => seenFromOutside(actor, field, opened)), [false, true, true, true, true, false]);
  // The one in the player's hands is not opened by the page (squad-ux.ts `opened`): it is seen from outside, as the
  // rest of the field; and nothing but the player's own is opened.
  assert.equal(seenFromOutside(actors[0], { ...field, controlledActor: 'a' }, new Set()), true);
  assert.equal(seenFromOutside({ id: 'm', ownerId: null }, { ...field, controlledActor: 'm' }, new Set(['m'])), true);
});

test('a wreck is whole until its last seconds and gone when its time is over', () => {
  const wreck = { field: { wreck: { until: 500 }, service: null } };
  assert.equal(wreckFade({ field: null }, 499), 1); assert.equal(wreckFade({}, 499), 1);
  assert.equal(wreckFade(wreck, 500 - WRECK_FADE_SECONDS - 30), 1);
  assert.equal(wreckFade(wreck, 500 - WRECK_FADE_SECONDS / 2), .5);
  assert.equal(wreckFade(wreck, 500), 0); assert.equal(wreckFade(wreck, 512), 0);
  assert.equal(wreckFade({ field: { wreck: null, service: { kind: 'repair', until: 9 } } }, 500), 1, 'a repair does not fade');
  const remembered = { ...wreck, defeated: true, ghost: { since: 0 } };
  for (const time of [500, 512, 5000]) {
    assert.equal(wreckFade(remembered, time), 1, 'a remembered wreck does not disclose its unseen expiry');
    assert.equal(ghostFade(remembered, time), .6, 'a known wreck stays equally legible on the map');
    assert.equal(standing(remembered, { faction: { id: 'own' } }), 'wreck');
  }
  assert.equal(ghostFade({ ghost: { since: 0 }, defeated: false }, 5000), .25, 'a live ghost keeps its existing age fade');
});

test('the stocks are told one by one, and the base by the stretch a construction may be published in', () => {
  assert.deepEqual(stockFigures(bill(60000, 0, 1234.4, 1500)).map(figure => [figure.id, figure.name, figure.text]),
    [['ferro', 'Ferro', '60.000'], ['ligas', 'Ligas', '0'], ['silica', 'Sílica', '1.234'], ['combustivel', 'Combustível', '1.500 L']]);
});

test('a fresh contact is worded by the sense it came through, with distance and side', () => {
  assert.equal(heardText({ x: 1320, channel: 'sound' }, 1000), 'ouviu um inimigo a 320 m →');
  assert.equal(heardText({ x: 400, channel: 'radar' }, 1000), 'sinal de radar a 600 m ←');
  assert.equal(heardText({ x: 3500, channel: 'visual' }, 1000), 'avistou um inimigo a 2.500 m →');
  for (const channel of ['memory', 'team', 'none', undefined, 'constructor'])
    assert.equal(heardText({ x: 990, channel }, 1000), 'inimigo detectado a 10 m ←');
  assert.equal(heardText(null, 1000), '');
  // Of one the side was told no place of — only heard —, the side alone.
  assert.equal(heardText({ side: -1, channel: 'sound' }, 1000), 'ouviu um inimigo à esquerda ←');
  assert.equal(heardText({ side: 1, channel: 'visual' }, 1000), 'avistou um inimigo à direita →');
});

test('a bill is worded stock by stock: what it asks, what it gives back and what is short', () => {
  assert.equal(billText(bill(21148)), 'Ferro 21.148'); assert.equal(billText(bill(500, 300, 20)), 'Ferro 500 + Ligas 300 + Sílica 20');
  assert.equal(billText(bill(-1147)), 'devolve Ferro 1.147'); assert.equal(billText(bill(-1147, 3000, 500)), 'Ligas 3.000 + Sílica 500 · devolve Ferro 1.147');
  assert.equal(billText(bill()), 'nada'); assert.equal(billText(bill(.2), 'sem custo'), 'sem custo', 'less than one unit is nothing');
  assert.equal(stockText(bill(60000, 0, 1234.4, 1500)), 'Ferro 60.000 · Ligas 0 · Sílica 1.234 · Combustível 1.500 L');
  // Fuel is counted in litres, and so is the petroleum it is made of.
  assert.equal(billText(bill(21733, 0, 0, 203)), 'Ferro 21.733 + Combustível 203 L'); assert.equal(billText(bill(-586, 0, 0, -23)), 'devolve Ferro 586 + Combustível 23 L');
  assert.equal(loadText(load(4250, 0, 1500, 800)), 'Ferro 4.250 + Sílica 1.500 + Petróleo 800 L'); assert.deepEqual([loadText(load()), loadText(load(.3), 'vazia')], ['nada', 'vazia']);
  assert.equal(shortText(bill(60000), bill(21148)), ''); assert.equal(shortText(bill(0, 0, 0), bill(-5, 0, 0)), '', 'what is given back is never short');
  assert.equal(shortText(bill(60000), bill(100461), 'fabricar'), 'Falta Ferro para fabricar: custa 100.461 e a facção tem 60.000.');
  assert.equal(shortText(bill(60000, 0, 0, 150.7), bill(21733, 0, 0, 203), 'fabricar'), 'Falta Combustível para fabricar: custa 203 L e a facção tem 150,7 L.');
  // What a refinery added up share by share is a crumb short of what was brought: that is not a unit less.
  assert.deepEqual([stocked(299.9999999999), stocked(299.99), stocked(-1e-9)], [300, 299, 0]); assert.equal(shortText(bill(299.9999999999), bill(300)), '');
  assert.equal(shortText(bill(299.99), bill(300)), 'Falta Ferro: custa 300 e a facção tem 299.');
  assert.equal(shortText(bill(60000, 100.9), bill(500, 300)), 'Falta Ligas: custa 300 e a facção tem 100.');
  assert.equal(shortText(bill(60000), bill(20000, 3000, 500)), 'Faltam Ligas e Sílica: Ligas custa 3.000 e a facção tem 0; Sílica custa 500 e a facção tem 0.');
});

test('a point offers an explicitly resumed repair and says in one line why an asked job waits', () => {
  const ids = services => services.jobs.map(work => work.id), job = (services, id) => services.jobs.find(work => work.id === id),
    // A previously cancelled repair needs an explicit request even at base; ordinary manual-at-base automation is tested below.
    asked = (unit, stock = bill(60000, 0, 0, 1500), options) => unitServices(unit && { declined: true, ...unit }, founded({ stock }), { hand: true, ...options });
  // A whole construction, full of rounds and of fuel, has nothing to ask of its base: dismantling is asked of those picked (Mais ações).
  assert.deepEqual(asked(quoted()), { jobs: [], held: '' });

  // Its repair is a job; filling it up is none: that comes by itself.
  const hurt = asked(quoted({ repair: bill(2013), repairSeconds: 9, rearm: bill(1253), value: bill(19000) }));
  assert.deepEqual(ids(hurt), ['repair']); assert.equal(hurt.held, '');
  assert.deepEqual([job(hurt, 'repair').text, job(hurt, 'repair').disabled], ['Reparar · Ferro 2.013 · 9 s', false]);
  // Filling up is named by what is missing: rounds, fuel or both.
  assert.deepEqual([fillName(bill(5)), fillName(bill(0, 0, 0, 5)), fillName(bill(5, 0, 0, 5))], ['Remuniciar', 'Abastecer', 'Remuniciar e abastecer']);
  assert.deepEqual([fillThing(bill(5)), fillThing(bill(0, 0, 0, 5)), fillThing(bill(5, 0, 0, 5))], ['a munição', 'o combustível', 'a munição e o combustível']);

  // A repair the point pays for none of waits: the job the player is about stays, with its reason.
  const poor = asked(quoted({ repair: bill(2013), repairSeconds: 9, rearm: bill(1253) }), bill(1500));
  assert.deepEqual([job(poor, 'repair').disabled, job(poor, 'repair').title], [true, 'Falta Ferro para o reparo: custa 2.013 e a facção tem 1.500.']);
  assert.equal(poor.held, 'Falta Ferro para o reparo: custa 2.013 e a facção tem 1.500.');
  // One it pays for part of mends that part (`mend`): the pieces, as far as it pays for them, the most needed first.
  const part = asked(quoted({ repair: bill(2013), repairSeconds: 9, mend: { cost: bill(1500), seconds: 8 } }), bill(1500));
  assert.deepEqual([job(part, 'repair').text, job(part, 'repair').disabled, part.held], ['Reparar em parte · Ferro 1.500 · 8 s', false, '']);
  assert.equal(job(part, 'repair').title,
    'Não há o bastante para o reparo inteiro: conserta o que der, peça por peça — primeiro o Comando, depois motor e rodas, armas e sensores, e por fim as chapas, uma inteira de cada vez.');
  // Filling up gives what the point pays for, and says nothing of what waits until that is nothing.
  const partial = asked(quoted({ rearm: bill(1253, 0, 0, 120), point: { supplier: null, stock: null, held: '', resupply: bill(650, 0, 0, 120) } }), bill(650, 0, 0, 1500));
  assert.deepEqual([ids(partial), partial.held], [[], '']);
  const none = asked(quoted({ rearm: bill(1253, 0, 0, 120), point: { supplier: null, stock: null, held: '', resupply: bill() } }), bill());
  assert.equal(none.held, 'Reposição até completar: Faltam Ferro e Combustível para remuniciar e abastecer: Ferro custa 1.253 e a facção tem 0; Combustível custa 120 L e a facção tem 0 L.');

  // A plate of titanium is mended with alloys: iron does not pay for it, however much there is.
  const plated = asked(quoted({ repair: bill(500, 300), repairSeconds: 7, value: bill(19000, 2700) }), bill(60000, 100));
  assert.deepEqual([job(plated, 'repair').text, job(plated, 'repair').disabled, job(plated, 'repair').title],
    ['Reparar · Ferro 500 + Ligas 300 · 7 s', true, 'Falta Ligas para o reparo: custa 300 e a facção tem 100.']);
  assert.equal(job(asked(quoted({ repair: bill(500, 300), repairSeconds: 7 }), bill(500, 300)), 'repair').disabled, false);

  // Away from any point nothing is done: no job, switched off or not, and no line about it.
  assert.deepEqual(asked(quoted({ repair: bill(2013), repairSeconds: 9, rearm: bill(1253), atBase: false })), { jobs: [], held: '' });
  // In combat the jobs wait, and the one line says for what.
  const fighting = asked(quoted({ repair: bill(2013), repairSeconds: 9, calm: false }));
  assert.deepEqual(ids(fighting), ['repair']);
  for (const work of fighting.jobs) { assert.equal(work.disabled, true); assert.match(work.title, /^Em combate/); }
  assert.match(fighting.held, /^Em combate: fique \d+ s sem atirar nem ser atingida\.$/);
  // A repair under way is all that is done of a construction, and its one job is to cancel it: the row of the squad says how long it takes.
  const mending = patch => quoted({ repair: bill(2013), repairSeconds: 9, service: { kind: 'repair', until: 106.2, cost: bill(2013), payer: null, ...patch } });
  assert.deepEqual(asked(mending()), { jobs: [{ id: 'cancel', text: 'Cancelar reparo', disabled: false,
    title: 'Encerra o reparo sem consertar nada e devolve Ferro 2.013 aos estoques da facção.' }], held: 'Em reparo na base: acelere para cancelar.' });
  assert.deepEqual(unitServices(mending(), founded()).jobs, asked(mending()).jobs, 'cancellation remains available in hand or not');
  assert.equal(unitServices(mending(), founded()).held, '', 'only manual control needs the acceleration hint');
  // Paid by a supply vehicle, it goes back to that one, wherever it is by now: the point is no matter.
  assert.equal(asked({ ...mending({ payer: 'truck' }), atBase: false, point: null }).jobs[0].title,
    'Encerra o reparo sem consertar nada e devolve Ferro 2.013 ao veículo de suprimentos que pagou, enquanto ele estiver no campo e tiver espaço: o que não couber se perde.');
  assert.equal(cancelledText({ refund: bill(2013), lost: bill(), supplier: null, gone: false }), 'Reparo cancelado · Ferro 2.013 de volta aos estoques da facção.');
  assert.equal(cancelledText({ refund: bill(2013), lost: bill(), supplier: 'truck', gone: false }), 'Reparo cancelado · Ferro 2.013 de volta ao veículo de suprimentos que pagou.');
  assert.equal(cancelledText({ refund: bill(1500, 40), lost: bill(513), supplier: 'truck', gone: false }),
    'Reparo cancelado · Ferro 1.500 + Ligas 40 de volta ao veículo de suprimentos que pagou · perdido: Ferro 513, que não coube nele.');
  assert.equal(cancelledText({ refund: bill(), lost: bill(2013), supplier: 'truck', gone: true }),
    'Reparo cancelado · perdido: Ferro 2.013, porque o veículo de suprimentos que pagou já não está no campo.');
  // One cancelled where the construction stands is not begun again by itself: it is a job, in hand or not.
  const declined = unitServices(quoted({ repair: bill(2013), repairSeconds: 9, declined: true }), founded());
  assert.deepEqual([ids(declined), job(declined, 'repair').text, declined.held], [['repair'], 'Reparar · Ferro 2.013 · 9 s', '']);
  assert.match(unitServices(quoted({ repair: bill(2013), repairSeconds: 9, declined: true, calm: false }), founded()).held, /^Em combate/);
  assert.deepEqual(asked(null), { jobs: [], held: '' });
  // Damage is told as the share of the construction there is to mend.
  assert.equal(damageText(quoted()), ''); assert.equal(damageText(null), '');
  assert.equal(damageText(quoted({ repair: bill(2115) })), 'avariado 10%'); assert.equal(damageText(quoted({ repair: bill(3) })), 'avariado 1%', 'any damage is told');

  // Beside a supply vehicle, away from the base, the two services are paid from what it carries, and the repair says whose supplies those are.
  const beside = (patch, point) => {
      const { resupply, ...truck } = { supplier: 'truck', stock: bill(3000, 0, 0, 800), held: '', resupply: bill(1253, 0, 0, 120), ...point };
      return quoted({ atBase: false, repair: bill(2013), repairSeconds: 9, rearm: bill(1253, 0, 0, 120), ...patch, point: { ...truck, resupply }, mender: truck });
    },
    served = asked(beside(), undefined, { named: () => 'veículo 3' });
  assert.deepEqual([served.jobs.map(work => [work.id, work.text, work.disabled]), served.held], [[['repair', 'Reparar · Ferro 2.013 · 9 s · suprimentos do veículo 3', false]], ''],
    'no dismantling away from the base');
  // What it carries does not pay the repair: the reason says what there is of what is asked. Iron alone gives the rounds and no fuel.
  const scant = asked(beside({}, { stock: bill(1500), resupply: bill(1253) }), undefined, { named: () => 'veículo 3' });
  assert.deepEqual([job(scant, 'repair').disabled, scant.held], [true, 'Os suprimentos do veículo 3 não pagam o reparo: Ferro 1.500 de 2.013.']);
  const some = asked(beside({ mend: { cost: bill(1500), seconds: 8 } }, { stock: bill(1500), resupply: bill(1253) }), undefined, { named: () => 'veículo 3' });
  assert.deepEqual([job(some, 'repair').text, job(some, 'repair').disabled], ['Reparar em parte · Ferro 1.500 · 8 s · suprimentos do veículo 3', false]);
  const fuelless = asked(beside({ repair: bill(), rearm: bill(0, 0, 0, 120) }, { stock: bill(1500), resupply: bill() }), undefined, { named: () => 'veículo de Beto' });
  assert.deepEqual(fuelless, { jobs: [], held: 'Reposição até completar: Os suprimentos do veículo de Beto não pagam o combustível: Combustível 0 de 120 L.' });
  assert.equal(scantText(bill(300, 5), bill(1253, 40), 'o reparo', 'ao alcance'), 'Os suprimentos ao alcance não pagam o reparo: Ferro 300 de 1.253 e Ligas 5 de 40.');
  assert.equal(scantText(bill(3000), bill(1253), 'o reparo', 'do veículo 3'), '');
  // A supply vehicle that moves, is in combat or is being mended gives nothing yet.
  for (const [held, words] of [['moving', 'O veículo 3 está em movimento: os suprimentos esperam ele parar.'], ['combat', 'O veículo 3 está em combate: os suprimentos esperam 10 s sem tiros.'],
    ['repair', 'O veículo 3 está em reparo: os suprimentos esperam o fim dele.']]) {
    const waiting = asked(beside({}, { held }), undefined, { named: () => 'veículo 3' });
    assert.deepEqual([waiting.jobs.map(work => work.disabled), waiting.held], [[true], words]);
  }
  // Two in reach share the work as the field gives it out: the nearer, with fuel and no iron, fuels it, and the farther
  // pays the repair. The repair says whose supplies pay it, and waits for that one alone; the fuel waits for the other.
  const two = (held = '', fueller = '') => ({ ...beside({ rearm: bill(0, 0, 0, 120) }, { stock: bill(0, 0, 0, 800), resupply: bill(0, 0, 0, 120), held: fueller }),
      mender: { supplier: 'other', stock: bill(3000), held } }),
    names = { named: id => id === 'truck' ? 'veículo 3' : 'veículo 4' };
  assert.deepEqual(asked(two(), undefined, names), { jobs: [{ id: 'repair', text: 'Reparar · Ferro 2.013 · 9 s · suprimentos do veículo 4', disabled: false,
    title: 'A construção fica parada durante o reparo e volta inteira, com a carga que tinha.' }], held: '' });
  const rolled = asked(two('moving'), undefined, names);
  assert.deepEqual([rolled.jobs.map(work => work.disabled), rolled.held], [[true], 'O veículo 4 está em movimento: os suprimentos esperam ele parar.']);
  assert.equal(asked(two('', 'moving'), undefined, names).held, 'O veículo 3 está em movimento: os suprimentos esperam ele parar.');
  // A supply vehicle whose point is itself fills its own tank out of the fuel it carries, and that is all: no rounds and no repair of its own.
  // That comes without asking, and what waits is said as of any other. Its supplies it does not tip out: they go back at the base.
  const supplier = (patch, point) => quoted({ id: 'supply', atBase: false, supplies: bill(3000, 0, 0, 800), repair: bill(2013), repairSeconds: 9, rearm: bill(1253, 0, 0, 197), ...patch,
    point: { supplier: 'supply', stock: bill(0, 0, 0, 800), held: '', resupply: bill(0, 0, 0, 197), ...point } });
  assert.deepEqual(asked(supplier()), { jobs: [], held: '' });
  assert.deepEqual(asked(supplier({ rearm: bill(1253) }, { resupply: bill() })), { jobs: [], held: '' }, 'with its tank full there is nothing of its own to give itself, nor anything to say of rounds it cannot give itself');
  assert.deepEqual(asked(supplier({}, { held: 'moving' })), { jobs: [], held: 'Em movimento: ele se abastece do que leva quando parar.' });
  assert.deepEqual(asked(supplier({}, { held: 'moving', stock: bill(), resupply: bill() })), { jobs: [], held: '' },
    'an own point with no published allowance promises no service and does not mask the work status');
  assert.match(asked(supplier({ calm: false })).held, /^Em combate/);
  // Beside another supply vehicle it is mended out of what that one carries, as any construction is.
  assert.deepEqual(asked({ ...supplier(), mender: { supplier: 'truck', stock: bill(3000), held: '' } }, undefined, { named: () => 'veículo 3' }).jobs.map(work => [work.id, work.text]),
    [['repair', 'Reparar · Ferro 2.013 · 9 s · suprimentos do veículo 3']]);
  // A hauler that also takes supplies along tips out the ore of its hopper, and nothing of its supplies.
  assert.deepEqual(asked(supplier({ cargo: load(4000) })).jobs.map(work => work.id), ['dump']);
});

test('whatever carries something away from its base may tip part of it out to weigh less, whether a point serves it there or not', () => {
  const ids = services => services.jobs.map(work => work.id), at = (patch, options) => unitServices(quoted({ cargo: load(0, 0, 17695), fill: { solid: 1, liquid: 0 }, ...patch }), founded(), options);
  // Stuck far from everything, full: nothing serves it, and that one job is there. In combat and on the move too.
  assert.deepEqual(at({ atBase: false }), { jobs: [DUMP], held: '' });
  assert.deepEqual(at({ atBase: false, calm: false, still: false }), { jobs: [DUMP], held: '' });
  // Beside a supply vehicle it comes after what that one does for it.
  const beside = at({ atBase: false, repair: bill(2013), repairSeconds: 9, point: { supplier: 'truck', stock: bill(3000), held: '', resupply: bill() },
    mender: { supplier: 'truck', stock: bill(3000), held: '' } }, { hand: true });
  assert.deepEqual(ids(beside), ['repair', 'dump']);
  // In its base a load is put down whole, and none of it is lost: the job is not offered there.
  assert.deepEqual([ids(at()), ids(at({ supplies: bill(3000) }))], [[], []]);
  // Nothing aboard, nothing to tip out; and a construction under repair has its repair to cancel, and no more.
  assert.deepEqual(at({ atBase: false, cargo: load() }), { jobs: [], held: '' });
  assert.deepEqual(ids(at({ atBase: false, point: null, service: { kind: 'repair', until: 106.2, cost: bill(2013), payer: 'truck' } })), ['cancel']);
  // What came out is said as the field answers, by the names of what is dug.
  assert.equal(dumpedText({ dumped: load(0, 0, 4424) }), 'Carga despejada · Sílica 4.424.');
  assert.equal(dumpedText({ dumped: load(600, 0, 0, 250) }), 'Carga despejada · Ferro 600 + Petróleo 250 L.');
});

test('filling up and repairing are no jobs: only the line of why one of them waits, and the repair of the construction in hand', () => {
  const ids = services => services.jobs.map(work => work.id), auto = (unit, stock = bill(60000, 0, 0, 1500), options) => unitServices(unit, founded({ stock }), options),
    worn = { repair: bill(2013), repairSeconds: 9, rearm: bill(1253, 0, 0, 120) };
  // About to be served: nothing to press and nothing to say.
  assert.deepEqual([ids(auto(quoted(worn))), auto(quoted(worn)).held], [[], '']);
  // What keeps the service from coming is said in one line: combat, moving, or what pays being short.
  assert.match(auto(quoted({ ...worn, calm: false })).held, /^Em combate: fique 10 s sem atirar nem ser atingida\.$/);
  assert.equal(auto(quoted({ ...worn, still: false })).held, 'Em movimento: o serviço começa quando a construção parar.');
  assert.equal(auto(quoted({ repair: bill(2013), repairSeconds: 9 }), bill(1500)).held, 'Falta Ferro para o reparo: custa 2.013 e a facção tem 1.500.');
  assert.equal(auto(quoted({ repair: bill(2013), repairSeconds: 9, mend: { cost: bill(1500), seconds: 8 } }), bill(1500)).held, '', 'what pays for part of it mends that part');
  // Filled up as far as the stocks went, what is still missing waits for them.
  const dry = auto(quoted({ rearm: bill(0, 0, 0, 120), point: { supplier: null, stock: null, held: '', resupply: bill() } }), bill(60000));
  assert.deepEqual([ids(dry), dry.held], [[], 'Reposição até completar: Falta Combustível para abastecer: custa 120 L e a facção tem 0 L.']);
  assert.equal(auto(quoted()).held, '', 'a whole one waits for nothing');
  // At base, a stationary manual construction is filled and repaired automatically; cancelled repair is covered above.
  assert.deepEqual(auto(quoted(worn), undefined, { hand: true }), { jobs: [], held: '' });
  assert.equal(auto(quoted({ repair: bill(2013), repairSeconds: 9 }), bill(1500), { hand: true }).held, 'Falta Ferro para o reparo: custa 2.013 e a facção tem 1.500.');
  // Beside a supply vehicle it is the same, with whose supplies are short.
  const beside = point => {
      const { resupply, ...truck } = { supplier: 'truck', stock: bill(3000, 0, 0, 800), held: '', resupply: bill(1253, 0, 0, 120), ...point };
      return quoted({ ...worn, atBase: false, point: { ...truck, resupply }, mender: truck });
    },
    at = (point, options) => auto(beside(point), undefined, { named: () => 'veículo 3', ...options });
  assert.deepEqual(at(), { jobs: [], held: '' });
  assert.equal(at({ stock: bill(1500, 0, 0, 800) }).held, 'Os suprimentos do veículo 3 não pagam o reparo: Ferro 1.500 de 2.013.');
  assert.equal(at({ stock: bill(), resupply: bill() }).held, 'Reposição até completar: Os suprimentos do veículo 3 não pagam a munição e o combustível: Ferro 0 de 1.253 e Combustível 0 de 120 L.');
  assert.equal(at({ held: 'moving' }).held, 'O veículo 3 está em movimento: os suprimentos esperam ele parar.');
  assert.deepEqual(at({}, { hand: true }).jobs.map(work => [work.id, work.text]), [['repair', 'Reparar · Ferro 2.013 · 9 s · suprimentos do veículo 3']]);
  assert.equal(auto(quoted({ atBase: false, mender: null, rearm: bill(0, 0, 0, 20),
    point: { supplier: 'truck', stock: bill(), held: '', resupply: bill() } }), undefined, { named: () => 'veículo 7' }).held,
    'Reposição até completar: Os suprimentos do veículo 7 não pagam o combustível: Combustível 0 de 20 L.');
});

test('a supply vehicle is filled up at its base without asking, and says what it carries', () => {
  const ids = services => services.jobs.map(work => work.id), at = (unit, options) => unitServices(unit, founded(), options);
  // Its supply piece empty or not, in its base there is nothing to ask for, in hand or not.
  const empty = { supplies: bill(), load: bill(8000, 2000, 0, 1064) },
    carrying = { supplies: bill(3000, 0, 0, 800), fill: { solid: 0, liquid: 0, supplies: .56 }, load: bill(5000, 0, 0, 264) };
  for (const unit of [empty, carrying]) assert.deepEqual([ids(at(quoted(unit))), ids(at(quoted(unit), { hand: true }))], [[], []]);
  assert.deepEqual(ids(at(quoted({ ...empty, atBase: false, point: null }))), [], 'and away from it, nothing');
  // What it carries is stock, told by the names of the stocks: in full in its gauge, and how full in its row.
  assert.deepEqual(supplied(load(3000, 20, 5, 800)), bill(3000, 20, 5, 800));
  assert.equal(carriedText(quoted(carrying)), 'Suprimentos: Ferro 3.000 + Combustível 800 L'); assert.equal(carriedText(quoted(empty)), 'Suprimentos: vazios');
  assert.deepEqual(suppliesGauge(quoted(carrying)), { share: .56, low: false, text: 'Ferro 3.000 + Combustível 800 L', title: 'Suprimentos: Ferro 3.000 + Combustível 800 L' });
  assert.deepEqual(suppliesGauge(quoted(empty)), { share: 0, low: true, text: 'vazios · Combustível 0 L', title: 'Suprimentos: vazios' });
  assert.deepEqual(suppliesGauge({ ...quoted(empty), auto: true }), { share: 0, low: false, text: 'vazios · Combustível 0 L', title: 'Suprimentos: vazios' },
    'in automatic it carries nothing but what a job takes');
  assert.equal(cargoText(quoted(carrying)), 'suprimentos 56%'); assert.equal(cargoText(quoted(empty)), 'suprimentos vazios');
  assert.equal(cargoText(quoted({ ...carrying, fill: { solid: 0, liquid: 0, supplies: 1 } })), 'suprimentos cheios');
  assert.equal(cargoText(quoted({ ...carrying, fill: { solid: 0, liquid: 0, supplies: .001 } })), 'suprimentos 1%', 'any of them is told');
  // A hauler that also takes supplies along says both.
  const both = quoted({ ...carrying, cargo: load(4250), fill: { solid: .38, liquid: 0, supplies: .56 } });
  assert.equal(carriedText(both), 'Carga: Ferro 4.250 · 38% · Suprimentos: Ferro 3.000 + Combustível 800 L');
  assert.equal(cargoText(both), 'carga Ferro 4.250 (38%) · suprimentos 56%');
});

test('a paver says what its hopper holds, and what its supply pieces carry besides, which feed it', () => {
  const hopper = { held: bill(0, 0, 5320, 266), fill: 1 }, paver = quoted({ mix: hopper, supplies: bill(0, 0, 6300, 315), fill: { solid: 0, liquid: 0, supplies: 1 } });
  assert.equal(cargoText(paver), 'tremonha Sílica 5.320 + Combustível 266 L (cheia) · suprimentos Sílica 6.300 + Combustível 315 L (cheios)');
  assert.deepEqual(mixGauge(paver), { share: 1, text: 'cheia', title: 'Tremonha: Sílica 5.320 + Combustível 266 L · cheia · Suprimentos: Sílica 6.300 + Combustível 315 L' });
  // Its supply pieces spent, they are told empty; with none, nothing is said of them.
  const spent = quoted({ mix: { held: bill(0, 0, 2800, 140), fill: .53 }, supplies: bill(), fill: { solid: 0, liquid: 0, supplies: 0 } });
  assert.equal(cargoText(spent), 'tremonha Sílica 2.800 + Combustível 140 L (53%) · suprimentos vazios');
  assert.equal(mixGauge(spent).title, 'Tremonha: Sílica 2.800 + Combustível 140 L · 53% · Suprimentos: vazios');
  const bare = quoted({ mix: { held: bill(), fill: 0 }, supplies: null });
  assert.deepEqual([cargoText(bare), mixGauge(bare).title], ['', 'Tremonha: vazia']);
});

test('dismantling is quoted with what the construction carries: its supplies back to the stocks, the load of its hoppers and its cisterns to the yard', () => {
  const supply = quoted({ supplies: bill(3000, 0, 0, 800), fill: { solid: 0, liquid: 0, supplies: .56 } }), hauler = quoted({ cargo: load(900, 0, 40), fill: { solid: .1, liquid: 0, supplies: 0 } });
  assert.deepEqual(dismantleQuote(supply), { refund: bill(24147, 0, 0, 800), cargo: load() });
  assert.deepEqual(dismantleQuote(hauler), { refund: bill(21147), cargo: load(900, 0, 40) });
  // The player is asked with that, of one alone or of several together; a poor faction dismantles too: it costs nothing.
  assert.deepEqual(dismantleQuestion(dismantlePlan([supply])), ['Desmontar este veículo?', 'O veículo sai do campo de vez: Ferro 24.147 + Combustível 800 L de volta aos estoques da facção.', 'Desmontar']);
  assert.deepEqual(dismantleQuestion(dismantlePlan([hauler]))[1], 'O veículo sai do campo de vez: Ferro 21.147 de volta aos estoques da facção e carga Ferro 900 + Sílica 40 no pátio.');
  assert.deepEqual(dismantleQuestion(dismantlePlan([supply, { ...hauler, id: 'lorry' }])).slice(0, 2), ['Desmontar 2 veículos?',
    'Os veículos saem do campo de vez: Ferro 45.294 + Combustível 800 L de volta aos estoques da facção e carga Ferro 900 + Sílica 40 no pátio.']);
  // What was given back is said as the field answers it, in the same words.
  assert.equal(returnedText(dismantleQuote(hauler)), 'Ferro 21.147 de volta aos estoques da facção e carga Ferro 900 + Sílica 40 no pátio');
  assert.equal(returnedText({ refund: bill(24147, 0, 0, 800), cargo: load() }), 'Ferro 24.147 + Combustível 800 L de volta aos estoques da facção');
});

test('a vehicle is dismantled in its base, out of combat and on no cable; a structure wherever it stands; neither while a service holds it', () => {
  assert.deepEqual([dismantleHold(quoted()), dismantleHold(quoted({ atBase: false })), dismantleHold(quoted({ calm: false })), dismantleHold(quoted(), true),
    dismantleHold(quoted({ service: { kind: 'repair' } })), dismantleHold(quoted({ vehicle: false, atBase: false, calm: false })),
    dismantleHold(quoted({ vehicle: false, service: { kind: 'dismantle', progress: .4 } }))],
  ['', 'fora da base', 'em combate', 'no cabo', 'em serviço', '', 'já em desmontagem']);
  // One alone that may not be says what to do about it; several, how many are left out and why.
  const one = patch => dismantlePlan([quoted(patch)]).reason;
  assert.deepEqual([one({ atBase: false }), one({ calm: false }), one({ service: { kind: 'build' } })],
    ['Leve o veículo até a base para desmontá-lo.', 'Em combate: fique 10 s sem atirar nem ser atingida.', 'Aguarde o fim do serviço.']);
  const mixed = dismantlePlan([quoted({ id: 'a' }), quoted({ id: 'post', vehicle: false, atBase: false }), quoted({ id: 'b', atBase: false }), quoted({ id: 'c', atBase: false })]);
  assert.deepEqual([mixed.ids, mixed.vehicles, mixed.structures, mixed.left, mixed.out, mixed.reason], [['a', 'post'], 1, 1, 2, '2 fora da base', '']);
  assert.deepEqual(dismantleQuestion(mixed), ['Desmontar 1 veículo e 1 estrutura?', 'O veículo sai do campo de vez: Ferro 21.147 de volta aos estoques da facção. ' +
    'Um construtor em automático vai até a estrutura e a desmonta no lugar. O material fica num monte ali, que ele mesmo ou um caminhão de suprimentos leva à base. ' +
    'Ficam de fora: 2 fora da base.', 'Desmontar']);
  assert.deepEqual(dismantleQuestion(dismantlePlan([quoted({ vehicle: false }), quoted({ vehicle: false, id: 'other' })])).slice(0, 2), ['Desmontar 2 estruturas?',
    'Construtores em automático vão até as estruturas e as desmontam no lugar. O material fica em montes ali, que eles mesmos ou caminhões de suprimentos levam à base.']);
  assert.equal(dismantlePlan([quoted({ atBase: false }), quoted({ calm: false })]).reason, 'Nenhuma pode ser desmontada agora: 1 fora da base, 1 em combate.');
  // What came of it, in one notice.
  assert.deepEqual([dismantledNews({ vehicles: 3, structures: 1, refused: [] }), dismantledNews({ vehicles: 1, structures: 0, refused: ['Solte o cabo.', 'Outro.'] })],
    ['3 veículos desmontados · 1 estrutura em desmontagem.', '1 veículo desmontado · 2 recusadas: Solte o cabo.']);
});

test('a construction in the air over its base is told to land, and one that rolls through it to stop, before it is dismantled, replaced or repaired there', () => {
  const hurt = { repair: bill(2013), repairSeconds: 9, declined: true }, aloft = quoted({ ...hurt, still: false, aloft: true }), rolling = quoted({ ...hurt, still: false });
  assert.deepEqual([dismantleHold(aloft), dismantleHold(rolling)], ['no ar', 'em movimento']);
  assert.deepEqual([dismantlePlan([aloft]).reason, dismantlePlan([rolling]).reason], ['Pouse na base para desmontar.', 'Pare na base para desmontar.']);
  assert.deepEqual([dismantlePlan([aloft, rolling, quoted({ id: 'b' })]).ids, dismantlePlan([aloft, rolling, quoted({ id: 'b' })]).out], [['b'], '1 no ar, 1 em movimento']);
  const replace = unit => publishQuote({ price: bill(100), faction: founded(), unit, name: 'o tanque' }).replace;
  assert.deepEqual([replace(aloft).disabled, replace(aloft).title, replace(rolling).title, replace(quoted()).disabled],
    [true, 'Pouse na base para substituir.', 'Pare na base para substituir.', false]);
  // A repair asked for waits, switched off, with what to do about it; one that comes by itself says what it waits for.
  const asked = unit => unitServices(unit, founded()).jobs.find(work => work.id === 'repair');
  assert.deepEqual([asked(aloft).disabled, asked(aloft).title, asked(rolling).title, asked(quoted(hurt)).disabled], [true, 'Pouse para reparar.', 'Pare para reparar.', false]);
  assert.deepEqual([unitServices({ ...aloft, declined: false }, founded()), unitServices({ ...rolling, declined: false }, founded())],
    [{ jobs: [], held: 'No ar: o serviço começa quando ela pousar.' }, { jobs: [], held: 'Em movimento: o serviço começa quando a construção parar.' }]);
});

test('a construction says what it carries in its hoppers and its cisterns and how full it is, and a base what waits in its yard', () => {
  assert.equal(carriedText(quoted()), '', 'nothing is said of one that carries nothing'); assert.equal(carriedText(null), '');
  assert.equal(carriedText(quoted({ cargo: load(4250), fill: { solid: .38, liquid: 0 }, loading: 'ferro:3' })), 'Carga: Ferro 4.250 · 38% · carregando');
  assert.equal(carriedText(quoted({ loading: 'ferro:3' })), 'Carga: vazia · carregando', 'before the first step of a load is told');
  assert.equal(carriedText(quoted({ cargo: load(4250, 0, 1500, 800), fill: { solid: .6, liquid: .2 } })), 'Carga: Ferro 4.250 + Sílica 1.500 + Petróleo 800 L · 60%');
  assert.equal(carriedText(quoted({ cargo: load(0, 7000), fill: { solid: 1, liquid: 0 } })), 'Carga: Ligas 7.000 · cheia');
  assert.equal(carriedText(quoted({ cargo: load(0, 0, 0, 3648), fill: { solid: 0, liquid: 1 } })), 'Carga: Petróleo 3.648 L · cheia');
  assert.equal(carriedText(quoted({ cargo: load(900), fill: { solid: .1, liquid: 0 } })), 'Carga: Ferro 900 · 10%');
  assert.equal(yardText(founded()), '', 'an empty yard is not shown'); assert.equal(yardText(null), '');
  assert.equal(yardText(founded({ yard: load(1200, 0, 40, 600) })), 'Pátio: Ferro 1.200 + Sílica 40 + Petróleo 600 L · refinando');
  assert.equal(yardText(founded({ yard: load(1200), base: null })), 'Pátio: Ferro 1.200 · espera uma base', 'with no base there is no refinery');
});

test('publishing is priced against the faction\'s stocks, and replacing against what the old construction gives back', () => {
  const affordable = publishQuote({ price: bill(21148), faction: founded() });
  assert.deepEqual([affordable.spawn.text, affordable.spawn.disabled, affordable.text], ['Fabricar novo veículo', false, ''], 'with nothing in the way, no line says anything');
  assert.deepEqual(affordable.costs, [{ id: 'ferro', text: '21.148', short: false, title: 'Ferro: custa 21.148 · a facção tem 60.000' }], 'only the stocks the design is paid from');
  // It is built for as long as a repair of all its materials would take.
  assert.deepEqual([affordable.seconds, affordable.time], [47, 'Pronta em 47 s: até lá fica na base, sem andar nem atirar.']);
  assert.equal(affordable.replace, null, 'with no construction to replace, replacing is not offered');
  const fuelled = publishQuote({ price: bill(21733, 0, 0, 203), faction: founded() });
  assert.deepEqual(fuelled.costs.map(c => [c.id, c.text, c.short]), [['ferro', '21.733', false], ['combustivel', '203 L', false]]);
  assert.equal(fuelled.seconds, 48, 'fuel is poured in, not built');
  const immediate = publishQuote({ price: bill(21733, 0, 0, 203), faction: founded(), unit: quoted(), instant: true });
  assert.equal(immediate.seconds, 0); assert.deepEqual(immediate.costs, fuelled.costs);
  assert.match(immediate.time, /instantânea/); assert.match(immediate.replace.text, /0 s$/);
  assert.equal(publishQuote({ price: bill(100461), faction: founded(), instant: true }).spawn.disabled, true, 'test speed does not pay for materials');
  assert.equal(publishQuote({ price: bill(100), faction: founded(), unit: quoted({ vehicle: false }), name: '1. Posto' }).replace, null, 'a structure is never replaced');

  // The construction to be replaced is named: the player sees which one goes.
  const dear = publishQuote({ price: bill(100461), faction: founded(), unit: quoted(), name: '2. Morteiro' });
  assert.equal(dear.spawn.disabled, true); assert.equal(dear.costs[0].short, true, 'the stock that is short is marked'); assert.equal(dear.unpaid, true, 'the stocks alone stand in the way: the garage has models they pay');
  assert.equal(affordable.unpaid, false);
  assert.equal(dear.spawn.title, 'Falta Ferro para fabricar um novo veículo: custa 100.461 e a facção tem 60.000. Falta completar: Ferro 40.461.'); assert.equal(dear.text, dear.spawn.title);
  assert.equal(dear.replace.disabled, true, '100 461 less 21 147 is still more than 60 000');
  assert.equal(dear.replace.text, 'Substituir 2. Morteiro · Ferro 79.314 · 164 s', 'built for what it pays');

  const named = { unit: quoted(), name: '1. Batedor' };
  // A design with no command post is published neither way, whatever the stocks pay: the one line says why.
  const headless = publishQuote({ price: bill(20000), faction: founded(), commanded: false, ...named });
  assert.equal(publishQuote({ price: bill(100461), faction: founded(), commanded: false }).unpaid, false, 'a design with no command post is not helped by another stock');
  assert.deepEqual([headless.spawn.disabled, headless.spawn.title, headless.replace.disabled, headless.replace.title], [true, UNCOMMANDED, true, UNCOMMANDED]);
  assert.equal(headless.text, UNCOMMANDED);
  // Nor by a faction with no base: there is nowhere to make it.
  const unbased = publishQuote({ price: bill(20000), faction: founded({ base: null, count: 0, counts: { vehicles: 0, fixed: 0 }, units: [] }) });
  assert.deepEqual([unbased.spawn.disabled, unbased.spawn.title, unbased.text, unbased.unpaid], [true, UNBASED, UNBASED, false]);
  const swap = publishQuote({ price: bill(100461), faction: founded({ stock: bill(79314) }), ...named });
  assert.equal(swap.spawn.disabled, true); assert.equal(swap.replace.disabled, false, 'the old construction pays part of the new one');
  assert.equal(swap.unpaid, false, 'the replacement is affordable without suggesting another model');
  assert.equal(swap.text, '', 'only the new-unit button carries its stock refusal');
  assert.match(swap.spawn.title, /^Falta Ferro para fabricar um novo veículo:/);
  assert.match(swap.replace.title, /Pronta em 164 s\.$/, 'the available action says when it finishes');
  const cheaper = publishQuote({ price: bill(20000), faction: founded({ stock: bill() }), ...named });
  assert.deepEqual([cheaper.replace.text, cheaper.replace.disabled], ['Substituir 1. Batedor · devolve Ferro 1.147 · 5 s', false], 'a cheaper design gives iron back');
  assert.equal(cheaper.spawn.disabled, true); assert.equal(cheaper.unpaid, false, 'replacing can even be free when the faction has no stock');
  assert.equal(publishQuote({ price: bill(21147), faction: founded(), ...named }).replace.text, 'Substituir 1. Batedor · sem custo · 5 s');
  // A replacement the stocks pay — for nothing, or for what the faction has — is no shortage, whatever a new one would cost:
  // nothing says the stocks lack anything, though fabricating one says why it cannot be done.
  for (const [price, stock] of [[bill(21147), bill()], [bill(100461), bill(79314)]]) {
    const even = publishQuote({ price, faction: founded({ stock }), ...named });
    assert.deepEqual([even.replace.disabled, even.text, even.unpaid, even.costs.map(c => c.short)], [false, '', false, [false]]);
    assert.deepEqual([even.spawn.disabled, even.spawn.title], [true, shortText(stock, price, 'fabricar um novo veículo') + ' Falta completar: Ferro 21.147.']);
  }

  // A design with plates of titanium and of ceramic asks for stocks a new faction does not have.
  const plated = publishQuote({ price: bill(20000, 3000, 500), faction: founded(), ...named });
  assert.deepEqual(plated.costs.map(c => [c.text, c.short]), [['20.000', false], ['3.000', true], ['500', true]]); assert.equal(plated.spawn.disabled, true);
  assert.equal(plated.spawn.title, 'Faltam Ligas e Sílica para fabricar um novo veículo: Ligas custa 3.000 e a facção tem 0; Sílica custa 500 e a facção tem 0. Falta completar: Ligas 3.000 + Sílica 500.');
  assert.equal(plated.replace.text, 'Substituir 1. Batedor · Ligas 3.000 + Sílica 500 · devolve Ferro 1.147 · 12 s');
  assert.equal(plated.replace.disabled, true, 'the iron the old one gives back buys no alloys'); assert.match(plated.replace.title, /^Faltam Ligas e Sílica para substituir este veículo/);
  const stocked = publishQuote({ price: bill(20000, 3000, 500), faction: founded({ stock: bill(20000, 3000, 500) }) });
  assert.equal(stocked.spawn.disabled, false); assert.deepEqual(stocked.costs.map(c => c.short), [false, false, false], 'what the faction has exactly pays');
  // The fuel in the tank of a design is paid in fuel: iron does not buy it, and the fuel left in the old one pays for that of the new.
  const dry = publishQuote({ price: bill(21733, 0, 0, 203), faction: founded({ stock: bill(60000, 0, 0, 150) }), unit: quoted({ value: bill(21147, 0, 0, 180) }), name: '1. Batedor' });
  assert.deepEqual([dry.spawn.disabled, dry.spawn.title], [true, 'Falta Combustível para fabricar um novo veículo: custa 203 L e a facção tem 150 L. Falta completar: Combustível 53 L.']);
  assert.deepEqual([dry.replace.text, dry.replace.disabled], ['Substituir 1. Batedor · Ferro 586 + Combustível 23 L · 6 s', false]);
  assert.equal(dry.unpaid, false, 'the fuel recovered from the old design makes replacement available without a stock warning');

  const fullFleet = founded({ count: CONSTRUCTION_LIMITS.vehicles, counts: { vehicles: CONSTRUCTION_LIMITS.vehicles, fixed: 0 } });
  assert.equal(publishQuote({ price: bill(100), faction: fullFleet }).spawn.title, 'Limite: 12 veículos por facção.');
  const atLimit = publishQuote({ price: bill(100), faction: fullFleet, ...named });
  assert.equal(atLimit.spawn.disabled, true); assert.equal(atLimit.replace.disabled, false, 'the cap does not prevent replacing one owned construction');
  assert.match(publishQuote({ price: bill(100), faction: founded(), unit: quoted({ atBase: false }), name: '1. Batedor' }).replace.title, /^Fora da base/);
  assert.match(publishQuote({ price: bill(100), faction: founded(), unit: quoted({ calm: false }), name: '1. Batedor' }).replace.title, /^Em combate/);
  const offline = publishQuote({ price: bill(100), faction: founded(), ...named, connected: false });
  assert.equal(offline.spawn.disabled && offline.replace.disabled, true); assert.equal(offline.text, 'Aguarde a conexão com o campo.');
  const none = publishQuote({ price: bill(100), faction: null });
  assert.deepEqual([none.spawn.disabled, none.replace, none.text], [true, null, 'Aguarde a conexão com o campo.']);
  assert.deepEqual([none.costs, none.seconds], [[{ id: 'ferro', text: '100', short: false, title: 'Ferro: 100' }], 5], 'what it asks is told before the stocks are');

  assert.equal(publishedText({ cost: bill(21148), seconds: 47 }, false), 'Fabricação iniciada na base · Ferro 21.148 · pronta em 47 s.');
  assert.equal(publishedText({ cost: bill(-1147, 3000), seconds: 11 }, true), 'Substituição iniciada na base · Ligas 3.000 · devolve Ferro 1.147 · pronta em 11 s.');
  assert.equal(publishedText({ cost: bill(), seconds: 5 }, true), 'Substituição iniciada na base · sem custo · pronta em 5 s.');
  assert.equal(publishedText({ cost: bill(), seconds: 0, relocated: { from: 100, to: 112 } }, true),
    'Substituição concluída na base · sem custo · pronta. Posição ajustada em 12 m para caber na base.');
});

test('vehicles and structures have separate slots, and a vehicle replaced takes no extra one, even above its quota', () => {
  const full = { ...CONSTRUCTION_LIMITS }, price = bill(100);
  for (const used of [full.vehicles, full.vehicles + 3]) {
    const counts = { ...full, vehicles: used }, faction = founded({ count: counts.vehicles + counts.fixed, counts }),
      unit = quoted(), before = structuredClone({ faction, unit }), same = publishQuote({ price, faction, unit });
    assert.deepEqual([same.spawn.disabled, same.spawn.title, same.text], [true, 'Limite: 12 veículos por facção.', 'Limite: 12 veículos por facção.']);
    assert.equal(same.replace.disabled, false, `a replacement consumes no extra slot at ${used}`);
    assert.deepEqual({ faction, unit }, before);
  }
  const room = (kind, patch = {}) => { const counts = { ...full, [kind]: full[kind] - 1 }; return founded({ count: counts.vehicles + counts.fixed, counts, ...patch }); };
  assert.deepEqual([publishQuote({ price, faction: room('vehicles') }).spawn.disabled, obraQuote({ price, faction: room('fixed') }).spawn.disabled], [false, false],
    'a full quota of the other kind blocks neither');
  // A works counts as a structure from when it is opened: past the limit none is opened, though one already standing may move.
  const fixed = founded({ counts: { vehicles: 0, fixed: full.fixed } }), opened = obraQuote({ price, faction: fixed }), moved = obraQuote({ price, faction: fixed, moving: true, value: price });
  assert.deepEqual([opened.spawn.disabled, opened.spawn.title, moved.spawn.disabled, moved.spawn.text], [true, 'Limite: 32 estruturas por facção.', false, 'Mudar para cá']);
});

test('a structure is a works opened on the field for nothing, whatever the stocks lack now, and never replaces anything', () => {
  const quote = obraQuote({ price: bill(46784, 0, 2000), faction: founded({ stock: bill(60000) }) });
  assert.deepEqual([quote.spawn.text, quote.spawn.disabled, quote.text, quote.unpaid, quote.replace], ['Escolher local no campo', false, '', false, null]);
  assert.deepEqual(quote.costs.map(cost => [cost.id, cost.text, cost.short]), [['ferro', '46.784', false], ['silica', '2.000', true]], 'what the stocks lack is only marked');
  assert.equal(quote.costs[1].title, 'Sílica: custa 2.000 · no estoque 0');
  assert.deepEqual(quote.costs.map(cost => cost.missing), [undefined, '2.000'], 'how much a stock lacks is told of that stock alone');
  assert.match(quote.spawn.title, /^Abrir a obra não custa nada/); assert.match(quote.time, /braço construtor/);
  const immediate = obraQuote({ price: bill(46784, 0, 2000), faction: founded({ stock: bill(60000, 0, 2000) }), instant: true });
  assert.equal(immediate.seconds, 0); assert.equal(immediate.spawn.disabled, false); assert.match(immediate.spawn.title, /Paga o custo completo/);
  assert.equal(obraQuote({ price: bill(46784, 0, 2000), faction: founded({ stock: bill(60000) }), instant: true }).spawn.disabled, true,
    'an instant structure must pay its materials immediately');
  assert(obraQuote({ price: bill(46784, 0, 2000), faction: founded({ stock: bill(60000) }), instant: true, moving: true, value: bill(46784, 0, 2000) }).seconds > 0,
    'moving a structure keeps its ordinary works');
  for (const [faction, options, reason] of [[null, {}, 'Aguarde a conexão com o campo.'], [founded(), { connected: false }, 'Aguarde a conexão com o campo.'],
    [founded(), { commanded: false }, UNCOMMANDED], [founded({ base: null }), {}, UNBASED], [founded(), { admissionReason: 'Ajuste o casco.' }, 'Ajuste o casco.']]) {
    const refused = obraQuote({ price: bill(100), faction, ...options });
    assert.deepEqual([refused.spawn.disabled, refused.spawn.title, refused.text], [true, reason, reason]);
  }
  assert.equal(obraQuote({ price: bill(100), faction: founded({ base: null }), moving: true, value: bill(100) }).spawn.disabled, false, 'a structure moves where its faction has no base');
  // An intact structure gives all of its price back, leaving only the new footing to supply.
  const footing = bill(0, 0, 2811), footed = obraQuote({ price: bill(46784, 0, 2000), footing, faction: founded({ stock: bill(60000, 0, 4000) }) }),
    moved = obraQuote({ price: bill(46784, 0, 2000), footing, faction: founded({ stock: bill(60000, 0, 4000) }), moving: true, value: bill(46784, 0, 2000) });
  assert.deepEqual(footed.costs.map(cost => [cost.id, cost.text, cost.short]), [['ferro', '46.784', false], ['silica', '4.811', true]]);
  assert.deepEqual(moved.costs.map(cost => [cost.id, cost.text, cost.short]), [['silica', '2.811', false]]);
  assert.deepEqual([footed.seconds, moved.seconds], [buildSeconds(bill(46784, 0, 4811)), buildSeconds(bill(46784, 0, 4811))]);
});

test('moving quotes replacement of damage and spent reserves plus the new footing, without charging on opening', () => {
  const input = { price: bill(100, 0, 0, 20), footing: bill(0, 0, 5), faction: founded({ stock: bill(40, 0, 5) }),
    moving: true, value: bill(54, 0, 0, 12) }, before = structuredClone(input), moved = obraQuote(input);
  assert.deepEqual(moved.costs.map(cost => [cost.id, cost.text, cost.short]), [['ferro', '46', true], ['silica', '5', false], ['combustivel', '8 L', true]]);
  assert.equal(moved.spawn.disabled, false, 'opening a works pays nothing and shortages do not prohibit it');
  assert.match(moved.spawn.title, /danos e reservas gastas/);
  assert.equal(moved.seconds, buildSeconds(bill(100, 0, 5, 20)), 'the full new construction still has to be assembled');
  assert.deepEqual(input, before, 'the quote changes neither stock nor the returned material');
  assert.deepEqual(obraQuote({ ...input, value: bill(120, 0, 0, 30) }).costs.map(cost => cost.id), ['silica'], 'a surplus is not a negative debit');
  const waiting = obraQuote({ ...input, value: null });
  assert.equal(waiting.spawn.disabled, true); assert.equal(waiting.text, 'Aguarde o valor atual da estrutura.');
});

test('a blocked replacement never hides the new vehicle shortage and publishing names the exact missing stocks', () => {
  const price = bill(9495, 91150, 275, 203), stock = bill(290145, 85918, 129135, 126720), faction = founded({ stock }),
    value = bill(4000, 6000, 0, 100), before = structuredClone({ price, faction, value });
  for (const [patch, reason] of [[{ atBase: false }, /^Fora da base/], [{ calm: false }, /^Em combate/], [{ service: { kind: 'repair' } }, /^Em reparo/]]) {
    const quote = publishQuote({ price, faction, unit: quoted({ value, ...patch }), name: '1. Caminhão' });
    assert.equal(quote.spawn.disabled, true); assert.equal(quote.replace.disabled, true);
    assert.match(quote.replace.title, reason, 'replacing keeps its own active impediment');
    assert.match(quote.text, /^Falta Ligas para fabricar um novo veículo:/);
    assert.match(quote.text, /custa 91\.150 e a facção tem 85\.918/);
    assert.match(quote.text, /Falta completar: Ligas 5\.232\./);
    assert.equal(quote.costs.find(cost => cost.id === 'ligas').short, true);
  }
  const available = publishQuote({ price, faction, unit: quoted({ value }), name: '1. Caminhão' });
  assert.equal(available.replace.disabled, false); assert.equal(available.text, '', 'a usable replacement still needs no general warning');
  assert.match(available.spawn.title, /Falta completar: Ligas 5\.232\./);
  const partial = publishQuote({ price: bill(1000, 10000, 0, 203), faction: founded({ stock: bill(5000, 9000, 0, 100) }),
    unit: quoted({ value: bill(1000, 200, 0, 10) }), name: '1. Caminhão' });
  assert.equal(partial.replace.disabled, true);
  assert.match(partial.replace.title, /Falta completar: Ligas 800 \+ Combustível 93 L\./, 'replacement deficits use its discounted price, stock by stock');
  assert.deepEqual({ price, faction, value }, before);
});

test('a works and a heap of the faction are told by their cards, and a structure taken down by how far that has gone', () => {
  const work = { id: 'c4', name: 'Posto de defesa leve', x: 1534, facing: 1, cost: bill(4216), delivered: bill(1686), progress: .25, share: .4, seconds: 13,
      building: false, waiting: false, supplying: false, blocked: '', from: null, lack: bill() },
    rows = list => workRows(founded({ works: list })), [plain] = rows([work]);
  assert.deepEqual([plain.id, plain.name, plain.x, plain.share, plain.cancel.text], ['c4', 'Obra · Posto de defesa leve', 1534, .25, 'Cancelar obra']);
  assert.deepEqual(plain.lines, ['Montada 25%', 'Chegou 40% do material', 'Aguardando um braço construtor trabalhar a até 7 m', 'Falta entregar à obra: Ferro 2.530', 'A 300 m → da base']);
  const [busy] = rows([{ ...work, delivered: work.cost, share: 1, progress: .7, building: true, supplying: true, lack: bill(), from: 'c2' }]);
  assert.deepEqual(busy.lines, ['Montada 70%', 'Todo o material chegou', 'Braço construtor montando', 'Suprimentos descarregando',
    'Mudança de lugar de uma estrutura', 'A 300 m → da base']);
  assert.equal(rows([{ ...work, waiting: true }])[0].lines[2], 'Braço construtor esperando material');
  // The builder the dispatch sent to it: on its way, waiting to go, beside it, or first taking down what it is moved from.
  assert.deepEqual([{ phase: 'go', reason: '' }, { phase: 'go', reason: 'waiting-fuel' }, { phase: 'work', reason: '' }, { phase: 'dismantle', reason: '' }]
    .map(sent => rows([{ ...work, sent }])[0].lines[2]),
  ['Construtor a caminho', 'Construtor aguardando combustível para a viagem', 'Construtor ao lado', 'Construtor desmontando a estrutura antes']);
  assert.equal(rows([{ ...work, progress: 1, share: 1, blocked: 'Limite: 32 estruturas por facção.' }])[0].lines[2], 'Limite: 32 estruturas por facção.', 'why one all put up waits');
  assert.deepEqual(workRows(founded({ base: null, works: [work] }))[0].lines, plain.lines.slice(0, -1), 'with no base, nothing is told from it');
  const [heap] = heapRows(founded({ heaps: [{ id: 'c2', x: 3234, stock: bill(4216) }] }));
  assert.deepEqual([heap.id, heap.name, heap.x, heap.lines[0], heap.lines.at(-1)], ['c2', 'Material', 3234, 'Ferro 4.216', 'A 2 km → da base']);
  assert.match(heap.lines[1], /caminhão de suprimentos parado ao lado carrega/);
  assert.deepEqual([abandonedText({ cancelled: 'c4', heap: { id: 'c4', stock: bill(10) } }), abandonedText({ cancelled: 'c4', heap: null })],
    ['Obra cancelada: o material que chegou ficou no local.', 'Obra cancelada.']);
  // Taken down, a structure has nothing to ask of a point: its own block says how far that has gone.
  const down = quoted({ vehicle: false, service: { kind: 'dismantle', progress: .456, seconds: 13, to: null, building: true } });
  assert.deepEqual(unitServices(down, founded()), { jobs: [], held: '' });
  assert.equal(serviceText(down.service, 0), 'desmontando · 45%');
});

test('a works distinguishes what remains to deliver from what the base lacks, including refined fuel', () => {
  const work = { id: 'well', name: 'Poço de petróleo', x: 1600, cost: bill(1000, 0, 0, 20), delivered: bill(600),
      progress: .4, share: .4, lack: bill(100), waiting: true },
    [shown] = workRows(founded({ works: [work] }));
  assert(shown.lines.includes('Falta entregar à obra: Ferro 400 + Combustível 20 L'));
  assert(shown.lines.includes('Falta no estoque da base: Ferro 100'));
  const [delivered] = workRows(founded({ works: [{ ...work, delivered: work.cost, share: 1, lack: bill() }] }));
  assert(!delivered.lines.some(line => line.startsWith('Falta entregar')));
});

test('a road asked for is told by its card: how far it is graded and paved, which machine is at it, and where it is', () => {
  const road = { id: 'r1', x0: 1500, x1: 1600, kind: 'asphalt', graded: .456, paved: .1, working: [], coming: false },
    rows = list => roadRows(founded({ roadworks: list })), [asphalt] = rows([road]);
  assert.deepEqual([asphalt.id, asphalt.name, asphalt.x, asphalt.x0, asphalt.x1, asphalt.share, asphalt.cancel.text, asphalt.cancel.question],
    ['r1', 'Estrada · Asfalto', 1550, 1500, 1600, (.456 + .1) / 2, 'Cancelar estrada', 'Cancelar esta estrada?']);
  assert.deepEqual(asphalt.lines, ['100 m · nivelada 45% · asfaltada 10%', 'Esperando uma máquina de estrada em automático', 'A 316 m → da base']);
  assert.deepEqual(rows([{ ...road, working: ['grade', 'pave'] }])[0].lines[1], 'Niveladora trabalhando · Pavimentadora trabalhando');
  assert.deepEqual(rows([{ ...road, coming: true }])[0].lines[1], 'Máquina de estrada a caminho');
  const [earth] = rows([{ ...road, kind: 'graded', paved: 0, working: ['grade'] }]);
  assert.deepEqual([earth.name, earth.share, earth.lines], ['Estrada · Terra batida', .456, ['100 m · nivelada 45%', 'Niveladora trabalhando', 'A 316 m → da base']]);
  assert.deepEqual(rows(undefined), [], 'a faction told of no roads has none');
});

test('a job says what it does and what for, named as the faction knows it, and why it waits', () => {
  const names = { c3: 'veículo 3', c4: 'Posto de defesa leve', c5: 'Bunker' },
    said = (kind, phase, targetId, reason = '', unit = {}) => jobText({ auto: true, supplies: bill(10), job: { kind, phase, targetId, reason }, ...unit }, { name: id => names[id] ?? '' });
  assert.deepEqual([said('work', 'collect', 'c4'), said('work', 'fetch', 'c4'), said('work', 'deliver', 'c4'), said('work', 'deliver', 'c9'), said('heap', 'collect', 'c8'), said('heap', 'fetch', 'c8')],
    ['buscando material para a obra Posto de defesa leve', 'buscando material para a obra Posto de defesa leve', 'levando material para a obra Posto de defesa leve',
      'levando material para uma obra', 'buscando o material de um monte', 'buscando o material de um monte']);
  assert.deepEqual([said('rearm', 'collect', 'c3'), said('rearm', 'deliver', 'c3'), said('rearm', 'deliver', 'c3', 'target-moving'), said(null, 'idle', null, 'waiting-dismantle'),
    said('work', 'collect', 'c4', 'waiting-stock'), said(null, 'idle', null), said(null, 'idle', 'c4', 'waiting-stock')],
    ['buscando suprimentos na base', 'levando suprimentos ao veículo 3', 'aguardando o veículo 3 parar', 'aguardando a desmontagem para levar o material',
      'aguardando estoque na base · Posto de defesa leve', 'aguardando trabalho', 'aguardando estoque na base · Posto de defesa leve']);
  // A builder goes to put up a works, by the base where it loads there, or to take a structure down, and waits by it for material.
  assert.deepEqual([said('build', 'collect', 'c4'), said('build', 'go', 'c4'), said('build', 'go', 'c4', 'waiting-fuel'), said('build', 'go', 'c4', 'blocked-way'), said('build', 'work', 'c4'),
    said('build', 'work', 'c4', 'waiting-material'), said('dismantle', 'go', 'c5'), said('dismantle', 'work', 'c5'), said('dismantle', 'load', 'c5')],
    ['indo à obra Posto de defesa leve pela base', 'indo à obra Posto de defesa leve', 'aguardando combustível para a viagem · Posto de defesa leve',
      'caminho bloqueado · Posto de defesa leve', 'aguardando para montar Posto de defesa leve', 'aguardando material · Posto de defesa leve',
      'indo desmontar Bunker', 'aguardando para desmontar Bunker', 'carregando o material desmontado']);
  assert.deepEqual([said('build', 'work', 'c4', '', { builder: { working: 'c4' } }), said('dismantle', 'work', 'c5', '', { builder: { working: 'c5' } })],
    ['montando Posto de defesa leve', 'desmontando Bunker']);
  assert.equal(said('dismantle', 'work', 'c5', '', { builder: { working: 'c4' }, tools: { limit: 'engine' } }), 'aguardando para desmontar Bunker',
    'a dispatch phase or activity at another target does not claim work here');
  // On its way home, with what it carries or not; held by the player, only by what: in automatic, an order it carries out first or the
  // player's hands, and out of it, Stop or the player's hands.
  assert.deepEqual([said(null, 'return', null), said(null, 'return', null, 'threat', { supplies: bill() }), said(null, 'return', null, '', { atBase: true }),
    said(null, 'paused', null, 'manual-order', { auto: false }), said(null, 'paused', null, '', { auto: false }), jobText({ auto: true }),
    said(null, 'paused', null, 'manual-order'), said(null, 'paused', null, 'manual-control'), said(null, 'paused', null, 'manual-control', { auto: false })],
    ['voltando à base com a carga restante', 'voltando à base · risco de combate', 'devolvendo suprimentos na base', 'desligado pela ordem Parar', '', '',
      'pausado · cumprindo sua ordem', 'pausado · sob seu controle', 'sob seu controle']);
  // A job whose place its faction holds dangerous: given to nobody, it is what one has nothing to do for; one on its way to it
  // turns home for it, and says so, with what it carries or not.
  assert.deepEqual([said(null, 'idle', 'c4', 'danger'), said(null, 'return', null, 'danger'), said(null, 'return', null, 'danger', { supplies: bill() })],
    ['destino perigoso · Posto de defesa leve', 'voltando à base com a carga restante · destino perigoso', 'voltando à base · destino perigoso']);
  assert.match(jobAdvice({ auto: true, job: { kind: null, phase: 'return', targetId: null, reason: 'danger' } }), /território de outra facção.*dê a ordem você mesmo/);
  // A road machine goes to a road, grades or paves it, fetches what it paves with at the base, or waits for the road to be graded.
  assert.deepEqual([said('grade', 'go', 'r1'), said('grade', 'work', 'r1'), said('pave', 'work', 'r1'), said('pave', 'collect', 'r1'), said('pave', 'go', 'r1', 'waiting-fuel'),
    said(null, 'idle', null, 'waiting-grade')],
    ['indo à estrada', 'nivelando a estrada', 'asfaltando a estrada', 'buscando material na base para a estrada', 'aguardando combustível para a viagem',
      'aguardando o nivelamento']);
});

test('wrecks are listed by the time they have left, with where they are from the base, what they give and what they carry', () => {
  const faction = founded({ wrecks: [
    { id: 'b', name: 'Morteiro', x: 900, until: 400, value: bill(7000), cargo: load(), inReach: false },
    { id: 'a', name: 'Batedor', x: 1500, until: 221.5, value: bill(5300, 0, 0, 180), cargo: load(), inReach: true }] });
  const [first, second] = wreckRows(faction, 100);
  assert.deepEqual(first, { id: 'a', name: 'Batedor', x: 1500, seconds: 122, inReach: true, calmIn: 0, stripped: false, cargo: load(),
    where: 'a 266 m → da base', until: 'somem em 2:02', lines: ['Vale Ferro 5.300 + Combustível 180 L', 'A 266 m → da base · somem em 2:02'],
    work: { text: 'Desmontar', icon: 'i-repair', title: 'O que resta dos destroços vai para os estoques da facção.' }, hint: 'Selecione sua construção ao lado deles para desmontá-los.' });
  // One out of reach says what would bring a construction to work on it.
  assert.deepEqual([second.id, second.lines, second.inReach], ['b', ['Vale Ferro 7.000', 'A 334 m ← da base · somem em 5:00'], false]);
  assert.equal(second.hint, `Para desmontá-los, leve uma construção sua, fora de combate, a menos de ${SALVAGE_REACH} m.`);
  // One by a construction of the player still in combat says how long until it may be dismantled.
  const [waiting] = wreckRows(founded({ wrecks: [faction.wrecks[0], { ...faction.wrecks[1], inReach: false, calmIn: 7 }] }), 100);
  assert.deepEqual([waiting.calmIn, waiting.hint], [7, 'Em combate: desmonte em 7 s.']);
  assert.equal(wreckRows(faction, 9999)[0].seconds, 0);
  assert.deepEqual(wreckRows(null, 0), []); assert.deepEqual(wreckRows(founded(), 0), []);
  // With no base, there is nothing to tell how far from.
  assert.deepEqual(wreckRows({ ...faction, base: null }, 100).map(w => [w.where, w.lines.at(-1)]), [['', 'Somem em 2:02'], ['', 'Somem em 5:00']]);
  // A hauler that was destroyed still carries its load; once dismantled, a wreck is nothing but what did not fit, taken up
  // by whoever has a hopper or a cistern for it.
  const [truck, husk] = wreckRows(founded({ wrecks: [
    { id: 'c', name: 'Transporte', x: 1400, until: 300, value: bill(9000, 400), cargo: load(18000, 0, 2500, 900), inReach: true },
    { id: 'd', name: 'Transporte', x: 1410, until: 310, value: bill(), cargo: load(0, 6000), inReach: true }] }), 100);
  assert.deepEqual(truck.lines, ['Vale Ferro 9.000 + Ligas 400', 'Carga Ferro 18.000 + Sílica 2.500 + Petróleo 900 L', 'A 166 m → da base · somem em 3:20']);
  assert.equal(truck.work.text, 'Desmontar'); assert.match(truck.work.title, /caçambas e cisternas das suas construções ao lado/);
  assert.deepEqual([husk.stripped, husk.lines, husk.work.text, husk.hint], [true, ['Carga Ligas 6.000', 'A 176 m → da base · somem em 3:30'], 'Recolher a carga',
    'Selecione seu veículo com caçamba ou cisterna ao lado deles para recolher a carga.']);
  assert.equal(wreckRows(founded({ wrecks: [{ ...faction.wrecks[1], value: bill(), cargo: load(0, 6000), inReach: false }] }), 100)[0].hint,
    `Para recolher a carga, leve um veículo com caçamba ou cisterna, fora de combate, a menos de ${SALVAGE_REACH} m.`);
  assert.equal(salvagedText({ value: bill(9000, 400), cargo: load(12000), left: load(6000, 0, 2500, 900) }),
    'Destroços desmontados · Ferro 9.000 + Ligas 400 para a facção · carga recolhida: Ferro 12.000 · leve-a à base · ficaram nos destroços: Ferro 6.000 + Sílica 2.500 + Petróleo 900 L.');
  assert.equal(salvagedText({ value: bill(5300), cargo: load(), left: load() }), 'Destroços desmontados · Ferro 5.300 para a facção.');
  assert.equal(salvagedText({ value: bill(), cargo: load(0, 6000), left: load() }), 'Destroços desmontados · carga recolhida: Ligas 6.000 · leve-a à base.');
  assert.equal(salvagedText({ value: bill(5300), cargo: load(), left: load(0, 0, 0, 900) }), 'Destroços desmontados · Ferro 5.300 para a facção · ficaram nos destroços: Petróleo 900 L.');
});

test('the veins a faction knows are those it was told of, at the sites of the ground: each with its card, marked on the overview and over the field', () => {
  // The sites of the ground, as the page grows them from the seed: which of them hold a vein it knows from the faction alone.
  const ground = [
    { id: 'ferro:1', x: 800, material: 'ferro', feature: 'outcrop', reserve: 62000 },
    { id: 'ferro:2', x: 1300, material: 'ferro', feature: 'ruins', reserve: 63000 },
    { id: 'ligas:2', x: 1450, material: 'ligas', feature: 'talus', reserve: 63500 },
    { id: 'ferro:3', x: 1900, material: 'ferro', feature: 'outcrop', reserve: 65000 },
    { id: 'petroleo:4', x: 2400, material: 'petroleo', feature: 'lowland', reserve: 66000 },
    { id: 'ferro:5', x: 3100, material: 'ferro', feature: 'outcrop', reserve: 69000 },
    { id: 'silica:9', x: 5600, material: 'silica', feature: 'dune', reserve: 77000 },
    { id: 'ligas:7', x: 7000, material: 'ligas', feature: 'talus', reserve: 80000 },
    { id: 'ferro:8', x: 7400, material: 'ferro', feature: 'ruins', reserve: 81000 }];
  // A vein as the faction is told of it: in sight, whole and dug, unless told otherwise.
  const vein = (id, more = {}) => ({ id, left: ground.find(site => site.id === id).reserve, at: null, seen: true, loading: false, active: true, ...more }),
    told = [vein('ferro:1'), vein('ferro:2', { active: false }), vein('ligas:2', { at: 1200, seen: false }), vein('ferro:3', { left: 41000 }),
      vein('petroleo:4', { at: 1900, seen: false }), vein('ferro:5'), vein('silica:9')], faction = founded({ deposits: told });
  const veins = knownVeins(ground, faction);
  assert.deepEqual(veins.map(v => v.id), ['ferro:1', 'ferro:2', 'ligas:2', 'ferro:3', 'petroleo:4', 'ferro:5', 'silica:9'], 'of the two sites it was told nothing of, nothing');
  assert.deepEqual(veins[3], { id: 'ferro:3', x: 1900, material: 'ferro', feature: 'outcrop', reserve: 65000, left: 41000, at: null, seen: true, loading: false, active: true });
  assert.equal(knownVeins(ground, faction), veins, 'made once for each telling of the faction'); assert.notEqual(knownVeins(ground, founded({ deposits: [...told] })), veins);
  // A faction that knows none, a page with no faction yet, and a vein told at a site the ground at hand has not.
  assert.deepEqual([knownVeins(ground, founded()), knownVeins(ground, null), knownVeins(ground, founded({ deposits: [{ ...vein('ferro:1'), id: 'ferro:99' }] }))], [[], [], []]);
  const one = knownVeins(ground, founded({ deposits: [vein('ferro:8', { left: 30000, at: 40, seen: false })] })); assert.deepEqual(one.map(v => [v.id, v.x, v.left]), [['ferro:8', 7400, 30000]]);
  // The card of each, by its mark over the field: its material and ground, what was left of it when last seen — with a bar
  // of its share —, what is ready there and where it is from the base, at 1 234 m; out of sight, how long ago it was seen.
  const rows = veinRows(veins, base.x, 2000);
  assert.deepEqual(rows.map(r => r.id), veins.map(v => v.id), 'every vein known');
  assert.deepEqual(rows[3], { id: 'ferro:3', x: 1900, material: 'ferro', name: 'Ferro · afloramento', share: 41000 / 65000,
    lines: ['Reserva 41 t de 65 t', 'Pronto 0 kg', 'A 666 m → da base'] });
  assert.deepEqual([rows[2].name, rows[2].lines.at(-1)], ['Ligas · cascalheira', 'A 216 m → da base · vista há 13 min'], 'out of sight, it says how long ago it was seen');
  // One its base stills is not dug: its card says so, with no bar.
  assert.deepEqual([rows[1].share, rows[1].lines], [null, ['Junto de uma base: ali não se extrai nada.', 'A 66 m → da base']]);
  assert.deepEqual([rows[4].name, rows[4].lines], ['Petróleo · baixada alagada', ['Reserva 66.000 L de 66.000 L', 'Pronto 0 L', 'A 1,2 km → da base · vista há 1 min']],
    'petroleum is told by the litre');
  assert.equal(veinRows(veins, base.x, 1925)[4].lines.at(-1), 'A 1,2 km → da base · vista há 25 s');
  // What is being done there is said by what is ready.
  const busy = veinRows(knownVeins(ground, founded({ deposits: told.map(v => v.id === 'ferro:5' ? { ...v, left: 12000, loading: true } :
    v.id === 'silica:9' ? { ...v, extracting: true } : v) })), base.x, 2000);
  assert.deepEqual([busy[5].lines, busy[6].lines[1]], [['Reserva 12 t de 69 t', 'Pronto 0 kg · carregando', 'A 1,9 km → da base'], 'Pronto 0 kg · extraindo']);
  assert.deepEqual([veinRows([], 0), veinRows(one, base.x, 100).map(r => r.lines.at(-1))], [[], ['A 6,2 km → da base · vista há 1 min']]);
  // A faction with no base is told no way to them: only how long ago one out of sight was seen.
  assert.deepEqual([3, 2].map(i => veinRows([veins[i]], null, 2000)[0].lines.at(-1)), ['Pronto 0 kg', 'Vista há 13 min']);
  // How far and to which side: metres under a kilometre, kilometres from there.
  assert.deepEqual([farText(800, 1380), farText(2380, 1380), farText(5600, 1380), farText(-30000, 1380)], ['580 m ←', '1 km →', '4,2 km →', '31,4 km ←']);
  // The overview has a mark for each vein the faction knows and for no other site, made once for each list of them.
  const marks = depositMarks(veins);
  assert.equal(marks.length, 7); assert.deepEqual(marks[1], { x: 1300, material: 'ferro', share: 1, active: false }); assert.deepEqual(marks[3], { x: 1900, material: 'ferro', share: 41000 / 65000, active: true });
  assert.deepEqual([marks[4], marks[6]], [{ x: 2400, material: 'petroleo', share: 1, active: true }, { x: 5600, material: 'silica', share: 1, active: true }]);
  assert.equal(depositMarks(veins), marks); assert.deepEqual(depositMarks(one), [{ x: 7400, material: 'ferro', share: 30000 / 81000, active: true }]); assert.deepEqual(depositMarks([]), []);
  // And so have the marks that stand over a stretch of the field while the squad is commanded: what was left of each when last seen, or that a base stills it.
  const fieldMarks = veinMarks(veins, 1400, 1000);
  assert.deepEqual(fieldMarks.map(({ shortText, shortDetail, priority, ...mark }) => mark), [{ id: 'ferro:1', x: 800, material: 'ferro', active: true, text: 'Ferro · reserva 62 t', detail: '0 kg prontos' },
    { id: 'ferro:2', x: 1300, material: 'ferro', active: false, text: 'Ferro · junto de uma base', detail: '' },
    { id: 'ligas:2', x: 1450, material: 'ligas', active: true, text: 'Ligas · reserva 63,5 t', detail: '0 kg prontos' },
    { id: 'ferro:3', x: 1900, material: 'ferro', active: true, text: 'Ferro · reserva 41 t', detail: '0 kg prontos' },
    { id: 'petroleo:4', x: 2400, material: 'petroleo', active: true, text: 'Petróleo · reserva 66.000 L', detail: '0 L prontos' }]);
  assert.deepEqual(fieldMarks.map(mark => [mark.shortText, mark.shortDetail, mark.priority]), [
    ['Ferro · 62 t', '', 0], ['Ferro · junto de uma base', '', -1], ['Ligas · 63,5 t', '', 0], ['Ferro · 41 t', '', 0], ['Petróleo · 66.000 L', '', 0] ]);
  assert.deepEqual([veinMarks(veins, 7200, 500), veinMarks(one, 7200, 500).map(m => m.text)], [[], ['Ferro · reserva 30 t']], 'a site with no vein known has no mark');
});

test('a depleted reserve with ready material remains useful and the row distinguishes reserve from stock', () => {
  const vein = { id: 'site', x: 100, material: 'ferro', feature: 'outcrop', reserve: 62000, left: 0, stock: 1500, active: true, seen: true },
    [row] = veinRows([vein], 0);
  assert.deepEqual([row.lines, row.share], [['Reserva 0 kg de 62 t', 'Pronto 1,5 t', 'A 100 m → da base'], 0]);
  const mark = veinMarks([vein], 100, 30)[0];
  assert.equal(mark.text, 'Ferro · reserva 0 kg'); assert.equal(mark.detail, '1,5 t prontos');
  assert.equal(mark.shortText, 'Ferro · 0 kg'); assert.equal(mark.shortDetail, '1,5 t prontos'); assert.equal(mark.priority, 1);
  assert.equal(veinMarks([{ ...vein, extracting: true }], 100, 30)[0].priority, 2);
  const [oil] = veinRows([{ ...vein, material: 'petroleo', feature: 'lowland' }], 0);
  assert.deepEqual(oil.lines.slice(0, 2), ['Reserva 0 L de 62.000 L', 'Pronto 1.500 L']);
});

test('airdrop UI projections retain one public site and keep natural age fallback local', () => {
  const natural = { id: 'ferro:1', x: 100, material: 'ferro', feature: 'outcrop', reserve: 100, left: 50, stock: 0,
    active: true, seen: false, at: -30 }, deposits = [{ ...natural }],
    drop = { id: 'airdrop:1', type: 'airdrop', x: 18000, material: 'ferro', reserve: 0, left: 0,
      stock: 4000, phase: 'collection', arrivesAt: 100, expiresAt: 500, active: true, guarded: true },
    faction = { deposits: [natural], activity: drop }, before = structuredClone({ deposits, faction }),
    known = knownVeins(deposits, faction), publicSite = known.filter(site => site.type === 'airdrop');
  assert.deepEqual(publicSite, [drop]); assert.equal(knownVeins(deposits, faction), known);
  for (const time of [undefined, null, NaN, Infinity]) {
    const row = veinRows(publicSite, null, time)[0];
    assert.equal(row.lines[0], 'Aguardando tempo do campo'); assert.equal(row.lines[1], 'Pronto 4 t');
    assert.equal(row.share, null); assert.doesNotMatch(row.lines.join(' '), /Reserva/);
  }
  const ready = veinRows(publicSite, 0, 220)[0], withdrawal = veinRows([{ ...drop, stock: 0, active: false, retireAt: 315 }], null, 300)[0];
  assert.equal(ready.lines[0], 'Airdrop · coleta por 280 s');
  assert.equal(ready.lines[2], 'Pode haver uma sentinela.');
  assert.deepEqual(ready.details, ['Carga pública: qualquer facção pode recolher.',
    'Use um veículo com recipiente para sólidos. Leve a carga à base para refinar.']);
  assert.match(withdrawal.lines[0], /Airdrop encerrado.*retirada.*15 s/);
  assert.equal(veinRows([natural], null)[0].lines.at(-1), 'Vista há 30 s', 'only the natural vein retains its legacy age fallback');
  const mark = depositMarks(known).find(site => site.type === 'airdrop');
  assert.deepEqual(mark, { x: drop.x, material: 'ferro', share: 0, active: true, type: 'airdrop' });
  const fieldMarks = veinMarks(known, drop.x, 1);
  assert.equal(fieldMarks.length, 1); assert.equal(fieldMarks[0].priority, 3);
  assert.deepEqual([fieldMarks[0].text, fieldMarks[0].detail], ['Airdrop · Ferro', '4 t prontos']);
  assert.equal(veinMarks([{ ...drop, phase: 'announcement', active: false }], drop.x, 1)[0].detail, 'a caminho');
  assert.equal(veinMarks([{ ...drop, active: false }], drop.x, 1)[0].detail, 'coleta indisponível');
  const partial = knownVeins(deposits, { ...faction, activity: { ...drop, stock: 2500 } });
  assert.notEqual(partial, known); assert.equal(publicSite[0].stock, 4000);
  assert.equal(veinRows(partial.filter(site => site.type === 'airdrop'), null, 220)[0].lines[1], 'Pronto 2,5 t');
  const cleaned = knownVeins(deposits, { ...faction, activity: null });
  assert.deepEqual(cleaned, [natural]); assert.deepEqual(veinMarks(cleaned, drop.x, 1), []);
  assert.deepEqual(depositMarks(cleaned).filter(site => site.type === 'airdrop'), []);
  const refined = { id: drop.id, type: 'airdrop', x: drop.x, supplies: bill(48000, 16000, 12000, 4000),
    refined: true, guarded: true, arrivesAt: 3600, expiresAt: 32400,
    phase: 'announcement', active: false }, refinedKnown = knownVeins(deposits, { ...faction, activity: refined }),
    [announced] = veinRows(refinedKnown.filter(site => site.type === 'airdrop'), null, 0);
  assert.equal(announced.name, 'Airdrop · Suprimentos'); assert.equal(announced.supplied, true);
  assert.equal(Object.hasOwn(announced, 'material'), false, 'the supplied event does not invent a geological material');
  assert.deepEqual(announced.lines, ['Airdrop · chegada em 1:00:00', 'Remessa · 42,2 m³ de suprimentos', 'Pode haver uma sentinela.']);
  assert.deepEqual(announced.details, ['Ferro 48.000 + Ligas 16.000 + Sílica 12.000 + Combustível 4.000 L',
    'Carga disputável: qualquer facção que encontrar o local pode recolher.',
    'Use uma peça de Suprimentos. A carga ocupa o espaço livre e pode exigir várias viagens.',
    'Volte à base para descarregar no estoque, sem refinar.']);
  for (const time of [undefined, null, NaN, Infinity]) assert.equal(veinRows([refined], null, time)[0].lines[0], 'Aguardando tempo do campo');
  const landed = { ...refined, active: true, phase: 'collection' };
  assert.deepEqual(veinRows([landed], null, 3600)[0].lines.slice(0, 2), ['Airdrop · coleta por 8:00:00', 'Disponível · 42,2 m³ de suprimentos']);
  assert.equal(veinRows([landed], null, 32339)[0].lines[0], 'Airdrop · coleta por 1:01');
  assert.equal(veinRows([{ ...landed, supplies: bill(), active: false, retireAt: 32415 }], null, 32400)[0].lines[0], 'Airdrop encerrado · retirada em 0:15');
  const fuelOnly = { ...landed, supplies: bill(0, 0, 0, 1250) }, fuelRow = veinRows([fuelOnly], null, 4000)[0],
    fuelMark = veinMarks([fuelOnly], fuelOnly.x, 1)[0];
  assert.equal(fuelRow.lines[1], 'Disponível · 1,3 m³ de suprimentos'); assert.equal(fuelRow.details[0], 'Combustível 1.250 L');
  assert.deepEqual([fuelMark.text, fuelMark.detail, fuelMark.shortDetail, fuelMark.supplied],
    ['Airdrop · Suprimentos', '1,3 m³ disponíveis', '1,3 m³', true]);
  assert.equal(Object.hasOwn(fuelMark, 'material'), false);
  assert.deepEqual(depositMarks([fuelOnly]), [{ x: fuelOnly.x, supplied: true, share: 0, active: true, type: 'airdrop' }]);
  assert.deepEqual(refined.supplies, bill(48000, 16000, 12000, 4000), 'formatting and caching never spend or rewrite the shipment');
  assert.equal(refinedKnown.filter(site => site.type === 'airdrop').length, 1);
  assert.deepEqual(knownVeins(deposits, { ...faction, activity: null }), [natural], 'late discovery and removal never duplicate or alter a natural deposit');
  assert.deepEqual({ deposits, faction }, before);
});

test('a hauler says where it is in its trip and how full it is', () => {
  assert.equal(haulText({ depositId: 'ferro:3', material: 'ferro', phase: 'out' }, quoted()), 'transportando · indo à coleta · 0%');
  assert.equal(haulText({ depositId: 'ferro:3', phase: 'load' }, quoted({ cargo: load(4250), fill: { solid: .354, liquid: 0 }, loading: 'ferro:3' })), 'transportando · carregando · 35%');
  assert.equal(haulText({ depositId: 'ferro:3', phase: 'home' }, quoted({ cargo: load(11197), fill: { solid: 1, liquid: 0 } })), 'transportando · voltando à base · 100%');
  assert.equal(haulText({ depositId: 'petroleo:4', phase: 'load' }, quoted({ cargo: load(0, 0, 0, 2200), fill: { solid: 0, liquid: .497 }, loading: 'petroleo:4' })), 'transportando · carregando · 50%', 'a tanker by its cistern');
  assert.equal(haulText({ depositId: 'airdrop:1', refined: true, phase: 'load' },
    quoted({ fill: { solid: .9, liquid: 0, supplies: .354 }, loading: 'airdrop:1' })), 'transportando · carregando · 35%',
  'refined cargo reports the actual supply compartments, independently of ordinary hoppers');
  assert.equal(haulText({ depositId: 'ferro:3', phase: 'unload' }, undefined), 'transportando · descarregando', 'before the faction told of it');
  const active = quoted({ extracting: 'ferro:3' });
  assert.equal(haulText({ phase: 'load' }, active, { extracts: true, carries: false }), 'extração · extraindo');
  assert.equal(haulText({ phase: 'load' }, quoted(), { extracts: true, carries: false }), 'extração · aguardando condições para extrair');
  assert.equal(haulText({ phase: 'load' }, quoted()), 'transportando · aguardando material extraído · 0%');
  assert.equal(haulText({ phase: 'load', refined: true }, quoted()), 'transportando · aguardando carga · 0%',
    'a refined shipment is already cargo and never claims to await extraction');
  assert.equal(haulText({ phase: 'load' }, { ...active, loading: 'ferro:3' }, { extracts: true, carries: true }), 'extração e transporte · extraindo e carregando · 0%');
  // What is still carried with no haul under way: the load of a wreck, or of a haul that ended.
  assert.equal(cargoText(quoted({ cargo: load(4250, 0, 1500), fill: { solid: .46, liquid: 0 } })), 'carga Ferro 4.250 + Sílica 1.500 (46%)');
  assert.equal(cargoText(quoted({ cargo: load(0, 0, 0, 3648), fill: { solid: 0, liquid: 1 } })), 'carga Petróleo 3.648 L (cheia)');
  assert.equal(cargoText(quoted()), ''); assert.equal(cargoText(undefined), '');
});

test('a faction goes by its nation or its founder, an invitation is new once, and joining another says what stays behind', () => {
  const FLAG = { field: 'cross', colours: [4, 0, 8], emblem: 'star' }, OTHER = { field: 'plain', colours: [0, 1, 2], emblem: 'none' },
    alone = founded({ invites: [{ factionId: 'red', name: 'Caio', nation: null, flag: FLAG, members: 2 }, { factionId: 'blue', name: 'Edu', nation: 'Império do Sul', flag: OTHER, members: 1 }] }),
    shared = { ...alone, members: [...alone.members, { id: 'beto', name: 'Beto', connected: false }] };
  assert.deepEqual([{ name: 'Caio', nation: null }, { name: 'Caio' }, { name: 'Edu', nation: 'Império do Sul' }].map(f => [factionName(f), factionSaid(f)]),
    [['Facção de Caio', 'facção de Caio'], ['Facção de Caio', 'facção de Caio'], ['Império do Sul', 'facção Império do Sul']]);
  assert.deepEqual(arrivals(new Set(['red']), alone.invites).map(i => i.factionId), ['blue'], 'an invitation is new once');
  assert.deepEqual(arrivals(new Set(), undefined), []);
  // Alone, the player leaves the faction behind, and what it has on the field leaves it with what it carries.
  assert.match(joinWarning(alone.invites[0], { ...alone, count: 3 }), /^Você sai da sua facção: os estoques \(Ferro 60\.000 · Ligas 0 · Sílica 0 · Combustível 1\.500 L\) ficam para trás e as 3 construções da facção saem do campo, com o que levam\..*facção de Caio/);
  assert.match(joinWarning(alone.invites[0], alone), /a construção da facção sai do campo/);
  assert.doesNotMatch(joinWarning(alone.invites[0], { ...alone, count: 0 }), /do campo/);
  // With another member the faction keeps it all: the stocks and the constructions, which are no longer the player's.
  assert.match(joinWarning(shared.invites[0], { ...shared, count: 3 }), /os estoques \(.*\) e as construções ficam com ela\. Você passa a usar a base, os estoques e as construções da facção de Caio\.$/);
  assert.match(joinWarning(shared.invites[1], { ...shared, count: 0 }), /ficam com ela\. Você passa a usar a base, os estoques e as construções da facção Império do Sul\.$/);
  // Asked for, it is said as what comes of the request being accepted.
  assert.match(joinWarning(shared.invites[0], shared, true), /^Se o pedido for aceito, você sai da sua facção: os estoques/);
});

test('a faction is told what establishing a base and the aid would be, what it lost with its base and what it got back', () => {
  const base = bill(22500, 2500, 2500, 375), lorry = bill(28022, 0, 995, 203);
  // A base it pays for, and one it does not, with the ore lorry it has no stocks for: the aid covers what is short.
  assert.equal(recoveryText({ base, lorry: null, reserve: 0, aid: bill(), offered: true }), 'Estabelecer base custa Ferro 22.500 + Ligas 2.500 + Sílica 2.500 + Combustível 375 L.');
  assert.equal(recoveryText({ base, lorry, reserve: 406, aid: bill(40000, 2500, 3495, 903), offered: true }),
    'Estabelecer base custa Ferro 22.500 + Ligas 2.500 + Sílica 2.500 + Combustível 375 L. Sem estoque para um caminhão de minério, ele vem junto, com Combustível 406 L de reserva. ' +
    'O auxílio cobre o que falta: Ferro 40.000 + Ligas 2.500 + Sílica 3.495 + Combustível 903 L.');
  // A base and nothing on the field: the lorry alone.
  assert.equal(recoveryText({ base: null, lorry, reserve: 406, aid: bill(20000, 0, 995, 609), offered: true }),
    'Nada no campo e sem estoque para um caminhão de minério (Ferro 28.022 + Sílica 995 + Combustível 203 L) com Combustível 406 L de reserva. ' +
    'O auxílio cobre o que falta: Ferro 20.000 + Sílica 995 + Combustível 609 L.');
  assert.equal(strandedText('Sem combustível'), 'Sem combustível, e a facção não tem outra construção nem estoque para um caminhão de minério. Abandone esta: sem nada no campo, a facção pode pedir auxílio.');
  // With nothing on the field: to the workshop, or, with no base, whose the base was.
  const caio = { id: 'red', name: 'Caio', nation: null }, fell = { at: 80, from: 1000, by: caio, dismantled: 0, returned: bill(), cargo: load(), stock: bill(), yard: load() },
    lost = founded({ base: null, count: 0, counts: { vehicles: 0, fixed: 0 }, units: [], fell });
  assert.deepEqual([emptyText(founded()), emptyText(founded({ count: 0 })), emptyText(lost), emptyText({ ...lost, fell: { ...fell, by: null } })], ['Selecione uma construção na lista ou no campo.', 'Você não tem construções no campo: monte uma em Construir e fabrique-a.',
    'Sua facção está sem base: tomada pela facção de Caio.', 'Sua facção está sem base.']);
  const waiting = { base: null, lorry, reserve: 406, aid: bill(20000), offered: false, wait: 1800 };
  assert.equal(emptyText(founded({ count: 0, recovery: waiting })), 'Sua facção está sem construções no campo. Novo auxílio em 30:00 de jogo.');
  assert.equal(emptyText(founded({ count: 0, recovery: { ...waiting, wait: .25 } })), 'Sua facção está sem construções no campo. Novo auxílio em 0:01 de jogo.');
  assert.equal(emptyText({ ...lost, recovery: { ...waiting, base } }), 'Sua facção está sem base: tomada pela facção de Caio. Novo auxílio em 30:00 de jogo.');
  assert.equal(emptyText(founded({ count: 0, recovery: { ...waiting, offered: true, wait: 0 } })),
    'Sua facção está sem construções no campo. Peça auxílio para receber um caminhão de minério.');
  assert.equal(emptyText({ ...lost, recovery: { base, lorry: null, reserve: 0, aid: bill(), offered: true } }),
    'Sua facção está sem base: tomada pela facção de Caio.', 'paid recovery is not described as waiting for a subsidy');
  // The base lost, with nothing on the field and nothing looted, and with all of that.
  assert.equal(fellText(lost), 'Sua base foi tomada pela facção de Caio. Saque: nada. Estabeleça outra base no painel do campo.');
  assert.equal(fellText({ ...lost, fell: { ...fell, dismantled: 1, returned: bill(20000, 0, 0, 90), cargo: load(3000), stock: bill(7500), yard: load(0, 0, 100, 25) } }),
    'Sua base foi tomada pela facção de Caio. 1 construção desmontada: Ferro 20.000 + Combustível 90 L de volta aos estoques e Ferro 3.000 ao pátio. ' +
    'Saque: Ferro 7.500 e Sílica 100 + Petróleo 25 L do pátio. Estabeleça outra base no painel do campo.');
  assert.equal(fellText({ ...lost, fell: { ...fell, dismantled: 2, returned: bill(40000), yard: load(500) } }),
    'Sua base foi tomada pela facção de Caio. 2 construções desmontadas: Ferro 40.000 de volta aos estoques. Saque: Ferro 500 do pátio. Estabeleça outra base no painel do campo.');
  // And to the faction that took it.
  const taken = { at: 80, of: { id: 'green', name: 'Ana', nation: null }, dismantled: 3, stock: bill(7500), yard: load(0, 0, 100) };
  assert.equal(takenText({ taken }), 'Base da facção de Ana tomada · 3 construções desmontadas · saque: Ferro 7.500 para os estoques e Sílica 100 para o pátio.');
  assert.equal(takenText({ taken: { ...taken, of: null, dismantled: 0, stock: bill(), yard: load() } }), 'Base inimiga tomada · saque: nada.');
  // A base established, how far from the one it lost and to which side, with the lorry and what the aid covered; or the lorry alone.
  assert.equal(recoveredText({ recovered: { at: 90, base: 39400, from: 2000, lorry: false, aid: bill() } }), 'Base estabelecida a 37,4 km → da que foi tomada.');
  assert.equal(recoveredText({ recovered: { at: 90, base: 1400, from: 2000, lorry: true, aid: bill(40000, 2500, 3495, 700) } }),
    'Base estabelecida a 600 m ← da que foi tomada, com um caminhão de minério · o auxílio cobriu Ferro 40.000 + Ligas 2.500 + Sílica 3.495 + Combustível 700 L.');
  assert.equal(recoveredText({ recovered: { at: 90, base: null, from: null, lorry: true, aid: bill(20000, 0, 995, 406) } }),
    'Caminhão de minério na base · o auxílio cobriu Ferro 20.000 + Sílica 995 + Combustível 406 L.');
});

test('the screen prices the design at the workshop of the field and, on the field, offers the base\'s work for the construction picked', () => {
  const editor = new Editor(createConstruction('heavy')), b = editor.blueprint, cost = constructionCost(b), price = designBill(b),
    view = { mode: 'edit', buildTool: 'select', testTool: 'fire', weapon: { preset: 'rh120', platform: 'vehicle' },
      placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual', snap: true } },
    faction = founded({ stock: bill(price.ferro - 1, 500, price.silica, price.combustivel), count: 2, counts: { vehicles: 2, fixed: 0 }, units: [quoted({ id: 'one', cargo: load(3000), fill: { solid: .25, liquid: 0 }, loading: 'ferro:1' }),
      quoted({ id: 'two', repair: bill(500), repairSeconds: 6, atBase: false })] }),
    network = { enabled: true, connected: true, designs: new Map(), playerId: 'ana', selected: 'one', faction, name: 'Ana', pingMs: 0 },
    unit = id => ({ id, role: 'armor', defeated: false, stance: 'return', move: null, attack: null, haul: null, alert: false, heard: null, activity: 'idle', reason: '', targetId: null }),
    state = { time: 50, shared: true, localPlayerId: 'ana', faction, players: [{ id: 'ana', name: 'Ana', connected: true, factionId: 'green', actors: ['one', 'two'] }],
      plates: [], modules: [], stats: { shots: 0 }, squad: { manual: null, out: [], units: [unit('one'), unit('two')] },
      actors: [{ id: 'one', ownerId: 'ana', name: 'Batedor', x: 1200, stats: { shots: 0 } }, { id: 'two', ownerId: 'ana', name: 'Morteiro', x: 2400, stats: { shots: 0 } }] },
    model = (mode, options) => { view.mode = mode;
      return screenModel({ view, editor, state, network, session: { paused: false, speed: 1, testDistance: 0, physicsMs: 0 },
        terrainId: 'flat', particles: 0, sound: { enabled: false, volume: .4 }, ...options }).bindings; },
    hidden = (bindings, ...ids) => ids.map(id => bindings[id].hidden);

  // In the workshop, full stock values remain available beside publishing costs without a second overlay on the drawing.
  let bindings = model('edit');
  assert.equal(bindings['faction-hud'].hidden, true);
  assert.deepEqual(['ferro', 'ligas', 'silica', 'combustivel'].map(id => bindings['stock-' + id].text), stockFigures(faction.stock).map(figure => figure.text));
  assert.equal(bindings['stock-ligas'].text, '500'); assert.match(bindings['stock-combustivel'].text, /^[\d.]+ L$/);
  assert.deepEqual(bindings['faction-yard'], { hidden: true, text: '' }); assert.equal(bindings['faction-vehicles'].text, 'Veículos 2/12');
  assert.equal(bindings['faction-structures'].text, 'Estruturas 0/32');
  assert.equal(bindings['faction-structures'].attr['aria-label'], 'Estruturas 0 de 32, incluindo obras em andamento.');
  assert.equal(bindings['faction-shots'].hidden, true, 'no gun of it waits for its rounds in the air to come down');
  assert.equal(model('edit', { shotsHeld: true })['faction-shots'].hidden, false, 'while one does, the faction is told so');
  assert.deepEqual([bindings['publish-new'].text, bindings['publish-new'].disabled], ['Fabricar novo veículo', true], 'one unit of iron short');
  for (const id of ['publish-panel', 'project-panel']) assert.equal(Object.hasOwn(bindings, id), false, 'WorkshopScreen owns ' + id);
  assert.deepEqual([bindings['cost-ferro'].classes.short, bindings['cost-ferro'].hidden, bindings['cost-ligas'].hidden], [true, false, true], 'the iron it is short of is red; what it does not ask is away');
  assert.match(bindings['publish-refused'].text, /^Falta Ferro/); assert.match(bindings['cost-time-n'].text, /^\d+ s$/);
  const immediate = model('edit', { instant: true });
  assert.equal(immediate['cost-time-n'].text, '0 s'); assert.match(immediate['cost-time'].title, /instantânea/);
  assert.equal(immediate['publish-new'].disabled, true, 'the displayed instant quote still refuses the missing iron');
  assert.deepEqual(bindings['publish-replace'], { hidden: true }, 'with no construction in focus, replacing is not offered');
  assert.deepEqual(hidden(bindings, 'unit-panel', 'field-empty', 'test-controls'), [true, true, true], 'nothing of the field\'s own tab is at the workshop');
  assert.equal(bindings.reset.hidden, true, 'nothing is restored for free on the shared field: Restaurar is of a test');
  // What its design is paid from is on the button; what it would carry, among its figures, when it has a hopper or a cistern.
  assert.match(billText(price), /^Ferro [\d.]+ \+ Sílica [\d.]+ \+ Combustível 203 L$/);
  assert.equal(price.ferro + price.silica + 162, cost.total, 'the fuel is the rest of its price');
  const figures = options => { view.mode = 'edit'; return screenModel({ view, editor, state, network, session: { paused: false, speed: 1, testDistance: 0, physicsMs: 0 },
    terrainId: 'flat', particles: 0, sound: { enabled: false, volume: .4 }, ...options }).figures; };
  assert.equal(figures().some(figure => figure.label === 'CARGA'), false, 'a tank carries nothing');
  for (const [template, carries] of [['truck', '4,7 m³ de minério'], ['tanker', '4.428 L de petróleo']])
    assert.equal(figures({ editor: new Editor(createConstruction(template)) }).find(figure => figure.label === 'CARGA')?.value, carries);
  // The design on the bench with its command post taken out is not published: the line under the buttons says what to install.
  const headless = new Editor(createConstruction('heavy')); headless.select(headless.blueprint.modules.find(m => m.kind === 'command').id); headless.remove();
  assert(!headless.blueprint.modules.some(m => m.kind === 'command'));
  const unposted = model('edit', { editor: headless });
  assert.deepEqual([unposted['publish-new'].disabled, unposted['publish-new'].title, unposted['publish-refused'].text], [true, UNCOMMANDED, UNCOMMANDED]);
  network.faction = founded({ yard: load(1200, 0, 0, 600) });
  assert.deepEqual(model('edit')['faction-yard'], { hidden: false, text: 'Pátio: Ferro 1.200 + Petróleo 600 L · refinando' }); network.faction = faction;
  // With a construction in focus the workshop offers to replace it, by name; one away from the base stays, with the reason.
  bindings = model('edit', { choice: { focus: 'one' } });
  assert.deepEqual([bindings['publish-replace'].hidden, bindings['publish-replace'].disabled, bindings['replace-reason'].hidden], [false, false, true], 'the construction in focus pays the difference');
  assert.match(bindings['publish-replace'].text, /^Substituir 1\. Batedor · /);
  assert.deepEqual(bindings['publish-refused'], { hidden: false, text: bindings['publish-new'].title }, 'touch users can read why New is unavailable even when replacing is affordable');
  assert.match(bindings['publish-new'].title, /^Falta Ferro para fabricar um novo veículo:/, 'the new unit still explains its own refusal');
  assert.equal(bindings['publish-new'].attr['aria-describedby'], 'publish-refused');
  assert.equal(bindings['publish-models'].hidden, true, 'the affordable replacement needs no model suggestion');
  assert.equal(bindings['cost-ferro'].classes.short, false, 'an affordable replacement keeps its valid cost presentation');
  // Counts are the server's admitted totals, including work not yet present in units; the screen must not recount them.
  network.faction = { ...faction, stock: bill(1000000, 1000000, 1000000, 1000000), count: CONSTRUCTION_LIMITS.vehicles + CONSTRUCTION_LIMITS.fixed,
    counts: { ...CONSTRUCTION_LIMITS } };
  const capped = model('edit', { choice: { focus: 'one' }, touch: true });
  assert.equal(capped['faction-vehicles'].text, 'Veículos 12/12');
  assert.equal(capped['faction-structures'].text, 'Estruturas 32/32');
  assert.equal(capped['faction-structures'].attr['aria-label'], 'Estruturas 32 de 32, incluindo obras em andamento.');
  assert.deepEqual(capped['publish-refused'], { hidden: false, text: 'Limite: 12 veículos por facção.' });
  assert.equal(capped['publish-new'].attr['aria-describedby'], 'publish-refused');
  assert.equal(capped['publish-replace'].disabled, false, 'a full vehicle quota still permits replacing the focused vehicle');
  const fixed = model('edit', { editor: new Editor(createConstruction('bunker')), choice: { focus: 'one' }, touch: true });
  assert.deepEqual(fixed['publish-refused'], { hidden: false, text: 'Limite: 32 estruturas por facção.' });
  assert.deepEqual(fixed['publish-replace'], { hidden: true }, 'a structure replaces no vehicle: it is a works opened on the field');
  // A structure is a works: its place is chosen on the field, and what the stocks lack now refuses nothing.
  network.faction = { ...faction, stock: bill() };
  const opened = model('edit', { editor: new Editor(createConstruction('bunker')), choice: { focus: 'one' } });
  assert.deepEqual([opened['publish-new'].text, opened['publish-new'].disabled, opened['publish-refused'].hidden], ['Escolher local no campo', false, true]);
  const asked = ['ferro', 'ligas', 'silica', 'combustivel'].filter(id => !opened['cost-' + id].hidden);
  assert(asked.length && asked.every(id => opened['cost-' + id].classes.short), 'what the stocks lack is marked, for the dispatch to wait for');
  network.faction = { ...faction, stock: bill(price.ferro, 500, price.silica, price.combustivel) };
  const funded = model('edit', { choice: { focus: 'one' } });
  assert.equal(funded['publish-new'].disabled, false);
  assert.deepEqual(funded['publish-refused'], { hidden: true, text: '' }, 'the old shortage disappears when the stock can pay for New');
  assert.equal(funded['publish-new'].attr['aria-describedby'], '', 'the enabled action is not described by an old refusal');
  const pendingBlueprint = { ...b, chassis: { ...b.chassis, loadedKg: b.chassis.limitKg * 1.1 }, mechanicalAdmission: false, admissionIssues: [
    { code: 'CHASSIS_OVERLOAD', loadedKg: 18000, limitKg: 13000 },
  ] }, draftEditor = { blueprint: pendingBlueprint, source: editor.source, selectionIds: new Set(), selection: null, past: [], future: [] },
    pending = model('edit', { editor: draftEditor, choice: { focus: 'one' } });
  assert.equal(pending['publish-new'].disabled, true); assert.equal(pending['publish-replace'].disabled, true);
  assert.match(pending['publish-new'].title, /18 \/ 13 t/);
  assert.deepEqual(pending['publish-refused'], { hidden: false, text: pending['publish-new'].title });
  assert.deepEqual(pending['replace-reason'], { hidden: true, text: '' }, 'the identical refusal is shown once for both actions');
  assert.equal(pending['publish-new'].attr['aria-describedby'], 'publish-refused');
  assert.equal(pending['construction-feedback'].text, pending['publish-new'].title);
  assert.equal(pending['body-paint'].disabled, false);
  assert.equal(pending['publish-models'].hidden, true, 'capacity cannot be fixed by choosing an affordable model');
  const overweight = figures({ editor: draftEditor }).find(figure => figure.label === 'PESO');
  assert.equal(overweight.over, true); assert.match(overweight.title, /^[\d,.]+ (kg|t) acima do limite do chassi · com combustível/);
  for (const [share, over] of [[.89, false], [.9, false], [1, false], [1.01, true]]) {
    const projected = { ...draftEditor, blueprint: { ...pendingBlueprint, chassis: { ...b.chassis, loadedKg: b.chassis.limitKg * share } } },
      weight = figures({ editor: projected }).find(figure => figure.label === 'PESO');
    assert.equal(weight.over, over, `capacity share ${share}`);
  }
  assert.equal(model('edit', { choice: { focus: 'one' } })['publish-new'].disabled, false, 'an admitted projection clears the manufacturing refusal');
  network.faction = faction;
  bindings = model('edit', { choice: { focus: 'two' } });
  assert.match(bindings['publish-replace'].text, /^Substituir 2\. Morteiro · /); assert.equal(bindings['publish-replace'].disabled, true);
  assert.deepEqual(bindings['replace-reason'], { hidden: false, text: 'Fora da base: leve a construção até a base.' });
  assert.match(bindings['publish-refused'].text, /Falta completar: Ferro 1\./, 'the visible manufacturing refusal survives a blocked replacement');

  // The field, commanding. A construction picked alone, in the base and whole: what it carries, and nothing to ask of the base.
  // Copying, dismantling and abandoning it are in Mais ações (squad-ux.ts), not in this block.
  bindings = model('test', { choice: { picked: ['one'] } });
  assert.deepEqual(hidden(bindings, 'unit-panel', 'unit-services', 'unit-repair', 'unit-dump', 'unit-held'), [false, true, true, true, true]);
  assert.deepEqual([bindings['unit-stats'].hidden, bindings['stat-cargo-text'].text, bindings['stat-cargo'].title, bindings['stat-cargo-bar'].attr.style],
    [false, '25%', 'Carga: Ferro 3.000 · 25% · carregando', '--fill: 25%']);
  network.faction = { ...faction, units: [{ ...faction.units[0], supplies: bill(0, 0, 0, 20), fill: { solid: .25, liquid: 0, supplies: .1 } }, faction.units[1]] };
  const both = model('test', { choice: { picked: ['one'] } });
  assert.equal(both['stat-cargo'].hidden, false); assert.equal(both['stat-supplies'].hidden, false);
  assert.equal(both['stat-cargo-label'].text, 'Carga'); assert.equal(both['stat-cargo-text'].text, '25%');
  assert.equal(both['stat-supplies-text'].text, 'Combustível 20 L');
  const unselected = model('test');
  assert.equal(unselected['stat-cargo'].hidden, true); assert.equal(unselected['stat-supplies'].hidden, true);
  network.faction = faction;
  assert.equal(bindings['unit-control'].hidden, false, 'it can be taken in hand');
  for (const id of ['unit-dismantle', 'unit-actions', 'edit-owned', 'unit-abandon']) assert.equal(id in bindings, false, id + ' is no longer in the panel');
  // One away from the base: the base does nothing for it and nothing is said of the base.
  bindings = model('test', { choice: { picked: ['two'] } });
  assert.deepEqual(hidden(bindings, 'unit-panel', 'unit-services', 'unit-held'), [false, true, true]);
  // The same one with a load aboard: there is that to tip out, and its button says so.
  network.faction = founded({ ...faction, units: [faction.units[0], quoted({ id: 'two', atBase: false, cargo: load(0, 0, 17695), fill: { solid: 1, liquid: 0 } })] });
  bindings = model('test', { choice: { picked: ['two'] } });
  assert.deepEqual([bindings['unit-services'].hidden, bindings['unit-dump']], [false, { hidden: false, text: DUMP.text, disabled: false, title: DUMP.title }]); network.faction = faction;
  // Nobody picked, or more than one: the block of one construction is not there.
  assert.equal(model('test')['unit-panel'].hidden, true); assert.equal(model('test', { choice: { picked: ['one', 'two'] } })['unit-panel'].hidden, true);

  // Without the connection nothing is priced or offered: the workshop waits, and the field says so in one line.
  network.faction = null; network.connected = false; bindings = model('edit', { choice: { focus: 'one' } });
  assert.equal(bindings['faction-hud'].hidden, true);
  assert.deepEqual([bindings['publish-new'].disabled, bindings['publish-replace'].hidden, bindings['publish-refused'].text], [true, true, 'Aguarde a conexão com o campo.']);
  for (const ready of [false, true]) {
    const options = { session: { ready, paused: false, speed: 1, testDistance: 0, physicsMs: 0 } };
    bindings = model('edit', options);
    assert.deepEqual(hidden(bindings, 'connection-notice', 'connection-workshop'), [ready, ready], 'entry offers Montar; the chosen workshop stays usable offline');
    bindings = model('test', options);
    assert.deepEqual(hidden(bindings, 'connection-notice', 'connection-workshop'), [false, ready], 'the field keeps its connection recovery');
  }
  bindings = model('test', { choice: { picked: ['one'] } });
  assert.deepEqual(hidden(bindings, 'unit-panel', 'network-connection'), [true, true]);
});
