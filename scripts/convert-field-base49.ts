// Explicit, offline Core49 -> physical-base Core50 conversion. Normal loaders never import this file.
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { rustSourceHash } from './rust-source-hash.ts';
import type { BinaryLike } from 'node:crypto';
import type { Stats } from 'node:fs';
import { record, parseJSON, cloneJSON as clone, expectRecord as object, expectArray as array, expectString as text, expectNumber as number, invoke, construct } from './operational-input.ts';

const FORMAT = 'impacto-field-base49-pins', DERIVED = ['physicalMass', 'physicalCenterLocal', 'physicalInertia', 'materialPolygons'],
  CARRIER = ['mass', 'carrierMass', 'carrierInertia', 'carrierCenter', 'localCenter'],
  SCRIPT = fileURLToPath(import.meta.url), hex = (value: BinaryLike): string => createHash('sha256').update(value).digest('hex');
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
const equal = (a: unknown, b: unknown, code: string): void => { if (!isDeepStrictEqual(a, b)) refuse(code); };
const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = (value: unknown): string => hex(text(JSON.stringify(canonical(value))));
const inside = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === '' || !path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path); };
function plainPath(path: string, directory = false): string {
  const absolute = resolve(path), stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) refuse('UNSUPPORTED_PATH');
  // Resolving every existing ancestor also rejects a junction above a regular file.
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
// Preserved roots retain their original JavaScript owner; a typed checkout has only the TypeScript owner.
const sourceModule = (root: string, file: string): string => file.endsWith('.js') && existsSync(join(root, file.slice(0, -3) + '.ts')) ? file.slice(0, -3) + '.ts' : file;
function pinRoot(path: string, core: number) {
  const root = plainPath(path, true), exported = (file: string, name: string): number => {
    const match = readFileSync(join(root, sourceModule(root, file)), 'utf8').match(new RegExp('export const ' + name + ' = (\\d+);'));
    if (!match?.[1]) refuse('ROOT_CONTRACT');
    return Number(match[1]);
  };
  if (exported('src/native-dynamics.js', 'CORE_CONTRACT') !== core) refuse('ROOT_CONTRACT');
  const manifestFile = join(root, 'native/artifacts', `battle_dynamics-${process.platform}-${process.arch}.json`),
    manifestBytes = readFileSync(plainPath(manifestFile)), manifest = object(parseJSON(manifestBytes.toString('utf8')));
  if (typeof manifest.binaryFile !== 'string' || basename(manifest.binaryFile) !== manifest.binaryFile || !manifest.binaryFile.endsWith('.node')) refuse('NATIVE_MANIFEST');
  const binary = plainPath(join(dirname(manifestFile), manifest.binaryFile)), binarySHA256 = hex(readFileSync(binary)),
    sourceSHA256 = rustSourceHash(join(root, 'native/dynamics'));
  if (binarySHA256 !== manifest.binarySHA256 || sourceSHA256 !== manifest.sourceSHA256 || manifest.platform !== process.platform || manifest.arch !== process.arch) refuse('STALE_NATIVE');
  return { root, core, fieldSave: exported('server/field-save.js', 'FIELD_SAVE'), codeSHA256: codeHash(root),
    sourceSHA256, manifestSHA256: hex(manifestBytes), binaryFile: manifest.binaryFile, binarySHA256 };
}
export function pinFieldBase49Roots(oldRoot: string, newRoot: string) {
  const before = pinRoot(oldRoot, 49), after = pinRoot(newRoot, 50);
  if (pathKey(before.root) === pathKey(after.root)) refuse('DISTINCT_ROOTS_REQUIRED');
  return { format: FORMAT, version: 1, old: before, candidate: after };
}
type Pins = ReturnType<typeof pinFieldBase49Roots>;
function checkPins(pins: unknown): asserts pins is Pins {
  if (!record(pins) || pins.format !== FORMAT || pins.version !== 1) refuse('PIN_FORMAT');
  equal(pinFieldBase49Roots(text(object(pins.old).root), text(object(pins.candidate).root)), pins, 'ROOT_CHANGED');
}

