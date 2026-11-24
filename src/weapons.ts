import { clamp } from './math.ts';
import type { MessageKey } from './message-contract.ts';
import type { ModuleKind } from './materials.ts';

export interface PropellantCharge { readonly value: number; readonly name: MessageKey }
export interface AmmunitionSpec { name: MessageKey; short: MessageKey; detail: MessageKey }
export type Trajectory = 'auto' | 'direct' | 'high' | 'low';
export interface Cartridge { massKg: number; litres: number; costCredits: number }
// The steel of a gun's barrel, which each round heats and the air cools (game_barrel.rs): its mass and length, the
// temperature its manual has it held under (`limitC`), and the heat a round leaves in it at its full charge (`heatJ`;
// a round of another kind may leave its own, `RoundSpec.heatJ`). That heat is the share of its propellant's energy the
// barrel takes: fitted to the manual's firing tables where it has them, and where not, between the 6 % of the M2 and the
// 2.5 % of a 120 mm tank gun by calibre. The limit of an automatic gun is 500 °C: where its manual's barrel changes come
// under this model, 335 to 626 °C, and where steel keeps 78 % of its strength (EN 1993-1-2); that of a gun whose charge
// waits in the chamber, 182 °C, the red line of a howitzer's tube thermometer (FA handbook, ADA134349). A gun without
// steel heats not at all: a launcher, whose propellant and tube are not published.
// A gun that turns several barrels (`barrels`) has that mass among them, each round heating the one it leaves from.
export interface BarrelSteelSpec { massKg: number; lengthM: number; limitC: number; heatJ: number; barrels?: number }
// The bore of a gun, as its round goes down it (game_variant.rs): the chamber its charge burns in, litres, how far down
// the bore the round goes before it leaves, the mass of its charge and of its round, kg. A gun the workshop makes over
// is derived from these: one without them is not made over.
export interface BoreSpec { chamberL: number; travelM: number; propellantKg: number; projectileKg: number }
// How a gun is fed (game_variant.rs `feed_of`): the rounds it holds loaded; a belt the crew changes in `reloadS`, or, of a
// gun that loads a round at a time, by hand or from a magazine an autoloader rams a round from every `cycleS` and the crew
// fills again, `perRoundS` a round; and whether the roof of its compartment is blow-out panels (`vented`). A reference states
// what its own feed holds and takes; a gun made over, all of it.
export interface WeaponFeed { kind?: 'belt' | 'magazine' | 'hand'; rounds: number; reloadS?: number; perRoundS?: number; cycleS?: number; massKg?: number; vented?: boolean }
// What the workshop shows of a gun (game_variant.rs `figures`): what it is; how far its first round goes, m; what its kinetic
// rounds pierce at 500 m and 1 km, or its shaped charge at any range, mm of rolled steel; how wide its burst, m; how fast it
// fires; how hard it is pushed back, N·s; how many rounds on end before its barrel is too hot (none: it does not get so);
// what it weighs and costs; its feed; and the compartment of its ready rounds.
export interface WeaponFigures { family: WeaponFamilyId; rangeM: number; pierceMm: { at500: number; at1000: number } | { any: number } | null;
  blastM?: number | null; rate: number; recoilNs: number | null; roundsToHot: number | null; massKg: number; costCredits: number; feed?: WeaponFeed;
  compartment?: WeaponCompartment | null; rounds?: Partial<Record<AmmoId, RoundFigures>> }
// What the workshop shows of one of a gun's rounds (game_variant.rs `round_figures`): how far it goes; what it pierces at
// 500 m and 1 km, or at any range, mm of rolled steel; how wide it bursts and how far its fragments fly, m; how fast it
// leaves, m/s; and what its cartridge weighs and costs.
export interface RoundFigures { rangeM: number; pierceMm: { at500: number; at1000: number } | { any: number } | null; blastM: number | null;
  fragmentsM: number | null; speed: number; massKg: number | null; costCredits: number | null }
// The compartment of a gun's ready rounds (game_variant.rs `compartment`), turning and running back with it, as high as its
// receiver, holding its belt or its magazine of `rounds`: a belt's can beside the back of the receiver, `besideM` long, and
// what the receiver has no length for `lengthM` behind it; an autoloader's magazine all behind it. None for a gun loaded a
// round at a time. With blow-out panels (`vented`, game_variant.rs `PANEL_STEEL`), what goes off in it goes out through its
// roof and spares its own construction; they and their blast door weigh `panelsKg`.
export interface WeaponCompartment { kind: 'belt' | 'magazine'; rounds: number; lengthM: number; besideM: number; heightM: number; litres: number;
  vented?: boolean; panelsKg?: number }
// How hot a barrel is, °C, as the core tells it (`barrelTemperature`): at its `limitC` a pilot holds its fire; from the
// Draper point (`BARREL_GLOW`) its steel glows, dull red and then, at `BARREL_WHITE`, orange, and wears with every round.
export const BARREL_GLOW = 525, BARREL_WHITE = 900;
// From `BARREL_SHIMMER` the air a barrel heats, rising off it, bends the light through it enough to be seen from the side
// at a glance: what is behind that air shimmers (heat-haze.ts), the more the hotter the steel is over the air, and an enemy
// sees it as well as the glow (server/fog.ts). Closer to the air's warmth the column of hot air is there, but too faint.
export const BARREL_SHIMMER = 150;
// The air at a height, °C, as warm as the standard atmosphere has it, as the core takes it (game_barrel.rs `Air::at`).
export const airTemperature = (height: number): number => 15 - .0065 * height;
export const barrelLimit = (preset: WeaponId | undefined): number => (preset && presetOf(preset)?.steel?.limitC) || Infinity;
const GLOW_FROM = [0x5a, 0x10, 0x06], GLOW_TO = [0xff, 0x8c, 0x2e];
export function barrelGlow(temperature = 0): { color: number; alpha: number } | null {
  if (!(temperature >= BARREL_GLOW)) return null;
  const share = Math.min(1, (temperature - BARREL_GLOW) / (BARREL_WHITE - BARREL_GLOW)),
    [r, g, b] = GLOW_FROM.map((from, i) => Math.round(from + (GLOW_TO[i]! - from) * share));
  return { color: r! << 16 | g! << 8 | b!, alpha: .2 + .6 * share };
}
// A round of a gun made over may weigh otherwise in flight than its first (`mass`), and a shell made otherwise throw its
// fragments otherwise: the share of its burst they carry and how far, in radii of it (game_variant.rs `derive`).
export interface RoundSpec { speed?: number; drag?: number; power?: number; blastRadius?: number; heatJ?: number; cartridge?: Partial<Cartridge>;
  mass?: number; fragments?: number; fragmentReach?: number }
export interface WeaponFamilySpec {
  name: MessageKey; label: MessageKey; caliberMm: number; speed: number; rate: number; spread: number; power: number; mass: number;
  ammo: readonly [AmmoId, ...AmmoId[]]; radius?: number; servoMaxSpeed?: number; charges?: readonly PropellantCharge[];
}
// How a gun's rounds are made (game_variant.rs `Design`), where it fires such a round: what its kinetic round's penetrator
// is of and what share of its projectile it weighs; its shaped charge's cone, % of its calibre, and how far before what it
// strikes it bursts, tenths of the cone's diameter; its shell's explosive, % of its weight. The workshop changes each.
export interface RoundDesign { core?: CoreId; coreShare?: number; cone?: number; standoff?: number; fill?: number }
export type CoreId = 'steel' | 'tungsten';
// The materials a kinetic round's penetrator may be of, as the workshop names them (game_variant.rs `CORES`).
export const CORES = Object.freeze({
  steel: { name: 'Aço', detail: 'mais leve e mais rápido, perfura menos e custa pouco' },
  tungsten: { name: 'Tungstênio', detail: 'mais pesado, perfura muito mais e custa mais' },
} as const) satisfies Record<CoreId, { name: string; detail: string }>;
export interface WeaponPreset extends Omit<WeaponFamilySpec, 'ammo'> {
  family: WeaponFamilyId; ammo?: readonly [AmmoId, ...AmmoId[]]; drag?: number; blastRadius?: number;
  barrel: number; barrelRadius: number; receiver: { length: number; height: number }; recoil: number;
  installedMassKg: number; costCredits: number; cartridge: Cartridge; source: string;
  rounds?: Partial<Record<AmmoId, RoundSpec>>; trajectory?: Trajectory; poweredTrail?: boolean; fragments?: number; fragmentReach?: number;
  design?: RoundDesign;
  recoilCutoff?: { recoil: number; fromDeg: number; toDeg: number }; steel?: BarrelSteelSpec; bore?: BoreSpec;
  // Of a gun made over: the gun it was made of, and the seconds its barrels take to come up to their rate, if they turn.
  // What was changed of it, in the units of `WeaponOptions`: none where it is the gun's own.
  variantOf?: WeaponPresetId; spinUp?: number; made?: { [K in keyof WeaponCustom]-?: number | null };
  feed?: WeaponFeed; figures?: WeaponFigures;
}
export interface WeaponOverrides {
  preset?: WeaponId | undefined; ammo?: AmmoId | undefined; speed?: number | undefined; rate?: number | undefined;
  spread?: number | undefined; power?: number | undefined; mass?: number | undefined; radius?: number | undefined; barrel?: number | undefined;
  platform?: 'vehicle' | 'ground' | undefined; trajectory?: Trajectory | undefined; detonation?: 'airburst' | 'impact' | undefined;
  componentId?: string | null | undefined; aimAngle?: number | undefined; charge?: number | 'auto' | undefined; fuzeTime?: number | undefined;
}
export interface WeaponSettings {
  id: WeaponFamilyId; preset: WeaponId | 'custom'; caliberMm: number; ammo: AmmoId;
  speed: number; drag?: number; rate: number; spread: number; power: number; mass: number; radius: number; barrel: number;
  platform: 'vehicle' | 'ground'; recoilFactor: number; trajectory: Trajectory; detonation: 'airburst' | 'impact'; blastRadius: number; fragmentReach?: number;
  charges: readonly PropellantCharge[]; variableCharge: boolean; charge: number | 'auto'; poweredTrail: boolean; life: number;
  componentId: string | null; aimAngle?: number; fuzeTime?: number;
}
export interface MountedWeapon {
  kind: ModuleKind; id: string; weaponPreset?: WeaponId | undefined; weaponAmmo?: AmmoId | undefined;
  health?: number | undefined; attached?: boolean | undefined;
}
type PresetChoice = WeaponId | 'custom' | null | undefined;

