import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkClient } from '../src/network-client.ts';
import { SOCIAL_LIMITS } from '../src/faction-social.ts';
import { NETWORK_VERSION, FrameWriter, FrameReader, difference, merged, retell } from '../src/network-protocol.ts';
import { controlContext } from '../src/ui-model.ts';
import { FramePresentation } from '../src/presentation.ts';
import { SoundSystem } from '../src/audio.ts';
import { packShots } from '../src/shots.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';
import { Publication } from '../server/publication.ts';
import { Fog, chapters } from '../server/fog.ts';
import { welcomeMessage, factionView, fieldUnit, squadView, drawingActor, drawingWheel, manufactureReceipt } from './helpers/network-fixtures.js';

// A browser as the client needs it: the storage of the browser, shared by its tabs, and a socket that keeps what it was sent.
function browser(t, kept = {}) {
  const store = initial => { const values = new Map(Object.entries(initial));
      return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }; },
    sockets = [], before = Object.getOwnPropertyDescriptors(globalThis), names = ['localStorage', 'WebSocket', 'location', 'document', 'window'];
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
  }
  const local = store(kept), tab = () => {
    for (const [name, value] of Object.entries({ localStorage: local, WebSocket: Socket, location: { protocol: 'http:', host: 'field' } }))
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  t.after(() => { for (const name of names) if (before[name]) Object.defineProperty(globalThis, name, before[name]); else delete globalThis[name]; });
  // The client says hello and the field answers with a seat, under the name it goes by.
  const seat = (client, token, faction = null, name = 'Ana', persistenceFailed = false) => {
    const socket = sockets.at(-1); socket.onopen();
    const hello = socket.sent.at(-1);
    socket.onmessage({ data: JSON.stringify(welcomeMessage({ playerId: 'p-' + token, token, name, selected: null,
      faction: faction ?? {}, actors: [], persistenceFailed })) });
    clearInterval(client.heartbeat);
    return hello;
  };
  return { local, tab, seat, sockets };
}

function pageUpdates(t, fetcher, hidden = false) {
  const env = browser(t); env.tab();
  const document = Object.assign(new EventTarget(), { hidden,
    querySelector: selector => selector === 'meta[name="impacto-page"]' ? { content: 'aaaaaaaaaaaaaaaa' } : null }), window = new EventTarget();
  for (const [name, value] of Object.entries({ document, window }))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.mock.method(globalThis, 'fetch', fetcher);
  return { ...env, document, window };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('an explicit player origin uses the same client without replacing the browser location', t => {
  const { tab, sockets } = browser(t); tab();
  const client = new NetworkClient(new URL('https://player-field.example:9443'));
  t.after(() => { client.enabled = false; client.socket?.onclose({ code: 1000 }); });
  client.connect('Ana');
  assert.equal(sockets[0].url, 'wss://player-field.example:9443/world');
  assert.equal(globalThis.location.host, 'field');
});

test('remote fields can read and change only the seat for their own origin', t => {
  const primary = 'impacto.network.seat', community = primary + ':https://community.example';
  const { local, tab, seat, sockets } = browser(t, { [primary]: 'local-secret', [community]: 'remote-secret' });
  tab();
  const client = new NetworkClient();
  client.build = 'this-page';
  t.after(() => client.cancelEntry());
  const remote = new URL('https://community.example');
  client.connect('Ana', '', remote);
  sockets[0].onopen();
  assert.equal(sockets[0].sent[0].token, 'remote-secret');
  assert.equal(sockets[0].sent[0].build, undefined);
  sockets[0].onmessage({ data: JSON.stringify({ type: 'reply', error: 'Chave inválida.', unknownKey: true }) });
  assert.equal(local.getItem(primary), 'local-secret');
  assert.equal(local.getItem(community), null);
  const other = new URL('https://community.example:8443');
  client.connect('Ana', '', other);
  assert.equal(seat(client, 'other-port-secret').token, '');
  assert.equal(local.getItem(primary + ':' + other.origin), 'other-port-secret');
  assert.equal(local.getItem(primary), 'local-secret');
});

test('untrusted state deltas cannot supply inherited data or expand sparse arrays', () => {
  assert.throws(() => merged({}, JSON.parse('{"__proto__":{"inherited":true}}')), /inválida/);
  assert.throws(() => merged([1], { $at: { 1_000_000: 3 } }), /inválida/);
  assert.deepEqual(merged([1, 2], { $at: { 1: 3 } }), [1, 3]);
});

test('a repeated connection attempt retires its previous socket before opening another', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { tab, sockets } = browser(t); tab();
  const client = new NetworkClient();
  t.after(() => { client.enabled = false; client.socket?.onclose({ code: 1000 }); });
  client.connect('Ana'); const previous = sockets[0];
  client.connect('Ana');
  assert.equal(previous.readyState, 3, 'a superseded connection must not remain on the field');
  assert.equal(sockets.length, 2);
  previous.onclose({ code: 4001 });
  assert.equal(client.phase, 'connecting', 'the retired connection cannot take the new page out of the field');
});

test('a control command that cannot be sent immediately releases its input hold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(); client.connect('Ana'); seat(client, 'seat-1');
  t.after(() => { client.enabled = false; client.socket?.onclose({ code: 1000 }); });
  client.squad = squadView({ manual: 'c1' }); client.told.squad = { squad: client.squad, selected: null };
  client.socket.send = () => { throw new Error('transport refused'); };
  await assert.rejects(client.command('squad', { order: 'control', id: 'c2' }), /transport refused/);
  assert.equal(client.manualActorId, 'c1', 'the unchanged vehicle remains available without waiting for a reply timeout');
});

test('an unsent weapon setup is included again in the next successful input', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(); client.connect('Ana'); seat(client, 'seat-1');
  t.after(() => { client.enabled = false; client.socket?.onclose({ code: 1000 }); });
  const socket = client.socket, send = socket.send, weapon = { id: 'cannon', componentId: 'gun-1', trajectory: 'direct' };
  socket.send = () => { throw new Error('transport refused'); };
  assert.throws(() => client.send('aim', { aim: { x: 10, y: 2 }, weapon }), /transport refused/);
  socket.send = send; client.send('aim', { aim: { x: 11, y: 2 }, weapon });
  assert.deepEqual(socket.sent.at(-1).weapon, weapon, 'the server has not received the failed setup');
});

test('the workshop without a field connection observes a ready page release but not its current version', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let version = 'aaaaaaaaaaaaaaaa', requests = 0;
  const client = new NetworkClient(), updates = [];
  t.after(() => client.stopUpdates());
  const { sockets } = pageUpdates(t, async () => { requests++; return { ok: true, json: async () => ({ update: { version, ready: true } }) }; });
  client.watchUpdates(value => updates.push(value)); await settled();
  assert.equal(requests, 1); assert.deepEqual(updates, []);
  version = 'bbbbbbbbbbbbbbbb'; t.mock.timers.tick(30000); await settled();
  assert.equal(requests, 2); assert.deepEqual(updates, [version]);
  assert.equal(client.enabled, false); assert.equal(client.connected, false); assert.equal(sockets.length, 0);
});

test('an unready backend, offline request, HTTP error and abort deadline are not page updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply = 'unready', signal;
  const client = new NetworkClient(), updates = []; t.after(() => client.stopUpdates());
  pageUpdates(t, async (_url, options) => {
    signal = options.signal;
    if (reply === 'offline') throw new TypeError('offline');
    if (reply === 'waiting') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return { ok: reply !== '404', json: async () => ({ update: { version: 'bbbbbbbbbbbbbbbb', ready: false } }) };
  });
  client.watchUpdates(value => updates.push(value)); await settled();
  for (reply of ['offline', '404']) { await client.checkUpdates(); assert.deepEqual(updates, []); }
  reply = 'waiting'; const pending = client.checkUpdates(); t.mock.timers.tick(5000); await pending;
  assert.equal(signal.aborted, true); assert.deepEqual(updates, []);
});

