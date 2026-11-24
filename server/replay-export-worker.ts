import { userError } from '../src/user-message.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayField } from './field-host.ts';
import type { FieldHost, ReplayOutcome } from './field-host.ts';
import { diaryLines } from './field-journal.ts';
import { ReplayRecording } from './replay-recording.ts';
import { initNativeDynamics, nativeDynamicsRuntime } from '../src/native-dynamics.ts';

const port = parentPort;
if (!port) throw new Error('Replay worker requires a parent.');
const input: unknown = workerData;
if (!input || typeof input !== 'object' || !('file' in input) || typeof input.file !== 'string' ||
  !('directory' in input) || typeof input.directory !== 'string' || !('id' in input) || typeof input.id !== 'string' ||
  !('name' in input) || typeof input.name !== 'string' || !('until' in input) || typeof input.until !== 'number' ||
  !('startStep' in input) || typeof input.startStep !== 'number') throw new Error('Invalid replay export.');
async function* checkedDiary(file: string) {
  let header = true;
  for await (const line of diaryLines(file)) {
    const value: unknown = JSON.parse(line);
    if (!header && (!Array.isArray(value) || !Number.isSafeInteger(value[0]) || typeof value[1] !== 'string'))
      throw new Error('Invalid complete diary entry.');
    header = false; yield line;
  }
}
let host: FieldHost | undefined;
const startStep = input.startStep;
try {
  await initNativeDynamics();
  if (nativeDynamicsRuntime !== 'native') throw userError('O visualizador requer o núcleo Native do servidor.');
  const recording = new ReplayRecording(input.directory);
  let reportedAt = -Infinity;
  const diary = checkedDiary(input.file);
  let outcome: ReplayOutcome;
  try { outcome = await replayField(diary, {
    until: input.until,
    observe(current, phase) { host = current; recording.observe(current, phase); },
    progress(step) {
      if (performance.now() - reportedAt < 250) return;
      reportedAt = performance.now(); port.postMessage({ type: 'progress', time: (step - startStep) / 60 });
    },
  }); } finally { await diary.return(undefined); }
  const archive = recording.finish(outcome, input.id, input.name);
  writeFileSync(join(input.directory, 'manifest.json'), JSON.stringify(archive));
  port.postMessage({ type: 'ready', archive });
} catch (error) {
  port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
} finally { host?.room.world.dispose(); }
