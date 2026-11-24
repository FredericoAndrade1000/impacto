import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, parse } from 'node:path';
import type { FieldSaveOptions } from './worker-contract.ts';

export const TEST_MARKER = 'test-server.json';
const PURPOSE = 'impacto-test-server';
// Operational provenance is outside Room/save/replay. It never grants a socket permission.
export function checkTestSave(testTools: boolean, save: FieldSaveOptions | null | undefined, stress = false): void {
  if (typeof testTools !== 'boolean') throw new Error('Modo de testes inválido.');
  if (!testTools) {
    if (save?.dir && existsSync(join(save.dir, TEST_MARKER))) throw new Error('Esta pasta pertence a um servidor de testes; não abra como campo normal.');
    return;
  }
  if (stress || !save?.dir || !isAbsolute(save.dir)) throw new Error('O servidor de testes exige uma pasta de save absoluta e isolada.');
  const dir = resolve(save.dir), marker = join(dir, TEST_MARKER);
  if (dir === parse(dir).root) throw new Error('Escolha uma pasta exclusiva para o servidor de testes.');
  if (existsSync(marker)) {
    let metadata: unknown;
    try { metadata = JSON.parse(readFileSync(marker, 'utf8')); } catch { throw new Error('Identificação da pasta de testes inválida.'); }
    if (!metadata || typeof metadata !== 'object' || !('purpose' in metadata) || metadata.purpose !== PURPOSE || !('version' in metadata) || metadata.version !== 1)
      throw new Error('Identificação da pasta de testes inválida.');
    return;
  }
  if (existsSync(dir) && readdirSync(dir).length) throw new Error('A pasta de testes precisa ser nova/vazia ou já identificada como teste; os dados existentes foram preservados.');
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, JSON.stringify({ purpose: PURPOSE, version: 1 }) + '\n', { encoding: 'utf8', flag: 'wx' });
}
