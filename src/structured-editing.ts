import { phrase, phraseList, tr, translate } from './i18n.ts';
import type { WireMessage } from './i18n.ts';
import { userError } from './user-message.ts';
import { makeId } from './blueprints.ts';
import { MATERIALS, MODULES, PIECE_METALS } from './materials.ts';
import { componentReference } from './component-size.ts';
import { piecePolygon, isRunningGear } from './assembly.ts';
import { localToWorld, worldToLocal, closestSegment, angleDifference, wrapAngle } from './math.ts';
import { regionGeometry, regionContains } from './scene-frame.ts';
import { gridRegions } from './armor-grid.ts';
import { WEAPON_PRESETS, weaponOf } from './weapons.ts';
import { defaultWeaponMount, compatibleWeaponMounts, WEAPON_MOUNTS } from './weapon-mounts.ts';
import { chassisSpec, CHASSIS_GEAR_SCALE, chassisLengthRange } from './chassis.ts';
import { CHASSIS_ID, chassisTopPlate, withChassisArmour, withChassisAxleCount, withChassisThickness, withChassisGearScale, withChassisSuspension,
  withChassisTopMaterial, withChassisTopThickness, withChassisTrackLength, withChassisTrackHeight, withChassisTrackPosition } from './chassis-editing.ts';
import { number as decimal } from './format.ts';
import { FRAME_HEIGHT, FRAME_REACH, drawRoom, joinContacts, landEnds, moveNodes, roomSpan, weaponHost } from './frame-editing.ts';
import { CAPACITY, PART_LIMITS, CONSTRUCTION_ORIGIN, RECOVERABLE, compileDraft, compileDraftConstruction, planStructuredComponent, planStructuredWeapon, structuredPlacementIntent } from './structured-construction.ts';
import { cellOf, metresOf, unitsOf } from './grid.ts';
import type { MaterialId, MetalId, ModuleKind } from './materials.ts';
import type { WeaponId, AmmoId } from './weapons.ts';
import type { WeaponMountId, WeaponMountSpec } from './weapon-mounts.ts';
import type { SensorMode } from './combat-sensors.ts';
import type { Point, Pose } from './math.ts';
import type { RoomWall } from './frame-editing.ts';
import { isNativeAdmissionIssue, isNativeAdmissionContext, isAuthoredComponent } from './construction-codec.ts';
import type { AuthoredComponent, AuthoredConstruction, AuthoredPlate, CompiledConstruction, CompiledModule, CompiledPlate, NativeAdmissionIssue, ChassisModelId } from './construction-contract.ts';

export type CopyComponent<C = AuthoredComponent> = C extends AuthoredComponent ? Omit<C, 'id'> : never;
export interface ComponentCopy extends Pose { component: CopyComponent }
export interface PlateCopy { plate: AuthoredPlate; a: Point; b: Point }
export interface ModulePlacementOptions {
  weaponPreset?: WeaponId;
  ammoPreset?: WeaponId;
  mountPreset?: WeaponMountId;
  sector?: { min: number; max: number };
  sectorMin?: number;
  sectorMax?: number;
  sensorMode?: SensorMode;
  sizeScale?: number;
  mirrored?: boolean;
  angle?: number;
  snap?: boolean;
  faceTolerance?: number;
  automaticMount?: boolean;
  compactSector?: boolean;
  joinReach?: number;
  copies?: readonly ComponentCopy[];
  plates?: readonly PlateCopy[];
  anchor?: Point;
}
export type CursorModule = AuthoredComponent & Pose & { width: number; height: number };
export type CursorPlate = AuthoredPlate & Pose & { length: number };
export type ModulePlacementPlan = {
  source: AuthoredConstruction;
  blueprint: CompiledConstruction;
  module?: CompiledModule | undefined;
  modules: CompiledModule[];
  plates: CompiledPlate[];
  ids: string[];
  refused: false;
  overlap: false;
  reason: string;
  meets?: Point[];
  error?: never;
} | {
  source: null;
  blueprint: CompiledConstruction;
  module?: CursorModule | undefined;
  modules: CursorModule[];
  plates: CursorPlate[];
  ids?: string[];
  refused: true;
  overlap: boolean;
  reason: string;
  meets?: Point[];
  error?: unknown;
};
export interface PiecePropertyValues {
  material: MaterialId | 'none'; thicknessMm: number; angle: number; length: number;
  sizeScale: number; metal: MetalId; weaponPreset: WeaponId; weaponAmmo: AmmoId;
  sensorMode: SensorMode; ammoPreset: WeaponId; mountPreset: WeaponMountId;
  sectorMin: number; sectorMax: number; axleCount: number; armorMm: number;
  frameThicknessMm: number; gearScale: number; suspension: number;
  topPlateMaterial: MaterialId | 'none'; topPlateThicknessMm: number;
  trackLength: number; trackHeight: number; trackX: number;
}
export type PieceProperty = keyof PiecePropertyValues;
export type PropertyChange = { [K in PieceProperty]: [key: K, value: PiecePropertyValues[K]] }[PieceProperty];
export type PropertyEdit = { [K in PieceProperty]: [key: K, value: PiecePropertyValues[K], commit?: boolean] }[PieceProperty];
export interface StructuredRoomPlan {
  source: AuthoredConstruction;
  blueprint: CompiledConstruction;
  divisions: Point[];
  length: number;
  depth: number;
  plates: string[];
  polygon: Point[];
}

// What the compiler says in its own words, and any slip of the code, is no message for the player: it goes to the
// console, and the player is told the edit was not taken.
const UNTOLD_MESSAGE = phrase('Essa mudança não pôde ser feita; o projeto continua como estava.'),
  UNTOLD = translate(UNTOLD_MESSAGE), NOWHERE = tr('Essa peça não tem onde ficar aqui. Tente outro ponto.');
// What of the construction box an edit would pass: a side of it, its top or its floor.
const LIMIT_MESSAGES = Object.freeze({
  reach: phrase`A estrutura passaria do limite de construção: ${FRAME_REACH.maxX} m para cada lado do centro.`,
  above: phrase`A estrutura passaria de ${FRAME_HEIGHT} m acima do chão.`,
  below: phrase('A estrutura passaria abaixo do chão.'),
});
export const LIMITS = Object.freeze({ reach: translate(LIMIT_MESSAGES.reach), above: translate(LIMIT_MESSAGES.above), below: translate(LIMIT_MESSAGES.below) });
// The lengths a model of chassis is made in, as the player is told them.
const chassisRangeNotice = (model: ChassisModelId) => {
  const [shortest, longest] = chassisLengthRange(model);
  return phrase`O ${chassisLabelMessage(model)} vai de ${decimal(shortest)} a ${decimal(longest)} m de comprimento.`;
};
export const chassisRangeMessage = (model: ChassisModelId) => translate(chassisRangeNotice(model));

