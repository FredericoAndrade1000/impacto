import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom, rehearsal, ROOM_LIMITS } from '../server/room.ts';
import { UNCOMMANDED } from '../src/economy.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { CAPACITY, PART_LIMITS, createStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { Editor } from '../src/editor.ts';
import { drawRoom } from '../src/frame-editing.ts';
import { plateCorners } from '../src/math.ts';
import { validateDraftBlueprint, workshopDraft } from '../src/persistence.ts';
import { onField } from './helpers/field.js';
import { constructionUI, descendants } from './helpers/dom.js';
import { DesignLibrary } from '../src/library.ts';

// Bases far enough apart for a faction to be founded anywhere else when somebody leaves one.
const BASES = [-100, 15000, 30000, 45000, -15000, -30000, 60000, -45000, 75000, -60000];
// A field of players who come with what a player is given (`grantStarter`), and what a test does on it.
function field(t, names) {
  const room = new SharedRoom({ build: false, base: i => BASES[i] }), f = onField(t, room), players = names.map(name => room.join(name));
  const view = player => room.factionView(player.playerId), squad = player => room.players.get(player.playerId).squad;
  return { ...f, room, players, view, squad,
    // Whose each construction of the faction is to a player: theirs while they hold it, the name of the member who does, or free.
    held: player => Object.fromEntries(room.squadView(player.playerId).units.map(u => [u.id, u.reserved ? 'mine' : u.by?.name ?? 'free'])),
    // The member whose squad carries out the orders of a construction.
    keeper: id => room.players.get(room.world.actor(id).ownerId)?.name,
    // Players invited into the faction of the first, which they join in that order.
    together: (leader, ...others) => { for (const other of others) {
      f.send(leader, 'invite', { playerId: other.playerId }); f.send(other, 'join-faction', { factionId: room.players.get(leader.playerId).factionId }); } } };
}

test('the constructions of a faction are all its members\': an order, a hand on one or work asked for it holds it for whoever asked until they let it go, and the others are told whose it is', t => {
  const { room, view, squad, order, send, held, keeper, together, players: [ana, bia] } = field(t, ['Ana', 'Bia']);
  together(ana, bia);
  // Bia brought nothing: the faction has what Ana came with, free, and both see all of it.
  const [lorry, tank, scout] = view(bia).units.map(u => u.id), base = view(ana).base.x;
  assert.deepEqual(view(ana).units.map(u => u.id), [lorry, tank, scout]);
  assert.deepEqual([held(ana), held(bia)], [{ [lorry]: 'free', [tank]: 'free', [scout]: 'free' }, { [lorry]: 'free', [tank]: 'free', [scout]: 'free' }]);
  // Ana sends the lorry somewhere: she holds it, and Bia is told so. Bia is refused it, whatever she asks of it.
  order(ana, 'move', { ids: [lorry], x: base + 70 });
  assert.deepEqual([held(ana)[lorry], held(bia)[lorry]], ['mine', 'Ana']);
  const refused = { message: 'Este veículo está com Ana até ser liberado.' };
  assert.throws(() => order(bia, 'stop', { ids: [lorry] }), refused);
  assert.throws(() => order(bia, 'control', { id: lorry }), refused);
  assert.throws(() => send(bia, 'remove', { actorId: lorry }), refused);
  assert.throws(() => send(bia, 'repair', { actorId: lorry }), refused);
  // An order to several goes to those Bia may have: the tank comes into her squad, the lorry stays with Ana.
  order(bia, 'stance', { ids: [lorry, tank], stance: 'hold' });
  assert.deepEqual([keeper(lorry), keeper(tank), held(bia)[tank], held(ana)[tank]], ['Ana', 'Bia', 'mine', 'Bia']);
  assert.equal(squad(bia).units.get(tank).stance, 'hold');
  // Ana lets the lorry go: it goes on to where it was sent, free, and Bia takes it with its order as it stands.
  order(ana, 'free', { ids: [lorry] });
  assert.deepEqual([held(ana)[lorry], held(bia)[lorry]], ['free', 'free']);
  assert.equal(squad(ana).units.get(lorry).move.x, base + 70);
  order(bia, 'stance', { ids: [lorry], stance: 'hold' });
  assert.deepEqual([keeper(lorry), held(ana)[lorry], squad(bia).units.get(lorry).move.x], ['Bia', 'Bia', base + 70]);
  // Taking a construction in hand holds it as well, and letting it go out of hand does not let it go to the others.
  order(ana, 'control', { id: scout });
  assert.deepEqual([keeper(scout), held(bia)[scout], room.squadView(ana.playerId).manual], ['Ana', 'Ana', scout]);
  order(ana, 'control', { id: null });
  assert.equal(held(bia)[scout], 'Ana');
  // Letting go is of what one holds: of what another member does it is refused, and it passes over it among the rest.
  assert.throws(() => order(ana, 'free', { ids: [tank] }), { message: 'Este veículo está com Bia até ser liberado.' });
  order(ana, 'free', { ids: [lorry, scout] });
  assert.deepEqual(held(ana), { [lorry]: 'Bia', [tank]: 'Bia', [scout]: 'free' });
});

