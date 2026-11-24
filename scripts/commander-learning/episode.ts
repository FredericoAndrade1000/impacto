import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { SharedRoom } from '../../server/room.ts';
import { FieldHost, DIARY } from '../../server/field-host.ts';
import { observeCommander } from '../../server/commander-observation.ts';
import { fieldStore } from '../../server/field-save.ts';
import { writeField } from '../../server/field-snapshot.ts';
import { initNativeDynamics, nativeDynamicsRuntime } from '../../src/native-dynamics.ts';
import { nativeRuntimeInfo } from '../native-dynamics-host.ts';
import { economicCapital, economicProposals, FEATURES, PARAMETERS, initialEconomicModel, readEconomicModel, selectEconomicProposal } from './policy.ts';
import { EconomicHistory } from './history.ts';
import { episodeScore, REWARDS, SCORE_VERSION } from './objective.ts';
import type { EpisodeOutcome, Reward } from './objective.ts';
import { DiscoveryProgress } from './discovery.ts';

function option(key: string, fallback: string): string {
  const at = process.argv.indexOf(key); return at < 0 ? fallback : process.argv[at + 1]!;
}
if (process.argv.includes('--initial-model')) {
  console.log(JSON.stringify(initialEconomicModel()));
} else {
  const count = Number(option('--factions', '2')), seconds = Number(option('--seconds', '180')),
    seedInput = Number(option('--seed', '1')), slot = Number(option('--slot', '0')), spacing = Number(option('--spacing', '3600')),
    center = Number(option('--center', '0')), rewardInput = option('--reward', 'standard'),
    directory = resolve(option('--out', 'validation/commander-learning/episode')), modelFile = option('--model', 'baseline');
  assert([2, 4].includes(count) && Number.isInteger(seconds) && seconds >= 10 && seconds <= 14400);
  assert(Number.isInteger(spacing) && spacing >= 2200 && spacing <= 6000);
  assert(Number.isInteger(center) && Math.abs(center) <= 200000 && REWARDS.includes(rewardInput as Reward));
  const reward = rewardInput as Reward;
  assert(Number.isSafeInteger(seedInput) && seedInput > 0 && Number.isInteger(slot) && slot >= 0 && slot < count);
  assert(!existsSync(directory), 'Preserve existing episodes.');
  await initNativeDynamics(); assert.equal(nativeDynamicsRuntime, 'native');
  const modelBytes = modelFile === 'baseline' ? null : readFileSync(modelFile),
    model = modelBytes ? readEconomicModel(JSON.parse(modelBytes.toString('utf8'))) : null,
    modelFileSHA256 = modelBytes ? createHash('sha256').update(modelBytes).digest('hex') : null,
    modelSHA256 = model ? createHash('sha256').update(JSON.stringify(model)).digest('hex') : null;
  // Vary starting positions on the same physical world; this is not advertised
  // as a new terrain seed. Native and room random state remain serializable.
  const shift = (Math.imul(seedInput, 0x9e3779b1) >>> 0) / 4294967296 * 500 - 250,
    positions = Array.from({ length: count }, (_, i) => center + (i - (count - 1) / 2) * spacing + shift),
    room = new SharedRoom({ fog: true, base: i => positions[i]! }),
    host = new FieldHost(room), started = performance.now();
  mkdirSync(join(directory, 'field', 'replays'), { recursive: true });
  try {
    assert(positions.every(x => x > room.limits.minX + 1000 && x < room.limits.maxX - 1000));
    const seats = positions.map((_, i) => room.addCommander(i === slot ? 'Política em avaliação' : `Referência ${i}`,
      i % 2 ? 'cautious' : 'balanced', (i + 1).toString(16).padStart(16, '0'))), learner = seats[slot]!;
    if (count === 2) room.startDuel();
    room.site = null;
    host.dir = join(directory, 'field', 'replays'); host.begin({ origin: null, snapshot: writeField(room, host.publication) });
    const initial = observeCommander(room, learner.id), initialCapital = economicCapital(initial),
      discovery = new DiscoveryProgress(initial), history = new EconomicHistory(),
      samples: unknown[] = [], decisions: unknown[] = [];
    let learnedDecisions = 0, candidateCount = 0, selectionMs = 0, samplingMs = 0, objectiveAt: number | null = null,
      localObjective: 'base-captured' | 'base-lost' | null = null;
    for (let tick = 0; tick < seconds * 60 && !host.ended; tick++) {
      if (!room.ended) host.decideCommander(learner.id, (o, state) => {
        discovery.observe(o);
        const at = performance.now(), proposals = economicProposals(o, state, history.observe(o)); samplingMs += performance.now() - at;
        const selecting = performance.now(), chosen = model ? selectEconomicProposal(model, proposals) : 0; selectionMs += performance.now() - selecting;
        candidateCount += proposals.length; if (model && proposals.length > 1) learnedDecisions++;
        decisions.push({ at: o.time, chosen, proposals: proposals.map(p => ({ choice: p.choice, features: p.features })) });
        return proposals[chosen]!.choice;
      });
      host.step(() => 1);
      if (room.steps % 60 === 0) {
        const faction = room.factions.get(learner.factionId)!;
        if (count === 4) {
          localObjective = !faction.base ? 'base-lost' : faction.taken ? 'base-captured' : null;
          if (localObjective) objectiveAt = room.world.time;
        }
        if (room.steps % (60 * 30) === 0) {
          const o = observeCommander(room, learner.id); discovery.observe(o);
          samples.push({ at: o.time, capital: economicCapital(o), stock: o.stock,
            units: o.units.length, ready: o.units.filter(u => u.ready).length, siege: o.besieged,
            industry: o.industry, knownBases: o.bases.length, threats: o.threats.length,
            discovery: discovery.summary(), operation: structuredClone(room.commanders.get(learner.id)!.operation),
            actions: room.commanders.get(learner.id)!.actions });
        }
        if (room.steps % (60 * 300) === 0) console.log(JSON.stringify({ progress: room.world.time,
          actions: room.commanders.get(learner.id)!.actions, wallSeconds: (performance.now() - started) / 1000 }));
        if (localObjective) break;
      }
    }
    const final = observeCommander(room, learner.id); discovery.observe(final);
    const duel = room.duel,
      outcome: EpisodeOutcome = duel?.phase === 'won' ? duel.winner === learner.factionId ? 'duel-win' : 'duel-loss' :
        duel?.phase === 'draw' ? 'duel-draw' : localObjective ?? 'horizon',
      scores = { standard: episodeScore(outcome, initialCapital, economicCapital(final)),
        discovery: episodeScore(outcome, initialCapital, economicCapital(final), discovery.value) },
      score = scores[reward],
      result = { at: new Date().toISOString(), factions: count, slot, seed: seedInput, spacing, center, positions, requestedSeconds: seconds,
        simulatedSeconds: room.world.time, wallSeconds: (performance.now() - started) / 1000,
        endedBy: host.ended ? 'definitive-duel' : localObjective ?? 'fixed-horizon', duel,
        objectiveAt: duel && duel.phase !== 'playing' ? duel.at : objectiveAt, outcome, score, scores, scoreVersion: SCORE_VERSION, reward,
        discovery: discovery.summary(), initialCapital, finalCapital: economicCapital(final), finalStock: final.stock,
        modelSHA256, modelFileSHA256, digest: room.digest(), learnedDecisions, candidateCount, selectionMs, samplingMs,
        actions: room.commanders.get(learner.id)!.actions, refusals: room.commanders.get(learner.id)!.refusals,
        selector: { version: 2, inputs: FEATURES.length, parameters: PARAMETERS, baselineMargin: model?.baselineMargin ?? null },
        native: nativeRuntimeInfo(), diary: DIARY, fieldId: room.fieldId, faults: [...room.faults], samples,
        method: 'Normal kit, stocks, industry, 60 Hz Native physics and faction fog; one economic selector against unchanged ordinary commanders. All chosen intentions are journalled. No online training or public-server changes.' };
    assert.equal(room.faults.size, 0);
    assert(fieldStore(join(directory, 'field')).save(host)); host.flush(); host.diary?.close(); host.diary = null;
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(directory, 'decisions.json'), JSON.stringify(decisions));
    console.log(JSON.stringify(result));
  } finally { host.diary?.close(); room.world.dispose(); }
}
