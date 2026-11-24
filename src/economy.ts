import { phrase, phraseList, tr, translate } from './i18n.ts';
import type { MessageValue } from './i18n.ts';
import { clamp } from './math.ts';
import { constructionCost, pieceCostBreakdown, piecesCost, ammunitionCost } from './construction-cost.ts';
import { reserveState, usableReserve, CARGO, FUEL_SHARE, carries, cargoRoom, cargoSpace, cargoVolume, cargoUnitVolume, holdsCargo, holdsMix, mixRoom, mixSpace } from './component-volume.ts';
import { componentScale } from './component-size.ts';
import { MATERIALS, metalOf } from './materials.ts';
import { count, number, volume, litres } from './format.ts';
import { bill } from './economy-contract.ts';
export { bill } from './economy-contract.ts';
import type { SupplyBill, CargoKind, CargoLoad, StockId, RepairLevels } from './economy-contract.ts';
import type { MaterialId, ModuleKind, MetalChoicePart } from './materials.ts';
import type { SizedComponent } from './component-size.ts';
import type { CompiledConstruction, CompiledModule, CompiledPlate } from './construction-contract.ts';
import type { SceneActor, SceneModule, LivePlate } from './scene-contract.ts';
import type { PieceCostGroups } from './construction-cost.ts';
import type { CapacityPiece } from './component-volume.ts';
import type { RepairPiece } from './construction-service.ts';

export type Bill = SupplyBill;
export type Load = Required<CargoLoad>;
export interface CargoRooms { solid: number; liquid: number; supplies: number }
type DesignPiece = CompiledModule | (CompiledPlate & { kind?: never });
type FieldPiece = SceneModule | (LivePlate & { kind?: never; cargo?: never; health?: never; maxHealth?: never; fuelLitres?: never; rounds?: never; detonated?: never });
export type FieldParts = Map<string, FieldPiece>;
export type CargoPiece = CapacityPiece & { health: number; attached?: boolean };
export type MendablePiece = { id: string; cost: number; entire?: boolean } &
  ({ stock: StockId; costs?: Partial<SupplyBill> } | { stock: null; costs: Partial<SupplyBill> });
export interface Appraisal {
  built: SupplyBill; salvage: SupplyBill; repair: SupplyBill; rearm: SupplyBill; seconds: number;
  levels: RepairLevels; full: RepairLevels; mendable: (MendablePiece & { rank: number })[];
}
export interface PartialRepair { pieces: RepairPiece[]; cost: SupplyBill; seconds: number }
interface ResupplyQuote { levels: RepairLevels; full: RepairLevels; rearm: SupplyBill }

// The economy of the shared field. Prices are the workshop's, in credits; what a piece is paid
// from is the stock of what it is made of, and a faction keeps one stock of each. Fuel is a stock
// of its own, in litres. What a construction is worth on the field is what is physically left of it.
export const STOCKS = Object.freeze({ ferro: 'Ferro', ligas: 'Ligas', silica: 'Sílica', combustivel: 'Combustível' });
const stockId = (id: string): id is StockId => Object.hasOwn(STOCKS, id);
export const STOCK_IDS: readonly StockId[] = Object.freeze(Object.keys(STOCKS).filter(stockId));
// What is dug, carried and unloaded, in the order the core has it (component-volume.ts `CARGO`), and
// the stock a refinery makes of each: ore into the material it is, petroleum into fuel.
export const RAW = Object.freeze({ ferro: 'Ferro', ligas: 'Ligas', silica: 'Sílica', petroleo: 'Petróleo' });
export const RAW_IDS: readonly CargoKind[] = Object.freeze(Object.keys(CARGO).filter((id): id is CargoKind => Object.hasOwn(CARGO, id)));
export const REFINED = Object.freeze({ ferro: 'ferro', ligas: 'ligas', silica: 'silica', petroleo: 'combustivel' } satisfies Record<CargoKind, StockId>);
// How much of that a refinery makes of a unit of each: as much of a material as there was of its ore, and 0.8 L of
// fuel of a litre of petroleum — the gasoline, the diesel and the jet fuel a refinery makes of a barrel of crude, the rest
// of it being heavier oils, gas and what it burns itself.
export const YIELD = Object.freeze({ ferro: 1, ligas: 1, silica: 1, petroleo: .8 });
// Stock taken to the front rides in supply pieces as the thing it was made of: the three materials as the solids of their
// names, and fuel as petroleum, litre for litre.
export const SUPPLIED = Object.freeze({ ferro: 'ferro', ligas: 'ligas', silica: 'silica', combustivel: 'petroleo' } satisfies Record<StockId, CargoKind>);
// The stock each armour is paid from. A component is paid from that of what it is made of (materials.ts `METALS`), but
// for what its material does not change (`kept`) and its rounds, in iron, and its fuel, in fuel.
const ARMOUR_STOCK: Readonly<Record<MaterialId, StockId>> = Object.freeze({ steel: 'ferro', hha: 'ferro', concrete: 'silica', aluminum: 'ligas', titanium: 'ligas',
  ceramic: 'silica', fiberglass: 'silica', glass: 'silica' });
