import { cartridgeOf, cartridgeId } from './weapons.ts';
import { componentScale, componentDimensions, componentReference, BODY_WIDTH } from './component-size.ts';
import type { SizedComponent } from './component-size.ts';
import type { ModuleKind } from './materials.ts';
import type { AmmoId, WeaponId } from './weapons.ts';
import type { CargoLoad } from './economy-contract.ts';

export interface CargoContainer { kind: ModuleKind; capacityM3: number; cargo?: CargoLoad | undefined }
type CapacityKind = 'hopper' | 'cistern' | 'supply' | 'paver';
export type CapacityPiece = { cargo?: CargoLoad | undefined } &
  ({ kind: CapacityKind; capacityM3: number } | { kind: Exclude<ModuleKind, CapacityKind>; capacityM3?: never });
export interface CargoRoomObservation { kind: ModuleKind; capacityM3?: number | undefined }
export interface ReserveStatus { attached?: boolean | undefined; health?: number | undefined; detonated?: boolean | undefined }
export interface AmmunitionReserveStatus extends ReserveStatus {
  kind: ModuleKind; ammoPreset?: WeaponId | undefined; actorId?: string | undefined;
}
export interface FuelReserveInput { kind: 'fuel'; capacityLitres: number; fuelLitres?: number | undefined }
export interface AmmoReserveInput { kind: 'ammo'; capacityRounds: number; rounds?: number | undefined }
type OtherReserveInput = { kind: Exclude<ModuleKind, 'fuel' | 'ammo'> };
// How deep a piece stands across the body (game_geometry.rs `installed_depth`): one the workshop sizes as deep as its
// kind at any size, so that what it holds, gives and weighs grows with what the side view shows of it, s² of the
// reference piece at size s; running gear, which its chassis sizes, by its one scale and no deeper than the body is wide.
const GEAR = Object.freeze(['wheel', 'track']);
export const componentDepth = (module: SizedComponent) => GEAR.includes(module.kind)
  ? Math.min((componentReference(module).depthM ?? .45) * componentScale(module), BODY_WIDTH) : componentReference(module).depthM ?? .45;
export const componentVolume = (module: SizedComponent) => {
  const {width, height} = componentDimensions(module);
  return width * height * componentDepth(module);
};

// Complete cartridge/round plus an estimated packed volume; projectile mass
// in weapons.ts remains separate. Presets identify compatible feeds, including
// the different 30 mm cartridges, rather than sharing by diameter alone.
export const ammunitionProfile = (module: { ammoPreset?: WeaponId | undefined; ammoType?: AmmoId | undefined }) => cartridgeOf(module.ammoPreset, module.ammoType);
// What a fuel tank or an ammunition box of a design takes and holds: it is built full, and a compiled one says so.
export function reserveState(module: FuelReserveInput): { capacityLitres: number; fuelLitres: number };
export function reserveState(module: AmmoReserveInput): { capacityRounds: number; rounds: number };
export function reserveState(module: OtherReserveInput): Record<string, never>;
export function reserveState(module: FuelReserveInput | AmmoReserveInput | OtherReserveInput):
  { capacityLitres: number; fuelLitres: number } | { capacityRounds: number; rounds: number } | Record<string, never>;
export function reserveState(module: FuelReserveInput | AmmoReserveInput | OtherReserveInput) {
  if (module.kind === 'fuel') {
    const { capacityLitres } = module;
    return { capacityLitres, fuelLitres: module.fuelLitres ?? capacityLitres };
  }
  if (module.kind === 'ammo') {
    const { capacityRounds } = module;
    return { capacityRounds, rounds: module.rounds ?? capacityRounds };
  }
  return {};
}
// What a hopper, a cistern and a supply piece carry, as the core has it (game_geometry.rs `CARGO`, in this order): a
// unit of a solid is a kilogram and takes the room of its bulk density, a unit of a liquid is a litre. `paving` is how
// many units of each the mix of a metre of asphalt takes (economy.ts `PAVING`), which is all a paver carries.
export const CARGO = Object.freeze({
  ferro: Object.freeze({ liquid: false, density: 2400, paving: 0 }), ligas: Object.freeze({ liquid: false, density: 1500, paving: 0 }),
  silica: Object.freeze({ liquid: false, density: 1600, paving: 280 }), petroleo: Object.freeze({ liquid: true, density: 850, paving: 14 }) });
export type CargoKind = keyof typeof CARGO;
// Whether a reservoir takes liquids (`true`), solids (`false`) or both
// (`null`: the crates and cans of a supply piece).
const RESERVOIRS = Object.freeze({ hopper: { liquid: false },
  cistern: { liquid: true }, supply: { liquid: null } });
