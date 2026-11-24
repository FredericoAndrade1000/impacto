import type { PartDefinition } from './part-view.ts';
import type { PlateDefinition } from './mesh.ts';
import type { ConstructionKind } from './chassis-editing.ts';
import type { CompilerResponse } from './construction-contract.ts';
import type { PieceProperty, PiecePropertyValues } from './structured-editing.ts';
import type { AuthoredConstruction, AuthoredComponent, AuthoredPlate, AuthoredChassis, CompiledConstruction, CompiledModule, ChassisPartMetadata, ChassisModelId } from './construction-contract.ts';
import type { MaterialId } from './materials.ts';
import type { WeaponId, AmmoId, CoreId } from './weapons.ts';
import type { Editor } from './editor.ts';
import type { SupplyBill, StockId } from './economy-contract.ts';
import type { SizedComponent } from './component-size.ts';
export type NumericSettingKey = 'angle' | 'axleCount' | 'frameThicknessMm' | 'topPlateThicknessMm' | 'gearScale' | 'suspension' | 'trackLength' | 'trackHeight' | 'trackX' | 'armorMm' | 'thicknessMm' | 'length' | 'sizeScale' | WeaponSettingKey;
// A setting of few values (`stops`, as shown) goes from one to the next, and a typed value rests on the nearest; one that
// also has a grid of its own (`fine`) rests on that, within its range, as a calibre typed between those in common use.
export interface NumericSetting { key: NumericSettingKey; label: string; unit: string; value: number; min: number; max: number; step: number; fine: number; per: number; ends: readonly [string, string]; stops?: readonly number[] }
// What the workshop makes over of a gun (weapons.ts `weaponVariant`): its barrel's length, its calibre, its charge, its
// projectile, how the round it is fed is made — a shaped charge's cone and standoff, a shell's explosive —, how fast it is
// set to fire, how many barrels it turns and how many rounds its feed holds. Each makes it another gun, of one name: they
// are changed on one gun at a time. What its kinetic round's penetrator is of is chosen as a material is (`coreChoices`).
export const WEAPON_SETTINGS = ['barrelLength', 'calibre', 'charge', 'projectile', 'cone', 'standoff', 'fill', 'rate', 'barrels', 'magazine'] as const;
export type WeaponSettingKey = (typeof WEAPON_SETTINGS)[number];
export const isWeaponSetting = (key: string): key is WeaponSettingKey => (WEAPON_SETTINGS as readonly string[]).includes(key);
export interface SharedSetting extends Omit<NumericSetting, 'value'> { value: number | null; each: NumericSetting[]; ids: string[]; range?: [number, number] }
export interface SettingChoice<Id extends string = string> { id: Id; name: string; detail?: string; tag?: string; note?: string; disabled?: boolean }
export interface SettingsPiece { id: string; chassis?: (ChassisPartMetadata & { topPlate?: AuthoredChassis['topPlate'] }) | undefined; material?: MaterialId | undefined; thicknessMm?: number | undefined; length?: number | undefined; angle?: number | undefined }
export type SettingsAuthoring = AuthoredPlate | AuthoredComponent | AuthoredChassis;
export interface SettingsEntry { piece: SettingsPiece; part?: SettingsAuthoring | null }
import { tr, translate, locale } from './i18n.ts';
import { MATERIALS, MATERIAL_NOTES, MATERIAL_ORDER, MATERIAL_TAGS, METALS, takesMetal } from './materials.ts';
import { componentSizeLimits } from './component-size.ts';
import { pieceMass, installedPower } from './mass-properties.ts';
import { pieceCost, piecesCost, formatCredits } from './construction-cost.ts';
import { compatibleWeaponMounts, weaponMountCost, weaponMountSpeed } from './weapon-mounts.ts';
import { RECOVERABLE, compileDraft } from './structured-construction.ts';
import { constructionEditMessage, withPieceProperty } from './structured-editing.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { AMMO, CORES, KINETIC_AMMO, WEAPONS, allowedAmmo, cartridgeOf, coreOf, fedAmmo, weaponBase, weaponBored, weaponFigures, weaponOf, weaponOptions, weaponVariant } from './weapons.ts';
import { feedName, weaponFeed } from './weapon-names.ts';
import { componentVolume } from './component-volume.ts';
import { STOCKS, STOCK_IDS, armourBill, piecesBill } from './economy.ts';
import { CHASSIS_METALS, CHASSIS_MODELS, CHASSIS_GEAR_SCALE, SUSPENSION_REACH, chassisAxles, chassisGearScale,
  chassisLabel, chassisName, chassisSpec, chassisFront, chassisRear, chassisTrack, trackLengthRange,
  frameThicknessMm, frameThicknessRange, skidRange } from './chassis.ts';
import { FIXED, chassisTopPlate, withConstructionKind, withFrameMetal, withChassisTopMaterial } from './chassis-editing.ts';
import { count, distance, number, power, specificPower } from './format.ts';
import { CELL, metresOf, unitsOf } from './grid.ts';