export const stockOf = (piece: MetalChoicePart | { kind?: never; material: MaterialId }): StockId => piece.kind ? metalOf(piece).stock : ARMOUR_STOCK[piece.material] || 'ferro';
// What of a kilogram of an armour the stock it is paid from pays, where that is not the whole of its price:
// of concrete, the sand, the gravel and the cement it is made of, in Sílica.
// Iron pays the rest, the bar that reinforces it: some 100 kg of steel to the cubic metre, at the price of steel.
const OWN_PRICES: Readonly<Partial<Record<MaterialId, number>>> = Object.freeze({ concrete: .8 });
const partly = (piece: DesignPiece): piece is CompiledPlate & { kind?: never } => !piece.kind && Object.hasOwn(OWN_PRICES, piece.material);
// The credits so many kilograms of an armour cost, and those of them its own stock pays, each to the credit begun as the
// core counts it.
const credits = (kg: number, price: number): number => Math.max(0, Math.ceil(kg * price - 1e-9));
const ownCost = (plate: CompiledPlate): number => credits(plate.physicalMass, Number(OWN_PRICES[plate.material]));
// What plates of an armour weighing so many kilograms each are paid with, by stock, as a design pays for them.
export function armourBill(material: MaterialId, masses: readonly number[]): SupplyBill {
  const paid = bill(), stock = ARMOUR_STOCK[material] || 'ferro',
    price = piecesCost(masses.map(physicalMass => ({ material, physicalMass }))),
    own = Object.hasOwn(OWN_PRICES, material) ? masses.reduce((sum, kg) => sum + credits(kg, Number(OWN_PRICES[material])), 0) : price;
  paid[stock] += own; paid.ferro += price - own;
  return paid;
}
// What so many cubic metres of concrete cast on the field cost, as the footing of a structure is (fixed-footing.ts): its
// sand, its gravel and its cement, in Sílica, as concrete pays for them. It asks for no bar of iron.
export const castBill = (volume: number): SupplyBill => bill(0, 0, credits(volume * MATERIALS.concrete.density, Number(OWN_PRICES.concrete)));
// What a faction begins with: iron to build with, fuel to move it, and of the two materials that have to be fetched
// enough to plate a light vehicle in aluminium or in ceramic — a medium one in aluminium —, not to do without the veins.
export const STARTING_STOCK = Object.freeze({ ferro: 90000, ligas: 10000, silica: 10000, combustivel: 1500 });
export const DAMAGED_SHARE = .5;   // of what is left of a damaged piece, when it is dismantled
export const BASE_RADIUS = 100;    // metres to each side of the base that count as the base
export const CALM_SECONDS = 10;    // without firing or being hit: out of combat
export const TURN_SECONDS = 5;     // a construction takes to turn about where it stands, unless it is hit meanwhile
// And an aircraft in the air, which flies on meanwhile: half a turn at 90° a second, as a light helicopter or a drone
// swings round in a hover, with no ground under it to work round on.
export const AIR_TURN_SECONDS = 2;
// Why a design with no command post is not published: on the field, a construction with none that works is out of action.
export const UNCOMMANDED = tr('Instale um Comando: sem ele, a construção fica fora de combate.');
// Why nothing is published by a faction that lost its base (server/room.ts, `fall`): there is nowhere to make it.
export const UNBASED = tr('Sua facção está sem base: estabeleça outra no painel do campo para fabricar.');
export const WRECK_SECONDS = 900;  // a wreck stays on the field this long
export const WRECK_FADE_SECONDS = 12; // and fades away over the last of them
export const SALVAGE_REACH = 30;   // metres from a wreck to a construction that dismantles it
export const LOAD_REACH = 30;      // broad search radius; a tool must also reach the actual surface band (loading-area.ts)
// How much a tool of a size does to one of the reference size, at the full pace of the engines of its construction: as
// much more as it holds more — the bucket of an excavator, the pump of a drill, the arm of a builder, the blade of a
// grader, the screed of a paver —, the square of its size (component-size.ts `componentScale`), as it stands as deep
// across the body at any size (component-volume.ts `componentDepth`). What it asks of those engines grows with it
// (game_geometry.rs `work_power_kw`).
export const toolPace = (piece: SizedComponent): number => componentScale(piece) ** 2;
// Units a second one tool of the reference size extracts so (server/room.ts, `haul`): kilograms of ore an excavator
// digs, as a 20 t excavator such as the Caterpillar 320 loads, and litres of petroleum a drill pumps.
const EXTRACT_RATES: Readonly<Partial<Record<ModuleKind, number>>> = Object.freeze({ excavator: 50, drill: 10 });
export const extractRate = (piece: SizedComponent): number => Number(EXTRACT_RATES[piece.kind]) * toolPace(piece);
// Metres of road a second one road machine of the reference size makes so, of a road as wide as a construction (2.4 m):
// a blade levels natural ground into packed earth as a motor grader of 150 kW such as the Caterpillar 140 does, a metre a
// second, and a paver lays packed earth over with 5 cm of asphalt as a paver of 120 kW such as the Vögele Super 1800-3
// does, half a metre a second — 520 t of mix an hour, of the 700 it is rated for.
const ROAD_RATES: Readonly<Partial<Record<ModuleKind, number>>> = Object.freeze({ blade: 1, paver: .5 });
export const roadRate = (piece: SizedComponent): number => Number(ROAD_RATES[piece.kind]) * toolPace(piece);
export const TRANSFER_RATE = 250;  // units a second moved from an existing pile into one construction's containers
// How near a supply vehicle hands a construction its supplies — rounds, fuel, the material of a repair — or takes them on from
// a heap, in metres between them end to end (construction-site.ts `gap`, of their hulls as they stand, server/field-construction.ts
// `Works.hull`; of a heap, of the pile it makes): as near as a crew hands crates and jerrycans across and runs a fuel hose over from
// a vehicle stopped alongside, and as far as the loader crane of a builder reaches out to a works or a heap (construction-site.ts
// `BUILD_REACH`, 7 m), which it unloads into and loads from the same way. A supply vehicle sent beside another stops the gap of
// its squad off it (squad.ts `GAP`, 3 m), within what counts as there (`ARRIVAL`, 1.5 m): 1.5 to 4.5 m off it, well inside.
export const SUPPLY_REACH = 7;
export const RESUME_DISTANCE = 5;  // metres a construction moves from where its repair was cancelled before one begins by itself again
// Units a second a refinery takes of all that waits in its yard, to make into stock, as a large plant does: 3 600 t of
// ore an hour, as a large concentrator, or 1 000 L of crude a second — some 540 000 barrels a day —, as a large refinery.
export const REFINE_RATE = 1000;
// The refinery of a post (territory.ts) takes a quarter of that: as fast as a hauler takes a load on from a pile
// (`TRANSFER_RATE`), so that what one brings it is refined about as fast as it was loaded, and what more of them bring waits
// in its yard. The refineries of a faction add up: its base and four posts make twice what its base makes.
export const POST_REFINE_RATE = TRANSFER_RATE;
export const STILL_SPEED = .5;     // metres a second under which a construction stands still
// A base is taken by a faction that stands in it, armed and alone, this many seconds (server/room.ts, `besiege`), from
// the day it is founded.
export const CAPTURE_SECONDS = 300;
// A post (territory.ts) is taken the same way, by a faction that stands in it armed and alone (server/room.ts, `besiege`),
// in this many seconds: a post is a smaller place to hold than a base.
export const POST_CAPTURE_SECONDS = 120;
// Of what the faction whose base is taken has above what a faction is founded with, stock by stock, and of what waits in
// its yard, the share that goes to whoever took it (server/room.ts, `fall`).
export const LOOT_SHARE = .25;
// A faction with no base establishes one for this share of each stock a faction is founded with (server/room.ts,
// `recovery`): one that kept those stocks pays for it and still has, of what is left, the ore lorry and the tanker of the catalogue.
export const BASE_SHARE = .25;
// A base whose faction is away is sheltered (server/room.ts, `shelter`) once every member of it has been off the field
// `SHELTER_AWAY` seconds and nothing of it has fought for `SHELTER_CALM` — a capture of its base, or by it, is a fight
// while it lasts —; and no longer than `SHELTER_LONGEST` after the last of them left: a base nobody comes back to does
// not hold its ground for ever.
export const SHELTER_AWAY = 120, SHELTER_CALM = 120, SHELTER_LONGEST = 7 * 24 * 3600;
// Which way a capture goes, a second of it a second: on while its faction stands there alone, nowhere while that is
// contested, and back while its faction stands there no longer.
const CAPTURE_RATES = Object.freeze({ advancing: 1, contested: 0, receding: -1 });
export type CaptureState = keyof typeof CAPTURE_RATES;
export interface Capture { progress: number; at: number; state: CaptureState }
// How far a capture has gone at `time`: as far as it had when it was last looked at (`progress`, at `at`), and on from
// there the way it goes (`state`), up to the `seconds` it takes — of a base, or of a post (`POST_CAPTURE_SECONDS`).
export const captureAt = (capture: Capture, time: number, seconds = CAPTURE_SECONDS): number => clamp(capture.progress + CAPTURE_RATES[capture.state] * (time - capture.at), 0, seconds);
const REPAIR_BASE_SECONDS = 5, REPAIR_CREDITS_PER_SECOND = 500, REPAIR_MAX_SECONDS = 180;
// How long mending so many credits of a construction holds it.
const repairSeconds = (credits: number): number => credits > 0 ? Math.min(REPAIR_MAX_SECONDS, Math.round(REPAIR_BASE_SECONDS + credits / REPAIR_CREDITS_PER_SECOND)) : 0;
// The order a repair that pays for part of the damage mends the pieces in: what gets the construction back to its work first —
// the thrusters of an aircraft with the running gear of a vehicle, for they carry it.
const MEND_RANKS: Readonly<Partial<Record<ModuleKind, number>>> = Object.freeze({ command: 0, engine: 1, wheel: 1, track: 1, thruster: 1, weapon: 2, sensor: 3 }), PLATE_RANK = 5;
// The least of the damage a repair of part of it mends, where it mends no piece whole: less is not worth holding the construction for.
const MEND_LEAST = .1;
// Where the core blows up a magazine that is hit, as a share of its health (game_damage.rs): below it no magazine works.
const MAGAZINE_BURSTS = .38;
// Whether a component that burst works again with `health` mended back into it: as one that was only damaged works, above
// nothing — a magazine from where the core would blow it up.
export const worksAgain = (piece: { kind: ModuleKind; maxHealth: number }, health: number): boolean => piece.kind === 'ammo' ? health >= piece.maxHealth * MAGAZINE_BURSTS - 1e-9 : health > 0;
// How long a construction takes to build at its base, for what it is paid: as long as one wholly destroyed takes to be
// repaired, by what its materials cost. Fuel is poured in, not built, and what a replacement gives back takes no time.
// A structure put up on the field takes as long for one builder of the reference size at the full pace of its engines;
// the builders that work on it go each at its own pace (`toolPace`), all together (server/field-construction.ts).
export const buildSeconds = (cost: Pick<SupplyBill, 'ferro' | 'ligas' | 'silica'>): number => Math.min(REPAIR_MAX_SECONDS,
  Math.round(REPAIR_BASE_SECONDS + (Math.max(0, cost.ferro) + Math.max(0, cost.ligas) + Math.max(0, cost.silica)) / REPAIR_CREDITS_PER_SECOND));

