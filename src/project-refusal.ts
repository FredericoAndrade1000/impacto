import { tr, locale } from './i18n.ts';
import { MATERIALS, METALS, MODULES, pieceMetals } from './materials.ts';
import { CHASSIS_METALS } from './chassis.ts';
import { chassisPart } from './chassis-editing.ts';
import { FRAME_HEIGHT } from './frame-editing.ts';
import { WEAPON_MOUNTS } from './weapon-mounts.ts';
import type { NativeAdmissionIssue } from './construction-contract.ts';
import type { ModuleKind } from './materials.ts';
import { isNativeAdmissionIssue } from './construction-codec.ts';

export type ProjectRefusal = Omit<Partial<NativeAdmissionIssue>, 'code'> & { code?: unknown; message?: string; name?: string };
interface RefusalPlace { subject: string; at: string; path: string; part?: unknown }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
// A refusal may be an Error from the compiler or its plain transported context. The presentation needs no error code.
export const isProjectRefusal = (value: unknown): value is ProjectRefusal => record(value) &&
  (value.message === undefined || typeof value.message === 'string') && (value.name === undefined || typeof value.name === 'string') &&
  isNativeAdmissionIssue({ ...value, code: '' });
const itemId = (value: unknown): unknown => record(value) ? value.id : undefined;
const moduleKind = (kind: unknown): kind is ModuleKind => typeof kind === 'string' && Object.hasOwn(MODULES, kind);
const metalsOf = (part: unknown) => record(part) && moduleKind(part.kind)
  ? pieceMetals({ kind: part.kind, ...(part.sensorMode === 'radar' ? { sensorMode: 'radar' } : {}) }) : undefined;

// A project that comes in whole from outside the workshop — a file brought into the garage, the copy of the project
// left open — and that the core refuses is told what in it is wrong and where, in one sentence the player can find
// in the file: the key, the piece by its id, what was written there and, when it is short, what is taken instead.
// The core says only the code of the refusal and that context; the words are the page's. A code with no sentence of
// its own is told by its code and its piece. Edits in the workshop keep their own messages (`constructionEditMessage`).

const decimal = new Intl.NumberFormat(locale(), { maximumFractionDigits: 3, useGrouping: false });
const figure = (value: unknown): string => decimal.format(typeof value === 'bigint' ? value : Number(value));
// What was written, as the file has it: a text in quotes, a number as it reads in the page.
const shown = (value: unknown): string => typeof value === 'string' ? `"${value.length > 40 ? value.slice(0, 40) + '…' : value}"`
  : typeof value === 'number' ? figure(value) : Array.isArray(value) ? tr('uma lista') : value && typeof value === 'object' ? tr('um objeto') : String(value);
const either = (names: readonly unknown[]): string => {
  const quoted = names.map(name => `"${name}"`);
  return quoted.length < 2 ? quoted.join('') : quoted.slice(0, -1).join(', ') + ' ou ' + quoted.at(-1);
};
const kinds = Object.keys(MODULES).filter(kind => !['wheel', 'track'].includes(kind));
// What a key holds, in the words of the page, and the unit its numbers are in.
const LABELS: Readonly<Record<string, readonly [string, string]>> = {
  thicknessMm: ['espessura', ' mm'], x: ['x', ' casas'], y: ['y', ' casas'], points: ['pontos ("points")', ''],
  sizeScale: ['tamanho ("sizeScale")', ''], angle: [tr('ângulo ("angle")'), ' rad'], radiusM: ['raio ("radiusM")', ' m'],
  min: [tr('setor mínimo ("min")'), ' rad'], max: [tr('setor máximo ("max")'), ' rad'], armorMm: [tr('blindagem da rodagem'), ' mm'],
  gearScale: [tr('tamanho da rodagem ("gearScale")'), ''], seed: ['semente ("seed")', ''],
  metal: ['metal', ''], weaponPreset: ['arma', ''], ammoPreset: ['calibre', ''],
  material: ['material', ''], kind: ['tipo', ''], id: ['id', ''], a: [tr('nó'), ''], b: [tr('nó'), ''],
};
const label = (field: string | undefined): string => LABELS[String(field)]?.[0] ?? `"${field}"`, unit = (field: string | undefined): string => LABELS[String(field)]?.[1] ?? '';
// The names a key takes, where they are few enough to tell.
const ACCEPTED: Readonly<Record<string, readonly string[]>> = { metal: CHASSIS_METALS, material: Object.keys(MATERIALS), kind: kinds };
const LISTS: Readonly<Record<string, readonly [string, string]>> = { nodes: [tr('O nó'), tr('no nó')], plates: ['A chapa', tr('na chapa')], components: [tr('Componente'), tr('no componente')] };
const PLURALS: Readonly<Record<string, string>> = { nodes: tr('nós'), plates: 'chapas', components: 'componentes', details: tr('detalhes visuais') };