// Longest catalogue fuze and forecast, also followed by game_flight.rs.
export const FLIGHT_HORIZON = 120;

// Shared action vocabulary: relative propellant energy, not shell explosive fill.
// These are sandbox levels; catalogue counts/names follow the real systems.
export const PROPELLANT_LEVELS = Object.freeze([.08, .16, .25, .4, .6, .8, 1] as const);
// Both tuples have the same keys, so each mapped value has its own authored label.
const charges = <const Values extends readonly number[]>(values: Values, names: { readonly [Index in keyof Values]: MessageKey }): readonly PropellantCharge[] =>
  Object.freeze(values.map((value, i) => Object.freeze({ value, name: names[i] as MessageKey })));
const MORTAR_CHARGES = charges([.08, .25, .4, .6, 1], ['Carga 0', 'Carga 1', 'Carga 2', 'Carga 3', 'Carga 4']);
const HOWITZER_CHARGES = charges(PROPELLANT_LEVELS, ['Carga 1', 'Carga 2', 'Carga 3', 'Carga 4', 'Carga 5', 'Carga 6', 'Carga 7']);
const MACS_CHARGES = charges([.16, .4, .6, .8, 1], ['Zona 1', 'Zona 2', 'Zona 3', 'Zona 4', 'Zona 5']);
const FIXED_CHARGE = charges([1], ['Carga fixa']);

// Artillery elevation rates are sandbox tuning, not published rates of the real weapons.
export const WEAPONS = Object.freeze({
  machinegun: { caliberMm: 12.7, name: 'Metralhadora', label: 'Rajadas rápidas · perfurante', mass: .05, speed: 560, rate: 600, spread: 0.30, power: 35, radius: 0.025, ammo: ['ap'] },
  autocannon: { caliberMm: 25, name: 'Canhão automático', label: 'Cadência e impacto', mass: .2, speed: 650, rate: 180, spread: 0.16, power: 155, radius: 0.037, ammo: ['ap', 'he'] },
  cannon: { caliberMm: 120, name: 'Canhão', label: 'Impacto pesado · tiro único', mass: 5, speed: 790, rate: 24, spread: 0.055, power: 430, radius: 0.058, ammo: ['apfsds', 'heat', 'he'] },
  rocket: { caliberMm: 84, name: 'Lançador', label: 'Carga oca e explosão', mass: 2, speed: 145, rate: 35, spread: 0.22, power: 285, radius: 0.07, ammo: ['heat'] },
  grenade: { caliberMm: 40, name: 'Lança-granadas', label: 'Explosões em rajadas', mass: .28, speed: 65, rate: 120, spread: 0.30, power: 95, radius: 0.02, ammo: ['he'] },
  mortar: { servoMaxSpeed: Math.PI / 18, caliberMm: 81, name: 'Morteiro', label: 'Tiro em arco · ataque por cima', mass: 2.2, speed: 72, rate: 14, spread: 0.20, power: 260, radius: 0.041, ammo: ['he'], charges: MORTAR_CHARGES },
  howitzer: { servoMaxSpeed: Math.PI / 30, caliberMm: 105, name: 'Obuseiro', label: 'Artilharia pesada · longo alcance', mass: 8, speed: 110, rate: 6, spread: 0.13, power: 410, radius: 0.053, ammo: ['he'], charges: HOWITZER_CHARGES },
} satisfies Record<string, WeaponFamilySpec>);
export type WeaponFamilyId = keyof typeof WEAPONS;
export const isWeaponFamilyId = (value: unknown): value is WeaponFamilyId => typeof value === 'string' && Object.hasOwn(WEAPONS, value);
// The rounds a gun may be fed (game_projectiles.rs, `Ammo`): a full-calibre armour-piercing round and a long rod
// pierce by their speed, and less as they slow; a shaped charge bursts small where it strikes and its jet pierces
// as much at any range, but spends itself in the air between spaced plates; a high-explosive shell bursts.
export const AMMO = { ap: { name: 'Perfurante', short: 'Perfurante', detail: 'atravessa a blindagem pela força do impacto' },
  apfsds: { name: 'Flecha', short: 'Flecha', detail: 'dardo muito rápido: a que mais perfura, mas perde força com a distância' },
  heat: { name: 'Carga oca', short: 'Carga oca', detail: 'perfura igual a qualquer distância; chapas espaçadas a enfraquecem' },
  he: { name: 'Explosiva', short: 'Explosiva', detail: 'explode no que atinge ou, com espoleta, no ar' } } satisfies Record<string, AmmunitionSpec>;
export type AmmoId = keyof typeof AMMO;
// The ammunition a gun on a vehicle fires: the one it was built to be fed, or the first its feed takes.
export const fedAmmo = (gun?: Pick<MountedWeapon, 'weaponAmmo' | 'weaponPreset'> | null) => gun?.weaponAmmo ?? allowedAmmo(gun?.weaponPreset)[0];
// Rounds that strike by their own motion; the others burst where they strike.
export const KINETIC_AMMO: readonly AmmoId[] = Object.freeze(['ap', 'apfsds']);
// How far from where it goes off a blast harms anything: its radius, and its fragments past it, as far as they fly at
// what stands within four radii of it, or as many more as the case of a shell made otherwise makes them fly
// (`fragmentReach`), twelve metres at most (`reach`, game_pressure.rs).
export const blastReach = (radius: number, fragmentReach = 1) => Math.max(radius, Math.min(radius * 4 * fragmentReach, 12));
// What one round weighs, takes up and costs when the weapon is fed `ammo`: the round's own where `rounds` states
// it, and otherwise the weapon's cartridge (game_weapons.rs, `cartridge`).
export function cartridgeOf(presetId: PresetChoice, ammo?: AmmoId): Cartridge {
  const model: WeaponPreset = presetOf(presetId) || WEAPON_PRESETS.rh120;
  return { ...model.cartridge, ...(ammo === undefined ? undefined : model.rounds?.[ammo]?.cartridge) };
}

