// Measures the stress field (server/stress-field.ts) without a server or a page: npm run stress:measure [-- factions [seconds]].
// Fixed steps and one frame per faction every three steps (20 Hz of simulated time). This microbenchmark has
// no sockets, squad/faction messages, backpressure or real-time cadence. Compression is independent raw deflate
// at level 1, an estimate of frame payload size rather than WebSocket traffic or full server capacity.
// What it prints: step and frame preparation costs, and estimated bytes for one receiver per faction.
import { chapters } from '../server/fog.ts';
import { stressField } from '../server/stress-field.ts';
import { Publication } from '../server/publication.ts';
import { FrameLedger, FrameWriter, tellEvent } from '../src/network-protocol.ts';
import { shotCount } from '../src/shots.ts';
import { deflateRawSync } from 'node:zlib';
import { parseJSON, record, expectRecord, expectArray } from './operational-input.ts';

const FACTIONS = Number(process.argv[2]) || 20, SECONDS = Number(process.argv[3]) || 20, WARM = 5, FRAME_STEPS = 3;
const timed: Record<string, { ms: number; calls: number; worst: number }> = {}, clock = (label: string, start: number): void => { const entry = timed[label] ||= { ms: 0, calls: 0, worst: 0 }, ms = performance.now() - start; entry.ms += ms; entry.calls++; if (ms > entry.worst) entry.worst = ms; };
function measured<Result>(label: string, run: () => Result): Result { const start = performance.now(); try { return run(); } finally { clock(label, start); } }

let start = performance.now();
const stress = stressField(FACTIONS), room = stress.room, world = room.world, factions = [...room.factions.keys()];
console.log(`Campo: ${factions.length} facções, ${world.actors.length} construções, ${world.plates.length} chapas e ${world.modules.length} peças, posto em ${((performance.now() - start) / 1000).toFixed(1)} s.`);
const sight = room.sight.bind(room), survey = room.survey.bind(room), fieldStep = room.field.step.bind(room.field);
room.sight = (...args: Parameters<typeof sight>) => measured('sensores (teamSight)', () => sight(...args));
room.survey = (...args: Parameters<typeof survey>) => measured('vistoria (survey)', () => survey(...args));
room.field.step = (...args: Parameters<typeof fieldStep>) => measured('núcleo (passo)', () => fieldStep(...args));
{ const game = room.field.game(), call = game.call;
  game.call = new Proxy(call, { apply(target, receiver: unknown, args: unknown[]): unknown {
    const began = performance.now();
    try { const result: unknown = Reflect.apply(target, receiver, args); return result; }
    finally { const message = args[0]; if (record(message) && (message.op === 'sync' || message.op === 'input')) clock(message.op === 'sync' ? 'leitura da cena (sync)' : 'ordens (input)', began); }
  } }); }

type CostName = 'snapshot' | 'publication' | 'chapters' | 'audience' | 'encode';
const COSTS: CostName[] = ['snapshot', 'publication', 'chapters', 'audience', 'encode'];
const publication = new Publication(), ledger = new FrameLedger(), ends = factions.map(faction => { const bytes: number[] = [], sent: number[] = []; return { faction, writer: new FrameWriter(ledger), bytes, sent, rounds: 0, events: 0 }; }),
  steps: number[] = [], frame = { snapshot: 0, publication: 0, chapters: 0, audience: 0, encode: 0, turns: 0, rounds: 0, events: 0 }, parts: Record<string, number> = {};