test('a member who leaves the field lets go of all they held, which goes on with its orders for another member to take', t => {
  const { room, view, squad, order, held, keeper, together, players: [ana, bia] } = field(t, ['Ana', 'Bia']);
  together(ana, bia);
  const [lorry, tank] = view(ana).units.map(u => u.id), base = view(ana).base.x;
  order(ana, 'move', { ids: [lorry], x: base + 70 }); order(ana, 'control', { id: tank });
  assert.deepEqual(held(bia), { ...held(bia), [lorry]: 'Ana', [tank]: 'Ana' });
  room.disconnect(ana.playerId);
  assert.deepEqual([held(bia)[lorry], held(bia)[tank]], ['free', 'free']);
  assert.equal(squad(ana).units.get(lorry).move.x, base + 70);
  order(bia, 'stance', { ids: [lorry], stance: 'hold' });
  assert.deepEqual([keeper(lorry), squad(bia).units.get(lorry).move.x], ['Bia', base + 70]);
  // Coming back, Ana holds nothing until she asks for it again.
  const back = room.join('Ana', ana.token);
  assert.equal(back.playerId, ana.playerId);
  assert.deepEqual([held(ana)[lorry], held(ana)[tank]], ['Bia', 'free']);
});

test('whoever leaves the faction, for another or one of their own, has none of its constructions any longer: what they held stays with it, free, in the squad of its leader', t => {
  const { room, view, order, send, held, keeper, together, players: [ana, bia, caio] } = field(t, ['Ana', 'Bia', 'Caio']);
  together(ana, bia);
  const [lorry, tank, scout] = view(ana).units.map(u => u.id);
  order(bia, 'stop', { ids: [lorry, tank] });
  assert.deepEqual([keeper(lorry), keeper(tank), held(ana)[lorry]], ['Bia', 'Bia', 'Bia']);
  // Bia joins Caio's faction: the lorry and the tank are Ana's to keep, free, and nothing of Ana's faction is Bia's.
  send(caio, 'invite', { playerId: bia.playerId }); send(bia, 'join-faction', { factionId: caio.faction.id });
  assert.deepEqual([keeper(lorry), keeper(tank), held(ana)[lorry], held(ana)[tank]], ['Ana', 'Ana', 'free', 'free']);
  assert(!view(bia).units.some(u => [lorry, tank, scout].includes(u.id)));
  // Work on one is refused as on any construction of another faction: out of sight of hers, as one not on the field.
  assert.throws(() => order(bia, 'control', { id: tank }), { message: 'Esta construção é de outra facção.' });
  assert.throws(() => send(bia, 'remove', { actorId: scout }), { message: 'Essa construção já não está no campo.' });
  // An order to the squad passes over what is not of the faction, as it does over what is not on the field.
  order(bia, 'stop', { ids: [lorry] });
  assert.deepEqual([keeper(lorry), held(ana)[lorry]], ['Ana', 'free']);
  // Whoever leads and leaves hands what they held to the one who leads after them.
  together(caio, ana);
  const caios = view(caio).units.map(u => u.id).filter(id => keeper(id) === 'Caio');
  order(caio, 'stop', { ids: caios });
  send(caio, 'leave-faction');
  assert.deepEqual(caios.map(keeper), caios.map(() => 'Bia'));
  assert(caios.every(id => held(bia)[id] === 'free'));
});

