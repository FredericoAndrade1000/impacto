import { parentPort } from 'node:worker_threads';
import { DESIGN_VERSION } from '../../src/design-contract.ts';

const reply: { designVersion: number } = { designVersion: DESIGN_VERSION };
parentPort?.postMessage(reply);
