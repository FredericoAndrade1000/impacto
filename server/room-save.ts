import { isAuthoredConstruction } from '../src/construction-codec.ts';
import { validFlag } from '../src/flag.ts';
import { isRoadKind } from '../src/roads.ts';
import { isIndustryLevels, isUpgradeId } from '../src/industry.ts';
import { isDuel } from '../src/duel.ts';
import { isSquadOrders } from '../src/squad-contract.ts';
import type { ConstructionService } from '../src/construction-service.ts';
import type { CargoLoad, RepairLevels, ReserveLevel, SupplyBill } from '../src/economy-contract.ts';
import type { Heap, Work } from './field-construction.ts';
import type { RoadOrder } from './road-works.ts';
import type { IndustryState } from './industry.ts';
import type { PendingUpgrade } from '../src/field-service-contract.ts';
import type {
  Accord, Base, BaseFall, BaseTaken, ChatMessage, FactionCapture, FactionFlag, FactionMet,
  KnownBase, KnownDeposit, KnownPost, LibraryModel, Post, PostLost, PostSeized, PublicationAnswer,
  RawLoad, RecoveryRecord, RoomSave, SavedFaction, SavedPlayer, SavedRecord, SavedSerials,
  SavedSquadOrders, Span, Trade, WreckRecord,
} from './room-contract.ts';

import { record, numeric as number, textual as string, logical as boolean, unknownValue as unknown,
  absent, optional, literal, array, undefinedValue, dictionaryOf as dictionary } from '../src/wire-shape.ts';
import type { Guard, Optional as OptionalCheck } from '../src/wire-shape.ts';

type ObjectSchema<Value extends object> = {
  [Key in keyof Value]-?: {} extends Pick<Value, Key> ? OptionalCheck<Value[Key]> : Guard<Value[Key]>;
};
const either = <Value>(...checks: Guard<Value>[]): Guard<Value> => (value): value is Value => checks.some(check => check(value));
const nullable = <Value>(check: Guard<Value>): Guard<Value | null> => (value): value is Value | null => value === null || check(value);
const maybe = <Value>(check: Guard<Value>): Guard<Value | undefined> => (value): value is Value | undefined => value === undefined || check(value);
const pair = <Left, Right>(left: Guard<Left>, right: Guard<Right>): Guard<[Left, Right]> =>
  (value): value is [Left, Right] => Array.isArray(value) && value.length === 2 && left(value[0]) && right(value[1]);
function checked<Value>(check: Guard<Value>, message: string): Guard<Value> {
  return (value): value is Value => { if (!check(value)) throw new Error(message); return true; };
}
// This is the cold Room envelope, not another physics validator. Unknown scene
// and activity payloads stay with World.resume and resumeActivities respectively.
// Every field promised below is checked; extra retired fields remain untouched.
function shape<Value extends object>(schema: ObjectSchema<Value>): Guard<Value> {
  return (value): value is Value => {
    if (!record(value)) return false;
    for (const key in schema) {
      const check = schema[key];
      if (typeof check === 'function') { if (!check(value[key])) return false; }
      else if (Object.hasOwn(value, key) && !check.test(value[key])) return false;
    }
    return true;
  };
}

const socialError = 'Campo salvo com comunicação, ofertas ou acordos inválidos.';
const counterError = 'Campo salvo sem contadores válidos de jogadores, facções, construções e estradas.';
const receiptError = 'Comprovantes de fabricação inválidos no campo salvo.';
const serial: Guard<number> = (value): value is number => number(value) && Number.isSafeInteger(value) && value >= 0;
const serials = checked(shape<SavedSerials>({ j: serial, f: serial, c: serial, r: serial,
  t: optional(checked(serial, socialError)), a: optional(checked(serial, socialError)), m: optional(checked(serial, socialError)),
}), counterError);
const bill = shape<SupplyBill>({ ferro: number, ligas: number, silica: number, combustivel: number });
const rawLoad = shape<RawLoad>({ ferro: number, ligas: number, silica: number, petroleo: number });
const cargo = shape<CargoLoad>({ ferro: optional(number), ligas: optional(number), silica: optional(number), petroleo: optional(number) });
const reserve = either<ReserveLevel>(
  shape<Extract<ReserveLevel, { fuelLitres: number }>>({ fuelLitres: number, rounds: optional(absent), cargo: optional(absent) }),
  shape<Extract<ReserveLevel, { rounds: number }>>({ rounds: number, fuelLitres: optional(absent), cargo: optional(absent) }),
  shape<Extract<ReserveLevel, { cargo: CargoLoad }>>({ cargo, rounds: optional(absent), fuelLitres: optional(absent) }),
);
const repairLevels: Guard<RepairLevels> = dictionary(reserve);
const repairPiece = shape<{ id: string; share: number }>({ id: string, share: number });
const service = either<ConstructionService>(
  shape<Extract<ConstructionService, { kind: 'build' }>>({ kind: literal('build'), until: number, objective: optional(literal(true)) }),
  shape<Extract<ConstructionService, { kind: 'repair' }>>({ kind: literal('repair'), until: number, levels: repairLevels,
    cost: bill, payer: nullable(string), pieces: nullable(array(repairPiece)) }),
  shape<Extract<ConstructionService, { kind: 'turn' }>>({ kind: literal('turn'), until: number, aloft: optional(literal(true)) }),
  shape<Extract<ConstructionService, { kind: 'dismantle' }>>({ kind: literal('dismantle'), progress: number, seconds: number, to: nullable(string) }),
);
const wreck = shape<WreckRecord>({ until: number, abandoned: boolean, stripped: boolean, damagedShare: optional(number) });
const savedRecord = shape<SavedRecord>({ arrival: number, combatAt: nullable(number), wreck: nullable(wreck), service: nullable(service),
  declined: nullable(number), tipped: nullable(number), auto: optional(boolean), homing: optional(boolean),
  gatheredOre: optional(boolean), supplyDelivery: optional(literal(true)) });