// The piece a refusal is of, as the sentence names it (`subject`) and as it says where (`at`), and the path of keys
// inside it that the refused key is in.
function piece(error: ProjectRefusal, project: unknown): RefusalPlace {
  const within = typeof error.within === 'string' ? error.within : '', ids = Array.isArray(error.ids) ? error.ids : [],
    nodes = Array.isArray(error.nodeIds) ? error.nodeIds : [], list = LISTS[within];
  const among = (key: string): readonly unknown[] => record(project) && Array.isArray(project[key]) ? project[key] : [];
  // A piece whose own id is refused is told by its place in its list.
  if (list && (!ids.length && !nodes.length || error.field === 'id'))
    return { subject: `${list[0]} nº ${(error.index ?? 0) + 1}`, at: `${list[1]} nº ${(error.index ?? 0) + 1}`, path: '' };
  const inner = list ? '' : within;
  // The outermost context is the piece: a part is told with what it meets, and last itself.
  const id = ids.at(-1);
  if (id !== undefined && chassisPart(id)) return { subject: 'O chassi', at: tr('no chassi'), path: inner };
  if (id !== undefined) {
    if (among('plates').some(plate => itemId(plate) === id)) return { subject: `A chapa "${id}"`, at: tr`na chapa "${id}"`, path: inner };
    const part = among('components').find(part => itemId(part) === id);
    if (part) return { subject: `Componente "${id}"`, at: tr`no componente "${id}"`, path: inner, part };
    if (among('nodes').some(node => itemId(node) === id)) return { subject: tr`O nó "${id}"`, at: tr`no nó "${id}"`, path: inner };
    return { subject: tr`A peça "${id}"`, at: tr`na peça "${id}"`, path: inner };
  }
  if (nodes.length) return { subject: tr`O nó "${String(nodes[0])}"`, at: tr`no nó "${String(nodes[0])}"`, path: inner };
  // A point of the chassis is told by its place along it, from the front.
  if (within === 'chassis.points' && Number.isInteger(error.index))
    return { subject: tr`O ponto nº ${error.index! + 1} do chassi`, at: tr`no ponto nº ${error.index! + 1} do chassi`, path: '' };
  if (error.model !== undefined || within === 'chassis' || within.startsWith('chassis.'))
    return { subject: 'O chassi', at: tr('no chassi'), path: within.replace(/^chassis\.?/, '') };
  return { subject: 'O projeto', at: tr('no projeto'), path: inner };
}
const keyPath = (place: RefusalPlace, field: string | undefined): string => [place.path, field].filter(Boolean).join('.');
// A key as the sentence names it: in the words of the page, or by its path when it is in an object of the piece.
const called = (place: RefusalPlace, field: string | undefined): string => place.path ? `"${keyPath(place, field)}"` : label(field);
// The span a number is taken in.
const span = (lo: number, hi: number, measure: string): string => lo < 0 ? `${figure(lo)} a ${figure(hi)}${measure}` : `${figure(lo)}–${figure(hi)}${measure}`;
// A key with a refused value.
function field(error: ProjectRefusal, place: RefusalPlace): string {
  const { field: key, value, range, expected } = error, path = keyPath(place, key), { subject } = place;
  if (value === undefined) return `${subject}: falta "${path}".`;
  if (key === 'preset' && place.path === 'mount' && typeof value === 'string')
    return tr`${subject}: montagem ${shown(value)} não existe (${either(Object.keys(WEAPON_MOUNTS))}).`;
  // A component is made of what its kind may be, a sensor of what one that detects as it does may: one of a material there
  // is is told that it does not take it.
  const accepted = (key === 'metal' && place.part ? metalsOf(place.part) : undefined) || ACCEPTED[String(key)];
  if (key === 'metal' && Object.hasOwn(METALS, typeof value === 'symbol' ? value : String(value)))
    return tr`${subject}: ${label(key)} ${shown(value)} não serve aqui (${either(accepted!)}).`;
  if (['weaponPreset', 'ammoPreset', 'metal'].includes(String(key)) && typeof value === 'string')
    return tr`${subject}: ${label(key)} ${shown(value)} não existe${accepted ? ` (${either(accepted)})` : ''}.`;
  if (Array.isArray(range) && range.length === 2) {
    if (typeof value !== 'number') return tr`${subject}: "${path}" precisa ser um número.`;
    // The launcher of a bench stands where it is in metres; every other position is written in cells.
    const lo = range[0]!, hi = range[1]!, measure = place.path === 'launcher' || error.within?.includes('details') && ['x', 'y', 'width', 'height'].includes(String(key)) ? ' m' : unit(key);
    if (lo === hi) return tr`${subject}: ${called(place, key)} ${figure(value)}${measure}, mas só pode ser ${figure(lo)}${measure}.`;
    return tr`${subject}: ${called(place, key)} ${figure(value)}${measure} fora de ${span(lo, hi, measure)}.`;
  }
  if (expected === 'text') return tr`${subject}: "${path}" precisa ser um texto entre aspas.`;
  if (expected === 'list') return tr`${subject}: "${path}" precisa ser uma lista [ ]${error.count ? tr` de ${error.count} números` : ''}.`;
  return tr`${subject}: "${path}" não aceita ${shown(value)}.`;
}

