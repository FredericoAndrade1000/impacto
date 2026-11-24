import type { STOCKS } from './economy.ts';
import type { CARGO } from './component-volume.ts';

// Labels and physical cargo remain owned by their existing catalogues.
export type StockId = keyof typeof STOCKS;
export type SupplyBill = Record<StockId, number>;
export type CargoKind = keyof typeof CARGO;
export type CargoLoad = Partial<Record<CargoKind, number>>;
export type ReserveLevel =
  | { fuelLitres: number; rounds?: never; cargo?: never }
  | { rounds: number; fuelLitres?: never; cargo?: never }
  | { cargo: CargoLoad; fuelLitres?: never; rounds?: never };
export type RepairLevels = Record<string, ReserveLevel>;

// An amount of each stock: what something costs or gives back. Fuel is in litres, the rest in credits.
export const bill = (ferro = 0, ligas = 0, silica = 0, combustivel = 0): SupplyBill => ({ ferro, ligas, silica, combustivel });
