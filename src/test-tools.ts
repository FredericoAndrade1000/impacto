import type { World } from './physics.ts';
import type { SceneActor } from './scene-contract.ts';
import type { CompiledConstruction } from './construction-contract.ts';
import type { RepairLevels } from './economy-contract.ts';
import type { Pose } from './math.ts';
import type { ConstructionTemplateId } from './construction-template-catalogue.ts';
import type { TestIntent, TestResult } from './field-protocol-contract.ts';
export type { TestAct, TestIntent, TestRequest, TestActor, TestResult } from './field-protocol-contract.ts';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const templateId = (value: unknown): value is ConstructionTemplateId => typeof value === 'string' && CONSTRUCTION_TEMPLATES.some(template => template.id === value);
const currentActor = (world: World, id: string): SceneActor => { const actor = world.actor(id); if (!actor) throw new Error('Construção ausente do campo de testes.'); return actor; };
import { tr } from './i18n.ts';
import { CONSTRUCTION_TEMPLATES } from './construction-template-catalogue.ts';
import { createStructuredTemplate } from './structured-templates.ts';
import { compileManufacture, compileStructuredConstruction } from './structured-construction.ts';
import { constructionSupportSite } from './construction-admission.ts';
import { coldConstructionPlacement, constructionSpan } from './construction-placement.ts';
import { appraise, fieldParts, STOCK_IDS } from './economy.ts';
import { tradeBill } from './faction-social.ts';
import { releaseWorldInputs } from './episode-input.ts';
import { uncommanded } from './wreck.ts';
import { CONSTRUCTION_LIMITS } from './construction-limits.ts';
import { constructionEditError } from './structured-editing.ts';
import { TRIAL_TARGET_OWNER } from './battle-rules.ts';

export const TEST_TARGET_TEAM = 'test-targets';
export const TEST_READS = Object.freeze(['act', 'kind', 'templateId', 'actorId', 'x', 'facing', 'ticket', 'stock', 'factor']);
const model = (id: string) => CONSTRUCTION_TEMPLATES.find(template => template.id === id);
const invalid = (): never => { throw new Error(tr('Comando de testes inválido.')); };

// This decoder grants no permission. The live server must gate before calling it or reading its world.
export function testIntent(data: unknown): TestIntent {
  if (!record(data) || data.type !== 'test') return invalid();
  if (data.act === 'list') return { type: 'test', act: 'list' };
  if (data.act === 'speed') {
    const factor = data.factor;
    if (factor !== 1 && factor !== 2 && factor !== 4 && factor !== 8) throw new Error(tr('Escolha a velocidade de 1, 2, 4 ou 8 vezes.'));
    return { type: 'test', act: 'speed', factor };
  }
  if (data.act === 'resources') {
    const source = data.stock, stock = tradeBill(source);
    if (!record(source) || STOCK_IDS.some(id => !Object.hasOwn(source, id))) throw new Error(tr('Informe os quatro estoques da facção.'));
    return { type: 'test', act: 'resources', stock };
  }
  if (data.act === 'spawn') {
    if (data.kind !== 'vehicle' && data.kind !== 'target' || !templateId(data.templateId)) return invalid();
    if (data.kind === 'vehicle' && model(data.templateId)?.type !== 'vehicle') return invalid();
    if (data.ticket !== undefined && (typeof data.ticket !== 'string' || !data.ticket.length || data.ticket.length > 59)) return invalid();
    if (!finite(data.x) || data.facing !== -1 && data.facing !== 1) return invalid();
    return { type: 'test', act: 'spawn', kind: data.kind, templateId: data.templateId, x: data.x, facing: data.facing,
      ...(data.ticket === undefined ? {} : { ticket: data.ticket }) };
  }
  if (data.act !== 'repair' && data.act !== 'resupply' && data.act !== 'reposition') return invalid();
  if (typeof data.actorId !== 'string' || !data.actorId.length || data.actorId.length > 120) return invalid();
  if (data.act === 'reposition') {
    if (!finite(data.x) || data.facing !== -1 && data.facing !== 1) return invalid();
    return { type: 'test', act: 'reposition', actorId: data.actorId, x: data.x, facing: data.facing };
  }
  return { type: 'test', act: data.act, actorId: data.actorId };
}

// This is a closed publication option, never a room-wide rule or a permission.
export function publicationInstant(data: { instant?: unknown; type?: unknown }) {
  if (data.instant === undefined) return false;
  if (typeof data.instant !== 'boolean' || typeof data.type !== 'string' || !['spawn', 'replace', 'post'].includes(data.type))
    throw new Error(tr('Opção de fabricação instantânea inválida.'));
  return data.instant;
}

// The live worker's existing bounded accumulator. The timestep and per-turn work budget stay unchanged.
export function fieldAccumulator(accumulator: number, elapsed: number, factor = 1) {
  return Math.min(.25, accumulator + Math.min(.15, elapsed * factor));
}

