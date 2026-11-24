import { readCommanderCount, readCommanderFill, readWorkerOptions } from './worker-contract.ts';
import type { FieldSaveOptions } from './worker-contract.ts';

export type FieldServerConfig =
  | { testTools: true; save: FieldSaveOptions; commanders?: number; commanderFill?: never }
  | { testTools: false; save: FieldSaveOptions | null; commanders?: never; commanderFill?: never }
  | { testTools: false; save: FieldSaveOptions; commanders?: never; commanderFill: number };
const count = (value: string): number => /^\d+$/.test(value) ? Number(value) : NaN;

// Environment policy is read once by the host. A save and a client message
// never grant test tools or permission to run autonomous public factions.
export function fieldServerConfig(env: NodeJS.ProcessEnv = process.env, preview = false): FieldServerConfig {
  if (env.IMPACTO_TEST_SERVER && !['0', '1'].includes(env.IMPACTO_TEST_SERVER)) throw new Error('IMPACTO_TEST_SERVER deve ser 0 ou 1.');
  const testTools = env.IMPACTO_TEST_SERVER === '1', testDir = env.IMPACTO_TEST_SAVE_DIR,
    requested = env.IMPACTO_TEST_COMMANDERS, fill = env.IMPACTO_AI_MIN_PLAYERS;
  if ((preview || env.NODE_ENV === 'production' || env.IMPACTO_ADDRESS) &&
      (testTools || testDir || requested !== undefined || env.IMPACTO_REHEARSAL || env.IMPACTO_STRESS))
    throw new Error('O servidor de produção não aceita configuração de testes, ensaio ou stress.');
  if (requested !== undefined && !testTools) throw new Error('IMPACTO_TEST_COMMANDERS exige IMPACTO_TEST_SERVER=1.');
  if (!testTools && testDir) throw new Error('IMPACTO_TEST_SAVE_DIR exige IMPACTO_TEST_SERVER=1.');
  const commanders = requested === undefined ? undefined : readCommanderCount(count(requested), testTools),
    commanderFill = fill === undefined ? undefined : readCommanderFill(count(fill));
  let config: FieldServerConfig;
  if (testTools) {
    if (commanderFill !== undefined) throw new Error('A população pública não pode ser combinada com testes, ensaio ou stress.');
    if (!testDir || env.IMPACTO_SAVE_DIR) throw new Error('Use somente IMPACTO_TEST_SAVE_DIR explícito no servidor de testes.');
    config = { testTools: true, save: { dir: testDir }, ...(commanders === undefined ? {} : { commanders }) };
  } else {
    const save = env.IMPACTO_SAVE_DIR ? { dir: env.IMPACTO_SAVE_DIR } : null;
    if (commanderFill === undefined) config = { testTools: false, save };
    else {
      if (!save) throw new Error('A população pública exige uma pasta de save explícita, absoluta e própria do campo.');
      config = { testTools: false, save, commanderFill };
    }
  }
  // Validate all incompatible modes before a test marker or save directory can
  // be written. Fixed test commanders retain their existing normal-field setup.
  readWorkerOptions({ ...config, rehearsal: (commanders ?? 0) > 0 ? null : env.IMPACTO_REHEARSAL ? { bases: [] } : null,
    stress: Number(env.IMPACTO_STRESS) || false });
  return config;
}
