import type { RoomSquadView, FactionView } from '../src/field-contract.ts';
import type { CommanderProfile } from './commander-contract.ts';
import type { PublishedScene } from '../src/publication-contract.ts';
import type { ShotBlock, ShotLegend } from '../src/shots.ts';
import type { RehearsalField } from './worker-contract.ts';
import { readWorkerOptions } from './worker-contract.ts';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s: unknown) => typeof s === 'string');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
interface HostOptions { field?: RehearsalField | null; diary?: boolean; segment?: number }
interface HostPlayer { audience: string | null; squad: RoomSquadView | null; selected: string | null; faction: FactionView | null }
type PublishedState = PublishedScene & { shared?: boolean; players?: { id: string; connected?: boolean | undefined }[]; shots?: ShotBlock<ShotLegend> & { drag?: Float64Array } };
// The field as a host runs it: the room (room.ts) and all that reaches it from outside, which is the whole of what
// the field does not decide for itself. A player comes (`join`) or goes (`leave`), a page sends a command
// (`command`), the field steps (`step`) at the pace of the host's clock and deals a round of decisions at the pace
// its dealing took (room.ts), the host tells the players of the field (`tell`) — which is more than reading it: the
// fog forgets what a faction was told it sees empty, and a base places guns by what it heard of them — and keeps it
// (`keep`). Each is written down with the step it came at, in the diary of the field (field-journal.ts), and every
// second of the field a print of it (`SharedRoom.digest`). The same field given the same at the same steps goes the
// same way: its diary is enough to run it again (`replayField`), and to find where it went otherwise if it did.
// Every five minutes of the field the diary goes on in a new file, which begins from the field written out whole as it
// stands then (field-snapshot.ts): a field is run again from the last of those before what is looked into, not from
// where it began. A diary that begins from the field the server opened begins from what it was opened with.
// The diary names a seat by whose it is, never by its token, and a player's address by the order addresses came in:
// the field counts an address only to tell two apart.
import { SharedRoom, rehearsal, asked, founding, flagDraw } from './room.ts';
import { chapters } from './fog.ts';
import { Publication } from './publication.ts';
import { FIELD_SAVE } from './field-save.ts';
import { coreBuild, openDiary } from './field-journal.ts';
import { readField, writeField } from './field-snapshot.ts';
import { fieldParts } from '../src/economy.ts';
import { tellEvent, keyOf, NETWORK_VERSION } from '../src/network-protocol.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { readCommanderChoice, stepCommander } from './faction-commander.ts';
import type { CommanderChoice, CommanderObservation, CommanderState } from './commander-contract.ts';

// The number of what a diary says, raised by hand when what it says changes its shape or its meaning.
export const DIARY = 59;
const PRINT_STEPS = 60;                     // a print of the field every second of it
const SEGMENT_STEPS = 5 * 60 * 60;          // and a new diary every five minutes
const STEPPED = new Set(['pace', 'print']); // what a step writes down; all else is what reached the field

// The room of a field: the game's, or one to rehearse on (`field`: { bases, stock }), empty or resumed from what was `kept`.
export const openRoom = (field: RehearsalField | null | undefined = null, kept: unknown = null) => field ? rehearsal(field.bases, field.stock, { kept }) : new SharedRoom({ kept });