const chassisLabelMessage = (model: ChassisModelId) => phrase(({ wheeled: 'chassi de rodas', tracked: 'chassi de esteiras', aircraft: 'chassi de aeronave' } as const)[chassisSpec(model).kind]);

const REFUSALS: Readonly<Record<string, WireMessage>> = {
  AUTHORING_LIMIT: phrase`A construção passaria do limite do projeto: ${PART_LIMITS.components} componentes, 64 nós e ${PART_LIMITS.plates} chapas.`,
  FRAME_EMPTY: phrase('Adicione ao menos uma chapa ou um componente para fabricar.'),
  CONSTRUCTION_OVERLAP: phrase('As peças ocupariam o mesmo espaço. Afaste as peças destacadas.'),
  PHYSICAL_SUPPORT: phrase('Peças internas ficam fixadas no compartimento apoiado. Armas e peças externas precisam tocar uma chapa, o chassi ou outra peça apoiada, ou ficar perto o bastante para um suporte chegar até ela.'),
  COMPONENT_PLATE: phrase('A peça atravessaria uma chapa. Afaste a peça ou mova a chapa.'),
  COMPONENT_GEAR: phrase('A lâmina encostaria na rodagem. Mova a lâmina ou ajuste seu tamanho.'),
  TOOL_GROUND: phrase('A ferramenta fica alta demais para alcançar o chão. Abaixe-a.'),
  THRUSTER_ANGLE: phrase('O propulsor aponta de 45 em 45°.'),
  WEAPON_SWEEP: phrase('O setor de tiro cruza outra chapa. Reduza o setor ou mude a arma de lugar.'),
  MOUNT_PORT: phrase('A abertura da arma não caberia na chapa. Afaste a arma do canto ou mire menos rente à chapa.'),
  MOUNT_KIND: phrase('Essa montagem não é feita para esse tipo de arma. Escolha outra montagem.'),
  PLATE_REPEATED: phrase('Já existe uma chapa entre esses pontos.'),
  PLATE_OVERLAP: phrase('As chapas ocupariam o mesmo lugar. Afaste uma delas.'),
  PLATE_JUNCTION: phrase('Uma ponta ficaria no meio de outra chapa.'),
  PLATE_CROSSING: phrase('As chapas se cruzariam sem um nó comum.'),
  PLATE_LENGTH: phrase('A chapa ficaria curta ou longa demais: de 8 cm a 12 m.'),
  CHASSIS_GEAR: phrase('Rodas e esteiras vêm com o chassi.'),
  AXLE_SPACING: phrase('Os eixos ficariam perto demais para esse tamanho de roda. Afaste os eixos ou reduza a rodagem.'),
  AXLE_EXTENT: phrase('Cada roda fica inteira embaixo do chassi, entre as pontas dele.'),
  TRACK_LENGTH: phrase('O comprimento da esteira está fora dos limites para essa altura. Ajuste o comprimento ou a altura da esteira.'),
  TRACK_EXTENT: phrase('A esteira fica embaixo do chassi, sem passar das pontas dele.'),
  CHASSIS_GEAR_KIND: phrase('Um chassi de rodas não tem esteira nem esquis, um de esteiras não tem eixos nem esquis, e uma aeronave só tem esquis.'),
  THRUSTER_CHASSIS: phrase('Propulsor só numa aeronave: mude o tipo da construção para Aeronave.'),
  AIRCRAFT_BALANCE: phrase('Não se equilibra, nem inclinada: aproxime o centro de massa do meio dos propulsores.'),
  SKID_HEIGHT: phrase('Os esquis ficariam baixos demais: as pernas têm ao menos 15 cm. Suba a altura dos esquis.'),
  SKID_EXTENT: phrase('O patim dos esquis fica embaixo do chassi, sem passar das pontas dele.'),
  CHASSIS_POINTS: phrase('O chassi leva de 2 a 16 pontos.'),
  CHASSIS_ORDER: phrase('Os pontos do chassi ficam em ordem, a 10 cm um do outro ou mais.'),
  CHASSIS_SLOPE: phrase('Um trecho do chassi sobe no máximo 45°.'),
  CHASSIS_GAP: phrase('Um vão fica entre dois trechos de chassi, nunca numa ponta nem ao lado de outro vão.'),
  CHASSIS_GAP_OPEN: phrase('Não há uma seção resistente para levar a carga através desse vão. Reforce as chapas que o atravessam ou reduza o vão.'),
  CHASSIS_CROSSING: phrase('O chassi atravessaria uma chapa do casco.'),
  CHASSIS_IDENTITY: phrase('Esse nome é das peças do chassi.'),
  CHASSIS_REQUIRED: phrase('Um veículo precisa de um chassi.'),
  CHASSIS_FIXED: phrase('Uma construção fixa não tem chassi.'),
  ARMOUR_FIXED: phrase('Concreto só serve numa construção fixa: troque antes o concreto das chapas.'),
  CHASSIS_MODEL: phrase('Esse chassi não existe.'),
};
// The tool of a road machine too high over the ground for it (`TOOL_GROUND`), by its kind.
const TOOL_HIGH: Readonly<Record<string, WireMessage>> = Object.freeze({ blade: phrase('A lâmina fica alta demais para alcançar o chão. Abaixe-a.'),
  paver: phrase('A mesa fica alta demais para alcançar o chão. Abaixe-a.') });
// The road tools a construction compiled as a draft stands too high over the ground its running gear stands on
// (game_construction.rs `TOOL_GROUND`), by id.
const toolsTooHigh = (compiled: CompiledConstruction) => new Set((compiled.admissionIssues ?? []).filter(issue => issue.code === 'TOOL_GROUND').flatMap(issue => issue.ids ?? []));
// An edit from `before` to `after`, both compiled as drafts, that leaves a road tool too high over that ground where it
// was not: refused as the workshop refuses a placement, the tools named. A design that had one so already keeps it, for
// its tool to be brought down.
export function refuseToolsTooHigh(before: CompiledConstruction, after: CompiledConstruction) {
  const was = toolsTooHigh(before), ids = [...toolsTooHigh(after)].filter(id => !was.has(id));
  if (!ids.length) return;
  const tool = after.modules.find(module => module.id === ids[0])?.kind;
  throw Object.assign(new Error(translate(TOOL_HIGH[tool!] ?? REFUSALS.TOOL_GROUND!)), { code: 'STRUCTURED_CONSTRUCTION', reason: 'TOOL_GROUND', ids, tool });
}
// A gun with no round of its calibre aboard (game_construction.rs `WEAPON_UNFED`): with no box of it, or with boxes of it,
// told after the gun, each too small for a round.
const UNFED = Object.freeze({ none: phrase('Arma sem caixa de munição do calibre dela: ponha uma para fabricar.'),
  small: phrase('A caixa de munição da arma é pequena demais para um tiro: aumente-a para fabricar.') });
