import { nativePhotoOnly } from './helpers/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal, asked } from '../server/room.ts';
import { FieldHost, replayField, DIARY } from '../server/field-host.ts';
import { writeField } from '../server/field-snapshot.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { bill, billSum, load, refine, shortText, stocked, STOCK_IDS } from '../src/economy.ts';
import { SOCIAL_LIMITS } from '../src/faction-social.ts';

const BASES = [-100, 15000, 30000, 45000, 60000], STOCK = bill(100, 100, 100, 100);
const written = room => JSON.parse(JSON.stringify(room.keep()));
function field(t, names = ['Ana', 'Bia', 'Caio', 'Duda']) {
  const room = rehearsal(BASES, STOCK), players = names.map(name => room.join(name)); t.after(() => room.field.dispose());
  const send = (p, type, data = {}) => room.command(p.playerId, { type, ...data });
  return { room, players, send, view: p => room.factionView(p.playerId),
    together: (leader, member) => { send(leader, 'invite', { playerId: member.playerId }); send(member, 'join-faction', { factionId: leader.faction.id }); } };
}

test('a pending trade reserves nothing; accept moves both bills once, and competing, cancelled or unauthorised commands move neither', t => {
  const { room, players: [ana, bia, caio], send, view } = field(t), from = room.faction(room.players.get(ana.playerId)),
    stock = () => [...room.factions.values()].map(f => ({ ...f.stock })),
    propose = (who, to) => send(who, 'trade', { act: 'offer', ref: view(to).ref, give: bill(10, 2, 3, 4), want: bill(0, 3, 0, 2) }).offered;
  const before = stock(), first = propose(ana, bia), other = propose(ana, caio);
  assert.deepEqual(stock(), before); assert.deepEqual(view(bia).trades.map(o => o.id), [first]); assert.deepEqual(view(caio).trades.map(o => o.id), [other]);
  assert.equal(propose(ana, bia), first, 'the same still-pending offer is not added twice');
  assert.throws(() => send(caio, 'trade', { act: 'accept', id: first }), /já não está disponível/);
  assert.throws(() => send(ana, 'trade', { act: 'accept', id: first }), /já não está disponível/);
  from.stock.ferro = 15;
  send(bia, 'trade', { act: 'accept', id: first });
  assert.deepEqual(from.stock, bill(5, 101, 97, 98)); assert.deepEqual(room.faction(room.players.get(bia.playerId)).stock, bill(110, 99, 103, 102));
  const paid = stock();
  assert.throws(() => send(bia, 'trade', { act: 'accept', id: first }), /já não está disponível/);
  assert.throws(() => send(ana, 'trade', { act: 'cancel', id: first }), /já não está disponível/);
  assert.throws(() => send(caio, 'trade', { act: 'accept', id: other }), { message: 'A outra facção já não tem os recursos da oferta.' });
  assert.deepEqual(stock(), paid); assert(room.trades.has(other));
  const unpaid = send(caio, 'trade', { act: 'offer', ref: view(bia).ref, give: bill(1), want: bill(200) }).offered;
  assert.throws(() => send(bia, 'trade', { act: 'accept', id: unpaid }), /Falta Ferro/); assert.deepEqual(stock(), paid);
  send(caio, 'trade', { act: 'cancel', id: unpaid });
  send(caio, 'trade', { act: 'cancel', id: other });
  assert.throws(() => send(caio, 'trade', { act: 'accept', id: other }), /já não está disponível/); assert.deepEqual(stock(), paid);
  const totals = STOCK_IDS.map(id => before.reduce((sum, row) => sum + row[id], 0) - (id === 'ferro' ? 85 : 0));
  assert.deepEqual(STOCK_IDS.map(id => stock().reduce((sum, row) => sum + row[id], 0)), totals);
  for (const give of [{ ferro: -1 }, { ferro: .5 }, { ferro: Infinity }, { ferro: Number.MAX_SAFE_INTEGER + 1 }, { ferro: null }, { petroleo: 1 }, []])
    assert.throws(() => send(ana, 'trade', { act: 'offer', ref: view(bia).ref, give, want: bill() }));
  assert.deepEqual(stock(), paid);
});

