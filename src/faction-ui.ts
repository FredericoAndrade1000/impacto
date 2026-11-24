import type { Load } from './economy.ts';
import type { Capture } from './economy.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { FogContactView, BatteryMark } from './fog-contract.ts';
import type { SightEye } from './ground-sight.ts';
import type { WithAbsentSlots } from './construction-contract.ts';
import type { Point } from './math.ts';
import type { SupplyBill, CargoLoad, CargoKind, StockId } from './economy-contract.ts';
import type { Deposit } from './deposits.ts';
import type { SquadHaul, SquadHeard } from './squad-contract.ts';
import type { StockWantFor, StockWant, RoomSquadView, DepositView, AiStatus, FieldPresence } from './field-contract.ts';
import type { FactionFlag } from './flag.ts';
export type { FactionView, UnitView } from './field-contract.ts';
import type { FactionView, UnitView } from './field-contract.ts';
export type FieldSquad = RoomSquadView;
export interface StandingActor { readonly id: string; readonly defeated?: boolean | undefined; readonly team?: string | null | undefined; readonly ownerId?: string | null | undefined }
export interface SquadHolder { readonly id: string; readonly name: string }
export interface StandingState {
  readonly shared?: boolean;
  readonly faction?: { readonly id?: string | null | undefined } | null;
  readonly localPlayerId?: string | null | undefined;
  readonly squad?: { readonly units: readonly { readonly id: string; readonly by?: SquadHolder | null | undefined }[] } | null;
}
export type Standing = 'wreck' | 'own' | 'ally' | 'enemy';
export interface FactionIdentity { readonly name?: string | null | undefined; readonly nation?: string | null | undefined }
export interface SharedSoundReport { id: string; shared: true; text: string; event?: never; x?: never; approximate?: never }
export type ContactMark =
  | { kind: 'battery'; id: string; x: number; y: number | null; radius: number; alpha: number; pulse: number; by: 'radar' | 'sound' }
  | { kind: 'radar'; id: string; x: number; y: number; radius: number; alpha: number }
  | { kind: 'sound'; x: number; y: number | null; side: -1 | 1; alpha: number };
export type FieldContact = WithAbsentSlots<FogContactView | BatteryMark>;
export interface FieldView extends DrawingScene, StandingState {
  faction?: FactionView | null;
  localPlayerId?: string | null | undefined;
  squad?: FieldSquad | null;
  contacts?: FieldContact[];
  controlledActor?: string | null;
  pace?: number;
  players?: readonly Readonly<FieldPresence>[];
  sharedEyes?: readonly SightEye[];
}
export type FieldState = FieldView;
export type UiFaction = FactionView;
type WithAbsent<T, Keys extends PropertyKey> = T extends unknown ? T & { [K in Exclude<Keys, keyof T>]?: never } : never;
export type KnownAirdrop = WithAbsent<NonNullable<FactionView['activity']>, 'material' | 'stock' | 'supplies' | 'refined' | 'retireAt'>;
export type DepositObservation = Pick<DepositView, 'id' | 'left' | 'stock'> & Partial<Omit<DepositView, 'id' | 'left' | 'stock'>>;
export interface KnownVeinsSource { readonly deposits: readonly DepositObservation[]; readonly activity?: FactionView['activity'] | undefined }
export type KnownDeposit = Deposit & DepositObservation & { type?: never; supplies?: never; refined?: never; retireAt?: never; guarded?: never; phase?: never; arrivesAt?: never; expiresAt?: never };
export type KnownVein = KnownDeposit | KnownAirdrop;
export interface UiJob { text: string; disabled: boolean; title: string }
export interface PublishQuote {
  costs: ReturnType<typeof costFigures>; seconds: number; time: string; text: string; unpaid: boolean;
  spawn: UiJob; replace: UiJob | null; availableStock?: never;
}
export interface ObraQuote extends Omit<PublishQuote, 'availableStock' | 'replace'> { replace: null; availableStock: SupplyBill | null }
export interface CargoGauge { share: number; text: string; title: string; label?: never }

export interface Refund { refund: SupplyBill; cargo: Load }
export interface PublishOptions {
  price: SupplyBill; faction: FactionView | null | undefined; unit?: UnitView | null; name?: string;
  connected?: boolean; commanded?: boolean; admissionReason?: string; instant?: boolean;
}
export interface ObraOptions extends Omit<PublishOptions, 'unit' | 'name'> { footing?: SupplyBill; moving?: boolean; value?: SupplyBill | null }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing field view record'); return value; };
interface GhostView { readonly ghost?: unknown; readonly defeated?: boolean | undefined }
const hasGhost = (actor: GhostView): actor is GhostView & { ghost: { since: number } } =>
  Boolean(actor.ghost && typeof actor.ghost === 'object' && 'since' in actor.ghost && typeof actor.ghost.since === 'number');
import { THRUSTER_LOST, comingText, workMaterialsText } from './automatic-presentation.ts';
export { THRUSTER_LOST, jobText, jobAdvice, comingText, workMaterialsText } from './automatic-presentation.ts';
import { clamp } from './math.ts';
import { count, number, litres, metres, volume, way, kilometres as km } from './format.ts';
import { CALM_SECONDS, SALVAGE_REACH, WRECK_FADE_SECONDS, RAW, RAW_IDS, STOCKS, STOCK_IDS, bill, load, billSum, billTotal, billText, stockText, shortText, scantText, fillName, fillThing,
  stocked, loadTotal, loadText, suppliesVolume, buildSeconds, UNCOMMANDED, UNBASED, CAPTURE_SECONDS, POST_CAPTURE_SECONDS, captureAt } from './economy.ts';
import { GHOST_SECONDS, BLIP_SECONDS, SOUND_SECONDS, BATTERY_SECONDS } from './battle-rules.ts';
import { depositsNear } from './deposits.ts';
import { constructionLimitReason } from './construction-limits.ts';
import { BUILD_REACH } from './construction-site.ts';
import { roadKindText } from './road-site.ts';
import { POST_BILL, POST_FULL_MESSAGE, POST_NAME, POST_RADIUS } from './territory.ts';
import { tr, translate } from './i18n.ts';
import { percentText, serviceText, serviceFeedback, serviceWaitText } from './service-presentation.ts';
export { percentText, serviceText, serviceFeedback } from './service-presentation.ts';
export const aiStatusText = (ai: AiStatus | undefined): string => ai === 'active' ? tr('IA') : ai === 'paused' ? tr('IA pausada') : '';

// What the page says of a faction on the shared field. Every text and every switch
// comes from the faction as the server last told it and the time of the frame on screen.
// A long way across the field, in kilometres to the tenth.
const kilometres = (value: number): string => km(value / 1000);
const remaining = (until: number, time: number): number => Math.max(0, Math.ceil(until - time));

