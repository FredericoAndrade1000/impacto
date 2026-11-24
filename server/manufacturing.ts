import { CAPACITY_MESSAGE, PART_LIMITS, validateStructuredConstruction, compileStructuredConstruction } from '../src/structured-construction.ts';
import { DESIGN_VERSION, isVehicleDesign } from '../src/persistence.ts';
import { constructionEditError } from '../src/structured-editing.ts';
import { constructionLimitMessage } from '../src/construction-limits.ts';
import { constructionSpan } from '../src/construction-placement.ts';
import { industrialAdmission, missingIndustry } from '../src/industry.ts';
import { industryRequirementMessage } from '../src/industry-messages.ts';
import { userError } from '../src/user-message.ts';
import { BASE_RADIUS, UNCOMMANDED } from '../src/economy.ts';
import type { AuthoredConstruction, CanonicalConstruction } from '../src/construction-contract.ts';
import type { World } from '../src/physics.ts';
import type { Facing } from './room-contract.ts';
import type { IndustryLevels } from '../src/industry.ts';

export interface ManufacturingPlanInput {
  blueprint: CanonicalConstruction; previous?: { facing: Facing } | null;
  baseFacing: Facing; facing?: unknown;
  counts: { vehicles: number; fixed: number }; industry: IndustryLevels;
}
export interface BasePositionInput {
  world: World; source: AuthoredConstruction; factionId: string; base: number;
  limits: { minX: number; maxX: number }; requested?: unknown;
  facing: Facing; ignoreId?: string | null | undefined;
}

const ROW_SPACING = 12, IN_THE_WAY = 50;
const BASE_ROW = Object.freeze(Array.from({ length: 2 * Math.floor(BASE_RADIUS / ROW_SPACING) + 1 },
  (_, i) => (i % 2 ? -1 : 1) * Math.ceil(i / 2) * ROW_SPACING));

// Admission and eligibility read explicit facts and never charge stock, claim
// an actor or open works. The room authorizes and commits the admitted plan.
export function admitManufacturingDesign(input: unknown): CanonicalConstruction {
  if (!input || typeof input !== 'object' || !('version' in input) || input.version !== DESIGN_VERSION ||
    'derived' in input && input.derived) throw userError('Este projeto não pode ser fabricado: recarregue a página e tente de novo.');
  let source, compiled;
  try { source = validateStructuredConstruction(input); compiled = compileStructuredConstruction(source); }
  catch (error) { throw Object.assign(constructionEditError(error),
    { code: error && typeof error === 'object' && 'code' in error ? error.code : undefined }); }
  if (!compiled.plates.length && !compiled.modules.length) throw userError('Adicione chapas ou componentes antes de fabricar.');
  if (!compiled.modules.some(module => module.kind === 'command')) throw new Error(UNCOMMANDED);
  if (source.plates.length > PART_LIMITS.plates || source.components.length > PART_LIMITS.components) throw userError(CAPACITY_MESSAGE);
  return source;
}
export function manufacturingPlan({ blueprint, previous = null, baseFacing, facing, counts, industry }: ManufacturingPlanInput) {
  const vehicle = isVehicleDesign(blueprint), direction = facing === -1 || facing === 1 ? facing : previous ? previous.facing : baseFacing;
  if (previous && !vehicle) throw userError('Uma estrutura não substitui um veículo: fabrique-a como obra no campo.');
  const limit = constructionLimitMessage(counts, vehicle, Boolean(previous));
  if (limit) throw userError(limit);
  const admission = industrialAdmission(blueprint, compileStructuredConstruction(blueprint)), missing = missingIndustry(admission, industry);
  if (admission.oversized || missing.length) throw Object.assign(userError(industryRequirementMessage(admission, industry)),
    { code: 'INDUSTRY_REQUIRED', requirements: missing, oversized: admission.oversized });
  return { blueprint, vehicle, direction };
}

// A new vehicle uses the requested place or the first free base-row point. A
// replacement may use the nearest free gap. Read only the faction's neighbours on
// the ground: a refusal must not reveal a construction it cannot see, and an
// aircraft in the air, however low, takes no place there (vehicles do not
// collide). Each outline is read once; neither the old vehicle nor a neighbour is
// moved to make room.
export function baseVehiclePosition({ world, source, factionId, base, limits: { minX, maxX }, requested, facing, ignoreId }: BasePositionInput): number {
  const blueprint = compileStructuredConstruction(source), span = constructionSpan(blueprint, { x: 0, facing }),
    requestedAt = requested == null ? requested : typeof requested === 'number' ? requested : NaN,
    positions = requestedAt == null ? BASE_ROW.map(offset => base + offset) : [requestedAt],
    about = world.actors.filter(actor => actor.team === factionId && actor.id !== ignoreId && !actor.vehicle?.flying &&
      Math.abs((actor.vehicle?.x ?? actor.x) - base) <= BASE_RADIUS + IN_THE_WAY).map(actor => world.actorBounds(actor.id)),
    free = (x: number) => about.every(bounds => x + span.maxX + .8 < bounds.minX || x + span.minX - .8 > bounds.maxX);
  for (const x of positions) {
    if (!Number.isFinite(x) || x < minX || x > maxX) throw userError('Posição no campo inválida.');
    if (Math.abs(x - base) > BASE_RADIUS) throw userError('Fabrique dentro da base.');
    if (free(x)) return x;
  }
  if (ignoreId) {
    // A micrometre beyond strict clearance avoids rejecting the gap at equality.
    const gap = .800001, nearby = about.flatMap(bounds => [bounds.minX - span.maxX - gap, bounds.maxX - span.minX + gap])
      .filter(x => x >= minX && x <= maxX && Math.abs(x - base) <= BASE_RADIUS)
      .sort((a, b) => Math.abs(a - Number(requestedAt)) - Math.abs(b - Number(requestedAt)) || a - b),
      place = nearby.find(free);
    if (place !== undefined) return place;
  }
  throw userError(requested == null ? 'A base está cheia. Mova ou desmonte uma construção.' : 'Não há espaço aí: afaste as construções vizinhas e tente de novo.');
}