// What the workshop marks on the pieces it is of: what fabrication refuses of them, and a box of a calibre no gun of the
// design takes (workshop-checklist.ts `AMMUNITION_IDLE`), which it does not.
export const MARKED_ISSUES = new Set(['PHYSICAL_SUPPORT', 'TOOL_GROUND', 'WEAPON_UNFED', 'AMMUNITION_IDLE', 'THRUSTER_CHASSIS']);
// A fixed construction stands on the ground where a vehicle stands on its chassis.
const FIXED_SUPPORT = phrase('Peças internas ficam fixadas no compartimento apoiado. Armas e peças externas precisam tocar uma chapa, o chão ou outra peça apoiada, ou ficar perto o bastante de uma chapa para um suporte chegar até ela.');
const BREECH_SURFACES: Readonly<Record<string, WireMessage>> = { roof: phrase('no teto'), floor: phrase('no piso'), wall: phrase('na parede') };
// Compiler refusals carry a code; local message contexts may carry just their reason.
// Authoring messages stay local; neither wording nor punctuation controls an edit.
// `fixed` tells of a construction without a chassis.
function constructionRefusal(thrown: unknown, { quiet = false, fixed = false } = {}): WireMessage | string {
  if (!isNativeAdmissionContext(thrown) && !(thrown instanceof Error)) {
    if (!quiet) console.warn(tr('Edição recusada:'), thrown);
    return UNTOLD_MESSAGE;
  }
  const error: Partial<NativeAdmissionIssue> & Partial<Pick<Error, 'name' | 'message'>> = thrown;
  const code = error.reason || error.code, chassis = chassisSpec(error.model);
  if (code === 'PHYSICAL_SUPPORT' && fixed) return FIXED_SUPPORT;
  // Two plates that share an end and run into each other there.
  if (code === 'PLATE_OVERLAP' && error.nodeIds?.length) return phrase('As chapas entrariam uma na outra na ponta comum. Abra mais o ângulo entre elas.');
  if (code === 'TOOL_GROUND' && TOOL_HIGH[error.tool!]) return TOOL_HIGH[error.tool!]!;
  if (code === 'WEAPON_UNFED') return (error.ids?.length ?? 0) > 1 ? UNFED.small : UNFED.none;
  if (REFUSALS[code!]) return REFUSALS[code!]!;
  // Nothing of an aircraft hangs as low as the runner of its skids: a gun as it turns, nor any other piece.
  if (code === 'AIRCRAFT_CLEARANCE') return error.gun === false ? tr('A peça destacada ficaria tão baixa quanto os esquis: suba os esquis ou a peça.') :
    tr('A arma bateria nos esquis ao girar: suba os esquis, afaste a arma das pernas deles ou reduza o setor.');
  if (code === 'AUTHORING_EXTENT' && (error.side === 'reach' || error.side === 'above' || error.side === 'below')) return LIMIT_MESSAGES[error.side];
  if (code === 'FIELD') {
    const field = error.field;
    if (['x', 'y'].includes(field!) && (error.nodeIds?.length || error.ids?.length || chassis && error.within === 'chassis.points'))
      return field === 'x' ? LIMIT_MESSAGES.reach : typeof error.value === 'number' && error.value < 0 ? LIMIT_MESSAGES.below : LIMIT_MESSAGES.above;
    if (chassis) {
      if (field === 'armorMm') return phrase`A blindagem da rodagem deste chassi vai até ${chassis.armourMm} mm.`;
      if (field === 'thicknessMm') return phrase('A espessura estrutural está fora do intervalo deste modelo e material. Confira os limites do ajuste.');
      if (field === 'gearScale' && chassis.kind === 'tracked') return phrase`A altura da esteira deve ficar entre ${decimal(chassis.track * CHASSIS_GEAR_SCALE.min)} e ${decimal(chassis.track * CHASSIS_GEAR_SCALE.max)} m.`;
      if (field === 'gearScale' && chassis.kind === 'aircraft') return phrase`O tamanho dos esquis deve ficar entre ${decimal(CHASSIS_GEAR_SCALE.min * 100)} e ${decimal(CHASSIS_GEAR_SCALE.max * 100)} %.`;
      if (field === 'skids' || error.within === 'chassis.skids') return phrase('Os esquis têm um patim, com as duas pontas, e duas pernas.');
      if (field === 'gearScale') return phrase`O tamanho da rodagem deve ficar entre ${decimal(CHASSIS_GEAR_SCALE.min * 100)} e ${decimal(CHASSIS_GEAR_SCALE.max * 100)} %, igual em todas as rodas ou em toda a esteira.`;
      if (field === 'metal') return phrase('O chassi é de aço, alumínio ou titânio.');
    } else if (error.ids?.length) {
      if (field === 'metal') return phrase('Essa peça não pode ser desse material.');
      if (field === 'sizeScale') return phrase('Tamanho fora do que a peça admite.');
      if (['min', 'max'].includes(field!)) return phrase('O setor escolhido ultrapassa os limites dessa montagem. Ajuste o setor da arma antes de trocar a montagem ou o modelo.');
    }
  }
  if (code === 'SUSPENSION_REACH') {
    const track = chassis?.kind === 'tracked', high = typeof error.value === 'number' && error.value > 0;
    return phrase`A suspensão não alcança ${phrase(track ? 'a esteira' : 'as rodas')}: o chassi ficaria ${phrase(high ? 'alto' : 'baixo')} demais sobre ${phrase(track ? 'ela' : 'elas')}. ${phrase(high ? 'Desça' : 'Suba')} o veículo pela altura da suspensão.`;
  }
  if (code === 'CHASSIS_LENGTH' && chassis) return chassisRangeNotice(chassis.kind);
  if (code === 'AXLE_COUNT' && chassis) return phrase`O ${chassisLabelMessage(chassis.kind)} leva de ${chassis.axleRange![0]} a ${chassis.axleRange![1]} eixos.`;
  if (code === 'CHASSIS_BALANCE' && chassis?.kind === 'aircraft') {
    const ahead = error.direction === 'front';
    return phrase`Com o que leva cheio ou vazio, o peso cairia ${phrase(ahead ? 'à frente' : 'atrás')} do patim dos esquis e a aeronave tombaria pousada. Leve os esquis ${phrase(ahead ? 'para a frente ou o peso para trás' : 'para trás ou o peso para a frente')}.`;
  }
  if (code === 'CHASSIS_BALANCE' && chassis) {
    const ahead = error.direction === 'front', track = chassis.kind === 'tracked',
      where = phrase(track ? ahead ? 'à frente da esteira' : 'atrás da esteira' : ahead ? 'à frente do primeiro eixo' : 'atrás do último eixo'),
      gear = phrase(track ? 'a esteira' : 'um eixo'), toward = phrase(ahead ? 'para a frente' : 'para trás'), away = phrase(ahead ? 'para trás' : 'para a frente');
    return phrase`Com o que leva cheio ou vazio, o peso cairia ${where} e o veículo se arrastaria no casco. Leve ${gear} ${toward} ou o peso ${away}.`;
  }
  const angle = error.angleDegrees, bore = angle ? phrase`a ${Math.abs(angle)}° ${phrase(angle > 0 ? 'para cima' : 'para baixo')}` : phrase('nivelado');
  // The ready rounds sit behind the receiver and turn with it.
  if (code === 'BREECH_PLATE') return phraseList([
    phrase(error.ready ? 'A culatra e o compartimento da munição atrás dela, que giram com o cano, bateriam ' : 'A culatra, que gira com o cano, bateria '),
    BREECH_SURFACES[error.surface!] ?? '', phrase(' com o cano '), bore,
    phrase(error.ready ? '. Reduza o setor, use uma cinta ou um pente menor ou mude a arma de lugar.' : '. Reduza o setor ou mude a arma de lugar.'),
  ], '');
  if (code === 'BREECH_COMPONENT') return phraseList([
    phrase(error.ready ? 'A culatra e o compartimento da munição atrás dela, que giram com o cano, bateriam na peça destacada com o cano ' :
      'A culatra, que gira com o cano, bateria na peça destacada com o cano '), bore,
    phrase(error.ready ? '. Afaste a peça, reduza o setor ou use uma cinta ou um pente menor.' : '. Afaste a peça ou reduza o setor.'),
  ], '');
  const leg = phrase`A perna ${phrase(error.index ? 'de trás' : 'da frente')} dos esquis`;
  if (code === 'SKID_GAP') return phrase`${leg} ficaria sob um vão do chassi, sem longarina para segurá-la: leve a perna para baixo de um trecho de chassi.`;
  if (code === 'SKID_RUNNER') return phrase`${leg} fica em cima do patim, a pelo menos ${decimal(Math.round((error.least ?? .2) * 100))} cm das pontas dele: afaste a perna da ponta ou estique o patim.`;
  if (code === 'SKID_SPACING') return phrase`As pernas dos esquis ficam a pelo menos ${decimal(Math.round((error.least ?? .5) * 100))} cm uma da outra.`;
  if (code === 'AIRCRAFT_LIFT') return phrase`Não decola: ${decimal(error.loadedKg! / 1000)} t com tudo cheio, e os propulsores erguem até ${decimal(error.limitKg! / 1000)} t com folga. Ponha mais empuxo ou tire peso.`;
  if (code === 'CHASSIS_OVERLOAD') return phrase`Passaria do peso que o chassi aguenta: ${decimal(error.loadedKg! / 1000)} / ${decimal(error.limitKg! / 1000)} t com tudo cheio. ${phrase(error.gap ? 'O vão do chassi não aguenta: engrosse ou afaste as chapas que o atravessam.' : 'Reforce a estrutura, ajuste a rodagem ou tire peso.')}`;
  if (!error.reason && (!error.name || error.name === 'Error') && error.message) return error.message;
  if (!quiet) console.warn(tr('Edição recusada:'), error);
  return UNTOLD_MESSAGE;
}

