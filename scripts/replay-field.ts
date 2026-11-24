// Runs a field again from its diary (server/field-host.ts) — the field it began as, given what reached it at the
// steps it came — and says whether it went as it went then and, if not, where it went otherwise; where it fell,
// whether it falls there again, and of what. A diary is run again on the core it was written with: on another build,
// or another machine that rounds otherwise, a field need not go alike. A diary that begins from the field written out
// whole is read by the native core alone.
//   node scripts/replay-field.ts <diário ou pasta> [--ate <passo>] [--salvar <pasta>]
// A directory is one a field is kept in (its newest diary, in `replays`), or one of diaries. `--ate` stops the field
// as it comes to that step. `--salvar` writes the field as it then stands into a directory with no field in it, as a
// field to resume (field-save.js): a server started on that directory opens it there. Its seats have their names
// (j1, j3…) for tokens.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { coreBuild, diaryLines, findDiary } from '../server/field-journal.ts';
import { replayField } from '../server/field-host.ts';
import { fieldStore } from '../server/field-save.ts';
import { parseJSON, record, errorText } from './operational-input.ts';

const USAGE = 'Uso: node scripts/replay-field.ts <diário ou pasta> [--ate <passo>] [--salvar <pasta>]';
const args = process.argv.slice(2), option = (name: string): string | null => {
  const i = args.indexOf(name);
  return i < 0 ? null : args.splice(i, 2)[1] ?? '';
};
const until = option('--ate'), into = option('--salvar');
if (args.length !== 1 || until !== null && !/^\d+$/.test(until) || into === '') { console.error(USAGE); process.exit(2); }
if (into && existsSync(join(into, 'field.json'))) { console.error(`Já há um campo salvo em ${into}: escolha uma pasta sem campo.`); process.exit(2); }

const input = args[0];
if (input === undefined) throw new Error(USAGE);
const file = findDiary(input), clock = (steps: number): string => {
    const seconds = Math.floor(steps / 60);
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} de campo`;
  },
  short = (text: string | null | undefined): string => text == null ? '(nada: o diário acaba ali)' : text.length > 400 ? text.slice(0, 400) + '…' : text;
const { value: first } = await diaryLines(file).next();
if (typeof first !== 'string') throw new Error('O diário de campo está vazio.');
const header = parseJSON(first), here = coreBuild();
if (!record(header) || !record(header.core) || header.snapshot && typeof header.step !== 'number') throw new Error('Cabeçalho do diário inválido.');
const began = header.snapshot && typeof header.step === 'number' ? `de uma foto do campo no passo ${header.step} (${clock(header.step)})` : header.origin ? 'num campo retomado' : 'num campo novo';
console.log(`Diário ${file}\n  começado em ${header.at}, ${began}${header.field ? ' de ensaio' : ''}.`);
if (header.core.build !== here.build)
  console.log(`  Aviso: escrito com outro núcleo (${header.core.runtime} ${header.core.platform}-${header.core.arch} ${typeof header.core.build === 'string' ? header.core.build.slice(0, 12) : undefined}; aqui ${here.runtime} ${here.platform}-${here.arch} ${here.build.slice(0, 12)}): pode divergir só por isso.`);

let toldAt = performance.now();
const started = toldAt, outcome = await replayField(diaryLines(file), { until: until === null ? Infinity : Number(until), progress: (step: number) => {
  if (performance.now() - toldAt < 5000) return;
  toldAt = performance.now(); console.log(`  … passo ${step} (${clock(step)})`);
} });
const { how, step, prints } = outcome, where = `passo ${step} (${clock(step)})`, took = ((performance.now() - started) / 1000).toFixed(1);
if (how === 'end') console.log(`Igual ao que foi até o fim do diário: ${where}, ${prints} impressões conferidas, em ${took} s.`);
if (how === 'until') console.log(`Parado ao chegar ao ${where}, como pedido: igual ao que foi até ali (${prints} impressões conferidas).`);
if (how === 'fell') console.log(`O campo caiu no ${where} como caiu então, igual até ali (${prints} impressões conferidas):\n${errorText(outcome.error)}`);
if (how === 'diverged') {
  console.log(`Divergiu no ${where}, depois de ${prints} impressões iguais.\n  O diário diz: ${short(outcome.expected)}\n  O replay deu:  ${short(outcome.got)}`);
  if (outcome.error) console.log(errorText(outcome.error));
  process.exitCode = 1;
}
if (into) {
  if (fieldStore(into).save(outcome.host.room)) console.log(`Campo do ${where} salvo em ${join(into, 'field.json')}.`);
  else { console.error('Não foi possível gravar o campo recuperado. O destino não foi confirmado como salvo.'); process.exitCode = 1; }
}