test('visibility and online events share one poll and a stopped monitor discards an already delivered late response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0, finish, signal;
  const client = new NetworkClient(), updates = [];
  t.after(() => client.stopUpdates());
  const { document, window } = pageUpdates(t, async (_url, options) => {
    signal = options.signal; requests++;
    return { ok: true, json: () => requests === 1
      ? { update: { version: 'aaaaaaaaaaaaaaaa', ready: true } }
      : new Promise(resolve => { finish = () => resolve({ update: { version: 'bbbbbbbbbbbbbbbb', ready: true } }); }) };
  }, true);
  client.watchUpdates(value => updates.push(value)); t.mock.timers.tick(60000); await settled(); assert.equal(requests, 0);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); await settled();
  assert.equal(requests, 1);
  t.mock.timers.tick(29999); await settled(); assert.equal(requests, 1);
  t.mock.timers.tick(1); await settled(); assert.equal(requests, 2);
  client.stopUpdates(); assert.equal(signal.aborted, true); finish(); await settled();
  assert.deepEqual(updates, [], 'a response already received before stop cannot notify the closed page monitor');
  document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online'));
  t.mock.timers.tick(90000); await settled(); assert.equal(requests, 2, 'no listener or second scheduled poll survives stop');
});

test('chat appends only new messages, replaces faction history on transfer, and reconnect never resends a lost message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat } = browser(t); tab();
  // The conversation has a listener of its own: told whole (nothing) or by the message that came, never as the faction.
  const client = new NetworkClient(), told = [], factions = [];
  client.onchat = item => told.push(item ? item.id : 'whole'); client.onfaction = () => factions.push(client.faction.ref);
  client.connect('Ana'); seat(client, 'seat-1', { ref: 'f1' });
  assert.deepEqual(told.splice(0), ['whole']);
  const receive = message => client.socket.onmessage({ data: JSON.stringify(message) }),
    privateMessage = { id: 'm1', scope: 'faction', of: 'f1', by: 'Bia', nation: 'Vale', text: 'Só da facção.', at: 1 };
  receive({ type: 'chat-history', ref: 'f1', messages: [privateMessage] });
  receive({ type: 'chat', message: privateMessage }); assert.equal(client.chat.faction.length, 1);
  receive({ type: 'chat', message: { ...privateMessage, id: 'm2', of: 'f2' } }); assert.equal(client.chat.faction.length, 1);
  assert.deepEqual(told.splice(0), ['whole'], 'a message already had or of another faction is not told');
  // What was said to allies goes in the faction's list: the faction's own, or an ally's that names it.
  const allied = { ...privateMessage, scope: 'allies', of: 'f2', to: ['f1', 'f3'] };
  receive({ type: 'chat', message: { ...allied, id: 'm3' } }); receive({ type: 'chat', message: { ...allied, id: 'm4', of: 'f1', to: ['f2'] } });
  receive({ type: 'chat', message: { ...allied, id: 'm5', to: ['f3'] } }); receive({ type: 'chat', message: { ...allied, id: 'm3' } });
  assert.deepEqual(client.chat.faction.map(m => m.id), ['m1', 'm3', 'm4']); assert.equal(client.chat.global.length, 0);
  assert.deepEqual(told.splice(0), ['m3', 'm4'], 'nor is one between other factions');
  for (let i = 0; i <= SOCIAL_LIMITS.history; i++) receive({ type: 'chat', message: { ...privateMessage, id: 'g' + i, scope: 'global' } });
  assert.equal(client.chat.global.length, SOCIAL_LIMITS.history);
  assert.deepEqual(told.splice(0), Array.from({ length: SOCIAL_LIMITS.history + 1 }, (_, i) => 'g' + i));
  const baseline = client.told.faction, global = client.chat.global;
  receive({ type: 'faction', changes: { ref: 'f2' } });
  assert.deepEqual(client.chat.faction, []); assert.equal(client.chat.ref, 'f2'); assert.equal(client.chat.global, global); assert.equal(baseline.ref, 'f1');
  receive({ type: 'chat-history', ref: 'f2', messages: [] }); assert.equal(client.chat.global, global);
  assert.deepEqual(told.splice(0), ['whole', 'whole']); assert.deepEqual(factions, ['f2'], 'the faction hears only of the faction');
  const pending = client.command('chat', { scope: 'faction', text: 'Sem resposta.' }); client.socket.onclose({ code: 1006 });
  await assert.rejects(pending, /A conexão com o campo caiu/);
  t.mock.timers.tick(800); client.socket.onopen();
  assert.deepEqual(client.socket.sent.map(message => message.type), ['hello']);
});

test('a lost connection retains the field and resumes the same seat without replaying old controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat, sockets } = browser(t); tab();
  const client = new NetworkClient(), welcomed = []; client.onwelcome = welcome => welcomed.push(welcome.reconnected);
  client.connect('Ana'); seat(client, 'seat-1', { id: 'f1', stock: { ferro: 100 } });
  client.squad = squadView({ manual: 'c1', units: [{ id: 'c1' }] }); client.selected = 'c1';
  const before = client.socket, pending = client.command('drive', { throttle: 1 });
  before.onclose({ code: 1006 });
  await assert.rejects(pending, /A conexão com o campo caiu/);
  assert.equal(client.enabled, true); assert.equal(client.connected, false);
  assert.equal(client.faction.id, 'f1'); assert.equal(client.squad.manual, 'c1'); assert.equal(client.selected, 'c1');
  t.mock.timers.tick(800); const fresh = client.socket; fresh.onopen();
  assert.equal(fresh.sent[0].token, 'seat-1');
  client.send('drive', { throttle: 1 }); client.aim({ x: 40, y: 2 }, {});
  assert.equal(fresh.sent.length, 1, 'only hello is sent before the session is accepted');
  before.onopen(); before.onerror(); before.onclose({ code: 4001 });
  assert.equal(client.socket, fresh, 'a late old socket cannot affect the new attempt');
  seat(client, 'seat-1', { id: 'f1' });
  assert.deepEqual(welcomed, [false, true]); assert.equal(client.connected, true); assert.equal(sockets.length, 2);
  assert.equal(client.squad.units[0].id, 'c1', 'the first resumed frame still has a squad, until its fresh metadata arrives');
  fresh.onmessage({ data: JSON.stringify({ type: 'squad', changes: { squad: squadView({ manual: null, units: [{ id: 'c1' }] }), selected: 'c1' } }) });
  assert.equal(client.squad.manual, null, 'the resumed squad replaces the old direct-control state');
  assert.equal(client.selected, 'c1');
});