test('trade follows canonical refinery rounding, keeps fractional remainders and refuses real shortages without partial payment', t => {
  const { room, players: [ana, bia], send, view } = field(t), from = room.faction(room.players.get(ana.playerId)), to = room.faction(room.players.get(bia.playerId)),
    give = bill(10), want = bill(0, 3), balances = () => [{ ...from.stock }, { ...to.stock }];
  Object.assign(from.stock, bill(0, 1.25, -1e-9, 2.75));
  refine(load(10 - 1e-9), from.stock, 1);
  Object.assign(to.stock, bill(3.5, 3 - 1e-9, 4.25, -2e-9));
  assert.equal(stocked(from.stock.ferro), give.ferro); assert.equal(stocked(to.stock.ligas), want.ligas);
  assert.equal(shortText(from.stock, give), ''); assert.equal(shortText(to.stock, want), '');
  const before = balances(), id = send(ana, 'trade', { act: 'offer', ref: view(bia).ref, give, want }).offered;
  send(bia, 'trade', { act: 'accept', id });
  assert.deepEqual(balances(), [billSum(billSum(before[0], give, -1), want), billSum(billSum(before[1], want, -1), give)]);
  assert.deepEqual([from.stock.ligas, from.stock.combustivel, to.stock.ferro, to.stock.silica], [4.25, 2.75, 13.5, 4.25]);
  assert.equal(from.stock.silica, before[0].silica); assert.equal(to.stock.combustivel, before[1].combustivel);
  assert(from.stock.ferro < 0 && to.stock.ligas < 0, 'the same signed rounding crumbs as a canonical debit are retained');
  assert.equal(shortText(from.stock, bill()), ''); assert.equal(shortText(to.stock, bill()), '');
  const paid = balances(); assert.throws(() => send(bia, 'trade', { act: 'accept', id }), /já não está disponível/); assert.deepEqual(balances(), paid);
  for (const short of ['from', 'to']) {
    from.stock.ferro = 10; to.stock.ligas = 3;
    const pending = send(ana, 'trade', { act: 'offer', ref: view(bia).ref, give, want }).offered;
    if (short === 'from') from.stock.ferro = 10 - 2e-6; else to.stock.ligas = 3 - 2e-6;
    assert(shortText(short === 'from' ? from.stock : to.stock, short === 'from' ? give : want));
    const unpaid = balances();
    assert.throws(() => send(bia, 'trade', { act: 'accept', id: pending }), short === 'from' ? /A outra facção já não tem/ : /Falta Ligas/);
    assert.deepEqual(balances(), unpaid); assert(room.trades.has(pending)); send(ana, 'trade', { act: 'cancel', id: pending });
  }
});

