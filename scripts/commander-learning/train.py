"""CPU neuroevolution with immutable episode records, resumable generations and separate evaluation."""
import argparse
import concurrent.futures
import copy
import hashlib
import json
import os
from pathlib import Path
import random
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
REWARDS = ('standard', 'discovery')
SCORE_VERSION = json.loads((ROOT / 'scripts/commander-learning/objective.json').read_text())['version']


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    temporary.replace(path)


def source_digest():
    value = hashlib.sha256()
    files = sorted(p for directory in ('server', 'src', 'scripts/commander-learning', 'native/dynamics/src')
                   for p in (ROOT / directory).rglob('*') if p.is_file() and p.suffix in ('.ts', '.py', '.rs', '.json'))
    for file in files:
        value.update(str(file.relative_to(ROOT)).replace(os.sep, '/').encode())
        value.update(digest(file).encode())
    return value.hexdigest()


def population(champion, size, seed, generation):
    rng = random.Random(seed + generation * 1000003)
    candidates = [copy.deepcopy(champion)]
    sigma = .12 * (.8 ** generation)
    for _ in range((size - 1) // 2):
        delta = [rng.gauss(0, sigma) for _ in champion['parameters']]
        for sign in [-1, 1]:
            model = copy.deepcopy(champion)
            model['parameters'] = [max(-4, min(4, p + sign * d)) for p, d in zip(champion['parameters'], delta)]
            candidates.append(model)
    return candidates


def scenario(raw):
    required = {'name', 'factions', 'slot', 'seed', 'seconds', 'spacing'}
    if not isinstance(raw, dict) or not required <= set(raw) or set(raw) - required - {'center'}:
        raise ValueError('Each scenario needs explicit name, factions, slot, seed, seconds and spacing.')
    value = dict(raw, center=raw.get('center', 0))
    if not isinstance(value['name'], str) or not re.fullmatch(r'[a-z0-9-]{1,60}', value['name']):
        raise ValueError('Use a simple scenario name.')
    if not all(type(value[key]) is int for key in required - {'name'} | {'center'}):
        raise ValueError('Scenario settings must be integers.')
    if not (value['factions'] in (2, 4) and 0 <= value['slot'] < value['factions']
            and 0 < value['seed'] <= 2**31 - 1 and 60 <= value['seconds'] <= 14400
            and 2200 <= value['spacing'] <= 6000 and abs(value['center']) <= 200000):
        raise ValueError('Scenario settings are outside the CPU experiment limits.')
    return value


def evaluation_cases(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 200:
        raise ValueError('Use one to 200 evaluation scenarios.')
    rows = [scenario(item) for item in raw]
    if len({r['name'] for r in rows}) != len(rows):
        raise ValueError('Evaluation names must be unique.')
    return rows


def curriculum(args):
    if args.plan:
        value = json.loads(Path(args.plan).read_text(encoding='utf-8'))
        if (not isinstance(value, dict) or set(value) != {'version', 'training', 'evaluation'}
                or type(value['version']) is not int or value['version'] != 1
                or not isinstance(value['training'], list) or len(value['training']) != args.generations):
            raise ValueError('The versioned plan must match the requested generations.')
        training = []
        for group in value['training']:
            if not isinstance(group, list) or not 1 <= len(group) <= 8:
                raise ValueError('Use one to eight paired scenarios per generation.')
            rows = [scenario(item) for item in group]
            if len({r['name'] for r in rows}) != len(rows):
                raise ValueError('Scenario names must be unique within a generation.')
            training.append(rows)
        evaluation = evaluation_cases(value['evaluation'])
    else:
        def case(name, factions, slot, seed):
            return dict(name=name, factions=factions, slot=slot, seed=seed, seconds=args.seconds, spacing=3600, center=0)
        training = [[case('duel', 2, g % 2, 101 + g), case('arena', 4, 1 + g % 2, 201 + g)]
                    for g in range(args.generations)]
        evaluation = [case(f'f{f}-s{s}', f, s, seed) for f, s, seed in
                      [(2, 0, 9001), (2, 1, 9002)] + [(4, s, 9100 + s) for s in range(4)]]
    if {r['seed'] for group in training for r in group} & {r['seed'] for r in evaluation}:
        raise ValueError('Evaluation seeds must be separate from training.')
    return dict(version=1, training=training, evaluation=evaluation)


class Runner:
    """One completion journal per run. Workers own distinct episode directories."""
    def __init__(self, output, workers, resume=False):
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=resume)
        self.workers = workers
        self.env = dict(os.environ, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1')
        self.index = self.output / 'episodes.ndjson'
        self.rows = {}
        if self.index.exists():
            for line in self.index.read_text(encoding='utf-8').splitlines():
                row = json.loads(line)
                if row['name'] in self.rows:
                    raise ValueError('Duplicate completed episode in the run journal.')
                self.rows[row['name']] = row

    def run(self, name, case, policy, reward, phase, **details):
        directory = self.output / name
        result_file = directory / 'result.json'
        model_hash = None if str(policy) == 'baseline' else digest(policy)
        job = dict(name=name, case=case, policy=str(policy), modelFileSHA256=model_hash,
                   reward=reward, phase=phase, **details)
        job_file = self.output / (name + '.job.json')
        if job_file.exists():
            if json.loads(job_file.read_text()) != job:
                raise ValueError('Existing episode inputs differ: ' + name)
        else:
            write_json(job_file, job)
        if not result_file.exists():
            if directory.exists():
                raise RuntimeError('Preserve and inspect the interrupted episode before retrying: ' + str(directory))
            command = ['node', 'scripts/commander-learning/episode.ts', '--factions', str(case['factions']),
                       '--slot', str(case['slot']), '--seed', str(case['seed']), '--seconds', str(case['seconds']),
                       '--spacing', str(case['spacing']), '--center', str(case['center']), '--reward', reward,
                       '--out', str(directory), '--model', str(policy)]
            with (self.output / (name + '.log')).open('w', encoding='utf-8') as log:
                subprocess.run(command, cwd=ROOT, env=self.env, stdout=log, stderr=subprocess.STDOUT,
                               timeout=1800, check=True)
        value = json.loads(result_file.read_text(encoding='utf-8'))
        if (value.get('scoreVersion') != SCORE_VERSION or value['reward'] != reward
                or value['modelFileSHA256'] != model_hash or value['faults']
                or not (directory / 'decisions.json').exists() or not (directory / 'field/field.json').exists()
                or any(value[k] != case[k] for k in ('factions', 'slot', 'seed', 'spacing', 'center'))
                or value['requestedSeconds'] != case['seconds']):
            raise ValueError('Completed episode identity or integrity differs: ' + name)
        return dict(name=name, scenario=case['name'], **{k: case[k] for k in ('factions', 'slot', 'seed', 'seconds', 'spacing', 'center')},
                    policy=str(policy), reward=reward, phase=phase, score=value['score'], scores=value['scores'],
                    outcome=value['outcome'], endedBy=value['endedBy'], simulatedSeconds=value['simulatedSeconds'],
                    wallSeconds=value['wallSeconds'], discovery=value['discovery'],
                    learnedDecisions=value['learnedDecisions'], candidateCount=value['candidateCount'],
                    actions=value['actions'], refusals=value['refusals'],
                    result=str(result_file), field=str(directory / 'field'), modelFileSHA256=model_hash,
                    resultSHA256=digest(result_file), fieldSHA256=digest(directory / 'field/field.json'),
                    decisionsSHA256=digest(directory / 'decisions.json'), **details)

    def batch(self, jobs):
        rows = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = {pool.submit(self.run, **job): job['name'] for job in jobs}
            for future in concurrent.futures.as_completed(futures):
                row = future.result()
                rows.append(row)
                if row['name'] in self.rows and self.rows[row['name']] != row:
                    raise ValueError('A completed result changed after it was journalled: ' + row['name'])
                if row['name'] not in self.rows:
                    with self.index.open('a', encoding='utf-8') as stream:
                        stream.write(json.dumps(row, separators=(',', ':')) + '\n')
                        stream.flush()
                        os.fsync(stream.fileno())
                    self.rows[row['name']] = row
                    print(json.dumps(dict(completed=row['name'], phase=row['phase'], score=row['score'],
                                          outcome=row['outcome'], seconds=row['simulatedSeconds'])), flush=True)
        return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--generations', type=int, default=2)
    parser.add_argument('--population', type=int, default=5)
    parser.add_argument('--seconds', type=int, default=300)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--seed', type=int, default=20261105)
    parser.add_argument('--plan')
    parser.add_argument('--reward', choices=(*REWARDS, 'compare'), default='standard')
    parser.add_argument('--holdout', help='Sealed scenarios, used only if development improves actual objectives.')
    parser.add_argument('--label')
    parser.add_argument('--patience', type=int, default=0, help='Stop after this many generations without an improvement; zero disables.')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    label = args.label or args.reward
    if not (1 <= args.generations <= 20 and 3 <= args.population <= 33 and args.population % 2 == 1
            and 60 <= args.seconds <= 14400 and 1 <= args.workers <= 16
            and 0 <= args.patience <= 20 and re.fullmatch(r'[a-z0-9-]{1,40}', label)):
        parser.error('Use bounded CPU experiment settings and a simple label.')
    try:
        plan = curriculum(args)
        holdout = evaluation_cases(json.loads(Path(args.holdout).read_text(encoding='utf-8'))) if args.holdout else []
        known_seeds = {r['seed'] for group in plan['training'] for r in group} | {r['seed'] for r in plan['evaluation']}
        if known_seeds & {r['seed'] for r in holdout}:
            raise ValueError('Holdout seeds must be separate from training and development.')
    except (ValueError, TypeError, KeyError) as error:
        parser.error(str(error))
    runner = Runner(args.out, args.workers, args.resume)
    output = runner.output
    spec = dict(plan=plan, generations=args.generations, population=args.population, seed=args.seed,
                reward=args.reward, label=label, patience=args.patience, scoreVersion=SCORE_VERSION,
                sourceSHA256=source_digest(), holdout=holdout)
    spec_file = output / 'run.json'
    if spec_file.exists():
        if json.loads(spec_file.read_text()) != spec:
            raise ValueError('Resume requires the same source, curriculum and search settings.')
    else:
        write_json(spec_file, spec)
        write_json(output / 'curriculum.json', plan)
    if (output / 'summary.json').exists():
        print(json.dumps(dict(done=True, reused=True, summary=str(output / 'summary.json'))), flush=True)
        return
    initial = subprocess.run(['node', 'scripts/commander-learning/episode.ts', '--initial-model'],
                             cwd=ROOT, env=runner.env, check=True, capture_output=True, text=True)
    rewards = REWARDS if args.reward == 'compare' else (args.reward,)
    champions = {reward: json.loads(initial.stdout) for reward in rewards}
    checkpoint_file = output / 'checkpoint.json'
    checkpoint = json.loads(checkpoint_file.read_text()) if checkpoint_file.exists() else None
    generations = checkpoint['generations'] if checkpoint else []
    if checkpoint:
        for reward, model in checkpoint['models'].items():
            if digest(model['file']) != model['sha256']:
                raise ValueError('The checkpoint model changed.')
            champions[reward] = json.loads(Path(model['file']).read_text())
    stale = checkpoint['stale'] if checkpoint else {reward: 0 for reward in rewards}
    started = time.monotonic()
    previous_wall = checkpoint['elapsedWallSeconds'] if checkpoint else 0

    def save_model(model):
        data = json.dumps(model, separators=(',', ':'))
        path = output / ('model-' + hashlib.sha256(data.encode()).hexdigest() + '.json')
        if path.exists():
            if path.read_text(encoding='utf-8') != data:
                raise ValueError('Preserve an existing different model: ' + str(path))
        else:
            path.write_text(data, encoding='utf-8')
        return path

    def episodes(phase, policies, cases):
        jobs, references = {}, {}
        for alias, policy in policies.items():
            model_hash = None if str(policy) == 'baseline' else digest(policy)
            references[alias] = {}
            for case in cases:
                physical = {k: v for k, v in case.items() if k != 'name'}
                case_hash = hashlib.sha256(json.dumps(physical, sort_keys=True).encode()).hexdigest()
                key = hashlib.sha256((str(model_hash) + case_hash).encode()).hexdigest()
                name = 'ep-' + key[:24]
                references[alias][case['name']] = name
                # Reward shaping never changes the trajectory. The same physical
                # episode supplies both bounded scores; reuse it across arms.
                jobs[name] = dict(name=name, case=dict(physical, name='s-' + case_hash[:16]),
                                  policy=policy, reward='standard', phase=phase)
        runner.batch(list(jobs.values()))
        return references

    for generation in range(len(generations), args.generations):
        active = [r for r in rewards if not args.patience or stale[r] < args.patience]
        if not active:
            break
        candidates = {r: population(champions[r], args.population, args.seed, generation) for r in active}
        policies = {f'{r}-{i}': save_model(model) for r in active for i, model in enumerate(candidates[r])}
        cases = plan['training'][generation]
        references = episodes('training', policies, cases)
        arms = {}
        for reward in active:
            means = [sum(runner.rows[n]['scores'][reward] for n in references[f'{reward}-{i}'].values()) / len(cases)
                     for i in range(args.population)]
            best = max(range(len(means)), key=lambda i: means[i])
            champions[reward] = candidates[reward][best]
            improvement = means[best] - means[0]
            stale[reward] = stale[reward] + 1 if improvement <= 1e-12 else 0
            arms[reward] = dict(scores=means, selected=best, improvementOverIncumbent=improvement, stale=stale[reward])
        generations.append(dict(generation=generation, cases=cases, arms=arms, episodes=references))
        models = {r: dict(file=str(save_model(m)), sha256=digest(save_model(m))) for r, m in champions.items()}
        write_json(checkpoint_file, dict(models=models, generations=generations, stale=stale,
                                        elapsedWallSeconds=previous_wall + time.monotonic() - started))
        print(json.dumps(dict(generation=generation, arms=arms)), flush=True)
    selected = {r: save_model(m) for r, m in champions.items()}

    def evaluate(phase, policies, cases):
        references = episodes(phase, dict(baseline='baseline', **policies), cases)
        pairs = []
        for alias in policies:
            for case in cases:
                baseline = runner.rows[references['baseline'][case['name']]]
                model = runner.rows[references[alias][case['name']]]
                pairs.append(dict(**case, arm=alias, baselineEpisode=baseline['name'], modelEpisode=model['name'],
                                  baseline=baseline['scores']['standard'], model=model['scores']['standard'],
                                  difference=model['scores']['standard'] - baseline['scores']['standard'],
                                  baselineOutcome=baseline['outcome'], modelOutcome=model['outcome'],
                                  baselineSeconds=baseline['simulatedSeconds'], modelSeconds=model['simulatedSeconds']))
        return pairs

    pairs = evaluate('development', selected, plan['evaluation'])
    success = ('duel-win', 'base-captured')
    failure = ('duel-loss', 'base-lost')
    evidence = {}
    for reward in rewards:
        rows = [r for r in pairs if r['arm'] == reward]
        counts = {f'{side}{kind}': sum(r[side + 'Outcome'] in outcomes for r in rows)
                  for side in ('baseline', 'model') for kind, outcomes in [('Successes', success), ('Losses', failure)]}
        passed = ((counts['modelSuccesses'] > counts['baselineSuccesses'] and counts['modelLosses'] <= counts['baselineLosses'])
                  or (counts['modelLosses'] < counts['baselineLosses'] and counts['modelSuccesses'] >= counts['baselineSuccesses']))
        evidence[reward] = dict(**counts, passed=passed, meanDifference=sum(r['difference'] for r in rows) / len(rows))
    eligible = [r for r in rewards if evidence[r]['passed']]
    finalist = max(eligible, key=lambda r: (evidence[r]['modelSuccesses'] - evidence[r]['modelLosses'], evidence[r]['meanDifference'])) if eligible else None
    final = evaluate('holdout', {finalist: selected[finalist]}, holdout) if finalist and holdout else []
    schema = json.loads(initial.stdout)
    summary = dict(settings=vars(args), method='CPU antithetic parameter search with a fixed preference for the classical choice.',
                   modelSchema=dict(version=schema['version'], inputs=len(schema['features']), hidden=schema['hidden'],
                                    parameters=len(schema['parameters']), baselineMargin=schema['baselineMargin']),
                   scoreVersion=SCORE_VERSION, evaluationScore='standard, excluding the discovery bonus',
                   curriculum=plan, totalWallSeconds=previous_wall + time.monotonic() - started,
                   generations=generations, stale=stale,
                   candidateEvaluations=sum(len(g['arms']) * args.population * len(g['cases']) for g in generations),
                   stoppedEarly={r: sum(r in g['arms'] for g in generations) < args.generations for r in rewards},
                   evaluation=pairs, evidence=evidence, finalist=finalist, holdout=final,
                   holdoutStatus='completed' if final else 'rejected-at-development' if holdout else 'not-requested',
                   selected={r: dict(file=str(p), sha256=digest(p)) for r, p in selected.items()},
                   episodes=list(runner.rows.values()),
                   limits='One optimizer seed per arm; reward ablation uses matching scenarios. Horizon games are partial. No production promotion.')
    write_json(output / 'summary.json', summary)
    write_json(output / 'finished.json', dict(episodes=len(runner.rows)))
    print(json.dumps(dict(done=True, summary=str(output / 'summary.json'))), flush=True)


if __name__ == '__main__':
    main()

