import { record } from './operational-input.ts';
import { workerJobs } from './worker-pool.ts';
import { executeReviewCase } from './review-execution.ts';
workerJobs(executeReviewCase, (error, entry) => ({ error: error instanceof Error ? error.message : record(error) ? error.message : undefined, probe: record(entry) ? entry.probe : undefined, status: 'invalid' }));
