// How long the tests of each file took, in milliseconds by file under tests/, for run-tests.ts to start
// the longest first next time. A file whose tests failed keeps its time all the same.
import { relative } from 'node:path';

interface TestEvent { type: string; data: { file?: string; nesting?: number; details?: { duration_ms?: number } } }

export default async function* testTimes(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const files: Record<string, number> = {};
  for await (const { type, data } of source) {
    if ((type !== 'test:pass' && type !== 'test:fail') || data.nesting !== 0 || !data.file) continue;
    const file = relative(process.cwd(), data.file).replaceAll('\\', '/');
    files[file] = (files[file] ?? 0) + (data.details?.duration_ms ?? 0);
  }
  yield JSON.stringify(files);
}