// Geometry combines published measurements [S], dimensions derived from them or a maker's drawing [D], and
// estimates from drawings and photos [E]. `barrel` runs from the trunnion, the pivot of the mount, to the muzzle with its
// brake or flash hider; `barrelRadius` is half the outer diameter of the thickest common section of the tube (sleeve,
// jacket, barrel support), within which its brake and fittings are drawn. `receiver` is what stays behind the
// trunnion with the gun at rest, `length` along the bore and `height` across it, and `recoil` how far the gun runs
// back in its cradle when it fires: the room left empty behind the receiver, which turns with the gun about its
// trunnion (`recoilCutoff`: a howitzer that recoils less raised high). A machine gun, a chain gun or an
// autocannon has its trunnion at the front of its receiver, where its cradle holds it; a mortar at the foot of its
// tube; a launcher or a pod at its middle.
// Names, calibres and muzzle speeds are those of the real systems: `speed` is
// the speed of the first round a weapon feeds, at its top charge, and `rounds`
// states the others: where they fly, strike, burst, weigh or cost otherwise. `drag` is no measured coefficient: with the sandbox mass
// of the projectile it carries the round fired from sea level as far as the real one goes (the
// longest range of mortars, howitzers and launchers, the speed a direct round
// keeps at one or two kilometres), in the air that thins as an arc climbs (atmosphere.ts): from the field, some
// 700 m up, a round goes a little further. Rate and projectile mass are rounded presets; installedMassKg estimates the
// complete installation, including its support, rather than the manufacturer's bare weapon weight. `power` is
// what a round pierces, 1.25 for each millimetre of rolled steel it gets through square on (`resistance`,
// game_damage.rs): a shaped charge's calibration target, at any range; a kinetic round's target at the range
// stated beside it, carried back to the muzzle by the square of the speed it keeps there in this flight
// (`commit_air`, game_projectiles.rs). A high-explosive round's `power` is that of its burst.
// `feed` (game_variant.rs `feed_of`): what a gun holds loaded and how its crew reloads it. A belt-fed gun holds its can or
// box: the M2's 100-round can [S, MCWP 3-15.1], the M240's two packs of 100 [S, same], the M249's 200-round box [S, same],
// the Mk 19's 48-round can [S, same], the Bradley's 300 ready rounds of the M242 [S, Northrop Grumman], the Stryker
// Dragoon's 2 × 78 of the Mk44 [S, Northrop Grumman XM813], the Skyranger 35's 252 [S, Rheinmetall]; the Rh202's and the
// M230LF's ready rounds are not published, 300 [E]. No army publishes how long a crew takes to change a belt or upload a
// ready box: 10–20 s for the M2's can (MCWP 3-15.1's loading steps), 15–25 s for the Mk 19's heavier one, some minutes for
// an autocannon's boxes in a turret, 5–10 for a revolver magazine [E]. A gun that loads a round at a time is loaded by
// hand; given a magazine, its autoloader rams a round every `cycleS` — the Leclerc's under 6 s, the K2 at 10 a minute
// [S]; the PzH 2000 three rounds in 10 s [S, KNDS]; the AMOS 16 bombs a minute [S, Patria] — and its crew puts one back
// every `perRoundS`: the PzH 2000's 60 in under 12 min [S], a tank's carousel from outside in 15–30 min for 22 [E].
// https://archive.org/details/MCWP3-15.1 · https://www.knds.com/en/solutions/artillery/pzh-2000
export const WEAPON_PRESETS = Object.freeze({
  // FN's vehicle Minimi is 0.793 m long with a 0.465 m barrel [S]: 0.40 m of it, flash hider and all, stands before
  // the receiver [E], which is 0.39 m long [D] and 0.15 m high with its feed cover [E]. A gas gun, it does not move in
  // its cradle. https://en.wikipedia.org/wiki/FN_Minimi
  // Fed the armour-piercing M995, it pierces 12 mm of rolled steel at 100 m [S].
  // https://www.nammo.com/products/ammunition/small-caliber-ammunition/5-56mm-series/5-56-mm-x-45-armor-piercing-3/
  // Its barrel, as the M249's, weighs 1.84 kg and is 0.521 m long [S]. https://archive.org/stream/DTIC_ADA434693/DTIC_ADA434693_djvu.txt
  // Its M855 burns 1.69 g of WC 844 [S, TM 43-0001-27]; the barrel takes 12 % of its 4 MJ/kg [D]: fitted so that 200
  // rounds in 2 minutes, what FM 3-22.68 calls a hot gun, bring it to the 190–200 °C at which ball powder ignites.
  // https://everyspec.com/ARMY/FM-Field-Manual/FM_3-22--68_JAN2003_13349/
  // Its M855 seats a 4.02 g bullet on 1.69 g of WC 844 [S, TM 43-0001-27, p. 10-17], leaving 1.6 cm³ of the 1.85 cm³ case
  // behind it [D]; the bullet goes 0.483 m down the bore, the barrel less 38 mm of neck and throat [D].
  // Its rounds as made: the SS109's hardened steel penetrator, some 0.6 g of its 4.0 g bullet [E; not published].
  minimi: { family: 'machinegun', name: 'Metralhadora Minimi · 5,56 mm', caliberMm: 5.56, label: 'Leve · rajadas de apoio', speed: 915, drag: .434, rate: 800, spread: 0.32, power: 19, mass: 0.005, barrel: .4, barrelRadius: .0175, receiver: { length: .39, height: .15 }, recoil: 0, steel: { massKg: 1.84, lengthM: .521, limitC: 500, heatJ: 810 }, bore: { chamberL: .0016, travelM: .483, propellantKg: .00169, projectileKg: .00402 }, installedMassKg: 16, costCredits: 1200, cartridge: { massKg: 0.012, litres: 0.009, costCredits: 0.08 }, feed: { rounds: 200, reloadS: 10 }, design: { core: 'steel', coreShare: .15 }, source: 'https://fnherstal.com/app/uploads/sites/2/technical-data-fn-minimi-556-mk3.pdf' },
  // The MAG as a coaxial gun (M240C) is 1.057 m long and 0.165 m high with a 0.551 m barrel [S]: 0.50 m of barrel and
  // flash hider before the receiver [E], 0.56 m of receiver [D]. A gas gun. https://fnamerica.com/?p=2669
  // Fed the armour-piercing M993, it pierces 18 mm of rolled steel at 100 m and 7 mm at 500 m [S].
  // https://www.nammo.com/products/ammunition/small-caliber-ammunition/7-62mm-series/7-62-mm-x-51-armor-piercing-8-m993/
  // Its barrel weighs 3.05 kg and is 0.63 m long [S]; its M80 burns 2.98 g of WC 846 [S, TM 43-0001-27], 12 % of whose
  // energy the barrel takes [D], as the Minimi's. https://fnherstal.com/app/uploads/Technical-Data_fnmag.pdf
  // Its M80 seats a 9.46 g bullet on 2.98 g of WC 846 [S, TM 43-0001-27, p. 11-15], leaving 3.1 cm³ of the 3.64 cm³ case
  // behind it [D]; the bullet goes 0.579 m down the bore, the barrel less 51 mm [D].
  // Its rounds as made: an armour-piercing bullet's hardened steel core, some 40 % of it, as the M61's [E].
  fnmag: { family: 'machinegun', name: 'Metralhadora MAG · 7,62 mm', caliberMm: 7.62, label: 'Uso geral · cartucho 7,62 × 51 mm', speed: 840, drag: .414, rate: 650, spread: 0.25, power: 28, mass: 0.01, barrel: .5, barrelRadius: .02, receiver: { length: .56, height: .165 }, recoil: 0, steel: { massKg: 3.05, lengthM: .63, limitC: 500, heatJ: 1430 }, bore: { chamberL: .0031, travelM: .579, propellantKg: .00298, projectileKg: .00946 }, installedMassKg: 25, costCredits: 1800, cartridge: { massKg: 0.025, litres: 0.016, costCredits: 0.12 }, feed: { rounds: 200, reloadS: 12 }, design: { core: 'steel', coreShare: .4 }, source: 'https://fnherstal.com/en/defence/portable-weapons/fn-mag/' },
  // Northrop Grumman's drawing gives 3.4085 m overall, a receiver and feeder 0.685 m long and 0.392 m high [S]: the
  // muzzle 2.72 m before the receiver [D], the barrel support 0.11 m across [E]; the gun runs back about 3 cm in a
  // soft mount [E]. https://cdn.northropgrumman.com/-/media/wp-content/uploads/Mk44-30mm-Bushmaster-Chain-Gun.pdf
  // Its MK258 Mod 1 APFSDS-T pierces over 100 mm of rolled steel at 1,000 m [S].
  // https://www.nammo.com/products/ammunition/medium-caliber-ammunition/30-mm-series/30mm-x-173-apfsds-t/
  // Its barrel weighs 69.4 kg [S] and is 2.41 m long [S, second hand]; an APFSDS round burns 163 g and the Mk266 HEI-T
  // 148 g of single-base [S], at 3.2 MJ/kg [E], 4.3 % of which the barrel takes [D].
  // https://fbcinc.com/source/Northrop_Resources/30_x_173mm_Full_Ammo_Suite.pdf
  // An APFSDS round sends 220 g on 163 g of propellant [S, KNDS M928]; its case holds some 0.16 L [D, at the 0.95 g/cm³
  // its 150 g rounds are loaded to], and the round goes 2.23 m down the bore, the barrel less 0.18 m of chamber [D].
  // Its rounds as made: a tungsten rod of some 55 % of the 220 g it sends with its sabot, as the DM53's [E]; the 30 x 173 mm
  // HEI-T's 29 g of explosive in 357 g, 8 % (ZVS: https://www.msm.sk/app/uploads/2024/02/zvs-30mm-heit.pdf).
  mk44: { family: 'autocannon', name: 'Canhão Bushmaster II · 30 mm', caliberMm: 30, label: 'Automático · cartucho 30 × 173 mm', ammo: ['apfsds', 'he'], speed: 1430, drag: .069, rounds: { he: { speed: 1080, drag: .292, power: 195, heatJ: 20400, cartridge: { massKg: 0.87, costCredits: 9 } } }, rate: 200, spread: 0.11, power: 148, mass: 0.36, barrel: 2.72, barrelRadius: .055, receiver: { length: .685, height: .392 }, recoil: .03, steel: { massKg: 69.4, lengthM: 2.41, limitC: 500, heatJ: 22400 }, bore: { chamberL: .16, travelM: 2.23, propellantKg: .163, projectileKg: .22 }, installedMassKg: 340, costCredits: 22000, cartridge: { massKg: 0.8, litres: 0.58, costCredits: 16 }, feed: { rounds: 156, reloadS: 300 }, design: { core: 'tungsten', coreShare: .55, fill: 8 }, source: 'https://www.northropgrumman.com/what-we-do/advanced-weapons/armament-systems/bushmaster-chain-guns/30x173mm' },
  // The M2HB is 1.654 m long and 0.193 m high with a 1.143 m barrel [S]: 0.88 m of bare barrel before its support [E],
  // and behind them the support, the receiver and the spade grips, 0.77 m [D]. Its recoiling parts run back about
  // 3 cm [E]. https://fnamerica.com/products/machine-guns/fn-m2hb-qcb
  // Its M2 armour-piercing round pierces 25 mm of rolled steel at 200 m and 19 mm at 500 m [S].
  // https://en.wikipedia.org/wiki/.50_BMG
  // Its barrel weighs 26 lb, 11.79 kg, and is 45 in long [S]; its M33 burns 15.2 g of WC 860 [S, TM 43-0001-27]. Its
  // manual changes the barrel after an hour of rapid fire, over 40 rounds a minute [S]: an hour at 60 brings it to the
  // limit if it takes 6 % of the propellant's energy [D]. https://www.armywriter.com/board/references/TC3-22x50.pdf
  // Its M33 leaves 16.3 cm³ of its case behind the seated bullet [S, second hand], which weighs 42.8 g [E] and goes down
  // the 41.88 in of rifling [S, TC 3-22.50].
  // Its rounds as made: the M2 AP's hardened steel core, some 55 % of its 45.8 g bullet [E; its mass is not published].
  m2hb: { caliberMm: 12.7, family: 'machinegun', name: 'Metralhadora M2 · 12,7 mm', label: 'Pesada · rajadas', speed: 890, drag: .398, rate: 550, spread: 0.18, power: 40, mass: 0.05, radius: 0.018, barrel: .88, barrelRadius: .0225, receiver: { length: .77, height: .193 }, recoil: .03, steel: { massKg: 11.79, lengthM: 1.143, limitC: 500, heatJ: 3650 }, bore: { chamberL: .0163, travelM: 1.064, propellantKg: .0152, projectileKg: .0428 }, installedMassKg: 85, costCredits: 4000, cartridge: { massKg: 0.115, litres: 0.065, costCredits: 0.65 }, feed: { rounds: 100, reloadS: 15 }, design: { core: 'steel', coreShare: .55 }, source: 'https://fnherstal.com/en/blog/the-m2-and-the-m3-50-cal-machine-guns-brothers-but-not-twins/' },
  // Northrop Grumman's drawing gives 2.672 m overall and a receiver and feeder 0.594 m long [S], 0.373 m high [S]: the
  // muzzle 2.08 m before the receiver [D], the barrel support 0.10 m across [E]; about 3 cm of soft-mount travel [E].
  // https://cdn.northropgrumman.com/-/media/wp-content/uploads/M242-25mm-Bushmaster-Chain-Gun.pdf
  // Its M791 APDS-T pierces 25 mm of rolled steel at 60 degrees, 50 mm along its path, at 1,300 m [E: the
  // Army's data sheet as quoted second hand]. https://www.mycity-military.com/uploads2/160397_1368395759_US_vazd_top_mun_2.pdf
  // Its barrel weighs 48.5 kg [S] and is 2.175 m long [S, second hand]; its M919 burns 98 g and its M792 90 g [S, TM
  // 43-0001-27], at 3.9 and 4.0 MJ/kg [E], 4.6 % of which the barrel takes [D].
  // Its M791 sends 132 g [S, General Dynamics] on 98.5 g of propellant [S, second hand: the M792]; its case holds some
  // 0.107 L [D], and the round goes 2.03 m down the bore [D].
  // Its rounds as made: the M791's tungsten penetrator, 102 g of its 132 g [S, second hand: General Dynamics]; the M792's 32 g
  // of explosive in 185 g, 17 % [S, inetres.com].
  m242: { caliberMm: 25, family: 'autocannon', name: 'Canhão Bushmaster · 25 mm', label: 'Automático · alimentação dupla', speed: 1345, drag: .104, rounds: { he: { speed: 1100, drag: .301, power: 155, heatJ: 16600, cartridge: { massKg: 0.5, costCredits: 6 } } }, rate: 200, spread: 0.12, power: 94, mass: 0.2, radius: 0.032, barrel: 2.08, barrelRadius: .05, receiver: { length: .594, height: .373 }, recoil: .03, steel: { massKg: 48.5, lengthM: 2.175, limitC: 500, heatJ: 17600 }, bore: { chamberL: .107, travelM: 2.03, propellantKg: .0985, projectileKg: .132 }, installedMassKg: 260, costCredits: 15000, cartridge: { massKg: 0.46, litres: 0.34, costCredits: 8 }, feed: { rounds: 300, reloadS: 300 }, design: { core: 'tungsten', coreShare: .77, fill: 17 }, source: 'https://www.northropgrumman.com/what-we-do/advanced-weapons/armament-systems/bushmaster-chain-guns/25x137mm' },
  // The Rh202 is 2.612 m long with a 2.002 m barrel [S] and 0.241 to 0.261 m high [S]: the muzzle 1.91 m before a
  // receiver 0.70 m long [E] and 0.25 m high [D]; it runs back about 2 cm, as the 35 mm revolver gun of the same maker
  // does [E]. https://en.wikipedia.org/wiki/Rheinmetall_Mk_20_Rh-202
  // Its armour-piercing DM43 pierces 32 mm of rolled steel square on at 1,000 m [E: a German table as quoted
  // second hand; its maker publishes none]. https://forum.warthunder.com/t/20mm-dm43-penetration/72866/7
  // Its barrel's mass is not published: the M242's, by the square of the calibre and the length, 28.6 kg [D]. A round
  // burns about 55 g [S, the KNDS 20 mm HEI-T], at 3.6 MJ/kg [E], 5 % of which the barrel takes [D].
  // https://backend.knds.com/uploads/20240617_KNDS_Catalogue_munition_20_102_HEI_T_382a05ac5c.pdf
  // Its full-calibre round weighs 134 g [S, second hand]; its case some 0.06 L [D], and the round goes 1.86 m down the
  // bore [D].
  // Its rounds as made: the DM43's hardened steel core, half its 134 g [E]; a 20 mm HEI shell's 10 % of explosive [E].
  rh202: { caliberMm: 20, family: 'autocannon', name: 'Canhão Rh202 · 20 mm', label: 'Automático · alta cadência', speed: 1100, drag: .125, rounds: { he: { speed: 1045, drag: .346, power: 100, cartridge: { massKg: 0.32, costCredits: 3.5 } } }, rate: 1000, spread: 0.16, power: 60, mass: 0.12, barrel: 1.91, barrelRadius: .03, receiver: { length: .7, height: .25 }, recoil: .02, steel: { massKg: 28.6, lengthM: 2.002, limitC: 500, heatJ: 9900 }, bore: { chamberL: .06, travelM: 1.86, propellantKg: .055, projectileKg: .134 }, installedMassKg: 230, costCredits: 10000, cartridge: { massKg: 0.3, litres: 0.22, costCredits: 5 }, feed: { rounds: 300, reloadS: 300 }, design: { core: 'steel', coreShare: .5, fill: 10 }, source: 'https://www.rheinmetall.com/en/products/weapons-and-ammunition/medium-calibre-canonns' },
  // Northrop Grumman gives 2.133 m overall, 0.303 m high, with a 1.524 m barrel [S]: the muzzle 1.53 m before a
  // receiver 0.60 m long [E], the ribbed recoil sleeve 0.09 m across [E].
  // https://cdn.northropgrumman.com/-/media/wp-content/uploads/M230LF-30mm-Bushmaster-Chain-Gun.pdf
  // Its barrel weighs 22.75 kg [S]; how much its M789 burns is not legible in its data sheet: 60 g [D], what gives its
  // muzzle energy at the M792's efficiency, at 4 MJ/kg, 4.3 % of which the barrel takes [D].
  // Its M789 weighs 232.5 g [S, second hand]; its case some 0.065 L [D], and the round goes 1.41 m down the bore [D].
  // Its rounds as made: the M789's some 27 g of PBXN-5 in 232.5 g, 12 % [E].
  m230lf: { caliberMm: 30, family: 'autocannon', name: 'Canhão leve M230 · 30 mm', label: 'Automático leve · granadas explosivas 30 × 113 mm', ammo: ['he'], speed: 805, drag: .287, rate: 200, spread: 0.14, power: 125, mass: 0.24, barrel: 1.53, barrelRadius: .045, receiver: { length: .6, height: .303 }, recoil: .03, steel: { massKg: 22.75, lengthM: 1.524, limitC: 500, heatJ: 10300 }, bore: { chamberL: .065, travelM: 1.41, propellantKg: .06, projectileKg: .2325 }, installedMassKg: 180, costCredits: 13000, cartridge: { massKg: 0.35, litres: 0.25, costCredits: 8 }, feed: { rounds: 300, reloadS: 300 }, design: { fill: 12 }, source: 'https://www.northropgrumman.com/wp-content/uploads/M230LF-30mm-Bushmaster-Chain-Gun.pdf' },
  // The MK35-E (the Wotan 35 of old, 35 × 228 mm at up to 200 rounds a minute) is about 4.26 m long with its airburst
  // unit and 0.48 m high and wide [S]; the 35 mm barrels of its maker are 3.15 m [S]: the muzzle 3.3 m before a
  // receiver 0.95 m long [E]. https://www.rheinmetall.com/Rheinmetall%20Group/brochure-download/Weapon-Ammmunition/B304e0526-MK35-E-electrically-powered-automatic-cannon.pdf
  // What its APFSDS-T pierces is not published: 120 mm of rolled steel at 1,000 m [E], more than the 30 mm MK258
  // pierces with a lighter rod at the same speed. https://www.rheinmetall.com/Rheinmetall%20Group/brochure-download/Weapon-Ammmunition/D251e0721-APFSDS-T-35x228-PMD343-RWMS.pdf
  // Its barrel's mass is not published: the M242's, by the square of the calibre and the length, 138 kg [D]. Its FAPDS
  // burns 376 g and its HEI 330 g of single-base [S], at 3.5 MJ/kg [E], 4 % of which the barrel takes [D].
  // https://mesko.com.pl/en/product/35x228-with-fapds-t-projectile
  // Its APDS weighs 375 g [S, second hand]; its case some 0.40 L [D], and the round goes 2.92 m down the bore [D].
  // Its rounds as made: a tungsten penetrator of some 60 % of its 375 g [E]; a 35 mm HEI-T's some 100 g of explosive in
  // 550 g, 18 % [E].
  mk35: { caliberMm: 35, family: 'autocannon', name: 'Canhão MK35 · 35 mm', label: 'Automático pesado · cartucho 35 × 228 mm', ammo: ['apfsds', 'he'], speed: 1440, drag: .07, rounds: { he: { speed: 1175, drag: .27, power: 240, heatJ: 46200, cartridge: { massKg: 1.55, costCredits: 15 } } }, rate: 200, spread: 0.10, power: 174, mass: 0.55, barrel: 3.3, barrelRadius: .05, receiver: { length: .95, height: .48 }, recoil: .03, steel: { massKg: 138, lengthM: 3.15, limitC: 500, heatJ: 52600 }, bore: { chamberL: .4, travelM: 2.92, propellantKg: .376, projectileKg: .375 }, installedMassKg: 550, costCredits: 31000, cartridge: { massKg: 1.45, litres: 0.95, costCredits: 24 }, feed: { rounds: 252, reloadS: 450 }, design: { core: 'tungsten', coreShare: .6, fill: 18 }, source: 'https://www.rheinmetall.com/en/products/weapons-and-ammunition/medium-calibre-canonns' },
  // The L44 tube is 5.30 m and the gun 5.593 m with its breech ring; it recoils 0.30 m [S]. The L7 of the same length
  // has its trunnion 4.235 m behind the muzzle [S], so 4.25 m before and 1.35 m behind it [D]; the thermal sleeve is
  // 0.23 m across from the tube's 1,190 kg [D], the breech ring 0.46 m high [E]. https://en.wikipedia.org/wiki/M256_(tank_gun)
  // Its DM33 APFSDS pierces 480 mm of rolled steel at 2,000 m, and its DM12A1 shaped charge 480 mm at any
  // range [S]. https://en.wikipedia.org/wiki/120%C3%97570mm_NATO
  // Its DM53 burns 8.9 kg at 4.8 MJ/kg [S], and a shaped charge about 7.1 kg [S, the M830A1]; the tube takes 2.5 % [D]:
  // about 1 MJ a round, what 387 J/mm measured past its forcing cone comes to along it. A round is held under the 182 °C
  // of a howitzer's chamber. https://web.archive.org/web/20070805005735/http://www.defense-update.com/products/digits/120ke.htm
  // Its chamber holds 10.2 L, and the DM53 with its sabot weighs 8.35 kg [S, second hand]; it goes 4.73 m down the bore,
  // the tube less 0.57 m of chamber [D]: so the 1,670 m/s it leaves the L/44 at come to 1,743 from the L/55, of the 1,750
  // published.
  // Its rounds as made: a tungsten rod of some 4.3 kg of the 8.35 kg it sends with its sabot [E]; its shaped charge's cone
  // 4/5 of its calibre, the rule of a liner of the 1940s (Walters, ARL-RP-232) [E], bursting 1.5 cone diameters off, where
  // Sandia's cone of 45° pierces the 5.0 diameters the DM12A1's 480 mm are of it [D]; the DM11's 2.17 kg of explosive in
  // 19 kg, 11 % [S, 120 x 570 mm NATO].
  rh120: { caliberMm: 120, family: 'cannon', name: 'Canhão Rheinmetall · 120 mm', label: 'Canhão de tanque · recarga entre tiros', speed: 1650, drag: .025, rounds: { heat: { speed: 1140, drag: .146, power: 600, blastRadius: .8, heatJ: 820000, cartridge: { massKg: 24, costCredits: 200 } },
    he: { speed: 1140, drag: .146, power: 430, heatJ: 820000, cartridge: { massKg: 27, costCredits: 150 } } }, rate: 6, spread: 0.05, power: 689, mass: 5, radius: 0.058, barrel: 4.25, barrelRadius: .115, receiver: { length: 1.35, height: .46 }, recoil: .3, steel: { massKg: 1190, lengthM: 5.3, limitC: 182, heatJ: 1070000 }, bore: { chamberL: 10.2, travelM: 4.73, propellantKg: 8.9, projectileKg: 8.35 }, installedMassKg: 3000, costCredits: 36000, cartridge: { massKg: 21, litres: 12, costCredits: 260 }, feed: { rounds: 1, cycleS: 6, perRoundS: 45 }, design: { core: 'tungsten', coreShare: .52, cone: 80, standoff: 15, fill: 11 }, source: 'https://www.rheinmetall.com/en/products/weapons-and-ammunition/large-calibre-weapons-and-ammunition' },
  // The AT4 is a tube 1.02 m long [S], about 0.10 m across and 0.12 m over its end caps [E], held at its middle.
  // Recoilless. https://man.fas.org/dod-101/sys/land/at4.htm
  // Its shaped charge pierces 420 mm of rolled steel [S].
  // https://esut.de/en/2019/12/meldungen/ruestung2/17287/saab-at4-lettland-investiert-in-zusaetzliche-panzerabwehr/
  at4: { caliberMm: 84, family: 'rocket', name: 'Lança-rojão AT4 · 84 mm', label: 'Descartável · um tubo novo a cada 10 s', speed: 285, drag: .383, rate: 6, spread: 0.22, power: 525, mass: 2, radius: 0.07, blastRadius: .7, barrel: .55, barrelRadius: .05, receiver: { length: .47, height: .12 }, recoil: 0, installedMassKg: 25, costCredits: 3500, cartridge: { massKg: 6.7, litres: 8, costCredits: 85 }, source: 'https://www.saab.com/products/at4' },
  // The Carl Gustaf M4 is 0.95 m long [S], 0.11 m across its barrel and 0.15 m over its venturi [E], held 0.40 m from
  // its rear [E]. Recoilless. https://en.wikipedia.org/wiki/Carl_Gustaf_8.4_cm_recoilless_rifle
  // Its HEAT 551 pierces 400 mm of rolled steel [S].
  // https://www.globalsecurity.org/military/world/europe/carl-gustaf-specs.htm
  carlgustaf: { caliberMm: 84, family: 'rocket', name: 'Lançador Carl Gustaf · 84 mm', label: 'Sem recuo · recarga manual', ammo: ['heat', 'he'], speed: 255, drag: .413, rate: 6, spread: 0.20, power: 500, mass: 2.3, blastRadius: .7,
    rounds: { he: { power: 320, blastRadius: 2.6, cartridge: { massKg: 3.1, costCredits: 80 } } }, barrel: .55, barrelRadius: .055, receiver: { length: .4, height: .15 }, recoil: 0, installedMassKg: 45, costCredits: 4800, cartridge: { massKg: 3.2, litres: 4, costCredits: 110 }, source: 'https://www.saab.com/globalassets/event/ds/carl-gustaf-m4.pdf' },
  // The Mk 19 is 1.095 m long [S, US Ordnance]. The 0.35 m before the trunnion and 0.20 m receiver height are
  // projection estimates [E]; the remaining 0.745 m behind it is derived [D]. Its 3 cm travel is also estimated [E].
  // It fires 40 rounds a minute sustained and 60 rapid [S]. Its barrel, about 7 kg [E], takes 3.8 % [D] of the 4.64 g
  // of M2 propellant its M430 burns [S, second hand], at 4.52 MJ/kg [S, TM 9-1300-214].
  // https://man.fas.org/dod-101/sys/land/mk19.htm
  // Its charge burns in a cup that vents into the low-pressure chamber behind the grenade, some 25 cm³ [E]; the grenade
  // weighs some 240 g [E] and goes 0.36 m down the bore [D].
  // Its rounds as made: a 40 mm grenade's some 15 % of explosive [E].
  mk19: { caliberMm: 40, family: 'grenade', name: 'Lança-granadas Mk 19 · 40 mm', label: 'Granadas em rajada · arco baixo', speed: 241, drag: .177, rate: 350, spread: 0.30, power: 95, mass: 0.28, barrel: .35, barrelRadius: .03, receiver: { length: .745, height: .2 }, recoil: .03, blastRadius: 1.8, trajectory: 'auto', steel: { massKg: 7, lengthM: .413, limitC: 500, heatJ: 800 }, bore: { chamberL: .025, travelM: .36, propellantKg: .00464, projectileKg: .24 }, installedMassKg: 85, costCredits: 5500, cartridge: { massKg: 0.35, litres: 0.25, costCredits: 5 }, feed: { rounds: 48, reloadS: 20 }, design: { fill: 15 }, source: 'https://www.usord.com/content/docs/datasheets/USORD_MK19-MOD3_40mm_10.17.pdf' },
  // The M224's tube is 1.016 m long [S] and stands on its baseplate, 0.46 m across and 0.15 m thick [S]; the mount
  // gives it 10 cm to settle [E]. https://man.fas.org/dod-101/sys/land/m224.htm
  // It fires 20 rounds a minute sustained and 30 for the first 4 minutes [S]; its M225 tube weighs 6.5 kg [S]. A round
  // at its top charge leaves 5 kJ in it [D]: what brings it to the red line in those 4 minutes, 2.5 % of the propellant
  // its muzzle energy asks for. https://man.fas.org/dod-101/sys/land/m224.htm
  // Its M720 weighs 1.7 kg [S, second hand]; its charges, 43 g at the top [D: its muzzle energy at a gun's 0.28 of its
  // propellant's 4 MJ/kg], burn in some 0.2 L behind the bomb [E], which goes 0.85 m down the tube [E].
  // Its rounds as made: 16 % of explosive, as the 2.5 kg of Composition B of a 15.5 kg mortar bomb (KNDS M530A2) [E].
  m224: { caliberMm: 60, family: 'mortar', name: 'Morteiro M224 · 60 mm', label: 'Leve · cinco cargas', speed: 237, drag: .15, rate: 20, spread: .23, power: 165, mass: 1.5, barrel: 1.02, barrelRadius: .037, receiver: { length: .15, height: .46 }, recoil: .1, blastRadius: 2.4, trajectory: 'auto', steel: { massKg: 6.5, lengthM: 1.016, limitC: 182, heatJ: 5000 }, bore: { chamberL: .2, travelM: .85, propellantKg: .043, projectileKg: 1.7 }, installedMassKg: 45, costCredits: 4000, cartridge: { massKg: 1.9, litres: 1.5, costCredits: 28 }, feed: { rounds: 1, cycleS: 3.75, perRoundS: 10 }, design: { fill: 16 }, source: 'https://www.cpeae.army.mil/Project-Offices/PM-CAS/Organizations/Precision-Fires-Mortars/Products/60MM-M224A1/' },
  // The M252's tube is 1.28 m long [S]; its baseplate 0.50 m across and 0.20 m thick [E]; 10 cm to settle [E].
  // https://en.wikipedia.org/wiki/M252_mortar
  // It fires 15 rounds a minute sustained and 30 for the first 2 minutes [S]; its M253 tube weighs 15.9 kg [S]. A round
  // at its top charge leaves 22.5 kJ in it [D], what brings it to the red line in those 2 minutes.
  // https://www.army.mil/article/139736
  // Its M821 weighs 4.1 kg [S, second hand]; its charges, 117 g at the top [D, as the M224's], burn in some 0.35 L behind
  // the bomb [E], which goes 1.1 m down the tube [E].
  // Its rounds as made: 16 % of explosive, as the 2.5 kg of Composition B of a 15.5 kg mortar bomb (KNDS M530A2) [E].
  m252: { caliberMm: 81, family: 'mortar', name: 'Morteiro M252 · 81 mm', label: 'Médio · cinco cargas', speed: 250, drag: .022, rate: 15, spread: 0.20, power: 260, mass: 2.2, barrel: 1.28, barrelRadius: .05, receiver: { length: .2, height: .5 }, recoil: .1, blastRadius: 3.5, trajectory: 'auto', steel: { massKg: 15.9, lengthM: 1.27, limitC: 182, heatJ: 22500 }, bore: { chamberL: .35, travelM: 1.1, propellantKg: .117, projectileKg: 4.1 }, installedMassKg: 90, costCredits: 6500, cartridge: { massKg: 4.2, litres: 3, costCredits: 45 }, feed: { rounds: 1, cycleS: 3.75, perRoundS: 10 }, design: { fill: 16 }, source: 'https://www.cpeae.army.mil/Project-Offices/PM-CAS/Organizations/Precision-Fires-Mortars/Products/81MM-M252A1/' },
  // The M119A3's tube is 3.20 m long [S] and recoils 0.635 m [S]: the muzzle and its brake 3.0 m before the trunnion,
  // the breech 0.75 m behind it and 0.36 m high [E], the tube 0.18 m across [E].
  // https://www.army.mil/article/171926/picatinny_engineers_modify_m119a3_howitzer_to_make_it_safer_simpler_more_reliable
  // It fires 3 rounds a minute sustained, for half an hour, and 6 for the first 2 minutes [S]. Its cannon weighs 519 kg
  // with its breech and is 33 calibres long [S]; a round of the M67 charge leaves 0.53 MJ in it [D], what brings it to the
  // red line in that half hour. https://man.fas.org/dod-101/sys/land/m119.htm
  // Its M1 shell weighs 15 kg [S, second hand]; the M67 charge some 1.3 kg [E] burns in a case of some 2.75 L [E], and the
  // shell goes 3.07 m down the bore [E].
  // Its rounds as made: the M1's 2.18 kg of TNT in 14.97 kg, 15 % [S, TM 9-1901].
  m119: { caliberMm: 105, family: 'howitzer', name: 'Obuseiro M119 · 105 mm', label: 'Leve · sete cargas e arcos variados', speed: 494, drag: .137, rate: 6, spread: 0.13, power: 410, mass: 8, barrel: 3, barrelRadius: .09, receiver: { length: .75, height: .36 }, recoil: .635, blastRadius: 5.2, trajectory: 'auto', steel: { massKg: 519, lengthM: 3.47, limitC: 182, heatJ: 530000 }, bore: { chamberL: 2.75, travelM: 3.07, propellantKg: 1.3, projectileKg: 15 }, installedMassKg: 2200, costCredits: 23000, cartridge: { massKg: 18, litres: 8, costCredits: 120 }, feed: { rounds: 1, cycleS: 3.3, perRoundS: 12 }, design: { fill: 15 }, source: 'https://www.army.mil/article/102652/Fort_Bragg_first_to_receive_upgraded_M119_howitzers' },
  // The M777's 39-calibre tube is 6.05 m long [S] with a double-baffle brake [S], and its breech sits well forward of
  // the trunnion, which is at the rear of the cradle [S]: 6.8 m from the trunnion to the muzzle, 0.50 m of cradle
  // 0.45 m high behind it [E]; it recoils 1.4 m at its top charge [E, not published]. https://en.wikipedia.org/wiki/M777_howitzer
  // Raised high, it recoils less (`recoilCutoff`), so that its breech does not strike what is under it, as the M198 it
  // replaced does, which runs back from 50 in at low angles to 30 in at high ones [S]: 0.84 m, the same share of the
  // whole [D], from 35 degrees over level, where the cut-off begins, to 55 [E]; between those, as much less as it is
  // raised higher. https://apps.dtic.mil/sti/tr/pdf/ADA123077.pdf
  // It fires 2 rounds a minute sustained and 4 for up to 2 minutes [S]. Its cannon weighs 1,678 kg with its breech [S]; a
  // round of zone 5 leaves 2.09 MJ in it [D]: what brings it to the red line by the M198's table, 4 a minute for 3
  // minutes and then 2 for 30. https://archive.org/stream/DTIC_ADA123077/DTIC_ADA123077_djvu.txt
  // Its chamber holds 18.5 L [S, second hand] and the M203A1 charge 12.7 kg [S, FAS; General Dynamics]; the M795 weighs
  // 46.7 kg [S, second hand] and goes some 5.1 m down the bore [E]: so made L/52 with its 23 L chamber it would fire
  // 930–939 m/s, of the 945 published.
  // Its rounds as made: the M795's 10.8 kg of TNT in 46.7 kg, 23 % [S].
  m777: { caliberMm: 155, family: 'howitzer', name: 'Obuseiro M777 · 155 mm', label: 'Pesado · cinco zonas de carga modular', speed: 827, drag: .0847, rate: 4, spread: .12, power: 560, mass: 12, barrel: 6.8, barrelRadius: .12, receiver: { length: .5, height: .45 }, recoil: 1.4, recoilCutoff: { recoil: .84, fromDeg: 35, toDeg: 55 }, blastRadius: 7.2, trajectory: 'auto', charges: MACS_CHARGES, steel: { massKg: 1678, lengthM: 6.05, limitC: 182, heatJ: 2090000 }, bore: { chamberL: 18.5, travelM: 5.1, propellantKg: 12.7, projectileKg: 46.7 }, installedMassKg: 4200, costCredits: 38000, cartridge: { massKg: 46, litres: 32, costCredits: 225 }, feed: { rounds: 1, cycleS: 3.3, perRoundS: 12 }, design: { fill: 23 }, source: 'https://www.army.mil/article/286160/artillery_charges_improved_at_u_s_army_yuma_proving_ground' },
  // The M261 pod of 19 rockets, 39 kg empty and 237 kg loaded [D], is 1.682 m long and 0.403 m across [S], held at
  // its middle. https://arnolddefense.com/?p=132
  hydra70: { caliberMm: 70, family: 'rocket', name: 'Foguetes Hydra · 70 mm', label: 'Casulo de foguetes · longo alcance', ammo: ['he'], speed: 700, drag: .323, rate: 45, spread: 0.35, power: 330, mass: 3, barrel: .84, barrelRadius: .2, receiver: { length: .84, height: .4 }, recoil: 0, blastRadius: 4, trajectory: 'low', poweredTrail: true, installedMassKg: 230, costCredits: 14000, cartridge: { massKg: 10, litres: 7, costCredits: 90 }, source: 'https://www.gd-ots.com/wp-content/uploads/2017/11/Hydra-70.pdf' },
} satisfies Record<string, WeaponPreset>);
export type WeaponPresetId = keyof typeof WEAPON_PRESETS;
export const isWeaponPresetId = (value: unknown): value is WeaponPresetId => typeof value === 'string' && Object.hasOwn(WEAPON_PRESETS, value);
// A gun of the catalogue, or one made over in the workshop (`weaponVariant`).
const presetOf = (id: PresetChoice): WeaponPreset | undefined => !id || id === 'custom' ? undefined : isWeaponPresetId(id) ? WEAPON_PRESETS[id] : variant(id)?.weapon;
export const weaponOf = (id: PresetChoice): WeaponPreset | undefined => presetOf(id);