test('accepted control replies close the metadata gap without changing its baseline or retained frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(); client.connect('Ana');
  assert.equal(client.manualActorId, null);
  seat(client, 'seat-1');
  const tell = manual => client.socket.onmessage({ data: JSON.stringify({ type: 'squad',
    changes: { squad: squadView({ manual, units: [{ id: 'a' }, { id: 'b' }] }), selected: manual || 'a' } }) });
  const ask = id => { const promise = client.command('squad', { order: 'control', id }); return { promise, request: client.socket.sent.at(-1).request }; },
    ack = ({ request }) => client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request }) }),
    actors = [{ id: 'a' }, { id: 'b' }], state = { actors, squad: { manual: 'a' } },
    context = () => controlContext({ mode: 'test' }, state, client);
  let notices = 0; client.onsquad = () => notices++;
  assert.equal(client.manualActorId, null, 'a welcome is not a grant of direct control');
  tell('a'); assert.equal(client.manualActorId, 'a');
  const baseline = client.told.squad, release = ask(null);
  assert.equal(client.squad.manual, 'a', 'sending a control order does not optimistically change the squad');
  assert.equal(client.manualActorId, null, 'input waits while an actual control order is on its way');
  assert.equal(context().manual, false, 'the old rendered frame cannot send inputs even before the release ACK');
  ack(release); await release.promise;
  assert.equal(client.manualActorId, null, 'the accepted release removes permission before metadata and a binary frame');
  assert.equal(context().manual, false); assert.equal(context().actorId, 'a'); assert.equal(context().actor, actors[0]);
  assert.equal(state.squad.manual, 'a', 'the previous frame retains its geometry and armament identity');
  assert.equal(client.told.squad, baseline); assert.equal(baseline.squad.manual, 'a', 'ACK does not rewrite the delta baseline');
  assert.notEqual(client.squad, baseline.squad); assert.equal(notices, 2);
  tell(null); assert.equal(client.selected, 'a', 'the released construction remains selected');
  const first = ask('a'), next = ask('b');
  assert.equal(client.manualActorId, null, 'pending grants cannot authorize input');
  ack(first); await first.promise; assert.equal(client.squad.manual, 'a');
  assert.equal(client.manualActorId, null, 'an earlier ACK cannot resume input while a later control is pending');
  ack(next); await next.promise; assert.equal(client.manualActorId, 'b', 'successive accepted controls follow the reply order');
  assert.equal(client.told.squad.squad.manual, null, 'successive ACKs still leave the received delta baseline intact');
  assert.equal(context().manual, false, 'the previous frame cannot send its old armament to the newly granted actor');
  assert.equal(context().actorId, 'a'); assert.equal(context().actor, actors[0]);
  tell('b'); state.squad = { manual: 'b' }; assert.equal(context().manual, true);
  const afterMetadata = ask(null);
  tell(null);
  const notified = notices; ack(afterMetadata); await afterMetadata.promise;
  assert.equal(client.manualActorId, null); assert.equal(notices, notified, 'matching metadata before the ACK does not notify twice');
  tell('b'); assert.equal(client.manualActorId, 'b');
  const retained = client.squad;
  client.socket.onclose({ code: 1006 }); assert.equal(client.manualActorId, null);
  t.mock.timers.tick(800); seat(client, 'seat-1');
  assert.equal(client.squad, retained, 'the squad is retained for local selection');
  assert.equal(client.manualActorId, null, 'old squad data does not authorize a new connection');
  const early = ask('a'); ack(early); await early.promise;
  assert.equal(client.manualActorId, null, 'an accepted order still waits for fresh connection metadata');
  tell('a'); assert.equal(client.manualActorId, 'a');
  const refused = client.command('squad', { order: 'control', id: null }),
    rejected = assert.rejects(refused, /recusa de controle/), refusedRequest = client.socket.sent.at(-1).request;
  assert.equal(client.manualActorId, null); tell('b');
  assert.equal(client.manualActorId, null, 'fresh metadata cannot bypass an unanswered control order');
  client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: refusedRequest, error: 'recusa de controle' }) });
  await rejected; assert.equal(client.manualActorId, 'b', 'a refusal resumes the latest received grant without rolling metadata back');
  const interrupted = ask('a'), socket = client.socket, kept = client.squad,
    disconnected = assert.rejects(interrupted.promise, /A conexão com o campo caiu/);
  socket.onclose({ code: 1006 }); await disconnected;
  socket.onmessage({ data: JSON.stringify({ type: 'reply', request: interrupted.request }) });
  assert.equal(client.squad, kept); assert.equal(client.squad.manual, 'b'); assert.equal(client.manualActorId, null);
});

test('a renewed connection bootstraps its own terrain frame and never merges an old socket or baseline', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(), frames = [], previous = new FrameWriter(), renewed = new FrameWriter(),
    packet = (time, terrainSettings) => ({ type: 'frame', events: [], state: { time, terrain: 'world', terrainSettings,
      actors: [], plates: [], modules: [], bodyPanels: [] } }),
    first = { seed: 6173, length: 512000, center: 12 }, next = { seed: 930222, length: 8193, center: 125.5 };
  t.after(() => { previous.close(); renewed.close(); });
  client.onframe = frame => frames.push(frame.state);
  client.connect('Ana'); seat(client, 'seat-1');
  const oldSocket = client.socket;
  oldSocket.onmessage({ data: previous.encode(packet(0, first)) });
  assert.deepEqual(frames[0].terrainSettings, first);
  oldSocket.onclose({ code: 1006 }); t.mock.timers.tick(800);
  const socket = client.socket;
  oldSocket.onmessage({ data: previous.encode(packet(1, first)) });
  assert.equal(frames.length, 1, 'an old socket cannot replace the retained field while reconnecting');
  seat(client, 'seat-1');
  // Both writers start at serial 1. A delta of the new field must not be read
  // against that same number from the old field if its whole frame was missed.
  renewed.encode(packet(10, next));
  socket.onmessage({ data: renewed.encode(packet(11, next)) });
  assert.equal(frames.length, 1); assert.equal(socket.sent.at(-1).type, 'resync');
  socket.onmessage({ data: renewed.encode(packet(12, next), true) });
  assert.deepEqual(frames.at(-1).terrainSettings, next); assert.equal(frames.at(-1).time, 12);
  socket.onmessage({ data: renewed.encode(packet(13, next)) });
  assert.equal(frames.length, 3); assert.deepEqual(frames.at(-1).terrainSettings, next);
  assert.deepEqual(frames[0].terrainSettings, first, 'previously accepted frames remain immutable');
});

test('measured fuel flow reaches own audio as a vehicle-only delta without cold admission or outside disclosure', async t => {
  const publication = new Publication(), fog = new Fog(), appearance = { paint: 'green' },
    wheel = { id: 'truck:wheel', actorId: 'truck', kind: 'wheel', x: 12, y: .5, angle: 0, width: 1, height: 1, health: 100, attached: true },
    snapshot = (time, fuelRate) => ({ time, shared: true, plates: [], bodyPanels: [], modules: [wheel], shots: packShots([]),
      actors: [{ id: 'truck', name: 'Same construction', team: 'own', revision: 7, appearance, facing: 1,
        vehicle: { x: 12, y: 1.5, angle: 0, vx: 19.5, vy: 0, engine: true, traction: 1, chassisId: 'same-hull',
          powerKw: 300, maxSpeed: 20, throttle: .9, brake: 0, driveSpeed: 20, fuelRate } }] }),
    ends = ['own', 'outside'].map(team => {
      const ctx = fakeAudioContext();
      return { team, ctx, writer: new FrameWriter(), reader: new FrameReader(),
        sound: new SoundSystem({ contextFactory: () => ctx, storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() }) };
    }), header = bytes => JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, new DataView(bytes).getUint32(4, true)))),
    turbo = end => end.ctx.nodes.filter(source => source.kind === 'buffer' && source.starts.length && source.buffer?.url === 'engine-turbo.mp3');
  for (const end of ends) { await end.sound.unlock(); end.sound.setActive(true); }
  t.after(() => { for (const end of ends) { end.writer.close(); end.sound.stop(); } });
  const transmit = (time, flow, whole = false) => {
    const raw = snapshot(time, flow), before = JSON.stringify(raw), published = publication.state(raw), parts = chapters(published);
    assert.equal(JSON.stringify(raw), before, 'publication cannot write its read model into the source');
    fog.read({ sight: { outside: [{ actorId: 'truck', channel: 'visual', visible: true, x: 12, y: 1.5, by: 'observer' }] } }, time);
    for (const end of ends) {
      const bytes = end.writer.encode({ type: 'frame', state: fog.tell(published, parts, end.team) }, whole);
      end.header = header(bytes); end.state = end.reader.decode(bytes).state;
      end.ctx.advance(time); end.sound.receive(end.state, []);
      if (end.team === 'outside') {
        assert.equal(Object.hasOwn(end.state.actors[0].vehicle, 'fuelRate'), false);
        assert.equal(JSON.stringify(end.header).includes('fuelRate'), false, 'neither whole nor delta frames disclose flow');
        assert.equal(turbo(end).length, 0, 'outside engines retain no private work inference');
      }
    }
    return published;
  };
  const first = transmit(1, 30, true), own = ends[0], original = own.state, source = turbo(own)[0],
    voice = own.sound.voices.find(value => value.profile === 'engine-turbo'), low = voice.chain.gain.gain.soundTarget;
  assert(source); assert.equal(own.state.actors[0].vehicle.fuelRate, 30);
  const jitter = transmit(1.1, 30.005);
  assert.equal(jitter.actors[0], first.actors[0]); assert.equal(own.header.state.actors, undefined, 'sub-audible float jitter sends no actor delta');
  transmit(1.2, 60);
  assert.deepEqual(own.header.state.actors.with, [{ vehicle: { $set: { fuelRate: 60 } } }], 'the existing open vehicle field needs no whole actor or new schema slot');
  assert.equal(own.state.actors[0].revision, 7); assert.equal(own.state.actors[0].vehicle.chassisId, 'same-hull');
  assert.equal(own.state.actors[0].appearance, original.actors[0].appearance);
  assert.equal(own.state.modules[0], original.modules[0], 'a fuel change leaves retained construction geometry alone');
  assert.equal(turbo(own).length, 1); assert.equal(turbo(own)[0], source); assert.equal(source.stops.length, 0);
  assert(voice.chain.gain.gain.soundTarget > low * 1.5, 'the nested flow update changes effort through the same source');
});