// What a paver lays a metre of road with (`roadRate`), out of the hopper built into it (component-volume.ts `holdsMix`):
// 2.4 m by 5 cm of asphalt, 288 kg of mix, its aggregate in Sílica and the 5 % of bitumen in it, 14 L, in Combustível —
// the mix the core has it carry (`CARGO`), by the stock it is taken from.
export const PAVING = Object.freeze(bill(...STOCK_IDS.map(id => CARGO[SUPPLIED[id]].paving)));
// How many metres of road so much of each stock paves: as far as the scarcer of what a metre takes goes.
export const pavedBy = (amounts: SupplyBill): number => Math.min(...STOCK_IDS.filter(id => PAVING[id] > 0).map(id => Math.max(0, amounts[id]) / PAVING[id]));
// All a bill asks for, whatever it is counted in: nothing when it asks for nothing.
export const billTotal = (amounts: SupplyBill): number => amounts.ferro + amounts.ligas + amounts.silica + amounts.combustivel;
export const billSum = (a: SupplyBill, b: SupplyBill, sign = 1): SupplyBill => bill(a.ferro + sign * b.ferro, a.ligas + sign * b.ligas, a.silica + sign * b.silica, a.combustivel + sign * b.combustivel);
// An amount of each thing dug: what a construction carries, a wreck holds or waits in a yard. Ore is in kilograms, petroleum in litres.
export const load = (ferro = 0, ligas = 0, silica = 0, petroleo = 0): Load => ({ ferro, ligas, silica, petroleo });
export const loadTotal = (amounts: Load): number => amounts.ferro + amounts.ligas + amounts.silica + amounts.petroleo;
// A load of supplies as the stock it is: what it pays with, and what it gives back.
export const supplied = (amounts: CargoLoad): SupplyBill => bill(...STOCK_IDS.map(id => amounts[SUPPLIED[id]]));
// The physical volume of a bill carried as supplies, using the core's ordinary cargo slots and densities.
export const suppliesVolume = (amounts: SupplyBill): number => STOCK_IDS.reduce((sum, id) => sum + amounts[id] * cargoUnitVolume(SUPPLIED[id]), 0);
// Units of this particular mixture that fit in the live free volume. No extra cargo balance or density table.
export function supplySpace(crates: readonly CargoPiece[], stock: SupplyBill): number {
  const volume = suppliesVolume(stock), free = crates.reduce((sum, piece) => sum +
    (piece.health > 0 && piece.attached !== false ? Math.max(0, cargoRoom(piece) - cargoVolume(piece)) : 0), 0);
  return volume > 0 ? billTotal(stock) * free / volume : 0;
}
// A load of what was dug as the stock a refinery makes of it (`YIELD`).
export function refined(amounts: Load): SupplyBill {
  const made = bill();
  for (const id of RAW_IDS) made[REFINED[id]] += amounts[id] * YIELD[id];
  return made;
}
// What a bill weighs, in kilograms: a credit of a material is the kilogram of it a refinery makes of a kilogram of
// ore, and a litre of fuel weighs `FUEL_DENSITY`. A load weighs as the stock it is, or is refined into.
export const FUEL_DENSITY = .84;
export const weight = (amounts: SupplyBill): number => amounts.ferro + amounts.ligas + amounts.silica + FUEL_DENSITY * amounts.combustivel;
// Whole material/currency units, where an operation asks for them: the shares a refinery adds up
// leave it a crumb short of what was brought, and that crumb is not a unit less.
export const stocked = (value: number): number => Math.floor(value + 1e-6);
// The stocks that do not hold what a bill asks of them.
const lacking = (stock: SupplyBill, cost: SupplyBill): StockId[] => STOCK_IDS.filter(id => cost[id] > stock[id] + 1e-6);
const amount = count;
const LITRES: Readonly<Partial<Record<StockId | CargoKind, string>>> = Object.freeze({ combustivel: ' L', petroleo: ' L' });
const fuelAmount = (value: number): string => value > 0 && value < .001 ? '< ' + number(.001, 3) : number(value, 3);
const counted = (id: StockId | CargoKind, value: number): string => (id === 'combustivel' ? fuelAmount(value) : amount(value)) + (LITRES[id] || '');
// A bill in words, each stock it touches by name. What a negative amount gives back is said apart.
export function billText(amounts: SupplyBill, none = tr('nada')): string {
  const said = (sign: number): string => STOCK_IDS.filter(id => (id === 'combustivel' ? amounts[id] * sign : Math.round(amounts[id] * sign)) > 0).map(id => `${tr(STOCKS[id])} ${counted(id, amounts[id] * sign)}`).join(' + '),
    paid = said(1), back = said(-1);
  return paid && back ? tr`${paid} · devolve ${back}` : paid || (back ? tr('devolve ') + back : none);
}
// A load in words: each thing there is some of, by name.
export const loadText = (amounts: CargoLoad, none = tr('nada')): string =>
  RAW_IDS.filter(id => Math.round(Number(amounts[id])) > 0).map(id => `${tr(RAW[id])} ${counted(id, Number(amounts[id]))}`).join(' + ') || none;
