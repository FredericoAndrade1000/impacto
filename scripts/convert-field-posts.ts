// Explicit, offline conversion of a field kept as FIELD_SAVE 26 into the current field format, in which the posts of the factions are
// places of the field, as their bases are, and not structures (src/territory.ts). Normal loaders never import this file:
// a field of 26 is refused by them (server/field-save.ts), and is only ever read here.
// Existing bases receive full installed capacity without paid capital; new factions start basic.
//
//   node scripts/convert-field-posts.ts --input ../copia/field.json --output ../copia/convertido
//   node scripts/convert-field-posts.ts --input ../copia/field.json --output ../copia/convertido --write
//
// The first is a trial: it converts and reopens the field and says what it would do, and writes nothing. The second writes
// `field.json` into the output folder, which must not exist yet, readable by its owner alone (it holds the keys of the
// seats). Neither prints anything of the field but counts: no token, name or design is ever said.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SharedRoom } from '../server/room.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { appraise, fieldParts, bill, buildSeconds, load, STOCK_IDS } from '../src/economy.ts';
import { POST_BILL } from '../src/territory.ts';
import { BASIC_INDUSTRY, FULL_INDUSTRY } from '../src/industry.ts';
import { newIndustry } from '../server/industry.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import { record as isRecord, parseJSON, cloneJSON, errorMessage } from './operational-input.ts';

// The save this converts from, and the one it converts to: the current one.
export const FROM_SAVE = 26;
const clone = cloneJSON;
const credit = (stock: SupplyBill, amounts: SupplyBill): void => { for (const id of STOCK_IDS) stock[id] += amounts[id]; };
function oldYard(value: unknown): ReturnType<typeof load> {
  if (value == null) return load();
  if (!isRecord(value)) throw new Error('Pátio do posto inválido.');
  return { ...value, ...load(...['ferro', 'ligas', 'silica', 'petroleo'].map(key => {
    const amount = value[key] ?? 0;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('Pátio do posto inválido.');
    return amount;
  })) };
}

// What a room kept as FIELD_SAVE 26 (`kept`, the `room` of the file) is in the current field format, and what was done to it, in counts.
// The room is opened by the current field as it would open it (`make`, a public field by default), with each construction
// that was a post of its faction (`record.post`) still on it as a structure like any other, and then:
// - each such construction standing is a post of its faction (`faction.posts`) where it stood and as it faced, with the yard
//   it had and since when it refined it, giving back, taken down, what dismantling the structure would have given back
//   (`appraise`), and being taken down as far as the structure was; what a repair it was held for was paid with goes back
//   to the stocks, as when a faction is stripped (room.ts `strip`), and what it carried goes back as it does there (`empty`).
//   The construction leaves the field, its players letting go of it (`forget`). What the fog held of it was never kept: the
//   others know the post once they see it (room.ts `reconnoitre`);
// - the wreck of one keeps no yard: what waited there is lost with it (`wreckYards`, how many);
// - each works of a post is the works of a post of the current field, of no design: it costs `POST_BILL`, what came of it is
//   kept as far as that asks — the rest goes back to the stocks of its faction (`refunded`) —, it is put up no further than
//   what came of it lets it be, and in the time a post takes.
// A field with no post is converted all the same: its factions have none. Returns the room as the current field keeps it.
export function convertPostsRoom(kept: unknown, make: (state: unknown) => SharedRoom = state => new SharedRoom({ kept: state })) {
  const prepared = clone(kept), posts = new Map<string, { yard: ReturnType<typeof load>; refinedAt: number | null }>();
  if (!isRecord(prepared)) throw new Error('O campo salvo não tem facções, registros ou obras.');
  prepared.startingIndustry = { ...BASIC_INDUSTRY };
  if (!Array.isArray(prepared.factions) || !prepared.factions.every(isRecord) || !Array.isArray(prepared.records) || !Array.isArray(prepared.works) || !isRecord(prepared.scene) || typeof prepared.scene.time !== 'number') throw new Error('O campo salvo não tem facções, registros ou obras.');
  for (const faction of prepared.factions) {
    if (Object.hasOwn(faction, 'posts')) throw new Error('O campo salvo já tem os postos das facções: não é do formato 26.');
    Object.assign(faction, { posts: [], lost: null, seized: null, outposts: [], industry: newIndustry(faction.base ? FULL_INDUSTRY : BASIC_INDUSTRY) });
  }
  let wreckYards = 0;
  for (const entry of prepared.records) {
    if (!Array.isArray(entry)) throw new Error('Registro do campo inválido.');
    const id: unknown = entry[0], record: unknown = entry[1];
    if (typeof id !== 'string' || !isRecord(record) || record.refinedAt != null && typeof record.refinedAt !== 'number') throw new Error('Registro do campo inválido.');
    if (record.post === true && !record.wreck) posts.set(id, { yard: oldYard(record.yard), refinedAt: record.refinedAt ?? null });
    else if (record.yard) wreckYards++;
    delete record.post; delete record.yard; delete record.refinedAt;
  }
  // A legacy post work carried an unused project. Remove that retired representation
  // before current admission; its original cost and delivery still drive the refund below.
  for (const work of prepared.works) {
    if (!isRecord(work)) throw new Error('Obra do campo inválida.');
    if (work.post === true) delete work.blueprint;
  }
  const room = make(prepared), world = room.world, refunded = bill();
  try {
    const parts = fieldParts(world);
    for (const [id, { yard, refinedAt }] of posts) {
      const actor = world.actor(id), faction = actor && typeof actor.team === 'string' && room.factions.get(actor.team);
      if (!actor || !faction) throw new Error('Um posto do campo salvo não está no campo ou não tem facção.');
      const record = room.records.get(id), service = record?.service, x = room.position(actor), facing = actor.facing === -1 ? -1 : 1;
      if (service?.kind === 'repair') credit(faction.stock, service.cost);
      room.empty(faction, actor);
      faction.posts.push({ id, x, facing, yard: { ...load(), ...yard }, refinedAt, salvage: appraise(actor, parts).salvage,
        takedown: service?.kind === 'dismantle' ? { progress: service.progress, seconds: service.seconds } : null, capture: null });
      const owner = typeof actor.ownerId === 'string' ? room.players.get(actor.ownerId) : undefined;
      room.discard(id);
      if (owner) room.forget(owner, id);
    }
    for (const player of room.players.values()) {
      if (!player.squad) throw new Error('Jogador do campo sem esquadrão.');
      player.squad.sync();
    }
    let works = 0;
    for (const work of room.works.pending.values()) {
      if (!work.post) continue;
      const faction = room.factions.get(work.factionId), delivered = bill(...STOCK_IDS.map(id => Math.min(work.delivered[id], POST_BILL[id])));
      if (!faction) throw new Error('Obra do campo sem facção.');
      credit(faction.stock, bill(...STOCK_IDS.map(id => work.delivered[id] - delivered[id])));
      credit(refunded, bill(...STOCK_IDS.map(id => work.delivered[id] - delivered[id])));
      Object.assign(work, { cost: { ...POST_BILL }, delivered, seconds: work.seconds > 0 ? buildSeconds(POST_BILL) : 0 });
      work.progress = Math.min(work.progress, room.works.share(work));
      works++;
    }
    room.topology++;
    return { room: room.keep(), receipt: { from: FROM_SAVE, to: FIELD_SAVE, factions: room.factions.size, posts: posts.size, works, wreckYards,
      refunded: Object.fromEntries(STOCK_IDS.map(id => [id, Math.round(refunded[id])])) } };
  } finally { world.dispose(); }
}