test('short baseline recovery and warm reconnection resume current drive loops, preserving topology, alerts and the private-trial guard', async t => {
  const { tab, seat } = browser(t); tab();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0, shown = true, trial = null;
  t.mock.method(performance, 'now', () => now);
  const client = new NetworkClient(), playback = new FramePresentation(), ctx = fakeAudioContext(),
    sound = new SoundSystem({ contextFactory: () => ctx, storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() }),
    writer = new FrameWriter(), renewed = new FrameWriter(), frames = [], errors = [], ages = [],
    recordings = profile => ctx.nodes.filter(source => source.kind === 'buffer' && source.buffer?.url === `${profile}.mp3` && source.starts.length),
    drive = profile => sound.voices.filter(voice => voice.loop && voice.profile === profile && voice.endAt === Infinity),
    packet = (time, held = false, flow = .4, topology = false, events = []) => ({ type: 'frame', events, state: {
      time, shared: true, plates: [], bodyPanels: [], shots: packShots([]), actors: [
        drawingActor({ id: 'brake', facing: 1, vehicle: { x: 12, y: 1.5, vx: 8, engine: false, traction: 1,
          throttle: held ? 0 : 1, brake: held ? 1 : 0, driveSpeed: held ? 0 : 20 } }),
        drawingActor({ id: 'turbo', facing: 1, vehicle: { x: 12, y: 1.5, vx: 19.5, engine: true, powerKw: 300,
          maxSpeed: 20, traction: 1, throttle: .9, brake: 0, driveSpeed: 20, fuelRate: flow * 90 } }),
        ...(topology ? [drawingActor({ id: 'fixed' })] : []),
      ], modules: [drawingWheel({ id: 'wheel', actorId: 'brake', x: 12, y: .5, width: 1, height: 1, health: 100, attached: true })],
    } }),
    present = () => {
      const sample = playback.present(playback.sample(now));
      if (sample) sound.receive(sample.state, sample.events, { time: sample.time, active: shown });
      return sample;
    },
    deliver = bytes => client.socket.onmessage({ data: bytes });
  t.after(() => {
    client.enabled = false; client.socket?.onclose({ code: 1000 });
    writer.close(); renewed.close(); sound.stop(); assert.deepEqual(errors, []);
  });
  await sound.unlock(); sound.setActive(true);
  client.onerror = issue => errors.push(issue);
  // The main callback's routing boundary; NetworkClient, FrameReader, Presentation and SoundSystem below are real.
  client.onframe = (frame, recovered) => {
    frames.push({ at: now, base: frame.base, recovered });
    if (!client.enabled || trial) return;
    playback.receive(frame.state, frame.events, { now, paused: false, visible: shown });
    if (recovered) { sound.stop({ keepAlerts: true }); playback.rest(now, dt => ages.push(dt)); }
  };
  client.connect('Ana'); seat(client, 'seat-1');
  const deliveries = new Map([[0, writer.encode(packet(1), true)], [25, writer.encode(packet(1.025, false, .4, true), true)]]);
  writer.encode(packet(1.045, false, .4, true)); // lost delta: the next two cannot be decoded against serial 2
  deliveries.set(65, writer.encode(packet(1.065, true, .9, true)));
  deliveries.set(70, writer.encode(packet(1.07, true, .9, true)));
  deliveries.set(90, writer.encode(packet(1.09, true, .9, true, [{ type: 'muzzle', x: 12, y: 1.5, time: 1.07, caliberMm: 25 }]), true));
  deliveries.set(130, writer.encode(packet(1.13, false, .4, true)));
  deliveries.set(200, writer.encode(packet(1.2, true, .9, true)));
  let firstMotor, alert, alertStops;
  for (now = 0; now <= 250; now += 5) {
    ctx.advance(now / 1000);
    if (now === 50) { sound.alert('contact'); alert = recordings('alert-contact')[0]; alertStops = [...alert.stops]; }
    if (deliveries.has(now)) deliver(deliveries.get(now));
    const sample = present();
    if (now === 0) firstMotor = recordings('diesel')[0];
    if (now === 30) assert.equal(firstMotor.stops.length, 0, 'an ordinary full topology frame preserves the motor');
    if (now === 90) {
      assert.equal(sample.time, 1.09, 'the recovered baseline is immediately shown, without the obsolete reserve');
      assert.equal(recordings('brake-air').length, 0, 'recovery cannot replay the retired pneumatic layer');
      for (const profile of ['brake-squeal', 'engine-turbo']) {
        assert.equal(drive(profile).length, 1);
        assert.equal(drive(profile)[0].sources[0].starts[0], .09, 'current held braking/load fades in with the recovered baseline');
      }
      assert.deepEqual(alert.stops, alertStops, 'recovery keeps the original contact tail');
    }
  }
  assert.deepEqual(frames.map(frame => frame.recovered), [false, false, true, false, false]);
  assert.equal(frames[1].base, null); assert.equal(frames[2].base, null);
  assert.equal(client.socket.sent.filter(message => message.type === 'resync').length, 1);
  assert.equal(recordings('gun-auto').length, 0, 'obsolete catch-up events were discarded with the reserve');
  assert.equal(recordings('brake-air').length, 0);
  for (const profile of ['brake-squeal', 'engine-turbo']) {
    assert.equal(drive(profile).length, 1);
    assert.equal(drive(profile)[0].sources[0], recordings(profile).at(-1));
    assert.equal(drive(profile)[0].sources[0].starts[0], .09, 'subsequent pedal/load changes reuse the recovered state loop');
  }
  assert.equal(ages.length, 1); assert(ages[0] > 0 && ages[0] < .25);

  now = 260; ctx.advance(.26);
  const oldSocket = client.socket, beforeReconnect = frames.length;
  oldSocket.onclose({ code: 1006 }); client.open(); seat(client, 'seat-1');
  oldSocket.onmessage({ data: writer.encode(packet(1.27, false), true) });
  assert.equal(frames.length, beforeReconnect, 'late old-socket frames never cross the routing boundary');
  now = 280; ctx.advance(.28); deliver(renewed.encode(packet(1.28, true, .9), true)); present();
  assert.equal(frames.at(-1).recovered, true, 'a warm first frame is marked even with no new rejected delta');
  const resumedMotor = recordings('diesel').at(-1), resumedDrive = ['brake-squeal', 'engine-turbo'].map(profile => {
    assert.equal(drive(profile).length, 1);
    const source = drive(profile)[0].sources[0];
    assert.equal(source.starts[0], .28, 'a warm reconnect starts from the current state, without a new pedal edge');
    return source;
  });
  assert.equal(recordings('brake-air').length, 0);
  now = 290; ctx.advance(.29); deliver(renewed.encode(packet(1.29, true, .9, true), true)); present();
  assert.equal(frames.at(-1).recovered, false); assert.equal(resumedMotor.stops.length, 0, 'normal topology after reconnection stays continuous');
  for (const source of resumedDrive) assert.equal(source.stops.length, 0, 'normal topology preserves the current drive source too');
  oldSocket.onclose({ code: 1006 }); assert.equal(client.connected, true);

  now = 300; ctx.advance(.3); shown = false; sound.setShown(false);
  const hiddenSources = ctx.nodes.filter(source => source.kind === 'buffer' && source.starts.length).length;
  renewed.encode(packet(1.3, true, .9, true));
  now = 320; ctx.advance(.32); deliver(renewed.encode(packet(1.32, true, .9, true)));
  now = 340; ctx.advance(.34); deliver(renewed.encode(packet(1.34, true, .9, true), true));
  assert.equal(frames.at(-1).recovered, true);
  assert.equal(ctx.nodes.filter(source => source.kind === 'buffer' && source.starts.length).length, hiddenSources);
  assert.deepEqual(alert.stops, alertStops);
  now = 380; ctx.advance(.38); shown = true; sound.setShown(true); playback.rest(now);
  assert.equal(present().time, 1.34);
  assert.equal(recordings('brake-air').length, 0);
  for (const profile of ['brake-squeal', 'engine-turbo']) {
    assert.equal(drive(profile).length, 1);
    assert.equal(drive(profile)[0].sources[0].starts[0], .38, 'visibility return plays current braking/load, not suppressed onsets');
  }

  now = 400; ctx.advance(.4); trial = 'terrain';
  const privateState = { ...packet(99).state, shared: false };
  sound.stop({ keepAlerts: true }); playback.receive(privateState, [], { now, paused: false }); present();
  const privateMotor = recordings('diesel').at(-1);
  renewed.encode(packet(1.4, false, .4, true));
  now = 420; ctx.advance(.42); deliver(renewed.encode(packet(1.42, true, .9, true)));
  now = 440; ctx.advance(.44); deliver(renewed.encode(packet(1.44, true, .9, true), true));
  assert.equal(frames.at(-1).recovered, true);
  assert.equal(playback.state, privateState); assert.equal(privateMotor.stops.length, 0, 'public recovery cannot stop or replace a private trial');
});

