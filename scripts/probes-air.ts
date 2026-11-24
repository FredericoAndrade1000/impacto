// Bounded probes of the pilots against aircraft and of aircraft against what stands on the ground: the trials of
// tests/helpers/air-trials.js, one a line, as JSON. `node scripts/probes-air.ts defence` runs every shooter against a drone
// hovering and crossing at three heights; `strike` a gunship against each target; a JSON object runs one trial.
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();
const { defence, strike } = await import('../tests/helpers/air-trials.js');
const SHOOTERS = ['heavy', 'scout', 'skywatch', 'guard-post', 'bunker'], HEIGHTS = [30, 100, 300], SPEEDS = [0, 30, 60, 100];
const TARGETS = [{ target: 'heavy' }, { target: 'truck', drive: true }, { target: 'guard-post' }];
const [, , what = 'defence', only] = process.argv;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// The air assays remain JavaScript test helpers; the dynamic invocation admits
// only the object it reports, without asserting a foreign trial/result DTO.
const line = (kind: string, trial: Record<string, unknown>, run: Function) => {
  const started = Date.now(), result: unknown = Reflect.apply(run, undefined, [trial]);
  if (!isRecord(result)) throw new TypeError('Air trial must return a result object.');
  console.log(JSON.stringify({ kind, ...trial, ...result, ms: Date.now() - started }));
};
// A trial of one, with `trace`, tells each second of it as well.
if (what.startsWith('{')) {
  const trial: unknown = JSON.parse(what);
  if (!isRecord(trial)) throw new TypeError('Air trial needs an options object.');
  if (trial.trace) trial.trace = (step: unknown) => console.log(JSON.stringify(step));
  line(trial.target ? 'strike' : 'defence', trial, trial.target ? strike : defence);
}
else if (what === 'defence') {
  for (const shooter of only ? only.split(',') : SHOOTERS) for (const speed of SPEEDS) for (const height of HEIGHTS)
    line('defence', { shooter, speed, height }, defence);
} else if (what === 'strike') for (const trial of TARGETS) line('strike', trial, strike);
else throw new Error(`Unknown probe: ${what}`);
