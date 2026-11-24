// Prepare every episode, including unsuccessful training perturbations. This
// uses the ordinary exporter and checks complete visual packets afterwards.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { ReplayViewer } from '../../server/replay-viewer.ts';
import { initNativeDynamics } from '../../src/native-dynamics.ts';
import { SceneFrameReader } from '../../src/network-protocol.ts';
import { decodeDrawingEvents, decodeRenderFieldView } from '../../src/scene-drawing-codec.ts';
import { replayPackets } from '../../src/replay-contract.ts';
await initNativeDynamics();
const root = resolve(process.argv[2]!), workers = Number(process.argv[3] ?? 4), port = Number(process.argv[4] ?? 8502);
assert(Number.isInteger(workers) && workers >= 1 && workers <= 24);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const watch = process.argv.includes('--watch'), cache = join(root, 'viewer-cache'), journal = join(root, 'replays.ndjson');
interface Episode { name: string; field: string; result: string; score: number; factions: number; slot: number;
  resultSHA256?: string; fieldSHA256?: string; decisionsSHA256?: string }
interface Audit { episode: string; archiveId: string; url: string; start: number; end: number; frames: number;
  sourceHashes: Record<string, string>; resultSHA256: string; decisionsSHA256: string; cacheSHA256: string }
const completed = new Map<string, Audit>(existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean)
  .map(line => { const item = JSON.parse(line) as Audit; return [item.episode, item]; }) : []), claimed = new Set<string>();
