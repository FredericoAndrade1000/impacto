import test from 'node:test';
import assert from 'node:assert/strict';
import { initChat } from '../src/chat-ux.ts';
import { SOCIAL_LIMITS } from '../src/faction-social.ts';
import { workspaceDOM } from './helpers/dom.js';

// The box on the shared tree double: the keys go up to the page as they would to the window, where the box hears them
// before the field does; what it stops never reaches the field. A phone is a screen that matches the compact query.
// Layout, the wheel and what lets a click through belong to the browser checks.
function field(t, { connected = true, phone = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { body, create } = workspaceDOM(t), host = create('div', 'viewport'), canvas = create('canvas', 'battle-canvas', host),
    pawn = create('button', 'pawn', host), before = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener'),
    media = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  document.addEventListener = (type, action) => body.addEventListener(type, action);
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, writable: true, value: (type, action) => body.addEventListener(type, action) });
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, writable: true, value: () => ({ matches: phone, addEventListener() {} }) });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'addEventListener', before); else delete globalThis.addEventListener;
    if (media) Object.defineProperty(globalThis, 'matchMedia', media); else delete globalThis.matchMedia;
  });
  const own = { ref: 'r1', name: 'Ana', flag: { country: 'br' } }, other = { ref: 'r2', name: 'Vale', flag: { country: 'pt' } }, calls = [], toasts = [],
    network = { enabled: true, connected, name: 'Ana', faction: { ...own, ranking: [own, other] }, chat: { ref: own.ref, faction: [], global: [] },
      answer: () => Promise.resolve({ sent: 'm9' }), command(type, data) { calls.push([type, data]); return this.answer(); } },
    state = { shown: true, blocked: false, time: 600 },
    chat = initChat({ host, network, canvas, toast: (...told) => toasts.push(told), shown: () => state.shown, blocked: () => state.blocked, fieldTime: () => state.time }),
    get = selector => host.querySelector(selector);
  // Above the numbers a test gives the history it tells whole.
  let serial = 100;
  // A message of the field, as the client keeps it and then tells it (network-client.ts `onchat`): live, or with the
  // conversation told whole (`whole`), as on coming back. One to the allies is in the faction's list.
  const arrive = (scope, by, text, of = by === 'Ana' || scope === 'faction' ? 'r1' : 'r2', whole = false) => {
    const message = { id: 'm' + ++serial, scope, of, by, nation: of === 'r1' ? 'Ana' : 'Vale', text, at: 590, ...(scope === 'allies' ? { to: [of === 'r1' ? 'r2' : 'r1'] } : {}) },
      list = scope === 'global' ? 'global' : 'faction';
    network.chat = { ...network.chat, [list]: [...network.chat[list], message] }; chat.receive(whole ? undefined : message); return message;
  };
  // An alliance of the player's faction with Vale's as the faction is told it: accepted, only proposed (false) or none (null).
  const ally = (accepted = true) => {
    network.faction = { ...network.faction, accords: accepted === null ? [] : [{ id: 'a1', kind: 'alliance', from: { ref: own.ref }, to: { ref: other.ref }, acceptedAt: accepted ? 300 : null }] };
    chat.render();
  };
  const lines = () => get('.chat-log').children.map(line => line.querySelector('.chat-text').textContent);
  return { host, canvas, pawn, network, state, chat, calls, toasts, get, arrive, ally, lines, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('Enter brings out the line to write under the history, Enter sends and puts it away, and the keys go back to the field', async t => {
  const { canvas, chat, calls, get, network, flush } = field(t), box = get('#field-chat'), input = get('.chat-input');
  chat.render();
  assert.equal(box.hidden, false); assert.equal(box.dataset.open, 'false', 'the history is there before anything is written');
  assert.equal(input.placeholder, 'Enter para escrever', 'at rest the line to write in is only its hint');
  const opening = canvas.dispatch('keydown', { key: 'Enter' });
  assert(opening.defaultPrevented && opening.stopped, 'the field does not hear the Enter that brings out the line');
  assert.equal(box.dataset.open, 'true'); assert.equal(document.activeElement, input); assert.equal(input.placeholder, 'Mensagem para a sua facção');
  for (const key of ['m', 'a', 'Delete', '1', ' ']) assert(input.dispatch('keydown', { key }).stopped, `${key} is the draft's, not the field's`);
  input.value = '  Vamos pelo norte  ';
  const typing = input.dispatch('keydown', { key: 'Enter', isComposing: true });
  assert(!typing.defaultPrevented); assert.equal(calls.length, 0, 'a word still being composed is not sent');
  input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual(calls, [['chat', { scope: 'faction', text: 'Vamos pelo norte' }]]);
  assert.equal(input.value, ''); assert.equal(box.dataset.open, 'false'); assert.equal(document.activeElement, canvas);
  // An empty line is put away with nothing sent; a click on the line at rest brings it out too.
  canvas.dispatch('keydown', { key: 'Enter' }); input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.equal(calls.length, 1); assert.equal(box.dataset.open, 'false');
  input.focus(); input.dispatch('focus'); assert.equal(box.dataset.open, 'true'); assert.equal(document.activeElement, input);
  input.value = 'Alguém tem ferro?'; input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual(calls[1], ['chat', { scope: 'faction', text: 'Alguém tem ferro?' }]);
  assert.equal(network.chat.faction.length, 0, 'the box keeps nothing of its own: the field tells the message back');
});

test('Tab, or a click on the channel, changes where the player speaks, in the line while writing and from the field at rest', async t => {
  const { canvas, chat, calls, get, flush } = field(t), box = get('#field-chat'), input = get('.chat-input'), channel = get('.chat-channel');
  chat.render();
  assert.deepEqual([channel.textContent, channel.dataset.scope, channel.getAttribute('title')], ['Facção', 'faction', 'Trocar para Global · Tab']);
  chat.open(); input.value = 'Alguém tem ferro?';
  const tab = input.dispatch('keydown', { key: 'Tab' });
  assert(tab.defaultPrevented && tab.stopped, 'Tab changes the channel and neither leaves the line nor reaches the field');
  assert.deepEqual([channel.textContent, channel.dataset.scope, input.placeholder], ['Global', 'global', 'Mensagem para todos no campo']);
  assert.equal(document.activeElement, input); assert.equal(input.value, 'Alguém tem ferro?', 'the draft goes with it');
  input.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(channel.textContent, 'Facção', 'with two channels, Shift+Tab is the other one too');
  channel.click(); assert.equal(channel.textContent, 'Global'); assert.equal(box.dataset.open, 'true'); assert.equal(document.activeElement, input);
  input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual(calls, [['chat', { scope: 'global', text: 'Alguém tem ferro?' }]]);
  assert.equal(channel.textContent, 'Global', 'the channel stays chosen for the next line');
  // At rest, the channel changes and the keys stay with the field; Tab over the field is not the box's.
  channel.click(); assert.equal(channel.textContent, 'Facção'); assert.equal(box.dataset.open, 'false'); assert.equal(document.activeElement, canvas);
  assert(!canvas.dispatch('keydown', { key: 'Tab' }).stopped); assert.equal(channel.textContent, 'Facção');
});

test('with an alliance the channel goes Facção, Aliados, Global, and back to Facção once the alliance is over', async t => {
  const { canvas, chat, calls, get, ally, flush } = field(t), input = get('.chat-input'), channel = get('.chat-channel'),
    shown = () => [channel.textContent, channel.dataset.scope, channel.getAttribute('title')];
  chat.render(); ally(false);
  assert.deepEqual(shown(), ['Facção', 'faction', 'Trocar para Global · Tab'], 'an alliance only proposed is no ally yet');
  ally();
  assert.deepEqual(shown(), ['Facção', 'faction', 'Trocar para Aliados · Tab']);
  chat.open(); input.value = 'Juntos pelo vale';
  input.dispatch('keydown', { key: 'Tab' });
  assert.deepEqual([...shown(), input.placeholder], ['Aliados', 'allies', 'Trocar para Global · Tab', 'Mensagem para a sua facção e os aliados']);
  input.dispatch('keydown', { key: 'Tab' }); assert.deepEqual(shown(), ['Global', 'global', 'Trocar para Facção · Tab']);
  input.dispatch('keydown', { key: 'Tab' }); assert.equal(channel.textContent, 'Facção');
  input.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(channel.textContent, 'Global', 'Shift+Tab goes back');
  input.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(channel.textContent, 'Aliados');
  assert.equal(input.value, 'Juntos pelo vale', 'the draft goes with it');
  input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual(calls, [['chat', { scope: 'allies', text: 'Juntos pelo vale' }]]);
  channel.click(); channel.click(); channel.click(); assert.equal(channel.textContent, 'Aliados', 'a click goes the same way');
  assert.equal(document.activeElement, canvas);
  // The alliance is over: Aliados is Facção again, and out of the turn.
  ally(null);
  assert.deepEqual(shown(), ['Facção', 'faction', 'Trocar para Global · Tab']);
  chat.open(); assert.equal(input.placeholder, 'Mensagem para a sua facção');
  input.dispatch('keydown', { key: 'Tab' }); assert.equal(channel.textContent, 'Global');
  input.dispatch('keydown', { key: 'Tab' }); assert.equal(channel.textContent, 'Facção');
});

test('Escape puts the line away with the draft kept and gives the keys back to the field; Enter elsewhere is not the box\'s', t => {
  const { host, canvas, pawn, state, chat, get, calls } = field(t), box = get('#field-chat'), input = get('.chat-input');
  chat.render(); chat.open();
  input.value = 'Rascunho';
  const escape = input.dispatch('keydown', { key: 'Escape' });
  assert(escape.defaultPrevented && escape.stopped, 'Escape is the box\'s alone: the field keeps its selection');
  assert.equal(box.dataset.open, 'false'); assert.equal(document.activeElement, canvas); assert.equal(input.value, 'Rascunho'); assert.equal(calls.length, 0);
  canvas.dispatch('keydown', { key: 'Enter' }); assert.equal(input.value, 'Rascunho', 'the draft is there when it comes out again');
  chat.close(); assert.equal(document.activeElement, canvas);
  assert(!pawn.dispatch('keydown', { key: 'Enter' }).stopped, 'Enter on a button presses the button'); assert.equal(box.dataset.open, 'false');
  state.blocked = true; canvas.dispatch('keydown', { key: 'Enter' }); assert.equal(box.dataset.open, 'false', 'a works being placed keeps its Enter');
  state.blocked = false; canvas.dispatch('keydown', { key: 'Enter', ctrlKey: true }); assert.equal(box.dataset.open, 'false');
  host.inert = true; canvas.dispatch('keydown', { key: 'Enter' }); assert.equal(box.dataset.open, 'false', 'nor while a panel is open over the field');
  host.inert = false; chat.open(); host.inert = true; chat.render();
  assert.equal(box.dataset.open, 'false', 'a panel that opens puts the line away'); assert.equal(box.hidden, false, 'the history stays, under it');
  host.inert = false;
  // A press elsewhere puts it away, where it pressed.
  chat.open(); pawn.focus(); canvas.dispatch('pointerdown'); assert.equal(box.dataset.open, 'false'); assert.equal(document.activeElement, pawn);
  // Off the field — in the workshop, in a test — there is no box, and the line goes with it.
  chat.open(); state.shown = false; chat.render(); assert(box.hidden); assert.equal(box.dataset.open, 'false');
  canvas.dispatch('keydown', { key: 'Enter' }); assert.equal(box.dataset.open, 'false');
});

test('one history holds both channels in the order the field took them, each line tagged with its channel, and its lines are text', t => {
  const { chat, network, arrive, get, lines } = field(t), log = get('.chat-log');
  // Told whole, the two channels interleave by the count of the field, whatever list each came in.
  network.chat = { ref: 'r1', faction: [{ id: 'm2', scope: 'faction', of: 'r1', by: 'Bia', nation: 'Ana', text: 'segunda', at: 1 }],
    global: [{ id: 'm1', scope: 'global', of: 'r2', by: 'Duda', nation: 'Vale', text: 'primeira', at: 1 },
      { id: 'm10', scope: 'global', of: 'r2', by: 'Duda', nation: 'Vale', text: 'terceira', at: 2 }] };
  chat.receive();
  assert.deepEqual(lines(), ['primeira', 'segunda', 'terceira']);
  arrive('faction', 'Caio', 'plano'); const first = arrive('global', 'Duda', '<img src=x>texto');
  assert.deepEqual(lines().slice(-2), ['plano', '<img src=x>texto'], 'what comes goes at the foot, from either channel');
  const [faction, global] = log.children.slice(-2);
  assert.equal(global.dataset.id, first.id); assert.equal(global.dataset.scope, 'global'); assert.equal(faction.dataset.scope, 'faction');
  assert.equal(global.querySelector('.chat-scope').textContent, 'Global'); assert.equal(faction.querySelector('.chat-scope').textContent, 'Facção');
  assert.equal(global.querySelector('.chat-text').textContent, '<img src=x>texto'); assert.equal(global.querySelector('img'), null);
  assert.equal(global.querySelector('.chat-by').textContent, 'Duda'); assert.equal(global.querySelector('.chat-nation').textContent, 'Vale');
  assert.match(global.querySelector('.chat-flag').innerHTML, /\/flags\/pt\.svg/, 'Global says whose faction it is, by its flag and name');
  assert.equal(faction.querySelector('.chat-nation'), null, 'the faction channel needs neither'); assert.equal(faction.querySelector('.chat-by').textContent, 'Caio');
  assert.match(global.querySelector('.chat-time').textContent, /^\d{2}:\d{2}$/);
  for (let i = 0; i < 12; i++) arrive(i % 2 ? 'global' : 'faction', 'Duda', 'linha ' + i);
  t.mock.timers.tick(10 * 60_000); chat.render();
  assert.equal(log.children.length, 17, 'what was said stays as long as the field keeps it');
  assert.deepEqual(lines().slice(-2), ['linha 10', 'linha 11']);
  // Joining another faction: the old faction's lines go, Global's stay.
  network.chat = { ...network.chat, ref: 'r3', faction: [] }; chat.receive();
  assert.deepEqual([...new Set(log.children.map(line => line.dataset.scope))], ['global']); assert.equal(log.children.length, 9);
  // A click on what was said brings out the line to write in.
  log.children[0].click(); assert.equal(get('#field-chat').dataset.open, 'true'); assert.equal(document.activeElement, get('.chat-input'));
});

test('what was said to the allies is in the one history, tagged Aliados, with the flag and name of the writer\'s faction', t => {
  const { chat, network, arrive, get, lines } = field(t), log = get('.chat-log');
  chat.render();
  arrive('faction', 'Bia', 'nossa'); const theirs = arrive('allies', 'Duda', 'deles'); arrive('global', 'Duda', 'de todos');
  const ours = arrive('allies', 'Ana', 'nossa aos aliados');
  assert.deepEqual(lines(), ['nossa', 'deles', 'de todos', 'nossa aos aliados']);
  assert.deepEqual(log.children.map(line => line.querySelector('.chat-scope').textContent), ['Facção', 'Aliados', 'Global', 'Aliados']);
  const [, ally, , own] = log.children;
  assert.equal(ally.dataset.id, theirs.id); assert.equal(ally.dataset.scope, 'allies'); assert.equal(ally.querySelector('.chat-by').textContent, 'Duda');
  assert.equal(ally.querySelector('.chat-nation').textContent, 'Vale'); assert.match(ally.querySelector('.chat-flag').innerHTML, /\/flags\/pt\.svg/);
  assert.equal(own.dataset.id, ours.id); assert.equal(own.querySelector('.chat-nation').textContent, 'Ana');
  assert.match(own.querySelector('.chat-flag').innerHTML, /\/flags\/br\.svg/, 'the player\'s own faction is named to the allies too');
  // Told whole, the faction's list holds both of its channels, shown in the order the field took them.
  network.chat = { ref: 'r1', global: [], faction: [{ id: 'm2', scope: 'allies', of: 'r2', to: ['r1'], by: 'Duda', nation: 'Vale', text: 'segunda', at: 1 },
    { id: 'm1', scope: 'faction', of: 'r1', by: 'Bia', nation: 'Ana', text: 'primeira', at: 1 }] };
  chat.receive();
  assert.deepEqual(lines(), ['primeira', 'segunda']);
});

test('a history told before the time of the field is known is dated once it is', t => {
  const { chat, network, state, get } = field(t), time = () => get('.chat-log').children.map(line => line.querySelector('.chat-time').textContent);
  state.time = null;
  network.chat = { ref: 'r1', faction: [{ id: 'm1', scope: 'faction', of: 'r1', by: 'Bia', nation: 'Ana', text: 'cedo', at: 590 }], global: [] };
  chat.receive(); assert.deepEqual(time(), ['']);
  state.time = 600; chat.render(); assert.match(time()[0], /^\d{2}:\d{2}$/);
});

test('the history keeps its place while the player reads back in it, and the player\'s own message takes it to its foot', t => {
  const { chat, arrive, get } = field(t), log = get('.chat-log');
  chat.render();
  Object.assign(log, { scrollHeight: 1000, clientHeight: 160, scrollTop: 840 });
  arrive('faction', 'Bia', 'no pé'); assert.equal(log.scrollTop, 1000, 'at its foot, it follows what comes');
  log.scrollTop = 200; log.dispatch('scroll'); arrive('global', 'Bia', 'mais uma'); assert.equal(log.scrollTop, 200);
  arrive('global', 'Ana', 'minha'); assert.equal(log.scrollTop, 1000);
});

test('on a computer nothing is counted, as everything said is in view', t => {
  const { chat, arrive, get } = field(t), toggle = get('.chat-toggle');
  chat.render(); arrive('faction', 'Bia', 'um'); arrive('global', 'Duda', 'dois');
  assert.equal(toggle.querySelector('.chat-unread').textContent, ''); assert.equal(toggle.getAttribute('aria-label'), 'Conversa');
});

test('on a phone a button counts what came while it was shut and opens the conversation, which stays open for the next line', async t => {
  const { canvas, chat, network, arrive, get, lines, calls, flush } = field(t, { phone: true }), box = get('#field-chat'), toggle = get('.chat-toggle'),
    total = toggle.querySelector('.chat-unread'), input = get('.chat-input');
  network.chat = { ref: 'r1', faction: [{ id: 'm90', scope: 'faction', of: 'r1', by: 'Bia', nation: 'Ana', text: 'antiga', at: 1 }], global: [] };
  chat.receive(); chat.render();
  assert.equal(total.textContent, '', 'the history told on arriving is read');
  arrive('faction', 'Bia', 'um'); arrive('allies', 'Duda', 'aliada'); arrive('global', 'Duda', 'dois'); arrive('global', 'Ana', 'minha');
  assert.equal(total.textContent, '3', 'the three channels, but not the player\'s own'); assert.equal(toggle.getAttribute('aria-label'), 'Conversa: 3 não lidas');
  assert.deepEqual(lines(), [], 'shut, nothing is drawn');
  get('.chat-log').click(); assert.equal(box.dataset.open, 'false');
  toggle.click();
  assert.equal(box.dataset.open, 'true'); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.notEqual(document.activeElement, input, 'the keyboard comes up only when the line is touched');
  assert.deepEqual(lines(), ['antiga', 'um', 'aliada', 'dois', 'minha']); assert.equal(total.textContent, '');
  arrive('global', 'Duda', 'lida aberta'); assert.equal(total.textContent, '', 'open, what comes is read');
  input.value = 'Já vou'; input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual(calls, [['chat', { scope: 'faction', text: 'Já vou' }]]); assert.equal(box.dataset.open, 'true');
  get('.chat-close').click(); assert.equal(box.dataset.open, 'false'); assert.equal(document.activeElement, canvas);
  assert.deepEqual(lines(), []);
  arrive('faction', 'Bia', 'última'); arrive('allies', 'Duda', 'outra aliada');
  for (let i = 0; i < 120; i++) arrive('global', 'Duda', 'muitas ' + i);
  assert.equal(toggle.getAttribute('aria-label'), 'Conversa: 122 não lidas'); assert.equal(total.textContent, '99+');
  // Joining another faction: what came of the old one, to it or to its allies, is no longer counted, and its conversation starts read.
  network.chat = { ...network.chat, ref: 'r3', faction: [] }; chat.receive();
  network.chat = { ...network.chat, faction: [{ id: 'm999', scope: 'faction', of: 'r3', by: 'Eva', nation: 'Norte', text: 'bem-vindo', at: 2 }] }; chat.receive();
  assert.equal(toggle.getAttribute('aria-label'), 'Conversa: 120 não lidas');
});

test('a refused message keeps the line out with its draft and says why, briefly, in Portuguese', async t => {
  const { chat, network, calls, get, toasts, flush } = field(t, { connected: false }), input = get('.chat-input'), status = get('.chat-status');
  chat.render(); chat.open();
  assert.equal(status.textContent, 'Sem conexão com o campo.');
  input.value = 'Oi'; input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.equal(calls.length, 0); assert.equal(get('#field-chat').dataset.open, 'true'); assert.equal(input.value, 'Oi');
  network.connected = true; network.faction = null; chat.render(); assert.equal(status.textContent, 'Você ainda não tem facção.');
  network.faction = { ref: 'r1', ranking: [] }; chat.render(); assert.equal(status.textContent, '');
  input.value = 'x'.repeat(SOCIAL_LIMITS.text); input.dispatch('input'); assert.equal(status.textContent, `Limite de ${SOCIAL_LIMITS.text} caracteres.`);
  input.value = 'Rápido demais';
  network.answer = () => Promise.reject(new Error('Aguarde um instante para enviar outra mensagem.'));
  input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.equal(status.textContent, 'Aguarde um instante para enviar outra mensagem.'); assert.equal(input.value, 'Rápido demais');
  assert.equal(get('#field-chat').dataset.open, 'true');
  // Put away before the field answered, the refusal is told by a notice.
  let refuse; network.answer = () => new Promise((_, reject) => { refuse = reject; });
  input.dispatch('keydown', { key: 'Enter' }); input.dispatch('keydown', { key: 'Escape' });
  refuse(new Error('A conexão com o campo caiu.')); await flush();
  assert.deepEqual(toasts, [['A conexão com o campo caiu.', true]]); assert.equal(input.value, 'Rápido demais');
});

test('a line whose answer was lost, but which the field took, is not left to be sent twice', async t => {
  const { canvas, chat, network, calls, get, arrive, lines, flush } = field(t), box = get('#field-chat'), input = get('.chat-input'), status = get('.chat-status');
  chat.render();
  arrive('global', 'Ana', 'Olá');
  // The connection falls after the field took the line: the page comes back and is told the conversation whole.
  network.answer = () => Promise.reject(new Error('A conexão com o campo caiu.'));
  chat.open(); input.dispatch('keydown', { key: 'Tab' }); input.value = 'Olá'; input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual([box.dataset.open, input.value, status.textContent], ['true', 'Olá', 'A conexão com o campo caiu.'], 'an older line of the same words is not this one');
  arrive('faction', 'Ana', 'Olá', 'r1', true);
  assert.equal(input.value, 'Olá', 'nor are the same words on the other channel');
  arrive('global', 'Ana', 'Olá', 'r1', true);
  assert.deepEqual([box.dataset.open, input.value, status.textContent, document.activeElement], ['false', '', '', canvas]);
  assert.equal(lines().filter(text => text === 'Olá').length, 3);
  // Told live before the answer was lost; and a draft changed since stays.
  network.answer = () => { arrive('global', 'Ana', 'Já vou'); return Promise.reject(new Error('O campo demorou a responder. Tente de novo.')); };
  chat.open(); input.value = 'Já vou'; input.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual([box.dataset.open, input.value, status.textContent], ['false', '', '']);
  network.answer = () => Promise.reject(new Error('A conexão com o campo caiu.'));
  chat.open(); input.value = 'Mais uma'; input.dispatch('keydown', { key: 'Enter' }); await flush(); input.value = 'Mais uma coisa';
  arrive('global', 'Ana', 'Mais uma');
  assert.deepEqual([box.dataset.open, input.value, status.textContent], ['true', 'Mais uma coisa', '']);
  assert.equal(calls.length, 3);
});
