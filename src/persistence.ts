import { validateStructuredConstruction, compileStructuredConstruction, validateDraftConstruction, compileDraftConstruction } from './structured-construction.ts';
import { DESIGN_VERSION } from './design-contract.ts';
export { DESIGN_VERSION } from './design-contract.ts';
import type { AuthoredConstruction, CompiledConstruction, ConstructionSource } from './construction-contract.ts';
import { isConstructionSource } from './construction-codec.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only the current authored format (`CONSTRUCTION_VERSION` in the core) is accepted.
function authored(input: unknown): unknown {
  if (!record(input) || input.version !== DESIGN_VERSION || input.derived)
    throw Object.assign(new Error('Esse não é um projeto desta versão do jogo. Exporte o original para preservá-lo e crie um projeto atual.'), { code: 'DESIGN_VERSION' });
  return input;
}
export const validateBlueprint = (input: unknown) => validateStructuredConstruction(authored(input));
export const validateDraftBlueprint = (input: unknown) => validateDraftConstruction(authored(input));
export const isVehicleDesign = (source: unknown) => record(source) && source.preset === 'vehicle' && Boolean(source.chassis);
// The workshop authors vehicles and fixed defences.
export const isWorkshopDesign = (source: unknown) => isVehicleDesign(source) || record(source) && source.preset === 'bunker' && !source.chassis;
export function workshopDraft(source: AuthoredConstruction): AuthoredConstruction;
export function workshopDraft(source: unknown): ConstructionSource;
export function workshopDraft(source: unknown): ConstructionSource {
  if (isWorkshopDesign(source) && isConstructionSource(source)) return source;
  throw Object.assign(new Error('Este projeto não é um veículo nem uma defesa fixa.'), { code: 'NOT_A_CONSTRUCTION' });
}
export const compileBlueprint = (input: unknown) => compileStructuredConstruction(authored(input));
export const compileDraftBlueprint = (input: unknown) => compileDraftConstruction(authored(input));
// Metadata and rendering can read a compiler result; imported/saved documents
// still pass the one native compiler, never a host converter.
export const constructionProjection = (input: AuthoredConstruction | CompiledConstruction): CompiledConstruction => 'derived' in input && input.derived === true &&
  input.canonicalVersion === DESIGN_VERSION && typeof input.mechanicalAdmission === 'boolean' ? input : compileDraftBlueprint(input);
export const serializeBlueprint = (input: unknown) => JSON.stringify(validateDraftBlueprint(input), null, 2);
export function parseBlueprint(text: unknown) {
  if (typeof text !== 'string' || text.length > 512000) throw new Error('O arquivo é grande demais para ser um projeto.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('O arquivo não é um projeto: está corrompido ou é de outro tipo.'); }
  return validateDraftBlueprint(parsed);
}