test('only current leaders and administrators represent factions; accepted commitments are public and either participant ends them', t => {
  const { room, players: [ana, bia, caio, duda], send, together, view } = field(t);
  together(ana, duda);
  assert.throws(() => send(duda, 'accord', { act: 'propose', ref: view(bia).ref, text: 'Trégua.' }), /Só o líder e os administradores/);
  send(ana, 'member', { playerId: duda.playerId, act: 'admin' });
  const id = send(duda, 'accord', { act: 'propose', ref: view(bia).ref, text: '<b>Trégua ao norte</b>' }).proposed;
  assert.equal(view(caio).accords.length, 0); assert.equal(view(bia).accords[0].acceptedAt, null);
  send(ana, 'member', { playerId: duda.playerId, act: 'member' });
  assert.throws(() => send(duda, 'accord', { act: 'end', id }), /Só o líder e os administradores/);
  assert.throws(() => send(caio, 'accord', { act: 'accept', id }), /já não está disponível/);
  send(bia, 'accord', { act: 'accept', id });
  const publicRecord = view(caio).accords[0];
  assert.equal(publicRecord.text, '<b>Trégua ao norte</b>'); assert.equal(publicRecord.acceptedAt, room.field.time);
  assert.deepEqual(Object.keys(publicRecord.from).sort(), ['flag', 'name', 'nation', 'ref']);
  assert(!JSON.stringify(publicRecord).includes(`"${ana.faction.id}"`));
  assert.throws(() => send(caio, 'accord', { act: 'end', id }), /já não está disponível/);
  send(ana, 'accord', { act: 'end', id }); assert.equal(view(caio).accords.length, 0);
  assert.throws(() => send(bia, 'accord', { act: 'accept', id }), /já não está disponível/);
  const trade = send(ana, 'trade', { act: 'offer', ref: view(bia).ref, give: bill(1), want: bill() }).offered;
  const proposal = send(bia, 'accord', { act: 'propose', ref: view(ana).ref, text: 'Compartilhar a estrada.' }).proposed;
  together(caio, bia);
  assert(!room.trades.has(trade) && !room.accords.has(proposal), 'dissolving a faction removes its offers and commitments');
});

test('chat has bounded history and preserved authorship; a member removed before any new quote receives no further faction message', t => {
  const { room, players: [ana, bia, caio], send, together, view } = field(t); together(ana, bia);
  const staleQuote = view(bia), first = send(ana, 'chat', { scope: 'faction', text: '<script>texto</script>' }).chat;
  assert(room.receivesChat(bia.playerId, first)); assert(!room.receivesChat(caio.playerId, first));
  assert(!JSON.stringify(view(caio)).includes(first.text)); assert(!Object.hasOwn(view(ana), 'chat'), 'history is outside economy quotes');
  send(ana, 'member', { playerId: bia.playerId, act: 'remove' });
  room.steps += SOCIAL_LIMITS.chatSteps;
  const secret = send(ana, 'chat', { scope: 'faction', text: 'Depois da saída, antes do próximo retell.' }).chat;
  assert.equal(staleQuote.ref, view(ana).ref); assert(!room.receivesChat(bia.playerId, secret));
  assert.equal(room.chatView(bia.playerId).faction.length, 0);
  assert.throws(() => send(ana, 'chat', { scope: 'global', text: 'Repetida rápido.' }), /Aguarde/);
  assert.throws(() => send(caio, 'chat', { scope: 'private', text: 'Privada.' }), /Facção, Aliados ou Global/);
  assert.throws(() => send(caio, 'chat', { scope: 'global', text: 'x'.repeat(SOCIAL_LIMITS.text + 1) }), /caracteres/);
  for (let i = 0; i <= SOCIAL_LIMITS.history; i++) {
    room.steps += SOCIAL_LIMITS.chatSteps; send(ana, 'chat', { scope: 'global', text: `Mensagem ${i}` });
  }
  assert.equal(room.chat.length, SOCIAL_LIMITS.history); assert(room.receivesChat(bia.playerId, room.chat.at(-1)));
  send(ana, 'rename', { name: 'Ana Nova' }); assert.equal(room.chat[0].by, 'Ana');
  assert.deepEqual(asked({ type: 'chat', scope: 'global', text: 'Oi', pad: 'fora', request: 9 }), { type: 'chat', scope: 'global', text: 'Oi' });
});