test('any member dismantles at the base a construction of the faction nobody else holds, whoever brought it', t => {
  const { room, view, order, send, held, together, players: [ana, bia] } = field(t, ['Ana', 'Bia']);
  together(ana, bia);
  const [lorry, tank, scout] = view(ana).units.map(u => u.id), stock = view(bia).stock.ferro;
  order(ana, 'stop', { ids: [tank] });
  assert.throws(() => send(bia, 'remove', { actorId: tank }), { message: 'Este veículo está com Ana até ser liberado.' });
  const given = send(bia, 'remove', { actorId: scout });
  assert(!room.world.actors.some(a => a.id === scout));
  assert(view(ana).stock.ferro > stock && given.removed === scout);
  assert.deepEqual(held(ana), { [lorry]: 'free', [tank]: 'mine' });
});

test('a faction shares twelve vehicle places between its members and keeps its fixed allowance separate', t => {
  const { room, view, publish, open, raise, together, players: [ana, bia] } = field(t, ['Ana', 'Bia']);
  together(ana, bia);
  const faction = room.faction(room.players.get(ana.playerId));
  Object.assign(faction.stock, { ferro: 1e9, ligas: 1e9, silica: 1e9, combustivel: 1e9 });
  for (let i = view(ana).counts.vehicles; i < ROOM_LIMITS.perFaction.vehicles; i++) publish(i % 2 ? ana : bia, 'scout');
  assert.deepEqual([view(ana).count, view(bia).count, view(bia).units.length], [12, 12, 12]);
  for (const player of [ana, bia]) {
    assert.deepEqual(view(player).counts, { vehicles: 12, fixed: 0 });
    assert.throws(() => publish(player, 'scout'), { message: 'Limite: 12 veículos por facção.' });
  }
  // A works is a structure of the faction's from the moment it is opened; all put up, it is the same one.
  const works = open(bia, 'guard-post');
  for (const player of [ana, bia]) {
    assert.deepEqual(view(player).counts, { vehicles: 12, fixed: 1 });
    assert.deepEqual(view(player).works.map(work => work.id), [works]);
  }
  const defence = raise(bia, 'guard-post');
  for (const player of [ana, bia]) {
    assert.deepEqual(view(player).counts, { vehicles: 12, fixed: 2 });
    assert.equal(view(player).units.find(unit => unit.id === defence).vehicle, false);
  }
});

test('the field builds what the workshop lets be drawn: as high as the workshop reaches, and no more parts than it takes', t => {
  const { room } = field(t, ['Ana']);
  // A box pulled up to the top of the workshop's reach stands eight metres over the floor its tracks stand on.
  const tower = new Editor(createStructuredConstruction({ length: 6, height: 1.6, frontInset: 0, rearInset: 0, thicknessMm: 5, chassis: 'tracked' })),
    roof = tower.plateSpans().find(span => span.id === 'hull:roof'), from = { x: (roof.a.x + roof.b.x) / 2, y: (roof.a.y + roof.b.y) / 2 };
  tower.blueprint = validateStructuredConstruction(drawRoom(tower.source, tower.blueprint, roof, from, { x: from.x, y: from.y + 30 }).source);
  tower.addModule('command', { x: 12, y: tower.blueprint.frame.origin.y + .3 });
  assert(Math.abs(Math.max(...tower.blueprint.plates.flatMap(plateCorners).map(point => point.y)) - 8) < .01);
  assert.equal(room.validateDesign(tower.source).plates.length, tower.source.plates.length);
  // Written by hand past the count the workshop refuses, the field refuses it in the same words.
  const bunker = () => new Editor(createStructuredConstruction({ preset: 'bunker', length: 11, height: 3, thicknessMm: 10, frontInset: 0, rearInset: 0 })),
    fuel = (e, k) => e.addModule('fuel', { x: 7.2 + .6 * k, y: 1.2 }, { sizeScale: .5 }), full = bunker();
  full.addModule('command', { x: 7.2, y: 1.2 });
  for (let k = 1; k < PART_LIMITS.components; k++) fuel(full, k);
  assert.equal(room.validateDesign(full.source).components.length, PART_LIMITS.components);
  const aside = bunker(), last = fuel(aside, PART_LIMITS.components),
    over = { ...full.source, components: [...full.source.components, aside.source.components.find(part => part.id === last.id)] };
  assert.throws(() => room.validateDesign(over), { message: CAPACITY });
});