test('an unavailable field is retried with the same identity instead of ending the session', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { local, tab, seat, sockets } = browser(t, { 'impacto.network.seat': 'seat-1' }); tab();
  const client = new NetworkClient(), leaves = [], issue = 'O campo salvo não pôde ser retomado. Nenhum campo substituto foi criado; sua chave de acesso foi mantida.';
  client.onleave = message => leaves.push(message);
  client.connect('Ana'); const first = client.socket; first.onopen();
  first.onmessage({ data: JSON.stringify({ type: 'reply', error: issue, retryable: true }) });
  const retained = (phase = 'reconnecting') => assert.deepEqual([client.enabled, client.phase, client.issue, client.token, local.getItem('impacto.network.seat')],
    [true, phase, issue, 'seat-1', 'seat-1']);
  retained(); assert.deepEqual(leaves, []);
  t.mock.timers.tick(800); assert.equal(sockets.length, 2); retained('connecting');
  const second = client.socket; second.onopen(); assert.equal(second.sent[0].token, 'seat-1');
  second.onerror(); retained();
  client.retryNow(); assert.equal(sockets.length, 3); retained('connecting');
  assert.equal(seat(client, 'seat-1').token, 'seat-1');
  assert.deepEqual([client.phase, client.issue, local.getItem('impacto.network.seat')], ['connected', '', 'seat-1']);
});

test('a late command reply cannot report an obsolete error or change settings while a newer request is pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(), errors = [];
  client.onerror = issue => errors.push(issue);
  client.connect('Ana'); seat(client, 'seat-1'); client.testTools = true;
  const socket = client.socket, expired = client.command('test', { act: 'speed', factor: 2 }), oldRequest = socket.sent.at(-1).request;
  const timedOut = assert.rejects(expired, /demorou a responder/);
  t.mock.timers.tick(8000); await timedOut;
  const current = client.rename('Bia'), request = socket.sent.at(-1).request;
  const reply = message => socket.onmessage({ data: JSON.stringify({ type: 'reply', ...message }) });
  reply({ request: oldRequest, error: 'Falha do comando anterior.', factor: 2 });
  assert.deepEqual(errors, [], 'an expired command is not a new server-wide error');
  assert.equal(client.testSpeed, 1, 'an expired reply cannot change the current test settings');
  reply({ request, name: 'Bia' }); await current; assert.equal(client.name, 'Bia');
  reply({ request, error: 'Resposta repetida.' }); assert.deepEqual(errors, []);
  reply({ error: 'Aviso atual do campo.' }); assert.deepEqual(errors, ['Aviso atual do campo.']);
});

test('autosave health survives welcomes and updates without consuming command replies or stopping controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat, sockets } = browser(t); tab();
  const client = new NetworkClient(), health = [], errors = [];
  client.onstatus = () => health.push(client.persistenceFailed); client.onerror = issue => errors.push(issue);
  client.connect('Ana'); seat(client, 'seat-1', null, 'Ana', true);
  assert.deepEqual([client.connected, client.persistenceFailed], [true, true]); assert.equal(health.at(-1), true);
  const socket = client.socket, pending = client.command('rename', { name: 'Bia' }), request = socket.sent.at(-1).request;
  socket.onmessage({ data: JSON.stringify({ type: 'reply', persistenceFailed: false }) });
  assert.equal(client.persistenceFailed, false);
  const statuses = health.length;
  socket.onmessage({ data: JSON.stringify({ type: 'reply', persistenceFailed: false }) });
  assert.equal(health.length, statuses, 'unchanged health does not refresh the UI again');
  socket.onmessage({ data: JSON.stringify({ type: 'reply', persistenceFailed: 'true' }) });
  assert.equal(client.persistenceFailed, false, 'only the boolean discriminant changes storage health');
  assert.deepEqual(errors.splice(0), ['Resposta do campo inválida.'], 'the malformed notice is refused at the cold boundary');
  socket.onmessage({ data: JSON.stringify({ type: 'reply', request, name: 'Bia' }) });
  assert.equal((await pending).name, 'Bia'); assert.deepEqual(errors, []);
  socket.onmessage({ data: JSON.stringify({ type: 'reply', persistenceFailed: true }) });
  client.send('drive', { throttle: 1, brake: 0 }); assert.equal(socket.sent.at(-1).type, 'drive');
  socket.onclose({ code: 1006 }); t.mock.timers.tick(800); assert.equal(sockets.length, 2);
  socket.onmessage({ data: JSON.stringify({ type: 'reply', persistenceFailed: false }) });
  assert.equal(client.persistenceFailed, true, 'the old socket cannot clear the last health report');
  seat(client, 'seat-1', null, 'Bia', false);
  assert.deepEqual([client.connected, client.persistenceFailed, client.issue, client.token], [true, false, '', 'seat-1']);
});

test('a required update keeps the session visible and delegates reloading to the page without retrying incompatible code', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat, sockets } = browser(t); tab(); const client = new NetworkClient(), outdated = [];
  client.onoutdated = message => outdated.push(message);
  client.connect('Ana'); seat(client, 'seat-1', { id: 'f1' });
  client.socket.onclose({ code: 1006 }); t.mock.timers.tick(800); client.socket.onopen();
  const error = 'Esta página e o campo usam versões diferentes. Recarregue a página (F5). Se continuar, reinicie o servidor.';
  client.socket.onmessage({ data: JSON.stringify({ type: 'reply', error, outdated: true }) });
  assert.equal(client.enabled, true); assert.equal(client.phase, 'updated'); assert.equal(client.faction.id, 'f1');
  assert.deepEqual(outdated, [error]);
  t.mock.timers.tick(60000); client.retryNow(); assert.equal(sockets.length, 2, 'incompatible code does not reconnect in a loop');
});

test('a seat another device or tab took is only taken back at the player\'s request', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat, sockets } = browser(t); tab(); const client = new NetworkClient(), left = [];
  client.onleave = issue => left.push(issue);
  client.connect('Ana'); seat(client, 'seat-1'); client.socket.onclose({ code: 4001 });
  assert.equal(client.enabled, true); assert.equal(client.phase, 'elsewhere');
  assert.deepEqual([client.issue, left], ['Sua conta entrou em outro aparelho.', ['Sua conta entrou em outro aparelho.']]);
  t.mock.timers.tick(20000); assert.equal(sockets.length, 1);
  client.retryNow(); assert.equal(sockets.length, 2); assert.equal(seat(client, 'seat-1').token, 'seat-1');
});

test('an unanswered handshake has a deadline and manual retry cancels the scheduled attempt', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { tab, seat, sockets } = browser(t); tab(); const client = new NetworkClient(); client.connect('Ana');
  const first = client.socket; first.onopen(); t.mock.timers.tick(10000);
  assert.equal(first.readyState, 3); assert.equal(client.phase, 'reconnecting');
  client.retryNow(); assert.equal(sockets.length, 2); seat(client, 'seat-1');
  t.mock.timers.tick(6000); assert.equal(sockets.length, 2, 'no delayed second connection steals the seat');
});

test('the browser keeps the key of the seat it was given, and every tab and visit after comes with it', t => {
  const { local, tab, seat } = browser(t); tab(); const first = new NetworkClient();
  first.connect('Ana');
  assert.deepEqual(seat(first, 'SEAT1'), { type: 'hello', version: NETWORK_VERSION, name: 'Ana', token: '' });
  assert.equal(local.getItem('impacto.network.seat'), 'SEAT1');
  // The same tab reloaded, another tab, another visit: the seat the browser kept, under the name the seat goes by.
  for (let i = 0; i < 3; i++) {
    tab(); const again = new NetworkClient(); again.connect(null);
    assert.deepEqual(seat(again, 'SEAT1', null, 'Ana B'), { type: 'hello', version: NETWORK_VERSION, name: null, token: 'SEAT1' });
    assert.equal(again.name, 'Ana B');
  }
});