// The one gun of the workshop (game_variant.rs): a gun of the catalogue, its reference, named with what was changed of it,
// in a set order and only what differs, `m2hb|L140|D145|C110|P120|R50|N3|M200`: its barrel's length, cm (where none is
// asked, its reference's, as many calibres long at another calibre); its calibre, tenths of a mm; its charge and projectile, % of its reference's at that calibre; its rate, % of the most it gives; how
// many barrels it turns; and how many rounds its feed holds. What it is follows from what it became (`figures.family`).
// Its rounds are named by its reference and what changed of the round alone (`cartridgeId`): a longer barrel fires the
// rounds of the gun it was made of.
export type WeaponVariantId = `${WeaponPresetId}|${string}`;
export type WeaponId = WeaponPresetId | WeaponVariantId;
// What a gun may be made into, as it is now: its barrel from and to what length at its calibre and its reference's, cm;
// the calibres it may be bored to, its barrel kept as many calibres long, and its reference's, tenths of a mm; its charge,
// projectile and rate, % (no rate: it loads a round at a time); how many barrels it may turn; the feeds it may be given and
// its reference's, rounds; whether its compartment may have blow-out panels; and what it is now.
interface ShareRange { min: number; max: number; step: number; base: number }
export interface WeaponOptions { length: { min: number; max: number; base: number }; calibres: number[]; caliber: number;
  charge: ShareRange; projectile: ShareRange; rate: ShareRange | null; barrels: number; feeds: number[]; rounds: number; panels: boolean; family: WeaponFamilyId;
  // How the rounds it fires may be made (game_variant.rs `options`): what its kinetic round's penetrator may be of, by its
  // place among the core's materials from 1, named; its shaped charge's cone, % of its calibre, and standoff, tenths of
  // the cone's diameter; its shell's explosive, % of its weight. None of a round it does not fire.
  core: { choices: number[]; names: CoreId[]; base: number } | null; cone: ShareRange | null; standoff: ShareRange | null; fill: ShareRange | null }
