import { readWorkerOptions, readHostMessage, COMMANDER_LIMIT } from './worker-contract.ts';
import type { BroadcastFrame } from './worker-contract.ts';
import type { Retelling } from '../src/network-protocol.ts';
import type { TestSpeed } from '../src/field-protocol-contract.ts';
import { isChatMessage } from '../src/field-protocol-codec.ts';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
interface FieldStream { writer: FrameWriter; full: boolean; wanted: boolean; fullAt: number }
const options = readWorkerOptions(workerData);
const port = parentPort;
if (!port) throw new Error('Worker físico sem porta do host.');
import { userError } from '../src/user-message.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { FieldHost, openRoom } from './field-host.ts';
import { tidyDiaries } from './field-journal.ts';
import { FIXED_DT } from '../src/physics.ts';
import { PhysicsMetrics } from '../src/performance.ts';
import { FrameLedger, FrameWriter, NETWORK_VERSION, retell } from '../src/network-protocol.ts';
import { stressField } from './stress-field.ts';
import { fieldStore } from './field-save.ts';
import { startActivities } from './world-activities.ts';
import { testActors, testIntent, publicationInstant, fieldAccumulator } from '../src/test-tools.ts';
import { checkTestSave } from './test-server.ts';
import { addNamedCommander, commanderPopulation } from './commander-population.ts';

// Only this live boundary grants test tools. Neither a saved room nor a page grants them.
const testTools = options.testTools ?? false;
checkTestSave(testTools, options.save, Boolean(options.stress));
// Live scheduling only: shared by this test host's peers, reset on every worker start, never kept or replayed.
let testSpeed: TestSpeed = 1;

// The stress field is the field of the game at its worst (stress-field.ts): `stress` is true for all of its
// factions, or how many of them to field. Whoever comes to it is seated in one of them, and told what it is.
// Where the server has the field kept (field-save.js), it starts as it was last kept there, and writes its diary
// beside it (field-host.ts). A field resumed is stepped before it is taken: one that cannot go on is no field to resume.
// The stress field is fielded before anybody comes; its guns are fed as the field goes on. Nobody runs it again.
let origin: unknown = null; // what the field was opened with, as it was then: its diary begins from it
const stress = options.stress ? stressField(options.stress === true ? undefined : options.stress) : null,
  field = options.rehearsal ?? null, store = options.save && !stress ? fieldStore(options.save!.dir) : null,
  replays = store && join(options.save!.dir, 'replays'),
  open = (kept: unknown) => {
    origin = kept && structuredClone(kept);
    const opened = openRoom(field, kept);
    if (!testTools && options.commanderFill === undefined && opened.commanders.size) {
      opened.field.dispose(); throw new Error('Um campo com comandantes autônomos exige servidor de testes ou configuração pública explícita.');
    }
    if (options.commanderFill !== undefined && opened.commanders.size > COMMANDER_LIMIT) {
      opened.field.dispose(); throw new Error('O campo salvo excede o limite de quatro identidades autônomas públicas.');
    }
    if (field && opened.commanders.size) { opened.field.dispose(); throw new Error('Um campo com comandantes autônomos não pode ser aberto como ensaio.'); }
    // Only the live normal host enables new activities. The exact diary records this origin;
    // old diaries and explicit rehearsals remain unchanged when opened by openRoom.
    if (!field && !opened.activities && !opened.ended) { startActivities(opened); origin = structuredClone(opened.keep()); }
    const host = new FieldHost(opened, { field, diary: Boolean(store) });
    if (kept) try { for (let i = 0; i < 12 && !host.ended; i++) host.step(); } catch (error) { host.room.field.dispose(); throw error; }
    return host;
  },
  host = stress ? new FieldHost(stress.room, { diary: false }) : store ? store.open(open) : open(null),
  room = host.room, peers = new Map<string, string>();