// The settings of the selected pieces, as the bar that floats over them asks for them. Nothing here
// decides what is admitted: a value is proposed to the Editor and the compiler keeps or refuses it.
export const weight = (kg: number) => kg >= 1000 ? number(kg / 1000) + ' t' : count(kg) + ' kg';
// What one round weighs: in grams under a kilogram, as a .50 round would read 0 kg; and what it costs, to the cent
// under 10 credits.
const roundWeight = (kg: number) => kg < 1 ? count(kg * 1000) + ' g' : kg < 10 ? number(kg, 1) + ' kg' : weight(kg);
const roundCost = (credits: number) => formatCredits(credits, credits < 10 ? 2 : 0);
// What a piece weighs and costs, in one line.
export const pieceFigures = (piece: PartDefinition) => weight(pieceMass(piece)) + ' · ' + formatCredits(pieceCost(piece));
// The chassis is selected once, but the price and mass include its whole frame and gear.
export function selectionFigures(compiled: CompiledConstruction, pieces: readonly Pick<PartDefinition, 'id' | 'chassis'>[]) {
  const ids = new Set(pieces.map(piece => piece.id));
  if (pieces.some(piece => 'chassis' in piece && piece.chassis) && compiled.chassis)
    for (const id of [...compiled.chassis.plates, ...compiled.chassis.gear]) ids.add(id);
  const selected = [...compiled.plates, ...compiled.modules].filter(piece => ids.has(piece.id));
  return weight(selected.reduce((sum, piece) => sum + pieceMass(piece), 0)) +
    ' · ' + formatCredits(piecesCost(selected));
}
// What the frame of the chassis of a compiled design and the gear that comes with it weigh and cost, in one line.
function chassisWorth(compiled: CompiledConstruction) {
  const { plates, gear } = compiled.chassis!, frame = compiled.plates.filter(plate => plates.includes(plate.id)),
    wheels = compiled.modules.filter(module => gear.includes(module.id));
  return weight(frame.reduce((sum, plate) => sum + pieceMass(plate), 0) + wheels.reduce((sum, module) => sum + pieceMass(module), 0)) +
    ' · ' + formatCredits(piecesCost([...frame, ...wheels]));
}
// What the chassis of a compiled design comes to, in one line: its length, and what it weighs and costs.
export const chassisFigures = (compiled: CompiledConstruction) => `${number(compiled.chassis!.length, 2)} m · ${chassisWorth(compiled)}`;

// What an engine of a compiled design gives, as its line tells it before its weight and price: its power, and that of
// all the engines of the vehicle for each tonne it weighs with its fuel, its ammunition and its cargo full.
export const enginePower = (compiled: CompiledConstruction, engine: Extract<CompiledModule, { kind: 'engine' }>) => power(engine.powerKw) +
  (compiled.chassis ? ' · ' + specificPower(installedPower(compiled), compiled.chassis.loadedKg / 1000) : '');

// One stepper each: `value`, `min`, `max` and `step` are as shown, `per` of them to one of what the
// project keeps. A press goes a `step`; a typed value rests on the nearest `fine`. `ends` say why a
// press at the lower or the upper end of the range changes nothing.
const setting = (key: NumericSettingKey, label: string, unit: string, value: number, min: number, max: number, step: number, ends: readonly [string, string], { per = 1, fine = 1 } = {}): NumericSetting =>
  ({ key, label, unit, value: Number((value * per).toFixed(6)), min: Number((min * per).toFixed(6)), max: Number((max * per).toFixed(6)), step, fine, per, ends });
// A thruster points one of eight ways, 45° apart (game_construction.rs `THRUSTER_TURN`): its Ângulo goes and rests in
// those steps.
const orientation = (angle: number, step = 5, fine = .01) => setting('angle', tr('Ângulo'), '°', angle, -Math.PI, Math.PI, step,
  [tr('A rotação chegou a −180°.'), tr('A rotação chegou a 180°.')], { per: 180 / Math.PI, fine });
