// Explicit offline migration to base facilities. Writes only to a new directory;
// the original snapshot preserves the retired point balances for review.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SharedRoom } from '../server/room.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { BASIC_INDUSTRY, FULL_INDUSTRY, industrialAdmission } from '../src/industry.ts';
import type { IndustryLevels } from '../src/industry.ts';
import { newIndustry } from '../server/industry.ts';
import { compileDraft } from '../src/structured-construction.ts';
import { record, parseJSON, cloneJSON, errorMessage } from './operational-input.ts';

export const FROM_SAVE = 28;
const clone = cloneJSON;
// What the core reads afresh at the first step of a scene taken up again and keeps nothing of: where a wheel or a skid
// meets the ground. A field saved after a step has it; the same field just reopened has none yet.
const READINGS = new Set(['groundContact', 'grounded']);
// Only the re-admitted physics scene may round its final digits, and read again what it reads at each step. Resources,
// identities and every non-progression room field must be exactly preserved.
function same(a: unknown, b: unknown, physics = false): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b || physics && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value: unknown, index: number) => same(value, b[index], physics));
  if (!record(a) || !record(b)) return false;
  // Old checkpoints can omit grounded; Native recreates this transient contact
  // observation on resume. Its presence is as disposable as its saved value.
  const keys = (value: Record<string, unknown>) => Object.keys(value).filter(key => !physics || !READINGS.has(key)), left = keys(a), right = keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && same(a[key], b[key], physics || key === 'scene'));
}
// Version 28 knowledge becomes the least completed facility levels covering the
// learned families and saved designs. Free conversion grants no salvage capital.
const LEGACY_LEVELS: Readonly<Record<string, Partial<IndustryLevels>>> = {
  'extraction-plants': {}, paving: {}, outposts: {}, 'light-alloys': { processing: 2 },
  'hardened-steel': { processing: 2 }, composites: { processing: 3 }, titanium: { processing: 3 },
  radar: { workshop: 2 }, 'jet-propulsion': { hangar: 1 }, 'automatic-weapons': { workshop: 2 },
  'support-launchers': { workshop: 2 }, 'field-artillery': { workshop: 2 }, 'heavy-artillery': { workshop: 3 }, 'tank-guns': { workshop: 3 },
};
export function convertIndustryField(text: string, at = new Date().toISOString(), make: (state: unknown) => { keep(): unknown; world: { dispose(): void } } = state => new SharedRoom({ kept: state })) {
  const kept = parseJSON(text);
  if (!record(kept) || ![27, FROM_SAVE].some(version => version === kept.save)) throw new Error('Use um campo salvo no formato 27 ou 28.');
  const prepared = clone(kept.room);
  if (!record(prepared) || !Array.isArray(prepared.factions) || !prepared.factions.every(record) || !record(prepared.scene) ||
    typeof prepared.scene.time !== 'number' || !Number.isFinite(prepared.scene.time)) throw new Error('O arquivo salvo não contém o estado do campo.');
  if (Object.hasOwn(prepared, 'startingIndustry') || prepared.factions.some(faction => Object.hasOwn(faction, 'industry')))
    throw new Error('O campo salvo já contém instalações.');
  prepared.startingIndustry = { ...BASIC_INDUSTRY }; delete prepared.startingResearch;
  let retiredPoints = 0;
  const grants: { faction: string; levels: IndustryLevels }[] = [];
  for (const faction of prepared.factions) {
    if (typeof faction.id !== 'string') throw new Error('Facção inválida no campo salvo.');
    let levels = { ...BASIC_INDUSTRY };
    if (kept.save === 27) levels = { ...FULL_INDUSTRY };
    else {
      const research = faction.research;
      if (!record(research) || !Array.isArray(research.completed) || !research.completed.every((id: unknown): id is string => typeof id === 'string' && Object.hasOwn(LEGACY_LEVELS, id)) ||
        typeof research.points !== 'number' || !Number.isSafeInteger(research.points) || research.points < 0) throw new Error('Pesquisas antigas inválidas.');
      retiredPoints += research.points;
      for (const id of research.completed) Object.assign(levels, Object.fromEntries(Object.entries(LEGACY_LEVELS[id]!).map(([key, value]) => [key, Math.max(levels[key as keyof IndustryLevels], value)])));
    }
    // Inspect only authoring owned by this faction: existing fleet, its library
    // and queued works. Do not infer capabilities from drawn projection metals.
    const actors = Array.isArray(prepared.scene.actors) ? prepared.scene.actors.filter(record).filter(actor => actor.team === faction.id).map(actor => actor.construction) : [],
      library = Array.isArray(faction.library) ? faction.library.filter(record).map(model => model.blueprint) : [],
      works = Array.isArray(prepared.works) ? prepared.works.filter(record).filter(work => work.factionId === faction.id && work.blueprint).map(work => work.blueprint) : [];
    for (const source of [...actors, ...library, ...works]) {
      const result = compileDraft(source), admission = industrialAdmission(result.construction, result.compiled);
      if (admission.oversized) throw new Error('Um projeto salvo excede o porte máximo. A conversão foi recusada sem alterar o campo.');
      for (const required of admission.requirements) levels = { ...levels, [required.facility]: Math.max(levels[required.facility], required.level) };
    }
    if (!faction.base) levels = { ...BASIC_INDUSTRY };
    faction.industry = newIndustry(levels); delete faction.research;
    grants.push({ faction: faction.id, levels });
  }
  // Restoring disconnects every member and starts the ordinary absence clock.
  // Allow that established restart rule, without exempting stocks or other data.
  const expected = clone(prepared);
  if (!record(expected) || !Array.isArray(expected.factions) || !expected.factions.every(record) || !record(expected.scene)) throw new Error('O arquivo salvo não contém o estado do campo.');
  for (const faction of expected.factions) if (faction.away === null) faction.away = expected.scene.time;
  const room = make(prepared);
  let converted: unknown;
  try { converted = clone(room.keep()); } finally { room.world.dispose(); }
  if (!same(converted, expected)) throw new Error('A conversão alterou o estado existente do campo.');
  const again = make(clone(converted));
  try { if (!same(clone(again.keep()), converted)) throw new Error('O campo convertido não se reabre igual.'); }
  finally { again.world.dispose(); }
  if (!record(converted) || !Array.isArray(converted.factions)) throw new Error('O campo convertido não contém facções.');
  return { text: JSON.stringify({ save: FIELD_SAVE, at, room: converted }),
    receipt: { from: kept.save, to: FIELD_SAVE, factions: converted.factions.length, retiredPoints, grants } };
}
function main(args: readonly string[]): void {
  const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; },
    input = value('--input'), output = value('--output'), write = args.includes('--write');
  if (!input || !output) throw new Error('Use --input <field.json> --output <pasta nova> [--write].');
  const folder = resolve(output);
  if (existsSync(folder)) throw new Error('A pasta de saída já existe: escolha uma nova.');
  const { text, receipt } = convertIndustryField(readFileSync(resolve(input), 'utf8'));
  if (write) {
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'field.json'), fresh = file + '.tmp', handle = openSync(fresh, 'wx', 0o600);
    try { writeFileSync(handle, text); fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(fresh, file);
  }
  console.log(JSON.stringify({ ...receipt, written: write }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