// Every stock by name, whatever it holds.
export const stockText = (stock: SupplyBill): string => STOCK_IDS.map(id => `${tr(STOCKS[id])} ${counted(id, stock[id])}`).join(' · ');
// Why a bill cannot be paid, or nothing when it can: each stock that is short, what is asked of it and what it holds.
export function shortMessage(stock: SupplyBill, cost: SupplyBill, what: MessageValue = '') {
  const short = lacking(stock, cost);
  if (!short.length) return null;
  const many = short.length > 1, names = phraseList(short.map(id => phrase(STOCKS[id])), phrase(' e ')),
    prices = phraseList(short.map(id => {
      const price = counted(id, cost[id]), held = counted(id, id === 'combustivel' ? stock[id] : stocked(stock[id]));
      return many ? phrase`${phrase(STOCKS[id])} custa ${price} e a facção tem ${held}` : phrase`custa ${price} e a facção tem ${held}`;
    }), '; '), missing = many ? phrase('Faltam') : phrase('Falta');
  return what ? phrase`${missing} ${names} para ${what}: ${prices}.` : phrase`${missing} ${names}: ${prices}.`;
}
export const shortText = (stock: SupplyBill, cost: SupplyBill, what = ''): string => translate(shortMessage(stock, cost, what) ?? '');
// What filling a construction up is called, by what its bill asks for — rounds, fuel or both —, and what that bill pays for.
export const fillName = (cost: Pick<SupplyBill, 'ferro' | 'combustivel'>): string => cost.ferro > 0 ? cost.combustivel > 0 ? tr('Remuniciar e abastecer') : tr('Remuniciar') : tr('Abastecer');
export const fillThing = (cost: Pick<SupplyBill, 'ferro' | 'combustivel'>): string => cost.ferro > 0 ? cost.combustivel > 0 ? tr('a munição e o combustível') : tr('a munição') : tr('o combustível');
// The same of a bill asked of the supplies a vehicle carries, `whose` they are: each thing short, what there is of it and what is asked.
export function scantMessage(stock: SupplyBill, cost: SupplyBill, what: MessageValue, whose: MessageValue) {
  const short = lacking(stock, cost);
  if (!short.length) return null;
  const prices = phraseList(short.map(id => phrase`${phrase(STOCKS[id])} ${id === 'combustivel' ? fuelAmount(stock[id]) : amount(stocked(stock[id]))} de ${counted(id, cost[id])}`), phrase(' e '));
  return phrase`Os suprimentos ${whose} não pagam ${what}: ${prices}.`;
}
export const scantText = (stock: SupplyBill, cost: SupplyBill, what: string, whose: string): string => translate(scantMessage(stock, cost, what, whose) ?? '');