// The diaries of runs that stopped are deflated, and the oldest make room, now and every ten minutes.
if (replays) {
  host.record(replays, origin);
  const tidy = () => tidyDiaries(replays, host.diary ? { own: host.diary.file } : {}).catch(error => console.error('Diários do campo:', error instanceof Error ? error.message : String(error)));
  tidy(); setInterval(tidy, 10 * 60_000);
}
// The journal starts before new controllers enter. Restored identities, including
// paused controllers, count toward the request and never receive a second kit.
while (room.commanders.size < (options.commanders ?? 0)) {
  addNamedCommander(host);
}
const fillCommanders = options.commanderFill === undefined ? null : commanderPopulation(host, options.commanderFill);
const SAVE_EVERY = (options.save?.seconds ?? 30) * 1000;
let savedAt = performance.now();
// Each faction is told a frame of its own: what its sensors leave it of the field, of the rounds
// in the air and of what happened since the frame before. The writers share one ledger, so that
// what they say alike of a construction is put into words once. A field without fog has one
// frame, for everybody.
const ledger = new FrameLedger(), streams = new Map<string | null, FieldStream>(), told = new Map<string, string | null>(); // by faction; and the faction each peer was last told as
const stream = (id: string | null): FieldStream => { let kept = streams.get(id); if (!kept) { kept = { writer: new FrameWriter(ledger), full: true, wanted: false, fullAt: -Infinity }; streams.set(id, kept); } return kept; };
const close = (id: string | null) => { streams.get(id)?.writer.close(); streams.delete(id); };
const squads = new Map<string, Retelling>(), factions = new Map<string, Retelling>(); // what each peer was last told of its squad and of its faction (`retell`)
// How each page last said the guns in hand are laid. A page says it with an aim, a pull of the trigger or a shot only when
// it changed: the field is told it with every one of them all the same, as the page would have said it.
const laid = new Map<string, unknown>();
const toldOf = (views: Map<string, Retelling>, peerId: string): Retelling => { let value = views.get(peerId); if (!value) { value = {}; views.set(peerId, value); } return value; };
// When every faction was last quoted, and the players whose own is owed sooner: whoever was answered since sees what
// its command did at the next frame, without the rest of the field being quoted for it.
let factionsAt = -Infinity;
const owed = new Set<string>();
let last = performance.now(),
  accumulator = 0,
  sentAt = 0,
  inFlight = false;