type ReservoirKind = keyof typeof RESERVOIRS;
const isReservoirKind = (kind: ModuleKind): kind is ReservoirKind => Object.hasOwn(RESERVOIRS, kind);
// The share of the room of supply pieces that fuel is loaded into; the materials take the rest.
export const FUEL_SHARE = .25;
// Whether a piece carries a load: a hopper, a cistern or a supply piece.
export const holdsCargo = (module: Pick<CargoContainer, 'kind'>) => isReservoirKind(module.kind);
export const cargoUnitMass = (name: CargoKind) => CARGO[name].liquid ? CARGO[name].density / 1000 : 1;
export const cargoUnitVolume = (name: CargoKind) => CARGO[name].liquid ? .001 : 1 / CARGO[name].density;
// A hopper takes solids, a cistern liquids and a supply piece either; nothing else carries.
export const carries = (module: Pick<CargoContainer, 'kind'>, name: CargoKind) => isReservoirKind(module.kind) && Object.hasOwn(CARGO, name) &&
  [null, CARGO[name].liquid].includes(RESERVOIRS[module.kind].liquid);
// Cargo capacity comes from the compiled piece.
export function cargoRoom<Piece extends CapacityPiece>(module: Piece): number;
export function cargoRoom(module: CargoRoomObservation): number | undefined;
export function cargoRoom(module: CargoRoomObservation): number | undefined {
  return module.kind === 'hopper' || module.kind === 'cistern' || module.kind === 'supply' ? module.capacityM3 : 0;
}
// The cargo contract limits the own keys of these dictionaries to the physical catalogue.
const cargoEntries = (cargo: CargoLoad) => Object.entries(cargo) as [CargoKind, number][];
export const cargoVolume = (module: Pick<CargoContainer, 'cargo'>) => cargoEntries(module.cargo || {}).reduce((sum, [name, units]) => sum + units * cargoUnitVolume(name), 0);
export const cargoMass = (module: Pick<CargoContainer, 'cargo'>) => cargoEntries(module.cargo || {}).reduce((sum, [name, units]) => sum + units * cargoUnitMass(name), 0);
// How many more units of a material a reservoir takes on top of what it holds.
export const cargoSpace = (module: CapacityPiece, name: CargoKind) => carries(module, name) ? Math.max(0, cargoRoom(module) - cargoVolume(module)) / cargoUnitVolume(name) : 0;
// A paver carries in the hopper built into it the mix of the asphalt it lays, and nothing else (game_geometry.rs
// `ComponentKind::cargo_most`): each thing of it in the share a metre of road takes of it, as far as its room — the room
// of that mix for 45 m at the reference size (`PAVER_METRES`), and s² of that at size s — goes. Its hopper is no
// reservoir of the field: it takes nothing dug, and nothing but its own paving.
export const holdsMix = (module: Pick<CargoContainer, 'kind'>) => module.kind === 'paver';
// The room the mix of a metre of asphalt takes, in cubic metres.
export const MIX_VOLUME = (Object.entries(CARGO) as [CargoKind, typeof CARGO[CargoKind]][]).reduce((sum, [name, cargo]) => sum + cargo.paving * cargoUnitVolume(name), 0);
// How many metres of asphalt a paver holds the mix for, full.
export const mixRoom = (module: CapacityPiece) => module.kind === 'paver' ? module.capacityM3 / MIX_VOLUME : 0;
// How many more units of a thing of that mix a paver takes on top of what it holds of it.
export const mixSpace = (module: CapacityPiece, name: CargoKind) => holdsMix(module) && CARGO[name]?.paving > 0 ?
  Math.max(0, mixRoom(module) * CARGO[name].paving - (module.cargo?.[name] || 0)) : 0;
export const usableReserve = (module: ReserveStatus) => module.attached !== false && module.health !== 0 && !module.detonated;
// The boxes that feed a gun, of the rounds of its cartridge (weapons.ts `cartridgeId`): a gun made over fires those of the
// gun it was made of while its calibre and charge are the same.
export function ammunitionSupply<T extends AmmunitionReserveStatus>(modules: readonly T[], preset: WeaponId, actorId?: string): T[] {
  const cartridge = cartridgeId(preset);
  return modules.filter(m => m.kind === 'ammo' && (m.ammoPreset || 'rh120') === cartridge &&
    (actorId === undefined || m.actorId === actorId) && usableReserve(m));
}