export class FieldHost {
  declare room: SharedRoom; declare field: RehearsalField | null; declare segment: number; declare publication: Publication;
  declare lines: string[] | null; declare diary: ReturnType<typeof openDiary> | null; declare places: Map<string, string>; declare dir?: string;
  // `field` is what the room was opened as (`openRoom`), for a diary to begin from. With `diary` false nothing
  // is written down: of a field nobody runs again, as the stress field. A new diary every `segment` steps.
  constructor(room: SharedRoom, { field = null, diary = true, segment = SEGMENT_STEPS }: HostOptions = {}) {
    this.room = room; this.field = field; this.segment = segment;
    this.publication = new Publication(); // what the frames tell the field as (publication.ts)
    this.lines = diary ? [] : null; this.diary = null; this.places = new Map();
  }
  note(step: number, ...entry: unknown[]) { this.lines?.push(JSON.stringify([step, ...entry])); }
  // The diary from now on is a new file in `dir`, with what was written down since the room opened from `kept`: a copy
  // of what it was opened with, taken before — a room resumed goes on with what it was given, and changes it as it
  // goes. In the field the diary begins from, each seat has its own name for a key.
  // A field the core cannot write out whole — the core of the page's, in a host that runs one — has the one diary.
  record(dir: string, kept: unknown = null) {
    if (kept !== null && (!record(kept) || !Array.isArray(kept.players))) throw new Error('Origem de diário inválida.');
    this.dir = dir;
    if (typeof this.room.field.dynamics?.core.export_state !== 'function') this.segment = Infinity;
    this.begin({ origin: record(kept) && Array.isArray(kept.players) ? { ...kept, players: kept.players.map((seat: unknown) => { if (!record(seat) || typeof seat.id !== 'string') throw new Error('Assento de diário inválido.'); return { ...seat, token: keyOf(seat.id) }; }) } : null });
  }
  // A diary in a new file, which begins from `start`, with what was written down since the one before.
  begin(start: object) {
    if (!this.dir) throw new Error('Diretório do diário ausente.');
    this.diary = openDiary(this.dir, { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT, core: coreBuild(),
      at: new Date().toISOString(), field: this.field, fieldId: this.room.fieldId, step: this.room.steps, ...start });
    this.flush();
  }
  // The diary goes on in a new file that begins from the field as it stands, written out whole (field-snapshot.ts).
  // A field that cannot be written out goes on in the diary it has, and the reason is said once.
  cut() {
    try {
      const snapshot = writeField(this.room, this.publication);
      this.flush();
      this.diary?.close();
      if (this.lines) this.begin({ origin: null, snapshot });
    } catch (error) { console.error('Foto do campo:', errorMessage(error), '— o diário segue num arquivo só.'); this.segment = Infinity; }
  }
  // What was written down goes into the diary. A diary that cannot be written is let go: the field goes on without one.
  flush() {
    if (!this.diary || !this.lines?.length) return;
    const text = this.lines.join('\n') + '\n';
    this.lines.length = 0;
    try { this.diary.write(text); }
    catch (error) { console.error('Diário do campo:', errorMessage(error), '— o campo segue sem diário.'); this.diary = this.lines = null; }
  }
  // The faction a player is told the field as; on a field without fog, everybody is told it alike.
  audience(playerId: string) { return this.room.fog ? this.room.players.get(playerId)?.factionId ?? null : null; }
  // A player comes with the key of a seat, or none (`SharedRoom.join`): a key no seat keeps is refused. An address is
  // given its name once a player from it is let in.
  join(name: unknown, token: unknown = '', address: string | null = null) {
    const seat = this.room.holder(token), place = address == null ? null : this.places.get(address) ?? `e${this.places.size + 1}`;
    this.admit(name, seat, place);
    if (place !== null && address !== null) this.places.set(address, place);
    return this.enter(name, seat, place);
  }
  // Whether the field lets a player in, with the name it is to go by (`playerName`): refused, in words, as the field
  // refuses it (`SharedRoom.admit`). What the field refuses changes nothing on it, and is not written down.
  admit(name: unknown, seat: string | null, place: string | null) { return this.room.admit(name, this.token(seat), place).called; }
  token(seat: string | null) { return seat === null ? '' : this.room.players.get(seat)?.token ?? ''; }
  // A player comes to the seat named, or to a new one, from the address of that name, with the draw of the flag of a
  // faction founded for it (`flagDraw`): written down, so that the field run again flies it too.
  enter(name: unknown, seat: string | null, place: string | null, draw = flagDraw()) {
    const called = this.admit(name, seat, place);
    this.note(this.room.steps, 'join', called, seat, place, draw);
    return this.room.join(called, this.token(seat), place, draw);
  }
  leave(playerId: string) { this.note(this.room.steps, 'leave', playerId); this.room.disconnect(playerId); }
  // Only the host can create/toggle a controller. Its decisions are internal to
  // Room.step and are recalculated on replay, rather than written twice as do.
  addCommander(name: string, profile: CommanderProfile = 'balanced', draw: string = flagDraw()) {
    if (profile !== 'balanced' && profile !== 'cautious') throw new Error('Perfil de comandante inválido.');
    const called = this.room.admit(name).called ?? '';
    this.note(this.room.steps, 'commander', called, profile, draw);
    return this.room.addCommander(called, profile, draw);
  }
  setCommanderEnabled(id: string, enabled: boolean) {
    if (!this.room.commanders.has(id) || typeof enabled !== 'boolean') throw new Error('Controlador de facção inválido.');
    this.note(this.room.steps, 'commander-enabled', id, enabled);
    return this.room.setCommanderEnabled(id, enabled);
  }
  // A command of a page, as the field reads it (`asked`): whatever else came with it reaches neither the field nor the
  // diary. A design is written down as the field keeps it, and only of what the field publishes (`SharedRoom.drafted`) or
  // puts in the library of a faction (`SharedRoom.validateDesign`).
  // A command to publish that the field refuses is written down, and run, without its design and without where the
  // construction was to stand or how it was to face: what was refused for them changes nothing on the field, and with no
  // design the field refuses the command there at the latest. The player is told why it was refused.
  // A command that may found a faction (`founding`) goes with the draw of its flag (`flagDraw`), written down after it:
  // a field run again flies that flag too.
  command(playerId: string, data: unknown, draw: string | null = null) {
    const said = asked(data);
    let refused: unknown = null;
    if (said.type === 'spawn' || said.type === 'replace')
      try { said.blueprint = this.room.drafted(playerId, said); } catch (error) { refused = error; delete said.blueprint; delete said.x; delete said.facing; }
    if (said.type === 'library' && said.act === 'publish')
      try { said.blueprint = this.room.validateDesign(said.blueprint); } catch (error) { refused = error; delete said.blueprint; }
    if (founding(said)) draw ??= flagDraw();
    this.note(this.room.steps, 'do', playerId, said, ...(draw === null ? [] : [draw]));
    try { return this.room.command(playerId, said, draw); } catch (error) { throw refused ?? error; }
  }
  // One step of the field, with what lapses before it. `paced` says the pace a round that ends in it is dealt at,
  // given the pace measured and the step: by default the one measured. What happens on a field nobody is connected
  // to nobody hears: it is let go at once.
  // A final Native print closes a duel. Keep at most one second of physical
  // aftermath, with all orders stopped; replay and cold restart share this end.
  get ended(): boolean { return this.room.ended && this.room.steps % PRINT_STEPS === 0; }
  // Experimental selectors share the ordinary cadence, memory and admission.
  // Journal their chosen intention so a replay does not rerun a neural model.
  decideCommander(id: string, choose: (o: CommanderObservation, state: CommanderState) => CommanderChoice): boolean {
    const state = this.room.commanders.get(id);
    if (!state) throw new Error('Comandante ausente.');
    return stepCommander(this.room, id, state, (o, memory) => {
      const choice = readCommanderChoice(choose(o, memory), o.time);
      this.note(this.room.steps, 'commander-decision', id, choice);
      return choice;
    });
  }
  step(paced: (measured: number, step: number) => number = measured => measured, beforeQuietDrain: (() => void) | null = null) {
    if (this.ended) throw new Error('O duelo terminou. O resultado é definitivo.');
    const room = this.room, step = room.steps;
    room.checkLeases();
    room.step({ quiet: true, pace: measured => { const pace = paced(measured, step); this.note(step, 'pace', pace); return pace; } });
    if (![...room.players.values()].some(p => p.connected)) { beforeQuietDrain?.(); room.field.drainEvents(); }
    if (this.lines && room.steps % PRINT_STEPS === 0) this.note(room.steps, 'print', room.digest());
    if (this.diary && room.steps % this.segment === 0) this.cut();
  }
  // What the field tells the players `playerIds` of itself now: the state of the field as it is published and what
  // happened on it since it was last told, to each faction (`audiences`) as the fog leaves them to it; and to each
  // player (`players`) the faction it is told the field as, its squad, the construction it has selected and, when
  // `quoted`, its faction with what things cost on the field: `quoted` is true for every player, or the players it is
  // for, by id. `quotes` names those players; `spent` is how long reading the field took, in milliseconds.
  tell(playerIds: readonly string[], quoted: boolean | readonly string[] = false) {
    const room = this.room, started = performance.now();
    this.note(room.steps, 'tell', playerIds, quoted);
    const state: PublishedState = room.world.snapshot((snapshot, sources) => this.publication.state(snapshot, sources));
    // With the drag of each round a frame tells it once: the pages follow it from there.
    if (!state.shots) throw new Error('Snapshot sem bloco de tiros.');
    state.shots = { ...state.shots, drag: room.world.shotDrags };
    state.shared = true;
    state.players = room.roster();
    const spent = performance.now() - started, events = room.world.drainEvents().map(tellEvent), parts = room.fog ? chapters(state) : null,
      of = new Map(playerIds.map(id => [id, this.audience(id)])), audiences = new Map<string | null, ReturnType<SharedRoom['audience']>>(), players = new Map<string, HostPlayer>();
    for (const id of new Set(of.values())) audiences.set(id, room.audience(state, parts, events, id));
    const quotes = new Set(quoted === true ? playerIds : quoted || []), costs = quotes.size ? fieldParts(room.world) : null,
      wrecks = new Map(), squads = new Map(); // shared faction knowledge for this publication; reach stays each player's
    for (const id of playerIds) players.set(id, { audience: of.get(id) ?? null, squad: room.squadView(id, squads), selected: room.players.get(id)?.selected ?? null,
      faction: quotes.has(id) ? room.factionView(id, costs ?? undefined, wrecks) : null });
    return { state, audiences, players, quotes, spent };
  }
  // What the field keeps of itself (`SharedRoom.keep`), to be written out.
  keep() { this.note(this.room.steps, 'keep'); return this.room.keep(); }
  // The field fell: the diary says where, and of what.
  fault(error: unknown) { this.note(this.room.steps, 'fault', errorMessage(error)); this.flush(); }
}