// `piece` is the piece as compiled; `part`, its authored plate or component; the chassis,
// told by the root plate of its frame, is its `chassis` as written. Chassis controls require that authored
// description; plate and placement controls pass null when they have no authored piece.
export function pieceSettings(piece: SettingsPiece | null, part: SettingsAuthoring | null, { snap = true } = {}): NumericSetting[] {
  if (piece?.chassis) {
    // Frame gauge is a different setting from hull plate thickness and gear armour.
    const chassis = part && 'model' in part ? part : piece.chassis;
    if (!('points' in chassis)) throw new TypeError('Os ajustes do chassi precisam da descrição do projeto.');
    const { model } = chassis, { axleRange, armourMm: most, kind } = chassisSpec(model),
      name = tr(chassisName(model)).toLowerCase(), frame = frameThicknessRange(chassis),
      axles = axleRange ? [setting('axleCount', tr('Eixos'), '', chassisAxles(chassis).length, axleRange[0]!, axleRange[1]!, 1,
        [tr`O ${name} leva ao menos ${axleRange[0]} eixos.`, tr`O ${name} leva no máximo ${axleRange[1]} eixos.`])] : [],
      structure = setting('frameThicknessMm', tr('Espessura estrutural'), 'mm', frameThicknessMm(chassis), frame.min, frame.max, 1,
        [tr`A estrutura deste material precisa de ao menos ${number(frame.min)} mm.`, tr`A estrutura deste chassi vai até ${number(frame.max)} mm.`], { fine: .1 }),
      floor = chassis.topPlate ? [setting('topPlateThicknessMm', tr('Espessura do piso'), 'mm', chassis.topPlate.thicknessMm,
        MATERIALS[chassis.topPlate.material].minThicknessMm, 1000, 5,
        [tr('Essa é a menor espessura deste material.'), tr('Uma chapa tem no máximo 1000 mm.')])] : [];
    // An aircraft stands on its skids however high over them its hull is: as high as clears what hangs under it. Their
    // tubes are as large as its gear, slim for a small one; where they stand along it is dragged by their grips.
    if (kind === 'aircraft') {
      const { min, max } = skidRange(chassis);
      return [structure, setting('gearScale', tr('Tamanho dos esquis'), '%', chassisGearScale(chassis), CHASSIS_GEAR_SCALE.min, CHASSIS_GEAR_SCALE.max, 5,
        [tr('Esse é o menor tamanho dos esquis.'), tr('Esse é o maior tamanho dos esquis.')], { per: 100 }),
      setting('suspension', tr('Altura dos esquis'), 'cm', unitsOf(piece.chassis.suspension!), min, max, snap ? CELL * 100 : 1,
        [tr('Os esquis já estão na menor altura.'), tr('Os esquis já estão na maior altura.')], { per: CELL * 100, fine: snap ? CELL * 100 : .1 }), ...floor];
    }
    // Assistance sets the button step; typed track measures always retain their own precision. The track stays on
    // the floor: how high the hull rides over it is the suspension, as over wheels.
    const track = !axleRange && chassisTrack(chassis), step = snap ? CELL : .01,
      trackMeasure = (key: NumericSettingKey, label: string, value: number, min: number, max: number, ends: readonly [string, string]) => setting(key, label, 'm', value, min, max, step, ends, { fine: 0 }),
      suspension = setting('suspension', tr('Altura da suspensão'), 'cm', unitsOf(piece.chassis.suspension!), -SUSPENSION_REACH, SUSPENSION_REACH, snap ? CELL * 100 : 1,
        [tr('Essa é a suspensão mais baixa.'), tr('Essa é a suspensão mais alta.')], { per: CELL * 100, fine: snap ? CELL * 100 : .1 }),
      gear = track ? [
        trackMeasure('trackLength', tr('Comprimento da esteira'), track.rear - track.front, trackLengthRange(chassis)[0]!, trackLengthRange(chassis)[1]!,
          [tr('A esteira chegou ao menor comprimento para essa altura.'), tr('A esteira chegou ao maior comprimento para essa altura.')]),
        trackMeasure('trackHeight', tr('Altura da esteira'), track.height, chassisSpec(model).track! * CHASSIS_GEAR_SCALE.min,
          chassisSpec(model).track! * CHASSIS_GEAR_SCALE.max, [tr('Essa é a menor altura da esteira.'), tr('Essa é a maior altura da esteira.')]),
        trackMeasure('trackX', tr('Posição horizontal'), (track.front + track.rear) / 2,
          chassisFront(chassis) + (track.rear - track.front) / 2, chassisRear(chassis) - (track.rear - track.front) / 2,
          [tr('A esteira chegou à ponta da frente do chassi.'), tr('A esteira chegou à ponta de trás do chassi.')]),
        suspension,
      ] : [
        setting('gearScale', tr('Tamanho de todas as rodas'), '%', chassisGearScale(chassis), CHASSIS_GEAR_SCALE.min, CHASSIS_GEAR_SCALE.max, 5,
          [tr('Esse é o menor tamanho da rodagem.'), tr('Esse é o maior tamanho da rodagem.')], { per: 100 }),
        suspension,
      ];
    return [...axles, structure, ...gear,
      setting('armorMm', tr('Blindagem da rodagem'), 'mm', ('armorMm' in chassis ? chassis.armorMm : undefined) ?? 0, 0, most, 5,
        [tr('A rodagem já está sem blindagem.'), tr`A blindagem da rodagem deste chassi vai até ${most} mm.`]),
      ...floor];
  }
  if (piece?.material) {
    // No plate is thinner than its armour stands as a plate.
    const { name, minThicknessMm: least } = MATERIALS[piece.material],
      stock = metresOf((part && 'ends' in part ? part.ends?.start ?? 0 : 0) + (part && 'ends' in part ? part.ends?.end ?? 0 : 0));
    return [setting('thicknessMm', tr('Espessura'), 'mm', piece.thicknessMm!, least, 1000, 5,
      [tr`Uma chapa de ${name.toLowerCase()} tem ao menos ${least} mm.`, tr('Uma chapa tem no máximo 1000 mm.')]),
      ...(chassisTopPlate(piece.id) ? [] : [setting('length', tr('Comprimento'), 'm', piece.length!, .08 + stock, 12 + stock, snap ? .05 : .01,
        [tr('As juntas precisam ficar a pelo menos 8 cm uma da outra.'), tr('As juntas podem ficar a até 12 m uma da outra.')], { fine: .001 }), orientation(piece.angle ?? 0)])];
  }
  if (!part || !('kind' in part)) return [];
  const settings = [], size = componentSizeLimits(part);
  if (part.kind !== 'weapon' && size.max > size.min) settings.push(setting('sizeScale', tr('Tamanho'), '%', part.sizeScale ?? 1, size.min, size.max, 10,
    [tr('Esse é o menor tamanho da peça.'), tr('Esse é o maior tamanho da peça.')], { per: 100, fine: 5 }));
  if (part.kind === 'weapon') settings.push(...gunSettings(part.weaponPreset ?? 'rh120', snap, fedAmmo(part)));
  settings.push(part.kind === 'thruster' ? orientation(part.pose.angle, 45, 45) : orientation(part.pose.angle));
  return settings;
}
// What a gun may be made into, as it is now, each range as the core gives it (weapons.ts `weaponOptions`). As a gun: its
// barrel, from the shortest to the longest it may have; its calibre, stepping through those in common use and, typed, any
// tenth of a millimetre between the first and the last of them; of a gun that fires by itself, how many barrels it turns
// and how fast it is set to fire. As its rounds: its charge and its projectile; of the round it is fed (`ammo`), a shaped
// charge's cone, % of its calibre, and how many cone diameters off it bursts, or a shell's explosive, % of its weight; and
// how many rounds its belt or magazine holds, stepping through those it may be given.
function gunSettings(id: WeaponId, snap: boolean, ammo: AmmoId): NumericSetting[] {
  const options = weaponOptions(id), made = weaponOf(id)?.made;
  if (!options) return [];
  const { length, calibres, caliber, charge, projectile, rate, barrels, feeds, rounds, cone, standoff, fill } = options, belt = weaponFeed(id)?.kind === 'belt';
  return [
    setting('barrelLength', tr('Cano'), 'm', (made?.length ?? length.base) / 100, length.min / 100, length.max / 100, snap ? .05 : .01,
      [tr('Esse é o cano mais curto desta arma.'), tr('Esse é o cano mais longo desta arma.')], { fine: .01 }),
    ...calibres.length > 1 ? [{ ...setting('calibre', tr('Calibre'), 'mm', (made?.calibre ?? caliber) / 10, calibres[0]! / 10, calibres.at(-1)! / 10, 1,
      [tr('Esse é o menor calibre desta arma.'), tr('Esse é o maior calibre desta arma.')], { fine: .1 }), stops: calibres.map(tenths => tenths / 10) }] : [],
    ...barrels > 1 ? [setting('barrels', tr('Canos'), '', made?.barrels ?? 1, 1, barrels, 1,
      [tr('Uma arma tem ao menos um cano.'), tr`Uma arma rotativa gira até ${barrels} canos.`])] : [],
    ...rate ? [setting('rate', tr('Cadência'), '%', made?.rate ?? 100, rate.min, rate.max, rate.step,
      [tr('Essa é a cadência mais baixa desta arma.'), tr('Essa é a cadência máxima do mecanismo.')], { fine: rate.step })] : [],
    setting('charge', tr('Carga'), '%', made?.charge ?? 100, charge.min, charge.max, charge.step,
      [tr('Essa é a carga mais leve.'), tr('Essa é a carga mais forte que a câmara aguenta.')], { fine: charge.step }),
    setting('projectile', tr('Projétil'), '%', made?.projectile ?? 100, projectile.min, projectile.max, projectile.step,
      [tr('Esse é o projétil mais leve desta arma.'), tr('Esse é o projétil mais pesado desta arma.')], { fine: projectile.step }),
    ...ammo === 'heat' && cone ? [setting('cone', tr('Cone'), '%', made?.cone ?? cone.base, cone.min, cone.max, cone.step,
      [tr('Esse é o menor cone desta carga.'), tr('Esse é o maior cone que o corpo da munição comporta.')], { fine: cone.step })] : [],
    ...ammo === 'heat' && standoff ? [setting('standoff', tr('Afastamento'), tr('× cone'), (made?.standoff ?? standoff.base) / 10, standoff.min / 10,
      standoff.max / 10, standoff.step / 10, [tr('A carga já explode quase encostada no alvo.'), tr('Esse é o maior afastamento: o jato já se desfaz.')],
      { fine: standoff.step / 10 })] : [],
    ...ammo === 'he' && fill ? [setting('fill', tr('Explosivo'), '%', made?.fill ?? fill.base, fill.min, fill.max, fill.step,
      [tr('Esse é o mínimo de explosivo: o resto do corpo é aço.'), tr('Esse é o máximo de explosivo que o corpo aguenta no disparo.')], { fine: fill.step })] : [],
    ...feeds.length > 1 ? [{ ...setting('magazine', belt ? tr('Cinta') : tr('Pente'), tr('tiros'), made?.magazine ?? rounds, feeds[0]!, feeds.at(-1)!, 1,
      belt ? [tr('Essa é a menor cinta desta arma.'), tr('Essa é a maior cinta desta arma.')] : [tr('Esse é o menor pente desta arma.'), tr('Esse é o maior pente desta arma.')],
      { fine: 0 }), stops: feeds }] : [],
  ];
}
// What the bar tells of a gun the workshop makes over, for the player to decide by (weapons.ts `weaponFigures`), in four
// lines: what it is now, how far the round it is fed (`ammo`) reaches and what it pierces, or how wide it bursts and how
// far its fragments fly; how fast it fires, how hard it is pushed back and how many rounds it fires on end before its
// barrel is too hot; how it is fed, and what the piece weighs and costs; and that round, as it is made, how fast it leaves
// and what each weighs and costs. A launcher, which is not made over, is told as any piece: by what it weighs and costs.
export function gunFigures(piece: PartDefinition, id: WeaponId, ammo: AmmoId = allowedAmmo(id)[0]): string[] {
  const figures = weaponFigures(id), feed = weaponFeed(id);
  if (!figures) return [pieceFigures(piece)];
  const { family, rate, recoilNs, roundsToHot } = figures, round = figures.rounds?.[ammo],
    { rangeM, pierceMm } = round ?? figures, blastM = round ? round.blastM : figures.blastM, fragmentsM = round?.fragmentsM,
    seconds = (s: number) => s < 60 ? count(s) + ' s' : number(s / 60) + ' min',
    effect = pierceMm && 'any' in pierceMm ? tr('perfura {0} mm a qualquer distância', count(pierceMm.any))
      : pierceMm ? tr('perfura {0} mm a 500 m e {1} mm a 1 km', count(pierceMm.at500), count(pierceMm.at1000))
        : blastM ? tr('explosão de {0} m', number(blastM)) + (fragmentsM ? ' · ' + tr('estilhaços até {0} m', count(fragmentsM)) : '') : '',
    fed = !feed ? '' : feed.kind === 'belt' ? feedName(feed) + ' · ' + tr('troca em {0}', seconds(feed.reloadS ?? 0))
      : feed.kind === 'magazine' ? feedName(feed) + ' · ' + tr('repõe 1 a cada {0}', seconds(feed.perRoundS ?? 0)) : feedName(feed);
  return [
    [tr(WEAPONS[family].name), tr('alcance {0}', distance(rangeM)), effect].filter(Boolean).join(' · '),
    [tr('{0} tiros/min', count(rate)), recoilNs ? tr('recuo {0}', recoilNs < 1000 ? count(recoilNs) + ' N·s' : number(recoilNs / 1000) + ' kN·s') : '',
      roundsToHot ? tr('esquenta em {0} tiros seguidos', count(roundsToHot)) : tr('não esquenta em rajada')].filter(Boolean).join(' · '),
    [fed, pieceFigures(piece)].filter(Boolean).join(' · '),
    ...round ? [[roundName(id, ammo), tr('sai a {0} m/s', count(round.speed)),
      round.massKg && round.costCredits !== null ? tr('tiro de {0} e {1}', roundWeight(round.massKg), roundCost(round.costCredits)) : ''].filter(Boolean).join(' · ')] : [],
  ];
}
// What a gun's round is, as it is made: its kind, and of a kinetic one what its penetrator is of.
function roundName(id: WeaponId, ammo: AmmoId) {
  const core = KINETIC_AMMO.includes(ammo) ? coreOf(id) : null;
  return core ? tr('{0} de {1}', tr(AMMO[ammo].name), tr(CORES[core].name).toLowerCase()) : tr(AMMO[ammo].name);
}
// The materials the penetrator of a gun's kinetic round may be made of, each with what that round would pierce at 1 km and
// cost (weapons.ts `weaponFigures`): the gun of each is the one it would become (`madeOver`).
export function coreChoices(id: WeaponId): SettingChoice<CoreId>[] {
  const options = weaponOptions(id)?.core, ammo = allowedAmmo(id).find(own => KINETIC_AMMO.includes(own));
  if (!options || !ammo) return [];
  return options.names.map((name, index) => {
    const made = madeOver(id, 'core', options.choices[index]!), round = made ? weaponFigures(made)?.rounds?.[ammo] : null,
      pierced = round?.pierceMm && 'at1000' in round.pierceMm ? tr('perfura {0} mm a 1 km', count(round.pierceMm.at1000)) : '',
      cost = round?.costCredits ? tr('{0} por tiro', roundCost(round.costCredits)) : '';
    return { id: name, name: tr(CORES[name].name), detail: [tr(CORES[name].detail), pierced, cost].filter(Boolean).join(' · '), disabled: !made };
  });
}
// The gun one of these settings makes of `id` at `value`, in its units: the others as they are. None where it may not be made.
// Another calibre keeps the barrel as many calibres long (weapons.ts `weaponBored`). Blow-out panels (`vent`) are 1 or none, 0;
// a feed with no compartment drops them. A penetrator (`core`) is its place among the core's materials, from 1; a standoff
// is told in cone diameters and named in tenths of one. How a round it does not fire would be made is none, 0.
export function madeOver(id: WeaponId, key: WeaponSettingKey | 'vent' | 'core', value: number): WeaponId | null {
  if (key === 'calibre') return weaponBored(id, Math.round(value * 10));
  const options = weaponOptions(id), made = weaponOf(id)?.made;
  if (!options) return null;
  const custom = { length: made?.length ?? options.length.base, calibre: made?.calibre ?? options.caliber, charge: made?.charge ?? 100,
    projectile: made?.projectile ?? 100, core: made?.core ?? options.core?.base ?? 0, cone: made?.cone ?? options.cone?.base ?? 0,
    standoff: made?.standoff ?? options.standoff?.base ?? 0, fill: made?.fill ?? options.fill?.base ?? 0,
    rate: made?.rate ?? 100, barrels: made?.barrels ?? 1, magazine: made?.magazine ?? options.rounds, vent: made?.vent ?? 0 };
  if (key === 'barrelLength') custom.length = Math.round(value * 100);
  else if (key === 'standoff') custom.standoff = Math.round(value * 10);
  else custom[key] = Math.round(value);
  return weaponVariant(weaponBase(id), custom);
}
// The value one press away: the next multiple of the step, whatever the value started on, held to the range.
// Null at the end of the range.
export function steppedSetting({ value, step, min, max, stops }: Pick<NumericSetting, 'value' | 'step' | 'min' | 'max' | 'stops'>, direction: number) {
  if (stops) return (direction < 0 ? [...stops].reverse().find(stop => stop < value - 1e-9) : stops.find(stop => stop > value + 1e-9)) ?? null;
  const next = Math.min(max, Math.max(min, direction < 0 ? Math.ceil(value / step - 1e-9) * step - step : Math.floor(value / step + 1e-9) * step + step));
  return Math.abs(next - value) < 1e-9 ? null : Number(next.toFixed(6));
}
// A typed value within its range: on its fine grid, or continuous when fine is zero; of a setting of few values with no
// grid of its own, the nearest of them. NaN for what is no number.
export function typedSetting({ fine, min, max, stops }: Pick<NumericSetting, 'fine' | 'min' | 'max' | 'stops'>, text: string) {
  const typed = String(text).trim() === '' ? NaN : Number(String(text).replace(',', '.'));
  if (stops && !fine && Number.isFinite(typed)) return stops.reduce((near, stop) => Math.abs(stop - typed) < Math.abs(near - typed) ? stop : near);
  return Number.isFinite(typed) ? Math.min(max, Math.max(min, fine ? Number((Math.round(typed / fine) * fine).toFixed(6)) : typed)) : NaN;
}
// The settings every piece of a selection has, as the bar shows them for all of it: the range takes in that
// of each piece, and the value is the one they share — null when they differ. `each` are the settings of the
// pieces and `ids` the pieces, in the order told. A piece is told as compiled, with the component its author
// wrote; a plate has none.
const combineSettings = (all: NumericSetting[], ids: string[]): SharedSetting => {
  const first = all[0]!;
  return { ...first, min: Math.min(...all.map(own => own.min)), max: Math.max(...all.map(own => own.max)),
    value: all.every(own => own.value === first.value) ? first.value : null, each: all, ids,
    ...(all.length > 1 ? { ends: [tr('Nenhuma das peças selecionadas vai abaixo disso.'), tr('Nenhuma das peças selecionadas vai acima disso.')] } : {}) };
};
// A mixed selection keeps each setting on the pieces that actually own it.
// Thickness belongs to plates, armour to running gear, and size to components.
// A gun is made over alone (`gunSettings`): with other pieces chosen, it keeps the settings it shares with them.
export function selectionSettings(pieces: readonly SettingsEntry[], options: { snap?: boolean } = {}) {
  const groups = new Map<NumericSettingKey, { entry: SettingsEntry; own: NumericSetting }[]>();
  for (const entry of pieces) for (const own of pieceSettings(entry.piece, entry.part ?? null, options)) {
    if (pieces.length > 1 && isWeaponSetting(own.key)) continue;
    if (!groups.has(own.key)) groups.set(own.key, []);
    groups.get(own.key)!.push({ entry, own });
  }
  return [...groups.values()].map(entries => {
    const shared = combineSettings(entries.map(({ own }) => own), entries.map(({ entry }) => entry.piece.id));
    return { ...shared, range: [Math.min(...shared.each.map(own => own.value)), Math.max(...shared.each.map(own => own.value))] as [number, number] };
  });
}
// What a press, or a typed value, asks of each piece of a shared setting: by piece, the values that change,
// as the project keeps them. Each piece steps from the value it has, and rests within its own range.
const asked = (shared: SharedSetting, next: (own: NumericSetting) => number | null) => new Map(shared.each.flatMap((own, index) => {
  const value = next(own);
  return value === null || Number.isNaN(value) || value === own.value ? [] : [[shared.ids[index]!, value / own.per] as const];
}));
export const steppedSettings = (shared: SharedSetting, direction: number) => asked(shared, own => steppedSetting(own, direction));
export const typedSettings = (shared: SharedSetting, text: string) => asked(shared, own => typedSetting(own, text));
// One property of several pieces put to a value for each, as one edit of the document. They are asked of the
// compiler all together first: pieces that grow together stand where each alone would not. Refused
// that, they go one at a time. A piece with no room for its value stays as it
// was; with every one of them refused, the first refusal is thrown.
export function applySettings<K extends PieceProperty>(editor: Editor, key: K, values: ReadonlyMap<string, PiecePropertyValues[K]>) {
  const source = editor.source, ids = [...values.keys()],
    put = (from: AuthoredConstruction, id: string) => withPieceProperty(from, id, key, values.get(id)!), refused: string[] = [],
    admit = (next: AuthoredConstruction) => editor.validateConstruction(next);
  let next, reason;
  try { next = admit(ids.reduce(put, source)); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && RECOVERABLE.includes(error.code))) throw error;
    next = source;
    for (const id of ids) try {
      next = admit(put(next, id));
    } catch (failed) {
      if (!(failed instanceof Error && 'code' in failed && typeof failed.code === 'string' && RECOVERABLE.includes(failed.code))) throw failed;
      reason ||= failed; refused.push(id);
    }
    if (refused.length === ids.length) throw reason;
  }
  editor.change(() => { editor.blueprint = next; });
  return { refused };
}