// A gun asked of the workshop, in the units of its options: each the reference's own where it is not asked; blow-out panels
// on its compartment, 1, or none, 0 (a feed with no compartment has none).
export interface WeaponCustom { length?: number; calibre?: number; charge?: number; projectile?: number; core?: number; cone?: number; standoff?: number;
  fill?: number; rate?: number; barrels?: number; magazine?: number; vent?: number }
interface WeaponVariant { id: WeaponId; cartridge: WeaponId; options: WeaponOptions | null; weapon: WeaponPreset }
// The core makes a gun over (`weapon_variant`, lib.rs), and binds that here once it is loaded (native-dynamics.ts), with the
// catalogue the core states guns by (construction-admission.ts `weaponCatalogue`): each request sends the reference as the
// catalogue states it and the kinds of gun it may become. The guns it made are kept by name, and a name it refused as none.
type CatalogueOf = () => Readonly<Record<string, object>>;
let variantCall: ((request: string) => unknown) | undefined, catalogueOf: CatalogueOf | undefined;
const variants = new Map<string, WeaponVariant>(), references = new Map<WeaponPresetId, WeaponVariant | null>();
export function bindWeaponVariants(call: (request: string) => unknown, catalogue: CatalogueOf) { variantCall = call; catalogueOf = catalogue; }
function askCore(base: WeaponPresetId, request: { id: string; calibre?: number } | { custom: WeaponCustom }): WeaponVariant | null {
  if (!variantCall || !catalogueOf) throw new Error('O jogo ainda não terminou de carregar. Recarregue a página.');
  const catalogue = catalogueOf(), families = Object.fromEntries(Object.keys(WEAPONS).map(family => [family, catalogue[family]]));
  let reply: unknown;
  try { reply = variantCall(JSON.stringify({ base: catalogue[base], families, ...request })); }
  catch { return null; }
  const value: unknown = typeof reply === 'string' ? JSON.parse(reply) : null;
  if (!weaponRecord(value) || typeof value.id !== 'string' || typeof value.cartridge !== 'string' || !weaponRecord(value.weapon)) return null;
  // The core of this build states a gun as the catalogue does (`CORE_CONTRACT`): the rounds it may be fed as `allowedAmmo`,
  // and its first alone as `ammo`, which a preset states all of.
  const made = value as unknown as WeaponVariant, allowed = value.weapon.allowedAmmo;
  return Array.isArray(allowed) && allowed.length ? { ...made, weapon: { ...made.weapon, ammo: allowed as unknown as NonNullable<WeaponPreset['ammo']> } } : made;
}
// Of the names it is asked, the guns it made are kept, the latest `KEPT_VARIANTS` of them; a name it refused is asked
// again, so that names from elsewhere fill no memory.
const KEPT_VARIANTS = 512;
function keep(made: WeaponVariant) {
  variants.delete(made.id);
  variants.set(made.id, made);
  if (variants.size > KEPT_VARIANTS) variants.delete(variants.keys().next().value!);
}
function variant(id: string): WeaponVariant | null {
  const known = variants.get(id);
  if (known) return known;
  const base = id.slice(0, id.indexOf('|'));
  const made = id.includes('|') && isWeaponPresetId(base) ? askCore(base, { id }) : null;
  if (made) keep(made);
  return made;
}
export const isWeaponId = (value: unknown): value is WeaponId => isWeaponPresetId(value) || typeof value === 'string' && value.includes('|') && variant(value) !== null;
// The gun of the catalogue a gun was made of, or itself.
export const weaponBase = (id: WeaponId): WeaponPresetId => isWeaponPresetId(id) ? id : (variant(id)?.weapon.variantOf ?? 'rh120');
// The name of the rounds a gun fires, which the boxes that feed it hold (game_variant.rs `cartridge`).
export const cartridgeId = (id: WeaponId): WeaponId => isWeaponPresetId(id) ? id : variant(id)?.cartridge ?? id;
export const isCartridgeId = (value: unknown): value is WeaponId => isWeaponId(value) && cartridgeId(value) === value;
// A reference as the core states it, with what it may be made into and its figures; asked once.
function reference(base: WeaponPresetId): WeaponVariant | null {
  if (!references.has(base)) references.set(base, askCore(base, { id: base }));
  return references.get(base)!;
}
const stated = (id: WeaponId) => isWeaponPresetId(id) ? reference(id) : variant(id);
// What a gun may be made into from where it is; nothing, a gun the workshop does not make over.
export const weaponOptions = (id: WeaponId): WeaponOptions | null => stated(id)?.options ?? null;
// What the workshop shows of a gun (game_variant.rs `figures`).
export const weaponFigures = (id: WeaponId): WeaponFigures | null => stated(id)?.weapon.figures ?? null;
// The gun the workshop makes of `base` as `custom` asks, by its name; none where it may not be made so.
export function weaponVariant(base: WeaponPresetId, custom: WeaponCustom): WeaponId | null {
  const made = askCore(base, { custom });
  if (!made) return null;
  if (!isWeaponPresetId(made.id)) keep(made);
  return made.id;
}
// What the penetrator of a gun's kinetic round is of, as the core names it: none where it may not be made otherwise.
export function coreOf(id: WeaponId): CoreId | null {
  const options = weaponOptions(id)?.core, made = weaponOf(id)?.made?.core;
  if (!options) return null;
  return options.names[options.choices.indexOf(made ?? options.base)] ?? null;
}
// The gun `id` bored to `tenths` of a mm, its barrel kept as many calibres long; none where it may not be made so.
export function weaponBored(id: WeaponId, tenths: number): WeaponId | null {
  const made = askCore(weaponBase(id), { id, calibre: tenths });
  if (!made) return null;
  if (!isWeaponPresetId(made.id)) keep(made);
  return made.id;
}
export const DEFAULT_WEAPON_PRESETS = { machinegun: 'm2hb', autocannon: 'm242', cannon: 'rh120', rocket: 'at4', grenade: 'mk19', mortar: 'm252', howitzer: 'm119' } satisfies Record<WeaponFamilyId, WeaponPresetId>;
// The families as the player picks among them, the lightest first.
export const WEAPON_FAMILIES = Object.freeze([['machinegun', 'Metralhadoras'], ['grenade', 'Lança-granadas'], ['autocannon', 'Canhões automáticos'],
  ['rocket', 'Lançadores'], ['mortar', 'Morteiros'], ['cannon', 'Canhões'], ['howitzer', 'Obuseiros']] satisfies [WeaponFamilyId, MessageKey][]);