class Diverged extends Error {}

// A field run again from its diary (`lines`, the first saying what it began from: the field the server opened, or the
// field written out whole where the diary before it stopped), as far as the diary goes or to
// step `until`: the field it began as, given what reached it at the steps it came, its rounds dealt at the paces
// they were dealt at then. What the host writes down as it goes is set against what was written down then, line by
// line, the prints with the rest: the first that differs is where the field went otherwise. Where the field fell
// it falls again, or it does not. Says how it went (`how`: `end`, alike as far as the diary goes; `until`; `fell`,
// alike to where it fell, with the error; `diverged`, with the line `expected` and the one it `got`), with the host
// of the field as it then stands, the step, how many lines were `read` and how many `prints` agreed.
// `progress` is told the step after each step.
export interface ReplayOutcome {
  how: 'end' | 'until' | 'fell' | 'diverged'; header: Record<string, unknown>; host: FieldHost;
  step: number; read: number; prints: number; expected?: string | null; got?: string; error?: unknown;
}
interface DiaryEntry { at: number; kind: string; args: unknown[] }
export type ReplayObservation = 'ready' | 'step' | 'input' | 'before-drain' | 'before-tell';
function json(line: string | undefined): unknown { try { return line === undefined ? null : JSON.parse(line); } catch { return null; } }
function diaryEntry(line: string | undefined): DiaryEntry | null {
  const row = json(line); if (!Array.isArray(row) || typeof row[0] !== 'number' || typeof row[1] !== 'string') return null;
  return { at: row[0], kind: row[1], args: row.slice(2) };
}
export async function replayField(lines: Iterable<string> | AsyncIterable<string>, { until = Infinity, progress = null, observe = null }: {
  until?: number; progress?: ((step: number) => void) | null;
  observe?: ((host: FieldHost, phase: ReplayObservation) => void) | null;
} = {}): Promise<ReplayOutcome> {
  const reader = Symbol.asyncIterator in lines ? lines[Symbol.asyncIterator]() : lines[Symbol.iterator]();
  let ahead: string | null | undefined = null, read = 0, prints = 0, host: FieldHost;
  const peek = async (): Promise<string | undefined> => { if (ahead === null) { const { value, done } = await reader.next(); ahead = done ? undefined : value; } return ahead; },
    take = () => { ahead = null; read++; };
  const raw = json(await peek()); take();
  if (!record(raw) || raw.diary !== DIARY) throw new Error(`Este diário é de outra versão (${record(raw) ? raw.diary : undefined}; esta lê a ${DIARY}). Preserve o arquivo e use a versão do jogo que o gravou; diários e fotos binárias não são convertidos.`);
  const header = raw;
  if (header.contract !== CORE_CONTRACT) throw new Error(`Este diário é de outro contrato do núcleo (${header.contract}; este lê o ${CORE_CONTRACT}). Preserve o arquivo e use a versão do jogo que o gravou; o estado binário não pode ser reinterpretado.`);
  if (header.save !== FIELD_SAVE) throw new Error(`Este diário é de outra versão do campo salvo (${header.save}; esta lê a ${FIELD_SAVE}).`);
  if (header.network !== NETWORK_VERSION) throw new Error(`Este diário é de outra versão da rede (${header.network}; esta lê a ${NETWORK_VERSION}).`);
  const field = readWorkerOptions({ rehearsal: header.field ?? null }).rehearsal ?? null;
  if (header.snapshot) {
    host = new FieldHost(openRoom(field), { field });
    if (typeof host.room.field.dynamics?.core.import_state !== 'function') throw new Error('Este diário começa de uma foto do campo, que só o núcleo nativo lê.');
    host.publication = readField(host.room, header.snapshot);
  } else host = new FieldHost(openRoom(field, header.origin), { field });
  if (typeof header.fieldId === 'string' && header.fieldId) host.room.fieldId = header.fieldId;
  const room = host.room, outcome = (how: ReplayOutcome['how'], more: Pick<ReplayOutcome, 'expected' | 'got' | 'error'> = {}): ReplayOutcome => ({ how, header, host, step: room.steps, read, prints, ...more });
  const compare = async (): Promise<ReplayOutcome | null> => {
    for (const mine of host.lines?.splice(0) ?? []) {
      const theirs = await peek();
      if (mine !== theirs) return outcome('diverged', { expected: theirs ?? null, got: mine });
      if (diaryEntry(mine)?.kind === 'print') prints++;
      take();
    }
    return null;
  };
  const paced = (_measured: number, step: number): number => {
    const said = diaryEntry(ahead ?? undefined);
    if (said?.kind !== 'pace' || said.at !== step || typeof said.args[0] !== 'number') throw new Diverged(`uma rodada terminou no passo ${step}`);
    return said.args[0];
  };
  const fell = async (error: unknown): Promise<ReplayOutcome> => {
    if (error instanceof Diverged) return outcome('diverged', { expected: ahead ?? null, got: error.message });
    host.fault(error);
    const differs = await compare();
    return differs ? { ...differs, error } : outcome('fell', { error });
  };
  const step = async (): Promise<ReplayOutcome | null> => {
    await peek();
    try { host.step(paced, observe ? () => observe(host, 'before-drain') : null); } catch (error) { return fell(error); }
    progress?.(room.steps);
    const differs = await compare();
    if (!differs) observe?.(host, 'step');
    return differs;
  };
  observe?.(host, 'ready');
  for (;;) {
    const line = await peek(), said = diaryEntry(line);
    if (!said) return outcome('end');
    const { at, kind, args } = said;
    if (STEPPED.has(kind)) { if (room.steps >= until) return outcome('until'); const differs = await step(); if (differs) return differs; continue; }
    while (room.steps < at && room.steps < until) { const differs = await step(); if (differs) return differs; }
    if (room.steps >= until) return outcome('until');
    if (room.steps > at || kind === 'fault') return outcome('diverged', { expected: line ?? null, got: room.steps > at ? `passo ${room.steps}` : 'o campo seguiu de pé' });
    if (kind === 'tell') observe?.(host, 'before-tell');
    try {
      if (kind === 'join') { const [name, seat, place, draw] = args; if (seat !== null && typeof seat !== 'string' || place !== null && typeof place !== 'string' || typeof draw !== 'string') throw new Error('Entrada de assento inválida.'); host.enter(name, seat, place, draw); }
      else if (kind === 'do') { const [id, data, draw] = args; if (typeof id !== 'string' || draw !== undefined && draw !== null && typeof draw !== 'string') throw new Error('Comando de diário inválido.'); host.command(id, data, draw ?? null); }
      else if (kind === 'leave') { if (typeof args[0] !== 'string') throw new Error('Saída de diário inválida.'); host.leave(args[0]); }
      else if (kind === 'commander') {
        const [name, profile, draw] = args;
        if (typeof name !== 'string' || profile !== 'balanced' && profile !== 'cautious' || typeof draw !== 'string') throw new Error('Controlador de diário inválido.');
        host.addCommander(name, profile, draw);
      }
      else if (kind === 'commander-decision') {
        const [id, raw] = args;
        if (typeof id !== 'string') throw new Error('Assento de decisão inválido.');
        if (!host.decideCommander(id, () => readCommanderChoice(raw, room.world.time)))
          throw new Error('Decisão de comandante antes do próximo ciclo.');
      }
      else if (kind === 'commander-enabled') {
        const [id, enabled] = args;
        if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('Ativação de controlador inválida.');
        host.setCommanderEnabled(id, enabled);
      }
      else if (kind === 'tell') { const [ids, quoted] = args; if (!strings(ids) || typeof quoted !== 'boolean' && !strings(quoted)) throw new Error('Publicação de diário inválida.'); host.tell(ids, quoted); }
      else if (kind === 'keep') host.keep();
      else return outcome('diverged', { expected: line ?? null, got: 'uma entrada que este jogo não conhece' });
    } catch (error) {
      // Expected refusals still produce their original note. A rejection before
      // note cannot consume this entry; swallowing it would retry it forever.
      if (!['join', 'do', 'keep'].includes(kind) || !host.lines?.length) return fell(error);
    }
    const differs = await compare(); if (differs) return differs;
    observe?.(host, 'input');
  }
}