const priceOf = (groups: PieceCostGroups): number => Object.values(groups).reduce((sum, value) => sum + value, 0);
// An amount lost or owed is counted whole: the part of a credit or of a litre is one.
const whole = (value: number): number => Math.max(0, Math.ceil(value - 1e-6));
const bills = new WeakMap<CompiledConstruction, Readonly<SupplyBill>>(), prices = new WeakMap<CompiledConstruction, Map<string, Readonly<SupplyBill>>>();
// What a compiled design is paid from, by stock. Its fuel is paid in litres of fuel, and only armour and pieces of
// another material than steel from anything else but iron — what they hold apart; pieces of plastic from the fuel, a
// litre for a credit: iron pays whatever the other stocks do not, the reinforcing bar of concrete among it, so that the
// credits of the bill and the price of the fuel are the price of the design, to the credit.
export function designBill(design: CompiledConstruction): Readonly<SupplyBill> {
  if (!bills.has(design)) {
    const built = bill();
    // Armour has no supplies: price each stock together, with per-piece rounding still in Rust, but for what of an
    // armour its stock pays only in part (`OWN_PRICES`).
    for (const stock of STOCK_IDS) if (stock !== 'ferro') {
      const plates = design.plates.filter(piece => stockOf(piece) === stock);
      built[stock] = piecesCost(plates.filter(piece => !partly(piece))) + plates.filter(partly).reduce((sum, plate) => sum + ownCost(plate), 0);
    }
    // A component of another material pays that stock for what of it is of that material: what it holds and what its
    // material does not change (`kept`: the equipment of a sensor or a command post, the rubber and armour of running
    // gear, a steel column) are paid as on a steel one.
    let fuel = 0, litres = 0;
    for (const piece of design.modules) if (stockOf(piece) !== 'ferro') {
      const groups = pieceCostBreakdown(piece);
      built[stockOf(piece)] += priceOf(groups) - (groups.supplies || 0) - (groups.kept || 0);
    }
    for (const piece of design.modules) if (piece.kind === 'fuel') { litres += reserveState(piece).fuelLitres; fuel += pieceCostBreakdown(piece).supplies; }
    const moulded = built.combustivel;
    built.combustivel = moulded + whole(litres);
    built.ferro = constructionCost(design).total - built.ligas - built.silica - moulded - fuel;
    bills.set(design, Object.freeze(built));
  }
  const value = bills.get(design);
  if (!value) throw new Error('Missing construction bill.');
  return value;
}
// What a piece costs, with its load apart, by the stocks that pay it: its own stock what of it is of what it is made of,
// and Ferro the rest — the bar of concrete, and what the material of a component does not change (`kept`).
function paidFor(piece: DesignPiece, groups = pieceCostBreakdown(piece)): SupplyBill {
  const structure = priceOf(groups) - (groups.supplies || 0), paid = bill(), stock = stockOf(piece);
  paid[stock] = partly(piece) ? ownCost(piece) : structure - (groups.kept || 0);
  paid.ferro += structure - paid[stock];
  return paid;
}
// What each piece of a compiled design costs, with its load apart, by the stocks that pay it.
function priced(design: CompiledConstruction): Map<string, Readonly<SupplyBill>> {
  if (!prices.has(design)) prices.set(design, new Map([...design.plates, ...design.modules].map(piece => [piece.id, Object.freeze(paidFor(piece))])));
  const value = prices.get(design);
  if (!value) throw new Error('Missing construction prices.');
  return value;
}
// What pieces are paid with, by stock, as a design pays for them, their rounds with them, in Ferro; the fuel of a tank,
// paid by the litre (`designBill`), is not among it.
export function piecesBill(pieces: readonly DesignPiece[]): SupplyBill {
  const paid = bill();
  for (const piece of pieces) {
    const groups = pieceCostBreakdown(piece), own = paidFor(piece, groups);
    for (const id of STOCK_IDS) paid[id] += own[id];
    if (piece.kind === 'ammo') paid.ferro += groups.supplies || 0;
  }
  return paid;
}

// Where the room of a piece that carries counts: ore in hoppers, petroleum in cisterns, supplies in supply pieces.
const place = (piece: { kind: ModuleKind }): keyof CargoRooms => piece.kind === 'cistern' ? 'liquid' : piece.kind === 'supply' ? 'supplies' : 'solid';
// What a design may carry: cubic metres of ore in its hoppers, litres of petroleum in its cisterns and cubic metres of
// supplies in its supply pieces.
const rooms = new WeakMap<CompiledConstruction, Readonly<CargoRooms>>();
export function designRoom(design: CompiledConstruction): Readonly<CargoRooms> {
  if (!rooms.has(design)) {
    const room = { solid: 0, liquid: 0, supplies: 0 };
    for (const piece of design.modules) if (cargoRoom(piece) > 0) room[place(piece)] += cargoRoom(piece);
    rooms.set(design, Object.freeze({ solid: room.solid, liquid: room.liquid * 1000, supplies: room.supplies }));
  }
  const value = rooms.get(design);
  if (!value) throw new Error('Missing construction cargo room.');
  return value;
}
// That, in a line for whoever draws the design: nothing when it has none of those pieces.
export function roomText(design: CompiledConstruction): string {
  const { solid, liquid, supplies } = designRoom(design);
  return [solid ? tr`${volume(solid)} de minério` : '', liquid ? tr`${litres(Math.floor(liquid))} de petróleo` : '',
    supplies ? tr`${volume(supplies)} de suprimentos` : ''].filter(Boolean).join(' · ');
}
// The hoppers and the cisterns among the pieces of a construction: what hauls what is dug.
export const reservoirsOf = <Piece extends { kind: ModuleKind }>(modules: readonly Piece[]): Piece[] => modules.filter(m => m.kind === 'hopper' || m.kind === 'cistern');
// The supply pieces among them: what takes the stocks of a faction to the front.
export const cratesOf = <Piece extends { kind: ModuleKind }>(modules: readonly Piece[]): Piece[] => modules.filter(m => m.kind === 'supply');
// Whether a piece hauls a thing dug: ore in a hopper, petroleum in a cistern. A supply piece hauls nothing.
export const hauls = (piece: { kind: ModuleKind }, material: CargoKind): boolean => piece.kind !== 'supply' && carries(piece, material);
// Tools extract into the public pile of a site. Containers only carry that pile away.
export const extracts = (piece: { kind: ModuleKind }, material: CargoKind | undefined): boolean => piece.kind === 'excavator' ? material !== undefined && RAW_IDS.includes(material) && material !== 'petroleo'
  : piece.kind === 'drill' && material === 'petroleo';
