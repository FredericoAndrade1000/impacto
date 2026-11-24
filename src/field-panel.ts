import type { DrawingActor, DrawingModule, DrawingPlate, DrawingVehicle } from './scene-drawing-contract.ts';
import type { SquadUnitView } from './squad-contract.ts';
type PanelSquadUnit = FieldSquad['units'][number] & { by?: SquadHolder; reserved?: boolean };
export type FieldActionId = 'copy' | 'relocate' | 'dismantle' | 'abandon';
export type FieldOrderId = 'move' | 'attack' | 'bombard' | 'haul' | 'tow' | 'turn' | 'home' | 'stop' | 'free';
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing field panel record'); return value; };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const requiredHeld = (value: unknown): keyof typeof HELD => { if (!isHeldReason(value)) throw new Error('Unknown ground hold'); return value; };
const isHeldReason = (value: unknown): value is keyof typeof HELD => typeof value === 'string' && Object.hasOwn(HELD, value);
import type { FieldView, FactionView, UnitView, FieldSquad, KnownVein, Standing, StandingActor, SquadHolder } from './faction-ui.ts';
import type { Deposit } from './deposits.ts';
import type { SupplyBill, CargoKind } from './economy-contract.ts';
export interface GroundHoldsMemo {
  pending?: Map<string, { revision: number | undefined; reason: string; direction: number; x: number; since: number }>;
  faction?: string | undefined; player?: string | null | undefined; time?: number | undefined;
}
export interface FieldPanelOptions {
  tab?: 'test' | 'edit'; shared?: boolean; connected?: boolean; state?: FieldView | null; faction?: FactionView | null;
  playerId?: string | null; picked?: readonly string[]; armed?: string | null; focus?: string | null;
  price?: SupplyBill | null; commanded?: boolean; drives?: boolean; admissionReason?: string;
  deposits?: readonly Deposit[]; pingMs?: number; touch?: boolean; mobility?: GroundHoldsMemo | null; instant?: boolean;
}
export type FieldPanelView = ReturnType<typeof fieldPanel>;
export type FieldPanel = FieldPanelView;
export interface FieldNoticeItem { text: string; grave: boolean; place: number | { id: string; x: number; approximate: boolean } | null; encounter?: { id: string; x: number; approximate: boolean } }
export interface FieldNoticeMemo {
  told?: Map<string, number>; expected?: Set<string>; grave?: boolean; spotted?: boolean; entered?: boolean;
  place?: number | null; entry?: ReturnType<typeof entryReport> | null; items?: FieldNoticeItem[];
  watch?: NonNullable<FieldPanelView['watch']> | null;
}
export type FieldOrder = FieldPanelView['orders'][number];
export type FieldAction = FieldPanelView['actions'][number];
export type FieldStance = NonNullable<FieldPanelView['stances']>[number];
export type FieldUnitRow = NonNullable<FieldPanelView['squad']>['units'][number];
import { tr } from './i18n.ts';
import { STANCES } from './squad.ts';
import { count, metres, way, kilometres as km } from './format.ts';
import { ammunitionSupply, CARGO } from './component-volume.ts';
import { cartridgeId } from './weapons.ts';
import { billTotal, loadTotal, RAW, RAW_IDS, SALVAGE_REACH } from './economy.ts';
import { standing, heardText, haulText, cargoText, damageText, damaged, cargoGauge, mixGauge, suppliesGauge, unitServices, dismantlePlan, publishQuote, obraQuote, wreckRows, workRows, heapRows, roadRows, knownVeins, veinRows, farText, factionName, recoveryText, emptyText, strandedText, fellText, recoveredText, removedText, batteryText, serviceText, cargoWorkText, serviceFeedback, jobText, jobAdvice, workMaterialsText, comingText, repairNeedsOrder, takenText, percentText, toolText, sharedSoundReports, SIEGE_NEWS, POST_SIEGE_NEWS, lostText, seizedText, postRows, THRUSTER_LOST } from './faction-ui.ts';
import { factionPage } from './faction-page.ts';
import { BUILD_REACH } from './construction-site.ts';
import { towOf } from './tow-ui.ts';
import { damageTone } from './part-view.ts';
import { detailPartId } from './vehicle-details.ts';
import { infrastructureOffer } from './infrastructure-ux.ts';

// The side panel of the shared field is a function of the situation. What is known goes in; what comes
// out is which blocks the panel has and what each says, and the page only paints that. Orders follow
// installed equipment; a temporary impediment keeps the action visible with its cause and remedy.
// What is done without being asked — filling up and
// repairing — has no button: only the line of why it waits, while it does.

// The orders of a squad, as they stand in the panel: name, key, where the click or the tap that gives it goes and, of one
// whose button says less than its name, what the button says. Turning about, going home, stopping and letting the vehicles
// go to the rest of the faction wait for neither. Sent home, a vehicle goes to the base or the post nearest it and stops
// there; an aircraft lands there, where it is filled up (squad.ts `home`). A structure is sent nowhere: it works the vein it
// stands on by itself, and Parar is for whatever moves or fires.
export const ORDERS = Object.freeze(([['move', tr('Mover'), 'M', tr('no terreno para onde ir')], ['attack', tr('Atacar'), 'T', tr('num veículo inimigo')],
  ['bombard', tr('Bombardear'), 'B', tr('no ponto a bombardear')],
  ['haul', tr('Transportar'), 'J', tr('num local de coleta conhecido (vai e volta da base ou do posto mais perto até nova ordem; ao encerrar a coleta, o veículo volta para lá e para)')],
  ['tow', tr('Rebocar'), 'R', tr('num veículo da facção parado ao lado')],
  ['turn', tr('Virar'), 'V', ''], ['home', tr('Voltar à base ou ao posto mais perto'), 'P', '', 'Base'], ['stop', tr('Parar'), 'X', tr('para cancelar movimento, ataque e rotas. Perto de jazidas, a extração e a carga continuam automáticas; afaste o veículo para interrompê-las.')], ['free', tr('Liberar'), 'L', '']] satisfies readonly [FieldOrderId, string, string, string, string?][] )
  .map(([id, name, key, hint, label]) => Object.freeze({ id, name, key, hint, ...(label ? { label } : {}) })));
// Where the click or the tap of Mover goes when those it sends fly, all or some: on the ground they come down, in the sky
// they hover (squad.ts `move`).
const MOVE_FLYING = Object.freeze({ all: tr('no chão para pousar ou no céu para pairar'), some: tr('no destino; aeronaves pousam no chão ou pairam no céu') });
// What is done to the constructions picked, beside the orders that are not in the main row (squad-ux.ts, Mais ações): a copy
// of the design of the one picked alone opened in the workshop; the structure picked alone moved elsewhere, to a place chosen
// on the field; dismantling all those picked that may be (`dismantlePlan`); and abandoning the one picked alone where it
// stands, away from its base.
export const ACTIONS = Object.freeze(([['copy', tr('Editar cópia'), 'i-copy', tr('Abre na Oficina uma cópia do projeto desta construção.')],
  ['relocate', tr('Mudar de lugar'), 'i-relocate', tr('Escolha outro local: ela é desmontada aqui e montada lá, levando o material.')],
  ['dismantle', tr('Desmontar'), 'i-build', tr('Veículos na base saem do campo e devolvem o que resta deles e a carga; estruturas são desmontadas no lugar por um construtor em automático.')],
  ['abandon', tr('Abandonar'), 'i-abandon', tr('A construção vira destroços ali mesmo, que valem menos e ficam para quem os recolher.')]] satisfies readonly [FieldActionId, string, string, string][])
  .map(([id, name, icon, title]) => Object.freeze({ id, name, icon, title })));
// Why an order is not offered to the vehicles picked.
const UNARMED = tr('Nenhuma das construções selecionadas tem arma instalada.');
const FIXED = tr('Selecione um veículo móvel: estruturas permanecem no local.');
const REFUSALS = Object.freeze({ attack: UNARMED, bombard: UNARMED, haul: tr('Nenhum dos veículos selecionados tem equipamento de coleta ou compartimento de suprimentos.'),
  move: FIXED, turn: FIXED, home: FIXED, stop: FIXED, free: tr('Nenhuma das construções selecionadas está reservada para você.') });
// They could carry, and the faction knows of no vein of what they carry: veins have to be found.
const UNFOUND = tr('Nenhum local de coleta compatível conhecido. Explore com um veículo de reconhecimento.');
const TURN_HELD = tr('Virar fica indisponível durante o serviço. Aguarde o término.');
const COLLECTION_BROKEN = tr('O equipamento de coleta está inutilizado. Faça um reparo completo na base ou com um veículo de suprimentos.');
const COLLECTION_BASE = tr('Nenhum local de coleta compatível está disponível agora. Confira o prazo ou explore longe das bases.');
// The only place they know is a cargo dropped on the field, which holds no reserve to dig: it is for a container to take.
const PILE_ONLY = tr('O local de coleta conhecido só tem carga pronta, sem reserva para extrair. Leve um veículo com caçamba.');
const OFFLINE = tr('A conexão com o campo está indisponível. Aguarde a reconexão para dar ordens.');
// Guns that fire nothing the field brings them (`abilities`): with boxes of another calibre only, or with no box. What puts
// that right is a copy of the project with the box of the calibre of the gun, made in the place of the construction:
// a vehicle is replaced by it, and a structure taken down for a works of it.
const MISFED = tr('munição de outro calibre'), BOXLESS = tr('sem caixa de munição');
const unfedAdvice = (gun: string, structure: boolean): string => `${gun === MISFED ? tr('Munição de outro calibre: nenhuma arma usa a das caixas. Em Editar cópia, troque o calibre da caixa')
  : tr('Sem caixa de munição: em Editar cópia, ponha uma do calibre da arma')}${structure ? tr(', desmonte esta e abra a obra nova.') : tr(' e substitua o veículo.')}`;
// What a vehicle sent to a vein does there, by the order it is given.
const AT_VEIN = Object.freeze({
  collect: { name: tr('Extrair e transportar'), label: tr('Coletar'), description: tr('extrai, leva o material à base ou ao posto mais perto e repete'), icon: 'i-haul' },
  extract: { name: tr('Extrair'), label: tr('Extrair'), description: tr('extrai e deixa o material pronto ali'), icon: 'i-extract' },
  haul: { name: tr('Transportar'), label: tr('Transportar'), description: tr('leva a carga à base ou ao posto mais perto e repete; sem carga, aguarda material no local'), icon: 'i-haul' },
});
// A vehicle on a cable, picked alone, has the order that lets go of it in the place of Rebocar: at once, pointing at nothing.
const UNTOW = Object.freeze({ name: tr('Soltar o cabo'), label: tr('Soltar'), hint: '', release: true });
// What the card of a wreck says to one of those spoken of by it that does not stand still on the ground, as the field
// refuses it (server/room.ts `salvage`).
const LAND_BY_WRECK = tr('Pouse perto dos destroços para recolhê-los.'), STOP_BY_WRECK = tr('Pare perto dos destroços para recolhê-los.');
// A cable joins two vehicles: one picked alone is the one that pulls. Said only on its button.
const TOW_ONE = tr('Selecione um único veículo para rebocar.');
// Why a gun under orders is silent, and why an order ended before it was done.
const GUNS = Object.freeze({ firing: 'atirando', reloading: 'recarregando', cooling: tr('cano superaquecido · esperando esfriar'), 'servo-aligning': 'alinhando a arma', holding: tr('alvo na mira · segurando fogo'),
  'search-contact': tr('nenhum inimigo detectado'), 'uncertain-contact': tr('posição do inimigo incerta'), 'no-armed-feed': tr('sem arma com munição'),
  'no-ballistic-solution': tr('alvo fora de alcance'), 'terrain-cover': tr('alvo encoberto pelo terreno'),
  'servo-obstruction': tr('arma travada'), 'futile-target': tr('os tiros não furam o alvo · poupando munição'), bombarding: 'bombardeando o ponto', 'point-out-of-reach': tr('ponto fora do alcance da arma'),
  'turn-to-fire': tr('virando para ter tiro'),
  'own-in-line': tr('o próprio veículo está na linha de tiro'), 'ally-in-line': tr('um aliado está na linha de tiro · segurando fogo'), 'ally-target': tr('Alvo aliado'),
  'blast-too-close': tr('alvo perto demais para explosivo'), 'point-too-close': tr('ponto perto demais para explosivo') });