test('a player asks to join a faction by the name every player is told of it: its leader or an administrator accepts or refuses, and a member neither', t => {
  const { room, view, send, together, players: [ana, bia, caio, duda, eva] } = field(t, ['Ana', 'Bia', 'Caio', 'Duda', 'Eva']);
  together(ana, bia, caio); send(ana, 'member', { playerId: caio.playerId, act: 'admin' });
  // Every player is told of every faction what a request names it by, met or not.
  const ref = view(ana).ref, refs = view(duda).ranking.map(row => row.ref);
  assert.equal(new Set(refs).size, 3); assert(refs.includes(ref) && refs.every(r => /^[0-9a-f]{12}$/.test(r)));
  assert.equal(view(duda).ranking.find(row => row.ref === ref).id, null);
  assert.deepEqual(send(duda, 'apply', { ref }), {});
  assert.deepEqual(view(duda).request, { ref, id: null, name: 'Ana', nation: null, flag: view(ana).flag });
  // Only those who answer are told of it.
  const asked = [{ id: duda.playerId, name: 'Duda', connected: true, from: { id: null, name: 'Duda', nation: null, flag: view(duda).flag } }];
  assert.deepEqual([view(ana).requests, view(caio).requests, view(bia).requests], [asked, asked, []]);
  assert.throws(() => send(bia, 'answer', { playerId: duda.playerId, accept: true }), { message: 'Só o líder e os administradores respondem aos pedidos.' });
  // Refused, it is over.
  assert.deepEqual(send(caio, 'answer', { playerId: duda.playerId, accept: false }), {});
  assert.deepEqual([view(duda).request, view(ana).requests, room.players.get(duda.playerId).factionId], [null, [], duda.faction.id]);
  assert.throws(() => send(ana, 'answer', { playerId: duda.playerId, accept: true }), { message: 'Esse pedido já não vale.' });
  for (const playerId of [eva.playerId, 'j99', 7, null]) assert.throws(() => send(ana, 'answer', { playerId, accept: true }), { message: 'Esse pedido já não vale.' });
  // One request at a time: the last replaces the one before, and is called off.
  send(duda, 'apply', { ref }); send(duda, 'apply', { ref: view(eva).ref });
  assert.deepEqual([view(ana).requests, view(eva).requests.map(r => r.id)], [[], [duda.playerId]]);
  send(duda, 'apply', { ref: view(eva).ref, cancel: true });
  assert.deepEqual([view(duda).request, view(eva).requests], [null, []]);
  // Nobody asks to join their own faction, one that is not on the field, or one that invited them.
  assert.throws(() => send(bia, 'apply', { ref }), { message: 'Você já é dessa facção.' });
  for (const bad of ['000000000000', 7, null]) assert.throws(() => send(duda, 'apply', { ref: bad }), { message: 'Essa facção já não está no campo.' });
  send(eva, 'invite', { playerId: duda.playerId });
  assert.throws(() => send(duda, 'apply', { ref: view(eva).ref }), { message: 'Essa facção já convidou você: aceite o convite no alto da página.' });
  // Accepted, Duda is of the faction as one invited would be: what she had leaves the field with the faction she was alone in.
  const hers = view(duda).units.map(u => u.id);
  send(duda, 'apply', { ref }); send(ana, 'answer', { playerId: duda.playerId, accept: true });
  assert.equal(room.players.get(duda.playerId).factionId, ana.faction.id);
  assert.deepEqual(view(ana).members.map(m => m.name), ['Ana', 'Bia', 'Caio', 'Duda']);
  assert(!room.factions.has(duda.faction.id) && !room.world.actors.some(a => hers.includes(a.id)));
  assert.deepEqual(view(duda).units.map(u => u.id), view(ana).units.map(u => u.id));
  assert.equal(view(duda).request, null);
});