let episodes: Episode[] = [], refreshed = -Infinity;
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function save(path: string, value: unknown) {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2)); renameSync(path + '.tmp', path);
}
function refresh(force = false) {
  if (!force && Date.now() - refreshed < 1000) return;
  refreshed = Date.now();
  if (watch) {
    const path = join(root, 'episodes.ndjson'), text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    // A producer may currently be appending the last line. Only complete rows
    // are admitted; malformed complete rows still fail instead of disappearing.
    episodes = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line) as Episode);
  } else episodes = (JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')) as { episodes: Episode[] }).episodes;
  assert.equal(new Set(episodes.map(e => e.name)).size, episodes.length);
  assert(episodes.every(e => resolve(e.result) === join(root, e.name, 'result.json') && resolve(e.field) === join(root, e.name, 'field')));
}
async function run(worker: number) {
  for (;;) {
    refresh();
    // Leave CPU capacity for the producer. Once it has finished, the same
    // verifier can use the Lab's remaining cores without changing any frames.
    if (watch && !existsSync(join(root, 'finished.json')) && worker >= Math.min(workers, 8)) {
      await delay(1000); continue;
    }
    const item = episodes.find(e => !claimed.has(e.name));
    if (!item) {
      const final = join(root, 'finished.json');
      if (!watch || existsSync(final)) {
        if (watch) {
          refresh(true);
          assert.equal(episodes.length, (JSON.parse(readFileSync(final, 'utf8')) as { episodes: number }).episodes);
          if (episodes.some(e => !claimed.has(e.name))) continue;
        }
        return;
      }
      await delay(1000); continue;
    }
    claimed.add(item.name);
    const directory = dirname(item.result),
      original = Object.fromEntries(['field.json', ...readdirSync(join(item.field, 'replays')).map(n => 'replays/' + n)]
        .map(n => [n, sha(join(item.field, n))])),
      viewer = new ReplayViewer([item.field], cache, `http://127.0.0.1:${port}`);
    try {
      const resultSHA256 = sha(item.result), decisionsSHA256 = sha(join(directory, 'decisions.json'));
      if (item.resultSHA256) assert.equal(resultSHA256, item.resultSHA256);
      if (item.fieldSHA256) assert.equal(original['field.json'], item.fieldSHA256);
      if (item.decisionsSHA256) assert.equal(decisionsSHA256, item.decisionsSHA256);
      const entries = viewer.catalog(), episode = JSON.parse(readFileSync(item.result, 'utf8')), expected = episode.simulatedSeconds,
        entry = entries.find(e => e.kind === 'complete') ??
          entries.find(e => e.compatible && e.start === 0 && Math.abs(e.end - expected) < 1e-6);
      assert(entry?.compatible, 'The full episode, including a single-chapter episode, must be available.');
      await viewer.prepare(entry.id);
      while (viewer.job.status === 'preparing') await delay(100);
      const job = viewer.job; assert.equal(job.status, 'ready', JSON.stringify(job));
      if (job.status !== 'ready') throw new Error('Replay not ready.');
      const archive = job.archive, final = JSON.parse(readFileSync(join(item.field, 'field.json'), 'utf8'));
      assert.equal(archive.status, 'verified'); assert.equal(archive.start, 0);
      assert(Math.abs(archive.end - final.room.scene.time) < 1e-6);
      assert.equal(archive.prints, Math.floor(expected + 1e-6));
      let frames = 0, last = -Infinity, shots = 0;
      const packetDigest = createHash('sha256'), previous = completed.get(item.name),
        reused = previous && JSON.stringify(archive) === JSON.stringify(JSON.parse(readFileSync(join(directory, 'prepared.json'), 'utf8')).archive);
      for (const chunk of archive.chunks) {
        const part = chunk.source?.archiveId ?? archive.id, index = chunk.source?.index ?? chunk.index,
          compressed = readFileSync(join(cache, part, `chunk-${index}.bin.gz`));
        packetDigest.update(`${part}/${index}:` + createHash('sha256').update(compressed).digest('hex'));
        if (reused) continue;
        const bytes = gunzipSync(compressed), reader = new SceneFrameReader(decodeRenderFieldView);
        let count = 0;
        for (const packet of replayPackets(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))) {
          const frame = reader.decode(packet); assert(frame);
          assert(frame.state.time >= last - 1e-6); last = frame.state.time;
          shots += decodeDrawingEvents(frame.events).filter(e => e.type === 'muzzle').length;
          count++; frames++;
        }
        assert.equal(count, chunk.frames);
      }
      const cacheSHA256 = packetDigest.digest('hex');
      assert(Object.entries(original).every(([n, hash]) => sha(join(item.field, n)) === hash));
      if (reused) {
        // Reuse the earlier full verification only when every input and packet
        // byte, plus the complete prepared metadata, is still identical.
        assert.deepEqual(previous, JSON.parse(readFileSync(join(directory, 'replay-audit.json'), 'utf8')));
        assert.equal(previous.resultSHA256, resultSHA256); assert.equal(previous.decisionsSHA256, decisionsSHA256);
        assert.deepEqual(previous.sourceHashes, original); assert.equal(previous.cacheSHA256, cacheSHA256);
        console.log(JSON.stringify({ reused: item.name, proof: 'unchanged-inputs-metadata-and-packets' }));
        continue;
      }
      assert.equal(shots, final.room.scene.stats.shots);
      assert(last >= expected - .05, 'The final frame must reach the end of the episode.');
      const result = { episode: item.name, factions: item.factions, slot: item.slot, score: item.score,
        archiveId: archive.id, url: `http://127.0.0.1:${port}/?replay=${archive.id}`, status: archive.status,
        start: archive.start, end: archive.end, chapters: archive.chapters?.length ?? 1, prints: archive.prints,
        frames, primaryShots: shots, originalsUnchanged: true,
        sourceHashes: original, resultSHA256, decisionsSHA256, cacheSHA256,
        endedBy: episode.endedBy, outcome: episode.outcome ?? 'horizon' };
      if (previous) assert.deepEqual(result, previous, 'A previously verified recording changed.');
      else {
        save(join(directory, 'prepared.json'), job); save(join(directory, 'replay-audit.json'), result);
        appendFileSync(journal, JSON.stringify(result) + '\n'); completed.set(item.name, result);
        console.log(JSON.stringify({ verified: item.name, archiveId: archive.id, prints: archive.prints, frames }));
      }
    } finally { await viewer.close(); }
  }
}
await Promise.all(Array.from({ length: workers }, (_, worker) => run(worker)));
assert.equal(completed.size, episodes.length);
save(join(root, 'replays.json'), [...completed.values()]);