// Why an aircraft goes to land on its own: for its fuel, or out of rounds (squad.ts `land`), or to work where it comes down; or,
// for a thruster it lost, home to be mended or down where it is (squad.ts `mend`).
const LANDING = Object.freeze({ fuel: tr('pouco combustível · voltando para pousar'), ammo: tr('sem munição · voltando para pousar'), work: tr('indo pousar para trabalhar'),
  mend: THRUSTER_LOST.home, forced: THRUSTER_LOST.forced });
// A vehicle with no order says its stance by name, but holding fire, which it says as what it is doing.
const POSTURES = Object.freeze({ hold: tr('segurando fogo') });
const WAYS = Object.freeze({ 'blocked-way': tr('caminho bloqueado'), immobile: tr('sem mobilidade'),
  'no-room': tr('sem equipamento ou compartimento compatível com esta coleta'), 'no-deposit': tr('local de coleta perto demais de uma base: coleta indisponível'),
  'no-loader': tr('o equipamento não alcança o local de coleta; reposicione-o na Oficina'),
  // A haul whose vein it found empty says so, and that the vein comes back (`vein-empty:ferro`), and one whose place is gone —
  // a cargo dropped on the field, all taken — of what (`vein-spent:ferro`), on its way home and stopped there; so does one given up for an enemy.
  ...Object.fromEntries(RAW_IDS.map(id => ['vein-empty:' + id, tr`jazida de ${tr(RAW[id])} vazia · recuperando`])),
  ...Object.fromEntries(RAW_IDS.map(id => ['vein-spent:' + id, tr`coleta de ${tr(RAW[id])} encerrada`])), 'enemy-near': tr('inimigo por perto: transporte interrompido'),
  'supplies-spent': tr('coleta de suprimentos encerrada'), 'haul-interrupted': tr('trajeto de coleta interrompido'),
  // An aircraft works on its skids (squad.ts `haul`): with no level ground by its vein, too heavy to take off, or short of the
  // fuel to come home, it stays; one whose tanks full do not take it to its vein and back stops at home.
  'no-landing': tr('sem chão plano para pousar no local'), 'too-heavy': tr('pesada demais para decolar · despeje parte da carga'),
  'fuel-home': tr('sem combustível para voltar · aguardando suprimento'), 'out-of-range': tr('jazida longe demais para o tanque · coleta encerrada'),
  // One that lost a thruster waits on its skids to be mended (squad.ts `crippled`).
  mending: THRUSTER_LOST.waiting });
const SPENT_ROUTES = ['vein-empty:', 'vein-spent:', 'supplies-spent:'];
// What keeps a vehicle where it is while its engine pushes, as its core tells it: the ground gives no grip, the ground is
// too soft for its weight, or the climb is more than it pulls. `row` is the word of it in the row of the vehicle, `news`
// what is said once as it comes about, and `advice` what to do about it, for one that carries a load and for one that does not.
const HELD = Object.freeze({
  grip: { row: 'patinando', news: tr('patina — o chão não dá aderência para ele seguir'), advice: () => tr('Patinando: este chão não dá aderência para ele seguir. Recue e tente outro caminho.') },
  ground: { row: tr('atolado'), news: tr('atolou — pesado demais para este chão'),
    advice: (loaded: boolean): string => tr('Atolado: pesado demais para este chão. ') + (loaded ? tr('Despeje parte da carga para sair.') : tr('Tente sair no outro sentido.')) },
  slope: { row: tr('sem força para a subida'), news: tr('sem força para a subida'),
    advice: (loaded: boolean): string => tr('Sem força para esta subida') + (loaded ? tr(' com a carga que leva: despeje parte dela ou contorne.') : ': recue e contorne.') } });
const SLOW_PING = 250; // milliseconds from which the connection is worth a word
// A vehicle whose fuel takes it less far than this many times the way to its base is told so, while it can still turn back.
// How far the fuel takes it is reckoned at a steady pace on the level: setting off and climbing burn more than that.
const FUEL_MARGIN = 2;
// The same trouble of the same vehicle is said again no sooner than this many seconds after it was said.
const NOTICE_REPEAT = 30;
const HELD_SECONDS = 2, HELD_PROGRESS = .5, HELD_GAP = 1;
const capital = (words: string): string => required(words[0]).toUpperCase() + words.slice(1);
// The jobs only a builder does (server/supply-dispatch.ts).
const BUILDS = new Set(['build', 'dismantle']);
// What the switch of a vehicle that works by itself does, as its title says it: what it does of what its faction has to do,
// by what it carries — a builder, a blade or a paver, supply pieces, or more than one of them. A road machine makes roads
// and nothing else, whatever supply pieces it carries (server/supply-dispatch.ts).
function automaticTitle(unit: UnitView, ability: ReturnType<typeof abilities> | undefined): string {
  const parts = [unit.builder && tr('monta as obras e desmonta as estruturas da facção'), unit.road && tr('faz as estradas pedidas pela facção'),
    unit.supplies && !unit.road && tr('repara e rearma a frota, leva às obras o material que falta e recolhe os montes, buscando na base só o necessário'),
    !unit.road && (ability?.solid || ability?.liquid || ability?.supply) && tr('recolhe cargas prontas conhecidas e as leva à base, sem escavar')].filter(Boolean);
  return tr('Faz sozinho o trabalho mais urgente e mais perto: ') + parts.join('; ') + tr('. Uma ordem sua o pausa até ser cumprida; Parar o desliga.');
}
// What the switch of the fuel return of an aircraft does (squad.ts `homing`), as its title says it, and as its line says it on
// and off.
const HOMING = Object.freeze({
  title: 'Ligada, a aeronave guarda combustível para voltar à base: volta sozinha quando só resta o da volta e recusa ordens que a deixariam sem ele. Desligada, cumpre toda ordem, mesmo até ficar sem combustível.',
  on: 'Volta sozinha para reabastecer e recusa ordens que a deixariam sem combustível para voltar.',
  off: 'Não volta sozinha para reabastecer: cumpre toda ordem, mesmo até ficar sem combustível.' } as const);
// The column of the player's constructions over the field, group by group: those that fight, those that work for the
// faction, and those that stay where they were built. Of what a vehicle is, these work.
export const COLUMN = Object.freeze(['attack', 'logistics', 'fixed'] as const);
const WORKERS = new Set(['supply', 'hauler', 'extractor', 'scout']);
// What a construction is held by while it is built or mended, which its place in the column shows with how far along it is.
const BUILDING = Object.freeze({ build: 'build', repair: 'repair' });

// Native grip can briefly fall short while the suspension settles at launch.
// Confirm that it keeps the vehicle in place; this page keeps one candidate per
// live vehicle, using frame time rather than timers or wall-clock pauses.
function groundHolds(memo: GroundHoldsMemo | null, state: FieldView | null, roster: FieldSquad | null, factionId: string | undefined, playerId: string | null, live: boolean): Set<string> {
  const held = new Set<string>();
  if (!memo) return held;
  const time = state?.time;
  if (!live || !finite(time) || memo.faction !== factionId || memo.player !== playerId ||
      finite(time) && finite(memo.time) && (time < memo.time || time - memo.time > HELD_GAP)) memo.pending = new Map();
  memo.pending ||= new Map(); memo.faction = factionId; memo.player = playerId; memo.time = time;
  const up = new Set<string>();
  for (const u of live && finite(time) ? roster?.units || [] : []) {
    if (u.defeated) continue;
    up.add(u.id);
    const actor = required(state).actors.find(a => a.id === u.id), v = actor?.vehicle, x = actor?.x ?? v?.x, direction = Math.sign(v?.throttle || 0);
    if (!actor || !finite(time) || !isHeldReason(v?.stuck) || !finite(x) || !direction || v.brake || dry(v) || v.gearCount === 0 || v.engine === false) {
      memo.pending.delete(u.id); continue;
    }
    let candidate = memo.pending.get(u.id);
    if (!candidate || candidate.revision !== actor.revision || candidate.reason !== v.stuck || candidate.direction !== direction || Math.abs(x - candidate.x) >= HELD_PROGRESS) {
      candidate = { revision: actor.revision, reason: v.stuck, direction, x, since: time }; memo.pending.set(u.id, required(candidate));
    }
    if (required(time) - required(candidate).since >= HELD_SECONDS) held.add(u.id);
  }
  for (const id of memo.pending.keys()) if (!up.has(id)) memo.pending.delete(id);
  return held;
}

interface FieldMembers { out(id: string): boolean; members: { id: string; x: number; name: string | undefined; foe: boolean }[] }
const fields = new WeakMap<FieldView, FieldMembers | null>();
// A construction of the field by name: one of the faction by its own, any other by its player's.
const identity = (a: DrawingActor, side: Standing) => ({ name: side === 'own' || side === 'ally' ? a.name : a.playerName || a.name, foe: side === 'enemy' });
// Who is on the shared field, as its frame tells it: the constructions of every player. Nothing when the
// player commands nobody there.
export function fieldOf(s: FieldView | null | undefined): FieldMembers | null {
  if (!s) return null;
  let found = fields.get(s);
  if (found !== undefined) return found;
  if (s.shared && s.squad) {
    const out = new Set(s.squad.out);
    // Only the constructions of other factions are enemies: a wreck is nobody's, and a faction's vehicles are friends.
    // A ghost is where something was last seen, not something to give an order about: it is nobody on the field.
    found = { out: (id: string): boolean => out.has(id),
      members: s.actors.filter(a => !a.ghost).map(a => ({ id: a.id, x: a.x, ...identity(a, standing(a, s)) })) };
  } else found = null;
  fields.set(s, found);
  return found;
}

const firing = (m: DrawingModule): boolean => typeof m.health === 'number' && m.health > 0 && m.attached !== false && !m.barrelDisabled;
const collectionEquipment = (pieces: readonly DrawingModule[]) => ({ solid: pieces.some(m => m.kind === 'hopper'), liquid: pieces.some(m => m.kind === 'cistern'),
  dig: pieces.some(m => m.kind === 'excavator'), pump: pieces.some(m => m.kind === 'drill') });