test('a message to the allies reaches the writer\'s faction and the factions allied to it as it is sent, stays with each, and comes back with the field', t => {
  const { room, players: [ana, bia, caio, duda, eva], send, together, view } = field(t, ['Ana', 'Bia', 'Caio', 'Duda', 'Eva']), ref = p => view(p).ref,
    texts = p => room.chatView(p.playerId).faction.map(m => m.text), wait = () => { room.steps += SOCIAL_LIMITS.chatSteps; };
  together(ana, duda);
  const ally = (from, to) => {
    const id = send(from, 'accord', { act: 'propose', ref: ref(to), kind: 'alliance' }).proposed;
    send(to, 'accord', { act: 'accept', id, kind: 'alliance' });
    return id;
  };
  assert.throws(() => send(duda, 'chat', { scope: 'allies', text: 'Ninguém ainda.' }), { message: 'Sua facção não tem aliados.' });
  const pending = send(ana, 'accord', { act: 'propose', ref: ref(caio), kind: 'alliance' }).proposed;
  assert.throws(() => send(duda, 'chat', { scope: 'allies', text: 'Proposta não basta.' }), { message: 'Sua facção não tem aliados.' });
  send(ana, 'accord', { act: 'end', id: pending });
  const pact = ally(ana, bia); ally(bia, caio);
  // Bia's ally Caio is no ally of Ana's: an alliance is between two factions, never with the allies of an ally.
  const said = send(duda, 'chat', { scope: 'allies', text: 'Avançamos juntos.' }).chat;
  assert.deepEqual([said.scope, said.of, said.to, said.by], ['allies', ref(ana), [ref(bia)], 'Duda']);
  assert.deepEqual([ana, bia, caio, duda, eva].map(p => room.receivesChat(p.playerId, said)), [true, true, false, true, false]);
  const answer = send(bia, 'chat', { scope: 'allies', text: 'Cobrimos o flanco.' }).chat;
  assert.deepEqual(answer.to, [ref(ana), ref(caio)]);
  assert.deepEqual([ana, bia, caio, duda, eva].map(p => room.receivesChat(p.playerId, answer)), [true, true, true, true, false]);
  wait(); send(bia, 'chat', { scope: 'faction', text: 'Só nossa.' });
  assert.deepEqual([ana, bia, caio, eva].map(texts),
    [['Avançamos juntos.', 'Cobrimos o flanco.'], ['Avançamos juntos.', 'Cobrimos o flanco.', 'Só nossa.'], ['Cobrimos o flanco.'], []]);
  assert(!JSON.stringify(room.chatView(eva.playerId)).includes('flanco'));
  // A field resumed tells each faction what it was told, what was said to allies with the rest: the same three messages,
  // each kept with every faction it went to. A copy that differs from another, or is kept where it never went, is refused.
  const kept = written(room), resume = state => { const again = rehearsal(BASES, STOCK, { kept: state }); t.after(() => again.field.dispose()); return again; },
    again = resume(kept), told = p => again.chatView(again.join(null, p.token).playerId).faction;
  assert.deepEqual([ana, bia, caio, eva].map(told), [ana, bia, caio, eva].map(p => room.chatView(p.playerId).faction));
  assert.equal(new Set(written(again).factions.flatMap(f => f.chat).map(m => m.id)).size, 3);
  const recorded = (state, of) => state.factions.find(f => f.ref === ref(of)).chat;
  for (const tamper of [
    state => { recorded(state, caio)[0].text = 'Outra coisa.'; },
    state => { recorded(state, ana)[0].to = []; },
    state => { recorded(state, eva).push(structuredClone(recorded(state, ana)[0])); },
    state => { recorded(state, ana)[1].scope = 'faction'; }]) {
    const state = structuredClone(kept); tamper(state);
    assert.throws(() => rehearsal(BASES, STOCK, { kept: state }), /comunicação, ofertas ou acordos inválidos/);
  }
  // An alliance that ends takes nothing back of what was said, and nothing more goes to the allies of none.
  send(ana, 'accord', { act: 'end', id: pact });
  assert.deepEqual(texts(bia), ['Avançamos juntos.', 'Cobrimos o flanco.', 'Só nossa.']);
  wait(); assert.throws(() => send(duda, 'chat', { scope: 'allies', text: 'Ainda aí?' }), { message: 'Sua facção não tem aliados.' });
  wait(); assert.deepEqual(send(bia, 'chat', { scope: 'allies', text: 'Seguimos com Caio.' }).chat.to, [ref(caio)]);
});