// An id written twice: nodes, plates and components share their ids.
const repeated = (error: ProjectRefusal): string => tr`O id "${String(error.nodeIds?.[0] ?? error.ids?.at(-1))}" se repete: cada nó, chapa e componente tem o seu.`;
// Where a gun points when its breech meets something: level, or so many degrees up or down.
const bore = (angle: number | undefined): string => angle ? `a ${figure(Math.abs(angle))}° ${angle > 0 ? tr('para cima') : tr('para baixo')}` : 'nivelado';

// Each code a written project can be refused with, told from its context.
type RefusalSentence = (error: ProjectRefusal, place: RefusalPlace, project: unknown) => string;
const SENTENCES: Readonly<Record<string, RefusalSentence>> = {
  AUTHORING_OBJECT: (e, p) => p.path ? tr`${p.subject}: "${p.path}" precisa ser um objeto { }.` : tr`${p.subject} precisa ser um objeto { }.`,
  AUTHORING_FIELDS: (e, p) => {
    const keys = Array.isArray(e.keys) ? e.keys : [], many = keys.length > 1;
    return tr`Chave${many ? 's' : ''} desconhecida${many ? 's' : ''} ${keys.map(key => `"${key}"`).join(', ')}${p.path ? ` em "${p.path}"` : ''} ${p.at}.`;
  },
  AUTHORING_LIMIT: (e, p) => PLURALS[String(e.field)] ? tr`O projeto tem mais de ${String(e.max)} ${String(PLURALS[String(e.field)])}, o limite.`
    : tr`${p.subject}: "${keyPath(p, e.field)}" tem mais de ${String(e.max)} itens.`,
  FIELD: field,
  FRAME_EMPTY: () => tr('Adicione uma chapa ou um componente antes de fabricar.'),
  // What passes the construction box: under its floor, or over its top.
  AUTHORING_EXTENT: (e, p) => e.side === 'below' ? tr`${p.subject} fica abaixo do chão.` : tr`${p.subject} passa de ${FRAME_HEIGHT} m acima do chão.`,
  // Plates meet only at their ends, and none stands in another (`Frame::meet`).
  PLATE_OVERLAP: e => e.nodeIds?.length ? tr`As chapas "${String(e.ids?.[0])}" e "${String(e.ids?.[1])}" entram uma na outra no nó "${String(e.nodeIds[0])}": abra mais o ângulo entre elas.`
    : tr`As chapas "${String(e.ids?.[0])}" e "${String(e.ids?.[1])}" ocupam o mesmo lugar.`,
  PLATE_JUNCTION: e => tr`O nó "${String(e.nodeIds?.[0])}" fica no meio da chapa "${String(e.ids?.[0])}": divida a chapa nesse nó.`,
  PLATE_CROSSING: e => tr`As chapas "${String(e.ids?.[0])}" e "${String(e.ids?.[1])}" se cruzam: divida as duas num nó onde se cruzam.`,
  COMPONENT_PLATE: e => tr`O componente "${String(e.ids?.at(-1))}" ocupa espaço da chapa "${String(e.ids?.[0])}".`,
  COMPONENT_GEAR: e => tr`O componente "${String(e.ids?.[0])}" ocupa espaço da rodagem "${String(e.ids?.[1])}".`,
  // A blade or a paver too high over the ground its vehicle stands on to reach it at work (game_construction.rs).
  TOOL_GROUND: e => tr`O componente "${String(e.ids?.[0])}" fica alto demais para alcançar o chão.`,
  EXPOSED_SHIELD: (e, p) => tr`${p.subject}: uma montagem exposta não leva mantelete nem "mount.radiusM".`,
  INTEGER: (e, p) => tr`${p.subject}: ${called(p, e.field)} ${shown(e.value)} precisa ser um número inteiro.`,
  // Chassis, running gear, equipment positions and stock extensions remain on the fabrication grid.
  AUTHORING_GRID: (e, p) => tr`${p.subject}: ${called(p, e.field)}${typeof e.value === 'number' ? ' ' + shown(e.value) : ''} fora da grade. `
    + tr('Esta posição ou extensão usa a grade de 5 cm, em número inteiro de casas.'),
  IDENTITY: (e, p) => tr`${p.subject}: ${called(p, e.field)} ${shown(e.value)} não serve: um id tem só letras, números, "_", "-" e ":", até 64.`,
  CHASSIS_IDENTITY: (e, p) => tr`${p.subject}: o id ${shown(e.value)} começa com "chassis:", que é das peças do chassi.`,
  NODE_IDENTITY: e => repeated(e),
  PLATE_IDENTITY: e => repeated(e),
  COMPONENT_IDENTITY: e => repeated(e),
  CONSTRUCTION_VERSION: (e, p) => e.field === 'preset'
    ? e.value === undefined ? tr`Falta "preset" no projeto (${either(e.accepted ?? [])}).` : tr`O tipo de projeto ${shown(e.value)} não existe (${either(e.accepted ?? [])}).`
    : tr('O projeto é de outra versão do jogo.'),
  PLATE_NODE: (e, p) => tr`${p.subject} liga o nó ${shown(e.value)}, que não existe.`,
  PLATE_REPEATED: (e, p) => e.nodeIds?.length ? tr`${p.subject} começa e termina no mesmo nó "${String(e.nodeIds[0])}".`
    : tr`${p.subject} repete a chapa "${String(e.ids?.[0])}": as duas ligam os mesmos nós.`,
  PLATE_LENGTH: (e, p) => tr`${p.subject} tem ${figure(e.value)} m: uma chapa vai de ${figure(e.range?.[0] ?? .08)} a ${figure(e.range?.[1] ?? 12)} m.`,
  ARMOUR_MATERIAL: (e, p) => e.value === undefined ? `${p.subject}: falta "material".`
    : tr`${p.subject}: material ${shown(e.value)} não existe (${either(ACCEPTED.material!)}).`,
  ARMOUR_FIXED: (e, p) => tr`${p.subject}: material ${shown(e.value)} só serve numa construção fixa ("bunker").`,
  CHASSIS_REQUIRED: () => tr('Um veículo ("vehicle") precisa de "chassis".'),
  CHASSIS_FIXED: () => tr('Uma construção fixa ("bunker") não leva "chassis".'),
  CHASSIS_MODEL: e => e.value === undefined ? tr`Falta "model" no chassi (${either(e.accepted ?? [])}).`
    : tr`O chassi ${shown(e.value)} não existe (${either(e.accepted ?? [])}).`,
  CHASSIS_LENGTH: e => tr`O chassi tem ${figure(e.value)} m do primeiro ao último ponto: este vai de ${figure(e.range?.[0])} a ${figure(e.range?.[1])} m.`,
  CHASSIS_POINTS: e => tr`O chassi tem ${String(e.value)} ponto${e.value === 1 ? '' : 's'}: leva de ${String(e.range?.[0])} a ${String(e.range?.[1])}.`,
  CHASSIS_ORDER: e => tr`O chassi: o ponto nº ${(e.index ?? 0) + 1} precisa ficar ao menos 10 cm atrás do anterior.`,
  CHASSIS_SLOPE: e => tr`O chassi: o trecho nº ${(e.index ?? 0) + 1} sobe ${figure(Math.round(Number(e.value) * 10) / 10)}°; o máximo é ${figure(e.range?.[1])}°.`,
  CHASSIS_GAP: e => tr`O chassi: o vão no ponto nº ${(e.index ?? 0) + 1} não fica entre dois trechos de chassi.`,
  CHASSIS_GAP_OPEN: e => tr`O chassi: nenhuma chapa que aguente peso atravessa o vão de ${figure(e.from)} a ${figure(e.to)} m (cerâmica, vidro e concreto não aguentam).`,
  CHASSIS_CROSSING: e => tr`O chassi atravessa a chapa "${String(e.ids?.[0])}".`,
  CHASSIS_GEAR_KIND: e => e.model === 'tracked' ? tr('Um chassi de esteiras ("tracked") não leva "axles" nem "skids".') :
    e.model === 'aircraft' ? tr('Uma aeronave ("aircraft") não leva "axles" nem "track": fica sobre esquis ("skids").') : tr('Um chassi de rodas ("wheeled") não leva "track" nem "skids".'),
  SKID_HEIGHT: e => tr`O chassi fica baixo demais sobre os esquis: as pernas têm ao menos ${figure(Math.round((e.least ?? .15) * 100))} cm.`,
  SKID_GAP: e => tr`O chassi: a perna ${e.index ? tr('de trás') : tr('da frente')} dos esquis fica sob um vão.`,
  SKID_EXTENT: () => tr('O chassi: o patim dos esquis ("skids") passa do primeiro ou do último ponto.'),
  SKID_RUNNER: e => tr`O chassi: a perna ${e.index ? tr('de trás') : tr('da frente')} dos esquis precisa ficar sobre o patim, a ${figure(Math.round((e.least ?? .2) * 100))} cm ou mais das pontas dele.`,
  SKID_SPACING: e => tr`O chassi: as pernas dos esquis ficam a ${figure(Math.round(Number(e.value ?? 0) * 100))} cm uma da outra; o mínimo é ${figure(Math.round((e.least ?? .5) * 100))} cm.`,
  AIRCRAFT_LIFT: e => tr`A aeronave não decola: ${figure(Number(e.loadedKg) / 1000)} t com tudo cheio, e os propulsores erguem até ${figure(Number(e.limitKg) / 1000)} t com folga.`,
  AIRCRAFT_BALANCE: () => tr('Os propulsores não equilibram a aeronave, nem inclinada: o centro de massa fica longe do meio deles.'),
  AIRCRAFT_CLEARANCE: (e, p) => e.gun === false ? tr`${p.subject}: fica tão baixo quanto os esquis da aeronave.` :
    tr`${p.subject}: a arma bate nos esquis ou desce até eles ao girar.`,
  THRUSTER_CHASSIS: (e, p) => tr`${p.subject}: um propulsor só vai numa aeronave ("aircraft").`,
  AXLES: () => tr('O chassi: "axles" precisa ser uma lista de números.'),
  AXLE_COUNT: e => tr`O chassi tem ${String(e.value)} eixo${e.value === 1 ? '' : 's'}: este leva de ${String(e.range?.[0])} a ${String(e.range?.[1])}.`,
  AXLE_EXTENT: () => tr('O chassi: cada roda precisa ficar inteira do primeiro ao último ponto.'),
  AXLE_SPACING: () => tr('O chassi: os eixos estão perto demais para o tamanho das rodas.'),
  TRACK_LENGTH: () => tr('O comprimento da esteira está fora dos limites para essa altura. Ajuste o comprimento ou a altura da esteira.'),
  TRACK_EXTENT: () => tr('O chassi: a esteira passa do primeiro ou do último ponto.'),
  FRAME_SECTION: () => tr('O chassi: a espessura da estrutura não cabe com essa rodagem.'),
  SUSPENSION_REACH: e => tr`O chassi fica ${figure(Math.round(Math.abs(Number(e.value ?? 0)) * 100))} cm ${Number(e.value) > 0 ? 'acima' : 'abaixo'} da altura da suspensão do modelo: a suspensão alcança ${e.model === 'tracked' ? 'a esteira' : tr('as rodas')} até ${figure(Math.round((e.range?.[1] ?? .2) * 100))} cm para cima ou para baixo.`,
  CHASSIS_BALANCE: e => e.model === 'aircraft' ? tr`O peso fica ${e.direction === 'front' ? tr('à frente') : tr('atrás')} dos esquis: a aeronave tombaria pousada.`
    : tr`O peso fica ${e.direction === 'front' ? tr('à frente') : tr('atrás')} da rodagem: o veículo se arrastaria no casco.`,
  CHASSIS_OVERLOAD: e => tr`O chassi não aguenta o peso: ${figure(Number(e.loadedKg) / 1000)} de ${figure(Number(e.limitKg) / 1000)} t com tudo cheio.`,
  CHASSIS_GEAR: (e, p) => tr`${p.subject}: o tipo ${shown(e.value)} vem com o chassi e não é um componente.`,
  COMPONENT_KIND: (e, p) => e.value === undefined ? `${p.subject}: falta "kind".`
    : tr`${p.subject}: tipo ${shown(e.value)} não existe (${either(ACCEPTED.kind!)}).`,
  MOUNT_FACE_DEPTH: (e, p) => tr`${p.subject}: a montagem precisa de mais espaço na largura da construção.`,
  MOUNT_KIND: (e, p) => tr`${p.subject}: essa montagem não é feita para esse tipo de arma.`,
  MOUNT_PORT: (e, p) => tr`${p.subject}: a abertura da arma não cabe na chapa "${String(e.ids?.[0])}".`,
  WEAPON_SWEEP: (e, p) => tr`${p.subject}: o setor de tiro cruza a chapa "${String(e.ids?.[0])}".`,
  BREECH_PLATE: (e, p) => e.ready ? tr`${p.subject}: a culatra ou o compartimento da munição bate na chapa "${String(e.ids?.[0])}" com o cano ${bore(e.angleDegrees)}.`
    : tr`${p.subject}: a culatra bate na chapa "${String(e.ids?.[0])}" com o cano ${bore(e.angleDegrees)}.`,
  BREECH_COMPONENT: e => e.ready ? tr`A culatra ou o compartimento da munição de "${String(e.ids?.[0])}" bate no componente "${String(e.ids?.[1])}" com o cano ${bore(e.angleDegrees)}.`
    : tr`A culatra de "${String(e.ids?.[0])}" bate no componente "${String(e.ids?.[1])}" com o cano ${bore(e.angleDegrees)}.`,
  CONSTRUCTION_OVERLAP: e => tr`Os componentes "${String(e.ids?.[0])}" e "${String(e.ids?.[1])}" ocupam o mesmo espaço.`,
  WEAPON_AMMUNITION: (e, p) => tr`${p.subject}: munição ${shown(e.value)} não serve nesta arma${e.accepted?.length ? ` (${either(e.accepted)})` : ''}.`,
  AMMUNITION_MISMATCH: (e, p) => tr`${p.subject}: munição ${shown(e.value)}, mas outra arma do mesmo calibre usa ${shown(e.accepted?.[0])}; um calibre usa uma só.`,
  SENSOR_MODE: (e, p) => tr`${p.subject}: sensor ${shown(e.value)} não existe ("visual", "radar" ou "sound").`,
  THRUSTER_ANGLE: (e, p) => tr`${p.subject}: um propulsor aponta de 45 em 45° (um "angle" múltiplo de π/4), não ${shown(e.value)} rad.`,
  PAINT: e => tr`"appearance.paint" ${shown(e.value)} não é uma cor: use "#rrggbb".`,
  DETAIL_KIND: () => tr('Esse detalhe não faz parte do catálogo visual.'),
  DETAIL_IDENTITY: () => tr('Dois detalhes usam a mesma identificação.'),
  DETAIL_SURFACE: () => tr('O detalhe precisa estar vinculado à carroceria, ao chassi ou a um componente.'),
  DETAIL_TEXT: () => tr('O número decorativo aceita de 1 a 3 algarismos.'),
  TERRAIN: () => tr('"terrain" precisa ser um texto de 1 a 64 letras.'),
};
export function projectRefusalMessage(input: unknown, project: unknown): string {
  const error = isProjectRefusal(input) ? input : null;
  const code = error?.reason;
  // What is not a refusal of the core says itself — a file that is no project, of another version, too big —, and a slip
  // of the code is no message for the player.
  if (!error || typeof code !== 'string') return error?.message && (!error.name || error.name === 'Error') ? error.message : tr('O projeto não pôde ser aberto.');
  const place = piece(error, project), say = SENTENCES[code];
  return say ? say(error, place, project) : `Recusado (${code}) ${place.at}.`;
}