// Read metrics against real wall time (speed 1), so state.pace reports achieved simulation speed, not requested/achieved.
const metrics = new PhysicsMetrics(last);
const direct = (peerId: string, payload: object) => port.postMessage({ type: 'direct', peerId, payload });
// Storage health is operational, outside the deterministic room and diary. A failed save keeps the live field.
let persistenceFailed = false;
const saveField = () => {
  const saved = store ? store.save(host) : true;
  if (persistenceFailed !== !saved) {
    persistenceFailed = !saved;
    for (const peerId of peers.keys()) direct(peerId, { type: 'reply', persistenceFailed });
  }
  return saved;
};
port.on('message', (raw: unknown) => {
  const message = readHostMessage(raw), type = message.type;
  if (type === 'ack') {
    inFlight = false;
    return;
  }
  // The server is about to stop this field: it is kept as it is now, and the server told.
  if (message.type === 'save') {
    const done = message.done;
    let saved = false;
    try { saved = saveField(); host.flush(); } finally { Atomics.store(done, 0, saved ? 1 : -1); Atomics.notify(done, 0); }
    return;
  }
  // Sockets that fell behind have caught up: each needs a whole state of its faction to go on from.
  if (message.type === 'whole') {
    for (const id of message.peerIds) if (peers.has(id)) stream(host.audience(peers.get(id)!)).wanted = true;
    return;
  }
  if (message.type === 'disconnect') {
    const peerId = message.peerId, id = peers.get(peerId)!;
    peers.delete(peerId); squads.delete(peerId); factions.delete(peerId); told.delete(peerId); laid.delete(peerId);
    if (id && ![...peers.values()].includes(id)) host.leave(id);
    return;
  }
  if (message.type !== 'command') return;
  const peerId = message.peerId, address = message.address ?? null; let data = message.data;
  try {
    // Reject before the deterministic host reads or records anything of this administrative request.
    if (data.type === 'test' && !testTools) throw userError('Ferramentas de testes indisponíveis neste servidor.');
    if (publicationInstant(data) && !testTools) throw userError('Fabricação instantânea indisponível neste servidor.');
    if (data.type === 'hello') {
      if (data.version !== NETWORK_VERSION) throw userError('O jogo foi atualizado. Recarregue a página (F5) para entrar no campo.');
      if (peers.has(peerId)) throw userError('Você já está no campo.');
      // A page that comes to a seat another page sits in takes it: that one is let go, and told why (network-server.ts).
      const welcome = host.join(data.name, data.token, address);
      for (const [old, id] of peers)
        if (id === welcome.playerId) {
          peers.delete(old); told.delete(old);
          port.postMessage({ type: 'kick', peerId: old });
        }
      peers.set(peerId, welcome.playerId);
      // The welcome tells the faction whole: what the page is told of it next is what changed since.
      const greeting = { type: 'welcome', ...welcome, watch: null, ...stress?.seat(welcome.playerId), persistenceFailed,
        ...(testTools ? { testTools: true, factor: testSpeed } : {}) };
      retell(toldOf(factions, peerId), greeting.faction);
      direct(peerId, greeting);
      return;
    }
    if (!peers.has(peerId)) throw userError('Entre no campo primeiro.');
    if (data.type === 'test') {
      const intent = testIntent(data);
      // Opening/refreshing the picker reads no blueprint and renews neither input lease nor diary.
      if (intent.act === 'list') {
        room.requirePlayer(peers.get(peerId)!);
        direct(peerId, { type: 'reply', request: data.request, ...testActors(room.world), factor: testSpeed });
        return;
      }
      if (intent.act === 'speed') {
        room.requirePlayer(peers.get(peerId)!);
        const changed = testSpeed !== intent.factor;
        testSpeed = intent.factor;
        direct(peerId, { type: 'reply', request: data.request, factor: testSpeed });
        if (changed) for (const id of peers.keys()) direct(id, { type: 'test-settings', factor: testSpeed });
        return;
      }
      data = { ...intent, request: data.request };
    }
    if (data.type === 'resync') {
      stream(host.audience(peers.get(peerId)!)).wanted = true;
      return;
    }
    if (['aim', 'trigger', 'fire'].includes(data.type)) laid.set(peerId, data.weapon ??= laid.get(peerId));
    const rawResult = host.command(peers.get(peerId)!, data), result = record(rawResult) ? rawResult : {};
    if (data.type === 'chat' && !isChatMessage(result.chat)) throw new Error('Resposta de conversa inválida.');
    // One new message, only to the players entitled to it now. The last quote of a faction may be a quarter-second old.
    if (data.type === 'chat' && isChatMessage(result.chat)) for (const [recipient, playerId] of peers) {
      if (room.receivesChat(playerId, result.chat)) direct(recipient, { type: 'chat', message: result.chat });
    }
    // Presence renews the lease through the deterministic host. The page's timestamp is only echoed for RTT:
    // neither the command the field reads nor its diary uses that clock.
    if (data.type === 'ping') { direct(peerId, { type: 'pong', time: data.time }); return; }
    if (data.request) { direct(peerId, { type: 'reply', request: data.request, ...(data.type === 'chat' ? { sent: isChatMessage(result.chat) ? result.chat.id : undefined } : result) }); owed.add(peers.get(peerId)!); }
  } catch (error) {
    // The field refuses in words for the player. Anything else that broke is for the log of the server: the
    // player is told plainly that it did not work.
    const said = error instanceof Error && error.constructor === Error, details = record(error) ? error : null;
    if (!said) console.error('Comando do campo:', error);
    // A key the field does not know is said as such: the page that kept it forgets it (network-client.ts). So is a name
    // another player goes by: the page asks for another.
    direct(peerId, {
      type: 'reply',
      request: data.request,
      error: said ? error.message : 'Algo deu errado no campo. Tente de novo.',
      ...(said && details?.userMessage ? { userMessage: details?.userMessage } : {}),
      ...(said && details?.unknownKey ? { unknownKey: true } : {}),
      ...(said && details?.nameTaken ? { nameTaken: true } : {}),
    });
  } finally {
    port.postMessage({ type: 'handled', peerId });
  }
});