// The steel of reference a thickness of an armour is worth, in millimetres as they are told: to the tenth
// under ten, where a whole number would make two armours look alike, and whole from there on.
export function steelWorth(thicknessMm: number, material: MaterialId) {
  const mm = thicknessMm * MATERIALS[material].resistance / MATERIALS.steel.resistance;
  return Math.round(mm * 10) < 100 ? mm.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : count(mm);
}
// What credits are paid from which stocks, in words: `first` first if it pays any, then the stock that pays the most.
const paidText = (amounts: SupplyBill, first: StockId | null = null) => STOCK_IDS.filter(id => amounts[id] > 0).sort((a, b) => Number(b === first) - Number(a === first) || amounts[b] - amounts[a])
  .map(id => `${formatCredits(amounts[id])} em ${tr(STOCKS[id])}`).join(tr(' e ')) || formatCredits(0);
// The armours plates may be made of, in the order of the workshop: what these very plates would weigh, be
// worth in steel and cost in each, at the thickness they have, and the stocks that pay it. An armour that does not stand as a plate that
// thin is told at the least thickness of its own, which the plate takes with it. Plates of several thicknesses
// are told by weight and cost alone. `fixed` says the construction does not drive: only such a one may be made
// of concrete.
export function materialChoices(plates: readonly PlateDefinition[], fixed = false) {
  const faces = plates.map(plate => pieceMass(plate) / MATERIALS[plate.material].density / plate.thicknessMm),
    thin = plates[0]!.thicknessMm, alike = plates.every(plate => plate.thicknessMm === thin);
  return MATERIAL_ORDER.filter(id => fixed || !('fixed' in MATERIALS[id] && MATERIALS[id].fixed)).map(id => {
    const mm = Math.max(thin, MATERIALS[id].minThicknessMm),
      each = plates.map((plate, index) => faces[index]! * Math.max(plate.thicknessMm, MATERIALS[id].minThicknessMm) * MATERIALS[id].density);
    return { id, name: tr(MATERIALS[id].name), tag: tr(MATERIAL_TAGS[id]), note: tr(MATERIAL_NOTES[id]),
      detail: `${alike && mm > thin ? tr`com ${count(mm)} mm · ` : ''}${weight(each.reduce((sum, kg) => sum + kg, 0))}${alike ? tr` · ≈ ${steelWorth(mm, id)} mm de aço` : ''} · ` +
        paidText(armourBill(id, each)) };
  });
}