export function testActors(world: World) {
  world.sync();
  const out = new Set(uncommanded(world));
  return { actors: world.actors.map(actor => ({ id: actor.id, name: actor.name,
    x: actor.vehicle?.x ?? actor.x, facing: actor.facing, mobile: Boolean(actor.vehicle?.config.enabled),
    active: !actor.defeated && !out.has(actor.id) })) };
}
export function activeTestActor(world: World, id: string) {
  world.sync();
  const actor = world.actor(id);
  if (!actor) throw new Error(tr('Essa construção já não está no cenário.'));
  if (actor.defeated || uncommanded(world).includes(id)) throw new Error(tr('Construção fora de combate: crie outra ou restaure o ensaio.'));
  return actor;
}
function poseAt(world: World, blueprint: CompiledConstruction, x: number, facing: -1 | 1) {
  const { minX, maxX } = world.terrain, span = constructionSpan(blueprint, { x, facing });
  if (span.minX < minX + 20 || span.maxX > maxX - 20) throw new Error(tr('Posição de testes fora do campo.'));
  return coldConstructionPlacement(blueprint, world.terrain, { x, facing, settle: world.settle });
}
// Admission is prepared before a new server identity or a replacement is committed.
export function prepareTestSpawn(world: World, intent: Extract<TestIntent, { act: 'spawn' }>) {
  const source = createStructuredTemplate(intent.templateId);
  let blueprint;
  try { blueprint = compileStructuredConstruction(source); }
  catch (error) { throw constructionEditError(error); }
  const placed = poseAt(world, blueprint, intent.x, intent.facing);
  try {
    const site = blueprint.preset === 'vehicle' ? {} : constructionSupportSite(world.terrain, placed, constructionSpan(blueprint, intent)),
      prepared = compileManufacture(source, site);
    return { source: prepared.construction, mobile: prepared.compiled.preset === 'vehicle' };
  } catch (error) { throw constructionEditError(error); }
}
export function testTargetLimit(world: World, mobile: boolean) {
  const count = world.actors.filter(actor => (actor.team === TEST_TARGET_TEAM || actor.ownerId === TRIAL_TARGET_OWNER) &&
    Boolean(actor.vehicle?.config.enabled) === mobile).length,
    limit = CONSTRUCTION_LIMITS[mobile ? 'vehicles' : 'fixed'];
  if (count >= limit) throw new Error(tr`Limite de testes: ${limit} alvos ${mobile ? tr('móveis') : 'fixos'}, incluindo destroços.`);
}
export function stopTestActor(world: World, actor: SceneActor) { releaseWorldInputs(world, [actor.id], 1, true, true); }
function supplyTestLevels(world: World, actor: SceneActor, levels: RepairLevels) {
  const game = world.game(), patches = Object.entries(levels).map(([piece, state]) => ({
    owner: game.handle(`${actor.id}:${actor.revision}:${piece}`), state,
  })).filter(patch => patch.owner !== null);
  if (!patches.length) return;
  try { game.call({ op: 'setPartStates', actorId: actor.id, patches }); }
  catch (error) { try { game.call({ op: 'sync' }); } finally { throw error; } }
}
export function repairTestActor(world: World, actor: SceneActor) {
  const levels = appraise(actor, fieldParts(world)).levels;
  stopTestActor(world, actor);
  const fresh = world.replaceActor(actor.construction, { id: actor.id });
  supplyTestLevels(world, fresh, levels);
  return fresh;
}
export function resupplyTestActor(world: World, actor: SceneActor) {
  const levels = appraise(actor, fieldParts(world)).full;
  stopTestActor(world, actor); supplyTestLevels(world, actor, levels);
  return currentActor(world, actor.id);
}
export function prepareTestMove(world: World, actor: SceneActor, intent: Extract<TestIntent, { act: 'reposition' }>) {
  if (!actor.vehicle?.config.enabled) throw new Error(tr('Reposicionar está disponível apenas para veículos móveis.'));
  return poseAt(world, actor.blueprint, intent.x, intent.facing).pose;
}
export function moveTestActor(world: World, actor: SceneActor, intent: Extract<TestIntent, { act: 'reposition' }>, pose: Pose) {
  stopTestActor(world, actor);
  if (actor.facing !== intent.facing) actor = world.turnActor(actor.id);
  world.command('setVehicleState', { actorId: actor.id, state: { ...pose, vx: 0, vy: 0, omega: 0 } });
  return currentActor(world, actor.id);
}

// Private proving ground only. It has no network authority and no second privilege/session state.
export function privateTestAction(world: World, data: unknown, request: number): TestResult {
  const intent = testIntent(data);
  if (intent.act === 'list') return testActors(world);
  if (intent.act === 'resources') throw new Error(tr('O campo de provas não tem estoque de facção.'));
  if (intent.act === 'speed') throw new Error(tr('A velocidade global é uma configuração do servidor de testes.'));
  if (intent.act === 'spawn') {
    const prepared = prepareTestSpawn(world, intent);
    if (intent.kind === 'target') {
      if (!Number.isSafeInteger(request) || request <= 0 || world.actor(`test-target:${request}`)) return invalid();
      testTargetLimit(world, prepared.mobile);
    }
    const actor = intent.kind === 'vehicle' ? world.replaceActor(prepared.source, { id: 'local', x: intent.x, facing: intent.facing }) :
      world.addActor(prepared.source, { id: `test-target:${request}`, ownerId: null, team: TEST_TARGET_TEAM, x: intent.x,
        facing: intent.facing, playerName: tr('Alvo de teste'), color: '#c96f5b' });
    stopTestActor(world, actor);
    return { actor: { id: actor.id, blueprint: structuredClone(actor.construction) } };
  }
  let actor = activeTestActor(world, intent.actorId);
  if (intent.act === 'repair') actor = repairTestActor(world, actor);
  else if (intent.act === 'resupply') actor = resupplyTestActor(world, actor);
  else actor = moveTestActor(world, actor, intent, prepareTestMove(world, actor, intent));
  return { changed: actor.id };
}
