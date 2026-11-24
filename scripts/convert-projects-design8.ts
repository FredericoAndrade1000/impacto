// Explicit offline copies: DESIGN8/Core52 -> DESIGN9/Core53. No normal loader imports this tool.
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { rustSourceHash } from './rust-source-hash.ts';
import type { BinaryLike } from 'node:crypto';
import type { Stats } from 'node:fs';
import { record, parseJSON, cloneJSON, expectRecord as object, expectArray as array, expectString as text, expectNumber as number, invoke } from './operational-input.ts';

const FORMAT = 'impacto-project-design8-pins', SCRIPT = fileURLToPath(import.meta.url),
  hex = (value: BinaryLike): string => createHash('sha256').update(value).digest('hex'), clone = (value: unknown) => object(cloneJSON(value));
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
const equal = (a: unknown, b: unknown, code: string): void => { if (!isDeepStrictEqual(a, b)) refuse(code); };
const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const digest = (value: unknown): string => hex(text(JSON.stringify(canonical(value))));
const inside = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };
function plainPath(path: string, directory = false): string {
  const absolute = resolve(path), stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) refuse('UNSUPPORTED_PATH');
  if (pathKey(resolve(realpathSync(absolute))) !== pathKey(absolute)) refuse('REPARSE_PATH');
  return absolute;
}
function codeHash(root: string): string {
  const hash = createHash('sha256'), files = ['package.json', 'package-lock.json'];
  const visit = (name: string): void => {
    for (const entry of readdirSync(join(root, name), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = name + '/' + entry.name;
      if (entry.isSymbolicLink()) refuse('REPARSE_SOURCE');
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:[cm]?[jt]s|json)$/.test(entry.name)) files.push(path);
    }
  };
  for (const directory of ['src', 'server', 'scripts']) visit(directory);
  for (const name of files.sort()) hash.update(name).update('\0').update(readFileSync(join(root, name), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  return hash.digest('hex');
}
const sourceModule = (root: string, file: string): string => file.endsWith('.js') && existsSync(join(root, file.slice(0, -3) + '.ts')) ? file.slice(0, -3) + '.ts' : file;
function pinRoot(path: string, core: number, design: number) {
  const root = plainPath(path, true), exported = (file: string, name: string): number => {
    const match = readFileSync(join(root, sourceModule(root, file)), 'utf8').match(new RegExp('export const ' + name + ' = (\\d+);'));
    if (!match?.[1]) refuse('ROOT_CONTRACT');
    return Number(match[1]);
  };
  if (exported('src/native-dynamics.js', 'CORE_CONTRACT') !== core || exported('src/persistence.js', 'DESIGN_VERSION') !== design) refuse('ROOT_CONTRACT');
  const manifestFile = join(root, 'native/artifacts', `battle_dynamics-${process.platform}-${process.arch}.json`),
    manifestBytes = readFileSync(plainPath(manifestFile)), manifest = object(parseJSON(manifestBytes.toString('utf8')));
  if (typeof manifest.binaryFile !== 'string' || basename(manifest.binaryFile) !== manifest.binaryFile || !manifest.binaryFile.endsWith('.node')) refuse('NATIVE_MANIFEST');
  const binarySHA256 = hex(readFileSync(plainPath(join(dirname(manifestFile), manifest.binaryFile)))),
    sourceSHA256 = rustSourceHash(join(root, 'native/dynamics'));
  if (binarySHA256 !== manifest.binarySHA256 || sourceSHA256 !== manifest.sourceSHA256 || manifest.platform !== process.platform || manifest.arch !== process.arch) refuse('STALE_NATIVE');
  return { root, core, design, codeSHA256: codeHash(root), sourceSHA256, manifestSHA256: hex(manifestBytes),
    binaryFile: manifest.binaryFile, binarySHA256 };
}
export function pinProjectDesign8Roots(oldRoot: string, newRoot: string) {
  const before = pinRoot(oldRoot, 52, 8), candidate = pinRoot(newRoot, 53, 9);
  if (pathKey(before.root) === pathKey(candidate.root)) refuse('DISTINCT_ROOTS_REQUIRED');
  return { format: FORMAT, version: 1, old: before, candidate };
}
type Pins = ReturnType<typeof pinProjectDesign8Roots>;
function checkPins(pins: unknown): asserts pins is Pins {
  if (!record(pins) || pins.format !== FORMAT || pins.version !== 1) refuse('PIN_FORMAT');
  equal(pinProjectDesign8Roots(text(object(pins.old).root), text(object(pins.candidate).root)), pins, 'ROOT_CHANGED');
}
interface SourceEntry { source: unknown; location: string }
function sourceCopies(value: unknown): { kind: string; entries: SourceEntry[] } {
  const document = object(value);
  if (document.version === 8 && typeof document.preset === 'string' && ['vehicle', 'bunker'].includes(document.preset)) return { kind: 'project', entries: [{ source: document, location: 'project:0' }] };
  if (document.version === 4 && Array.isArray(document.entries) && document.entries.length <= 100) {
    const ids = new Set<string>();
    const entries = document.entries.map((value: unknown, index: number) => {
      const entry = object(value);
      if (typeof entry?.id !== 'string' || !entry.id || ids.has(entry.id)) refuse('GARAGE_ID');
      ids.add(entry.id); return { source: entry.blueprint, location: `garage:${index}` };
    });
    if (document.activeId !== null && document.activeId !== undefined && (typeof document.activeId !== 'string' || !ids.has(document.activeId))) refuse('GARAGE_ACTIVE_ID');
    return { kind: 'garage4', entries };
  }
  if (typeof document?.projectId === 'string' && document.projectId && document.blueprint)
    return { kind: 'working', entries: [{ source: document.blueprint, location: 'working:0' }] };
  refuse('PROJECT8_GARAGE4_OR_WORKING_REQUIRED');
}
// Keep every authored property except the two deliberately changed representations.
function authoredApartFromTrack(source: unknown) {
  const value = clone(source); delete value.version;
  if (record(value.chassis) && value.chassis.model === 'tracked') delete value.chassis.track;
  return value;
}
function physicalProjection(compiled: unknown) {
  const value = clone(compiled); delete value.canonicalVersion;
  // Core53 adds centre readouts here and on the first frame plate; the physical centre stays compared in modules.
  if (record(value.chassis) && record(value.chassis.track)) delete value.chassis.track.y;
  for (const plate of array(value.plates).map(object)) if (record(plate.chassis) && record(plate.chassis.track)) delete plate.chassis.track.y;
  return value;
}
// Moving an old world coordinate into the new local representation can lose a few floating-point bits.
// This offline gate compares the entire projection; discrete fields and decisions remain exact.
const EXACT_NUMBERS = new Set(['seed', 'version', 'owner', 'hostOwner', 'hostEdge', 'index', 'segment', 'credits', 'wheels',
  'capacityRounds', 'rounds', 'nx', 'ny', 'bits']);
function comparePhysical(after: unknown, before: unknown, code: string) {
  const differences: { path: string; before: number; after: number; delta: number; limit: number }[] = [];
  function visit(a: unknown, b: unknown, path = '', exact = false): void {
    if (typeof a === 'number' && typeof b === 'number') {
      if (!Number.isFinite(a) || !Number.isFinite(b)) refuse(code);
      if (a === b) return;
      const limit = 16 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
      if (exact || Math.abs(a - b) > limit) refuse(code);
      differences.push({ path, before: b, after: a, delta: a - b, limit });
      return;
    }
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') { equal(a, b, code); return; }
    if (Array.isArray(a) !== Array.isArray(b)) refuse(code);
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) refuse(code);
      for (let index = 0; index < a.length; index++) visit(a[index], b[index], path ? path + '.' + index : String(index), exact);
      return;
    }
    if (!record(a) || !record(b)) refuse(code);
    equal(Object.keys(a).sort(), Object.keys(b).sort(), code);
    for (const key of Object.keys(a)) visit(a[key], b[key], path ? path + '.' + key : key,
      exact || EXACT_NUMBERS.has(key) || key === 'ballisticGrid' || key === 'admissionIssues');
  }
  visit(after, before);
  return { beforeSHA256: digest(before), afterSHA256: digest(after),
    bound: '16 * Number.EPSILON * max(1, abs(before), abs(after)); discrete fields, ballistic grids and admission decisions exact', differences };
}
interface WorkerRequest { phase: 'baseline' | 'candidate'; root: string; pin: ReturnType<typeof pinRoot>; entries: SourceEntry[]; baseline?: unknown }
function workerRequest(value: unknown): WorkerRequest {
  const input = object(value), root = text(input.root), supplied = object(input.pin);
  if (input.phase !== 'baseline' && input.phase !== 'candidate') refuse('WORKER_PHASE');
  const pin = pinRoot(root, number(supplied.core), number(supplied.design));
  equal(pin, supplied, 'ROOT_CHANGED');
  const entries = array(input.entries).map(value => { const entry = object(value); return { source: entry.source, location: text(entry.location) }; });
  return { phase: input.phase, root, pin, entries, ...(input.baseline === undefined ? {} : { baseline: input.baseline }) };
}
async function inRoot(message: unknown) {
  const { phase, root, pin, entries, baseline } = workerRequest(message);
  equal(pinRoot(root, pin.core, pin.design), pin, 'ROOT_CHANGED');
  const load = async (path: string): Promise<Record<string, unknown>> => { const module: unknown = await import(pathToFileURL(join(root, sourceModule(root, path))).href); return object(module); },
    [native, persistence, compiler, grid, economy] = await Promise.all([
      load('src/native-dynamics.js'), load('src/persistence.js'), load('src/structured-construction.js'),
      load('src/grid.js'), load('src/economy.js')]);
  await invoke(native, 'initNativeDynamics');
  if (native.CORE_CONTRACT !== pin.core || persistence.DESIGN_VERSION !== pin.design || native.nativeDynamicsRuntime !== 'native') refuse('RUNTIME_CONTRACT');
  return entries.map(({ source, location }, index) => {
    try {
      const before = phase === 'candidate' ? object(array(baseline)[index]) : null, asked = before ? before.copy : source;
      if (phase === 'baseline' && (!record(source) || source.version !== 8 || source.derived || !invoke(persistence, 'isWorkshopDesign', source))) refuse('DESIGN8_REQUIRED');
      // Draft validation is intentional: conversion must not repair or discard an unfinished design.
      const result = object(invoke(compiler, 'compileDraft', invoke(persistence, 'validateDraftBlueprint', asked))), compiled = object(result.compiled),
        manufactured = object(invoke(compiler, 'compileManufacture', result.construction, {}, true)), manufacturedCompiled = object(manufactured.compiled),
        bill = clone(invoke(economy, 'designBill', compiled)), seconds = number(invoke(economy, 'buildSeconds', bill));
      if (phase === 'baseline') {
        const copy = clone(result.construction); copy.version = 9;
        if (record(copy.chassis) && copy.chassis.model === 'tracked') {
          const tracks = array(compiled.modules).map(object).filter(part => part.id === 'chassis:track'), first = tracks[0],
            track = record(compiled.chassis) ? compiled.chassis.track : null, origin = record(compiled.frame) ? compiled.frame.origin : null;
          if (tracks.length !== 1 || !first || first.kind !== 'track' || first.angle !== 0 || !record(track) || !record(origin) ||
              ![track.front, track.rear, first.y, origin.x, origin.y].every(value => typeof value === 'number' && Number.isFinite(value)) || number(track.front) >= number(track.rear)) refuse('TRACK52_GEOMETRY');
          copy.chassis.track = { front: number(invoke(grid, 'unitsOf', number(track.front) - number(origin.x))), rear: number(invoke(grid, 'unitsOf', number(track.rear) - number(origin.x))),
            y: number(invoke(grid, 'unitsOf', number(first.y) - number(origin.y))) };
        }
        return { location, canonical: result.construction, copy, physical: physicalProjection(compiled),
          manufacture: physicalProjection(manufacturedCompiled), bill, seconds };
      }
      if (!before) refuse('BASELINE_REQUIRED');
      equal(authoredApartFromTrack(result.construction), authoredApartFromTrack(before.canonical), 'UNRELATED_AUTHORING_CHANGED');
      const priorCopy = object(before.copy), priorChassis = record(priorCopy.chassis) ? priorCopy.chassis : null;
      if (priorChassis?.model === 'tracked') equal(object(object(result.construction).chassis).track, priorChassis.track, 'TRACK_COPY_CHANGED');
      const physicalComparison = comparePhysical(physicalProjection(compiled), before.physical, 'PHYSICAL_PROJECTION_CHANGED'),
        manufactureComparison = comparePhysical(physicalProjection(manufacturedCompiled), before.manufacture, 'MANUFACTURING_CHANGED');
      equal(bill, before.bill, 'BILL_CHANGED'); equal(seconds, before.seconds, 'BUILD_TIME_CHANGED');
      // This is also the normal current import gate, without creating a project identity or storage.
      const serialized = text(invoke(persistence, 'serializeBlueprint', result.construction)) + '\n';
      if (Buffer.byteLength(serialized, 'utf8') > 512000) refuse('IMPORT_FILE_TOO_LARGE');
      equal(invoke(persistence, 'parseBlueprint', serialized), result.construction, 'CURRENT_IMPORT_CHANGED');
      return { location, text: serialized, canonicalSHA256: digest(result.construction),
        physicalComparison, manufactureComparison, bill, seconds,
        plates: array(compiled.plates).length, modules: array(compiled.modules).length,
        mechanicalAdmission: compiled.mechanicalAdmission,
        manufactureAdmission: manufacturedCompiled.mechanicalAdmission,
        manufactureIssueCodes: array(manufacturedCompiled.admissionIssues).map(issue => object(issue).code),
        ...(priorChassis?.model === 'tracked' ? { materializedTrack: priorChassis.track } : {}) };
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { location }); }
  });
}
function safeError(error: unknown) {
  const row = record(error) ? error : {}, word = (value: unknown): string | null => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,64}$/.test(value) ? value : null;
  return { code: word(row.reason) || word(row.code) || word(row.message) || 'VALIDATION_FAILED',
    ...(typeof row.location === 'string' && /^(project|garage|working):\d+$/.test(row.location) ? { location: row.location } : {}) };
}
function runWorker(message: WorkerRequest): Promise<unknown> {
  return new Promise<unknown>((resolveValue, reject) => {
    const child = fork(SCRIPT, ['--worker'], { cwd: message.root, execArgv: [], serialization: 'advanced',
      env: { ...process.env, IMPACTO_DYNAMICS_RUNTIME: 'native' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let reply: unknown;
    const timer = setTimeout(() => child.kill(), 120000);
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('WORKER_FAILED'), { code: 'WORKER_FAILED' })); });
    child.once('message', value => { reply = value; });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0 || !record(reply) || !reply.ok) { const error = record(reply) && record(reply.error) ? reply.error : {}; reject(Object.assign(new Error(typeof error.code === 'string' ? error.code : 'WORKER_FAILED'), error, { phase: message.phase })); }
      else resolveValue(reply.value);
    });
    child.send(message);
  });
}
function outputPath(path: string, pins: Pins, input: string): string {
  const output = resolve(path), parent = plainPath(dirname(output), true);
  if (existsSync(output)) refuse('OUTPUT_EXISTS');
  if (join(parent, basename(output)) !== output || pathKey(output) === pathKey(input) || inside(pins.old.root, output)) refuse('OUTPUT_PATH');
  return output;
}
function writeNewDirectory(output: string, files: readonly [string, Uint8Array][]): () => void {
  mkdirSync(output, { mode: 0o700 });
  const ownDirectory = lstatSync(output), written: [string, Stats][] = [], sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
  const cleanup = () => {
    if (!existsSync(output)) return;
    const directory = lstatSync(output);
    if (directory.isSymbolicLink() || !sameFile(directory, ownDirectory)) return;
    // Exact owned files only; never recursively delete a path supplied by the operator.
    for (const [path, owned] of [...written].reverse()) if (existsSync(path)) {
      const now = lstatSync(path); if (!now.isSymbolicLink() && sameFile(now, owned)) unlinkSync(path);
    }
    if (readdirSync(output).length === 0) rmdirSync(output);
  };
  try {
    for (const [name, bytes] of files) {
      const path = join(output, name), descriptor = openSync(path, 'wx', 0o600);
      written.push([path, fstatSync(descriptor)]);
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
export async function convertProjectsDesign8({ input, output, pins, write = false }: { input: string; output: string; pins: unknown; write?: boolean }) {
  checkPins(pins);
  const originalPath = plainPath(input), bytes = readFileSync(originalPath), inputSHA256 = hex(bytes),
    destination = outputPath(output, pins, originalPath);
  if (bytes.length > 52200000) refuse('INPUT_TOO_LARGE');
  let document: unknown; try { document = parseJSON(bytes.toString('utf8')); } catch { refuse('INPUT_JSON'); }
  const { kind, entries } = sourceCopies(document);
  if (!entries.length) refuse('EMPTY_GARAGE');
  const unchanged = () => { if (hex(readFileSync(plainPath(originalPath))) !== inputSHA256) refuse('INPUT_CHANGED'); };
  let cleanup: (() => void) | undefined;
  try {
    const baseline = await runWorker({ phase: 'baseline', root: pins.old.root, pin: pins.old, entries }),
      copies = array(await runWorker({ phase: 'candidate', root: pins.candidate.root, pin: pins.candidate, entries, baseline })).map(object);
    unchanged(); checkPins(pins); outputPath(output, pins, originalPath);
    const projects = copies.map(({ text: serialized, ...entry }, index) => ({ ...entry,
      file: `project-${String(index + 1).padStart(3, '0')}-design9.json`, sha256: hex(Buffer.from(text(serialized))) })),
      receipt = { format: 'impacto-project-design8-conversion', version: 1,
        status: write ? 'COPIES_WRITTEN' : 'SIMULATION_ONLY', inputKind: kind, inputSHA256,
        originalFile: 'input-original.json', roots: pins, projects,
        manufactureSite: 'Empty site: vehicle support is compared; fixed structures still need their real terrain at normal placement.',
        importInstructions: 'Importe os arquivos project-*-design9.json pela Oficina; cada importação cria uma identidade nova. Não substitua armazenamento do navegador.',
        limits: 'Somente projetos8; sem conversão de campo, diário ou estado binário. Toda a entrada deve ser válida; nenhum item é descartado.' };
    if (write) cleanup = writeNewDirectory(destination, [['input-original.json', bytes],
      ...copies.map((entry, index): [string, Buffer] => { const project = projects[index]; if (!project) refuse('INCOMPLETE_CONVERSION'); return [project.file, Buffer.from(text(entry.text))]; }),
      ['conversion-receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n')]]);
    unchanged(); checkPins(pins); return receipt;
  } catch (error) { cleanup?.(); unchanged(); throw Object.assign(record(error) ? error : new Error(String(error)), { inputSHA256 }); }
}
function argumentsOf(args: readonly string[]): Record<string, string | true> {
  const options: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i], next = args[i + 1];
    if (key === undefined) refuse('ARGUMENTS');
    if (['--write', '--pin', '--help'].includes(key)) options[key.slice(2)] = true;
    else if (['--input', '--output', '--pins', '--old-root', '--new-root'].includes(key) && next && !next.startsWith('--')) { options[key.slice(2)] = next; i++; }
    else refuse('ARGUMENTS');
  }
  return options;
}
async function main() {
  const options = argumentsOf(process.argv.slice(2));
  if (options.help) {
    console.log('Pin: --pin --old-root ROOT52_PRESERVADO --new-root ROOT53 --pins PINS_NOVO.json.\n' +
      'Simular: --input COPIA.json --pins PINS.json --output PASTA_NOVA. Gravar: repita com --write.\n' +
      'Entrada: projeto8, exportação da Garagem4 contendo somente projetos8, ou edição {projectId,blueprint8}.\n' +
      'Saída: original literal e projetos9 individuais para importar como novas cópias. Não altera Garagem, campo ou diário.'); return;
  }
  if (options.pin) {
    if (typeof options['old-root'] !== 'string' || typeof options['new-root'] !== 'string' || typeof options.pins !== 'string') refuse('ARGUMENTS');
    const pins = pinProjectDesign8Roots(options['old-root'], options['new-root']), path = resolve(options.pins);
    plainPath(dirname(path), true);
    if (inside(pins.old.root, path)) refuse('PIN_PATH');
    writeFileSync(path, JSON.stringify(pins, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(pins, null, 2)); return;
  }
  if (typeof options.input !== 'string' || typeof options.output !== 'string' || typeof options.pins !== 'string') refuse('ARGUMENTS');
  const pins = parseJSON(readFileSync(plainPath(options.pins), 'utf8'));
  console.log(JSON.stringify(await convertProjectsDesign8({ input: options.input, output: options.output, write: options.write === true, pins }), null, 2));
}
if (process.argv[2] === '--worker') {
  for (const name of ['log', 'warn', 'error', 'info', 'debug'] satisfies (keyof Console)[]) console[name] = () => {};
  process.once('message', async (message: unknown) => {
    let reply: unknown;
    try { reply = { ok: true, value: await inRoot(message) }; }
    catch (error) { reply = { ok: false, error: safeError(error) }; process.exitCode = 1; }
    process.send?.(reply, () => process.disconnect?.());
  });
} else if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) main().catch((error: unknown) => {
  const row = record(error) ? error : {};
  console.error(JSON.stringify({ status: 'REFUSED_ORIGINAL_PRESERVED', ...safeError(error), ...(row.phase ? { phase: row.phase } : {}),
    ...(typeof row.inputSHA256 === 'string' && /^[a-f0-9]{64}$/.test(row.inputSHA256) ? { inputSHA256: row.inputSHA256 } : {}) }));
  process.exitCode = 1;
});