export function constructionEditMessage(thrown: unknown, options?: { quiet?: boolean; fixed?: boolean }): string {
  return translate(constructionRefusal(thrown, options));
}

export function constructionEditError(thrown: unknown, options?: { quiet?: boolean; fixed?: boolean }): Error {
  const message = constructionRefusal(thrown, options);
  if (typeof message === 'string') return new Error(message);
  return userError`${message}`;
}
// The authoring with one property of a plate, of a component or of the chassis — the armour of its gear, or how many
// axles it stands on — put to a value: nothing is asked of the compiler here. A plate that changes armour comes no
// thinner than the new one stands as a plate.
export function withPieceProperty<K extends PieceProperty>(source: AuthoredConstruction, id: string, key: K, value: PiecePropertyValues[K]): AuthoredConstruction;
export function withPieceProperty(source: AuthoredConstruction, id: string, ...[key, value]: PropertyChange): AuthoredConstruction {
  if (chassisTopPlate(id)) {
    if (key === 'material') return withChassisTopMaterial(source,value);
    if (key === 'thicknessMm') return withChassisTopThickness(source,value);
    throw new Error(tr('O piso acompanha os pontos do chassi.'));
  }
  if (id === CHASSIS_ID) {
    switch (key) {
      case 'axleCount': return withChassisAxleCount(source,value);
      case 'armorMm': return withChassisArmour(source,value);
      case 'frameThicknessMm': return withChassisThickness(source,value);
      case 'gearScale': return withChassisGearScale(source,value);
      case 'suspension': return withChassisSuspension(source,value);
      case 'topPlateMaterial': return withChassisTopMaterial(source,value);
      case 'topPlateThicknessMm': return withChassisTopThickness(source,value);
      case 'trackLength': return withChassisTrackLength(source,value);
      case 'trackHeight': return withChassisTrackHeight(source,value);
      case 'trackX': return withChassisTrackPosition(source,value);
      default: throw new Error(tr('O chassi não tem esse ajuste.'));
    }
  }

  const plate = source.plates.find(candidate => candidate.id === id);
  if (!plate) return { ...source, components: source.components.map(part => {
    if (part.id !== id) return part;
    if (key === 'angle') return { ...part, pose: { ...part.pose, angle: value } };
    if (key === 'sensorMode' && part.kind === 'sensor') {
      const { radarModel, ...kept } = part;
      return { ...kept, sensorMode: value, ...(value === 'radar' ? { radarModel: radarModel ?? 'mobile' } : {}) };
    }
    // A mounting edit of another kind already failed on its absent mount; keep that contract.
    if (key === 'mountPreset') {
      if (part.kind !== 'weapon') throw new TypeError('O componente não tem montagem.');
      const mount = { ...part.mount, preset: value };
      if (value !== part.mount!.preset!) delete mount.radiusM;
      return { ...part, mount };
    }
    // A gun made into another has its mantlet sized anew for it, as a gun put on another mount has (game_construction.rs
    // `mount_geometry`): one sized for a thinner bore or a longer barrel need not fit this one.
    if (key === 'weaponPreset' && part.kind === 'weapon' && value !== part.weaponPreset && part.mount?.radiusM !== undefined) {
      const { radiusM, ...mount } = part.mount;
      return { ...part, weaponPreset: value, mount };
    }
    if (key === 'sectorMin' || key === 'sectorMax') {
      if (part.kind !== 'weapon') throw new TypeError('O componente não tem montagem.');
      return { ...part, mount: { ...part.mount, sector: { ...part.mount!.sector!, [key === 'sectorMin' ? 'min' : 'max']: value } } };
    }
    return { ...part, [key]: value };
  }) };
  // Numeric edits refer to the whole stock, as displayed, including material past
  // its joints. Keep its physical centre; grid assistance belongs to gestures.
  if (key === 'angle' || key === 'length') {
    if (!Number.isFinite(value) || key === 'length' && value <= 0) throw new Error(key === 'angle' ? tr('Ângulo inválido.') : tr('Comprimento inválido.'));
    const a = source.nodes.find(node => node.id === plate.a)!, b = source.nodes.find(node => node.id === plate.b)!,
      length = Math.hypot(b.x - a.x, b.y - a.y), start = plate.ends?.start ?? 0, end = plate.ends?.end ?? 0,
      offset = (end - start) / 2, x = (a.x + b.x) / 2 + (b.x - a.x) / length * offset,
      y = (a.y + b.y) / 2 + (b.y - a.y) / length * offset,
      half = key === 'length' ? (unitsOf(value) - start - end) / 2 : length / 2,
      cosine = key === 'length' ? (b.x - a.x) / length : Math.cos(value),
      sine = key === 'length' ? (b.y - a.y) / length : Math.sin(value),
      // Exact cardinal rotations must not put a floor endpoint below zero by sin(PI)'s rounding error.
      ux = Math.abs(cosine) < Number.EPSILON ? 0 : cosine,
      uy = Math.abs(sine) < Number.EPSILON ? 0 : sine;
    if (half <= 0) throw new Error(tr('O comprimento precisa ser maior que as extensões das juntas.'));
    return moveNodes(source, new Map([[plate.a, { x: x - ux * (half + offset), y: y - uy * (half + offset) }],
      [plate.b, { x: x + ux * (half - offset), y: y + uy * (half - offset) }]]), { plateIds: [id], clampToReach: false });
  }
  const change = key === 'material' && value !== 'none' && MATERIALS[value] ? { material: value, thicknessMm: Math.max(plate.thicknessMm, MATERIALS[value].minThicknessMm) } : { [key]: value };
  return { ...source, plates: source.plates.map(candidate => candidate === plate ? { ...candidate, ...change } : candidate) };
}
export function structuredComponent(kind: 'weapon', options?: ModulePlacementOptions, id?: string): Extract<AuthoredComponent,{kind:'weapon'}>;
export function structuredComponent(kind: ModuleKind | 'plate', options?: ModulePlacementOptions, id?: string): AuthoredComponent;
export function structuredComponent(kind: ModuleKind | 'plate', options: ModulePlacementOptions = {}, id = makeId('module')): AuthoredComponent {
  if (kind === 'plate' || !MODULES[kind]) throw new Error(tr('Componente desconhecido.'));
  if (kind === 'wheel' || kind === 'track') throw new Error(tr('Rodas e esteiras vêm com o chassi.'));
  const preset = options.weaponPreset ?? 'rh120';
  if (kind === 'weapon' && !weaponOf(preset)) throw new Error(tr('Arma desconhecida.'));
  const mount = options.mountPreset || defaultWeaponMount(preset), capacity = WEAPON_MOUNTS[mount],
    sector = options.sector || (options.sectorMin !== undefined || options.sectorMax !== undefined
      ? { min: options.sectorMin ?? capacity?.min, max: options.sectorMax ?? capacity?.max } : null),
    mirrored = options.mirrored ?? ['hopper', 'cistern', 'supply', 'blade', 'paver'].includes(kind),
    // A piece of a kind that is not of steel, as a thruster, is made of the first of the metals it may be.
    metals: readonly MetalId[] | undefined = PIECE_METALS[kind];
  const pose = { x: 0, y: 0, angle: options.angle ?? (kind === 'weapon' ? Math.PI : 0), ...(mirrored ? { mirrored: true } : {}) };
  const stock = { sizeScale: options.sizeScale ?? 1, ...(metals && !metals.includes('steel') ? { metal: metals[0]! } : {}) };
  if (kind === 'weapon') return { id, kind, pose, weaponPreset: preset, mount: { preset: mount, ...(sector ? { sector } : {}) } };
  if (kind === 'sensor') return { id, kind, pose, ...stock, sensorMode: options.sensorMode ?? 'visual', ...(options.sensorMode === 'radar' ? { radarModel: 'mobile' } : {}) };
  if (kind === 'ammo') return { id, kind, pose, ...stock, ammoPreset: options.ammoPreset ?? 'rh120' };
  return { id, kind, pose, ...stock };
}
// A new compartment starts on the chosen stretch. A refused proposal keeps
// that stretch and size for the author to adjust. The plate it stands on is divided at its feet, and whatever else it
// meets where it meets it (`divisions`, in cells).
export function planStructuredRoom(source: AuthoredConstruction, compiled: CompiledConstruction, wall: RoomWall, from: Point, to: Point | null, { snap = false } = {}): StructuredRoomPlan | null {
  const support = roomSpan(wall, from, 1.8, { snap }), drawn = drawRoom(source, compiled, support, from, to, { snap });
  if (!drawn.source) {
    if (!drawn.refusal) return null;
    throw Object.assign(new Error(drawn.refusal), { code: 'FRAME_EDIT' });
  }
  const joined = joinContacts(drawn.source), admitted = compileDraft(joined.source);
  return { ...drawn, source: admitted.construction, blueprint: admitted.compiled, divisions: joined.points };
}
// A refused preview uses only dimensions. Admitted geometry, mass and ports
// always come from the native compiler.
function cursorComponent(part: AuthoredComponent, point: Point): CursorModule {
  const scale = part.sizeScale ?? 1, dimensions = componentReference(part);
  return { ...part, x: point.x, y: point.y, angle: part.pose.angle,
    width: dimensions.width * scale, height: dimensions.height * scale };
}
// Optional gesture assistance, after the grid: translate only to a nearby real
// material face. Never rotate, search for a distant support or retry admission.
// Native still decides whether the resulting ordinary authoring is supported.
export function componentFaceSnap(component: CursorModule | CompiledModule, plates: readonly CompiledPlate[], tolerance = 0): Point {
  const point = { x: component.x, y: component.y };
  if (!(tolerance > 0) || !Number.isFinite(tolerance) || component.kind === 'weapon' || isRunningGear(component)) return point;
  const polygon = piecePolygon(component);
  let best: (Point & {distance:number}) | null = null;
  for (const plate of plates) {
    const local = polygon.map(point => worldToLocal(plate, point)), half = plate.thicknessMm / 2000;
    if (Math.min(...local.map(point => point.u)) > plate.length / 2 + tolerance ||
      Math.max(...local.map(point => point.u)) < -plate.length / 2 - tolerance ||
      Math.min(...local.map(point => point.v)) > half + tolerance ||
      Math.max(...local.map(point => point.v)) < -half - tolerance) continue;
    const data = { definition: plate, solidRegions: plate.ballisticGrid ? gridRegions(plate.ballisticGrid) :
      [{ minX: -plate.length / 2, maxX: plate.length / 2, minY: -half, maxY: half }] },
      outline = regionGeometry(data), world = (index: number) => localToWorld(plate, outline.vertices[index]!.x, outline.vertices[index]!.y);
    for (const edge of outline.edges) {
      const a = world(edge.a), b = world(edge.b), length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length,
        outward = regionContains(data, { x: (a.x + b.x) / 2 - uy * 1e-6, y: (a.y + b.y) / 2 + ux * 1e-6 }) ? -1 : 1,
        nx = -uy * outward, ny = ux * outward;
      if ((point.x - a.x) * nx + (point.y - a.y) * ny < 0) continue;
      const depths = polygon.map(point => (point.x - a.x) * nx + (point.y - a.y) * ny),
        least = Math.min(...depths), distance = Math.abs(least);
      if (distance > tolerance || best && distance >= best.distance) continue;
      const foot = polygon.filter((_, index) => Math.abs(depths[index]! - least) < 1e-9),
        along = foot.map(point => (point.x - a.x) * ux + (point.y - a.y) * uy);
      // A close plane extension is not a face: contact must lie on its real edge.
      if (Math.max(...along) < 0 || Math.min(...along) > length) continue;
      best = { distance, x: point.x - least * nx, y: point.y - least * ny };
    }
  }
  return best && best.distance > 1e-12 ? { x: best.x, y: best.y } : point;
}
// A piece moved from `from` to `point` in the field. Grid assistance, when
// requested, already changed the common delta at the caller.
const translatedPose = (part: AuthoredComponent, from: Pose, point: Point & {angle?:number}) => {
  const coordinate = (key: 'x' | 'y') => point[key] === from[key] ? part.pose[key] : part.pose[key] + unitsOf(point[key] - from[key]);
  return { ...part.pose, x: coordinate('x'), y: coordinate('y'),
    ...(point.angle === undefined || point.angle === from.angle ? {} : { angle: part.pose.angle + (point.angle - from.angle) }) };
};
// A gun put in near a real face turns to it and takes the mounting made for it: through the face, or standing on the
// top of it. The core still derives every foot, post, port and clearance and admits it once.
function weaponSurfaceIntent(part: Extract<AuthoredComponent,{kind:'weapon'}>, compiled: CompiledConstruction, point: Point, { automaticMount, compactSector, faceTolerance = 0, mountPreset }: ModulePlacementOptions): Extract<AuthoredComponent,{kind:'weapon'}> {
  const mirrored=Boolean(part.pose.mirrored), parity=mirrored ? -1 : 1,
    oldAxis=part.pose.angle+(mirrored ? Math.PI : 0), flat=mirrored ? 0 : Math.PI, oldMount: WeaponMountSpec=WEAPON_MOUNTS[part.mount!.preset!],
    oldSector=part.mount!.sector || {min:oldMount.min,max:oldMount.max},
    oldRest=oldMount.exposed ? parity*angleDifference(flat,oldAxis) : 0,
    bore=oldMount.exposed ? oldAxis+parity*Math.max(oldSector.min,Math.min(oldSector.max,oldRest)) : oldAxis,
    aim={x:Math.cos(bore),y:Math.sin(bore)};
  let face: {distance:number;tangent:Point;normal:Point} | null=null;
  if (faceTolerance>0) for (const plate of compiled.plates) {
    const c=Math.cos(plate.angle), s=Math.sin(plate.angle),
      a={x:plate.x-c*plate.length/2,y:plate.y-s*plate.length/2}, b={x:plate.x+c*plate.length/2,y:plate.y+s*plate.length/2},
      on=closestSegment(point,a,b), distance=Math.hypot(point.x-on.x,point.y-on.y);
    if (distance>faceTolerance || face && distance>=face.distance) continue;
    const wall=compiled.rooms.flatMap(room=>room.walls).find(wall=>wall.id===plate.id&&wall.exterior),
      outward=wall?.normal || {x:-s,y:c}, side=(point.x-on.x)*outward.x+(point.y-on.y)*outward.y,
      way=Math.abs(side)>1e-9 ? Math.sign(side) : Math.abs(outward.y)>1e-9 ? Math.sign(outward.y) : aim.x*outward.x+aim.y*outward.y>=0 ? 1 : -1;
    face={distance,tangent:{x:c,y:s},normal:{x:outward.x*way,y:outward.y*way}};
  }
  let preset=mountPreset || part.mount!.preset!;
  if (automaticMount && face) {
    const open=compatibleWeaponMounts(part.weaponPreset!).find(([,mount])=>mount.exposed),
      roof=face.normal.y>.5 && Math.abs(face.tangent.y)<.75;
    preset=roof && open ? open[0] : oldMount.exposed ? defaultWeaponMount(part.weaponPreset!) : part.mount!.preset!;
  }
  const mount: WeaponMountSpec=WEAPON_MOUNTS[preset];
  let axis=oldAxis;
  if (face) {
    if (mount.exposed) axis=Math.atan2(face.normal.y,face.normal.x);
    else if (Math.abs(aim.x*face.tangent.x+aim.y*face.tangent.y)>Math.SQRT1_2) {
      if (automaticMount || mountPreset && preset!==part.mount!.preset!) {
        const way=aim.x*face.tangent.x+aim.y*face.tangent.y>=0 ? 1 : -1; axis=Math.atan2(face.tangent.y*way,face.tangent.x*way);
      }
    } else { const way=aim.x*face.normal.x+aim.y*face.normal.y>=0 ? 1 : -1; axis=Math.atan2(face.normal.y*way,face.normal.x*way); }
  }
  const newRest=mount.exposed ? parity*angleDifference(flat,axis) : 0;
  let sector=oldSector;
  if (compactSector || preset!==part.mount!.preset! || Math.abs(axis-oldAxis)>1e-9) {
    const half=compactSector ? 0 : Math.min((oldSector.max-oldSector.min)/2,(mount.max-mount.min)/2),
      middle=compactSector ? newRest : (oldSector.min+oldSector.max)/2+parity*angleDifference(oldAxis,axis),
      held=Math.max(mount.min+half,Math.min(mount.max-half,middle));
    sector={min:held-half,max:held+half};
  }
  const mounting={...part.mount,preset,sector};
  if (preset!==part.mount!.preset!) delete mounting.radiusM;
  return {...part,mount:mounting,pose:{...part.pose,angle:wrapAngle(axis-(mirrored ? Math.PI : 0))}};
}