// A piece or a batch of components, with aggregate mass and price. Compile once per material, independent of the number
// selected; previews never edit the document. A batch is offered every material one of its pieces may be made of, and
// each goes to the pieces that may: what they would weigh and cost is told, and how many of the batch they are. The price
// is told by the stocks that pay it (`piecesBill`): that of the material for what of them is of it, and Ferro for what
// it does not change — the equipment of a sensor or a command post, a steel column — and for their rounds.
export function metalChoices(source: AuthoredConstruction, part: AuthoredComponent | readonly AuthoredComponent[]) {
  const parts: readonly AuthoredComponent[] = 'kind' in part ? [part] : part;
  return Object.values(METALS).filter(metal => parts.some(part => takesMetal(part, metal.id))).map(metal => {
    const choice: SettingChoice = { id: metal.id, name: tr(metal.name), tag: tr(metal.tag) },
      taking = parts.filter(part => takesMetal(part, metal.id)), ids = new Set(taking.map(part => part.id));
    try {
      const fit: CompilerResponse = compileDraft(taking.reduce((next, part) => withPieceProperty(next, part.id, 'metal', metal.id), source)),
        made = fit.compiled.modules.filter(module => ids.has(module.id));
      choice.detail = tr`${weight(made.reduce((sum, part) => sum + pieceMass(part), 0))} · vida ${Math.round(metal.health * 100)} % · ${paidText(piecesBill(made), metal.stock)}` +
        (taking.length < parts.length ? tr` · em ${taking.length} de ${parts.length} componentes` : '');
      if (!fit.compiled.mechanicalAdmission) choice.detail += tr(' · capacidade pendente');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && RECOVERABLE.includes(error.code))) throw error;
      choice.disabled = true; choice.detail = constructionEditMessage(error, { quiet: true });
    }
    return choice;
  });
}