test('a request is answered while whoever sent it is away, and is over with the faction it went to or the one who sent it leaving theirs', t => {
  const { room, view, send, together, players: [ana, bia, caio, duda] } = field(t, ['Ana', 'Bia', 'Caio', 'Duda']);
  const ref = view(ana).ref;
  send(bia, 'apply', { ref }); room.disconnect(bia.playerId);
  assert.deepEqual(view(ana).requests.map(r => [r.name, r.connected]), [['Bia', false]]);
  send(ana, 'answer', { playerId: bia.playerId, accept: true });
  assert.equal(room.players.get(bia.playerId).factionId, ana.faction.id);
  // A faction gone takes the requests to it along.
  send(caio, 'apply', { ref: view(duda).ref });
  together(ana, duda);
  assert.equal(view(caio).request, null);
  // Whoever leaves their faction asks to join nowhere from then on.
  together(caio, duda); send(duda, 'apply', { ref });
  assert.deepEqual(view(ana).requests.map(r => r.name), ['Duda']);
  send(duda, 'leave-faction');
  assert.deepEqual([view(duda).request, view(ana).requests], [null, []]);
});

test('a faction keeps a library of projects its members publish: every member opens a copy, and whoever published one, its leader or an administrator removes it', t => {
  const { room, view, send, together, players: [ana, bia, caio] } = field(t, ['Ana', 'Bia', 'Caio']);
  together(ana, bia, caio);
  // A page asks for the projects it is told of by their names (`get`), as many as the library holds.
  const library = player => send(player, 'library', { act: 'get', ids: view(player).library.map(model => model.id) }).models, scout = createStructuredTemplate('scout');
  assert.deepEqual([view(bia).library, library(bia)], [[], []]);
  const published = send(ana, 'library', { act: 'publish', blueprint: scout });
  assert.deepEqual(published, { model: { id: published.model.id, name: scout.name, replaced: false } });
  const at = room.field.time, index = [{ id: published.model.id, name: scout.name, author: ana.playerId, by: 'Ana', at }];
  assert.deepEqual([view(ana).library, view(bia).library], [index, index]);
  // What every member opens is the design as the field would build it, which the workshop opens as any other.
  const [model] = library(caio);
  assert.deepEqual(model, { ...index[0], blueprint: room.validateDesign(scout) });
  assert.equal(workshopDraft(validateDraftBlueprint(model.blueprint)).name, scout.name);
  // Only what is asked for comes, once however often it is named; a name of no project of the faction's brings nothing.
  assert.deepEqual(send(bia, 'library', { act: 'get', ids: [] }).models, []);
  assert.deepEqual(send(bia, 'library', { act: 'get', ids: [model.id, model.id, 'nenhum'] }).models, [model]);
  for (const ids of [undefined, model.id, [7], Array(ROOM_LIMITS.library + 1).fill(model.id)])
    assert.throws(() => send(bia, 'library', { act: 'get', ids }), { message: 'Pedido inválido.' });
  // Publishing a project of the same name again publishes a new version of it, in its place.
  for (let i = 0; i < 30; i++) room.step();
  const again = send(ana, 'library', { act: 'publish', blueprint: { ...scout, preset: scout.preset } });
  assert.deepEqual(again.model, { id: published.model.id, name: scout.name, replaced: true });
  assert.deepEqual(view(bia).library.map(m => [m.id, m.at]), [[published.model.id, room.field.time]]);
  // What the field would not build is not published.
  const { components, ...rest } = scout;
  assert.throws(() => send(bia, 'library', { act: 'publish', blueprint: { ...rest, components: components.filter(part => part.kind !== 'command') } }), { message: UNCOMMANDED });
  for (const blueprint of [null, 7, { ...scout, version: 1 }]) assert.throws(() => send(bia, 'library', { act: 'publish', blueprint }),
    { message: 'Este projeto não pode ser fabricado: recarregue a página e tente de novo.' });
  // A member removes what they published, and nothing of another's; the leader and an administrator remove any.
  const heavy = send(bia, 'library', { act: 'publish', blueprint: createStructuredTemplate('heavy') }).model.id,
    truck = send(bia, 'library', { act: 'publish', blueprint: createStructuredTemplate('truck') }).model.id;
  assert.throws(() => send(bia, 'library', { act: 'remove', id: published.model.id }), { message: 'Só quem publicou, o líder e os administradores removem um projeto da biblioteca.' });
  send(bia, 'library', { act: 'remove', id: heavy });
  send(ana, 'member', { playerId: caio.playerId, act: 'admin' }); send(caio, 'library', { act: 'remove', id: truck });
  assert.deepEqual(view(caio).library.map(m => m.id), [published.model.id]);
  assert.throws(() => send(ana, 'library', { act: 'remove', id: heavy }), { message: 'Esse projeto já não está na biblioteca da facção.' });
  for (const act of ['burn', undefined]) assert.throws(() => send(ana, 'library', { act }), { message: 'Ação inválida.' });
  // What Ana published stays with the faction when she leaves it; her new faction's library has none of it, and she
  // is given none of the projects of the faction she left, asked for by their names.
  send(ana, 'leave-faction');
  assert.deepEqual(library(bia).map(m => [m.name, m.by]), [[scout.name, 'Ana']]);
  assert.deepEqual(library(ana), []);
  assert.deepEqual(send(ana, 'library', { act: 'get', ids: [published.model.id] }).models, []);
});