// Another mounting for a gun, its sector kept as far as the new mounting turns: on the plate it goes with (the one it
// fires through, stands on its post on, or alone stands on its feet on), seated again where the new mounting holds it
// there; with none, where it stands, its axis as it lies. The core derives the new feet, post and port.
export function remountStructuredWeapon(source: AuthoredConstruction, part: Extract<AuthoredComponent,{kind:'weapon'}>, mountPreset: WeaponMountId): AuthoredConstruction {
  if (!compatibleWeaponMounts(part.weaponPreset!).some(([id]) => id === mountPreset))
    return planStructuredComponent(source, withPieceProperty(source, part.id, 'mountPreset', mountPreset).components.find(p => p.id === part.id)!).construction;
  const base = compileDraftConstruction(source), gun = base.modules.find(p => p.id === part.id)!,
    host = base.plates.find(p => p.id === weaponHost(source, part.id));
  if (host) {
    const c = Math.cos(host.angle), s = Math.sin(host.angle),
      point = closestSegment(gun, {x:host.x-c*host.length/2,y:host.y-s*host.length/2}, {x:host.x+c*host.length/2,y:host.y+s*host.length/2}),
      proposed = weaponSurfaceIntent(part, base, point, { automaticMount:false, compactSector:false, faceTolerance:.001, mountPreset });
    return planStructuredWeapon(source, proposed, { faceTolerance:.08, point:{x:point.x,y:point.y} }).construction;
  }
  return planStructuredComponent(source, weaponSurfaceIntent(part, base, gun, { automaticMount:false, compactSector:false, faceTolerance:0, mountPreset })).construction;
}

