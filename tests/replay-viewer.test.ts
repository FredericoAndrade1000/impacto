import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { initNativeDynamics, nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import { FieldHost, openRoom, replayField, DIARY } from '../server/field-host.ts';
import { SharedRoom } from '../server/room.ts';
import { writeField } from '../server/field-snapshot.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { coreBuild } from '../server/field-journal.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { ReplayRecording, replayChunkFile } from '../server/replay-recording.ts';
import { ReplayViewer } from '../server/replay-viewer.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { SceneFrameReader, NETWORK_VERSION } from '../src/network-protocol.ts';
import { decodeDrawingEvents, decodeRenderFieldView } from '../src/scene-drawing-codec.ts';
import { REPLAY_VERSION, replayPackets, replayTelemetry } from '../src/replay-contract.ts';
import { replaySeries } from '../server/replay-series.ts';
import { ReplayPlayer } from '../src/replay-player.ts';
import type { ReplayArchive, ReplayJob } from '../src/replay-contract.ts';
import type { ReplayFrame } from '../src/replay-player.ts';
import type { SceneSnapshot } from '../src/scene-contract.ts';
await initNativeDynamics();

async function waitForReplay(viewer: ReplayViewer): Promise<void> {
  const deadline = Date.now() + 30000;
  while (viewer.job.status === 'preparing') {
    assert(Date.now() < deadline, 'Replay preparation timed out.');
    await new Promise(done => setTimeout(done, 20));
  }
}

test('the complete catalogue keeps the beginning after one hundred chapters', t => {
  const folder = mkdtempSync(join(tmpdir(), 'impacto-replay-catalogue-'));
  t.after(() => { assert(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  // Catalogue metadata only: Native verification remains the exporter's job.
  for (let chapter = 0; chapter < 101; chapter++) {
    const header = { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT,
      core: coreBuild(), fieldId: 'long-recording', step: chapter * 60,
      at: new Date(Date.UTC(2026, 0, 1) + chapter * 1000).toISOString() };
    writeFileSync(join(folder, `chapter-${String(chapter).padStart(3, '0')}.ndjson`),
      JSON.stringify(header) + '\n' + JSON.stringify([(chapter + 1) * 60, 'print', 'catalogue-only']) + '\n');
  }
  // Experiment indexes share the directory but are not replay diaries.
  writeFileSync(join(folder, 'episodes.ndjson'), JSON.stringify({ name: 'episode', outcome: 'horizon' }) + '\n');
  writeFileSync(join(folder, 'replays.ndjson'), JSON.stringify({ episode: 'episode', status: 'verified' }) + '\n');
  const viewer = new ReplayViewer([folder], join(folder, 'cache'), 'http://127.0.0.1'), catalog = viewer.catalog(),
    chapters = catalog.filter(entry => entry.kind === 'chapter'), complete = catalog.find(entry => entry.kind === 'complete');
  assert.equal(chapters.length, 101);
  assert(chapters.some(entry => entry.start === 0), 'the first chapter remains available');
  assert.equal(complete?.chapters, 101); assert.equal(complete?.end, 101);
});

test('chapter baselines inherit wrecks, while a later defeat and a live rewind baseline retain their loss events', t => {
  const folder = mkdtempSync(join(tmpdir(), 'impacto-replay-losses-')), room = new SharedRoom(), host = new FieldHost(room, { diary: false });
  t.after(() => { room.world.dispose(); assert(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  room.join('Observer fixture');
  const world = room.world, frame = structuredClone(world.snapshot());
  // The observer consumes scene snapshots; physical damage is tested elsewhere.
  // Keep the real publication and frame encoder, supplying the chapter states.
  function snapshot(): SceneSnapshot;
  function snapshot<Value>(read: (state: SceneSnapshot) => Value): Value;
  function snapshot<Value>(read?: (state: SceneSnapshot) => Value) {
    const state = { ...frame, time: world.time }; return read ? read(state) : state;
  }
  t.mock.method(world, 'snapshot', snapshot);
  const old = frame.actors[0]!, later = frame.actors[1]!;
  old.defeated = true;
  const first = new ReplayRecording(folder); first.observe(host, 'ready');
  assert.equal(first.markers.filter(marker => marker.kind === 'loss').length, 0);
  for (let i = 0; i < 6; i++) host.step(() => 1);
  later.defeated = true; world.sync(); first.observe(host, 'step');
  assert.deepEqual(first.markers.filter(marker => marker.kind === 'loss').map(marker => marker.actorId), [later.id]);
  const next = new ReplayRecording(folder); next.observe(host, 'ready');
  for (let i = 0; i < 6; i++) host.step(() => 1);
  world.sync(); next.observe(host, 'step'); assert.equal(next.markers.filter(marker => marker.kind === 'loss').length, 0);
  later.defeated = false;
  const rewound = new ReplayRecording(folder); rewound.observe(host, 'ready');
  for (let i = 0; i < 6; i++) host.step(() => 1);
  later.defeated = true; world.sync(); rewound.observe(host, 'step');
  assert.deepEqual(rewound.markers.filter(marker => marker.kind === 'loss').map(marker => marker.actorId), [later.id], 'a fresh loss after a live checkpoint baseline is not deduplicated across runs');
});

test('observing quiet steps preserves native events and export cursors, including isolated boundary frames',
  { skip: nativeDynamicsRuntime !== 'native' && 'Native checkpoint isolation required.' }, async t => {
  const folder = mkdtempSync(join(tmpdir(), 'impacto-replay-quiet-')), field = { bases: [-150] },
    host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => { room.field.dispose(); assert(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  host.join('Quiet observer'); host.lines = [];
  host.step(() => 1);
  const world = room.field, game = world.game(), core = world.dynamics!.core,
    bytes = () => Buffer.from(core.export_state!()), beforeReady = bytes(), recording = new ReplayRecording(folder);
  assert.equal(game.stale, true);
  recording.observe(host, 'ready');
  assert.equal(game.stale, true); assert.deepEqual(bytes(), beforeReady, 'the initial private frame must leave the source untouched');
  for (let step = 1; step < 120; step++) {
    host.step(() => 1);
    const before = step < 4 || step % 60 === 59 ? bytes() : null, events = [...world.events];
    const wasStale: boolean = game.stale;
    recording.observe(host, 'step');
    if (step === 2) recording.observe(host, 'before-drain');
    if (before) assert.deepEqual(bytes(), before, 'a visual sample must not deliver native events early');
    assert.deepEqual(world.events, events); assert.equal(game.stale, wasStale);
  }
  recording.observe(host, 'before-tell'); host.tell([...room.players.keys()]); recording.observe(host, 'input');
  const beforeFinish = bytes(), archive = recording.finish({ how: 'end', header: {}, host, step: room.steps, read: 0, prints: 2 }, 'e'.repeat(24), 'quiet');
  assert.deepEqual(bytes(), beforeFinish, 'the final private frame must preserve the recorded source');
  assert.equal(archive.status, 'verified'); assert(Math.abs(archive.end - 2) < 1e-8);
  assert(archive.chunks.reduce((sum, chunk) => sum + chunk.frames, 0) >= 20, 'quiet periods retain regular visual frames');
  const firstChunk = archive.chunks[0]!, lastChunk = archive.chunks.at(-1)!;
  assert(Math.abs(firstChunk.from - 1 / 60) < 1e-8); assert(Math.abs(lastChunk.to - 2) < 1e-8);
  const reader = new SceneFrameReader(decodeRenderFieldView);
  let lastTime = NaN;
  for (const packet of replayPackets(Uint8Array.from(gunzipSync(readFileSync(join(folder, replayChunkFile(lastChunk.index))))).buffer)) {
    const frame = reader.decode(packet); assert(frame); lastTime = frame.state.time;
  }
  assert(Math.abs(lastTime - 2) < 1e-8);
});

test('visual export preserves diary verification, tells, events and independent chunk decoding',
  { skip: nativeDynamicsRuntime !== 'native' && 'The server replay exporter requires the Native host.' }, async t => {
  const folder = mkdtempSync(join(tmpdir(), 'impacto-replay-viewer-'));
  t.after(() => { assert(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  const field = { bases: [-150, 6000] }, host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => room.world.dispose()); host.record(folder);
  const alice = host.join('Alice'), bob = host.join('Bob');
  host.command(alice.playerId, { type: 'spawn', request: 1, x: -150, facing: 1, blueprint: createStructuredTemplate('scout') });
  const actor = room.world.actors.at(-1)!;
  host.command(bob.playerId, { type: 'spawn', request: 1, x: 6000, facing: -1, blueprint: createStructuredTemplate('scout') });
  host.command(alice.playerId, { type: 'squad', order: 'control', id: actor.id });
  const gun = room.world.modules.find(part => part.actorId === actor.id && part.kind === 'weapon')!;
  host.command(alice.playerId, { type: 'trigger', active: true, aim: { x: 150, y: room.world.terrain.height(150) + 2 }, weapon: { id: 'cannon', componentId: gun.id } });
  for (let i = 0; i < 780; i++) {
    if (i === 60) host.command(alice.playerId, { type: 'spawn', request: 2, x: -350, facing: 1, instant: true, blueprint: createStructuredTemplate('guard-post') });
    if (i % 3 === 0) host.tell([alice.playerId, bob.playerId], i % 15 === 0);
    host.step(() => 1);
  }
  host.flush(); const file = host.diary!.file, original = readFileSync(file), lines = original.toString('utf8').trim().split('\n');
  const structure = room.world.actors.find(actor => actor.blueprint.preset === 'bunker'); assert(structure);
  host.diary!.close(); host.diary = null;
  const output = join(folder, 'visual'); mkdirSync(output);
  const recording = new ReplayRecording(output), outcome = await replayField(lines, { observe: (current, phase) => recording.observe(current, phase) });
  t.after(() => outcome.host.room.world.dispose());
  assert.equal(outcome.how, 'end', outcome.got); assert.equal(outcome.host.room.digest(), room.digest());
  assert.equal(outcome.prints, 13);
  const archive = recording.finish(outcome, 'a'.repeat(24), 'test');
  assert.equal(archive.status, 'verified'); assert(Math.abs(archive.end - 13) < 1e-8); assert(archive.chunks.length >= 2);
  let shots = 0, decoded = 0, sawStructure = false, sawBases = false;
  for (const chunk of archive.chunks) {
    const bytes = gunzipSync(readFileSync(join(output, replayChunkFile(chunk.index)))), reader = new SceneFrameReader(decodeRenderFieldView);
    const packets = replayPackets(Uint8Array.from(bytes).buffer); assert.equal(packets.length, chunk.frames);
    for (const packet of packets) {
      const frame = reader.decode(packet); assert(frame); assert.equal(frame.state.shared, false);
      sawStructure ||= frame.state.actors.some(actor => actor.id === structure.id && actor.preset === 'bunker');
      sawBases ||= frame.state.observerBases?.length === 2;
      const telemetry = replayTelemetry(frame.telemetry); assert(telemetry.units.every(unit => Number.isFinite(unit.health)));
      shots += decodeDrawingEvents(frame.events).filter(event => event.type === 'muzzle').length; decoded++;
    }
  }
  assert(decoded > 200); assert(shots > 0, 'events were observed before recorded tell drained them');
  assert(sawStructure && sawBases, 'fixed actors and faction bases both reach the drawing codec');
  assert(archive.markers.some(marker => marker.kind === 'structure' && marker.actorId === structure.id));
  assert.deepEqual(readFileSync(file), original);
  // A changed print must never publish its provisional second of visual frames.
  const bad = lines.findIndex(line => line.startsWith('[120,"print"'));
  assert(bad > 0);
  const changed = lines.with(bad, lines[bad]!.slice(0, -1) + ',"wrong"]'), partialDir = join(folder, 'partial'); mkdirSync(partialDir);
  const partial = new ReplayRecording(partialDir), divergence = await replayField(changed, { observe: (current, phase) => partial.observe(current, phase) });
  t.after(() => divergence.host.room.world.dispose());
  assert.equal(divergence.how, 'diverged'); assert(Math.abs(partial.finish(divergence, 'b'.repeat(24), 'changed').end - 1) < 1e-8);

  // HTTP accepts configured IDs, not paths, and workers read frozen copies.
  const cache = join(folder, 'cache'); let viewer: ReplayViewer;
  const server = createServer((request, response) => { void viewer.request(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  viewer = new ReplayViewer([folder], cache, origin);
  t.after(async () => { await viewer.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const old = JSON.parse(lines[0]!) as { diary: number; fieldId: string }; old.diary--; old.fieldId = 'old-fixture';
  writeFileSync(join(folder, 'old.ndjson'), JSON.stringify(old) + '\n');
  const catalog = viewer.catalog(), entry = catalog.find(entry => entry.compatible); assert(entry);
  assert(catalog.some(entry => entry.reason === 'version' && !entry.compatible));
  assert.equal((await fetch(origin + '/api/replay/prepare?id=../../field.json', { method: 'POST' })).status, 400);
  assert.equal((await fetch(origin + '/api/replay/status', { headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
  await viewer.prepare(entry.id);
  await waitForReplay(viewer);
  const ready = viewer.job as ReplayJob; assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') assert.fail(JSON.stringify(ready));
  assert.equal(ready.archive.status, 'verified');
  const chunkResponse = await fetch(`${origin}/api/replay/chunk/${ready.archive.id}/0`); assert.equal(chunkResponse.status, 200);
  assert(replayPackets(await chunkResponse.arrayBuffer()).length > 0);
  await viewer.prepare(entry.id); assert.equal(viewer.worker, null, 'completed preparation is cached');
  assert.deepEqual(readFileSync(entry.name ? join(folder, entry.name) : ''), original);
  const second = [...lines], secondHeader = JSON.parse(lines[0]!) as { at: string };
  secondHeader.at = new Date(Date.parse(secondHeader.at) + 1000).toISOString(); second[0] = JSON.stringify(secondHeader);
  writeFileSync(join(folder, 'second.ndjson'), second.join('\n') + '\n');
  const complete = viewer.catalog().find(entry => entry.kind === 'complete' && entry.compatible); assert(complete);
  await viewer.prepare(complete.id);
  await waitForReplay(viewer);
  const full = viewer.job as ReplayJob; if (full.status !== 'ready') assert.fail(JSON.stringify(full));
  assert.equal(full.archive.chapters?.length, 2); assert.equal(full.archive.prints, 26);
  assert(Math.abs(full.archive.end - 26) < 1e-8);
  assert.equal(full.archive.markers.filter(marker => marker.kind === 'structure').length, 1, 'chapter snapshots do not duplicate construction events');
  const nextChunk = full.archive.chunks.find(chunk => chunk.chapter === 1)!;
  const nextResponse = await fetch(`${origin}/api/replay/chunk/${full.archive.id}/${nextChunk.index}`);
  assert.equal(nextResponse.status, 200); assert(replayPackets(await nextResponse.arrayBuffer()).length > 0);
  const restored = new ReplayViewer([folder], cache, origin);
  const saved = await fetch(`${origin}/api/replay/archive/${full.archive.id}`); assert.equal(saved.status, 200);
  restored.catalog(); await restored.prepare(complete.id); assert.equal(restored.worker, null, 'a complete cache restores its chapter links'); await restored.close();
  writeFileSync(join(folder, 'diverged.ndjson'), changed.join('\n') + '\n');
  const badEntry = viewer.catalog().find(entry => entry.name === 'diverged.ndjson'); assert(badEntry);
  await viewer.prepare(badEntry.id);
  await waitForReplay(viewer);
  const badJob = viewer.job as ReplayJob; if (badJob.status !== 'ready') assert.fail(JSON.stringify(badJob));
  assert.equal(badJob.archive.status, 'diverged'); assert.equal(viewer.worker, null, 'a divergent streamed diary closes before another job');
  const cancelledLines = [...lines], changedHeader = JSON.parse(lines[0]!) as { at: string }; changedHeader.at = new Date(0).toISOString();
  cancelledLines[0] = JSON.stringify(changedHeader);
  const cancelledFile = join(folder, 'cancel.ndjson'), cancelledBytes = cancelledLines.join('\n') + '\n'; writeFileSync(cancelledFile, cancelledBytes);
  const cancelledEntry = viewer.catalog().find(entry => entry.name === 'cancel.ndjson'); assert(cancelledEntry);
  await viewer.prepare(cancelledEntry.id); assert(viewer.worker); await viewer.close();
  assert.equal(viewer.job.status, 'idle'); assert.equal(readFileSync(cancelledFile, 'utf8'), cancelledBytes);
  assert(readdirSync(cache).every(name => existsSync(join(cache, name, 'manifest.json'))), 'cancel removes only its unpublished attempt');
});

test('a bot-only battle keeps muzzle events while preserving its ordinary quiet diary',
  { timeout: 180000, skip: nativeDynamicsRuntime !== 'native' && 'Native battle snapshot required.' }, async t => {
  const folder = mkdtempSync(join(tmpdir(), 'impacto-replay-combat-'));
  t.after(() => { assert(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  const positions = [-2400, -800, 800, 2200], room = new SharedRoom({ base: index => positions[index] }), host = new FieldHost(room);
  t.after(() => room.world.dispose());
  for (const [index, profile] of (['balanced', 'cautious', 'cautious', 'balanced'] as const).entries())
    host.addCommander(`AI ${index}`, profile, '0011223344556677');
  room.site = null; host.lines = [];
  const lines = [JSON.stringify({ diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT,
    field: null, fieldId: room.fieldId, snapshot: writeField(room, host.publication) })];
  let originalShots = 0;
  for (let step = 0; step < 120 * 60; step++) host.step(() => 1, () => {
    originalShots += room.field.events.filter(event => event.type === 'muzzle').length;
  });
  // Read the final native tail only after simulation stops; the ordinary quiet
  // cleanup must not deliver native events to gameplay ahead of its own reads.
  room.field.game().sync(); originalShots += room.field.events.filter(event => event.type === 'muzzle').length;
  room.field.drainEvents();
  lines.push(...host.lines);
  assert(originalShots > 0, 'autonomous factions must actually shoot without a human connection');
  const recording = new ReplayRecording(folder), outcome = await replayField(lines, { observe: (host, phase) => recording.observe(host, phase) });
  t.after(() => outcome.host.room.world.dispose());
  assert.equal(outcome.how, 'end', outcome.got); assert.equal(outcome.host.room.digest(), room.digest());
  const archive = recording.finish(outcome, 'd'.repeat(24), 'bot-only');
  let reproducedShots = 0;
  for (const chunk of archive.chunks) {
    const reader = new SceneFrameReader(decodeRenderFieldView);
    for (const packet of replayPackets(Uint8Array.from(gunzipSync(readFileSync(join(folder, replayChunkFile(chunk.index))))).buffer)) {
      const frame = reader.decode(packet); assert(frame);
      reproducedShots += decodeDrawingEvents(frame.events).filter(event => event.type === 'muzzle').length;
    }
  }
  assert.equal(archive.prints, 120);
  assert.equal(reproducedShots, originalShots, 'quiet cleanup must not erase or duplicate a recorded muzzle flash');
});

test('a complete timeline preserves rewound world clocks and resets at chapter boundaries', async () => {
  const part = (id: string, start: number): ReplayArchive => ({ version: REPLAY_VERSION, id: id.repeat(24), name: id, start, end: start + 10,
    fps: 1, status: 'verified', prints: 10, stoppedAt: start + 10, detail: null,
    chunks: [{ index: 0, from: start, to: start + 10, frames: 11, bytes: 1 }],
    markers: [{ kind: 'structure', time: start, actorId: 'fixed', label: 'Post', x: 42 }] });
  const archive = replaySeries('c'.repeat(24), 'complete', [part('a', 100), part('b', 105)]);
  let resets = 0; const fed: [number, number][] = [];
  const player = new ReplayPlayer(archive, async index => Array.from({ length: 11 }, (_, n) => ({
    state: { time: (index ? 105 : 100) + n, deadline: 120 }, time: index * 10 + n, chapter: index,
    events: [{ type: 'muzzle', time: (index ? 105 : 100) + n }], telemetry: { factions: [], units: [] },
  })), { reset() { resets++; }, receive(frame, before) {
    assert.equal(frame.state.deadline, 120, 'service timestamps are never rebased'); assert.equal(frame.events[0]!.time, frame.state.time);
    fed.push([before, frame.state.time]);
  } });
  await player.show(9); assert.equal(player.worldTime, 109);
  await player.show(10); assert.equal(player.worldTime, 105); assert.equal(player.chapterIndex, 1); assert.equal(resets, 2);
  assert.deepEqual(fed.at(-1), [105, 105], 'the renderer never interpolates between separate runs');
  await player.show(10.5); assert.equal(player.worldTime, 105.5); assert.deepEqual(fed.at(-1), [105, 106]);
  await player.show(9.5); assert.equal(player.worldTime, 109.5); assert.equal(player.chapterIndex, 0);
});

test('playback seeks, freezes and cancels obsolete loads with bounded retention', async () => {
  type State = { time: number };
  const archive = { start: 0, end: 49, fps: 1, chunks: Array.from({ length: 5 }, (_, index) => ({ index, from: index * 10, to: index * 10 + 9, frames: 10, bytes: 0 })) } as ReplayArchive,
    frames = (index: number): ReplayFrame<State>[] => Array.from({ length: 10 }, (_, i) => ({ state: { time: index * 10 + i }, events: [], telemetry: { factions: [], units: [] } }));
  let resets = 0; const feeds: [number, number][] = [], clock = new ReplayPlayer(archive, async index => frames(index), {
    reset() { resets++; }, receive(frame, before) { feeds.push([before, frame.state.time]); },
  });
  await clock.show(0); await clock.show(.5); assert.equal(clock.time, .5); assert.equal(clock.frame!.state.time, 0);
  assert.deepEqual(feeds.at(-1), [0, 1]);
  await clock.show(.75); assert.equal(feeds.length, 2, 'paused/fractional positions never repeat a frame');
  await clock.show(1.25); assert.equal(clock.frame!.state.time, 1, 'telemetry does not anticipate the next endpoint');
  await clock.show(35, true); await clock.show(45, true); await clock.show(15, true); await clock.show(25, true);
  assert(clock.cachedChunks <= 3); assert.equal(clock.time, 25); assert.equal(clock.frame!.state.time, 25); assert(resets >= 5);
  const shown: number[] = []; let release!: (frames: ReplayFrame<State>[]) => void;
  const delayed = new ReplayPlayer<State>(archive, () => new Promise<ReplayFrame<State>[]>(done => { release = done; }), { reset() {}, receive(frame) { shown.push(frame.state.time); } });
  const old = delayed.show(0); delayed.cancel(); release(frames(0)); assert.equal(await old, false); assert.deepEqual(shown, []);
});

test('chunk framing and telemetry reject truncation and nonfinite metadata', () => {
  assert.throws(() => replayPackets(new Uint8Array([1, 0, 0]).buffer), /Truncated/);
  assert.throws(() => replayPackets(new Uint8Array([12, 0, 0, 0, 1]).buffer), /Invalid/);
  assert.throws(() => replayPackets(new Uint8Array([0, 0, 0, 0]).buffer), /Invalid/);
  assert.throws(() => replayTelemetry({ factions: [{ id: 'x', stock: { ferro: NaN } }], units: [] }), /Invalid/);
});