// What falls on a place takes its arc by itself ('auto': the high one of a mortar, the low one of the others, and the
// other where the mount refuses that one), and may be held to one of them.
export function allowedTrajectories(id: PresetChoice): Trajectory[] {
  const family = presetOf(id)?.family;
  return family === 'mortar' ? ['auto', 'high', 'low'] : family === 'grenade' || family === 'howitzer' ? ['auto', 'low', 'high', 'direct'] : ['direct', 'low'];
}

export function allowedAmmo(presetId: PresetChoice): readonly [AmmoId, ...AmmoId[]] {
  const model = presetOf(presetId);
  return model ? model.ammo || WEAPONS[model.family].ammo : WEAPONS.cannon.ammo;
}
// How far a gun recoils, in metres, with its bore at `elevation` over the level of its hull, in radians: its whole
// stroke, or, where its recoil is cut off at high angles, from that down to the shorter one over the band of elevation
// it is cut over (game_construction.rs `Stroke`).
export function recoilAt(presetId: PresetChoice, elevation: number) {
  const { recoil = 0, recoilCutoff: cut } = presetOf(presetId) || {};
  if (!cut) return recoil;
  const from = cut.fromDeg * Math.PI / 180, to = cut.toDeg * Math.PI / 180;
  return elevation <= from ? recoil : elevation >= to ? cut.recoil : recoil + (cut.recoil - recoil) * (elevation - from) / (to - from);
}
// How far a bore laid at `angle` in the frame of its construction rises over level, whichever end of it it points to:
// up is positive, straight up a quarter turn (game_construction.rs `elevation`).
export const boreElevation = (angle: number) => Math.atan2(Math.sin(angle), Math.abs(Math.cos(angle)));
// The lowest a bore points turned from `from` to `to`: straight down if it passes it (game_construction.rs `lowest`).
function lowestElevation(from: number, to: number) {
  const down = -Math.PI / 2;
  return down + 2 * Math.PI * Math.ceil((from - down) / (2 * Math.PI)) <= to ? down : Math.min(boreElevation(from), boreElevation(to));
}
// The finest step of a sector over which the breech of a gun that recoils less raised high is reserved as one: a degree.
export const STROKE_STEP = Math.PI / 180;
// The steps of the sector of a gun, `min` to `max` about the axis of its mount, which lies at `axis` in the frame of its
// construction, each as long as the gun recoils at the lowest elevation in it; steps that recoil as far are one
// (game_construction.rs `breech`). A gun that recoils as far at any angle, or one without that axis, has one step.
// Finer steps, `step` wide at most, each as long as the gun recoils within `margin` of it, hold those of the core.
export function recoilSteps(presetId: PresetChoice, axis: number, min: number, max: number, { step = STROKE_STEP, margin = 0 } = {}) {
  const { recoil = 0, recoilCutoff: cut } = presetOf(presetId) || {};
  if (!cut || cut.recoil === recoil || !Number.isFinite(axis) || !(max >= min)) return [{ min, max, stroke: recoil }];
  const count = Math.max(1, Math.ceil((max - min) / step)), steps: { min: number; max: number; stroke: number }[] = [];
  for (let i = 0; i < count; i++) {
    const lo = min + (max - min) * i / count, hi = i + 1 === count ? max : min + (max - min) * (i + 1) / count,
      stroke = recoilAt(presetId, lowestElevation(axis + lo - margin, axis + hi + margin)), last = steps.at(-1);
    if (last?.stroke === stroke) last.max = hi; else steps.push({ min: lo, max: hi, stroke });
  }
  return steps;
}
// The receiver of a weapon as it stands in its mount: `width` along the bore, behind the trunnion, with the compartment of
// its ready rounds at the back of it (game_construction.rs `receiver_dimensions`).
export function weaponMountSize(presetId: PresetChoice) {
  const id = presetOf(presetId) ? presetId as WeaponId : 'rh120', { receiver } = presetOf(id)!;
  return { width: receiver.length + (weaponCompartment(id)?.lengthM ?? 0), height: receiver.height };
}
// The compartment of a gun's ready rounds, as the core states it; none for a gun loaded a round at a time.
export const weaponCompartment = (id: WeaponId): WeaponCompartment | null => weaponFigures(id)?.compartment ?? null;