const span: Guard<Span> = pair(number, number);
const facing = either<-1 | 1>(literal(-1), literal(1));
const base = shape<Base>({ x: number, facing });
const knownBase = shape<KnownBase>({ x: number, facing, at: number });
const knownPost = shape<KnownPost>({ x: number, facing, at: number, of: string });
const knownDeposit = shape<KnownDeposit>({ left: number, stock: number, at: number, still: boolean });
const capture = shape<FactionCapture>({ by: string, progress: number, at: number,
  state: either(literal('advancing'), literal('contested'), literal('receding')) });
const recovery = shape<RecoveryRecord>({ at: number, base: nullable(number), from: nullable(number), lorry: boolean, aid: bill, aidAt: optional(number) });
const fell = shape<BaseFall>({ at: number, from: number, by: string, dismantled: number, returned: bill, cargo: rawLoad, stock: bill, yard: rawLoad });
const taken = shape<BaseTaken>({ at: number, of: string, dismantled: number, stock: bill, yard: rawLoad });
const lost = shape<PostLost>({ at: number, x: number, by: string, yard: rawLoad });
const seized = shape<PostSeized>({ at: number, x: number, of: string });
const met = shape<FactionMet>({ since: number, at: nullable(number), x: nullable(number), defeatedAt: nullable(number) });
const post = shape<Post>({ id: string, x: number, facing, yard: rawLoad, refinedAt: nullable(number), salvage: bill,
  takedown: nullable(shape<{ progress: number; seconds: number }>({ progress: number, seconds: number })), capture: nullable(capture) });
const libraryModel = shape<LibraryModel>({ id: string, name: string, author: string, by: string, at: number, blueprint: isAuthoredConstruction });
const flag: Guard<FactionFlag> = (value): value is FactionFlag => {
  if (!record(value)) return false;
  try {
    const valid = validFlag(value);
    return typeof valid.country === 'string' ? value.field === undefined && value.colours === undefined && value.emblem === undefined : value.country === undefined;
  } catch { return false; }
};
const pendingUpgrade = shape<PendingUpgrade>({ id: number, upgrade: isUpgradeId, by: string, startedAt: number, until: number, cost: bill });
const industry = checked(shape<IndustryState>({ levels: isIndustryLevels, capital: bill, pending: nullable(pendingUpgrade), serial: number }),
  'Instalações inválidas no campo salvo.');
const chat = checked(shape<ChatMessage>({ id: string, of: string, by: string, nation: string, at: number,
  scope: either(literal('global'), literal('faction'), literal('allies')), text: string, to: optional(array(string)) }), socialError);
const chats = checked(array(chat), socialError);
const savedFaction = shape<SavedFaction>({ id: string, ref: string, leader: string, admins: array(string), nation: nullable(string), flag,
  stock: bill, yard: rawLoad, refinedAt: nullable(number), base: nullable(base), fell: nullable(fell), recovered: nullable(recovery),
  removed: nullable(shape<{ at: number; from: { name: string; nation: string | null } }>({ at: number,
    from: shape<{ name: string; nation: string | null }>({ name: string, nation: nullable(string) }) })),
  capture: nullable(capture), taken: nullable(taken), away: nullable(number), fought: nullable(number), shelter: nullable(number),
  posts: checked(array(post), 'Campo salvo sem os postos das facções.'), lost: nullable(lost), seized: nullable(seized), industry,
  members: array(string), invited: array(string), met: array(pair(string, met)), library: array(libraryModel), chat: optional(chats),
  explored: nullable(array(span)), veins: nullable(array(pair(string, knownDeposit))), bases: optional(nullable(array(pair(string, knownBase)))),
  outposts: nullable(array(pair(string, knownPost))) });