// What a construction is made as, on wheels, on tracks, as an aircraft or fixed in its place, each evaluated by the same
// construction compiler: what the chassis would carry — an aircraft, what its thrusters hold up —, or why it cannot be.
export const kindChoices = (source: AuthoredConstruction) => ([...Object.keys(CHASSIS_MODELS).filter((id): id is ChassisModelId => Object.hasOwn(CHASSIS_MODELS, id)), FIXED] satisfies ConstructionKind[]).map(id => {
  const choice: SettingChoice<ConstructionKind> = { id, name: id === FIXED ? tr('Fixa') : tr(chassisLabel(id)) };
  try {
    const made: CompiledConstruction = compileDraft(withConstructionKind(source, id)).compiled;
    if (!made.vehicle.enabled) choice.detail = tr('Sem chassi: fica no lugar e aceita concreto');
    else {
      choice.detail = tr`Cheio: ${weight(made.chassis!.loadedKg)} · limite: ${weight(made.chassis!.limitKg)} · ${chassisWorth(made)}`;
      if (!made.mechanicalAdmission) choice.detail += tr(' · capacidade pendente');
    }
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && RECOVERABLE.includes(error.code))) throw error;
    choice.disabled = true; choice.detail = constructionEditMessage(error, { quiet: true });
  }
  return choice;
});