// What a vehicle can do, by the pieces the frame shows of it: the guns it has and how many still fire,
// the rounds left for each kind of those, and whether a hopper or a cistern of it still takes a load. Of guns that fire
// none, whether none of them has a box of its calibre (`boxless`), and if so whether it has boxes of another (`misfed`):
// the field fills the boxes a construction has, never with rounds of another calibre, and only a new project puts
// that right (game_construction.rs `WEAPON_UNFED`).
function abilities(pieces: readonly DrawingModule[]) {
  const guns = pieces.filter(m => m.kind === 'weapon'), sound = guns.filter(firing), boxes = pieces.filter(m => m.kind === 'ammo'),
    presets = [...new Set(sound.map(gun => cartridgeId(gun.weaponPreset || 'rh120')))],
    rounds = presets.map(preset => ammunitionSupply(pieces, preset).reduce((sum, m) => sum + (m.rounds || 0), 0)),
    boxless = presets.length > 0 && presets.every(preset => !boxes.some(box => (box.ammoPreset || 'rh120') === preset));
  return { guns: guns.length, firing: sound.length, rounds, fed: rounds.some(left => left > 0), boxless, misfed: boxless && boxes.length > 0,
    ...collectionEquipment(pieces.filter(firing)), supply: pieces.some(m => m.kind === 'supply' && firing(m)),
    installed: { ...collectionEquipment(pieces), supply: pieces.some(m => m.kind === 'supply') } };
}
// A vehicle is out of fuel when its engines say so.
// What its tanks take is told of those it still draws from.
const dry = (vehicle: DrawingVehicle | null | undefined): boolean => Boolean(vehicle?.fuelStarved);
const drawn = (m: DrawingModule): boolean => m.kind === 'fuel' && typeof m.health === 'number' && m.health > 0 && m.attached !== false && !m.detonated,
  tankRoom = (pieces: readonly DrawingModule[]): number => pieces.reduce((sum, m) => sum + (drawn(m) ? m.capacityLitres || 0 : 0), 0);