// What pieces carry in all, and the room their hoppers, their cisterns and their supply pieces have, in cubic metres.
export function carriedBy(pieces: readonly CargoPiece[]): { carried: Load; room: CargoRooms } {
  const carried = load(), room = { solid: 0, liquid: 0, supplies: 0 };
  for (const piece of pieces) {
    room[place(piece)] += cargoRoom(piece);
    for (const id of RAW_IDS) if (piece.cargo && Object.hasOwn(piece.cargo, id)) carried[id] += Number(piece.cargo[id]);
  }
  return { carried, room };
}
// How full a load leaves such room, from 0 to 1: the ore in the hoppers and the petroleum in the cisterns.
export function fillOf(amounts: Load, room: Pick<CargoRooms, 'solid' | 'liquid'>): { solid: number; liquid: number } {
  const used = { solid: 0, liquid: 0 };
  for (const id of RAW_IDS) used[CARGO[id].liquid ? 'liquid' : 'solid'] += amounts[id] * cargoUnitVolume(id);
  return { solid: room.solid ? Math.min(1, used.solid / room.solid) : 0, liquid: room.liquid ? Math.min(1, used.liquid / room.liquid) : 0 };
}
// How full supply pieces are, from 0 to 1: all they carry, crates and cans alike, against all their room.
export function suppliesFill(crates: readonly CargoPiece[]): number {
  const { carried, room } = carriedBy(crates);
  return room.supplies ? Math.min(1, RAW_IDS.reduce((sum, id) => sum + carried[id] * cargoUnitVolume(id), 0) / room.supplies) : 0;
}
// How full the hoppers of pavers are, from 0 to 1: the metres of asphalt the mix they carry paves against the metres they
// hold the mix for.
export function mixFill(pavers: readonly CargoPiece[]): number {
  const room = pavers.reduce((sum, piece) => sum + mixRoom(piece), 0);
  return room ? Math.min(1, pavedBy(supplied(carriedBy(pavers).carried)) / room) : 0;
}
// What a construction tips out of such a load to weigh less: a quarter of what its hoppers hold when full and a quarter
// of what its cisterns do, each thing in the share it is of what they carry, or all of it where they carry no more than that.
const DUMP_SHARE = .25;
export function dumpOf(amounts: Load, room: Pick<CargoRooms, 'solid' | 'liquid'>): Load {
  const fill = fillOf(amounts, room), share = (id: CargoKind): number => { const full = fill[CARGO[id].liquid ? 'liquid' : 'solid']; return full > DUMP_SHARE + 1e-6 ? DUMP_SHARE / full : 1; };
  return load(...RAW_IDS.map(id => amounts[id] * share(id)));
}
// Puts `units` of a material into pieces, each in turn as far as it has room — a paver, as far as its share of the mix of
// the asphalt it lays goes (`mixSpace`) —; a destroyed piece takes no more. With `units` negative, takes them out.
// Returns what each piece touched carries then, by piece, and how much went in or came out.
export function stow<Piece extends CargoPiece>(pieces: readonly Piece[], material: CargoKind, units: number): { changed: Map<Piece, CargoLoad>; moved: number } {
  const changed = new Map<Piece, CargoLoad>();
  let moved = 0;
  for (const piece of pieces) {
    if (moved >= Math.abs(units)) break;
    const held = piece.cargo?.[material] || 0,
      space = units > 0 ? (piece.health > 0 ? (holdsMix(piece) ? mixSpace : cargoSpace)(piece, material) : 0) : held,
      share = Math.min(space, Math.abs(units) - moved);
    if (!(share > 0)) continue;
    changed.set(piece, { ...piece.cargo, [material]: held + Math.sign(units) * share }); moved += share;
  }
  return { changed, moved };
}

// One proportional pickup of finite refined stocks, as far as the total per-vehicle budget and physical room go.
// `carry` applies each real stow before the next material asks for the same volume. Only what entered is debited.
export function gatherSupplies<Piece extends CargoPiece>(stock: SupplyBill, crates: readonly Piece[], budget: number, carry: (changed: Map<Piece, CargoLoad>) => unknown): number {
  const total = billTotal(stock);
  if (!(total > 1e-6) || !(budget > 0)) return 0;
  const share = Math.min(total, budget, supplySpace(crates, stock)) / total;
  let moved = 0;
  for (const id of STOCK_IDS) if (stock[id] > 0) {
    const taken = stow(crates, SUPPLIED[id], stock[id] * share);
    if (!(taken.moved > 0)) continue;
    carry(taken.changed); stock[id] = Math.max(0, stock[id] - taken.moved); moved += taken.moved;
  }
  return moved;
}

// A public pile is shared by vehicles, not by pieces or arrival order. Fill the smallest request first and share
// what remains equally: a nearly full truck releases its unused share to the others in the same operation.
export function sharePile(stock: number, requests: readonly number[]): number[] {
  const shares: number[] = Array(requests.length).fill(0), ordered = requests.map((want, index) => ({ want, index })).sort((a, b) => a.want - b.want);
  let left = Math.max(0, stock);
  for (let i = 0; i < ordered.length; i++) {
    const request = ordered[i];
    if (!request) throw new TypeError('Missing pile request.');
    const share = Math.min(Math.max(0, request.want), left / (ordered.length - i));
    shares[request.index] = share; left -= share;
  }
  return shares;
}