// One material changes the structure and all its running gear. Preview the
// actual combined mass, cost and capacity, without redesigning its support. The price is told by the stocks that pay
// it: that of its metal first, and Ferro for the rubber and the armour of the gear and for a floor of steel.
export const chassisMetalChoices = (source: AuthoredConstruction) => CHASSIS_METALS.map(id => {
  const choice: SettingChoice = { id, name: tr(METALS[id].name) };
  try {
    const fit: CompilerResponse = compileDraft(withFrameMetal(source, id)), made = fit.compiled,
      chassis = [...made.plates.filter(plate => made.chassis!.plates.includes(plate.id)), ...made.modules.filter(part => made.chassis!.gear.includes(part.id))];
    choice.detail = tr`${weight(chassis.reduce((sum, piece) => sum + pieceMass(piece), 0))} · ${paidText(piecesBill(chassis), METALS[id].stock)} · limite: ${weight(made.chassis!.limitKg)}`;
    if (!made.mechanicalAdmission) choice.detail += tr(' · capacidade pendente');
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && RECOVERABLE.includes(error.code))) throw error;
    choice.disabled = true; choice.detail = constructionEditMessage(error, { quiet: true });
  }
  return choice;
});

// Each material is previewed by the compiler so the extra plate's bends, true mass and price have one authority.
export const topPlateChoices = (source: AuthoredConstruction) => [{ id: 'none', name: tr('Sem piso do chassi'), detail: tr('Mantém a armação; compartimentos que dependem deste piso ficam abertos.') },
  ...MATERIAL_ORDER.filter(id => !('fixed' in MATERIALS[id] && MATERIALS[id].fixed)).map(id => {
    const choice: SettingChoice = { id, name: tr(MATERIALS[id].name), tag: tr(MATERIAL_TAGS[id]) };
    try {
      const made: CompilerResponse = compileDraft(withChassisTopMaterial(source, id)),
        plates = made.compiled.plates.filter(plate => plate.id.startsWith('chassis:top-'));
      choice.detail = `${count(made.construction.chassis!.topPlate!.thicknessMm)} mm · ${weight(plates.reduce((sum, plate) => sum + pieceMass(plate), 0))} · ${formatCredits(piecesCost(plates))}`;
      if (!made.compiled.mechanicalAdmission) choice.detail += tr(' · capacidade pendente');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && RECOVERABLE.includes(error.code))) throw error;
      choice.disabled = true; choice.detail = constructionEditMessage(error, { quiet: true });
    }
    return choice;
  })];