// Whether two kept rooms are the same: the same keys and texts, and numbers alike to `SAME_DIGITS` of their size — an
// opening of a kept field may round a pose of the core, of a vehicle in motion, in its last digits.
const SAME_DIGITS = 1e-9;
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= SAME_DIGITS * Math.max(1, Math.abs(a), Math.abs(b));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value: unknown, index: number) => same(value, b[index]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
// A field file of 26 (`text`) as a current field file, written `at`, and what was done to it, once the room converted has been
// opened again by the current field and kept the same (`same`).
export function convertPostsField(text: string, at = new Date().toISOString(), make?: (state: unknown) => SharedRoom) {
  const kept = parseJSON(text);
  if (!isRecord(kept) || kept.save !== FROM_SAVE) throw new Error(`O campo salvo não é do formato ${FROM_SAVE}.`);
  if (!kept.room || typeof kept.room !== 'object' || Array.isArray(kept.room)) throw new Error('O arquivo salvo não contém o estado do campo.');
  const { room, receipt } = convertPostsRoom(kept.room, make), again = (make ?? (state => new SharedRoom({ kept: state })))(clone(room));
  try {
    if (!same(clone(again.keep()), clone(room))) throw new Error('O campo convertido não se reabre igual.');
  } finally { again.world.dispose(); }
  return { text: JSON.stringify({ save: FIELD_SAVE, at, room }), receipt };
}

function main(args: readonly string[]): void {
  const value = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; },
    input = value('--input'), output = value('--output'), write = args.includes('--write');
  if (!input || !output) throw new Error('Use --input <field.json> --output <pasta nova> [--write].');
  const folder = resolve(output), file = join(folder, 'field.json');
  if (existsSync(folder)) throw new Error('A pasta de saída já existe: escolha uma nova.');
  const { text, receipt } = convertPostsField(readFileSync(resolve(input), 'utf8'));
  if (write) {
    mkdirSync(folder, { recursive: true });
    const fresh = file + '.tmp', handle = openSync(fresh, 'wx', 0o600);
    try { writeFileSync(handle, text); fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(fresh, file);
  }
  console.log(JSON.stringify({ ...receipt, written: write }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