export function propellantCharges(presetId: PresetChoice) {
  const model = presetOf(presetId), family: WeaponFamilySpec | undefined = model ? WEAPONS[model.family] : undefined;
  return model?.charges || family?.charges || FIXED_CHARGE;
}

// How long a barrel may be, from the trunnion to the muzzle, in metres: the shortest launcher to the longest field
// howitzer (game_geometry.rs `BARREL_REACH`).
export const BARREL_REACH = Object.freeze([0.2, 7.5] as const);
// The fastest round a gun may fire, and the most rounds a minute (game_weapons.rs `MAX_MUZZLE_SPEED`, `MAX_RATE`): the gas
// of a charge pushes no round much past 2 km/s, and a rotary gun turns its barrels up to six thousand a minute.
export const MAX_MUZZLE_SPEED = 2100;
export const MAX_RATE = 6000;
export function weaponSettings(id: WeaponFamilyId = 'cannon', overrides: WeaponOverrides = {}): WeaponSettings {
  const family = isWeaponFamilyId(id) ? id : 'cannon', model = presetOf(overrides.preset),
    modelId = overrides.preset && model?.family === family ? overrides.preset : 'custom';
  // A family named without a preset is of the size of its usual one.
  const preset: WeaponFamilySpec & Partial<WeaponPreset> = { ...WEAPONS[family], ...(modelId === 'custom' ? { barrel: WEAPON_PRESETS[DEFAULT_WEAPON_PRESETS[family]].barrel } : model) },
    ammo = overrides.ammo !== undefined && preset.ammo.includes(overrides.ammo) ? overrides.ammo : preset.ammo[0],
    round = { speed: preset.speed, drag: preset.drag, power: preset.power, blastRadius: preset.blastRadius,
      ...ammo === preset.ammo[0] ? { fragmentReach: preset.fragmentReach } : {}, ...preset.rounds?.[ammo] },
    life = ['mortar', 'howitzer', 'grenade'].includes(family) || preset.poweredTrail ? FLIGHT_HORIZON : 5;
  const levels = preset.charges || FIXED_CHARGE, variableCharge = levels.length > 1,
    automatic = variableCharge && !Number.isFinite(overrides.aimAngle) &&
      (overrides.charge === 'auto' || overrides.charge === undefined),
    requested = typeof overrides.charge === 'number' && Number.isFinite(overrides.charge) ? overrides.charge : 1,
    charge = automatic ? 'auto' : levels.reduce((a, b) =>
      Math.abs(a.value - requested) <= Math.abs(b.value - requested) ? a : b).value;
  return {
    id: family, preset: modelId, caliberMm: preset.caliberMm, ammo,
    speed: clamp(Number(overrides.speed ?? round.speed) || round.speed, 60, MAX_MUZZLE_SPEED),
    ...(round.drag ? { drag: round.drag } : {}),
    rate: clamp(Number(overrides.rate ?? preset.rate) || preset.rate, 4, MAX_RATE),
    spread: clamp(Number(overrides.spread ?? preset.spread) || 0, 0, 3),
    power: clamp(Number(overrides.power ?? round.power) || round.power, 10, 1500),
    mass: clamp(Number(overrides.mass ?? round.mass ?? preset.mass) || 0.05, 0.005, 60),
    radius: clamp(Number(overrides.radius ?? (preset.caliberMm ? preset.caliberMm / 2000 : preset.radius)), 0.001, 0.12),
    barrel: clamp(Number(overrides.barrel ?? preset.barrel), ...BARREL_REACH),
    platform: overrides.platform === 'vehicle' ? 'vehicle' : 'ground',
    recoilFactor: family === 'rocket' ? 0.04 : 1.05,
    trajectory: overrides.trajectory !== undefined && allowedTrajectories(modelId).includes(overrides.trajectory) ? overrides.trajectory : preset.trajectory || 'direct',
    detonation: overrides.detonation === 'airburst' && ammo === 'he' ? 'airburst' : 'impact',
    blastRadius: round.blastRadius || (family === 'rocket' ? 2.6 : family === 'autocannon' ? 0.95 : 1.75),
    // A shell made otherwise throws its fragments as many more radii as its case makes them fly (`blastReach`).
    ...round.fragmentReach ? { fragmentReach: round.fragmentReach } : {},
    charges: levels, variableCharge, charge,
    poweredTrail: preset.poweredTrail === true,
    life,
    componentId: typeof overrides.componentId === 'string' ? overrides.componentId : null,
    // Direct controls express a bearing, charge and fuze; they never change
    // catalogue power, reload, mass or servo limits.
    ...(overrides.aimAngle !== undefined && Number.isFinite(overrides.aimAngle) ? {
      aimAngle: Math.atan2(Math.sin(overrides.aimAngle), Math.cos(overrides.aimAngle)),
      fuzeTime: clamp(Number(overrides.fuzeTime) || 1, .05, life),
    } : {}),
  };
}
// All player commands use this catalog. Tunable values remain private to the
// regression scenes, which call World directly.
export function fixedWeapon(config: WeaponOverrides & { id?: WeaponFamilyId } = {}, modules: readonly MountedWeapon[] = []) {
  const mounted = config.platform === 'vehicle';
  const installed = mounted ? modules.find(m => m.kind === 'weapon' && (!config.componentId || m.id === config.componentId) && m.health !== 0 && m.attached !== false) : null;
  const chosen = mounted ? installed?.weaponPreset : config.preset && isWeaponId(config.preset) ? config.preset : config.id && isWeaponFamilyId(config.id) ? DEFAULT_WEAPON_PRESETS[config.id] : undefined;
  const model = presetOf(chosen) ?? WEAPON_PRESETS.rh120, presetId: WeaponId = chosen && presetOf(chosen) ? chosen : 'rh120';
  return weaponSettings(model.family, { preset: presetId, ammo: mounted ? fedAmmo(installed ?? { weaponPreset: presetId }) : config.ammo, trajectory: config.trajectory, detonation: config.detonation, platform: mounted ? 'vehicle' : 'ground', componentId: installed?.id || config.componentId,
    aimAngle: config.aimAngle, charge: config.charge, fuzeTime: config.fuzeTime });
}

const weaponRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteSetting = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const chargeNames = [...MORTAR_CHARGES, ...HOWITZER_CHARGES, ...MACS_CHARGES, ...FIXED_CHARGE].map(charge => charge.name);
const isPropellantCharge = (value: unknown): value is PropellantCharge => weaponRecord(value) && finiteSetting(value.value) &&
  chargeNames.some(name => name === value.name);
// Native actor controls are validated when their delta arrives, not on every rendered frame.
export function isWeaponSettings(value: unknown): value is WeaponSettings {
  if (!weaponRecord(value) || !isWeaponFamilyId(value.id) || !(value.preset === 'custom' || isWeaponId(value.preset)) ||
      typeof value.ammo !== 'string' || !Object.hasOwn(AMMO, value.ammo)) return false;
  const numeric = ['caliberMm', 'speed', 'rate', 'spread', 'power', 'mass', 'radius', 'barrel', 'recoilFactor', 'blastRadius', 'life'] as const;
  if (!numeric.every(key => finiteSetting(value[key])) ||
      !(['drag', 'aimAngle', 'fuzeTime'] as const).every(key => !Object.hasOwn(value, key) || finiteSetting(value[key]))) return false;
  if (value.platform !== 'vehicle' && value.platform !== 'ground' ||
      value.trajectory !== 'auto' && value.trajectory !== 'direct' && value.trajectory !== 'high' && value.trajectory !== 'low' ||
      value.detonation !== 'airburst' && value.detonation !== 'impact' ||
      typeof value.variableCharge !== 'boolean' || typeof value.poweredTrail !== 'boolean' ||
      value.charge !== 'auto' && !finiteSetting(value.charge) || value.componentId !== null && typeof value.componentId !== 'string') return false;
  if (!Array.isArray(value.charges)) return false;
  const charges: readonly unknown[] = value.charges;
  return charges.every(isPropellantCharge);
}