// `tab` is the tab the page is on, 'edit' or 'test'; `shared` and `connected` say whether that is the
// shared field and whether the field answers. `state` is the frame on screen, `faction` the faction as
// last told and `playerId` the player. `picked` are the vehicles chosen while commanding and `armed`
// the order waiting for its click; `focus` is the construction the workshop of the field would
// replace. `price` is the bill of the design on the bench, `commanded` whether it has a command post and `drives` whether it is a vehicle, `deposits` the sites of the field's ground,
// of which the faction says where it knows a vein (none while the ground at hand is not the field's), `pingMs`
// the delay of the connection. `touch` says the player
// points with a finger: what the panel says of the pointer, it says of the finger.
// `admissionReason` is the draft's translated mechanical refusal, passed through to its fabrication quote.
// `mobility` is the page's small progress memo, kept between frames to confirm physical stalls.
export function fieldPanel({ tab = 'test', shared = false, connected = false, state = null, faction = null, playerId = null,
  picked = [], armed = null, focus = null, price = null, commanded = true, drives = true, admissionReason = '', deposits = [], pingMs = 0, touch = false, mobility = null, instant = false }: FieldPanelOptions = {}) {
  // A squad of nobody is no squad: the faction has nothing there to command. Those it has are on the field whatever
  // the tab; they are commanded from the tab of the field, but for those another member holds (`by`).
  const field = shared ? fieldOf(state) : null, roster = field && required(required(state).squad).units.length ? required(required(state).squad) : null, squad = tab === 'test' ? roster : null,
    manual = squad?.units.find(u => u.id === squad.manual && !u.defeated) || null,
    chosen = squad && !manual ? squad.units.filter(u => picked.includes(u.id) && !u.defeated && !u.by) : [],
    // The one vehicle the panel speaks of: the one in hand, or the one picked alone.
    one = manual || (chosen.length === 1 ? chosen[0] : null),
    situation = !shared ? null : tab === 'edit' ? 'workshop' : !connected || !faction ? 'offline' : squad ? manual ? 'direct' : 'command' : 'empty',
    duelEnded = Boolean(faction?.duel && faction.duel.phase !== 'playing'),
    live = shared && connected && Boolean(faction), commanding = situation === 'command' && !duelEnded, direct = situation === 'direct' && !duelEnded,
    fieldTime = state?.shared && Number.isFinite(required(state).time) ? required(state).time : null,
    told = (id: string): UnitView | null => faction?.units.find((u: UnitView) => u.id === id) || null, member = (id: string) => required(field).members.find(p => p.id === id),
    vehicle = (id: string): DrawingVehicle | null | undefined => required(state).actors.find(a => a.id === id)?.vehicle,
    // On a field with fog a vehicle sees with its eyes, as the frame tells them of it: with none that sees out it sees nothing.
    sightless = (id: string): boolean => { const eyes = live && required(faction).explored ? required(state).actors.find(a => a.id === id)?.eyes : null; return eyes != null && !eyes.some(eye => eye.left > 0 || eye.right > 0); },
    pieces = new Map<string, DrawingModule[]>(roster?.units.map(u => [u.id, []])), plates = new Map<string, DrawingPlate[]>(roster?.units.map(u => [u.id, []]));
  for (const m of roster ? required(state).modules : []) pieces.get(m.actorId)?.push(m);
  for (const p of roster ? required(state).plates : []) if (p.actorId) plates.get(p.actorId)?.push(p);
  const can = new Map([...pieces].map(([id, list]) => [id, abilities(list)])),
    // Whoever of the vehicles spoken of has a hopper or a cistern that still takes a load: those haul.
    mobile = (u: PanelSquadUnit) => Boolean(vehicle(u.id)) && required(vehicle(u.id)).enabled !== false,
    // An aircraft (ui-model.ts `flies`).
    flier = (u: PanelSquadUnit) => (vehicle(u.id)?.thrustN ?? 0) > 0,
    // A structure stays where it was built: it extracts from the vein it stands on by itself, and is sent to none.
    fixed = (u: PanelSquadUnit) => !vehicle(u.id),
    // What a vehicle is: a supply vehicle — one with a supply piece that serves, as the faction is told (`serves`) —, one
    // that hauls, one that extracts, one with no gun that only looks, artillery or armour.
    kindOf = (u: PanelSquadUnit) => told(u.id)?.serves ? 'supply' : required(can.get(u.id)).solid || required(can.get(u.id)).liquid ? 'hauler' : required(can.get(u.id)).dig || required(can.get(u.id)).pump ? 'extractor' : !required(can.get(u.id)).guns ? 'scout' :
      u.role === 'artillery' ? 'artillery' : 'armor',
    // Where a construction stands in the column over the field (`COLUMN`): with those that fight; with those that work for the
    // faction — that mine, carry, supply or build, and those with no gun —; or with those that stay where they were built.
    // A construction is numbered by its place in the column, which is its key.
    groupOf = (u: PanelSquadUnit) => !vehicle(u.id) ? 'fixed' : WORKERS.has(kindOf(u)) || told(u.id)?.builder ? 'logistics' : 'attack',
    column = roster ? COLUMN.flatMap(group => roster.units.filter(u => groupOf(u) === group)) : [],
    number = (id: string): number => column.findIndex(u => u.id === id) + 1,
    movers = chosen.filter(mobile), shooters = chosen.filter(u => required(can.get(u.id)).guns > 0),
    equippedHolders = (manual ? [manual] : chosen).filter(u => {
      const equipment = required(can.get(u.id)).installed; return !fixed(u) && (equipment.solid || equipment.liquid || equipment.dig || equipment.pump || equipment.supply);
    }),
    holders = (manual ? [manual] : chosen).filter(u => {
      const ability = required(can.get(u.id)); return !fixed(u) && (ability.solid || ability.liquid || ability.dig || ability.pump || ability.supply);
    }),
    // The veins the faction knows of, and of those the ones the vehicles spoken of carry from: a hopper takes no petroleum.
    veins = live ? knownVeins(deposits, faction) : [], kinds = (material: CargoKind): boolean => holders.some(u => {
      const ability = required(can.get(u.id)); return CARGO[material].liquid ? ability.liquid || ability.pump : ability.solid || ability.dig;
    }),
    orderFor = (material?: CargoKind) => {
      const liquid = material && CARGO[material].liquid,
        available = holders.length ? holders.map(u => required(can.get(u.id))) : equippedHolders.map(u => required(can.get(u.id)).installed),
        extracts = available.some(ability => material ? ability[liquid ? 'pump' : 'dig'] : ability.dig || ability.pump),
        transports = available.some(ability => material ? ability[liquid ? 'liquid' : 'solid'] : ability.solid || ability.liquid),
        order = AT_VEIN[extracts ? transports ? 'collect' : 'extract' : 'haul'];
      return { name: order.name, label: order.label, hint: tr`num local de coleta conhecido (${order.description})`,
        title: capital(order.description) + '.', icon: order.icon };
    },
    accepts = (u: PanelSquadUnit, vein: KnownVein, installed = false): boolean => { const ability = installed ? required(can.get(u.id)).installed : required(can.get(u.id));
      if (vein.type === 'airdrop' && !mobile(u)) return false;
      if (vein.supplies) return billTotal(vein.supplies) > 0 && ability.supply;
      // A vein of the ground is worked whatever the faction last knew was left of it: it comes back. A cargo dropped on the
      // field has only its pile, for a container to take.
      const liquid = CARGO[vein.material].liquid, carries = ability[liquid ? 'liquid' : 'solid'];
      return vein.type === 'airdrop' ? finite(vein.stock) && vein.stock > 0 && carries : carries || ability[liquid ? 'pump' : 'dig']; },
    works = (vein: KnownVein) => (vein.supplies || kinds(vein.material)) && holders.some(u => accepts(u, vein)),
    lodes = veins.filter(works), workOrder = orderFor(),
    // A haul is ordered on a vein the faction knows of and no base stills: with none of what they carry, there is nowhere to send them.
    // A mixed selection stays selected. An order addresses only constructions with the relevant
    // equipment; empty fuel or ammunition does not discard an order that service can make useful.
    // Those the player holds go back to the faction: a release is offered, or refused, only where another member could take them.
    together = live && required(faction).members.length > 1, held = together ? chosen.filter((u: PanelSquadUnit) => u.reserved) : [],
    // A cable is for a faction with another vehicle on the field; one picked alone pulls, or lets go of the cable it is on.
    linked = chosen.filter(u => towOf(state, u.id)),
    partnered = Boolean(faction) && (state?.actors ?? []).filter(a => a.team === required(faction).id && a.vehicle && !a.ghost && !field?.out(a.id)).length > 1,
    towers = linked.length ? linked : partnered ? movers : [],
    // Parar stops what moves and what fires: a structure with no gun has nothing to stop.
    stoppable = chosen.filter(u => !fixed(u) || required(can.get(u.id)).guns > 0),
    compatible = { move: movers, turn: movers, home: movers, attack: shooters, bombard: shooters, haul: equippedHolders, tow: towers, stop: stoppable, free: held },
    recipients = { move: movers, turn: movers.filter(u => !told(u.id)?.service), home: movers,
      attack: shooters, bombard: shooters, haul: holders.filter(u => lodes.some(vein => vein.active && accepts(u, vein))),
      tow: chosen.length === 1 ? towers : [], stop: stoppable, free: held },
    applies = Object.fromEntries(ORDERS.map(order => [order.id, live && recipients[order.id].length > 0])),
    collectionReason = (() => {
      if (!equippedHolders.length) return chosen.every(fixed) ? FIXED : REFUSALS.haul;
      if (recipients.haul.length) return '';
      if (!holders.length || veins.some(vein => vein.active && equippedHolders.some(u => accepts(u, vein, true)))) return COLLECTION_BROKEN;
      const known = veins.filter(vein => vein.supplies ? holders.some(u => required(can.get(u.id)).supply) : kinds(vein.material));
      if (!known.length) return UNFOUND;
      if (!known.some(vein => vein.active)) return COLLECTION_BASE;
      return PILE_ONLY;
    })(),
    reasons = { ...REFUSALS, haul: collectionReason, turn: movers.length ? TURN_HELD : FIXED, tow: towers.length ? TOW_ONE : FIXED },
    refusal = (id: FieldOrderId): string => live ? reasons[id] : OFFLINE,
    flying = movers.filter(flier).length, moveHint = flying ? { hint: flying === movers.length ? MOVE_FLYING.all : MOVE_FLYING.some } : {},
    offered = (commanding || situation === 'offline') && chosen.length ? ORDERS.filter(order => compatible[order.id].length).map(order =>
      ({ ...order, ...(order.id === 'haul' ? workOrder : {}), ...(order.id === 'tow' && linked.length ? UNTOW : {}), ...(order.id === 'move' ? moveHint : {}),
        ids: applies[order.id] ? recipients[order.id].map(u => u.id) : [],
        // Of a cable for one of several picked, the button alone says why.
        disabled: !applies[order.id], reason: applies[order.id] ? '' : refusal(order.id),
        ...(order.id === 'tow' && live && !applies.tow ? { quiet: true } : {}) })) : [],
    pending = offered.find(order => order.id === armed),
    common = shooters.length && shooters.every(u => u.stance === required(shooters[0]).stance) ? required(shooters[0]).stance : null,
    // A vehicle of the faction in words: by its place in the column, or as of the faction before the column has it.
    named = (id: string): string => number(id) ? tr('veículo ') + number(id) : tr('veículo da facção'),
    unit = live && one ? told(one.id) : null,
    // Dismantling all those picked that may be, while the player commands them and the faction has told of them.
    quoted = live && commanding ? chosen.map(u => told(u.id)).filter((unit): unit is UnitView => unit !== null) : [],
    plan = quoted.length ? dismantlePlan(quoted, id => Boolean(towOf(state, id))) : null,
    base = live ? unitServices(unit, required(faction), { hand: direct, named }) : { jobs: [], held: '' },
    feedback = live ? serviceFeedback(unit, state?.time) : null,
    directTurn = Boolean(manual && (direct || situation === 'offline') && mobile(manual)),
    directTurnReason = directTurn ? !live ? OFFLINE : unit?.service ? TURN_HELD : '' : '',
    home = live && required(faction).base ? required(required(faction).base).x : null,
    // Where its vehicles are served: its base and its posts, the nearest of them to a place.
    served = home === null ? [] : [{ x: home, post: false }, ...(required(faction).posts ?? []).filter(post => !post.takedown).map(post => ({ x: post.x, post: true }))],
    nearest = (x: number | undefined): { x: number; post: boolean } | null => finite(x) ? served.reduce<{ x: number; post: boolean } | null>((best, place) => !best || Math.abs(place.x - x) < Math.abs(best.x - x) ? place : best, null) : null,
    holds = groundHolds(mobility, state, roster, faction?.id, playerId, live);
  // What is wrong with a vehicle that keeps it from its work: it cannot move, for want of fuel or of what it runs on,
  // or the ground holds it where it is; it cannot fire, for want of a gun or of rounds; it sees nothing, for want of an
  // eye that sees out; or its fuel will not take it much further than its base or the nearest post. Its tools at work stop for want of
  // fuel or of an engine (`tool`), where that is not said already, and the blade or the screed of a road machine that does
  // not reach the ground stops it where it stands (`reachless`); the share they work at is no trouble (`status`). `list`
  // is the words of it for the row of the vehicle, the gravest first; `away` how far it is from the nearest of its base and
  // its posts (`depot`) when it is in none. What the ground does to it is confirmed while its engine pushes, and told by the order that ended for it once
  // its driver gave up (`held`). An aircraft goes on its thrusters, with no wheels nor need of its engine: only with all
  // of them gone does it go nowhere.
  const wrong = (u: PanelSquadUnit) => {
    const v = vehicle(u.id), able = required(can.get(u.id)), x = member(u.id)?.x, depot = !told(u.id)?.atBase && !told(u.id)?.atPost ? nearest(x) : null,
      away = depot ? Math.abs(required(x) - depot.x) : null,
      empty = dry(v), stuck = !v || empty || typeof v.thrustN === 'number' && v.thrustN > 0 ? '' : pieces.get(u.id)?.some(m => m.kind === 'thruster') ? tr('propulsores destruídos') :
        v.gearCount === 0 ? tr('rodagem destruída') : v.engine === false ? tr('motor destruído') : '',
      held = !v || empty || stuck ? null : (u.reason?.startsWith('stuck-') ? u.reason.slice(6) : null) || (holds.has(u.id) ? v.stuck : null),
      gun = !able.guns ? '' : !able.firing ? able.guns > 1 ? tr('armas inutilizadas') : tr('arma inutilizada') : able.fed ? '' :
        able.misfed ? MISFED : able.boxless ? BOXLESS : tr('sem munição'),
      // An aircraft goes home for its fuel by itself (squad.ts `homeward`): its range on the ground is none of it.
      blind = sightless(u.id), low = !empty && !stuck && away !== null && v?.rangeKm != null && !(typeof v.thrustN === 'number' && v.thrustN > 0) && v.rangeKm * 1000 < FUEL_MARGIN * away,
      tools = told(u.id)?.tools, tool = !tools || 'pace' in tools && tools.pace !== undefined || tools.limit === 'fuel' && empty || tools.limit === 'engine' && stuck ? '' : toolText(tools),
      reachless = tools?.limit === 'ground';
    return { dry: empty, stuck, held, gun, blind, low, away, depot, x, tool, reachless, blocked: u.haul?.blocked === 'blocked-way',
      halted: empty || Boolean(stuck) || Boolean(held) || Boolean(u.haul?.blocked) || reachless,
      list: [empty ? tr('sem combustível') : '', stuck ? tr('sem mobilidade · ') + stuck : '', held ? HELD[requiredHeld(held)].row : '', u.haul?.blocked === 'blocked-way' ? tr('caminho de volta bloqueado') : '',
        tool, gun, blind ? tr('sem visão') : '', low ? tr`combustível para ${km(v.rangeKm)} · ${required(depot).post ? 'posto' : 'base'} a ${metres(away)}` : ''].filter(Boolean) };
  }, ills = new Map(roster?.units.filter(u => !u.defeated).map(u => [u.id, wrong(u)]));

  // The share of their pace the tools of a construction work at, while they work (`toolText`).
  const capacity = (u: PanelSquadUnit) => told(u.id)?.tools && 'pace' in required(told(u.id)?.tools) ? toolText(required(told(u.id)).tools) : '';
  // What a vehicle under orders is doing, in one line: its order, the share its tools work at, how full it is when it
  // carries, the damage it has, and what its senses or its way last told. A fresh contact says more than the gun's silence
  // does; a vehicle with no gun says nothing of guns, and one not sent to attack nothing of having no enemy in sight.
  // A vehicle on its way: how far it has to go, and of an aircraft the height over the ground it was sent to there or that
  // it goes to land, for its fuel or as it was told (squad.ts `land`); of one sent home, that it goes to the base, or the post.
  const moving = (move: NonNullable<SquadUnitView['move']>, x: number): string => {
    const left = Math.abs(move.x - x), far = left > 3 ? 'faltam ' + metres(left) : '';
    if (move.land) return [Object.entries(LANDING).find(([reason]) => reason === move.land)?.[1] || tr('indo pousar'), far].filter(Boolean).join(' · ');
    if (move.home) return [nearest(move.x)?.post ? tr('voltando ao posto') : tr('voltando à base'), far].filter(Boolean).join(' · ');
    return [tr('em movimento'), far, Number.isFinite(move.height) ? 'a ' + metres(move.height) + tr(' do chão') : ''].filter(Boolean).join(' · ');
  };
  const status = (u: PanelSquadUnit) => {
    const x = member(u.id)?.x ?? 0, quote = told(u.id), job = quote?.job, guns = required(can.get(u.id)).guns;
    if (u.defeated) return tr('fora de combate');
    if (quote?.service) return serviceText(quote.service, required(state).time ?? 0);
    // What is wrong comes first: the line is cut where the row ends. A vehicle that cannot move is not on its way anywhere,
    // and one by its deposit that was hit takes nothing on until the fight has left it alone.
    const ill = required(ills.get(u.id)), ability = required(can.get(u.id)),
      target = u.attack?.targetId ? member(u.attack.targetId) : null, kept = u.haul?.phase === 'load' && quote && !quote.loading && !quote.calm,
      hauling = u.haul && haulText(u.haul, quote, { extracts: !u.haul.depositId?.startsWith('airdrop:') && (ability.dig || ability.pump),
        carries: ability.solid || ability.liquid || Boolean(u.haul.refined && ability.supply), time: required(state).time, post: Boolean(nearest(x)?.post) }),
      // What it does by itself, a builder at work or a job (`working`), comes before anything it was told: a builder on its way
      // says how far it has to go.
      doing = working(quote), going = ill.halted ? '' : doing ? doing + (u.move && job?.phase === 'go' && job.kind && BUILDS.has(job.kind) ? ' · faltam ' + metres(Math.abs(u.move.x - x)) : '') :
        u.haul ? kept ? hauling + tr(' · interrompido pelo combate') : hauling :
        u.move ? moving(u.move, x) : cargoWorkText(quote?.cargoWork, required(state).time) || (quote?.extracting ? tr('extraindo na jazida') : ''),
      parts = [...ill.list, going, capacity(u),
        u.attack?.targetId ? 'atacando ' + (target?.name ? tr('o veículo de ') + target.name : 'o alvo') : '',
        u.attack?.point ? 'bombardeio a ' + metres(Math.abs(u.attack.point.x - x)) : '',
        // What it answers on its own: the fire its base placed.
        u.counter ? 'contrafogo a ' + farText(u.counter.x, x) : ''].filter(Boolean);
    if (!parts.length) parts.push(!guns ? tr('parado') : Object.entries(POSTURES).find(([stance]) => stance === u.stance)?.[1] || tr(STANCES[u.stance].name).toLowerCase());
    // Why its way ended is said once: not again after its job, which may have said it already.
    const silent = guns && !ill.gun && (u.attack || u.reason !== 'search-contact') ? Object.entries(GUNS).find(([reason]) => reason === u.reason)?.[1] : '',
      way = ill.halted || required(going).includes(String(Object.entries(WAYS).find(([reason]) => reason === u.reason)?.[1])) ? '' : Object.entries(WAYS).find(([reason]) => reason === u.reason)?.[1];
    return [...parts, u.haul && !ill.halted ? '' : cargoText(quote), damageText(quote), u.heard ? heardText(u.heard, x) : silent || way].filter(Boolean).join(' · ');
  };
  // The vehicle in the player's hands says what is wrong with it, and the share its tools work at: its fuel and its damage
  // are in its gauges.
  const driving = (u: PanelSquadUnit) => {
    if (told(u.id)?.service) return status(u);
    const ill = required(ills.get(u.id));
    return [[ill.dry && tr('sem combustível'), ill.stuck && tr('sem mobilidade · ') + ill.stuck, ill.held && HELD[requiredHeld(ill.held)].row, ill.tool, ill.gun, ill.blind && tr('sem visão'), ill.low ? (required(ill.depot).post ? 'posto a ' : 'base a ') + metres(ill.away) : '', cargoWorkText(told(u.id)?.cargoWork, required(state).time)].filter(Boolean).join(' · ') || tr('sob seu controle'), capacity(u)].filter(Boolean).join(' · ');
  };
  // What it is doing, in a word: held by a service, in the player's hands, stopped by what is wrong with it, or at its order.
  // One with nothing to do has none.
  const doing = (u: PanelSquadUnit) => u.defeated ? 'out' : told(u.id)?.service?.kind || (u === manual ? 'manual' : required(ills.get(u.id)).halted ? 'halted' :
    told(u.id)?.extracting ? 'extract' : u.haul ? 'haul' : u.attack || u.counter || u.activity?.includes('firing') ? 'fire' : u.move ? 'move' : '');
  // The one vehicle spoken of, at a glance: its fuel and how far that takes it, its rounds, what it carries and how whole
  // it is. Each that it has is a few words, a share for its gauge and the whole of it in a title; one that runs short is marked.
  // A structure with a tank tells what the tank holds, and it takes it nowhere: what the tank takes, less what the field
  // says it lacks to fill it (`rearm`). The page is not told the fuel of each tank (server/publication.ts).
  const vitals = (u: PanelSquadUnit) => {
    const v = vehicle(u.id), able = required(can.get(u.id)), ill = required(ills.get(u.id)), room = tankRoom(required(pieces.get(u.id))), quote = told(u.id),
      rounds = able.rounds.map(count).join(' + '), lost = damaged(quote), held = Math.max(0, room - (quote?.rearm?.combustivel ?? room));
    return {
      fuel: v?.fuelLitres != null ? { share: room ? Math.min(1, v.fuelLitres / room) : 1, low: ill.dry || ill.low,
        text: ill.dry ? tr('sem combustível') : `${count(v.fuelLitres)} L` + (typeof v.thrustN === 'number' && v.thrustN > 0 ? '' : ` · ${km(v.rangeKm ?? 0)}`),
        title: (room ? tr`Combustível ${count(v.fuelLitres)} L de ${count(room)} L` : tr`Combustível ${count(v.fuelLitres)} L`) +
          (typeof v.thrustN === 'number' && v.thrustN > 0 ? '' : tr` · autonomia ${km(v.rangeKm ?? 0)}`) } :
        room ? { share: Math.min(1, held / room), low: quote?.tools?.limit === 'fuel', text: held > .5 ? `${count(held)} L` : tr('sem combustível'),
          title: tr`Combustível ${count(held)} L de ${count(room)} L` } : null,
      rounds: !able.guns ? null : { low: !able.fed, text: !able.firing ? able.guns > 1 ? tr('armas inutilizadas') : tr('arma inutilizada') : able.misfed ? tr('outro calibre') : rounds,
        title: !able.firing ? tr('Nenhuma arma dispara') : able.misfed ? tr('As caixas são de outro calibre: nenhuma arma usa a munição delas') :
          tr`Munição ${rounds}${able.rounds.length > 1 ? tr(', uma conta por calibre') : ''}` },
      cargo: able.solid || able.liquid || quote && loadTotal(quote.cargo) > 0 ? cargoGauge(quote) : quote?.mix ? { ...mixGauge(quote), label: tr('Mistura de asfalto') } : null,
      supplies: quote?.supplies ? suppliesGauge(quote) : null,
      whole: quote ? { share: 1 - lost / 100, low: lost > 50, text: 100 - lost + '%', title: lost ? tr`Integridade ${100 - lost}% · ${damageText(quote)}` : tr('Integridade 100%: nada avariado') } : null,
    };
  };
  // What to do about the gravest of what is wrong with the one vehicle spoken of, in a line. The base fuels, arms and
  // mends, and so does a supply vehicle wherever it is brought, out of its supply pieces — in part, where they do not
  // pay for the whole of a repair. At a point that serves it the line says where to ask, when that is asked for: service that comes by
  // itself needs no telling, and where it does not come the line of the services says why. Away from any, it says
  // how far the base is, and that a vehicle that cannot get there is served where it stands. Filling up and mending are
  // said where the field does each (`point`, `mender`). A supply vehicle that carries fuel fuels itself and arms itself
  // with nothing; it is mended as any other, by another one beside it.
  // The last construction of a faction that cannot pay for an ore lorry has nobody to bring it anything: it is told so (`stranded`).
  // A vehicle the ground holds is not mended: it is made lighter, where it carries a load, or driven another way.
  const ill = one ? required(ills.get(one.id)) : null, where = ill?.away != null ? `a ${metres(ill.away)} ${way(required(ill.depot).x, required(ill.x))}` : '',
    // What serves it nearest, in words: its base, or a post.
    nearer = ill?.depot?.post ? 'o posto' : 'a base',
    stranded = live && required(faction).count === 1 && Boolean(required(faction).recovery?.lorry),
    own = unit?.point != null && unit.point.supplier === unit.id,
    // Where a point serves it, in words: beside a supply vehicle, or in the base or a post.
    at = (point: UnitView['point'] | UnitView['mender'] | undefined): string => !point ? '' : point.supplier ? tr`com os suprimentos do ${named(point.supplier)}` : unit?.atPost ? tr('nos serviços do posto') : tr('nos serviços da base'),
    here = own ? '' : at(unit?.point), mends = at(unit?.mender),
    // A manual vehicle is mended by its base too; away from it, or after cancelling there, the repair is asked for.
    mended = repairNeedsOrder(unit, direct),
    brought = unit?.supplies ? tr('outro veículo de suprimentos') : tr('um veículo de suprimentos'), OR = `ou ${brought}`,
    advice = !live || !ill || unit?.service ? '' :
      ill.dry ? own || here ? '' :
        stranded ? strandedText(tr('Sem combustível')) : tr`Sem combustível: leve até ele ${brought}. ${capital(nearer)} está ${where}.` :
      ill.stuck ? mends ? mended ? tr`${capital(ill.stuck)}: repare aqui, ${mends}.` : '' :
        stranded ? strandedText(tr`Não anda mais (${ill.stuck})`) : tr`Não anda mais (${ill.stuck}): leve até ele ${brought}, que o repara ali. ${capital(nearer)} está ${where}.` :
      ill.held ? HELD[requiredHeld(ill.held)].advice(unit != null && loadTotal(unit.cargo) > 0) :
      ill.gun === tr('sem munição') ? here ? '' : tr`Sem munição: ${nearer} remunicia, ${where}, ${OR}.` :
      ill.gun === MISFED || ill.gun === BOXLESS ? unfedAdvice(ill.gun, fixed(required(one))) :
      ill.gun ? mends ? mended ? tr`${capital(ill.gun)}: repare aqui, ${mends}.` : '' : `${capital(ill.gun)}: ${nearer} repara, ${where}, ${OR}.` :
      ill.blind ? tr('Sem visão: nenhuma câmera dele vê para fora. Não vê o chão nem quem está ao lado.') :
      ill.low ? tr`O combustível mal dá para a volta: ${nearer} está ${where}.` :
      unit && !mends && damageText(unit) ? `${capital(damageText(unit))}: ${nearer} repara, ${where}, ${OR}.` :
      jobAdvice(unit, { work: required(faction).works?.find(work => work.id === unit?.job?.targetId) ?? null });
  // The one mark a construction bears in the column, when it is worth one: built or mended, with when that ends; taken
  // down, with how far that has gone; in the player's hands; out of fuel; held by the ground or with no way to move; or firing.
  const mark = (u: PanelSquadUnit) => {
    const service = told(u.id)?.service;
    if (u.defeated) return { mark: '', until: null, progress: null };
    if (service?.kind === 'dismantle') return { mark: 'dismantle', until: null, progress: service.progress };
    if (service && (service.kind === 'build' || service.kind === 'repair')) return { mark: BUILDING[service.kind], until: service.until, progress: null };
    const ill = required(ills.get(u.id));
    return { mark: u === manual ? 'manual' : ill.dry ? 'dry' : ill.held || ill.stuck ? 'stuck' : doing(u) === 'fire' ? 'fire' : '', until: null, progress: null };
  };
  // What a builder works on now, in a few words (server/field-construction.ts): putting up a works of the faction, or taking
  // down a structure, with how far that has gone. Nothing for one that does neither.
  const opened = faction?.works || [], labour = (builder: NonNullable<UnitView['builder']>): string => {
    const work = opened.find(w => w.id === builder.working), down = !work && builder.working ? told(builder.working) : null;
    return work ? `montando ${work.name} · ${percentText(work.progress)}` :
      builder.working ? `desmontando ${member(builder.working)?.name || tr('uma estrutura')}` + (down?.service?.kind === 'dismantle' ? ' · ' + percentText(down.service.progress) : '') : '';
  };
  // What a job is for, in words: a works or a structure by its name, a vehicle by its place in the column, a site by where it
  // lies from the base.
  const site = (id: string) => veins.find(vein => vein.id === id), aim = (id: string): string => opened.find(w => w.id === id)?.name ||
    (told(id)?.vehicle === false ? member(id)?.name || '' : number(id) ? named(id) :
      site(id) ? (required(site(id)).type === 'airdrop' ? 'airdrop' : 'jazida') + (home === null ? '' : tr` a ${farText(required(site(id)).x, home)} da base`) : '');
  // What a construction does by itself now, in one line: what its builder works on, or else its job (`jobText`) — held by the
  // player, by what (`paused`), which its row says nothing of.
  const working = (quote: UnitView | null, paused = false): string => {
    const building = quote?.builder && labour(quote.builder), job = quote?.job;
    if (building) return building;
    if (!job || !paused && job.phase === 'paused') return '';
    // An idle dispatcher is not a stopped pilot. The retained move is a published squad order; its purpose is unknown.
    if (quote.auto === true && job.phase === 'idle' && !job.reason && roster?.units.some(u => u.id === quote.id && u.move))
      return paused ? tr('seguindo trajeto') : ''; // The general row already says movement and remaining distance.
    return jobText(quote, { name: aim });
  };
  // And a builder's block: what it works on, or why it may not build now, or, beside a works, that it waits for its material.
  // One in automatic says what it does in the line of its switch, and its block says nothing of it then.
  const building = (u: PanelSquadUnit, builder: NonNullable<UnitView['builder']>): string => {
    const quote = told(u.id), doing = labour(builder), x = member(u.id)?.x, waits = finite(x) && opened.find(w => w.waiting && Math.abs(w.x - x) <= builder.reach + 10);
    if (typeof quote?.auto === 'boolean' && working(quote) && quote.job?.phase !== 'idle') return '';
    return doing ? capital(doing) : builder.reason || (waits ? [tr`Esperando material para ${required(waits.name)}`, workMaterialsText(waits)].filter(Boolean).join(' · ') : '');
  };
  // A structure of the player taken down, where it stands or to be moved elsewhere (Mais ações): how far that has gone and
  // whether a builder does it now, which may be cancelled (faction-ux.ts).
  const dismantling = (u: PanelSquadUnit) => {
    const down = required(told(u.id)).service;
    return down?.kind !== 'dismantle' ? null : { actorId: u.id, moving: Boolean(down.to), progress: down.progress,
      text: (down.to ? tr('Desmontando para a mudança · ') : 'Desmontando · ') + percentText(down.progress) +
        (down.building ? tr(' · braço construtor trabalhando') : down.sent ? ' · construtor ' + comingText(down.sent) : tr` · aguardando um braço construtor trabalhar a até ${BUILD_REACH} m`) };
  };
  // How the column draws a construction (squad-ux.ts): how damaged each of its pieces is that is, by its id in the design
  // (part-view.ts `damageTone`); and its hairline, the share of what the tanks it still draws from take that they hold — of a
  // structure, what they take less what filling them costs, as its gauge says (`vitals`) —, with whether they are dry or run
  // as low as the field sends a supply vehicle to them for (`fuelLow`, server/supply-dispatch.ts `runsLow`). One with no
  // tank has no hairline, nor one lost, nor a structure the faction has not told of yet.
  const damage = (u: PanelSquadUnit) => {
    const actor = !u.defeated && required(state).actors.find(a => a.id === u.id), tones: Record<string, Exclude<ReturnType<typeof damageTone>, ''>> = {};
    if (actor) for (const part of [...required(plates.get(u.id)), ...required(pieces.get(u.id))]) { const tone = damageTone(part); if (tone) tones[String(detailPartId(part, actor))] = tone; }
    return tones;
  };
  const gauge = (u: PanelSquadUnit) => {
    const list = required(pieces.get(u.id)), v = vehicle(u.id), quote = told(u.id), room = tankRoom(list);
    if (u.defeated || !list.some(m => m.kind === 'fuel') || !v && !quote) return null;
    const held = v ? v.fuelLitres ?? 0 : Math.max(0, room - (required(quote).rearm?.combustivel ?? room));
    return { share: room ? Math.min(1, held / room) : 0, level: !room || (v ? dry(v) || !(held > 0) : held <= .5) ? 'empty' : quote?.fuelLow ? 'low' : '' };
  };
  // One another member holds is theirs while they do (`held`, their name); one nobody holds is anybody's of the faction.
  const row = (u: PanelSquadUnit) => {
    const p = member(u.id), own = u === manual;
    return { id: u.id, number: number(u.id), name: p?.name || tr('Veículo'), held: u.by?.name ?? '', kind: kindOf(u), group: groupOf(u), ...mark(u), doing: doing(u), mobile: mobile(u),
      defeated: Boolean(u.defeated), selected: chosen.includes(u), manual: own, alert: !u.defeated && Boolean(u.alert), heard: !u.defeated && Boolean(u.heard),
      // What is wrong with a vehicle marks its row, but for one the base is already mending.
      trouble: !u.defeated && !told(u.id)?.service && required(ills.get(u.id)).list.length > 0,
      damage: damage(u), fuel: gauge(u), status: own ? driving(u) : status(u),
      feedback: live && !u.defeated ? serviceFeedback(told(u.id), required(state).time) : null };
  };

  const page = factionPage(live ? faction : null, playerId, state?.time ?? 0),
    place = focus ? number(focus) : 0, replaced = situation === 'workshop' && focus ? told(focus) : null;
  // Finished matches keep the information at each site, without commands on
  // their cards. The server also rejects these actions after the result.
  const siteRows = <Row extends { cancel: unknown }>(rows: Row[]) => duelEnded ? rows.map(({ cancel: _cancel, ...row }) => row) : rows;
  return {
    situation,
    // The connection is worth a line only when it is slow or lost.
    connection: !shared ? '' : !connected ? tr('Sem conexão com o campo: reconectando…') : pingMs > SLOW_PING ? tr`Conexão lenta · ${Math.round(pingMs)} ms` : '',
    // Nothing of the player's on the field: the panel says so and points to the workshop; of a faction with no base, it
    // says that instead. Where the aid is offered — to a faction with no base, or with nothing on the field and less in its
    // stocks than an ore lorry costs — it says what it would be, and its button what to ask: a base, or the lorry.
    empty: situation === 'empty', emptyText: situation === 'empty' ? emptyText(required(faction)) : '',
    recovery: situation === 'empty' && required(faction).recovery?.offered ? recoveryText(required(required(faction).recovery)) : '',
    recover: situation === 'empty' && required(faction).recovery?.offered ? required(required(faction).recovery).base ? tr('Estabelecer base') : tr('Pedir auxílio') : '',
    // The design has its block wherever it is worked on.
    project: tab === 'edit',
    squad: squad && { title: manual ? tr('CONTROLE DIRETO') : tr('ESQUADRÃO'), tag: chosen.length ? `${chosen.length} selecionado${chosen.length > 1 ? 's' : ''}` : '',
      note: !chosen.length || movers.length === chosen.length ? '' : !movers.length ? chosen.length === 1 ? tr('Estrutura · permanece no local.') : tr('Estruturas · permanecem no local.') :
        `${movers.length} ${movers.length === 1 ? tr('móvel') : tr('móveis')} · ${chosen.length - movers.length} ${chosen.length - movers.length === 1 ? 'estrutura' : 'estruturas'}`,
      units: column.map(row) },
    orders: duelEnded ? [] : offered.map(order => ({ ...order, active: order.id === armed && !order.disabled })),
    refused: Object.fromEntries(ORDERS.filter(order => !applies[order.id] && (order.id !== 'free' || together) && (order.id !== 'tow' || partnered))
      .map(order => [order.id, refusal(order.id)])),
    // Whether service comes by itself to the player's constructions: a switch of whoever commands the squad of the field.
    // The order waiting for its click, by name, and where that goes: the buttons of the orders are only marks.
    armed: pending?.disabled ? tr`${pending.name} indisponível · ${pending.reason}` : pending?.hint ? `${pending.name} · ${pending.ids.length === chosen.length ? tr`${pending.ids.length} veículo${pending.ids.length > 1 ? 's' : ''}` : `${pending.ids.length} de ${chosen.length} selecionados`}: ${touch ? 'toque' : 'clique'} ` +
      pending.hint + (touch ? '' : tr(' · Esc cancela')) : '',
    stances: commanding && shooters.length ? Object.entries(STANCES).map(([id, stance]) => ({ id, name: tr(stance.name), help: tr(stance.help), active: id === common })) : null,
    control: commanding && chosen.length === 1, release: direct,
    controlTitle: one && !mobile(one) ? tr('Opere esta estrutura sem deslocá-la.') : tr('Conduza e opere as armas desta construção.'),
    // The vehicle in hand turns about by a button of its own: the orders are the squad's.
    turn: directTurn, turnDisabled: Boolean(directTurnReason), turnReason: directTurnReason,
    // The vehicle picked alone, or the one in hand, at a glance.
    stats: one && (commanding || direct) ? vitals(one) : null, advice: duelEnded ? tr('Resultado definitivo. As ações do campo foram encerradas.') : advice,
    // The guns of the vehicle in hand have their block only when it has one: a gun shot away still has its state to tell.
    weapon: direct && required(can.get(required(manual).id)).guns > 0,
    services: duelEnded ? [] : base.jobs, held: base.held || feedback?.text || '',
    // Only a single vehicle that works by itself has this switch: a group, or any other vehicle, never acquires an automatic
    // order by changing selection. Its line says what it does now. In hand, it says whether it goes back to work once let go.
    automatic: live && !duelEnded && one && typeof unit?.auto === 'boolean' ? { actorId: one.id, on: unit.auto, status: working(unit, true), title: automaticTitle(unit, required(can.get(one.id))) } : null,
    // An aircraft picked alone, or in hand, has the switch of its fuel return, and its line says what it does (`HOMING`).
    homing: live && !duelEnded && one && typeof unit?.homing === 'boolean' ? { actorId: one.id, on: unit.homing, status: tr(HOMING[unit.homing ? 'on' : 'off']), title: tr(HOMING.title) } : null,
    // A builder goes by itself to what its faction has for it to do: its block says what it is at (faction-ux.ts). A works is
    // opened from the workshop, with any fixed design.
    builder: live && one && unit?.builder ? { status: building(one, unit.builder) } : null,
    // What the faction may raise and ask for on the field from the Infraestrutura page: a post and roads (infrastructure-ux.ts).
    infrastructure: live && !duelEnded ? infrastructureOffer(faction) : null,
    dismantling: live && !duelEnded && one && unit ? dismantling(one) : null,
    // What is done to what is picked (`ACTIONS`): a copy of the design and abandoning it, of one picked alone — abandoned only
    // away from its base —; moving it elsewhere, of a structure picked alone and not being taken down, held by another service
    // as dismantling it would be; dismantling, of all those picked that may be, how many on its button when several are picked.
    actions: !plan ? [] : ACTIONS.filter(({ id }) => (!duelEnded || id === 'copy') && (id === 'dismantle' || Boolean(unit) &&
      (id === 'copy' || (id === 'relocate' ? !required(unit).vehicle && required(unit).service?.kind !== 'dismantle' : !required(unit).atBase)))).map(action =>
      action.id === 'dismantle' ? { ...action, ...plan, label: chosen.length > 1 ? `${action.name} (${plan.ids.length})` : action.name, disabled: !plan.ids.length } :
      action.id === 'relocate' ? { ...action, disabled: Boolean(plan.reason), reason: plan.reason } : { ...action, disabled: false, reason: '' }),
    // A vehicle is fabricated at the base, or replaces one of the player's there; a structure is a works opened on the field.
    publish: situation === 'workshop' ? drives ? publishQuote({ price: required(price), faction, unit: replaced, connected, commanded, admissionReason: duelEnded ? tr('O duelo terminou. O resultado é definitivo.') : admissionReason, instant,
      name: replaced ? (place ? place + '. ' : '') + (state?.actors.find(a => a.id === focus)?.name ?? tr('o veículo')) : '' }) :
      obraQuote({ price: required(price), faction, connected, commanded, admissionReason: duelEnded ? tr('O duelo terminou. O resultado é definitivo.') : admissionReason, instant }) : null,
    // The veins the faction knows of, each as the card by its mark tells it; and, while the player commands, what the button
    // over it orders those picked that work it (`collect`): a vein no base stills, with something left to dig, or to load of
    // what they carry — a hopper takes no petroleum.
    veins: live ? veinRows(veins, home, fieldTime).map((row, i) => {
      const vein = required(veins[i]), ids = commanding && vein.active ? holders.filter(u => accepts(u, vein)).map(u => u.id) : [],
        order = vein.type === 'airdrop' ? { ...AT_VEIN.haul, title: vein.supplies ?
          tr('Transporta os recursos refinados em peças de Suprimentos para o estoque da base.') : tr('Transporta a carga à base, sem precisar extrair.') } : orderFor(vein.material);
      return { ...row, collect: ids.length ? { ids, name: order.name, label: order.label, title: order.title, icon: order.icon } : null };
    }) : [],
    // The wrecks on the field, each as the card by its mark tells it. One of the vehicles spoken of within reach of a wreck
    // works on it by the button over it (`salvage`) — for a wreck that is only its load, one with a hopper or a cistern for
    // it —, a button held while a construction by it is in combat; and with none, the card says how to come to that: of
    // one of them in the air by it, to land, and of one that drives by it, to stop — the field gives a wreck only to one
    // that stands still on the ground (server/room.ts `reaching`).
    wrecks: live ? wreckRows(faction, state?.time ?? 0).map(w => {
      const takes = (u: PanelSquadUnit): boolean => !w.stripped || RAW_IDS.some(id => w.cargo[id] > 0 && required(can.get(u.id))[CARGO[id].liquid ? 'liquid' : 'solid']),
        by = (manual ? [manual] : chosen).filter(u => Math.abs((member(u.id)?.x ?? Infinity) - w.x) <= SALVAGE_REACH && takes(u)),
        salvage = !duelEnded && by.length && (w.inReach || w.calmIn > 0) ? { ...w.work, disabled: !w.inReach, ...(w.inReach ? {} : { title: w.hint }) } : null,
        hint = salvage ? w.hint : by.some(u => told(u.id)?.aloft) ? LAND_BY_WRECK : by.some(u => told(u.id) && !required(told(u.id)).still) ? STOP_BY_WRECK : w.hint;
      return { id: w.id, x: w.x, name: tr('Destroços · ') + w.name, lines: duelEnded || salvage && !salvage.disabled ? w.lines : [...w.lines, hint], salvage };
    }) : [],
    // The works, the heaps and the roads asked for of the faction, each as the card by its mark tells it: no other faction is
    // told of them.
    works: live ? siteRows(workRows(faction)) : [], heaps: live ? heapRows(faction) : [],
    roads: live ? siteRows(roadRows(faction)) : [], posts: live ? siteRows(postRows(faction)) : [],
    // The page of the faction (`factionPage`): the nations of the field by their wealth, its members, the invitations the
    // player has and whoever may be invited.
    faction: page,
    // What is watched from one look to the next, for what must be said once when it comes about (`fieldNotices`): who
    // of the faction the player holds or nobody does — another member hears of those they hold —, what is wrong with each, who is under repair or had one cancelled, who is turning about and which way each faces,
    // and what was left of those that are gone;
    // and of the faction the player is in, when it last lost its base and when it last recovered, with the words for each, whether its base
    // is being taken and the last base it took, the factions it has met, with when each last lost its base,
    // and the veins it knows of, each by its material and where it lies from the base — nothing of them while the ground at hand is not the
    // field's, nor while the faction has no base (`veins` is null); and of the haulers, what became of a haul whose vein it found empty, whose
    // place is gone or that was given up for an enemy close by (`hauls`): the hauler goes home and stays there; and the guns the watch of its base holds by
    // their fire (`batteries`), each by where it is from the base and by which of the radar and the ears of the base.
    // A player left with nobody is still watched: the last vehicle to go is told of like any other.
    watch: roster || live ? watched() : null,
  };
  interface WatchContact { id: string; text: string; shared?: boolean; event?: string | undefined; x?: number | undefined; approximate?: boolean }
  function watched() {
    const label = (u: PanelSquadUnit): string => tr`Veículo ${number(u.id)} · ${member(u.id)?.name || tr('Veículo')}`, all = roster?.units || [], up = all.filter(u => !u.defeated && !u.by),
      ownX = (id: string): number | undefined => finite(member(id)?.x) ? required(member(id)).x : vehicle(id)?.x;
    // A page that does not know yet all a look needs — the faction, and each vehicle of the squad in the frame, with its parts — looks in part.
    return { partial: !live || fieldTime === null || up.some(u => !required(state).actors.some(a => a.id === u.id) || !pieces.get(u.id)?.length),
      faction: live ? required(faction).id : null, fell: live && required(faction).fell ? { at: required(required(faction).fell).at, text: fellText(required(faction)) } : null,
      recovered: live && required(faction).recovered ? { at: required(required(faction).recovered).at, base: required(required(faction).recovered).base !== null, text: recoveredText(required(faction)) } : null,
      // Whether another member took the player out of the faction the player was in, with the words for it.
      removed: live && required(faction).removed ? { at: required(required(faction).removed).at, text: removedText(required(faction)) } : null,
      // Whether another faction is taking the base of the faction, and the last base the faction took, with the words for it;
      // of its posts, those another faction is taking, and the last it lost and the last it took, with the words for each.
      siege: live && Boolean(required(faction).siege), taken: live && required(faction).taken ? { at: required(required(faction).taken).at, text: takenText(required(faction)) } : null,
      sieges: live ? (required(faction).posts ?? []).filter(post => post.siege).map(post => post.id) : [],
      lost: live && required(faction).lost ? { at: required(required(faction).lost).at, text: lostText(required(faction)) } : null,
      seized: live && required(faction).seized ? { at: required(required(faction).seized).at, text: seizedText(required(faction)) } : null,
      met: live ? required(faction).known.map(f => ({ id: f.id, name: factionName(f), defeated: f.defeated })) : [],
      veins: live && deposits.length && home !== null ? veins.filter(vein => vein.type !== 'airdrop').map(vein => ({ id: vein.id, name: tr(RAW[vein.material]), where: 'a ' + farText(vein.x, home) })) : null,
      activity: live && fieldTime !== null && required(faction).activity ? { id: required(required(faction).activity).id, x: required(required(faction).activity).x,
        phase: required(required(faction).activity).phase,
        text: required(required(veinRows([required(required(faction).activity)], home, fieldTime)[0]).lines[0]) } : null,
      batteries: home === null ? [] : (state?.contacts || []).filter(contact => contact.kind === 'battery').map(mark => ({ id: mark.id, by: mark.by, x: mark.x,
        approximate: mark.error !== 0, text: batteryText(mark, home) })),
      contacts: [...up.flatMap((u): WatchContact[] => {
        if (!u.heard) return [];
        // Sound locates an encounter near the listener, never at an unseen enemy.
        const placed = u.heard.channel !== 'sound' && Number.isFinite(u.heard.x), x = placed ? u.heard.x : ownX(u.id);
        return [{ id: u.id, event: u.heard.event, text: tr`Veículo ${number(u.id)}: ${heardText(u.heard, Number(ownX(u.id) ?? u.heard.x))}.`,
          ...(finite(x) ? { x, approximate: !placed } : {}) }];
      }), ...sharedSoundReports(state)] satisfies WatchContact[],
      // A hauler that found its vein empty, or its place gone, takes no other, and one that picked up an enemy close by gives its trip up: each says so,
      // on its way home and stopped there.
      hauls: up.flatMap(u => (u.haul?.fled || u.reason === 'enemy-near' ? [['enemy-near', tr('inimigo por perto — interrompe o transporte, volta à base ou ao posto e fica lá. Mande-o de novo quando o caminho estiver livre')]] :
        u.haul?.interrupted || u.reason === 'haul-interrupted' ? [['haul-interrupted', tr('trajeto de coleta interrompido — volta à base ou ao posto e aguarda uma nova ordem')]] :
        u.reason === 'supplies-spent' ? [['supplies-spent:' + (u.haul?.depositId ?? ''), tr('coleta de suprimentos encerrada — volta à base ou ao posto e fica lá. Escolha outro local de coleta para ele')]] :
        u.reason?.startsWith('vein-empty:') ? [['vein-empty:' + (u.haul?.depositId ?? ''), tr`jazida de ${tr(required(Object.entries(RAW).find(([id]) => id === u.reason.slice(11))?.[1]))} vazia · recuperando — ${required(can.get(u.id)).solid || required(can.get(u.id)).liquid ? tr('volta à base ou ao posto e fica lá') : tr('extração encerrada')}. Mande-o de novo mais tarde ou a outro local de coleta`]] :
        u.reason?.startsWith('vein-spent:') ? [['vein-spent:' + (u.haul?.depositId ?? ''), tr`coleta de ${tr(required(Object.entries(RAW).find(([id]) => id === u.reason.slice(11))?.[1]))} encerrada — ${required(can.get(u.id)).solid || required(can.get(u.id)).liquid ? tr('volta à base ou ao posto e fica lá') : tr('extração encerrada')}. Escolha outro local de coleta para ele`]] : [])
        .map(([key, words]) => ({ id: u.id, key: required(key), words: required(words), text: `${label(u)}: ${words}.`, ...(u.haul?.threat || u.haltEvent ? { event: u.haul?.threat || u.haltEvent } : {}),
          ...(key === 'enemy-near' && finite(ownX(u.id)) ? { x: ownX(u.id), approximate: true } : {}) }))),
      units: up.map(u => ({ id: u.id, label: label(u) })), repairs: up.filter(u => told(u.id)?.service?.kind === 'repair').map(u => u.id),
      // Of those, the ones that mend part of the damage.
      partly: up.filter(u => (told(u.id)?.service?.kind === 'repair' && 'partial' in required(told(u.id)?.service) && Reflect.get(required(told(u.id)?.service), 'partial'))).map(u => u.id),
      // Both as the frame on the screen has them: one that turned faces the other way in the frame that no longer shows it turning.
      turns: up.filter(u => required(state).actors.find(a => a.id === u.id)?.field?.service?.kind === 'turn').map(u => u.id),
      builds: up.filter(u => required(state).actors.find(a => a.id === u.id)?.field?.service?.kind === 'build').map(u => u.id),
      facing: Object.fromEntries(up.map(u => [u.id, required(state).actors.find(a => a.id === u.id)?.facing])),
      cancelled: up.filter(u => told(u.id)?.declined).map(u => u.id),
      ills: up.flatMap(u => {
        const ill = required(ills.get(u.id)), far = ill.away != null ? ` a ${metres(ill.away)} ${required(ill.depot).post ? tr('do posto') : tr('da base')}` : '', quote = told(u.id),
          short = ill.low && required(required(vehicle(u.id)).rangeKm) * 1000 < required(ill.away),
          // A supply vehicle away from its base and its posts with nothing left to give: it has to go back for more.
          spent = quote?.supplies != null && !quote.auto && !quote.atBase && !quote.atPost && !billTotal(quote.supplies);
        const troubles: (false | '' | null | undefined | [string, string, boolean?])[] = [ill.dry && ['dry', tr('sem combustível') + far], ill.stuck && ['stuck', tr`não anda mais (${ill.stuck})` + far], ill.held && ['held:' + ill.held, HELD[requiredHeld(ill.held)].news],
          ill.blocked && ['blocked-way', tr('caminho de volta bloqueado — aguardando ajuda ou uma nova ordem')], ill.gun && ['gun', ill.gun],
          ill.blind && ['blind', tr('sem visão — nenhuma câmera dele vê para fora')], ill.reachless && ['reachless', ill.tool],
          // A reserve approaching its margin is routine; already unable to reach the base needs attention now.
          ill.low && [short ? 'return-fuel' : 'low', tr`combustível só para ${km(required(required(vehicle(u.id)).rangeKm))}; ${ill.depot?.post ? 'o posto' : 'a base'} está a ${metres(ill.away)}`, short],
          spent && ['spent', tr('suprimentos esgotados'), false]];
        return troubles.filter((item): item is [string, string, boolean?] => Boolean(item)).map(([key, words, grave]) =>
            ({ id: u.id, key, words, text: `${label(u)}: ${words}.`, ...(grave === undefined ? {} : { grave }) }));
      }),
      gone: { ...Object.fromEntries(all.filter(u => u.defeated).map(u => [u.id, ''])),
        ...Object.fromEntries((live ? wreckRows(faction, state?.time ?? 0) : []).map(w => [w.id, tr`destroços ${w.where}, ${w.until}`])) } };
  }
}

