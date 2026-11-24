import { appraise, bill, billTotal, resupply, stocked, PAVING, STOCK_IDS } from '../src/economy.ts';
import { isVehicleDesign } from '../src/persistence.ts';
import { repairOffer } from './service-policy.ts';
import type { SupplyBill, StockId } from '../src/economy-contract.ts';
import type { World } from '../src/physics.ts';
import type { SharedRoom } from './room.ts';
import type { Faction } from './room-contract.ts';

type Actor = NonNullable<ReturnType<World['actor']>>;
type Parts = ReturnType<typeof fieldPartsForType>;
import type { fieldParts as fieldPartsForType } from '../src/economy.ts';
type Quote = ReturnType<typeof appraise>;
import type { StockWantKind, StockWantFor, StockWant, StockWants } from '../src/field-contract.ts';
export type { StockWantKind, StockWantFor, StockWant, StockWants } from '../src/field-contract.ts';
interface Ask { kind: StockWantKind; key: string; amounts: SupplyBill; stuck: Set<StockId>; fixed?: boolean; name?: string | undefined }
type StockWantsRoom = Pick<SharedRoom, 'atDepot' | 'canMend' | 'canServe' | 'fleet' | 'players' | 'position' | 'records' | 'roadworks' | 'supplyDispatch' | 'works' | 'world'>;

// What the stocks of a faction keep waiting, or will not cover, as its members are told it over the field: each stock that
// something stands still for now (`waiting`), or else that falls short of all there is to ask of it (`short`) — the
// others are said nothing of. What asks of the stocks is reckoned against what of them is free (SupplyDispatch.available),
// by the very rules the field serves by, and never by why a vehicle in automatic says it waits: one whose supply pieces do
// not hold what a vehicle asks waits as one whose stocks lack it does, and only the second is the stocks'.
// - The fleet: each construction of the faction — but a wreck, one being built or taken down, and one a job of the dispatch
//   is bringing what it asks for (`claimed`) — asks for what fills its magazines (`ammo`, in Ferro) and its tanks (`fuel`) up
//   to the design, and what mends all of it (`repair`), a repair under way aside. It asks for that now where it would be
//   served now with the stocks: in its base, standing still out of combat, as the base fills it up and mends it of itself
//   (SharedRoom.serve); away from it, standing still out of combat, run low (SupplyDispatch.need) or free for mending, as
//   the dispatch sends supply vehicles to it (SupplyDispatch.demands). What it asks for now the free stocks do not pay any of
//   by the field's own reckoning (`resupply`, `repairOffer`) stands still for them.
// - The works (`work`): each asks for what it lacks that no job brings it, less what the heap of the structure it is moved
//   from still holds; one still waiting for that heap asks for nothing yet. One with nothing left to put up of what came of
//   it stands still for each stock it lacks that the free stocks have not a unit of.
// - The roads of asphalt (`road`): each asks for the mix of what of it is not paved, less what its pavers carry. With
//   graded ground waiting to be paved, a paver of the faction on the field, the pavers on it short of the least of a lane
//   (SupplyDispatch.least) and the free stocks short of that much mix, it stands still for them.
// Of each stock, how much is missing — of what stands still for it, or of all that asks of it — in round figures
// (`rough`), and what asks of it, by kind, in the order above: how many constructions — of them `fixed` structures —, and
// of a single works, its name. A view changes as rarely as that does.
const KINDS: readonly StockWantKind[] = ['ammo', 'fuel', 'repair', 'work', 'road'];
// A rearm bill pays Ferro for the rounds and Combustível for the tanks.
const REARM = Object.freeze({ ferro: 'ammo', combustivel: 'fuel' } as const);
const REARM_STOCKS = ['ferro', 'combustivel'] as const;
// An amount in three figures, never less than it is: what the field may say every quarter of a second, and say again only
// when that changes.
export function rough(value: number): number {
  if (!(value > 0)) return 0;
  if (value < 1000) return Math.ceil(value - 1e-9);
  const step = 10 ** (Math.floor(Math.log10(value)) - 2);
  return Math.ceil(value / step - 1e-9) * step;
}

