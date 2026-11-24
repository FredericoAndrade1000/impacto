// Offline sensitivity, not additional games or evidence of a better strategy.
// Compare both margins on the exact same classical development observations.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { BASELINE_MARGIN, initialEconomicModel, selectEconomicProposal } from './policy.ts';
import type { Proposal } from './policy.ts';

const root = resolve(process.argv[2]!), read = (path: string) => JSON.parse(readFileSync(path, 'utf8')),
  summary = read(join(root, 'summary.json')) as { evaluation: { baselineEpisode: string }[] },
  rows = readFileSync(join(root, 'episodes.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as
    { name: string; policy: string; result: string; decisionsSHA256: string }),
  episodes = [...new Set(summary.evaluation.map(p => p.baselineEpisode))], states: Proposal[][] = [],
  hashes: Record<string, string> = {};
for (const name of episodes) {
  const row = rows.find(r => r.name === name)!; assert.equal(row.policy, 'baseline');
  const bytes = readFileSync(join(dirname(row.result), 'decisions.json')),
    hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, row.decisionsSHA256); hashes[name] = hash;
  for (const decision of JSON.parse(bytes.toString('utf8')) as { chosen: number; proposals: Proposal[] }[]) {
    assert.equal(decision.chosen, 0);
    if (decision.proposals.length > 1) states.push(decision.proposals);
  }
}
assert(states.length > 0, 'Need actual multi-choice classical observations.');
const initial = initialEconomicModel();
assert(states.every(proposals => selectEconomicProposal(initial, proposals) === 0));
let seed = 20261106;
const uniform = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; },
  normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()),
  directions = Array.from({ length: 8 }, () => initial.parameters.map(normal));
const measurements = [1e-6, .01, .12].map(sigma => {
  const paired = directions.flatMap(delta => [-1, 1].map(sign => {
    const model = { ...initial, parameters: initial.parameters.map((p, i) => p + sign * sigma * delta[i]!) },
      without = { ...model, baselineMargin: 0 };
    let withoutMargin = 0, withMargin = 0, differentSelections = 0;
    for (const proposals of states) {
      const a = selectEconomicProposal(without, proposals), b = selectEconomicProposal(model, proposals);
      withoutMargin += Number(a !== 0); withMargin += Number(b !== 0); differentSelections += Number(a !== b);
    }
    return { withoutMargin, withMargin, differentSelections };
  })), comparisons = states.length * paired.length;
  const count = (key: keyof typeof paired[number]) => paired.reduce((n, row) => n + row[key], 0);
  return { sigma, perturbations: paired.length, comparisons,
    withoutMargin: count('withoutMargin') / comparisons, withMargin: count('withMargin') / comparisons,
    differentSelections: count('differentSelections') / comparisons, paired };
});
const report = { method: 'Matched offline perturbations around the neutral V2 model; eight antithetic Gaussian directions, three scales. All states come from classical development games, including forced decisions only when there is more than one distinct proposal. This does not estimate win rates or the causal gameplay effect of the margin.',
  seed: 20261106, baselineMargin: BASELINE_MARGIN, episodes, sourceDecisionHashes: hashes,
  states: states.length, physicalGamesAdded: 0, measurements };
writeFileSync(join(root, 'stability.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ states: report.states, measurements: measurements.map(({ paired, ...r }) => r) }));