const publicationAnswer: Guard<PublicationAnswer> = shape<PublicationAnswer>({
  actor: optional(shape<{ id: string; blueprint: import('../src/construction-contract.ts').AuthoredConstruction }>({ id: string, blueprint: isAuthoredConstruction })),
  selected: optional(nullable(string)), cost: optional(bill), seconds: optional(number),
  work: optional(shape<{ id: string; name?: string | undefined; x: number }>({ id: string, name: optional(maybe(string)), x: number })),
  post: optional(shape<{ id: string; x?: number }>({ id: string, x: optional(number) })), blocked: optional(maybe(string)),
  relocated: optional(shape<{ from: number; to: number }>({ from: number, to: number })), testIntent: optional(string),
  answer: optional((value): value is PublicationAnswer => publicationAnswer(value)),
});
const receipts = checked(array(pair(string, publicationAnswer)), receiptError);
const orders: Guard<SavedSquadOrders> = (value): value is SavedSquadOrders => {
  if (!record(value)) return false;
  if (Object.hasOwn(value, 'fireAt')) {
    if (value.fireAt !== null && !number(value.fireAt)) throw new Error('Origem de fogo livre inválida no campo salvo.');
    return isSquadOrders(value);
  }
  // Validate the current orders contract without writing its new anchor into a
  // legacy save. Room chooses that anchor from the restored actor exactly once.
  return isSquadOrders({ ...value, fireAt: null });
};
const objectives = shape<NonNullable<SavedPlayer['objectives']>>({ selectMiner: optional(boolean), collectOre: optional(boolean),
  deliverOre: optional(boolean), directControl: optional(boolean), fabricateVehicle: optional(boolean), buildDefense: optional(boolean) });
const aidAt = checked<number>((value): value is number => number(value) && value >= 0, 'Histórico de auxílio inválido no campo salvo.');
const savedPlayer = shape<SavedPlayer>({ id: string, token: string, name: string, color: string, selected: nullable(string),
  factionId: optional(maybe(nullable(string))), request: nullable(string), objectives: optional(objectives), published: optional(receipts),
  aidAt: optional(aidAt), chatAt: optional(number), hastened: optional(number), lapsed: optional(number),
  orders: checked(array(pair(string, orders)), 'Ordens salvas do esquadrão inválidas.') });
const trade = shape<Trade>({ id: string, from: string, to: string, give: bill, want: bill, acceptedAt: optional(undefinedValue) });
const accord = shape<Accord>({ id: string, from: string, to: string, text: string,
  kind: optional(either(literal('declaration'), literal('alliance'))), acceptedAt: nullable(number) });
const workBase = { id: string, factionId: string, ownerId: string, x: number, facing, cost: bill, delivered: bill,
  progress: number, seconds: number, from: nullable(string) };
const work = either<Work>(
  shape<Extract<Work, { post: true }>>({ ...workBase, post: literal(true), blueprint: optional(absent) }),
  shape<Extract<Work, { blueprint: object }>>({ ...workBase, post: optional(literal(false)), blueprint: isAuthoredConstruction }),
);
const heap = shape<Heap>({ id: string, factionId: string, x: number, stock: bill });
const road = shape<RoadOrder>({ id: string, factionId: string, x0: number, x1: number, kind: isRoadKind });
const roomSave = shape<RoomSave>({ fieldId: optional(string), ground: string, veins: array(pair(string, number)),
  duel: optional(isDuel),
  extracted: checked(array(pair(string, number)), 'Campo salvo sem mapa de materiais extraídos.'),
  arrivals: number, founded: number, chance: number, serials,
  trades: optional(checked(array(trade), socialError)), accords: optional(checked(array(accord), socialError)), chat: optional(chats),
  startingIndustry: checked(isIndustryLevels, 'Campo salvo sem as instalações iniciais.'), activities: optional(unknown),
  players: array(savedPlayer), factions: array(savedFaction), commanders: optional(array(pair(string, unknown))), records: array(pair(string, savedRecord)),
  works: checked(array(work), 'Campo salvo sem obras ou montes.'), heaps: checked(array(heap), 'Campo salvo sem obras ou montes.'),
  roadworks: checked(array(road), 'Campo salvo sem estradas pedidas.'), scene: unknown });

export function readRoomSave(value: unknown): RoomSave {
  if (!roomSave(value)) throw new Error('Dados inválidos no campo salvo.');
  return value;
}