test('a view told as what changed of it is put together into the view itself, whatever changed', () => {
  // Views as a field makes them, one after the other: fields that come, change and go, lists that grow, shrink and change inside.
  let seed = 11; const random = () => (seed = seed * 1103515245 + 12345 >>> 0) / 2 ** 32, pick = list => list[Math.floor(random() * list.length)];
  const value = depth => { const kind = random(); if (depth > 2 || kind < .4) return pick([0, 1, 2.5, -3, 'a', 'b', true, false, null]);
    if (kind < .7) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, () => [pick(['id', 'x', 'units', 'stock', 'name']), value(depth + 1)])); };
  const vary = (old, depth = 0) => {
    if (Array.isArray(old) && random() < .7) return old.map(item => random() < .3 ? vary(item, depth + 1) : item);
    if (old && typeof old === 'object' && !Array.isArray(old) && random() < .7) {
      const next = {}; for (const [key, item] of Object.entries(old)) if (random() < .85) next[key] = random() < .3 ? vary(item, depth + 1) : item;
      if (random() < .2) next[pick(['id', 'x', 'units', 'stock', 'name'])] = value(depth + 1); return next;
    }
    return random() < .5 ? old : value(depth);
  };
  let view = value(0), had = structuredClone(view);
  for (let turn = 0; turn < 2000; turn++) {
    const next = vary(view), said = difference(view, next), got = merged(had, said);
    assert.deepEqual(got, next, `turn ${turn}`); assert.deepEqual(had, view, 'what the reader had is left as it was');
    if (JSON.stringify(view) === JSON.stringify(next)) assert.equal(said, undefined);
    view = next; had = got;
  }
  assert.equal(difference({ a: [1, 2] }, { a: [1, 2] }), undefined);
});

test('unchanged JSON leaves need no serialization and the delta keeps its exact words', t => {
  const view = speed => ({ id: 'f1', units: [{ id: 'c1', speed: 0, order: null }, { id: 'c2', speed, active: false }], stock: { ferro: 7, silica: 3 } }),
    before = { ...view(0), obsolete: 'old' }, next = view(2), values = [], stringify = JSON.stringify,
    spy = t.mock.method(JSON, 'stringify', (...args) => { values.push(args[0]); return stringify(...args); });
  let said;
  try {
    said = difference(before, next);
    assert.equal(difference(undefined, undefined), undefined);
    assert.equal(difference(null, null), undefined);
  } finally { spy.mock.restore(); }
  assert.deepEqual(values, [0, 2], 'only the changed scalar is serialized on each side');
  assert.equal(JSON.stringify(said), '{"units":{"$at":{"1":{"speed":2}}},"$drop":["obsolete"]}');
  assert.deepEqual(merged(before, said), next);
});

test('retell keeps JSON normalization before comparing undefined, null and nonfinite numbers', () => {
  const kept = {}, first = retell(kept, { nullable: null, dropped: 'old', value: NaN, absent: undefined, words: [undefined, Infinity, -Infinity] });
  assert.deepEqual(first, { nullable: null, dropped: 'old', value: null, words: [null, null, null] });
  assert.equal(retell(kept, { nullable: null, dropped: 'old', value: null, words: [null, null, null] }), undefined);
  const said = retell(kept, { nullable: null, dropped: undefined, value: Infinity, words: [null, NaN, 2] });
  assert.equal(JSON.stringify(said), '{"words":{"$at":{"2":2}},"$drop":["dropped"]}');
  assert.deepEqual(merged(first, said), { nullable: null, value: null, words: [null, null, 2] });
  assert.equal(difference(NaN, null), undefined);
  assert.equal(difference(Infinity, -Infinity), undefined);
});

test('the squad and the faction come as what changed of them, and the page has them whole', t => {
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(); client.connect('Ana'); seat(client, 'seat-1');
  const socket = client.socket, squads = {}, factions = {}, sent = [], tell = (type, kept, view) => {
    const changes = retell(kept, view);
    if (changes !== undefined) { const text = JSON.stringify({ type, changes }); sent.push(text.length); socket.onmessage({ data: text }); }
  };
  const unit = id => fieldUnit({ id, value: { ferro: 1200, ligas: 30 }, repair: { ferro: 0, ligas: 0 }, atBase: true, calm: true, still: true, cargo: { ferro: 0, petroleo: 0 } }),
    faction = (units, ferro) => factionView({ id: 'f1', name: 'Facção de Ana', stock: { ferro, ligas: 500 }, base: { x: 10, facing: 1 }, units, wrecks: [], deposits: [] }),
    units = Array.from({ length: 16 }, (_, i) => unit('c' + i, i));
  tell('squad', squads, { squad: squadView({ manual: null, units: [{ id: 'c1', stance: 'return' }] }), selected: 'c1' });
  assert.deepEqual([client.squad, client.selected], [squadView({ manual: null, units: [{ id: 'c1', stance: 'return' }] }), 'c1']);
  tell('faction', factions, faction(units, 900));
  assert.deepEqual(client.faction, faction(units, 900)); assert.deepEqual(client.base, faction(units, 900).base);
  // One of sixteen moves off: a few words, and the page has the faction as it is.
  const moved = units.map((u, i) => i === 5 ? { ...u, atBase: false, still: false } : u), whole = sent.at(-1);
  tell('faction', factions, faction(moved, 900));
  assert.deepEqual(client.faction, faction(moved, 900)); assert(sent.at(-1) < whole / 20, `${sent.at(-1)} bytes against ${whole}`);
  // Nothing changed: nothing is said. A unit that left the faction: the list is told again.
  const count = sent.length; tell('faction', factions, faction(moved, 900)); assert.equal(sent.length, count);
  tell('faction', factions, faction(moved.slice(1), 870)); assert.deepEqual(client.faction, faction(moved.slice(1), 870));
  // The page forgets a construction that left, before the field says so; what the field says next is what stands.
  client.squad = squadView({ manual: null, units: [] }); client.selected = null;
  tell('squad', squads, { squad: squadView({ manual: 'c1', units: [{ id: 'c1', stance: 'return' }] }), selected: 'c1' });
  assert.deepEqual([client.squad, client.selected], [squadView({ manual: 'c1', units: [{ id: 'c1', stance: 'return' }] }), 'c1']);
  // A resumed seat keeps its last squad until the fresh whole squad arrives.
  // Delta baselines start over; the faction comes whole with the welcome.
  const again = {}; retell(again, faction(moved, 900)); seat(client, 'seat-1', faction(moved, 900));
  assert.deepEqual([client.faction, client.squad], [faction(moved, 900), squadView({ manual: 'c1', units: [{ id: 'c1', stance: 'return' }] })]);
  tell('faction', again, faction(moved, 880)); assert.deepEqual(client.faction, faction(moved, 880)); assert(sent.at(-1) < whole / 20, `${sent.at(-1)} bytes against ${whole}`);
  tell('squad', {}, { squad: squadView({ manual: null, units: [{ id: 'c1', stance: 'return' }] }), selected: 'c1' });
  assert.deepEqual([client.squad, client.selected], [squadView({ manual: null, units: [{ id: 'c1', stance: 'return' }] }), 'c1']);
});

