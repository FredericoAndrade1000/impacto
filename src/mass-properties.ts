import { constructionProjection } from './persistence.ts';
import type { CompiledConstruction } from './construction-contract.ts';
type ConstructionMassInput = Parameters<typeof constructionProjection>[0];

// Pieces on the field retain the mass from the core's last weighing, including its load threshold.
export function pieceMass(piece: { physicalMass?: number | undefined } | null | undefined): number {
  const mass = piece?.physicalMass;
  if (typeof mass !== 'number' || !Number.isFinite(mass) || mass < 0) throw new TypeError('A peça não tem uma massa física compilada válida.');
  return mass;
}
export function blueprintMass(input: ConstructionMassInput): number {
  const mass = constructionProjection(input).fixedAssembly?.mass;
  if (!Number.isFinite(mass) || mass < 0) throw new TypeError('A construção não tem uma massa física compilada válida.');
  return mass;
}

// Workshop reports use the same admitted drivetrain as the live construction.
export const blueprintPowertrain = (input: ConstructionMassInput) => constructionProjection(input).powertrain;
// The power of every engine of a compiled design, as installed: with no fuel to burn, the drivetrain gives none, but
// the engines are as strong.
export const installedPower = (compiled: Pick<CompiledConstruction, 'modules'>): number =>
  (compiled.modules || []).filter(part => part.kind === 'engine').reduce((sum, part) => sum + part.powerKw, 0);