// What the player finds wrong with the vehicles on coming into the field, by vehicle: what keeps each from its work,
// and a hauler that stopped its trip. Nothing when all is well.
export function entryReport(watch: NonNullable<FieldPanelView['watch']>) {
  const rows = [...watch.ills, ...watch.hauls],
    vehicles = watch.units.map(u => ({ id: u.id, label: u.label, problems: rows.filter(row => row.id === u.id).map(row => row.words) })).filter(v => v.problems.length);
  return vehicles.length ? { title: vehicles.length > 1 ? tr('Seus veículos precisam de atenção') : tr('Um veículo seu precisa de atenção'),
    text: tr('Situação de agora. “Ver” leva a câmera até o veículo.'), vehicles } : null;
}

// What is said once, as it comes about, of the vehicles a player has: one lost, one that ran dry, lost its way of moving,
// of firing or of seeing, or is held by the ground, or has little fuel left for the way back, a supply vehicle with nothing left to give, a repair that
// is done, and a turning about that a hit undid; a hauler that found its vein empty, whose place is gone or that gave its trip up for an enemy close by; and of the faction, to whoever was in
// it then, that another is taking its base, that it lost its base, that it recovered — a base established, or the ore lorry of
// the aid —, that it took the base of another, that it met another, that one it had met lost its base, that it found
// a vein, and that the watch of its base placed a gun by its fire (`memo.spotted` says that this was said: it is heard as a contact is; `memo.place` is where that gun is held, for whoever would go and look). A filling up says nothing: what was wrong is no longer in the rows. `memo` is kept between looks and
// `watch` is what the panel watches now (`fieldPanel().watch`); `time` is in seconds. The first look says nothing except
// active allied sound reports, which have no vehicle row to read. A look in part (`partial`) is no measure of news: it says nothing, and
// the look before stays the one the next is measured by. The first whole look since the page opened is the player's
// coming into the field: what is wrong with the vehicles then is told at once, as a report to read (`memo.entry`).
// A vehicle the player gave up is expected to go (`memo.expected`).
// Routine operations are informative. `memo.grave` is for threats, losses and faults that need attention now:
// that stays longer on the screen and sounds the grave alert. Consumed resources alone are not a fault.
// `memo.items` keeps each notice's own severity and location for the history.
export function fieldNotices(memo: FieldNoticeMemo, watch: NonNullable<FieldPanelView['watch']> | null, time: number): string[] {
  memo.told ||= new Map(); memo.expected ||= new Set(); memo.grave = memo.spotted = false; memo.place = null; memo.entry = null; memo.items = [];
  for (const [key, at] of memo.told) if (time - at >= NOTICE_REPEAT) memo.told.delete(key);
  if (watch?.partial) return [];
  const before = memo.watch, said: string[] = [];
  memo.watch = watch;
  if (watch && !memo.entered) { memo.entered = true; memo.entry = entryReport(watch); }
  const encounterAt = (id: string, origin: { x?: number | undefined; approximate?: boolean } | null | undefined) => finite(origin?.x) ? { id, x: origin.x, approximate: origin.approximate !== false } : null,
    tell = (key: string, words: string, grave = false, place: FieldNoticeItem['place'] = null, encounter: FieldNoticeItem['encounter'] | null = null): void => {
      if (time - (required(memo.told).get(key) ?? -Infinity) < NOTICE_REPEAT) return;
      required(memo.told).set(key, time); said.push(words); required(memo.items).push({ text: words, grave, place, ...(encounter ? { encounter } : {}) }); memo.grave ||= grave;
    };
  if (watch?.activity && (before?.activity?.id !== watch.activity.id || before.activity.phase !== watch.activity.phase))
    tell('activity:' + watch.activity.id + ':' + watch.activity.phase, watch.activity.text + '.', false,
      { id: watch.activity.id, x: watch.activity.x, approximate: false });
  if (watch && watch.faction === before?.faction && before.activity && !watch.activity)
    tell('activity:' + before.activity.id + ':removed', tr('O airdrop saiu dos recursos conhecidos desta facção.'));
  if (!watch || !before) {
    for (const contact of watch?.contacts || []) if (contact.shared) tell('contact:' + contact.id, contact.text);
    memo.spotted = said.length > 0;
    return said;
  }
  const up = new Set(watch.units.map(u => u.id)), had = new Set(before.ills.map(ill => ill.id + ':' + ill.key));
  for (const u of before.units) if (!up.has(u.id) && u.id in watch.gone && !memo.expected.delete(u.id))
    tell('lost:' + u.id, tr`${u.label} foi destruído${watch.gone[u.id] ? ' · ' + watch.gone[u.id] : ''}.`, true);
  for (const ill of watch.ills) if (!had.has(ill.id + ':' + ill.key)) tell(ill.id + ':' + ill.key, ill.text, ill.grave ?? true);
  // A single encounter can send several workers home. It and its contact are one
  // notice; each vehicle still keeps its own status and reason in the roster.
  // Stopping at home loses the emptied vein's ID, not its identity. A different
  // interruption or encounter must still be announced for that same vehicle.
  for (const haul of watch.hauls) if (!before.hauls.some(was => was.id === haul.id && was.event === haul.event &&
    (was.key === haul.key || SPENT_ROUTES.some(prefix => was.key.startsWith(prefix) && haul.key.startsWith(prefix) &&
      (was.key === prefix || haul.key === prefix))))) {
    if (haul.key === 'enemy-near') {
      const key = 'contact:' + (haul.event || haul.id), origin = (watch.contacts || []).find(contact =>
        (haul.event ? contact.event === haul.event : contact.id === haul.id) && Number.isFinite(contact.x)) || haul,
        encounter = encounterAt(key, origin);
      tell(key, haul.event ? tr('Inimigo por perto: veículos ameaçados interrompem o trabalho e voltam à base. Mande-os novamente quando o caminho estiver livre.') : haul.text,
        true, encounter?.x ?? null, encounter);
    } else tell(haul.id + ':' + haul.key, haul.text);
  }
  const contacts = said.length;
  for (const contact of watch.contacts || []) if (!(before.contacts || []).some(was => was.id === contact.id && was.event === contact.event)) {
    const key = 'contact:' + (contact.event || contact.id), encounter = encounterAt(key, contact);
    tell(key, contact.text, false, encounter?.x ?? null, encounter);
  }
  memo.spotted = said.length > contacts;
  // A repair that is over was done, unless it was cancelled: that the player did, and is told in the reply. One of part of
  // the damage says so.
  for (const id of before.repairs) if (up.has(id) && !watch.repairs.includes(id) && !watch.cancelled.includes(id)) {
    const part = before.partly.includes(id);
    tell((part ? 'partly:' : 'mended:') + id, `${required(watch.units.find(u => u.id === id)).label}: ${part ? tr('reparo em parte concluído') : tr('reparo concluído')}.`);
  }
  // A construction that was being built is ready.
  for (const id of before.builds) if (up.has(id) && !watch.builds.includes(id)) tell('built:' + id, `${required(watch.units.find(u => u.id === id)).label}: pronto.`);
  // A turning about that is over with the vehicle facing as it did was undone by a hit.
  for (const id of before.turns) if (up.has(id) && !watch.turns.includes(id) && watch.facing[id] === before.facing[id])
    tell('stayed:' + id, tr`${required(watch.units.find(u => u.id === id)).label}: atingido enquanto virava — ficou como estava.`, true);
  // What became of the faction is news to whoever was in it as it happened, not to one who came into it since; the one
  // the player was taken out of is told by the faction that came instead.
  if (watch.faction !== before.faction) {
    if (watch.removed) tell('removed:' + watch.removed.at, watch.removed.text, true);
    return said;
  }
  // While the page cannot tell the veins, those it last could are the ones it goes on from. A base established brings the
  // veins about it, which are no finding (`moved`).
  const veins = watch.veins, knew = before.veins, recovered = Boolean(watch.recovered) && required(watch.recovered).at !== before.recovered?.at,
    moved = recovered && required(watch.recovered).base;
  watch.veins ??= knew;
  // A faction whose base the faction took just then lost it for that: the base taken says it.
  for (const other of watch.met) {
    const was = before.met.find(f => f.id === other.id);
    if (!was) tell('met:' + other.id, tr`Nova facção encontrada: ${other.name}.`);
    else if (other.defeated !== null && other.defeated !== was.defeated && other.defeated !== watch.taken?.at)
      tell(`defeated:${other.id}:${other.defeated}`, `${other.name} perdeu a base.`);
  }
  // A capture of the base that begins is bad news, as is the base lost (`fell`); a base the faction took, and the faction
  // recovered, are good news. So is a capture of a post of it that begins bad news, once for each post, and the post lost;
  // a post the faction took is good news.
  if (watch.siege && !before.siege) tell('siege', SIEGE_NEWS, true);
  for (const post of watch.sieges ?? []) if (!before.sieges?.includes(post)) tell('post-siege:' + post, POST_SIEGE_NEWS, true);
  if (watch.fell && watch.fell.at !== before.fell?.at) tell('fell:' + watch.fell.at, watch.fell.text, true);
  if (watch.lost && watch.lost.at !== before.lost?.at) tell('lost:' + watch.lost.at, watch.lost.text, true);
  if (recovered) tell('recovered:' + required(watch.recovered).at, required(watch.recovered).text);
  if (watch.taken && watch.taken.at !== before.taken?.at) tell('taken:' + watch.taken.at, watch.taken.text);
  if (watch.seized && watch.seized.at !== before.seized?.at) tell('seized:' + watch.seized.at, watch.seized.text);
  // A gun the watch of the base has just placed by its fire, and all those placed in one look in one sentence: the
  // mark of each is on the field while it is held, and one that is held on says nothing more.
  const placed = watch.batteries.filter(gun => !before.batteries.some(was => was.id === gun.id)), heard = said.length,
    batteryKey = 'battery:' + placed.map(gun => gun.id), battery = encounterAt('contact:' + batteryKey, placed[0]);
  if (placed.length) tell(batteryKey, placed.length > 1 ? tr`Fogo inimigo localizado: ${placed.map(gun => gun.text).join(', ')}.` :
    tr`Fogo inimigo localizado ${required(placed[0]).text}, ${required(placed[0]).by === 'radar' ? tr('pelo radar da base') : tr('pelo som')}.`, false, battery?.x ?? null, battery);
  const located = said.length > heard;
  memo.spotted ||= located; if (located) memo.place = battery?.x ?? null;
  if (!veins || !knew) return said;
  // A vein found is said, and several found in one look are one sentence: not those a new base brought with it, which the
  // faction knows from its founding. A vein known is never lost: emptied, it comes back.
  const listed = (list: NonNullable<NonNullable<FieldPanelView['watch']>['veins']>): string => list.map(vein => `${vein.name} ${vein.where}`).join(', '),
    found = moved ? [] : veins.filter(vein => !knew.some(was => was.id === vein.id));
  if (found.length) tell('found:' + found.map(vein => vein.id), found.length > 1 ? tr`Jazidas encontradas: ${listed(found)}.` : tr`Jazida de ${required(found[0]).name} encontrada ${required(found[0]).where}.`);
  return said;
}