// The member of the faction who holds a construction of it, other than the player, as the squad of a frame tells it (`by`):
// nobody for one the player holds or one that is free. Read once for each squad told.
const holders = new WeakMap<NonNullable<StandingState['squad']>, Map<string, SquadHolder>>();
export function holderOf(actor: StandingActor, state: StandingState | null | undefined): SquadHolder | null {
  const squad = state?.squad;
  if (!squad) return null;
  if (!holders.has(squad)) holders.set(squad, new Map(squad.units.flatMap(unit => unit.by ? [[unit.id, unit.by] as const] : [])));
  return required(holders.get(squad)).get(actor.id) ?? null;
}
// What the player is told of a construction of the faction another member holds: the field refuses it the same words.
export const heldText = (name: string): string => tr`Este veículo está com ${name} até ser liberado.`;
// Whose a construction of the shared field is, to this player, as a frame tells it: a wreck is nobody's; one of the faction
// is the player's own, but for one another member holds, which is an ally's; any other is an enemy's. Before the faction is
// known, the player's own is what is in the player's squad.
export function standing(actor: StandingActor, state: StandingState): Standing {
  const factionId = state.faction?.id;
  return actor.defeated ? 'wreck' : (factionId != null ? actor.team === factionId : actor.ownerId === state.localPlayerId) ?
    holderOf(actor, state) ? 'ally' : 'own' : 'enemy';
}
// Whether a construction is seen from outside only. The player sees into those of the faction they have open on the
// shared field (`opened`: picked, while none is in their hands); of any other, wrecked or not, the skin of the hull
// covers what stands within it. Away from the field the page opens the design alone (ui-model.ts `trialOpened`): in
// the test of armour, and on the proving ground while the player inspects it; driven there, it is seen from outside as
// on the field, and so are the targets it stands against.
export function seenFromOutside(actor: StandingActor, state: StandingState, opened: ReadonlySet<string> | null = null): boolean {
  if (!state.shared) return !opened?.has(actor.id);
  return !(opened?.has(actor.id) && standing(actor, state) === 'own');
}
// A wreck goes away over its last seconds in sight; its last-seen memory cannot know it went.
export function wreckFade(actor: GhostView & { readonly field?: { readonly wreck?: { readonly until: number } | null | undefined } | null | undefined }, time: number): number {
  if (actor.ghost && actor.defeated) return 1;
  const wreck = actor.field?.wreck;
  return wreck ? clamp((wreck.until - time) / WRECK_FADE_SECONDS, 0, 1) : 1;
}
// A ghost is what the faction last saw of a construction it sees no longer, standing where it was.
// It is drawn pale, and paler the longer ago that was; anything else is whole. Its label says how long.
// A wreck stays equally legible while it remains a memory.
export const GHOST_TINT = 0x9fb2c8;
export function ghostFade(actor: GhostView, time: number): number {
  if (actor.ghost && actor.defeated) return .6;
  return hasGhost(actor) ? .6 - .35 * clamp((time - actor.ghost.since) / GHOST_SECONDS, 0, 1) : 1;
}
// A construction still being built at its base stands pale until it is ready; its label does not.
export const buildFade = (actor: { readonly field?: { readonly service?: { readonly kind: string } | null | undefined } | null | undefined }): number => actor.field?.service?.kind === 'build' ? .5 : 1;
export const ghostText = (actor: GhostView, time: number): string => hasGhost(actor) ? tr` · visto há ${Math.max(0, Math.floor(time - actor.ghost.since))} s` : '';
// Overlapping labels of the same owner/state (`key`) share one mark. Services, ghosts and the single focus (`alone`)
// stay individual. This only groups screen positions; their compact contents are decided by vehicle-labels.ts.
export function labelGroups(items: readonly { id: string; x: number; y: number; width: number; key: string; alone?: boolean }[], gap = 6) {
  const groups: { key: string | null; items: typeof items[number][]; right: number; y: number }[] = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const group = !item.alone && groups.findLast(g => g.key === item.key && item.x - item.width / 2 < g.right + gap && Math.abs(item.y - g.y) < 14);
    if (group) { group.items.push(item); group.right = Math.max(group.right, item.x + item.width / 2); }
    else groups.push({ key: item.alone ? null : item.key, items: [item], right: item.x + item.width / 2, y: item.y });
  }
  return groups.map(({ items: members }) => ({ ids: members.map(m => m.id) }));
}
// What the faction's sensors hold without seeing it, as marks of the view: where a radar has
// something, as wide as the radar may be off, and beside the construction that heard something, the
// side it came from. A mark goes out as what it says gets old. What stands on no chassis has no
// height of its own: whoever draws the mark puts it over the ground there. And where the watch of the
// base places a gun by its fire (`battery`) — as high as it placed one firing from the air, and over the ground there
// otherwise —: as wide as that may be off, paler as the last word of the
// gun gets old but there until the mark is gone, with how much of the showing of that word has gone by
// (`pulse`, from 0 as it comes to 1) and whether the radar of the base or its ears alone hold it (`by`).
// The construction that heard is where `body` says it is: where the frame draws it, which at speed is metres off where
// the state has it.
export const WATCH_PULSE = 1.4;
interface ContactBody { readonly x?: number | undefined; readonly y?: number | undefined }
interface ContactActor { readonly id: string; readonly x: number; readonly vehicle?: ContactBody | null | undefined }
export function contactMarks<Actor extends ContactActor>(state: { readonly time: number; readonly actors: readonly Actor[]; readonly contacts?: readonly FieldContact[] }, time = state.time, body: (actor: Actor) => ContactBody | null | undefined = actor => actor.vehicle): ContactMark[] {
  const marks: ContactMark[] = [], left = (at: number, span: number): number => 1 - clamp((time - at) / span, 0, 1);
  for (const contact of state.contacts || []) {
    if (contact.kind === 'battery') marks.push({ kind: 'battery', id: contact.id, x: contact.x, y: contact.y ?? null, radius: Math.max(1, contact.error),
      alpha: .4 + .6 * left(contact.at, BATTERY_SECONDS), pulse: clamp((time - contact.at) / WATCH_PULSE, 0, 1), by: contact.by });
    if (contact.kind === 'radar') marks.push({ kind: 'radar', id: contact.id, x: contact.x, y: contact.y, radius: Math.max(1, contact.error), alpha: left(contact.at, BLIP_SECONDS) });
    const by = contact.kind === 'sound' && !contact.shared && state.actors.find(actor => actor.id === contact.by), at = by ? body(by) : null;
    if (by) marks.push({ kind: 'sound', x: at?.x ?? by.x, y: at?.y ?? null, side: contact.side < 0 ? -1 : 1, alpha: left(contact.at, SOUND_SECONDS) });
  }
  return marks;
}
// An allied ear reports its own frozen direction. There is no point to mark or receiver to anchor it to.
export function sharedSoundReports(state: Pick<FieldView, 'time' | 'contacts'> | null | undefined, time = state?.time ?? 0): SharedSoundReport[] {
  return (state?.contacts || []).flatMap<SharedSoundReport>(contact => {
    if (contact.kind !== 'sound' || !contact.shared || !contact.from?.ref || time - contact.at >= SOUND_SECONDS) return [];
    const age = Math.max(0, Math.floor(time - contact.at)), side = contact.side < 0 ? tr('à esquerda') : tr('à direita');
    return [{ id: 'allied-sound:' + contact.from.ref + ':' + (contact.side < 0 ? -1 : 1), shared: true,
      text: tr`Relato aliado — ${factionName(contact.from)}: contato ouvido ${side} do observador aliado, há ${age} s.` }];
  });
}
// The words the watch of the base at `x` has just had of a gun, to be shown on the base: of each, whether its radar
// or its ears had it, the side the gun is on and how much of the showing has gone by.
export function watchPulses(state: { readonly time: number; readonly contacts?: readonly FieldContact[] }, x: number, time = state.time) {
  return (state.contacts || []).flatMap(contact => contact.kind === 'battery' && time - contact.at < WATCH_PULSE ?
    [{ by: contact.by, side: contact.x < x ? -1 : 1, age: clamp((time - contact.at) / WATCH_PULSE, 0, 1) }] : []);
}
// A gun the watch of the base placed, in words: where it is from the base and how far off that may be.
export const batteryText = (mark: { x: number; error: number }, home: number): string => tr`a ${farText(mark.x, home)} da base (±${metres(mark.error)})`;
// The four stocks of a faction, each by its name and what it holds: fuel by the litre.
export const stockFigures = (stock: SupplyBill) => STOCK_IDS.map(id => ({ id, name: tr(STOCKS[id]), text: count(stock[id]) + (id === 'combustivel' ? ' L' : '') }));
// What asks of a stock, in a few words, as the field tells it (server/stock-wants.ts): so many constructions — vehicles, or
// structures where all of them are —, a works by its name or how many, how many roads; and a vehicle the player went to
// fabricate, by its name.
const constructions = ({ n, fixed = 0 }: { n: number; fixed?: number }): string => fixed === n ? `${n} ${n === 1 ? tr('estrutura') : tr('estruturas')}` : !fixed ? `${n} ${n === 1 ? tr('veículo') : tr('veículos')}` : tr`${n} construções`;
type Asking = StockWantFor | { kind: 'fabricate'; name: string; n?: never; fixed?: never };
const ASKING = Object.freeze({
  ammo: (item: StockWantFor): string => tr('munição de ') + constructions(item), fuel: (item: StockWantFor): string => tr('abastecimento de ') + constructions(item), repair: (item: StockWantFor): string => tr('reparo de ') + constructions(item),
  work: (item: StockWantFor): string => item.name ? tr('obra ') + item.name : tr`${item.n} obras`, road: (item: StockWantFor): string => item.n === 1 ? tr('estrada de asfalto') : tr`${item.n} estradas de asfalto`,
  fabricate: (item: { name: string }): string => tr('fabricar ') + item.name });
const askingText = (item: Asking): string => item.kind === 'fabricate' ? ASKING.fabricate(item) : ASKING[item.kind](item);
const listed = (words: readonly string[]): string => words.length > 1 ? words.slice(0, -1).join(', ') + tr(' e ') + words.at(-1) : words[0] ?? '';
// What each stock of the faction keeps waiting, or does not cover, over the field: `waiting` where something stands still for
// it now, `short` where nothing does yet but the stocks do not cover all the fleet and the works ask of them (`faction.wants`);
// and, in a few words, what that is and how much is missing. A vehicle the player went to fabricate and the stocks alone kept
// from it (`fabrication`: its name and what it costs) stands still for each stock it costs more of than the faction has.
// The stocks with nothing to say are not among them.
export function stockWants(faction: FactionView | null | undefined, fabrication: { name: string; price: SupplyBill } | null = null) {
  const told: Partial<Record<StockId, { level: 'waiting' | 'short'; text: string }>> = {};
  for (const id of STOCK_IDS) {
    const said: StockWant | undefined = faction?.wants?.[id], lack = fabrication ? Math.max(0, fabrication.price[id] - Math.max(0, faction?.stock?.[id] ?? 0)) : 0,
      held: { kind: 'fabricate'; name: string; missing: number }[] = lack >= 1 && fabrication ? [{ kind: 'fabricate', name: fabrication.name, missing: Math.ceil(lack - 1e-9) }] : [],
      // What stands still for it is what is told: what the field says does, with that vehicle; and only with nothing of that,
      // what is short.
      items = [...said?.level === 'waiting' ? [said] : [], ...held], of = items.length ? items : said ? [said] : [];
    if (!of.length) continue;
    told[id] = { level: items.length ? 'waiting' : 'short',
      text: `${items.length ? tr('Parado por falta') : tr('Não cobre tudo')}: ${listed(of.flatMap((item): Asking[] => 'for' in item ? item.for : [item]).map(askingText))}` +
        tr` · faltam ${count(of.reduce((sum, item) => sum + item.missing, 0))}${id === 'combustivel' ? ' L' : ''}` };
  }
  return told;
}
// An enemy that came freshly into a vehicle's senses: by which of them, how far and to which side — or, of one the
// side was told no place of (`heard.side`: one only heard), the side alone.
const CONTACTS = Object.freeze({ sound: tr('ouviu um inimigo'), radar: tr('sinal de radar'), visual: tr('avistou um inimigo') });
export const heardText = (heard: SquadHeard | null | undefined, x: number): string => {
  if (!heard) return '';
  const sense = Object.entries(CONTACTS).find(([id]) => id === heard.channel)?.[1] ?? tr('inimigo detectado');
  return finite(heard.x) ? tr`${sense} a ${metres(Math.abs(heard.x - x))} ${way(heard.x, x)}` : tr`${sense} à ${typeof heard.side === 'number' && heard.side < 0 ? tr('esquerda ←') : tr('direita →')}`;
};