test('the library of a faction holds a hundred projects: a new version takes no more room, and a page asks for them all at once', t => {
  const { send, view, players: [ana] } = field(t, ['Ana']), scout = createStructuredTemplate('scout');
  assert.equal(ROOM_LIMITS.library, 100);
  for (let i = 0; i < ROOM_LIMITS.library; i++) send(ana, 'library', { act: 'publish', blueprint: { ...scout, name: 'Batedor ' + i } });
  assert.throws(() => send(ana, 'library', { act: 'publish', blueprint: { ...scout, name: 'Mais um' } }),
    { message: 'A biblioteca da facção guarda até 100 projetos: remova um antes de publicar outro.' });
  assert.equal(send(ana, 'library', { act: 'publish', blueprint: { ...scout, name: 'Batedor 3' } }).model.replaced, true);
  const ids = view(ana).library.map(model => model.id);
  assert.equal(ids.length, 100);
  assert.deepEqual(send(ana, 'library', { act: 'get', ids }).models.map(model => model.id), ids);
});

test('the garage asks the field only for the projects of the library of the faction it does not have as published, once, and forgets those gone', async t => {
  const { room, send, view, run, together, players: [ana, bia] } = field(t, ['Ana', 'Bia']);
  together(ana, bia);
  const scout = createStructuredTemplate('scout'), publish = (player, name) => { run(.5); return send(player, 'library', { act: 'publish', blueprint: { ...scout, name } }).model.id; };
  const first = publish(ana, 'Batedor A'), second = publish(bia, 'Batedor B');
  // Bia's garage, with the faction as the field tells her; what it asks of the field is answered when the test says so.
  const asked = [], waiting = [], said = [], storage = { getItem: () => null, setItem() {} };
  const { ui, nodes } = constructionUI(t, { library: new DesignLibrary(storage), getProjectId: () => null, getPlayerId: () => bia.playerId,
    getFaction: () => view(bia), getTime: () => room.field.time, stopControls() {}, onOpen() {}, onLibraryChange() {}, toast: (...args) => said.push(args),
    command: (type, data) => { asked.push(data); return new Promise(resolve => waiting.push(() => resolve(room.command(bia.playerId, { type, ...data })))); } });
  const answer = async () => { for (const reply of waiting.splice(0)) reply(); await new Promise(resolve => setImmediate(resolve)); },
    summary = () => nodes.get('#library-summary').textContent,
    names = () => nodes.get('#library-grid').children.map(card => descendants(card).find(node => node.tagName === 'h3')?.textContent).filter(Boolean);
  // Opened on the tab of the faction, the garage asks for the two projects at once, and shows them once they come.
  ui.openLibrary('faction');
  assert.deepEqual([asked, summary()], [[{ act: 'get', ids: [first, second] }], 'Carregando a biblioteca da facção…']);
  await answer(); assert.deepEqual([names(), summary()], [['Batedor B', 'Batedor A'], '2 projetos da facção']);
  // A project published while it is open is the only one asked for; one more meanwhile, only that one.
  const third = publish(ana, 'Batedor C'); ui.watchShelf();
  assert.deepEqual(asked.at(-1), { act: 'get', ids: [third] });
  assert.deepEqual([names(), summary()], [['Batedor B', 'Batedor A'], '2 de 3 projetos da facção · carregando o resto…']);
  const fourth = publish(bia, 'Batedor D'); ui.watchShelf();
  assert.deepEqual(asked.at(-1), { act: 'get', ids: [fourth] }, 'what was asked for and has not come is not asked for again');
  await answer(); assert.deepEqual(names(), ['Batedor D', 'Batedor C', 'Batedor B', 'Batedor A']);
  // A new version of one is asked for again; one removed is forgotten, and nothing is asked for it.
  publish(ana, 'Batedor A'); ui.watchShelf();
  assert.deepEqual(asked.at(-1), { act: 'get', ids: [first] });
  await answer(); assert.deepEqual(names(), ['Batedor A', 'Batedor D', 'Batedor C', 'Batedor B']);
  const count = asked.length;
  send(bia, 'library', { act: 'remove', id: second }); ui.watchShelf();
  assert.equal(asked.length, count); assert.deepEqual(names(), ['Batedor A', 'Batedor D', 'Batedor C']);
  assert(!ui.kept.has(second));
  // Closed and opened again, the garage has them all: it asks for nothing.
  nodes.get('#library-dialog').close(); ui.openLibrary('faction');
  assert.equal(asked.length, count); assert.equal(summary(), '3 projetos da facção');
  // In all the garage asked for five projects: each new one once, and the one published again once more.
  assert.deepEqual(asked.flatMap(data => data.ids), [first, second, third, fourth, first]);
  assert(asked.every(data => data.act === 'get')); assert.deepEqual(said, []);
});