// How much of a piece is left: all of it, none of it, or the share that still stands — of one that burst, what was mended
// of it since (`partialMend`), which the core left at nothing.
function condition(part: FieldPiece | undefined): number {
  if (!part || part.attached === false) return 0;
  if (!part.kind) return part.integrity;
  if (!(part.health > 0)) return 0;
  const health = clamp(part.health / part.maxHealth, 0, 1);
  return part.barrelDisabled ? Math.min(health, .5) : health;
}
// Every piece on the field by its id, read once for all the constructions appraised together.
export function fieldParts(world: { plates: readonly LivePlate[]; modules: readonly SceneModule[] }): FieldParts {
  const parts: FieldParts = new Map();
  for (const plate of world.plates) parts.set(plate.id, plate);
  for (const module of world.modules) parts.set(module.id, module);
  return parts;
}
// A construction as it stands, every amount by stock: what it cost, what dismantling it gives
// back (a whole piece in full, a damaged one a share of what is left, rounds at their price and
// fuel by the litre), what repairing it costs (the value destroyed) and how long that takes, and
// what filling its magazines and tanks costs. An abandoned construction has no whole pieces.
// `levels` is the load it carries, `full` the load it was designed with, by piece: what its hoppers, cisterns,
// supply pieces and pavers carry is among the first and not in the second, for no design comes loaded. `mendable` are the
// pieces a repair that pays for part of the damage may mend (`partialMend`), each with what mending it costs and of what
// stock, in the order they are mended: the components still on the construction, burst or not, and then the plates,
// each whole or not at all (`entire`); a piece blown off waits for a whole repair.
// What dismantling gives back is the price less what was lost, and the loss is what is
// rounded, stock by stock: a construction untouched is worth exactly what was paid for it.
// Capture returns the remaining integrity in full (`damagedShare: 1`); ordinary dismantling keeps its damaged-piece discount.
export function appraise(actor: Pick<SceneActor, 'id' | 'revision' | 'blueprint'>, parts: FieldParts,
  { abandoned = false, damagedShare = DAMAGED_SHARE }: { abandoned?: boolean; damagedShare?: number } = {}): Appraisal {
  const design = actor.blueprint, built = designBill(design), pieces = priced(design), levels: RepairLevels = {}, full: RepairLevels = {}, lost = bill(), repair = bill(), mendable: Appraisal['mendable'] = [],
    // A construction with a piece blown off has no plate mended alone: it is admitted anew for that (room.ts `fix`), which
    // would put that piece back on for nothing.
    loose = [...design.plates, ...design.modules].some(piece => parts.get(`${actor.id}:${actor.revision}:${piece.id}`)?.attached === false);
  let rounds = 0, litres = 0;
  for (const piece of [...design.plates, ...design.modules]) {
    const paid = pieces.get(piece.id), part = parts.get(`${actor.id}:${actor.revision}:${piece.id}`), left = condition(part),
      kept = left >= 1 && !abandoned ? 1 : left * damagedShare;
    if (!paid) throw new Error('Missing piece price.');
    for (const id of STOCK_IDS) if (paid[id]) { lost[id] += paid[id] * (1 - kept); repair[id] += paid[id] * (1 - left); }
    // A piece is mended from the stocks it was paid from: a component from that of its material, and Ferro for what its
    // material does not change (`kept`), in part as far as the scarcest of them pays for it, burst or not; a plate, which may
    // be paid from two, only whole (`entire`).
    const costs: Partial<SupplyBill> = Object.fromEntries(STOCK_IDS.map((id): [StockId, number] => [id, whole((paid[id] || 0) * (1 - left))]).filter(([, cost]) => cost > 0)),
      mend = Object.values(costs).reduce((sum, cost) => sum + cost, 0);
    if (piece.kind && left < 1 && part && part.attached !== false && mend > 0)
      mendable.push({ id: piece.id, stock: stockOf(piece), cost: mend, costs, rank: MEND_RANKS[piece.kind] ?? 4 });
    if (!piece.kind && left < 1 && part && !loose && mend > 0) mendable.push({ id: piece.id, stock: null, cost: mend, costs, entire: true, rank: PLATE_RANK });
    if (piece.kind && (holdsCargo(piece) || holdsMix(piece))) { if (part?.cargo) levels[piece.id] = { cargo: { ...part.cargo } }; continue; }
    if (piece.kind !== 'ammo' && piece.kind !== 'fuel') continue;
    const fuel = piece.kind === 'fuel', key = fuel ? 'fuelLitres' : 'rounds',
      designed = fuel ? reserveState(piece).fuelLitres : reserveState(piece).rounds,
      held = left > 0 && part && usableReserve(part) ? Number(part[key]) : 0, short = Math.max(0, designed - held);
    if (fuel) lost.combustivel += short; else lost.ferro += short * ammunitionCost(piece.ammoPreset, piece.ammoType);
    levels[piece.id] = fuel ? { fuelLitres: held } : { rounds: held };
    if (left > 0 && part && usableReserve(part) && designed > held) {
      if (fuel) litres += short; else rounds += short * ammunitionCost(piece.ammoPreset, piece.ammoType);
      full[piece.id] = fuel ? { fuelLitres: designed } : { rounds: designed };
    }
  }
  const salvage = bill();
  for (const id of STOCK_IDS) { repair[id] = whole(repair[id]); salvage[id] = Math.max(0, built[id] - whole(lost[id])); }
  // Fuel is a continuous liquid inventory: quote the same litres the tank is missing.
  return { built: { ...built }, salvage, repair, rearm: bill(Math.round(rounds), 0, 0, litres),
    seconds: repairSeconds(billTotal(repair)), levels, full, mendable: mendable.sort((a, b) => a.rank - b.rank) };
}
// What a point that does not pay for the whole repair mends of a construction as `quote` appraised it: the pieces it
// may mend, in their order, each as far as what is left of the stocks it is paid from pays for it, in whole units — all
// of it while that lasts, and the share of what it lacks that the scarcest of them pays (`share`, 1 for all of it), each
// paying that share of its part —, and a plate only where what is left pays for all of it (`entire`). Returns those
// pieces, what mending them costs and how long that holds the construction, or nothing when it pays for none of them, or
// mends no piece whole and less than `MEND_LEAST` of the damage.
export function partialMend(quote: { repair: SupplyBill; mendable: readonly MendablePiece[] }, stock: SupplyBill): PartialRepair | null {
  const left = { ...stock }, pieces: RepairPiece[] = [], cost = bill();
  for (const piece of quote.mendable) {
    const costs: Partial<SupplyBill> = piece.costs ?? { [String(piece.stock)]: piece.cost }, keys = Object.keys(costs), ids = keys.filter(stockId);
    // A piece paid from an unknown stock contributes no repair.
    if (ids.length !== keys.length) continue;
    const reach = Math.min(1, ...ids.map(id => stocked(left[id]) / Number(costs[id])));
    if (piece.entire && reach < 1) continue;
    const paid: Partial<SupplyBill> = Object.fromEntries(ids.map(id => [id, reach >= 1 ? costs[id] : Math.min(Number(costs[id]), stocked(reach * Number(costs[id])))])),
      share = Math.min(...ids.map(id => Number(paid[id]) / Number(costs[id])));
    if (!(share > 0)) continue;
    for (const id of ids) { left[id] -= Number(paid[id]); cost[id] += Number(paid[id]); }
    pieces.push({ id: piece.id, share });
  }
  const worth = pieces.some(piece => piece.share >= 1) || billTotal(cost) >= billTotal(quote.repair) * MEND_LEAST;
  return pieces.length && worth ? { pieces, cost, seconds: repairSeconds(billTotal(cost)) } : null;
}
// What `stock` gives of what the magazines and the tanks of a design are short of, as `quote` appraised them: all of
// it where it pays the bill, and otherwise what it pays for — fuel by the actual litres available, and
// rounds as far as its iron goes, by the whole round, piece after piece. Returns the load to set, by piece, what it
// costs and whether that is everything.
export interface ResupplyDesign { modules: readonly Pick<CompiledModule, 'id' | 'kind' | 'ammoPreset' | 'ammoType'>[] }
export function resupply(design: ResupplyDesign, quote: ResupplyQuote, stock: SupplyBill): { levels: RepairLevels; cost: SupplyBill; whole: boolean } {
  const levels: RepairLevels = {}, cost = bill(), short = lacking(stock, quote.rearm);
  let iron = short.includes('ferro') ? stocked(stock.ferro) : Infinity, fuel = Math.max(0, stock.combustivel);
  for (const piece of design.modules) {
    const full = quote.full[piece.id];
    if (!full) continue;
    const key = piece.kind === 'fuel' ? 'fuelLitres' : 'rounds', level = quote.levels[piece.id];
    if (!level) throw new TypeError('Missing reserve level.');
    const held = Number(level[key]), price = piece.kind === 'fuel' ? 1 : ammunitionCost(piece.ammoPreset, piece.ammoType),
      given = piece.kind === 'fuel' ? Math.min(Number(full[key]) - held, fuel) : Math.min(Number(full[key]) - held, Math.floor(iron / price + 1e-9));
    if (!(given > 0)) continue;
    levels[piece.id] = key === 'fuelLitres' ? { fuelLitres: held + given } : { rounds: held + given };
    if (piece.kind === 'fuel') { fuel -= given; cost.combustivel += given; } else { iron -= given * price; cost.ferro += given * price; }
  }
  // Ammunition retains whole-round currency pricing. Fuel costs exactly what was transferred.
  if (!short.includes('ferro')) cost.ferro = quote.rearm.ferro; else cost.ferro = Math.round(cost.ferro);
  return { levels, cost, whole: !short.length };
}
// What a construction takes on as supplies, by stock, into its supply pieces (`crates`): fuel into `FUEL_SHARE` of their
// room, and the three materials into the rest in the shares `mix` has of them — so much of each as fills its share,
// less what they hold of it already —, as far as the pieces that still stand have room, all of it in the same
// measure, and no more of anything than `stock` holds, in whole units.
export function supplyLoad(crates: readonly CargoPiece[], mix: SupplyBill, stock: SupplyBill): SupplyBill {
  let room = 0, free = 0;
  for (const piece of crates) { room += cargoRoom(piece); if (piece.health > 0) free += Math.max(0, cargoRoom(piece) - cargoVolume(piece)); }
  const held = carriedBy(crates).carried, want = bill(), solids = STOCK_IDS.filter(id => !CARGO[SUPPLIED[id]].liquid),
    shares = solids.some(id => mix[id] > 0) ? mix : bill(1),
    each = room * (1 - FUEL_SHARE) / solids.reduce((sum, id) => sum + Math.max(0, shares[id]) * cargoUnitVolume(SUPPLIED[id]), 0);
  for (const id of solids) want[id] = Math.max(0, Math.max(0, shares[id]) * each - held[SUPPLIED[id]]);
  want.combustivel = Math.max(0, room * FUEL_SHARE / cargoUnitVolume(SUPPLIED.combustivel) - held[SUPPLIED.combustivel]);
  const needs = STOCK_IDS.reduce((sum, id) => sum + want[id] * cargoUnitVolume(SUPPLIED[id]), 0), fits = Math.min(1, free / Math.max(1e-12, needs));
  for (const id of STOCK_IDS) want[id] = Math.floor(Math.min(want[id] * fits, stocked(stock[id])) + 1e-6);
  return want;
}
// What `seconds` of a refinery that takes `rate` units a second take of a yard: so many units in all, of each thing in the
// share it has of what waits there. Takes them out of the yard and puts what they make (`YIELD`) into the stocks.
export function refine(yard: Load, stock: SupplyBill, seconds: number, rate = REFINE_RATE): number {
  const waiting = loadTotal(yard), taken = Math.min(waiting, rate * Math.max(0, seconds));
  if (!(taken > 0)) return 0;
  for (const id of RAW_IDS) {
    // The last of a yard goes whole: no crumb of it is left to refine for ever.
    const share = taken >= waiting ? yard[id] : taken * yard[id] / waiting;
    yard[id] -= share; stock[REFINED[id]] += share * YIELD[id];
  }
  return taken;
}