// Installation and single-weapon dragging. A gun put in turns to the face nearest the pointer and takes the mounting
// made for it (`weaponSurfaceIntent`); one dragged keeps its angle and its mounting, as any piece does. Either is seated
// by the core where its mounting holds it on a face within `faceTolerance`. A refused candidate remains a preview; the
// document still owns the old gun.
export function planStructuredWeaponPlacement(source: AuthoredConstruction, part: Extract<AuthoredComponent,{kind:'weapon'}>, point: Point, { from = null, snap = true, faceTolerance = 0, automaticMount = true, compactSector = false }: ModulePlacementOptions & { from?: Pose | null } = {}): ModulePlacementPlan {
  const base = compileDraftConstruction(source);
  let component = { ...part, pose: from ? translatedPose(part, from, snap ? {
    x: from.x + metresOf(cellOf(point.x - from.x)), y: from.y + metresOf(cellOf(point.y - from.y)),
  } : point) : structuredPlacementIntent(part, point, { snap }) };
  if (!from) component = weaponSurfaceIntent(component, base, point, { automaticMount, compactSector, faceTolerance: Math.min(.1, faceTolerance) });
  const preview = () => cursorComponent(component, {
    x: CONSTRUCTION_ORIGIN.x + metresOf(component.pose.x), y: CONSTRUCTION_ORIGIN.y + metresOf(component.pose.y),
  });
  try {
    const admitted = planStructuredWeapon(source, component, { faceTolerance, point }),
      module = admitted.compiled.modules.find(module => module.id === part.id)!;
    return { source: admitted.construction, blueprint: admitted.compiled, module, modules: [module], plates: [], ids: [part.id],
      refused: false, overlap: false, reason: '' };
  } catch (error) {
    if (!isNativeAdmissionIssue(error) || !RECOVERABLE.includes(error.code)) throw error;
    if (isAuthoredComponent(error.placement) && error.placement.id === part.id && error.placement.kind === 'weapon') component = error.placement;
    const module = preview(), message = constructionEditMessage(error, { quiet: true });
    return { source: null, blueprint: base, module, modules: [module], plates: [], ids: [part.id],
      refused: true, overlap: error.code === 'CONSTRUCTION_OVERLAP', reason: message === UNTOLD ? NOWHERE : message, error };
  }
}
export function planStructuredModule(source: AuthoredConstruction, kind: ModuleKind | 'plate', point: Point, options: ModulePlacementOptions = {}): ModulePlacementPlan {
  options = { snap: true, ...options };
  const base = compileDraftConstruction(source);
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    const error = Object.assign(new Error(tr('Posição inválida.')), { code: 'STRUCTURED_CONSTRUCTION' });
    return { source: null, blueprint: base, modules: [], plates: [], refused: true, overlap: false, reason: error.message, error };
  }
  if (kind === 'weapon' && !options.copies && !options.plates)
    return planStructuredWeaponPlacement(source, structuredComponent(kind, options), point, {automaticMount:!options.mountPreset,...options});
  const copying = options.copies || options.plates,
    anchor = options.anchor || options.copies?.[0] || options.plates?.[0]?.a,
    // Every copy follows the same rigid delta; only explicit grid assistance
    // rounds it, including a mixed group of plates and components.
    coordinate = options.snap ? cellOf : unitsOf,
    shift = copying ? { x: coordinate(point.x - anchor!.x), y: coordinate(point.y - anchor!.y) } : null,
    entries: {part:AuthoredComponent;point:Point;from?:Pose}[] = copying ? (options.copies || []).map(copy => ({
      part: { ...structuredClone(copy.component), id: makeId('module') },
      point: { x: copy.x + metresOf(shift!.x), y: copy.y + metresOf(shift!.y) },
      from: copy,
    })) : [{ part: structuredComponent(kind, options), point }],
    cellAt = (point: Point, key: 'x' | 'y') => unitsOf(point[key] - CONSTRUCTION_ORIGIN[key]) + shift![key],
    plateEntries = (options.plates || []).map(copy => ({
      plate: { ...structuredClone(copy.plate), id: makeId('plate'), a: makeId('node'), b: makeId('node') },
      a: { x: cellAt(copy.a, 'x'), y: cellAt(copy.a, 'y') },
      b: { x: cellAt(copy.b, 'x'), y: cellAt(copy.b, 'y') },
    }));
  let modules: CursorModule[] = entries.map(entry => cursorComponent(entry.part, entry.point)), plates: CursorPlate[] = plateEntries.map(({ plate, a, b }) => ({
    ...plate, x: metresOf(a.x + b.x) / 2 + CONSTRUCTION_ORIGIN.x, y: metresOf(a.y + b.y) / 2 + CONSTRUCTION_ORIGIN.y,
    length: metresOf(Math.hypot(b.x - a.x, b.y - a.y)), angle: Math.atan2(b.y - a.y, b.x - a.x),
  }));
  const refused = (reason: string, error?: unknown): Extract<ModulePlacementPlan,{refused:true}> => ({ source: null, blueprint: base, module: modules[0], modules, plates,
    refused: true, reason, error, overlap: isNativeAdmissionIssue(error) && error.code === 'CONSTRUCTION_OVERLAP' });
  if (source.components.length + entries.length > PART_LIMITS.components || source.plates.length + plateEntries.length > PART_LIMITS.plates)
    return refused(CAPACITY);
  try {
    const components = entries.map(({ part, point, from }) => {
      const component = { ...part, pose: copying ? translatedPose(part, from!, point) : structuredPlacementIntent(part, point, { snap: options.snap }) };
      if (entries.length === 1 && !plateEntries.length) {
        const preview = cursorComponent(component, { x: CONSTRUCTION_ORIGIN.x + metresOf(component.pose.x), y: CONSTRUCTION_ORIGIN.y + metresOf(component.pose.y) });
        component.pose = translatedPose(component, preview, componentFaceSnap(preview, base.plates, options.faceTolerance));
      }
      return component;
    });
    modules = components.map(part => cursorComponent(part, { x: CONSTRUCTION_ORIGIN.x + metresOf(part.pose.x), y: CONSTRUCTION_ORIGIN.y + metresOf(part.pose.y) }));
    // The copies put in, `ox` and `oy` cells further than the pointer took them.
    const pasted = (ox: number, oy: number): AuthoredConstruction => ({ ...source,
        nodes: [...source.nodes, ...plateEntries.flatMap(entry => [
          { id: entry.plate.a, x: entry.a.x + ox, y: entry.a.y + oy }, { id: entry.plate.b, x: entry.b.x + ox, y: entry.b.y + oy },
        ])],
        plates: [...source.plates, ...plateEntries.map(entry => entry.plate)],
        components: [...source.components, ...components.map(part => ({ ...part, pose: { ...part.pose, x: part.pose.x + ox, y: part.pose.y + oy } }))],
      }),
      // Plates copied are divided where they meet the plates there, and those where the copies meet them.
      joining = (drawn: AuthoredConstruction) => { const joined = joinContacts(drawn); return { joined, admitted: compileDraft(joined.source) }; };
    // A loose end of the plates copied within `joinReach` (in metres) of an end or a plate there lands on it
    // (frame-editing.ts `landEnds`); where so joined they would be refused, they go where the pointer took them.
    let landed = null, made = null;
    if (plateEntries.length && (options.joinReach ?? 0) > 0) try {
      landed = landEnds(source, pasted, unitsOf(options.joinReach!)); made = landed && joining(landed.source);
    } catch (error) {
      if (!isNativeAdmissionIssue(error) || !RECOVERABLE.includes(error.code) && error.code !== 'FRAME_EDIT') throw error;
      landed = null;
    }
    if (plateEntries.length && !made) made = joining(pasted(0, 0));
    const admitted = made ? made.admitted : components.length === 1 ? planStructuredComponent(source, components[0]!)
        : compileDraft({ ...source, components: [...source.components, ...components] }),
      copied = plateEntries.flatMap(entry => made!.joined.parts.get(entry.plate.id) ?? [entry.plate.id]),
      field = (point: Point) => ({ x: CONSTRUCTION_ORIGIN.x + metresOf(point.x), y: CONSTRUCTION_ORIGIN.y + metresOf(point.y) });
    refuseToolsTooHigh(base, admitted.compiled);
    const admittedModules = components.map(part => admitted.compiled.modules.find(module => module.id === part.id)!);
    const admittedPlates = copied.map(id => admitted.compiled.plates.find(plate => plate.id === id)!);
    return { source: admitted.construction, blueprint: admitted.compiled, module: admittedModules[0], modules: admittedModules, plates: admittedPlates,
      ids: [...components.map(part => part.id), ...copied], refused: false, overlap: false, reason: '',
      meets: made ? [...landed?.ends ?? [], ...made.joined.points].map(field) : [] };
  } catch (error) {
    if (!isNativeAdmissionIssue(error) || !RECOVERABLE.includes(error.code) && error.code !== 'FRAME_EDIT') throw error;
    const message = constructionEditMessage(error, { quiet: true });
    return refused(message === UNTOLD ? NOWHERE : message, error);
  }
}
export function moveStructuredComponents(source: AuthoredConstruction, original: readonly (Pose & {id:string})[], transform: (before: Pose & {id:string}) => Point & {angle?:number}, onRejected?: (error: NativeAdmissionIssue) => void): AuthoredConstruction | null {
  if (original.some(part => !source.components.some(candidate => candidate.id === part.id))) return null;
  const moved = new Map(original.map(before => {
    const part = source.components.find(candidate => candidate.id === before.id)!;
    return [part.id, { ...part, pose: translatedPose(part, before, transform(before)) }];
  }));
  try {
    const admitted = compileDraft({ ...source, components: source.components.map(part => moved.get(part.id) || part) });
    refuseToolsTooHigh(compileDraftConstruction(source), admitted.compiled);
    return admitted.construction;
  } catch (error) {
    if (!isNativeAdmissionIssue(error) || !RECOVERABLE.includes(error.code)) throw error;
    onRejected?.(error);
    return null;
  }
}