test('the library of each faction and the request each player has out are kept with the field, and nothing anybody held', t => {
  const room = rehearsal([0, 3000, -3000]), f = onField(t, room), [ana, bia, caio] = ['Ana', 'Bia', 'Caio'].map(name => room.join(name));
  f.send(ana, 'invite', { playerId: bia.playerId }); f.send(bia, 'join-faction', { factionId: ana.faction.id });
  const published = f.send(bia, 'library', { act: 'publish', blueprint: createStructuredTemplate('scout') }).model;
  f.send(caio, 'apply', { ref: room.factionView(ana.playerId).ref });
  const fleet = room.factionView(ana.playerId).units.map(u => u.id);
  f.order(ana, 'stop', { ids: fleet });
  const kept = JSON.parse(JSON.stringify(room.keep())), again = rehearsal([0, 3000, -3000], undefined, { kept });
  t.after(() => again.world.dispose());
  const faction = again.factions.get(ana.faction.id);
  assert.deepEqual(faction.library, room.factions.get(ana.faction.id).library);
  assert.deepEqual(faction.library.map(m => [m.id, m.by]), [[published.id, 'Bia']]);
  assert.equal(faction.ref, room.factions.get(ana.faction.id).ref);
  assert.equal(again.players.get(caio.playerId).request, ana.faction.id);
  // Nobody is on a field resumed: nothing is held, and the first to come back takes what they ask for.
  again.join('Bia', bia.token);
  assert(again.squadView(bia.playerId).units.every(u => !u.reserved && !u.by));
  again.command(bia.playerId, { type: 'squad', order: 'stop', ids: fleet });
  assert(fleet.every(id => again.world.actor(id).ownerId === bia.playerId));
});