test('the aim goes twenty times a second at most, to the millimetre and where the pointer stopped; the laying of the guns when it changed', t => {
  const { tab, seat } = browser(t); tab();
  let clock = 1000; t.mock.method(performance, 'now', () => clock); t.mock.timers.enable({ apis: ['setTimeout'] });
  const pass = ms => { clock += ms; t.mock.timers.tick(ms); };
  const client = new NetworkClient(); client.connect('Ana'); seat(client, 'seat-1');
  const sent = () => client.socket.sent.filter(m => ['aim', 'fire'].includes(m.type)),
    gun = { id: 'cannon', preset: 'rh120', ammo: 'he', speed: 1650, rate: 8, mass: 20.6, caliberMm: 120, platform: 'vehicle', componentId: 'c1:gun',
      trajectory: 'direct', detonation: 'impact', charge: 1, aimAngle: undefined },
    laid = { id: 'cannon', componentId: 'c1:gun', trajectory: 'direct', detonation: 'impact', charge: 1 };
  // A second of the pointer sweeping, sixty events a second, and then it rests.
  for (let i = 0; i < 60; i++) {
    client.aim({ x: 10 + i / 7, y: 2.123456789 }, gun);
    if (!i) assert.equal(sent().length, 1, 'the first aim leaves immediately');
    pass(Math.floor((i + 1) * 1000 / 60) - Math.floor(i * 1000 / 60));
  }
  pass(200);
  const aims = sent();
  assert(aims.length >= 20 && aims.length <= 21, `${aims.length} aims in a second`);
  assert.deepEqual(aims.at(-1).aim, { x: Math.round((10 + 59 / 7) * 1000) / 1000, y: 2.123 }, 'where the pointer stopped');
  assert.deepEqual(aims[0].weapon, laid, 'the laying, and only what the field reads of it');
  assert(aims.slice(1).every(aim => !('weapon' in aim)), 'the same laying is not said again');
  // Another charge, a gun switched on to fire along: the laying goes with the next aim, and a shot after it says nothing of it.
  const also = [{ componentId: 'c1:mg', trajectory: 'direct', detonation: 'impact', charge: 1 }];
  client.aim({ x: 30, y: 2 }, { ...gun, charge: .5, also }); pass(200);
  client.command('fire', { aim: { x: 30, y: 2 }, weapon: { ...gun, charge: .5, also }, queue: true }).catch(() => {});
  const [aimed, fired] = sent().slice(aims.length);
  assert.deepEqual(aimed.weapon, { ...laid, charge: .5, also }); assert.equal(fired.weapon, undefined); assert.equal(fired.queue, true);
  // A seat taken again: the field does not know how the guns are laid, and is told.
  seat(client, 'seat-1'); pass(200);
  client.aim({ x: 30, y: 2 }, { ...gun, charge: .5, also }); assert.deepEqual(client.socket.sent.at(-1).weapon, { ...laid, charge: .5, also });
  client.enabled = false; client.closeSocket();
});

for (const type of ['trigger', 'fire']) test(`a ${type} keeps its newer aim and laying when an older pointer update was pending`, async t => {
  const { tab, seat } = browser(t); tab();
  let clock = 1000; t.mock.method(performance, 'now', () => clock); t.mock.timers.enable({ apis: ['setTimeout'] });
  const pass = ms => { clock += ms; t.mock.timers.tick(ms); }, client = new NetworkClient();
  client.connect('Ana'); seat(client, 'seat-1'); client.selected = 'c1';
  const gun = { id: 'cannon', componentId: 'c1:gun', charge: 1 },
    changed = { ...gun, charge: .5, also: [{ componentId: 'c1:mg', charge: .5 }] },
    sent = () => client.socket.sent.filter(message => ['aim', 'trigger', 'fire'].includes(message.type));
  client.aim({ x: 10, y: 2 }, gun); pass(10);
  client.aim({ x: 20, y: 3 }, gun); pass(10);
  const pending = client.command(type, { aim: { x: 30, y: 4 }, weapon: changed, ...(type === 'trigger' ? { active: true } : { queue: true }) }),
    fired = sent().at(-1);
  client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: fired.request, accepted: true }) }); await pending;
  assert.deepEqual(fired.aim, { x: 30, y: 4 }); assert.deepEqual(fired.weapon, changed);
  pass(30); // The old pointer timer was due here; it must not restore its point or gun settings.
  assert.deepEqual(sent().map(message => [message.type, message.aim]), [['aim', { x: 10, y: 2 }], [type, { x: 30, y: 4 }]]);
  pass(10); client.aim({ x: 40, y: 5 }, changed);
  assert.equal(sent().length, 2, 'the next pointer update waits from the aim sent with the shot');
  pass(9); assert.equal(sent().length, 2); pass(1);
  assert.equal(sent().length, 3); assert.deepEqual(sent().at(-1).aim, { x: 40, y: 5 });
  assert.equal(sent().at(-1).weapon, undefined, 'the new laying, including the linked gun, remains the one already sent');
});

test('releasing the trigger leaves the final pending pointer aim to reach the field', async t => {
  const { tab, seat } = browser(t); tab();
  let clock = 1000; t.mock.method(performance, 'now', () => clock); t.mock.timers.enable({ apis: ['setTimeout'] });
  const pass = ms => { clock += ms; t.mock.timers.tick(ms); }, client = new NetworkClient();
  client.connect('Ana'); seat(client, 'seat-1'); client.selected = 'c1';
  const gun = { id: 'cannon', componentId: 'c1:gun' }, last = { x: 20, y: 3 };
  client.aim({ x: 10, y: 2 }, gun); pass(10); client.aim(last, gun); pass(10);
  const pending = client.command('trigger', { active: false, aim: last, weapon: gun }), released = client.socket.sent.at(-1);
  client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: released.request }) }); await pending;
  pass(29); assert.equal(client.socket.sent.filter(message => message.type === 'aim').length, 1);
  pass(1);
  assert.deepEqual(client.socket.sent.at(-1).aim, last); assert.equal(client.socket.sent.at(-1).type, 'aim');
  for (const [id, error] of [['c2', 'controle recusado'], [null, null]]) {
    pass(50); client.aim({ x: 30, y: 4 }, gun); pass(10);
    const aims = client.socket.sent.filter(message => message.type === 'aim').length;
    client.aim({ x: 40, y: 5 }, gun);
    assert.equal(client.socket.sent.filter(message => message.type === 'aim').length, aims, 'the newer pointer update waits behind the last aim');
    const control = client.command('squad', { order: 'control', id }), asked = client.socket.sent.at(-1),
      rejected = error && assert.rejects(control, /controle recusado/);
    pass(50); assert.equal(client.socket.sent.filter(message => message.type === 'aim').length, aims, 'a control order cancels the queued aim before its ACK');
    client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: asked.request, ...(error && { error }) }) });
    if (error) await rejected; else await control;
    pass(50);
    assert.equal(client.socket.sent.filter(message => message.type === 'aim').length, aims, 'neither an accepted release nor a rejected switch resurrects the old aim');
  }
});

test('a post keeps its publication ticket across a lost reply until confirmation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(); client.connect('Ana'); seat(client, 'seat-1');
  t.after(() => { client.enabled = false; client.closeSocket(); });
  const data = { x: 500, facing: 1 }, receipt = manufactureReceipt({ work: { id: 'w1', x: 500 } }), first = client.command('post', data),
    sent = client.socket.sent.at(-1), rejected = assert.rejects(first, /A conexão com o campo caiu/);
  client.socket.onclose({ code: 1006 }); await rejected;
  assert.equal(typeof sent.ticket, 'string', 'a new publication type needs the same retry protection as other works');
  client.retryNow(); seat(client, 'seat-1');
  const again = client.command('post', data), repeated = client.socket.sent.at(-1);
  assert.equal(repeated.ticket, sent.ticket);
  client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: repeated.request, ...receipt }) });
  assert.deepEqual((await again).work, receipt.work);
  client.command('post', data).catch(() => {});
  assert.notEqual(client.socket.sent.at(-1).ticket, sent.ticket);
});

test('a publication whose answer never came is asked again under its ticket; one answered, or another, goes under a new one', async t => {
  const { tab, seat } = browser(t); tab();
  const client = new NetworkClient(); client.connect('Ana'); seat(client, 'seat-1');
  const receipt = manufactureReceipt({ actor: { id: 'c1' } }), blueprint = { ...receipt.actor.blueprint, name: 'Batedor' }, last = () => client.socket.sent.at(-1),
    answer = data => client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: last().request, ...data }) });
  // The connection falls before the answer comes: asked again, the same, it goes under the same ticket.
  const lost = client.command('spawn', { blueprint, facing: 1 }), { ticket } = last();
  assert.equal(typeof ticket, 'string');
  client.socket.onclose({ code: 1006 }); await assert.rejects(lost, /A conexão com o campo caiu/);
  clearTimeout(client.reconnectTimer); client.open(); seat(client, 'seat-1');
  const again = client.command('spawn', { blueprint, facing: 1 }); assert.equal(last().ticket, ticket);
  answer(receipt); assert.deepEqual((await again).actor, receipt.actor);
  // Answered, the same design published again is another publication.
  const next = client.command('spawn', { blueprint, facing: 1 }), fresh = last().ticket; assert.notEqual(fresh, ticket);
  // Refused, it may go again under its ticket: the field keeps what it built, not what it refused.
  answer({ error: 'Falta Ferro.' }); await assert.rejects(next, /Falta Ferro/);
  client.command('spawn', { blueprint, facing: 1 }).catch(() => {}); assert.equal(last().ticket, fresh);
  // Another design, or a replacement, goes under a ticket of its own; any other command under none.
  client.command('spawn', { blueprint: { ...blueprint, name: 'Outro' }, facing: 1 }).catch(() => {}); assert.notEqual(last().ticket, fresh);
  client.command('replace', { blueprint, facing: 1, actorId: 'c1' }).catch(() => {}); assert(last().ticket && last().ticket !== fresh);
  client.command('repair', { actorId: 'c1' }).catch(() => {}); assert.equal(last().ticket, undefined);
  client.enabled = false; client.closeSocket();
});