const degrees = (angle: number) => Math.round(Math.abs(angle) * 180 / Math.PI) + '°';
// The ways a sensor detects, the mounts a weapon may stand on and the ammunition it may be fed, each with what tells
// it from the others.
// A mount carries a gun of any weight of its kinds: past its rated weight it lays it slower and costs more (weapon-mounts.ts).
// Catalogue choices stay visible. Committing an edit checks its actual geometry once.
export const sensorChoices = () => Object.entries(SENSOR_MODES).map(([id, mode]) =>
  ({ id, name: tr(mode.name), detail: tr`até ${count(mode.range)} m · ${formatCredits(mode.cost)}` }));
export const mountChoices = (preset: WeaponId = 'rh120') => compatibleWeaponMounts(preset).map(([id, mount]) => ({ id, name: translate(mount.name),
  detail: `${mount.exposed ? tr('por fora · ') : ''}−${degrees(mount.min)} a +${degrees(mount.max)} · ${degrees(weaponMountSpeed(preset, mount))}/s · ${mount.exposed ? tr('sem blindagem') : `${mount.armourMm} mm`} · ${formatCredits(weaponMountCost(preset, mount))}` }));
// What the box would hold of a calibre, built full: as many of its rounds as its room takes, and what they weigh.
// A calibre fits when at least one round does.
export function ammunitionBoxChoice(box: SizedComponent, preset: WeaponId, ammoType?: AmmoId) {
  const cartridge = cartridgeOf(preset, ammoType), rounds = Math.floor(componentVolume(box) * .55 * 1000 / cartridge.litres);
  return { rounds, mass: rounds * cartridge.massKg, fits: rounds > 0 };
}
export const ammoChoices = (preset: WeaponId = 'rh120') => allowedAmmo(preset).map(id => {
  const round = cartridgeOf(preset, id);
  return { id, name: tr(AMMO[id].name), detail: tr`${AMMO[id].detail} · ${roundWeight(round.massKg)} e ${roundCost(round.costCredits)} por tiro` };
});