// Only the field promises a loading deadline. Empty or production-limited piles
// have no countdown; neither a cargo share nor a local wall clock supplies one.
export function cargoWorkText(work: UnitView['cargoWork'] | null | undefined, time?: number | null): string {
  if (work?.kind !== 'load') return '';
  if (work.waiting === true) return tr('aguardando material');
  if (work.limited === true) return tr('carregando · depende da extração');
  return tr('carregando') + (finite(work.until) && finite(time) ? ` · ${Math.max(0, Math.ceil(work.until - time))} s` : '');
}
// What keeps a construction in combat from work it is to be still and calm for.
const FIGHTING = tr`Em combate: fique ${CALM_SECONDS} s sem atirar nem ser atingida.`;
// Why the workshop cannot work on a construction now, or nothing when it can: it works on one standing still on the ground
// in the base (server/room.ts `workshop`), which an aircraft in the air over it is not (`aloft`).
function held(unit: UnitView): string {
  return unit.service ? serviceWaitText(unit.service) : !unit.atBase ? tr('Fora da base: leve a construção até a base.') :
    !unit.still ? unit.aloft ? tr`Pouse na base para ${tr('substituir')}.` : tr`Pare na base para ${tr('substituir')}.` :
    !unit.calm ? FIGHTING : '';
}
const job = (text: string, refused: string, title: string): UiJob => ({ text, disabled: Boolean(refused), title: refused || title });
// How full the fuller of the hoppers and the cisterns of a construction is, from 0 to 1.
const fullest = (unit: UnitView): number => Math.max(unit.fill.solid, unit.fill.liquid);
const share = (unit: UnitView): string => `${Math.round(fullest(unit) * 100)}%`;
// What a construction carries in its hoppers and its cisterns, thing by thing, and how full that leaves
// it: nothing said of one that carries nothing. A supply vehicle says what its supply pieces carry, and that they are empty too.
export function carriedText(unit: UnitView | null | undefined) {
  const supplies = unit?.supplies ? tr`Suprimentos: ${billText(unit.supplies, tr('vazios'))}` : '', work = cargoWorkText(unit?.cargoWork);
  if (!unit || !(loadTotal(unit.cargo) > 0 || unit.loading || work)) return supplies;
  const some = loadTotal(unit.cargo) > 0, full = fullest(unit) >= 1;
  return [tr`Carga: ${loadText(unit.cargo, tr('vazia'))}` + (some && !full ? ` · ${share(unit)}` : '') + (work ? ' · ' + work : unit.loading ? tr(' · carregando') : full ? tr(' · cheia') : ''), supplies]
    .filter(Boolean).join(' · ');
}
// What waits in the yard of the base for its refinery, or nothing when the yard is empty; with no base, it waits for one.
export const yardText = (faction: FactionView | null | undefined) => faction && loadTotal(faction.yard) > 0 ? tr`Pátio: ${loadText(faction.yard)} · ${faction.base ? tr('refinando') : tr('espera uma base')}` : '';
// How much of a construction is destroyed, by what mending it costs of what it cost: nothing said of a whole one.
const credits = (amounts: SupplyBill): number => amounts.ferro + amounts.ligas + amounts.silica;
// What a construction carries, for the gauge of the panel: how full its fuller hopper or cistern is, that share — or empty,
// or full — in a word, and the load itself in full.
export function cargoGauge(unit: UnitView | null | undefined): CargoGauge {
  const share = unit ? fullest(unit) : 0, some = unit != null && loadTotal(unit.cargo) > 0;
  return { share, text: !some ? tr('vazia') : share >= 1 ? tr('cheia') : Math.round(share * 100) + '%', title: carriedText(unit) || tr('Carga: vazia') };
}
// How full the supply pieces of a construction are, in a word: empty, full or the share.
const stockedShare = (unit: UnitView): string => !billTotal(required(unit.supplies)) ? tr('vazios') : unit.fill.supplies >= 1 ? tr('cheios') : Math.max(1, Math.round(unit.fill.supplies * 100)) + '%';
// How full the hoppers of the pavers of a construction are, in a word, as its hoppers and cisterns are told: empty, full or
// the share.
const mixShare = (unit: UnitView): string => !billTotal(required(unit.mix).held) ? tr('vazia') : required(unit.mix).fill >= 1 ? tr('cheia') : Math.max(1, Math.round(required(unit.mix).fill * 100)) + '%';
// What the hoppers of the pavers of a construction carry, as what its hoppers carry is told: the mix of the asphalt by the
// stocks it was taken from, and how full that leaves them. Nothing said of one with no paver.
export const mixText = (unit: UnitView | null | undefined) => !unit?.mix ? '' : !billTotal(required(unit.mix).held) ? tr('Tremonha: vazia') :
  tr`Tremonha: ${billText(required(unit.mix).held)} · ${mixShare(unit)}`;
// That, for the gauge of the panel, with what its supply pieces carry, if it has any.
export const mixGauge = (unit: UnitView) => ({ share: required(unit.mix).fill, text: mixShare(unit), title: [mixText(unit), carriedText(unit)].filter(Boolean).join(' · ') });
// What the supply pieces of a construction carry, for the same gauge: how full they are, and what they have to give. One in
// automatic carries nothing but what its job takes: empty, it lacks nothing.
export function suppliesGauge(unit: UnitView) {
  const some = billTotal(required(unit.supplies)) > 0;
  const text = (some ? billText(required(unit.supplies)) : tr('vazios')) + (required(unit.supplies).combustivel > 0 ? '' : tr(' · Combustível 0 L'));
  return { share: unit.fill.supplies, low: !some && !unit.auto, text, title: carriedText(unit) };
}
// In whole percent, at least one for any damage; and in words.
export const damaged = (unit: UnitView | null | undefined) => unit && credits(unit.repair) > 0 ? Math.max(1, Math.round(credits(unit.repair) / Math.max(1, credits(unit.built)) * 100)) : 0;
export const damageText = (unit: UnitView | null | undefined) => damaged(unit) ? tr`avariado ${damaged(unit)}%` : '';

// A point as the jobs done at it say it: whose supplies pay there — those a supply vehicle carries for itself, those of
// another, which `named` says in words, or none for the stocks of the faction (`stock`) —, what keeps it from serving
// now, and why what it has does not pay a bill.
function served(point: NonNullable<UnitView['point']> | NonNullable<UnitView['mender']>, unit: UnitView, stock: SupplyBill, named: (id: string) => string) {
  const own = point.supplier === unit.id, supplier = point.supplier && !own ? named(point.supplier) : '',
    whose = own ? tr('que ele leva') : supplier ? 'do ' + supplier : '', has = point.stock ?? stock;
  return { own, paid: whose && ` · suprimentos ${whose}`,
    unready: own ? point.held === 'moving' ? tr('Em movimento: ele se abastece do que leva quando parar.') : '' :
      point.held === 'moving' ? tr`O ${supplier} está em movimento: os suprimentos esperam ele parar.` :
      point.held === 'combat' ? tr`O ${supplier} está em combate: os suprimentos esperam ${CALM_SECONDS} s sem tiros.` :
      point.held === 'build' ? tr`O ${supplier} ainda está em construção: os suprimentos esperam ele ficar pronto.` :
      point.held === 'repair' ? tr`O ${supplier} está em reparo: os suprimentos esperam o fim dele.` :
      point.held === 'turn' ? tr`O ${supplier} está virando: os suprimentos esperam ele terminar.` : '',
    short: (cost: SupplyBill, work: string, thing = work): string => whose ? scantText(has, cost, thing, whose) : shortText(has, cost, work) };
}
// What is done for a construction of the player where it stands, as the faction quotes it: only what there is
// to do. A point serves it — its base, from the stocks, or a supply vehicle beside it, from what that one carries,
// told in words by `named` — and away from any none of it is done. The field says which point fills it up
// (`unit.point`) and which one a repair is charged to (`unit.mender`), each as it picks it when asked: two supply
// vehicles in reach may share the work, one giving the fuel and the other paying the repair. A supply vehicle whose
// point is itself is filled with its fuel alone, out of what it carries: it arms itself with nothing, and only another in reach mends it.
// A repair under way has one job, to cancel it, which says where its bill goes back. A construction being built, or
// turning about, has none: it waits for its time; nor has a structure being taken down, whose own block says how far that
// has gone and takes it back (faction-ux.ts).
// Service comes by itself: filling up and repairing are no jobs to ask for. They come when the construction stands
// still on the ground, out of combat — an aircraft in the air (`unit.aloft`) once it lands —, and `held` says in one line
// why one of them waits. The repair of the construction in the
// player's hands (`hand`) is asked for away from its base, and so is one that was cancelled where the construction stands
// (`unit.declined`): a job the point cannot take now — the construction moves or is in the air, is in combat, the supply
// vehicle is not ready, or what pays is short — stays, switched off, and `held` says why. A repair the point pays for part of mends that part
// (`unit.mend`): the pieces, as far as it pays for them, in the order a vehicle needs them back. A supply vehicle is
// filled up at its base by itself. Dismantling is no service of a point: it is asked of the constructions picked (`dismantleHold`).
// Tipping part of its load out, to weigh less, is no service of a point: it is a job of whatever carries something,
// wherever it stands but in its base or a post, where a load is put down whole and none of it is lost.
export const repairNeedsOrder = (unit: UnitView | null | undefined, hand: boolean): boolean => Boolean(unit?.declined || hand && !unit?.atBase && !unit?.atPost);
export function unitServices(unit: UnitView | null | undefined, faction: FactionView, { hand = false, named = () => '' }: { hand?: boolean; named?: (id: string) => string } = {}) {
  const point = unit?.point;
  if (unit?.service?.kind === 'build') return { jobs: [], held: tr('Em construção: fica parada na base até ficar pronta.') };
  if (unit?.service?.kind === 'dismantle') return { jobs: [], held: '' };
  if (unit?.service?.kind === 'turn') return { jobs: [], held: unit.service.aloft ? tr('Virando no ar: segue voando, sem atirar, até o fim do giro. Se for atingida, o giro se desfaz.') :
    tr('Virando: fica parada até o fim do giro. Se for atingida, o giro se desfaz.') };
  if (unit?.service) return { jobs: [{ id: 'cancel', ...job(tr('Cancelar reparo'), '', tr`Encerra o reparo sem consertar nada e devolve ${billText(unit.service.cost)} ` +
    (unit.service.payer ? tr('ao veículo de suprimentos que pagou, enquanto ele estiver no campo e tiver espaço: o que não couber se perde.') : tr('aos estoques da facção.'))) }],
    held: hand && (unit.atBase || unit.atPost) ? tr`Em reparo ${unit.atPost ? tr('no posto') : tr('na base')}: acelere para cancelar.` : '' };
  const dump = unit && !unit.atBase && !unit.atPost && loadTotal(unit.cargo) > 0 ? [{ id: 'dump', ...job(tr('Despejar ¼ da carga'), '', tr('Alivia o peso: o que sai fica no chão e se perde.')) }] : [];
  if (!point) return { jobs: dump, held: '' };
  const fills = served(point, unit, faction.stock, named), mends = unit.mender && served(unit.mender, unit, faction.stock, named),
    // Of itself a supply vehicle takes fuel, and nothing else.
    repair = mends ? unit.repair : bill(), rearm = fills.own ? bill(0, 0, 0, unit.rearm.combustivel) : unit.rearm,
    fighting = unit.calm ? '' : FIGHTING,
    // What keeps each point from taking its work now: the construction in combat, or the point not ready.
    unfuelled = fighting || fills.unready, unmended = fighting || mends?.unready || '',
    moving = unit.still ? '' : unit.aloft ? tr('No ar: o serviço começa quando ela pousar.') : tr('Em movimento: o serviço começa quando a construção parar.'),
    // A repair asked for is done to one that stands still on the ground (server/room.ts `station`).
    unsettled = unit.still ? '' : unit.aloft ? tr`Pouse para ${tr('reparar')}.` : tr`Pare para ${tr('reparar')}.`,
    // The server may keep carried fuel for the works: no own allowance means no automatic refill to wait for.
    mending = billTotal(repair) > 0, filling = billTotal(rearm) > 0 && (!fills.own || billTotal(point.resupply) > 0),
    // What the point pays for part of is mended as far as that goes.
    part = mending ? unit.mend : null, unpaid = mending && !part ? required(mends).short(repair, 'o reparo') : '',
    // What the point pays for none of: a filling up it pays for in part is done as far as that goes.
    unfilled = filling && !billTotal(point.resupply) ? tr`Reposição até completar: ${fills.short(rearm, fillName(rearm).toLowerCase(), fillThing(rearm))}` : '',
    asked = repairNeedsOrder(unit, hand),
    jobs = [
      mending && asked && { id: 'repair', ...(part ? job(tr`Reparar em parte · ${billText(part.cost)} · ${part.seconds} s${required(mends).paid}`, unsettled || unmended,
        tr('Não há o bastante para o reparo inteiro: conserta o que der, peça por peça — primeiro o Comando, depois motor e rodas, armas e sensores, e por fim as chapas, uma inteira de cada vez.')) :
        job(tr`Reparar · ${billText(repair)} · ${unit.repairSeconds} s${required(mends).paid}`, unsettled || unmended || unpaid, tr('A construção fica parada durante o reparo e volta inteira, com a carga que tinha.'))) },
      ...dump].filter((work): work is { id: string } & UiJob => Boolean(work)),
    // Service that comes by itself has no button to say why it has not come.
    waiting = filling && (unfuelled || moving || unfilled) || mending && !asked && (unmended || moving || unpaid) || '';
  return { jobs, held: jobs.find(work => work.disabled)?.title || waiting };
}
// What cancelling a repair gave back and to what, and what of its bill was lost, with the reason.
export function cancelledText(result: { refund: SupplyBill; lost: SupplyBill; supplier?: string | null; gone?: boolean }): string {
  const back = billText(result.refund, ''), lost = billText(result.lost, '');
  return tr('Reparo cancelado') + (back && tr` · ${back} de volta ${result.supplier ? tr('ao veículo de suprimentos que pagou') : tr('aos estoques da facção')}`) +
    (lost && tr` · perdido: ${lost}, ${result.gone ? tr('porque o veículo de suprimentos que pagou já não está no campo') : tr('que não coube nele')}`) + '.';
}