// These are the real source owners, not a recursive search through private JSON.
function sourceCopies(value: unknown, projects: readonly unknown[]) {
  const room = object(value), sources: { source: unknown; location: string; draft: boolean }[] = [],
    add = (source: unknown, location: string, draft = false): number => sources.push({ source, location, draft });
  for (const [i, actor] of array(object(room.scene).actors).map(object).entries()) add(actor.construction, `actor:${i}`);
  for (const [i, faction] of array(room.factions).map(object).entries())
    for (const [j, model] of array(faction.library).map(object).entries()) add(model.blueprint, `library:${i}:${j}`);
  for (const [i, work] of array(room.works).map(object).entries()) add(work.blueprint, `work:${i}`);
  for (const [i, project] of projects.entries()) {
    if (record(project) && project.version === 8 && project.preset) add(project, `project:${i}`, true);
    else if (record(project) && project.version === 4 && Array.isArray(project.entries))
      for (const [j, entry] of project.entries.map(object).entries()) add(entry.blueprint, `garage:${i}:${j}`, true);
    else if (record(project) && typeof project.projectId === 'string' && project.blueprint) add(project.blueprint, `working:${i}`, true);
    else refuse('CURRENT_PROJECT_FORMAT_REQUIRED');
  }
  return sources;
}
function withoutCarriers(scene: unknown, actorIds: readonly string[]) {
  const next = object(clone(scene));
  for (const actor of array(next.actors).map(object)) if (actorIds.includes(text(actor.id))) {
    delete actor.contactContours;
    if (record(actor.vehicle)) for (const key of CARRIER) delete actor.vehicle[key];
  }
  return next;
}
function maskedScene(scene: unknown, integrated: readonly string[], affected: readonly string[]) {
  const next = withoutCarriers(scene, affected);
  for (const module of array(next.modules).map(object)) if (integrated.includes(text(module.id))) for (const key of DERIVED) delete module[key];
  return next;
}
function byId(value: unknown): Map<string, Record<string, unknown>> {
  const entries = array(value).map(object), map = new Map(entries.map(entry => [text(entry.id), entry]));
  if (map.size !== entries.length) refuse('DUPLICATE_SAVED_ID');
  return map;
}
function frames(value: unknown): [string, unknown][] {
  return array(object(value).actors).map(object).map(actor => [text(actor.id), actor.vehicle ? invoke(actor.vehicle, 'pose') : { x: actor.x, y: actor.y, angle: 0 }]);
}
function clock(value: unknown, before: unknown): void {
  const scene = object(value), original = object(before);
  for (const key of ['time', 'tick', 'nextId', 'randomState', 'recoveries', 'stats']) equal(scene[key], original[key], 'CLOCK_OR_COUNTER_CHANGED');
}
function identities(value: unknown) {
  const integrated = array(object(value).modules).map(object).filter(module => module.kind === 'weapon' && !object(module.weaponMount).exposed);
  return { integrated: integrated.map(module => text(module.id)), affected: [...new Set(integrated.map(module => text(module.actorId)))] };
}
function finiteDerivatives(value: unknown): void {
  const module = object(value), center = record(module.physicalCenterLocal) ? module.physicalCenterLocal : {};
  if (typeof module.physicalMass !== 'number' || !(module.physicalMass > 0) || typeof module.physicalInertia !== 'number' || !(module.physicalInertia > 0) ||
      ![module.physicalMass, module.physicalInertia, center.x, center.y].every(value => typeof value === 'number' && Number.isFinite(value)) ||
      !Array.isArray(module.materialPolygons) || module.materialPolygons.length < 4 ||
      !module.materialPolygons.every((poly: unknown) => Array.isArray(poly) && poly.length >= 3 && poly.every((p: unknown) => record(p) && typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y)))) refuse('INVALID_DERIVED_WEAPON');
}
function resumeReweighted(value: unknown, scene: unknown, affected: readonly string[], transforms: Record<string, unknown>): void {
  const world = object(value), freshFrames = new Map<string, unknown>(), addActor = world.addActor, game = world.game;
  if (typeof addActor !== 'function' || typeof game !== 'function') refuse('ROOT_CONTRACT');
  const frame = (actor: Record<string, unknown>): unknown => actor.vehicle ? invoke(actor.vehicle, 'pose') : { x: 0, y: actor.y, angle: 0 };
  let prepared = false;
  // Normal cold load has immutable saved contours. Here they were deliberately omitted, so the
  // temporary volumes made at initial placement must follow the saved vehicle before Native weighs it.
  world.addActor = function (this: Record<string, unknown>, ...args: unknown[]) {
    const made: unknown = Reflect.apply(addActor, this, args), actor = object(made), id = text(actor.id);
    if (affected.includes(id)) freshFrames.set(id, frame(actor));
    return actor;
  };
  world.game = function (this: Record<string, unknown>, ...args: unknown[]) {
    if (!prepared) {
      if (freshFrames.size !== affected.length) refuse('INCOMPLETE_COLD_PREPARATION');
      for (const id of affected) {
        const actor = object(invoke(this, 'actor', id)), before = freshFrames.get(id), after = frame(actor);
        if (!isDeepStrictEqual(before, after)) actor.contactVolumes = array(actor.contactVolumes).map(poly => array(poly).map(point => {
          const { u, v } = object(invoke(transforms, 'worldToLocal', before, point));
          return invoke(transforms, 'localToWorld', after, u, v);
        }));
      }
      prepared = true;
    }
    const result: unknown = Reflect.apply(game, this, args); return result;
  };
  try { invoke(world, 'resume', scene); if (!prepared) refuse('INCOMPLETE_COLD_PREPARATION'); }
  finally { delete world.addActor; delete world.game; }
}
interface WorkerRequest { phase: 'baseline' | 'candidate'; root: string; pin: ReturnType<typeof pinRoot>; document: unknown; projects: unknown[]; baseline?: unknown }
function workerRequest(value: unknown): WorkerRequest {
  const input = object(value), root = text(input.root), supplied = object(input.pin);
  if (input.phase !== 'baseline' && input.phase !== 'candidate') refuse('WORKER_PHASE');
  const pin = pinRoot(root, number(supplied.core)); equal(pin, supplied, 'ROOT_CHANGED');
  return { phase: input.phase, root, pin, document: input.document, projects: array(input.projects), ...(input.baseline === undefined ? {} : { baseline: input.baseline }) };
}
async function inRoot(message: unknown) {
  const { phase, root, pin, document: inputDocument, projects, baseline } = workerRequest(message), document = object(inputDocument),
    originalRoom = object(document.room), originalScene = object(originalRoom.scene);
  equal(pinRoot(root, pin.core), pin, 'ROOT_CHANGED');
  const load = async (path: string): Promise<Record<string, unknown>> => { const module: unknown = await import(pathToFileURL(join(root, sourceModule(root, path))).href); return object(module); },
    [{ SharedRoom }, persistence, { CORE_CONTRACT }, { FIELD_SAVE }, transforms] = await Promise.all([
      load('server/room.js'), load('src/persistence.js'), load('src/native-dynamics.js'), load('server/field-save.js'), load('src/math.js')]);
  if (CORE_CONTRACT !== pin.core || FIELD_SAVE !== pin.fieldSave || (phase === 'baseline' && document.save !== FIELD_SAVE)) refuse('SAVE_OR_CORE_CONTRACT');
  const sources = sourceCopies(originalRoom, projects).map(({ source, location, draft }) => {
    try { return { location, sha256: digest(invoke(persistence, draft ? 'validateDraftBlueprint' : 'validateBlueprint', source)) }; }
    catch (error) { throw Object.assign(record(error) ? error : new Error(String(error)), { location }); }
  });
  const rooms: Record<string, unknown>[] = [], room = (kept?: unknown) => { const instance = construct(SharedRoom, kept ? { kept: clone(kept) } : {}); rooms.push(instance); return instance; };
  try {
    if (phase === 'baseline') {
      const admitted = room(originalRoom), reopened = object(clone(invoke(admitted, 'keep'))), original = object(reopened.scene), ids = identities(admitted.world);
      clock(original, originalScene);
      const savedModules = byId(originalScene.modules), originalModules = byId(original.modules);
      for (const id of ids.integrated) for (const key of DERIVED) equal(savedModules.get(id)?.[key], originalModules.get(id)?.[key], 'BASELINE_WEAPON_DERIVATIVE');
      // This 49 cold regeneration is the exact control for pose/decomposition roundoff in 50.
      const control = room();
      if (invoke(control, 'ground') !== originalRoom.ground) refuse('GROUND_CHANGED');
      resumeReweighted(control.world, withoutCarriers(originalScene, ids.affected), ids.affected, transforms);
      const scene = clone(invoke(control.world, 'keep')); clock(scene, originalScene);
      const reopenedTwice = clone(invoke(room(reopened), 'keep'));
      return { ...ids, sources, control: scene, reopened, reopenedTwice, frames: frames(control.world), fieldSave: FIELD_SAVE };
    }
    const before = object(baseline), integrated = array(before.integrated).map(text), affected = array(before.affected).map(text);
    equal(sources, before.sources, 'AUTHORED_SOURCE_CHANGED');
    const intermediate = maskedScene(originalScene, integrated, affected), candidate = room();
    if (invoke(candidate, 'ground') !== originalRoom.ground) refuse('GROUND_CHANGED');
    resumeReweighted(candidate.world, intermediate, affected, transforms);
    const regenerated = object(clone(invoke(candidate.world, 'keep'))); clock(regenerated, originalScene);
    equal(identities(candidate.world), { integrated, affected }, 'WEAPON_IDENTITIES_CHANGED');
    equal(frames(candidate.world), before.frames, 'CONSTRUCTION_FRAME_CHANGED');
    const controlActors = byId(object(before.control).actors), candidateActors = byId(regenerated.actors), candidateModules = byId(regenerated.modules);
    for (const id of affected) equal(candidateActors.get(id)?.contactContours, controlActors.get(id)?.contactContours, 'CONTACT_GEOMETRY_CHANGED');
    equal(maskedScene(regenerated, integrated, affected),
      maskedScene(before.control, integrated, affected), 'UNRELATED_NATIVE_STATE_CHANGED');
    const converted = object(clone(document)), convertedRoom = object(converted.room), convertedScene = object(convertedRoom.scene),
      targetModules = byId(convertedScene.modules), targetActors = byId(convertedScene.actors), inertia: { id: string; before: unknown; after: unknown }[] = [];
    for (const id of integrated) {
      const target = object(targetModules.get(id)), fresh = object(candidateModules.get(id)); finiteDerivatives(fresh);
      inertia.push({ id, before: target.physicalInertia, after: fresh.physicalInertia });
      for (const key of DERIVED) target[key] = clone(fresh[key]);
    }
    for (const id of affected) {
      const target = object(targetActors.get(id)), fresh = object(candidateActors.get(id));
      if (Boolean(target.vehicle) !== Boolean(fresh.vehicle)) refuse('ACTOR_KIND_CHANGED');
      if (target.vehicle) for (const key of CARRIER) object(target.vehicle)[key] = clone(object(fresh.vehicle)[key]);
      // Base geometry adds no rigid collider. Preserve the saved contour byte-for-byte.
    }
    converted.save = FIELD_SAVE;
    equal(maskedScene(convertedScene, integrated, affected),
      maskedScene(originalScene, integrated, affected), 'PRESERVATION_FAILED');
    const roomBefore = { ...originalRoom, scene: null }, roomAfter = { ...convertedRoom, scene: null };
    equal(roomAfter, roomBefore, 'ROOM_STATE_CHANGED');
    const first = room(convertedRoom), firstKept = object(clone(invoke(first, 'keep'))); clock(firstKept.scene, originalScene);
    const second = room(firstKept), secondKept = object(clone(invoke(second, 'keep'))); clock(secondKept.scene, originalScene);
    for (const [kept, expected] of [[firstKept, object(before.reopened)], [secondKept, object(before.reopenedTwice)]] satisfies [Record<string, unknown>, Record<string, unknown>][]) {
      // Cold world/local pose conversion can round again in49 too. Compare each of exactly two
      // normal50 reopens to the corresponding49 reopen, with exact equality and no pose tolerance.
      equal({ ...kept, scene: maskedScene(kept.scene, integrated, affected) },
        { ...expected, scene: maskedScene(expected.scene, integrated, affected) }, 'REOPEN_UNRELATED_STATE_CHANGED');
      const scene = object(kept.scene), modules = byId(scene.modules), actors = byId(scene.actors);
      for (const id of integrated) for (const key of DERIVED) equal(modules.get(id)?.[key], targetModules.get(id)?.[key], 'REOPEN_WEAPON_DERIVATIVE');
      for (const id of affected) if (object(targetActors.get(id)).vehicle)
        for (const key of CARRIER) { const actor = actors.get(id), vehicle = actor && record(actor.vehicle) ? actor.vehicle : undefined;
          equal(vehicle?.[key], object(object(targetActors.get(id)).vehicle)[key], 'REOPEN_CARRIER'); }
    }
    return { converted, summary: { sources: sources.length, integratedWeapons: integrated.length,
      affectedActors: affected.length, simulationSteps: 0, strictReopens: 2,
      preservedStateSHA256: digest({ ...roomBefore, scene: maskedScene(originalScene, integrated, affected) }),
      inertia } };
  } finally { for (const instance of rooms) invoke(instance.world, 'dispose'); }
}
function safeError(error: unknown) {
  const row = record(error) ? error : {}, word = (value: unknown): string | null => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,64}$/.test(value) ? value : null;
  return { code: word(row.reason) || word(row.code) || word(row.message) || 'VALIDATION_FAILED',
    ...(typeof row.location === 'string' && /^(actor|library|work|project|garage|working):[\d:]+$/.test(row.location) ? { location: row.location } : {}) };
}
function runWorker(message: WorkerRequest): Promise<unknown> {
  return new Promise<unknown>((resolveValue, reject) => {
    const child = fork(SCRIPT, ['--worker'], { cwd: message.root, execArgv: [], serialization: 'advanced',
      env: { ...process.env, IMPACTO_DYNAMICS_RUNTIME: 'native' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let reply: unknown;
    const timer = setTimeout(() => { child.kill(); }, 600000);
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
function outputPath(path: string, pins: Pins, inputPaths: readonly string[]): string {
  const output = resolve(path);
  if (existsSync(output)) refuse('OUTPUT_EXISTS');
  const parent = plainPath(dirname(output), true);
  if (join(parent, basename(output)) !== output || inside(pins.old.root, output) || inputPaths.includes(output)) refuse('OUTPUT_PATH');
  return output;
}
function writeNewDirectory(output: string, files: readonly [string, Uint8Array][]): () => void {
  mkdirSync(output, { mode: 0o700 }); // Exclusive reservation; never replace even an empty existing directory.
  const ownDirectory = lstatSync(output), written: [string, Stats][] = [], sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
  const cleanup = () => {
    if (!existsSync(output)) return;
    const directory = lstatSync(output);
    if (directory.isSymbolicLink() || !sameFile(directory, ownDirectory)) return;
    // Exact files only, including a partially written file. Never recursively remove the destination.
    for (const [path, owned] of [...written].reverse()) if (existsSync(path)) {
      const now = lstatSync(path);
      if (!now.isSymbolicLink() && sameFile(now, owned)) unlinkSync(path);
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
  } catch (error) {
    cleanup();
    throw error;
  }
}
export async function convertFieldBase49({ input, output, pins, projects = [], write = false }: { input: string; output: string; pins: unknown; projects?: readonly string[]; write?: boolean }) {
  checkPins(pins);
  const paths = [input, ...projects].map(path => plainPath(path)), originals = paths.map(path => readFileSync(path)),
    originalHashes = originals.map(hex), destination = outputPath(output, pins, paths), original = originals[0];
  if (!original) refuse('INPUT_JSON');
  const document = parseJSON(original.toString('utf8')), projectDocuments = originals.slice(1).map(bytes => parseJSON(bytes.toString('utf8')));
  if (!record(document) || !record(document.room) || !document.room.scene || document.save !== pins.old.fieldSave) refuse('SAVE_OR_CORE_CONTRACT');
  const unchanged = () => {
    for (let i = 0; i < paths.length; i++) {
      let bytes; try { bytes = readFileSync(plainPath(text(paths[i]))); } catch { refuse('INPUT_CHANGED'); }
      if (hex(bytes) !== originalHashes[i]) refuse('INPUT_CHANGED');
    }
  };
  let cleanup: (() => void) | undefined;
  try {
    const baseline = await runWorker({ phase: 'baseline', root: pins.old.root, pin: pins.old, document, projects: projectDocuments }),
      candidate = object(await runWorker({ phase: 'candidate', root: pins.candidate.root, pin: pins.candidate, document, projects: projectDocuments, baseline }));
    unchanged(); checkPins(pins); outputPath(destination, pins, paths);
    const outputBytes = Buffer.from(JSON.stringify(candidate.converted) + '\n'),
      receipt = { format: 'impacto-field-base49-conversion', version: 1, status: write ? 'WRITTEN' : 'SIMULATION_ONLY',
        inputSHA256: originalHashes[0], outputSHA256: hex(outputBytes), projectSHA256: originalHashes.slice(1),
        roots: pins, ...object(candidate.summary) };
    if (write) cleanup = writeNewDirectory(destination, [['field.json', outputBytes],
      ...originals.slice(1).map((bytes, i): [string, Buffer] => [`project-${i + 1}.json`, bytes]),
      ['conversion-receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n')]]);
    unchanged(); checkPins(pins);
    return receipt;
  } catch (error) {
    cleanup?.(); unchanged();
    throw Object.assign(record(error) ? error : new Error(String(error)), { inputSHA256: originalHashes[0] });
  }
}
function argumentsOf(args: readonly string[]): { flags: Record<string, string | true>; projects: string[] } {
  const options: Record<string, string | true> = {}, projects: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i], next = args[i + 1];
    if (key === undefined) refuse('ARGUMENTS');
    if (['--write', '--pin', '--help'].includes(key)) options[key.slice(2)] = true;
    else if (['--input', '--output', '--pins', '--old-root', '--new-root', '--project'].includes(key) && next && !next.startsWith('--')) {
      i++; if (key === '--project') projects.push(next); else options[key.slice(2)] = next;
    } else refuse('ARGUMENTS');
  }
  return { flags: options, projects };
}
async function main() {
  const { flags: options, projects } = argumentsOf(process.argv.slice(2));
  if (options.help) {
    console.log('Pin: --pin --old-root ROOT49 --new-root ROOT50 (grave o JSON fora das pastas de código).\n' +
      'Simular: --input COPIA/field.json --pins pins.json --output PASTA_NOVA [--project projeto.json].\n' +
      'Gravar: repita com --write. Nunca substitui entrada nem pasta existente; nenhuma simulação avança.');
    return;
  }
  if (options.pin) {
    if (typeof options['old-root'] !== 'string' || typeof options['new-root'] !== 'string') refuse('ARGUMENTS');
    const pins = pinFieldBase49Roots(options['old-root'], options['new-root']), serialized = JSON.stringify(pins, null, 2);
    if (options.pins) {
      const path = resolve(text(options.pins)); plainPath(dirname(path), true);
      writeFileSync(path, serialized + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log(serialized);
  }
  else {
    if (typeof options.input !== 'string' || typeof options.output !== 'string' || typeof options.pins !== 'string') refuse('ARGUMENTS');
    const pins = parseJSON(readFileSync(plainPath(options.pins), 'utf8'));
    console.log(JSON.stringify(await convertFieldBase49({ input: options.input, output: options.output, projects, write: options.write === true, pins }), null, 2));
  }
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
  console.error(JSON.stringify({ status: 'REFUSED_ORIGINALS_PRESERVED', ...safeError(error), ...(row.phase ? { phase: row.phase } : {}),
    ...(typeof row.inputSHA256 === 'string' && /^[a-f0-9]{64}$/.test(row.inputSHA256) ? { inputSHA256: row.inputSHA256 } : {}) }));
  process.exitCode = 1;
});