setInterval(() => {
  // A busy host slows the simulated clock, but must not build minutes of stale
  // catch-up work. Metrics still report actual completed steps and clock speed.
  const now = performance.now();
  try {
    accumulator = fieldAccumulator(accumulator, (now - last) / 1000, testSpeed);
    last = now;
    let steps = 0;
    const budget = performance.now();
    while (accumulator + 1e-10 >= FIXED_DT && steps++ < 4 && performance.now() - budget < 12) {
      if (host.ended) { accumulator = 0; break; }
      const start = performance.now();
      fillCommanders?.();
      host.step();
      metrics.record(performance.now(), performance.now() - start);
      accumulator -= FIXED_DT;
    }
    stress?.feed(room.field.time);
    if (store && now - savedAt >= SAVE_EVERY) { savedAt = now; saveField(); }
    if (!inFlight && peers.size && now - sentAt >= 48) {
      // Orders are each player's own: they go to that player alone, when something in them changed, with the
      // construction the workshop looks at. So does the faction, four times a second: stocks, base, quotes, holds,
      // wrecks, the veins and the bases of others it knows of, the factions it has met, who else is on the field and the names,
      // flags and wealth of every nation there — one renamed, founded or gone is told to everybody the next of those times —; and to a player that
      // was answered since, at once. Each goes as what changed of it since that page was told it.
      const quoted = now - factionsAt >= 250 || (owed.size ? [...owed] : false),
        { audiences, players, quotes, spent } = host.tell([...peers.values()], quoted),
        // How the field keeps up with the time that passes, to a hundredth: what a page's meter of the frames says of the server.
          { measured, simRatio } = metrics.read(now, room.field.time, 1, false, accumulator, spent), pace = measured ? Math.round(simRatio * 100) / 100 : undefined;
      if (quoted === true) factionsAt = now;
      owed.clear();
      // Who is told which frame. A peer that came, or whose player went over to another faction,
      // starts from a whole state of the faction it is in now.
      const heard = new Map<string | null, string[]>();
      for (const [peerId, playerId] of peers) {
        const id = players.get(playerId)!.audience;
        if (told.get(peerId) !== id) { told.set(peerId, id); stream(id).full = true; }
        if (!heard.has(id)) heard.set(id, []);
        heard.get(id)!.push(peerId);
      }
      for (const id of [...streams.keys()]) if (!heard.has(id)) close(id);
      // A whole state for whoever came; for a peer that lost a frame, no more than one a second.
      // Every other frame tells what changed: a construction that came, went or was rebuilt is the
      // items that came and went, as one that comes into a faction's sight is.
      const frames: BroadcastFrame[] = [];
      ledger.turn();
      for (const [id, peerIds] of heard) {
        const kept = stream(id), whole = kept.full || kept.wanted && now - kept.fullAt > 1000, { state, events } = audiences.get(id)!,
          buffer = kept.writer.encode({ state: { ...state, pace }, events }, whole);
        frames.push({ peers: peerIds, buffer, whole });
        if (whole) { kept.fullAt = now; kept.wanted = false; }
        kept.full = false;
      }
      port.postMessage({ type: 'broadcast', frames }, frames.map(frame => frame.buffer));
      inFlight = true;
      sentAt = now;
      for (const [peerId, playerId] of peers) {
        const { squad, selected, faction } = players.get(playerId)!, orders = retell(toldOf(squads, peerId), { squad, selected });
        if (orders !== undefined) direct(peerId, { type: 'squad', changes: orders });
        if (!quotes.has(playerId)) continue;
        const lastFaction = factions.get(peerId)?.view, before = record(lastFaction) ? lastFaction.ref : undefined, quote = retell(toldOf(factions, peerId), faction);
        if (quote !== undefined) direct(peerId, { type: 'faction', changes: quote });
        if (before !== faction?.ref) {
          const { ref, faction: history } = room.chatView(playerId);
          direct(peerId, { type: 'chat-history', ref, messages: history });
        }
      }
    } else if (!peers.size) for (const id of [...streams.keys()]) close(id);
  } catch (error) { host.fault(error); throw error; }
  finally { host.flush(); }
}, 8);
// The field stands: a server recovering it can let pages in now.
port.postMessage({ type: 'ready' });