// What a construction tipped out of its load, as the field answers.
export const dumpedText = (result: { dumped: Load }): string => tr`Carga despejada · ${loadText(result.dumped)}.`;
// What dismantling a construction gives back, as the faction quotes it: what is left of it, with what its supply pieces
// and the hoppers of its pavers carry, into the stocks of the faction (`refund`), and the load of its hoppers and its
// cisterns into the yard (`cargo`) — what the field answers when it is done. And that in words, quoted or answered.
export const dismantleQuote = (unit: UnitView): Refund => ({ refund: billSum(billSum(unit.value, unit.supplies ?? bill()), unit.mix?.held ?? bill()), cargo: unit.cargo });
export const returnedText = ({ refund, cargo }: Refund): string => tr`${billText(refund)} de volta aos estoques da facção` + (loadTotal(cargo) > 0 ? tr` e carga ${loadText(cargo)} no pátio` : '');
// Dismantling is asked of the constructions picked, of all of them at once: a vehicle in its base, standing still there on
// the ground — an aircraft in the air over it is to land (`aloft`) —, out of combat and on no cable (server/room.ts
// `workshop`), leaves the field and gives back what is left of it with what it carries (`dismantleQuote`); a structure is taken
// down where it stands, by a builder in automatic that goes to it. Neither while a service holds it. Why one may not be
// now, in a few words, counted when several are asked; nothing when it may. `cabled` says it is on a cable.
export function dismantleHold(unit: UnitView, cabled = false): keyof typeof HOLDS | '' {
  if (unit.service) return unit.service.kind === 'dismantle' ? 'já em desmontagem' : 'em serviço';
  return !unit.vehicle ? '' : cabled ? 'no cabo' : !unit.atBase ? 'fora da base' : !unit.still ? unit.aloft ? 'no ar' : 'em movimento' :
    !unit.calm ? 'em combate' : '';
}
// Why one construction alone may not be dismantled, as what to do about it.
const HOLDS = Object.freeze({
  'já em desmontagem': { text: tr('já em desmontagem'), advice: tr('Já está sendo desmontada.') },
  'em serviço': { text: tr('em serviço'), advice: tr('Aguarde o fim do serviço.') },
  'no cabo': { text: tr('no cabo'), advice: tr('Solte o cabo antes de desmontar.') },
  'fora da base': { text: tr('fora da base'), advice: tr('Leve o veículo até a base para desmontá-lo.') },
  'no ar': { text: tr('no ar'), advice: tr`Pouse na base para ${tr('desmontar')}.` },
  'em movimento': { text: tr('em movimento'), advice: tr`Pare na base para ${tr('desmontar')}.` },
  'em combate': { text: tr('em combate'), advice: FIGHTING },
});
// Those that may not be, counted by why: "2 fora da base, 1 em combate".
const heldOut = (holds: readonly (keyof typeof HOLDS)[]): string => [...new Set(holds)].map(hold => `${holds.filter(other => other === hold).length} ${HOLDS[hold].text}`).join(', ');
// Dismantling the constructions picked, as the faction quotes each (`units`): those that may be (`ids`), how many of them
// are vehicles and how many structures, what the vehicles give back together (`back`), and those left out, how many
// (`left`) and why (`out`); with none that may be, why (`reason`). `cabled(id)` says which are on a cable.
export function dismantlePlan(units: readonly UnitView[], cabled: (id: string) => boolean = () => false) {
  const holds = units.map(unit => dismantleHold(unit, cabled(unit.id))), taken = units.filter((unit, i) => !holds[i]),
    vehicles = taken.filter(unit => unit.vehicle), out = holds.filter((hold): hold is keyof typeof HOLDS => Boolean(hold)),
    back = vehicles.map(dismantleQuote).reduce((sum, quote) => ({ refund: billSum(sum.refund, quote.refund),
      cargo: load(...RAW_IDS.map(id => (sum.cargo[id] ?? 0) + (quote.cargo?.[id] ?? 0))) }), { refund: bill(), cargo: load() });
  return { ids: taken.map(unit => unit.id), vehicles: vehicles.length, structures: taken.length - vehicles.length, back, left: out.length, out: heldOut(out),
    reason: taken.length ? '' : units.length === 1 ? HOLDS[required(out[0])].advice : tr`Nenhuma pode ser desmontada agora: ${heldOut(out)}.` };
}
// The player is asked first, in a few words (`dismantlePlan`): how many vehicles and how many structures, what the vehicles
// give back, and how many are left out and why. The title, the words and the button that says yes.
export function dismantleQuestion({ vehicles, structures, back, left, out }: ReturnType<typeof dismantlePlan>): [string, string, string] {
  const alone = vehicles + structures === 1 && !left,
    what = [vehicles && `${vehicles} ${vehicles === 1 ? tr('veículo') : tr('veículos')}`, structures && `${structures} ${structures === 1 ? tr('estrutura') : tr('estruturas')}`].filter(Boolean).join(tr(' e '));
  return [alone ? vehicles ? tr('Desmontar este veículo?') : tr('Desmontar esta estrutura?') : tr`Desmontar ${what}?`,
    [vehicles && tr`${vehicles === 1 ? tr('O veículo sai') : tr('Os veículos saem')} do campo de vez: ${returnedText(back)}.`,
      structures && (structures === 1 ? tr`Um construtor em automático vai até ${alone ? tr('ela') : tr('a estrutura')} e a desmonta no lugar. ` +
        tr('O material fica num monte ali, que ele mesmo ou um caminhão de suprimentos leva à base.') :
        tr('Construtores em automático vão até as estruturas e as desmontam no lugar. O material fica em montes ali, que eles mesmos ou caminhões de suprimentos levam à base.')),
      left && tr`${left === 1 ? tr('Fica') : tr('Ficam')} de fora: ${out}.`].filter(Boolean).join(' '), tr('Desmontar')];
}
// What came of dismantling several at once, as the field answered each: the vehicles taken off the field, the structures a
// builder goes to, and how many it refused, with why of the first.
export const dismantledNews = ({ vehicles, structures, refused }: { vehicles: number; structures: number; refused: readonly string[] }): string => [vehicles && `${vehicles} ${vehicles === 1 ? tr('veículo desmontado') : tr('veículos desmontados')}`,
  structures && `${structures} ${structures === 1 ? tr('estrutura em desmontagem') : tr('estruturas em desmontagem')}`,
  refused.length && `${refused.length} ${refused.length === 1 ? 'recusada' : 'recusadas'}: ${refused[0]}`].filter(Boolean).join(' · ') + (refused.length ? '' : '.');