export function stockWants(room: StockWantsRoom, faction: Faction, parts: Parts, appraisal: (actor: Actor) => Quote = actor => appraise(actor, parts)): StockWants {
  const dispatch = room.supplyDispatch, free = dispatch.available(faction), claimed = dispatch.claimed(), asks: Ask[] = [];
  // What one thing asks of the stocks, by kind, and the stocks it stands still for now.
  const ask = (kind: StockWantKind, key: string, amounts: SupplyBill, stuck: StockId[] = [], more: Pick<Ask, 'fixed' | 'name'> = {}): void => {
    if (billTotal(amounts) > 0) asks.push({ kind, key, amounts, stuck: new Set(stuck), ...more });
  };
  for (const actor of room.fleet(faction)) {
    const record = room.records.get(actor.id), service = record?.service?.kind;
    if (!record || record.wreck || service === 'build' || service === 'dismantle' || claimed.has(actor.id)) continue;
    const quote = appraisal(actor), owner = room.players.get(actor.ownerId!)!, home = Boolean(room.atDepot(faction, actor)),
      fixed = !isVehicleDesign(actor.construction),
      waits = home ? room.canServe(actor) : !dispatch.target(actor, { factionId: faction.id, targetX: room.position(actor) });
    if (billTotal(quote.rearm) > 0) {
      const now = waits && (home || dispatch.need(actor, parts, quote)), paid = now ? resupply(actor.blueprint, quote, free).cost : null;
      for (const id of REARM_STOCKS)
        ask(REARM[id], actor.id, bill(...STOCK_IDS.map(stock => stock === id ? quote.rearm[id] : 0)), now && !(paid![id] > 0) ? [id] : [], { fixed });
    }
    if (billTotal(quote.repair) > 0 && service !== 'repair') {
      const now = waits && room.canMend(owner, actor), [point] = now ? repairOffer([{ stock: free }], quote) : [null];
      ask('repair', actor.id, quote.repair, now && !point ? STOCK_IDS.filter(id => quote.repair[id] > free[id] + 1e-6) : [], { fixed });
    }
  }
  const works = room.works;
  for (const work of works.of(faction.id)) {
    if (dispatch.awaits(work)) continue;
    const wanted = dispatch.wanted(work), heap = dispatch.source(work),
      lacks = bill(...STOCK_IDS.map(id => Math.max(0, wanted[id] - (heap?.stock[id] ?? 0)))),
      idle = !(works.share(work) > work.progress + 1e-9);
    ask('work', work.id, lacks, idle ? STOCK_IDS.filter(id => lacks[id] > 1e-6 && stocked(free[id]) < 1) : [], { name: works.name(work) });
  }
  // The pavers of the faction are looked for only where it has a road of asphalt to make.
  const roadworks = room.roadworks, roads = roadworks.of(faction.id).filter(road => road.kind === 'asphalt' && !roadworks.done(road)),
    pavers = roads.length ? room.fleet(faction).filter(actor => !room.records.get(actor.id)?.wreck && roadworks.rate(actor, 'pave') > 0) : [];
  for (const road of roads) {
    const unpaved = dispatch.unpaved(road), aboard = [...dispatch.jobs].reduce((sum, [id, job]) => {
      const actor = job.kind === 'pave' && job.targetId === road.id && room.world.actor(id);
      return sum + (actor ? roadworks.aboard(actor) : 0);
    }, 0), metres = Math.max(0, unpaved - aboard), least = Math.min(...pavers.map(actor => dispatch.least(actor, unpaved))),
      stalled = pavers.length > 0 && roadworks.left(road, 'pave').length > 0 && aboard < least - 1e-6;
    ask('road', road.id, bill(...STOCK_IDS.map(id => PAVING[id] * metres)),
      stalled ? STOCK_IDS.filter(id => PAVING[id] > 0 && free[id] < PAVING[id] * least - 1e-6) : []);
  }
  const told: StockWants = {};
  for (const id of STOCK_IDS) {
    const asking = asks.filter(item => item.amounts[id] > 1e-6), stuck = asking.filter(item => item.stuck.has(id)),
      waiting = stuck.length > 0, of = waiting ? stuck : asking, missing = of.reduce((sum, item) => sum + item.amounts[id], 0) - free[id];
    if (!waiting && !(missing >= 1)) continue;
    told[id] = { level: waiting ? 'waiting' : 'short', missing: Math.max(1, rough(missing)), for: KINDS.flatMap(kind => {
      const these = of.filter(item => item.kind === kind);
      if (!these.length) return [];
      const n = new Set(these.map(item => item.key)).size, fixed = new Set(these.filter(item => item.fixed).map(item => item.key)).size;
      return [{ kind, n, ...(fixed ? { fixed } : {}), ...(kind === 'work' && n === 1 ? { name: these[0]!.name } : {}) }];
    }) };
  }
  return told;
}
