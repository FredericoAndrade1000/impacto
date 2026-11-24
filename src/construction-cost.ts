import { nativeConstructionCost } from './native-dynamics.ts';
import { constructionCatalogue } from './construction-admission.ts';
import { constructionProjection } from './persistence.ts';
import { WEAPON_PRESETS, cartridgeOf, weaponOf } from './weapons.ts';
import { number } from './format.ts';
import type { MaterialId, MetalId, ModuleKind } from './materials.ts';
import type { AmmoId, WeaponId } from './weapons.ts';
import type { WeaponMountId } from './weapon-mounts.ts';
import type { AuthoredConstruction, ChassisPartMetadata, CompiledConstruction, ModuleSupport } from './construction-contract.ts';

export const COST_GROUP_IDS = ['command', 'chassis', 'armour', 'engines', 'weapons', 'runningGear', 'storage', 'supplies', 'kept'] as const;
export type PieceCostGroups = Record<typeof COST_GROUP_IDS[number], number>;
export type ConstructionPrice = PieceCostGroups & { total: number };
export interface PricedPlate {
  material: MaterialId; kind?: undefined; chassis?: Partial<ChassisPartMetadata> | undefined;
  physicalMass?: number | undefined; length?: number | undefined; thicknessMm?: number | undefined; widthM?: number | undefined;
}
export interface PricedModule {
  kind: ModuleKind; material?: undefined; width?: number | undefined; height?: number | undefined; mechanicalDepth?: number | undefined; physicalMass?: number | undefined;
  metal?: MetalId | undefined; armorMm?: number | undefined; support?: Pick<ModuleSupport, 'mass'> | undefined; weaponPreset?: WeaponId | undefined;
  weaponMount?: { preset: WeaponMountId } | undefined; ammoPreset?: WeaponId | undefined; ammoType?: AmmoId | undefined;
}
export type CostPiece = PricedPlate | PricedModule;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isCostGroups = (value: unknown): value is PieceCostGroups => record(value) && COST_GROUP_IDS.every(key => finite(value[key]));
const isConstructionPrice = (value: unknown): value is ConstructionPrice => record(value) && finite(value.total) && isCostGroups(value);
function costGroups(value: unknown): PieceCostGroups {
  if (!isCostGroups(value)) throw new Error('O núcleo respondeu com custos de construção inválidos.');
  return value;
}
function constructionPrice(value: unknown): ConstructionPrice {
  if (!isConstructionPrice(value)) throw new Error('O núcleo respondeu com custos de construção inválidos.');
  return value;
}

// The price reader uses only these catalogue fields. Derive the private build constant from
// the ordinary catalogue; admission and templates still receive the complete public catalogue.
// Running gear is paid for its rubber as on a steel one whatever its metal, by the share of it its chassis tells.
// A mount is paid as it grows with a gun heavier than it is rated for (weapon-mounts.ts `weaponMountCost`).
const costCatalogue = (() => {
  const { weapons, mounts, sensors, chassis } = constructionCatalogue();
  return {
    weapons: Object.fromEntries(Object.entries(weapons).map(([id, { costCredits, cartridge, rounds, installedMassKg }]) => [id, { costCredits, cartridge, rounds, installedMassKg }])),
    mounts: Object.fromEntries(Object.entries(mounts).map(([id, { cost, exposed, ratedMass }]) => [id, { cost, exposed, ratedMass }])),
    sensors: Object.fromEntries(Object.entries(sensors).map(([id, { cost }]) => [id, { cost }])),
    chassis: Object.fromEntries(Object.entries(chassis).map(([id, { structure: { rubberShare } }]) => [id, { structure: { rubberShare } }])),
  };
})();
// Armour price reads its physical mass, or its dimensions where that mass is absent. Keep
// chassis metadata for its one frame charge; modules retain their complete physical mount.
const costPiece = (piece: CostPiece) => typeof piece.material === 'string' ? {
  chassis: piece.chassis, material: piece.material, physicalMass: piece.physicalMass,
  length: piece.length, thicknessMm: piece.thicknessMm, widthM: piece.widthM,
} : piece;

// Credits are gameplay prices for complete installed assemblies, not market
// quotations. No cost supplied by a saved file is trusted by the calculation.
// Concrete is paid in two stocks, what it is made of (economy.ts `OWN_PRICES`).
export const formatCredits = (value: number, digits = 0) => number(value, digits) + ' cr';
export const weaponCost = (preset?: WeaponId) => (weaponOf(preset ?? 'rh120') || WEAPON_PRESETS.rh120).costCredits;
// A round of a calibre, as the guns of it are fed `ammo` (by a box: its `ammoType`).
export const ammunitionCost = (preset?: WeaponId, ammo?: AmmoId) => cartridgeOf(preset, ammo).costCredits;

// The prices of the catalogue, with those of the guns made over in the workshop that these pieces name (weapons.ts
// `weaponOf`): the core priced them as it made them.
function catalogueFor(pieces: readonly { weaponPreset?: WeaponId | undefined; ammoPreset?: WeaponId | undefined }[]) {
  const made = pieces.flatMap(piece => [piece.weaponPreset, piece.ammoPreset]).filter((id): id is WeaponId => !!id && !Object.hasOwn(costCatalogue.weapons, id));
  if (!made.length) return costCatalogue;
  const weapons = { ...costCatalogue.weapons };
  for (const id of made) {
    const gun = weaponOf(id);
    if (gun) weapons[id] = { costCredits: gun.costCredits, cartridge: gun.cartridge, rounds: gun.rounds, installedMassKg: gun.installedMassKg };
  }
  return { ...costCatalogue, weapons };
}
export function pieceCostBreakdown(piece: CostPiece): PieceCostGroups {
  return costGroups(nativeConstructionCost({ version: 1, piece: costPiece(piece), catalogue: catalogueFor(typeof piece.material === 'string' ? [] : [piece]) }));
}
export function pieceCost(piece: CostPiece): number {
  return Object.values(pieceCostBreakdown(piece)).reduce((sum, value) => sum + value, 0);
}
// Price compiled pieces together, without admitting another construction.
export function piecesCost(pieces: readonly CostPiece[]): number {
  if (!pieces.length) return 0;
  const plates: ReturnType<typeof costPiece>[] = [], modules: PricedModule[] = [];
  for (const piece of pieces) {
    if (typeof piece.material === 'string') plates.push(costPiece(piece));
    else modules.push(piece);
  }
  return constructionPrice(nativeConstructionCost({ version: 1, compiled: { plates, modules }, catalogue: modules.length ? catalogueFor(modules) : undefined })).total;
}
export function constructionCost(input: AuthoredConstruction | CompiledConstruction): ConstructionPrice {
  const { plates, modules } = constructionProjection(input);
  return constructionPrice(nativeConstructionCost({ version: 1, compiled: { plates: plates.map(costPiece), modules }, catalogue: catalogueFor(modules) }));
}