test('a key typed comes to its seat and is the browser\'s from then on; a key the field does not know takes the page off the field', t => {
  const { local, tab, seat, sockets } = browser(t, { 'impacto.network.seat': 'SEAT1' }); tab();
  const unknown = 'Chave de acesso não encontrada neste campo: confira as letras e os números.',
    refuse = () => { const socket = sockets.at(-1); socket.onopen(); socket.onmessage({ data: JSON.stringify({ type: 'reply', error: unknown, unknownKey: true }) }); return socket.sent.at(-1); };
  const said = [], client = new NetworkClient(); client.onkey = (error, typed) => said.push([error, typed]);
  // A key typed wrong: refused as typed, and the key the browser kept stays.
  client.connect(null, 'WRONG');
  assert.equal(refuse().token, 'WRONG');
  assert.deepEqual([client.enabled, client.phase, client.token, local.getItem('impacto.network.seat')], [false, 'refused', 'SEAT1', 'SEAT1']);
  // Typed right: the seat it keeps, which the browser keeps from then on.
  client.connect(null, 'SEAT2');
  assert.equal(seat(client, 'SEAT2', null, 'Bia').token, 'SEAT2');
  assert.deepEqual([client.name, local.getItem('impacto.network.seat')], ['Bia', 'SEAT2']);
  // The kept key, changed on another device since: refused, and forgotten.
  const later = new NetworkClient(); later.onkey = (error, typed) => said.push([error, typed]); later.connect(null);
  assert.equal(refuse().token, 'SEAT2');
  assert.deepEqual([later.enabled, later.token, local.getItem('impacto.network.seat')], [false, '', null]);
  assert.deepEqual(said, [[unknown, true], [unknown, false]]);
});

test('a name another player goes by takes the page off the field, with why, and the browser keeps its key; a name changed is the one it keeps', async t => {
  const { local, tab, seat, sockets } = browser(t, { 'impacto.network.seat': 'SEAT1' }); tab();
  const taken = 'Esse nome já é de outro jogador.', said = [], client = new NetworkClient(); client.onname = (error, typed) => said.push([error, typed]);
  client.connect('Bia');
  const socket = sockets.at(-1); socket.onopen(); socket.onmessage({ data: JSON.stringify({ type: 'reply', error: taken, nameTaken: true }) });
  assert.deepEqual([client.enabled, client.phase, client.issue, client.token, local.getItem('impacto.network.seat'), said],
    [false, 'refused', taken, 'SEAT1', 'SEAT1', [[taken, false]]]);
  // Under another name it comes in, and the browser keeps the name for the next visit.
  client.connect('Carla');
  assert.equal(seat(client, 'SEAT1', null, 'Carla').name, 'Carla');
  assert.equal(local.getItem('impacto.player-name'), 'Carla');
  // The player changes it on the field: the browser keeps the name the field worked out.
  const renaming = client.rename(' Dora '), asked = client.socket.sent.at(-1);
  assert.deepEqual([asked.type, asked.name], ['rename', ' Dora ']);
  client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: asked.request, name: 'Dora' }) });
  assert.equal(await renaming, 'Dora');
  assert.deepEqual([client.name, local.getItem('impacto.player-name')], ['Dora', 'Dora']);
  // A page let in comes back to its seat by itself saying no name: the seat has the one the player gave it last, wherever.
  client.socket.onclose({ code: 1006 }); client.retryNow();
  assert.equal(seat(client, 'SEAT1', null, 'Dora').name, null);
});

test('a key changed is the one the browser keeps, and the page goes on with it', async t => {
  const { local, tab, seat } = browser(t); tab(); const client = new NetworkClient();
  client.connect('Ana'); seat(client, 'SEAT1');
  const changing = client.rekey(), asked = client.socket.sent.at(-1);
  assert.equal(asked.type, 'rekey');
  client.socket.onmessage({ data: JSON.stringify({ type: 'reply', request: asked.request, token: 'SEAT9' }) });
  assert.equal(await changing, 'SEAT9');
  assert.deepEqual([client.token, local.getItem('impacto.network.seat')], ['SEAT9', 'SEAT9']);
});

test('a field that leaves the pings unanswered for five seconds is taken as lost, and the page goes back to it', t => {
  const { tab, sockets } = browser(t); tab();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const statuses = [], client = new NetworkClient(); client.onstatus = status => statuses.push(status);
  client.connect('Ana');
  const socket = sockets.at(-1), pings = () => socket.sent.filter(m => m.type === 'ping'),
    answer = () => socket.onmessage({ data: JSON.stringify({ type: 'pong', time: pings().at(-1).time }) });
  socket.onopen();
  socket.onmessage({ data: JSON.stringify(welcomeMessage({ playerId: 'p-seat-1', token: 'seat-1', name: 'Ana', selected: null, actors: [] })) });
  // A field that answers, if only every four seconds: the page stays on it.
  for (let beat = 1; beat <= 40; beat++) { t.mock.timers.tick(500); if (beat % 8 === 0) answer(); }
  assert.equal(pings().length, 40); assert.equal(client.connected, true); assert.equal(statuses.at(-1), 'Conectado');
  assert.equal(socket.sent.length, 41, 'one timestamped ping per beat, in addition to the greeting');
  assert(pings().every(ping => Number.isFinite(ping.time)));
  // It answers no more. Ten pings go, one each half a second, and the first is five seconds unanswered: the connection is
  // lost, and the page says so and opens another without waiting for the socket to close.
  t.mock.timers.tick(10 * 500);
  assert.equal(pings().length, 50); assert.equal(client.connected, true);
  t.mock.timers.tick(500);
  assert.equal(client.connected, false); assert.equal(statuses.at(-1), 'Reconectando…'); assert.equal(socket.readyState, 3, 'the socket is let go');
  t.mock.timers.tick(800);
  assert.equal(sockets.length, 2);
  // The old socket closes at last: it is not heard from again.
  const beforeLateClose = statuses.length;
  socket.onclose({ code: 1006 }); t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2); assert.equal(statuses.length, beforeLateClose);
  sockets[1].onopen();
  assert.deepEqual([sockets[1].sent.at(-1).type, sockets[1].sent.at(-1).token], ['hello', 'seat-1']);
});

test('a throttled tab counts missing heartbeat replies by messages, and uses its timestamp only to measure RTT', t => {
  const { tab, sockets } = browser(t); tab();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000, beat;
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(globalThis, 'setInterval', fn => { beat = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const client = new NetworkClient(); client.connect('Ana');
  const socket = sockets.at(-1); socket.onopen();
  socket.onmessage({ data: JSON.stringify(welcomeMessage({ playerId: 'p-seat-1', token: 'seat-1', selected: null, actors: [] })) });
  clock += 60_000; beat();
  const ping = socket.sent.at(-1);
  assert.equal(ping.type, 'ping'); assert.equal(ping.time, clock); assert.equal(client.connected, true);
  clock += 37; socket.onmessage({ data: JSON.stringify({ type: 'pong', time: ping.time }) });
  assert.equal(client.pingMs, 37); assert.equal(client.unanswered, 0);
  for (let missing = 0; missing < 10; missing++) { clock += 60_000; beat(); }
  assert.equal(client.connected, true, 'long gaps between ten sends do not add missing replies');
  clock += 60_000; beat();
  assert.equal(client.connected, false); assert.equal(client.phase, 'reconnecting');
});