// What publishing a vehicle on the bench costs against the faction's stocks: `price` is its
// bill, stock by stock. `costs` are the stocks it is paid from, each with what it asks and whether the faction has
// that — when it has not, how much it lacks (`missing`) —, and `seconds` how long it takes to build at the base. `text` is
// the one line there is to say of it: why it cannot be fabricated as a new vehicle now, or nothing. Replacing is offered
// only for a vehicle of the player — `unit`, told by
// `name` — and takes its place: it pays the new design less what the old one gives back, each stock for itself: one may be paid while
// another is given back; it is built for what it pays. The stocks stand in the way of the design only where they pay
// for neither: an available replacement they pay for is no shortage, whatever a new one would cost, though fabricating one says why
// it cannot be done. A design with no command post (`commanded` false) is not
// published either way. `admissionReason` is the workshop's translated mechanical
// refusal, separate from stocks and costs. The quote does not analyze physics. A structure is no vehicle to publish so
// (`obraQuote`), and never replaces nor is replaced: it is taken down and opened anew elsewhere.
const costFigures = (price: SupplyBill, stock: SupplyBill | null | undefined, lack: unknown, whose = tr('a facção tem')) => STOCK_IDS.filter(id => Math.round(price[id]) > 0).map(id => {
  const unit = id === 'combustivel' ? ' L' : '', asks = `${count(price[id])}${unit}`, short = Boolean(lack) && price[id] > required(stock)[id] + 1e-6;
  return { id, text: asks, short, ...short && { missing: `${count(price[id] - stocked(required(stock)[id]))}${unit}` },
    title: stock ? `${tr(STOCKS[id])}: custa ${asks} · ${whose} ${count(stocked(required(stock)[id]))}${unit}` : `${tr(STOCKS[id])}: ${asks}` };
});
const publishShort = (stock: SupplyBill, cost: SupplyBill, what?: string): string => {
  const reason = shortText(stock, cost, what);
  return reason ? reason + tr(' Falta completar: ') +
    billText(bill(...STOCK_IDS.map(id => Math.max(0, cost[id] - stocked(required(stock)[id]))))) + '.' : '';
};
export function publishQuote({ price, faction, unit = null, name = '', connected = true, commanded = true, admissionReason = '', instant = false }: PublishOptions): PublishQuote {
  const offline = connected && faction ? '' : tr('Aguarde a conexão com o campo.'), seconds = instant ? 0 : buildSeconds(price),
    stock = faction?.stock, old = unit?.vehicle ? unit : null, cost = old ? billSum(price, old.value, -1) : null,
    short = stock ? publishShort(stock, price, tr('fabricar um novo veículo')) : '',
    lack = short && cost && !held(required(old)) && !shortText(required(stock), cost) ? '' : short,
    costs = costFigures(price, stock, lack),
    time = instant ? tr('Fabricação instantânea neste servidor de testes.') : tr`Pronta em ${seconds} s: até lá fica na base, sem andar nem atirar.`,
    replacementSeconds = instant || !old ? 0 : buildSeconds(required(cost)), made = tr('Fabricar novo veículo');
  if (!faction) return { costs, seconds, time, text: admissionReason || offline, unpaid: false, spawn: job(made, admissionReason || offline, admissionReason || offline), replace: null };
  const full = constructionLimitReason(faction.counts, true), headless = commanded ? '' : UNCOMMANDED,
    unbased = faction.base ? '' : UNBASED,
    refused = admissionReason || offline || unbased || headless || full || short, said = admissionReason || offline || unbased || headless || full || lack;
  return {
    costs, seconds, time,
    text: said,
    // The stocks are all that stands in the way: the garage has models the faction can pay.
    unpaid: Boolean(lack) && said === lack,
    spawn: job(made, refused, tr`Fabrica na base com os estoques da facção. ${time}`),
    replace: old && job(tr`Substituir ${name} · ${billText(required(cost), tr('sem custo'))} · ${replacementSeconds} s`, admissionReason || offline || headless || held(old) || publishShort(required(stock), required(cost), tr('substituir este veículo')),
      tr`Troca ${name} por este projeto na base, pagando a diferença. Se não couber no mesmo ponto, usa a vaga livre mais próxima dentro da mesma base. ` +
      (instant ? time : tr`Pronta em ${replacementSeconds} s.`)),
  };
}
// A structure is a works opened at a place of the field the player chooses (server/field-construction.ts): opening it costs
// nothing, and its material is taken to it from the stocks or by supply vehicles, so what the stocks lack now refuses
// nothing — it is only marked. One moved (`moving`) stays the structure it was: neither the limit nor a base counts. The
// footing its place asks for (`footing`, fixed-footing.ts) is paid with it, and put up in its time. Moving reuses only
// what dismantling currently gives back, including its supply cargo (`value`): damage and spent reserves require replacement.
export function obraQuote({ price, footing = bill(), faction, connected = true, commanded = true, moving = false, value = null, admissionReason = '', instant = false }: ObraOptions): ObraQuote {
  const immediate = instant && !moving, stock = faction?.stock ?? null, total = billSum(price, footing), seconds = immediate ? 0 : buildSeconds(total),
    told = moving ? bill(...STOCK_IDS.map(id => Math.max(0, total[id] - (value?.[id] ?? 0)))) : total,
    offline = connected && faction ? '' : tr('Aguarde a conexão com o campo.'),
    lack = Boolean(stock) && STOCK_IDS.some(id => told[id] > stocked(required(stock)[id]) + 1e-6),
    refused = admissionReason || offline || (!commanded ? UNCOMMANDED : '') ||
      (moving ? value ? '' : tr('Aguarde o valor atual da estrutura.') : (required(faction).base ? '' : UNBASED) || constructionLimitReason(required(faction).counts, false)) ||
      (immediate && stock ? publishShort(stock, told, tr('fabricar esta estrutura')) : ''),
    time = immediate ? tr('Fabricação instantânea neste servidor de testes.') : tr`Montagem: ${seconds} s com um braço construtor de 100 % ao lado.`;
  return { costs: costFigures(told, stock, lack, tr('no estoque')), seconds, time, text: refused, unpaid: false, availableStock: stock,
    spawn: job(moving ? tr('Mudar para cá') : tr('Escolher local no campo'), refused,
      (moving ? tr('Reaproveita o que a desmontagem devolver; danos e reservas gastas exigem reposição. A fundação anterior não volta. ') :
        immediate ? tr('Paga o custo completo pelo estoque da facção. ') : tr('Abrir a obra não custa nada: o material é levado até ela. ')) + time), replace: null };
}
// What raising a post asks (post-placement.ts), as a works is quoted (`obraQuote`): what it costs (territory.ts
// `POST_BILL`), marked where the stocks lack it — which refuses nothing: the material is taken to it as it comes —, and how
// long a builder takes to put it up. Refused, in words (`refused`), while the field is away or the faction has no base, and,
// raised at once on a field of tests, while the stocks are short of it.
export function postQuote({ faction, connected = true, instant = false }: { faction: FactionView | null | undefined; connected?: boolean; instant?: boolean }) {
  const stock = faction?.stock ?? null, lack = Boolean(stock) && STOCK_IDS.some(id => POST_BILL[id] > stocked(required(stock)[id]) + 1e-6),
    refused = (connected && faction ? '' : tr('Aguarde a conexão com o campo.')) || (required(faction).base ? '' : UNBASED) ||
      (instant && stock ? publishShort(stock, POST_BILL, 'erguer o posto') : '');
  return { costs: costFigures(POST_BILL, stock, lack, tr('no estoque')), seconds: instant ? 0 : buildSeconds(POST_BILL), refused };
}
// What a publication did to the stocks, and when the construction is ready, said once it is done.
export const publishedText = (result: { seconds?: number; cost: SupplyBill; relocated?: { from: number; to: number } }, replaced: boolean): string => (replaced ? tr`Substituição ${result.seconds ? tr('iniciada') : tr('concluída')} na base · ${billText(result.cost, tr('sem custo'))}` :
  tr`Fabricação ${result.seconds ? tr('iniciada') : tr('concluída')} na base · ${billText(result.cost)}`) + (result.seconds ? tr` · pronta em ${result.seconds} s.` : tr(' · pronta.')) +
  (result.relocated ? tr` Posição ajustada em ${metres(Math.abs(result.relocated.to - result.relocated.from))} para caber na base.` : '');