const header = (buffer: ArrayBuffer): Record<string, unknown> => expectRecord(parseJSON(new TextDecoder().decode(new Uint8Array(buffer, 8, new DataView(buffer).getUint32(4, true))))), size = (value: unknown): number => JSON.stringify(value)?.length ?? 0;
for (let step = 0, turn = 0; step < (WARM + SECONDS) * 60; step++) {
  const measured = step >= WARM * 60;
  if (!measured) for (const entry of Object.values(timed)) entry.ms = entry.calls = entry.worst = 0;
  start = performance.now(); room.step({ quiet: true }); if (measured) steps.push(performance.now() - start);
  stress.feed(world.time);
  if (step % FRAME_STEPS !== FRAME_STEPS - 1) continue;
  // Read as the host reads it (FieldHost.tell): the publication is handed the scene, which copies none of its pieces.
  let at = performance.now(), read = at;
  const published = world.snapshot((snapshot, sources) => { read = performance.now(); return publication.state(snapshot, sources); }),
    cost: Record<CostName, number> = { snapshot: read - at, publication: 0, chapters: 0, audience: 0, encode: 0 }; at = read;
  if (!published.shots) throw new Error('Quadro medido sem bloco de projéteis.');
  const state = { ...published, shots: { ...published.shots, drag: world.shotDrags }, shared: true, players: room.roster() };
  const events = world.drainEvents().map(tellEvent), lap = () => { const now = performance.now(), ms = now - at; at = now; return ms; }; cost.publication = lap();
  const told = chapters(state); cost.chapters = lap(); cost.audience = cost.encode = 0;
  ledger.turn();
  for (const end of ends) {
    const { state: sent, events: heard } = room.audience(state, told, events, end.faction); cost.audience += lap();
    const buffer = end.writer.encode({ type: 'frame', state: sent, events: heard }, turn === 0); cost.encode += lap();
    if (!measured) continue;
    end.bytes.push(buffer.byteLength); end.sent.push(deflateRawSync(new Uint8Array(buffer), { level: 1 }).length); end.rounds += shotCount(sent.shots); end.events += heard.length;
    // Where the bytes of a frame go, of one player, on one turn in twenty.
    if (end === ends[0] && turn % 20 === 0) {
      const head = header(buffer), state = expectRecord(head.state), add = (name: string, bytes: number): void => { parts[name] = (parts[name] || 0) + bytes; };
      add('eventos', size(head.events)); add('projéteis', size(state.shots)); add('binário', buffer.byteLength - 8 - new DataView(buffer).getUint32(4, true));
      for (const name of ['actors', 'plates', 'modules']) { const delta = state[name]; for (const value of record(delta) && delta.with ? expectArray(delta.with) : []) {
        const words = expectRecord(value); for (const key of Object.keys(words)) add(name + '.' + key, size(words[key]) + key.length + 4);
      } }
      parts.turns = (parts.turns || 0) + 1;
    }
    lap();
  }
  if (measured) { for (const key of COSTS) frame[key] += cost[key]; frame.turns++; frame.rounds = Math.max(frame.rounds, shotCount(state.shots)); frame.events += events.length; }
  turn++;
}
const mean = (list: readonly number[]): number => list.reduce((sum, value) => sum + value, 0) / list.length, sorted = steps.slice().sort((a, b) => a - b), at = (share: number): number => { const value = sorted[Math.floor(sorted.length * share)]; if (value === undefined) throw new Error('Nenhum passo medido.'); return value; }, worst = sorted.at(-1);
if (worst === undefined) throw new Error('Nenhum passo medido.');
console.log(`Passo (ms; 16,7 para 60 por segundo): média ${mean(steps).toFixed(2)}, mediana ${at(.5).toFixed(2)}, p95 ${at(.95).toFixed(2)}, pior ${worst.toFixed(1)}.`);
for (const [label, entry] of Object.entries(timed).sort((a, b) => b[1].ms - a[1].ms)) console.log(`  ${label}: ${(entry.ms / steps.length).toFixed(2)} ms por passo, ${entry.calls} chamadas, pior ${entry.worst.toFixed(1)} ms`);
const per = (key: CostName): string => (frame[key] / frame.turns).toFixed(2);
console.log(`Quadros de um turno, das ${ends.length} facções (ms): cena ${per('snapshot')}, publicação ${per('publication')}, capítulos ${per('chapters')}, audiência ${per('audience')}, codificar ${per('encode')}.`);
console.log(`No campo: até ${frame.rounds} projéteis em voo e ${(frame.events / frame.turns).toFixed(0)} eventos por turno; ${[...room.records.values()].filter(record => record.wreck).length} destroços.`);
const players = ends.map(end => mean(end.bytes)), peak = Math.max(...ends.map(end => Math.max(...end.bytes))), wire = mean(ends.map(end => mean(end.sent)));
console.log(`Por receptor simulado: ${Math.round(mean(players))} bytes por quadro em média (${Math.round(Math.max(...players))} no que mais recebe, pico ${peak}), ${(mean(players) * 60 / FRAME_STEPS / 1e6).toFixed(2)} MB/s a 20 Hz simulados; ` +
  `estimativa com deflate isolado nível 1, ${Math.round(wire)} bytes por quadro, ${(wire * 60 / FRAME_STEPS / 1e6).toFixed(2)} MB/s a 20 Hz simulados (sem metadados, framing WebSocket ou backpressure); ` +
  `${(mean(ends.map(end => end.rounds)) / frame.turns).toFixed(0)} projéteis e ${(mean(ends.map(end => end.events)) / frame.turns).toFixed(0)} eventos por quadro.`);
console.log('Um receptor simulado, bytes por quadro: ' + Object.entries(parts).filter(([name]) => name !== 'turns').sort((a, b) => b[1] - a[1]).slice(0, 18).map(([name, bytes]) => `${name} ${Math.round(bytes / (parts.turns ?? 0))}`).join(', '));
world.dispose(); process.exit(0);