test('checkpoint restores both stocks and pending records together, keeps spent ids, and admits save25 without social fields', t => {
  const { room, players: [ana, bia], send, view } = field(t);
  const id = send(ana, 'trade', { act: 'offer', ref: view(bia).ref, give: bill(10), want: bill(0, 5) }).offered;
  const agreement = send(ana, 'accord', { act: 'propose', ref: view(bia).ref, text: 'Acesso à passagem.' }).proposed;
  send(ana, 'chat', { scope: 'faction', text: 'Oferta em andamento.' });
  const checkpoint = written(room), balances = checkpoint.factions.map(f => f.stock);
  send(bia, 'trade', { act: 'accept', id });
  const restore = kept => { const field = rehearsal(BASES, STOCK, { kept }); t.after(() => field.field.dispose()); return field; },
    rollback = restore(checkpoint), back = rollback.join(null, bia.token);
  assert.deepEqual([...rollback.factions.values()].map(f => f.stock), balances); assert(rollback.trades.has(id));
  rollback.command(back.playerId, { type: 'trade', act: 'accept', id });
  assert.deepEqual([...rollback.factions.values()].map(f => f.stock), [...room.factions.values()].map(f => f.stock));
  const again = restore(written(rollback)), returned = again.join(null, bia.token);
  assert.throws(() => again.command(returned.playerId, { type: 'trade', act: 'accept', id }), /já não está disponível/);
  const source = again.join(null, ana.token), next = again.command(source.playerId, { type: 'trade', act: 'offer', ref: returned.faction.ref, give: bill(1), want: bill() }).offered;
  assert.notEqual(next, id); assert(again.accords.has(agreement)); assert.equal(again.chatView(source.playerId).faction[0].text, 'Oferta em andamento.');
  const legacy = structuredClone(checkpoint);
  for (const key of ['trades', 'accords', 'chat']) delete legacy[key];
  for (const key of ['t', 'a', 'm']) delete legacy.serials[key];
  for (const f of legacy.factions) delete f.chat;
  const old = restore(legacy); assert.deepEqual([old.trades.size, old.accords.size, old.chat.length], [0, 0, 0]);
  const broken = structuredClone(checkpoint); delete broken.serials.t;
  assert.throws(() => rehearsal(BASES, STOCK, { kept: broken }), /ofertas ou acordos inválidos/);
  assert.equal(checkpoint.trades[0].id, id, 'restoring leaves the checkpoint input intact');
});

test('social commands replay from the origin and a segmented snapshot with the same digest', nativePhotoOnly, async t => {
  const field = { bases: BASES, stock: STOCK }, host = new FieldHost(rehearsal(BASES, STOCK), { field }); t.after(() => host.room.field.dispose());
  const ana = host.join('Ana'), bia = host.join('Bia'), id = host.command(ana.playerId, { type: 'trade', act: 'offer', ref: bia.faction.ref, give: bill(10), want: bill(0, 5) }).offered;
  const agreement = host.command(ana.playerId, { type: 'accord', act: 'propose', ref: bia.faction.ref, text: 'Guardar a passagem.' }).proposed;
  host.command(ana.playerId, { type: 'chat', scope: 'faction', text: 'Propostas enviadas.' });
  const versions = { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT },
    start = [...host.lines], snapshot = writeField(host.room, host.publication); host.lines.length = 0;
  host.command(bia.playerId, { type: 'trade', act: 'accept', id }); host.command(bia.playerId, { type: 'accord', act: 'accept', id: agreement });
  for (const lines of [[JSON.stringify({ ...versions, field, origin: null }), ...start, ...host.lines],
    [JSON.stringify({ ...versions, field, origin: null, snapshot }), ...host.lines]]) {
    const again = await replayField(lines); t.after(() => again.host.room.field.dispose());
    assert.equal(again.how, 'end', again.got); assert.equal(again.host.room.digest(), host.room.digest());
    assert.deepEqual([...again.host.room.accords.values()], [...host.room.accords.values()]);
  }
});