// The wrecks on the field the faction knows of, the one that goes first on top, as the card by the mark of each tells it:
// what dismantling it gives, what it carries, where it is from the base and how long it stays (`lines`; `where` and
// `until` of these). Whether a construction of the player can work on it now (`inReach`) or once the fight by it is over
// (`calmIn`, in seconds), what working on it is (`work`) — dismantling it or, of one already dismantled (`stripped`),
// taking up its load, for whoever has a hopper or a cistern with room for it — and how to come to that (`hint`).
export function wreckRows(faction: FactionView | null | undefined, time: number) {
  const origin = faction?.base?.x ?? null;
  return (faction?.wrecks || []).slice().sort((a, b) => a.until - b.until || (a.id < b.id ? -1 : 1)).map(w => {
    const left = remaining(w.until, time), cargo = loadTotal(w.cargo) > 0, stripped = cargo && !billTotal(w.value),
      calmIn = !w.inReach && finite(w.calmIn) && w.calmIn > 0 ? w.calmIn : 0,
      where = origin === null ? '' : tr`a ${metres(Math.abs(w.x - origin))} ${way(w.x, origin)} da base`, until = tr`somem em ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    return { id: w.id, name: w.name, x: w.x, seconds: left, inReach: w.inReach, calmIn, stripped, cargo: w.cargo, where, until,
      lines: [stripped ? '' : 'Vale ' + billText(w.value), cargo ? 'Carga ' + loadText(w.cargo) : '', where ? `A${where.slice(1)} · ${until}` : `S${until.slice(1)}`].filter(Boolean),
      work: { text: stripped ? tr('Recolher a carga') : tr('Desmontar'), icon: stripped ? 'i-haul' : 'i-repair',
        title: !cargo ? tr('O que resta dos destroços vai para os estoques da facção.') : (stripped ? tr('A carga') : tr('O que resta dos destroços vai para os estoques; a carga')) +
          tr(' vai para as caçambas e cisternas das suas construções ao lado e precisa ser levada à base.') },
      hint: calmIn ? tr`Em combate: desmonte em ${calmIn} s.` : w.inReach ? stripped ? tr('Selecione seu veículo com caçamba ou cisterna ao lado deles para recolher a carga.') :
        tr('Selecione sua construção ao lado deles para desmontá-los.') : stripped ?
        tr`Para recolher a carga, leve um veículo com caçamba ou cisterna, fora de combate, a menos de ${SALVAGE_REACH} m.` :
        tr`Para desmontá-los, leve uma construção sua, fora de combate, a menos de ${SALVAGE_REACH} m.` };
  });
}
// What salvaging a wreck gave: its value to the stocks, its load to the hoppers and cisterns that reached it, and what did not fit.
export function salvagedText(result: { value: SupplyBill; cargo: Load; left: Load }): string {
  const parts = [billTotal(result.value) ? tr`${billText(result.value)} para a facção` : '',
    loadTotal(result.cargo) ? tr`carga recolhida: ${loadText(result.cargo)} · leve-a à base` : '',
    loadTotal(result.left) ? tr`ficaram nos destroços: ${loadText(result.left)}` : ''].filter(Boolean);
  return tr('Destroços desmontados') + (parts.length ? ' · ' + parts.join(' · ') : '') + '.';
}
export function workRows(faction: FactionView | null | undefined) {
  const where = placed(faction);
  return (faction?.works || []).map(w => ({ id: w.id, name: tr('Obra · ') + w.name, x: w.x, share: w.progress,
    lines: [tr`Montada ${percentText(w.progress)}`, w.share >= 1 ? tr('Todo o material chegou') : tr`Chegou ${percentText(w.share)} do material`,
      billTotal(w.lack) > 0 ? tr('Falta no estoque da base: ') + billText(w.lack) : '',
      w.blocked || (w.building ? tr('Braço construtor montando') : w.waiting ? tr('Braço construtor esperando material') :
        w.sent ? tr('Construtor ') + comingText(w.sent) : tr`Aguardando um braço construtor trabalhar a até ${BUILD_REACH} m`),
      w.supplying ? tr('Suprimentos descarregando') : '', workMaterialsText(w), w.from ? tr('Mudança de lugar de uma estrutura') : '', where(w.x)].filter(Boolean),
    cancel: { text: tr('Cancelar obra'), title: tr('O material que chegou fica num monte no local; a montagem se perde.'), question: tr('Cancelar esta obra?') } }));
}
// The heaps of the faction on the field, each as its card tells it: what is in it, how it is taken away and where it is.
export function heapRows(faction: FactionView | null | undefined) {
  const where = placed(faction);
  return (faction?.heaps || []).map(h => ({ id: h.id, name: tr('Material'), x: h.x,
    lines: [billText(h.stock), tr('Um caminhão de suprimentos parado ao lado carrega; um em automático leva à base ou a uma obra.'), where(h.x)].filter(Boolean) }));
}
// Where a place is from the base of the faction, in words; nothing with no base.
const placed = (faction: FactionView | null | undefined) => (x: number): string => finite(faction?.base?.x) ? tr`A ${farText(x, faction.base.x)} da base` : '';
// The roads the faction asked for on the field, each as its card tells it: what it is to be, how far it is graded and, of
// asphalt, paved, with a bar of how far it is made; which machines work on it now, that one is on its way, or that it waits for
// one in automatic; and where it is from the base. Given up (`cancel`), what was made of it stays.
export function roadRows(faction: FactionView | null | undefined) {
  const where = placed(faction);
  return (faction?.roadworks || []).map(r => {
    const asphalt = r.kind === 'asphalt', x = (r.x0 + r.x1) / 2;
    return { id: r.id, name: tr('Estrada · ') + roadKindText(r.kind), x, x0: r.x0, x1: r.x1, share: asphalt ? (r.graded + r.paved) / 2 : r.graded,
      lines: [`${metres(r.x1 - r.x0)} · nivelada ${percentText(r.graded)}` + (asphalt ? ` · asfaltada ${percentText(r.paved)}` : ''),
        r.working.length ? r.working.map(part => ROAD_MACHINES[part]).join(' · ') : r.coming ? tr('Máquina de estrada a caminho') : tr('Esperando uma máquina de estrada em automático'),
        where(x)].filter(Boolean),
      cancel: { text: tr('Cancelar estrada'), title: tr('O que já foi feito fica no campo; as máquinas param.'), question: tr('Cancelar esta estrada?') } };
  });
}
const ROAD_MACHINES = Object.freeze({ grade: tr('Niveladora trabalhando'), pave: tr('Pavimentadora trabalhando') });
// What cancelling a works left on the field.
export const abandonedText = (result: { heap?: unknown }): string => result.heap ? tr('Obra cancelada: o material que chegou ficou no local.') : tr('Obra cancelada.');

// The ground a vein is dug from, by the feature its site was read off.
const DIGGINGS = Object.freeze({ outcrop: tr('afloramento'), ruins: tr('ruínas'), talus: tr('cascalheira'), dune: tr('duna'), lowland: tr('baixada alagada') });
// An amount of a thing dug, in its unit: ore by the kilogram, as a plain number, and petroleum by the litre.
export const dugText = (material: CargoKind, units: number): string => material === 'petroleo' ? litres(units) :
  units >= 1000 ? number(units / 1000) + ' t' : count(units) + ' kg';
// How far a place of the field is from another and to which side: in metres under a kilometre, in kilometres from there.
export const farText = (x: number, from: number): string => { const far = Math.abs(x - from); return `${far < 1000 ? metres(far) : kilometres(far)} ${way(x, from)}`; };
const known = new WeakMap<readonly Deposit[], { told: readonly DepositObservation[] | null; activity: FactionView['activity'] | null; veins: KnownVein[] }>(), marked = new WeakMap<readonly KnownVein[], ReturnType<typeof makeDepositMarks>>();
// The veins the faction knows of, from one end of the ground to the other: each as the faction was last told of it —
// what was left when it last saw it, when that was unless it sees it now, whether one of the player's loads there and
// whether its base stills it — at the site of the ground it lies at (`deposits`). The page has every site of the ground
// it grew from the seed, and which of them hold a vein it knows from this alone: a site the faction was told nothing of
// is ground like any other. Made once for each telling of the faction, not on every frame.
export function knownVeins(deposits: readonly Deposit[], faction: KnownVeinsSource | null | undefined): KnownVein[] {
  const told = faction?.deposits || null, activity = faction?.activity || null, kept = known.get(deposits);
  if (kept?.told === told && kept.activity === activity) return kept.veins;
  const sites = new Map(deposits.map(site => [site.id, site])),
    veins = [...(told || []).flatMap(vein => sites.has(vein.id) ? [{ ...required(sites.get(vein.id)), ...vein }] : []),
      ...(activity ? [activity] : [])].sort((a, b) => a.x - b.x);
  known.set(deposits, { told, activity, veins });
  return veins;
}
const airdropAmount = (drop: KnownAirdrop): string => drop.supplies ? volume(suppliesVolume(drop.supplies)) : dugText(drop.material, required(drop.stock));
export function airdropText(drop: KnownAirdrop, time: number | null): string {
  if (!finite(time)) return tr('Aguardando tempo do campo');
  const clock = (until: number): string => {
    const seconds = remaining(until, time);
    if (!drop.refined) return seconds + ' s';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), tail = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
  };
  if (drop.retireAt !== undefined) return tr`Airdrop encerrado · retirada em ${clock(drop.retireAt)}`;
  if (time < drop.arrivesAt) return tr`Airdrop · chegada em ${clock(drop.arrivesAt)}`;
  if (time >= drop.expiresAt) return tr('Airdrop encerrado');
  return tr`Airdrop · coleta por ${clock(drop.expiresAt)}`;
}
// The veins the faction knows of, as the card by the mark of each tells it: its material and ground, what was left of it
// when the faction last saw it (`share` of its reserve, for a bar), what is ready there to load, how far it is from the
// base and to which side and, when the faction has it in sight no longer, how long ago that was, by the time of the frame
// on screen: it may have been dug out since. Of a vein a base stills, only that. A faction with no base (`base` is nothing)
// is told no way to it.
export const veinRows = (veins: readonly KnownVein[], base: number | null, time: number | null = null) => veins.map(vein => {
  if (vein.type === 'airdrop') return { id: vein.id, type: vein.type, x: vein.x,
    ...(vein.supplies ? { supplied: true } : { material: vein.material }),
    name: vein.supplies ? tr('Airdrop · Suprimentos') : tr('Airdrop · Ferro bruto'), share: null,
    lines: [airdropText(vein, time), vein.supplies ?
      tr`${vein.phase === 'announcement' ? tr('Remessa') : tr('Disponível')} · ${airdropAmount(vein)} de suprimentos` :
      `${vein.phase === 'announcement' ? tr('Remessa') : tr('Pronto')} ${airdropAmount(vein)}`,
      ...(vein.guarded && vein.retireAt === undefined ? [tr('Pode haver uma sentinela.')] : []),
      ...(finite(time) && time >= vein.arrivesAt && time < vein.expiresAt && vein.retireAt === undefined && !vein.active ? [tr('Junto de uma base: a coleta fica indisponível.')] : []),
      ...(base === null ? [] : [tr`A ${farText(vein.x, base)} da base`])],
    details: vein.supplies ? [billText(vein.supplies), tr('Carga disputável: qualquer facção que encontrar o local pode recolher.'),
      tr('Use uma peça de Suprimentos. A carga ocupa o espaço livre e pode exigir várias viagens.'),
      tr('Volte à base para descarregar no estoque, sem refinar.')] : [tr('Carga pública: qualquer facção pode recolher.'),
      tr('Use um veículo com recipiente para sólidos. Leve a carga à base para refinar.')] };
  const where = [base === null ? '' : tr`a ${farText(vein.x, base)} da base`, vein.seen ? '' : tr`vista ${ago(required(vein.at), time ?? 0)}`].filter(Boolean).join(' · ');
  return { id: vein.id, x: vein.x, material: vein.material,
    name: `${tr(RAW[vein.material])} · ${required(Object.entries(DIGGINGS).find(([feature]) => feature === vein.feature)?.[1])}`, share: vein.active && vein.reserve > 0 ? vein.left / vein.reserve : null,
    lines: [...vein.active ? [tr`Reserva ${dugText(vein.material, vein.left)} de ${dugText(vein.material, vein.reserve)}`,
      tr`Pronto ${dugText(vein.material, vein.stock || 0)}` + (vein.extracting ? tr(' · extraindo') : vein.loading ? tr(' · carregando') : '')] :
      [tr('Junto de uma base: ali não se extrai nada.')], ...where ? [required(where[0]).toUpperCase() + where.slice(1)] : []] };
});
// The veins the faction knows of as marks of the overview: where each lies, of which material, the share of its
// reserve it had when last seen and whether it is dug. Made once for each list of them.
export function depositMarks(veins: readonly KnownVein[]) {
  let marks = marked.get(veins);
  if (!marks) marked.set(veins, marks = makeDepositMarks(veins));
  return marks;
}
function makeDepositMarks(veins: readonly KnownVein[]) { return veins.map(vein => ({ x: vein.x,
    ...(vein.supplies ? { supplied: true } : { material: vein.material }),
    share: vein.type === 'airdrop' ? 0 : vein.left / vein.reserve, active: vein.active, ...(vein.type ? { type: vein.type } : {}) }));
}
// Marks separate the last known unextracted reserve from the pile ready to load.
export const veinMarks = (veins: readonly KnownVein[], x: number, reach: number) => depositsNear(veins, x, reach).map(vein => vein.type === 'airdrop' ?
  { id: vein.id, x: vein.x, ...(vein.supplies ? { supplied: true } : { material: vein.material }), active: vein.active,
    text: vein.supplies ? tr('Airdrop · Suprimentos') : tr('Airdrop · Ferro'),
    detail: vein.retireAt !== undefined ? tr('encerrado') : vein.active ? airdropAmount(vein) + (vein.supplies ? tr(' disponíveis') : tr(' prontos')) : vein.phase === 'announcement' ? tr('a caminho') : tr('coleta indisponível'),
    shortText: tr('Airdrop'), shortDetail: vein.active ? airdropAmount(vein) : '', priority: 3 } :
  { id: vein.id, x: vein.x, material: vein.material, active: vein.active,
  text: `${tr(RAW[vein.material])} · ${vein.active ? tr('reserva ') + dugText(vein.material, vein.left) : tr('junto de uma base')}`,
  detail: vein.active ? dugText(vein.material, vein.stock || 0) + tr(' prontos') : '',
  shortText: vein.active ? `${tr(RAW[vein.material])} · ${dugText(vein.material, vein.left)}` : tr`${tr(RAW[vein.material])} · junto de uma base`,
  shortDetail: vein.active && Number(vein.stock) > 0 ? dugText(vein.material, Number(vein.stock)) + tr(' prontos') : '',
  priority: !vein.active ? -1 : vein.loading || vein.extracting ? 2 : Number(vein.stock) > 0 ? 1 : 0 });
// A hauler's turn, as its order says it: where it is in the trip and how full it is, and that it is the trip home of one that fled an enemy.
// Home is its base, or a post when that is nearer (`post`). An aircraft its pilot sent home for its fuel says so, and that it
// fills up there before it goes on (squad.ts `homeward`, `fuel`); one sent home to be mended, that it waits there for that
// (`mend`).
const TRIP = Object.freeze({ out: tr('indo à coleta'), load: tr('carregando'), home: tr('voltando à base'), unload: tr('descarregando') }),
  FUELLING = Object.freeze({ home: tr('pouco combustível · voltando para abastecer'), unload: tr('abastecendo') }),
  MENDING = Object.freeze({ home: THRUSTER_LOST.home, unload: THRUSTER_LOST.waiting });
export function haulText(haul: SquadHaul, unit: UnitView | null | undefined, { extracts = false, carries = true, time, post = false }: { extracts?: boolean; carries?: boolean; time?: number | null; post?: boolean } = {}): string {
  const onlyTool = extracts && !carries, work = cargoWorkText(unit?.cargoWork, time), phase = haul.mend && (haul.phase === 'home' || haul.phase === 'unload' ? MENDING[haul.phase] : undefined) ? (haul.phase === 'home' || haul.phase === 'unload' ? MENDING[haul.phase] : undefined) :
    haul.fuel && (haul.phase === 'home' || haul.phase === 'unload' ? FUELLING[haul.phase] : undefined) ? (haul.phase === 'home' || haul.phase === 'unload' ? FUELLING[haul.phase] : undefined) :
    haul.waiting && haul.phase === 'out' ? tr('aguardando espaço no local de coleta') :
    haul.phase === 'load' ? work ? (unit?.extracting && !required(unit.cargoWork).waiting ? 'extraindo e ' : '') + work : unit?.extracting ? unit.loading ? 'extraindo e carregando' : 'extraindo' :
      onlyTool ? tr('aguardando condições para extrair') : unit && !unit.loading ?
        (haul.refined ? tr('aguardando carga') : tr('aguardando material extraído')) : tr('carregando') : post && haul.phase === 'home' ? tr('voltando ao posto') : TRIP[haul.phase],
    job = onlyTool ? tr('extração') : extracts ? tr('extração e transporte') : tr('transportando');
  return `${haul.fled ? 'recuando' : job} · ${phase}` + (unit && carries ?
    ` · ${Math.round((haul.refined ? unit.fill.supplies : fullest(unit)) * 100)}%` : '');
}
// What the tools of a construction at work do, as the field tells it (`tools`): with no fuel or no engine that turns they
// stop, and so does the blade or the screed of a road machine that does not reach the ground (`ground`); else they work at
// the share of their pace its engines give them (`pace`), all of it, or what engines too weak for them give — never all of
// it then.
export function toolText(tools: UnitView['tools'] | null | undefined): string {
  if (!tools) return '';
  if (tools.limit === 'fuel') return tr('ferramenta sem combustível');
  if (tools.limit === 'engine') return tr('ferramenta sem motor');
  if (tools.limit === 'ground') return tools.tool === 'paver' ? tr('a mesa não alcança o chão') : tr('a lâmina não alcança o chão');
  const pace = required('pace' in tools ? tools.pace : undefined);
  return tools.limit === 'power' ? tr`${Math.min(99, Math.round(pace * 100))} % da capacidade, limitado pelo motor` : tr`${Math.round(pace * 100)} % da capacidade`;
}
// What a construction that is not hauling still carries and how full it is, or nothing when it carries nothing.
// A supply vehicle says how full its supply pieces are, and that they are empty: what they hold is in its gauge. A paver
// says what the hoppers of its pavers carry, as a hopper is told, and what its supply pieces carry, which feed them.
export const cargoText = (unit: UnitView | null | undefined) => [unit && loadTotal(unit.cargo) > 0 ? tr`carga ${loadText(unit.cargo)} (${fullest(unit) >= 1 ? tr('cheia') : share(unit)})` : '',
  unit?.mix && billTotal(required(unit.mix).held) > 0 ? `tremonha ${billText(required(unit.mix).held)} (${mixShare(unit)})` : '',
  unit?.supplies ? tr('suprimentos ') + (unit.mix && billTotal(required(unit.supplies)) > 0 ? `${billText(required(unit.supplies))} (${stockedShare(unit)})` : stockedShare(unit)) : ''].filter(Boolean).join(' · ');

// How long ago something of the field was, by its time and the time of the frame on screen: in seconds under a minute, in
// minutes under an hour, in hours under a day, and in days from there.
export const ago = (at: number, time: number): string => {
  const seconds = Math.max(0, Math.floor(time - at));
  return seconds < 60 ? tr`há ${seconds} s` : seconds < 3600 ? tr`há ${Math.floor(seconds / 60)} min` : seconds < 86400 ? tr`há ${Math.floor(seconds / 3600)} h` : tr`há ${Math.floor(seconds / 86400)} d`;
};
// A faction as it is named: by the name its members gave their nation, and by its leader's until they give one…
export const factionName = (faction: FactionIdentity): string => faction.nation || tr('Facção de ') + faction.name;
// …and as a sentence names it, after "a", "da" or "na".
export const factionSaid = (faction: FactionIdentity): string => tr('facção ') + (faction.nation || tr('de ') + faction.name);
// The invitations that were not there the last time the player was told of them.
export const arrivals = (known: ReadonlySet<string>, invites: FactionView['invites'] = []) => invites.filter(i => !known.has(i.factionId));
// What joining another faction takes away, said before it is done — or before asking to (`asked`), which may be answered
// while the player is away: the stocks and the constructions stay with the faction the player leaves, which the player has
// no longer; and with nobody left in it, they leave the field.
export function joinWarning(invite: FactionIdentity, faction: FactionView, asked = false): string {
  const kept = faction.members.length > 1, fleet = faction.count;
  return tr`${asked ? tr('Se o pedido for aceito, você sai') : tr('Você sai')} da sua facção: os estoques (${stockText(faction.stock)}) ` + (kept ? (fleet ? tr('e as construções ficam com ela') : tr('ficam com ela')) :
    tr('ficam para trás') + (fleet ? tr` e ${fleet === 1 ? tr('a construção da facção sai') : tr`as ${fleet} construções da facção saem`} do campo, com o que levam` : '')) +
    tr`. Você passa a usar a base, os estoques e as construções da ${factionSaid(invite)}.`;
}

// What the aid would give a faction (server/room.ts, `recovery`), in words: what establishing a base costs, where it has
// none, and the ore lorry it lacks the stocks for, with the fuel kept besides; or, for one with a base and nothing on the
// field, the lorry and that fuel. And what the aid gives of all that, which is what the faction lacks of it.
export function recoveryText(recovery: NonNullable<FactionView['recovery']>): string {
  const { base, lorry, reserve, aid } = recovery, reserved = tr`com Combustível ${count(reserve)} L de reserva`,
    wanted = base ? tr`Estabelecer base custa ${billText(base)}.` + (lorry ? tr` Sem estoque para um caminhão de minério, ele vem junto, ${reserved}.` : '') :
      tr`Nada no campo e sem estoque para um caminhão de minério (${billText(required(lorry))}) ${reserved}.`;
  return wanted + (billTotal(aid) > 0 ? tr` O auxílio cobre o que falta: ${billText(aid)}.` : '');
}
// A server-derived wait is simulation time; the page has no independent aid timer or eligibility rule.
export function emptyText(faction: FactionView): string {
  const waiting = (faction.recovery?.wait ?? 0) > 0 ? tr` Novo auxílio em ${clock(required(required(faction.recovery).wait))} de jogo.` : '';
  if (!faction.base) return tr`Sua facção está sem base${required(faction.fell).by ? tr(': tomada pela ') + factionSaid(required(required(faction.fell).by)) : ''}.${waiting}`;
  if (faction.count > 0) return tr('Selecione uma construção na lista ou no campo.');
  if (waiting) return tr('Sua facção está sem construções no campo.') + waiting;
  return faction.recovery?.offered ? tr('Sua facção está sem construções no campo. Peça auxílio para receber um caminhão de minério.') :
    tr('Você não tem construções no campo: monte uma em Construir e fabrique-a.');
}
// What there is to do about the last construction of a faction with no stocks for an ore lorry, which nothing can be
// brought to: `trouble` is what keeps it where it is.
export const strandedText = (trouble: string): string =>
  tr`${trouble}, e a facção não tem outra construção nem estoque para um caminhão de minério. Abandone esta: sem nada no campo, a facção pode pedir auxílio.`;
// How many constructions were dismantled where a base was taken, in words.
const dismantledText = (n: number): string => n === 1 ? tr('1 construção desmontada') : tr`${n} construções desmontadas`;
// The base a faction lost, said to its members: by whom, what dismantling what they had on the field gave back to the
// stocks and to the yard, what the looting took, and what to do next.
export function fellText(faction: FactionView): string {
  const { by, dismantled, returned, cargo, stock, yard } = required(faction.fell),
    loot = [billTotal(stock) > 0 ? billText(stock) : '', loadTotal(yard) > 0 ? loadText(yard) + tr(' do pátio') : ''].filter(Boolean).join(tr(' e '));
  return tr`Sua base foi tomada${by ? ' pela ' + factionSaid(by) : ''}.` + (dismantled ? tr` ${dismantledText(dismantled)}: ${billText(returned)} de volta aos estoques` +
    (loadTotal(cargo) > 0 ? tr` e ${loadText(cargo)} ao pátio.` : '.') : '') + tr` Saque: ${loot || tr('nada')}. Estabeleça outra base no painel do campo.`;
}
// The last time the faction recovered, said to its members: the base it established, how far from the one it lost and to
// which side, and with the ore lorry where it came with one; or the lorry alone. And what the aid gave, if anything.
export function recoveredText(faction: FactionView): string {
  const { base, from, lorry, aid } = required(faction.recovered), helped = billTotal(aid) > 0 ? tr` · o auxílio cobriu ${billText(aid)}` : '';
  return base === null ? tr`Caminhão de minério na base${helped}.` :
    tr`Base estabelecida a ${farText(base, required(from))} da que foi tomada${lorry ? tr(', com um caminhão de minério') : ''}${helped}.`;
}
// A player another member took out of a faction, as the faction that came instead says it.
export const removedText = (faction: FactionView): string => tr`A ${factionSaid(required(faction.removed).from)} tirou você dela. Você começou uma facção nova, com base própria.`;

// A base or a post being taken, over the field: the faction's own base before its posts, and those before any it takes, with
// what to do about it, or else of those it takes the one that has gone furthest. Each says the time left before it is taken
// — a base in `CAPTURE_SECONDS`, a post (`post`) in `POST_CAPTURE_SECONDS` — and which way the capture goes (`captureAt`);
// one the faction stands armed in and cannot take, that it is contested, or sheltered while its faction is away
// (server/room.ts, `shelter`), or, of a post, that the faction has all the posts it may have (`full`), which holds its
// capture. `share` is how far the capture has gone. Nothing while no base and no post is being taken.
const CAPTURE_WAYS = Object.freeze({ advancing: tr('avançando'), contested: tr('disputada'), receding: tr('recuando') });
const clock = (seconds: number): string => { const left = Math.max(0, Math.ceil(seconds)); return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; };
export function duelPanel(duel: FactionView['duel']) {
  if (!duel) return null;
  const text = duel.phase === 'playing' ? tr('Duelo · capture a base principal') :
    duel.phase === 'won' ? tr('Vitória · duelo encerrado') : duel.phase === 'lost' ? tr('Derrota · duelo encerrado') : tr('Empate · capturas simultâneas');
  return { text, hint: duel.phase === 'playing' ? tr('A tomada da base principal encerra a partida.') :
    tr('Resultado definitivo. As ações do campo foram encerradas.') };
}

export function captureBar(faction: FactionView | null | undefined, time: number) {
  type CapturePlace = Capture & { post?: string; full?: boolean };
  const seconds = (place: CapturePlace): number => place.post ? POST_CAPTURE_SECONDS : CAPTURE_SECONDS, gone = (capture: CapturePlace, of: CapturePlace = capture): number => captureAt(capture, time, seconds(of)),
    share = (capture: CapturePlace): number => gone(capture) / seconds(capture), told = (capture: CapturePlace): string => `${clock(seconds(capture) - gone(capture))} · ${CAPTURE_WAYS[capture.state]}`,
    siege = faction?.siege, held = (faction?.posts ?? []).flatMap(post => post.siege ? [{ ...post.siege, post: post.id }] : [])
      .sort((a, b) => share(b) - share(a))[0], taking = (faction?.taking ?? []).slice().sort((a, b) => share(b) - share(a))[0];
  if (siege) return { own: true, share: share(siege), text: tr`Base sendo tomada · ${told(siege)}`, hint: tr('Destrua os veículos armados inimigos na base.') };
  if (held) return { own: true, share: share(held), text: tr`Posto sendo tomado · ${told(held)}`, hint: tr('Destrua os veículos armados inimigos no posto.') };
  if (!taking) return null;
  const target: CapturePlace & FactionIdentity & { sheltered: boolean } = taking;
  const what = target.post ? tr`o posto da ${factionSaid(taking)}` : tr`a base da ${factionSaid(taking)}`;
  if (target.sheltered) return { own: false, share: 0, text: tr`${target.post ? tr('Posto') : tr('Base')} da ${factionSaid(taking)} ${target.post ? tr('protegido') : tr('protegida')}: ninguém dela está no campo`, hint: '' };
  if (target.full && !taking.progress && taking.state === 'contested') return { own: false, share: 0, text: tr`Sem tomar ${what}: ${POST_FULL_MESSAGE}`, hint: '' };
  return { own: false, share: share(taking), text: tr`Tomando ${what} · ${told(taking)}`, hint: target.full ? translate(POST_FULL_MESSAGE) : '' };
}
// What the members of a faction are told as a capture of their base begins: what to do about it, and what holds it.
export const SIEGE_NEWS = tr('Sua base está sendo tomada: destrua os veículos armados inimigos nela. Um veículo armado seu no chão da base segura a contagem.');
// And as a capture of one of their posts begins.
export const POST_SIEGE_NEWS = tr('Um posto seu está sendo tomado: destrua os veículos armados inimigos nele. Um veículo armado seu no chão do posto segura a contagem.');
// The last post the faction lost, said to its members: where it stood, by whom it was taken, and what of what waited in its
// yard went into the stocks, refined.
export function lostText(faction: FactionView): string {
  const { x, by, yard } = required(faction.lost), home = faction.base?.x;
  return `Posto ${finite(home) ? tr`a ${farText(x, home)} da base ` : ''}tomado${by ? ' pela ' + factionSaid(by) : ''}.` +
    (loadTotal(yard) > 0 ? tr` O que esperava no pátio dele (${loadText(yard)}) foi refinado para os estoques.` : '');
}
// The last post the faction took, said to its members: whose it was and where it stands; it is theirs now, with its ground.
export function seizedText(faction: FactionView): string {
  const { x, of } = required(faction.seized), home = faction.base?.x;
  return tr`Posto ${of ? 'da ' + factionSaid(of) : 'inimigo'} tomado${finite(home) ? tr` a ${farText(x, home)} da base` : ''}: agora é seu, com o território em volta.`;
}
// The posts of the faction on the field, each as the card by its mark tells it (field-sites.ts): what it serves, its capture
// under way, its taking down — how far it has gone and who does it —, and where it is from the base. Taken down (`cancel`),
// what it was put up with is left there in a heap; one being taken down is kept as it was instead.
export function postRows(faction: FactionView | null | undefined) {
  const where = placed(faction);
  return (faction?.posts || []).map(p => {
    const down = p.takedown;
    return { id: p.id, name: POST_NAME, x: p.x, share: down ? down.progress : null, takedown: Boolean(down),
      lines: [down ? tr`Desmontando ${percentText(down.progress)}` : tr`Descarga, rearme, abastecimento, reparo e abrigo a até ${POST_RADIUS} m`,
        down ? down.building ? tr('Braço construtor desmontando') : down.sent ? tr('Construtor ') + comingText(down.sent) : tr`Aguardando um braço construtor trabalhar a até ${BUILD_REACH} m` : '',
        p.siege ? tr`Sendo tomado pela ${factionSaid(required(p.siege.by))} · ${required(Object.entries(CAPTURE_WAYS).find(([key]) => key === p.siege?.state)?.[1])}` : '', where(p.x)].filter(Boolean),
      cancel: down ? { text: tr('Manter posto'), title: tr('Para a desmontagem: o posto volta a servir como estava.'), question: tr('Manter este posto?') }
        : { text: tr('Desmontar posto'), title: tr('Um construtor em automático vai até ele e o desmonta; o que a facção pôs nele fica num monte no local.'), question: tr('Desmontar este posto?') } };
  });
}
// What taking a post down, or keeping it, came to.
export const postText = (result: { kept: unknown } | { dismantling: string }): string => 'kept' in result && result.kept ? tr('Posto mantido.') : tr('Desmontagem do posto iniciada: um construtor em automático vai até ele.');
// The base the faction took, said to its members: whose it was, how many constructions were dismantled there, and what
// the looting brought to the stocks and to the yard.
export function takenText(faction: FactionView): string {
  const { of, dismantled, stock, yard } = required(faction.taken),
    loot = [billTotal(stock) > 0 ? billText(stock) + tr(' para os estoques') : '', loadTotal(yard) > 0 ? loadText(yard) + tr(' para o pátio') : ''].filter(Boolean).join(tr(' e '));
  return `Base ${of ? 'da ' + factionSaid(of) : 'inimiga'} tomada` + (dismantled ? ` · ${dismantledText(dismantled)}` : '') + ` · saque: ${loot || tr('nada')}.`;
}
