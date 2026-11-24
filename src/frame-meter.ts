import { tr, locale } from './i18n.ts';
// The meter of the frames: how many frames a second the page draws, how long the worst of them was in coming and,
// when that is poor, what the time went on. It is a diagnosis the player asks for: until then every call here
// returns at once, and nothing is timed.
//
// A frame is a turn of the loop that drew. It begins with the time the browser gave the turn (`begin`), and each
// stretch of its work is marked as it ends (`mark`): the time since the mark before goes under the name given.
// Work done between two frames is told under a name of its own (`run`, `add`): the panels, a state of the world
// taken in. How long a frame was in coming is the time from the frame before, and what was marked or told in
// between is what the page spent of it: the work of one frame is what makes the next one late.
//
// The simulation is not on this thread. A world that runs slow, in the worker of a test or on the server of the
// field, makes no frame long: it shows in how its states arrive (`state`). Each brings some time of the world, to
// be shown over as much time of the page, and the picture stands still when the next comes later than that.
//
// Twice a second the meter tells of the last second (`end`): the frames a second, the worst of them, and what is
// wrong when something is, in no more than two causes.

// The optional economy limit is sixty frames a second. Diagnose against this baseline even when
// automatic follows a faster display: the report still counts every frame actually drawn.
const DUE = 1000 / 60;
// A second is told of, in two halves: a report is made as each of them ends.
const HALF = 500;
// The frames are poor under this many a second, a second that lost one frame in six, or with one that was longer
// in coming than two and a half are due, a hitch anyone sees. A display of 60 Hz gives frames of 17, 33 or 50 ms,
// and a faster one, paced down to sixty, some of up to 33 ms with nothing wrong: one frame of 33 ms says nothing,
// and the mark stands clear of both, between 33 and 50.
export const POOR_FPS = 50, LONG_FRAME = 2.5 * DUE;
// The causes are those of the late frames of the second, when it has any: a frame this long in coming lost one on
// a display of 60 Hz. A second that is slow with none of them is slow all through, and all its frames are told of.
const LATE_FRAME = 1.8 * DUE;
// The page is the cause when what it spent on the frames is at least this share of how long they were in coming.
const PAGE_SHARE = .5;
// A second cause is told when it weighs at least this share of the first.
const SECOND_SHARE = 1 / 3;
// The world is slow when it goes on by less than this share of the time that passes, and it stalls when its
// picture stood still for longer than this many milliseconds: six frames with nothing new in them.
const SLOW_WORLD = .9, STALL = 100;
// A pace is told of this many states or more.
const PACED = 3;
// A cause stays on the screen this long after the second it was found in: a hitch is one frame, and nobody reads
// a line in half a second.
export const HOLD = 3000;

// What each name is called on the screen, and what is counted with it.
const PHASES: Record<string, readonly [label: string, counted?: string]> = {
  camera: [tr('câmera')],
  playback: [tr('interpolação do mundo')],
  sight: [tr('terreno à vista (névoa de guerra)')],
  constructions: [tr('desenho das construções'), tr('na tela')],
  effects: [tr('efeitos e partículas'), tr('partículas')],
  shots: [tr('projéteis'), tr('à vista')],
  terrain: ['terreno e subsolo'],
  scenery: [tr('céu, árvores e pedras')],
  sites: ['jazidas, bases e obras'],
  mist: [tr('névoa do chão')],
  overlay: [tr('mira e marcações')],
  board: [tr('desenho da Oficina')],
  gpu: [tr('envio à placa de vídeo')],
  overview: [tr('visão geral do campo')],
  sound: ['som'],
  hud: [tr('leituras da mira')],
  panels: [tr('painéis da interface')],
  simulation: [tr('recebimento dos estados da simulação')],
  network: [tr('recebimento dos estados da rede')],
};

// The detail of the frames, when the player asks for it (`detailed`): the parts of a frame as he reads them, each with
// the names whose time is told under it, and last what the page did not spend of the time between two frames, which went
// on the GPU or in the browser. A name the meter does not know is told among the others.
export const PARTS: readonly (readonly [part: string, names: readonly string[]])[] = Object.freeze([
  [tr('Física e rede'), ['simulation', 'network']],
  [tr('Apresentação'), ['camera', 'playback', 'sound']],
  [tr('Terreno e subsolo'), ['terrain', 'sight', 'mist']],
  [tr('Céu, árvores e pedras'), ['scenery']],
  ['Jazidas, bases e obras', ['sites']],
  [tr('Veículos'), ['constructions']],
  [tr('Efeitos e tiros'), ['effects', 'shots']],
  [tr('Rótulos e interface'), ['overlay', 'board', 'overview', 'hud', 'panels']],
  [tr('Envio à placa de vídeo'), ['gpu']],
]);
const OTHERS = tr('Outros'), OUTSIDE = tr('Fora da página');
const partOf: Record<string, string> = Object.fromEntries(PARTS.flatMap(([part, names]) => names.map(name => [name, part])));
// What is counted on each frame in detail (`tally`), and what each is called on the screen.
export const TALLIES = Object.freeze({ draws: tr('desenhos enviados'), textures: tr('texturas enviadas'), buffers: tr('geometrias enviadas') });

export interface FrameDetailLine { label: string; mean: string; worst: string }
export interface FrameDetail { parts: FrameDetailLine[]; tallies: FrameDetailLine[]; shown: number; notes: Record<string, string> }
export interface FrameReport { fps: number; worst: number; poor: boolean; causes: string[]; rate: string; detail?: FrameDetail }
interface FrameTotals { frames: number; span: number; page: number; by: Record<string, number> }
interface HalfWindow {
  all: FrameTotals; late: FrameTotals; worst: number; heaviest: number; busy: number; states: number; gaps: number; played: number; still: number;
  parts: Record<string, number>; peaks: Record<string, number>; tallied: Record<string, number>; tallyPeaks: Record<string, number>;
}
interface WorldSource { field: boolean; told: number | null; ping: number }
interface StateArrival { now: number; at: number; due: number }
export interface FrameState { time: number; speed?: number; field?: boolean; told?: number | null; ping?: number }

const time = (ms: number): string => ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 }) + ' s';
// A part of a frame told to the tenth of a millisecond, as the detail tells it.
const fine = (ms: number): string => ms.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = (share: number): string => Math.round(share * 100) + '%';
// Some frames as one: how many, how long they were in coming, and what the page spent of that, in all and by name.
const tally = (): FrameTotals => ({ frames: 0, span: 0, page: 0, by: {} });
function joined(a: FrameTotals, b: FrameTotals): FrameTotals {
  const both = { frames: a.frames + b.frames, span: a.span + b.span, page: a.page + b.page, by: { ...a.by } };
  for (const [name, value] of Object.entries(b.by)) both.by[name] = (both.by[name] || 0) + value;
  return both;
}
// Half a second: its frames, the late ones among them, the worst, the most the page spent on one of them and the
// longest task the browser told of; and the states of the world that came, the time between them, the time of the
// world they brought, and the longest its picture stood still.
const half = (): HalfWindow => ({ all: tally(), late: tally(), worst: 0, heaviest: 0, busy: 0, states: 0, gaps: 0, played: 0, still: 0,
  // In detail: by part, the time of every frame and the most of one; and the same of what was counted on them.
  parts: {}, peaks: {}, tallied: {}, tallyPeaks: {} });
const most = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => { const both = { ...a }; for (const [key, value] of Object.entries(b)) both[key] = Math.max(both[key] || 0, value); return both; };
const sum = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => { const both = { ...a }; for (const [key, value] of Object.entries(b)) both[key] = (both[key] || 0) + value; return both; };

// The causes of slow frames. `set` are the frames told of, `heaviest` the most the page spent on one frame of the
// second, `busy` the longest task the browser told of in it, and `counts` what was last counted with each name.
function frameCauses(set: FrameTotals, heaviest: number, busy: number, counts: Record<string, number>): string[] {
  const coming = set.span / set.frames, spent = set.page / set.frames;
  if (spent >= coming * PAGE_SHARE) {
    const ranked = Object.entries(set.by).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const first = ranked[0];
    return (first ? ranked.filter(([, total]) => total >= first[1] * SECOND_SHARE) : []).map(([name, total]) => {
      const [label, counted] = PHASES[name] || [name], count = counts[name];
      return `${label} ${time(total / set.frames)}` + (counted && count ? ` (${count.toLocaleString(locale())} ${counted})` : '');
    });
  }
  // The frames were long in coming and the page spent little of that. A long task nothing marked was work on this
  // thread all the same, of the browser or of code no name is given to. With none, the page was waiting.
  return [busy > 0 && busy - heaviest >= busy / 2 ? tr`página ocupada ${time(busy)} fora das fases medidas (layout, coleta de lixo ou outro código)`
    : tr`fora da página: GPU ou navegador (a página usou ${coming < 1000 ? Math.round(spent) : time(spent)} de ${time(coming)})`];
}

export class FrameMeter {
  declare clock: () => number;
  declare spent: Record<string, number>;
  declare counts: Record<string, number>;
  declare tallies: Record<string, number>;
  declare notes: Record<string, string>;
  declare detailed: boolean;
  declare on: boolean;
  declare kept: { causes: string[]; until: number } | null;
  declare last: number | null;
  declare turned: number | null;
  declare marked: number | null;
  declare arrived: StateArrival | null;
  declare source: WorldSource | undefined;
  declare halves: [HalfWindow, HalfWindow];
  constructor(clock = () => performance.now()) {
    this.clock = clock; this.spent = {}; this.counts = {}; this.tallies = {}; this.notes = {}; this.detailed = false; this.turn(false);
  }
  // Turned on or off, the meter knows nothing of before. `detailed`, it tells of every part of the frames besides.
  turn(on: boolean, detailed = this.detailed) { this.on = on; this.detailed = on && detailed; this.kept = null; this.forget(); }
  // In detail, what the frame counted: so many more of `name` (TALLIES); and what the page says of how it draws, as words.
  tally(name: string, count = 1) { if (this.detailed) this.tallies[name] = (this.tallies[name] || 0) + count; }
  note(name: string, words: string) { if (this.detailed) this.notes[name] = words; }
  // Nothing was drawn for a while, the tab away or the field not ready: the time until the next frame is no
  // frame's, and what was gathered is of a second long gone. What was last found wrong is still told for its moment.
  rest() { if (this.on) this.forget(); }
  forget() { this.last = this.turned = this.marked = this.arrived = null; this.halves = [half(), half()]; this.tallies = {}; }
  // The world shown is another: nothing is due after the last state of the one before.
  renew() { this.arrived = null; }
  begin(stamp: number) {
    if (!this.on) return;
    if (this.last === null) { for (const name in this.spent) this.spent[name] = 0; this.tallies = {}; this.turned = stamp; }
    else this.close(stamp - this.last);
    this.last = stamp; this.marked = this.clock();
  }
  // The stretch of the frame that ends here, by name, and what was counted in it. A mark outside a frame is of nothing.
  mark(name: string, count?: number) {
    if (!this.on || this.marked === null) return;
    const now = this.clock(); this.spent[name] = (this.spent[name] || 0) + now - this.marked; this.marked = now;
    if (count !== undefined) this.counts[name] = count;
  }
  add(name: string, ms: number) { if (this.on) this.spent[name] = (this.spent[name] || 0) + ms; }
  run<T>(name: string, work: () => T): T {
    if (!this.on) return work();
    const started = this.clock();
    try { return work(); } finally { this.add(name, this.clock() - started); }
  }
  // A task of 50 ms or more, as the browser tells of it some time after: only the longest of a second is kept.
  busy(ms: number) { if (this.on) this.halves[1].busy = Math.max(this.halves[1].busy, ms); }
  // The frame before took this long to be followed by another.
  close(interval: number) {
    const half = this.halves[1], spent = this.spent;
    let page = 0;
    for (const value of Object.values(spent)) page += value;
    half.worst = Math.max(half.worst, interval); half.heaviest = Math.max(half.heaviest, page);
    for (const set of interval > LATE_FRAME ? [half.all, half.late] : [half.all]) {
      set.frames++; set.span += interval; set.page += page;
      for (const [name, value] of Object.entries(spent)) if (value) set.by[name] = (set.by[name] || 0) + value;
    }
    if (this.detailed) {
      const parts = { [OUTSIDE]: Math.max(0, interval - page) };
      for (const [name, value] of Object.entries(spent)) { const part = partOf[name] ?? OTHERS; parts[part] = (parts[part] || 0) + value; }
      half.parts = sum(half.parts, parts); half.peaks = most(half.peaks, parts);
      half.tallied = sum(half.tallied, this.tallies); half.tallyPeaks = most(half.tallyPeaks, this.tallies);
      for (const name in this.tallies) this.tallies[name] = 0;
    }
    for (const name in spent) spent[name] = 0;
  }
  // A state of the world came in at `now`, with the world at `time` seconds and shown at `speed` times its pace:
  // none, while the world stands. `field` says it came from the server of the shared field, `told` what share of
  // the time that passes the sender says its world goes on by, when it says, and `ping` the way there and back.
  state(now: number, { time: at, speed = 1, field = false, told = null, ping = 0 }: FrameState) {
    if (!this.on) return;
    const before = this.arrived;
    this.source = { field, told, ping };
    // A world that stands or that began again has no pace to keep.
    if (!(speed > 0) || before && at < before.at) { this.arrived = null; return; }
    // A state with no time of the world in it is news of something else, an aim or an order.
    if (before && at === before.at) return;
    const due = before ? (at - before.at) * 1000 / speed : Infinity;
    if (before) {
      const half = this.halves[1], gap = now - before.now;
      half.states++; half.gaps += gap; half.played += due; half.still = Math.max(half.still, gap - before.due);
    }
    this.arrived = { now, at, due };
  }
  // The work of the frame is done. Every half second this tells of the last second, and of nothing in between:
  // `fps` and `worst`, the same as the line `rate`; `poor`, when something is wrong in this second; and `causes`,
  // the lines of what is wrong, or of what was a moment ago.
  end(stamp: number): FrameReport | null {
    if (!this.on) return null;
    this.marked = null;
    if (stamp - (this.turned ?? 0) < HALF) return null;
    const told = this.tell(stamp);
    this.halves = [this.halves[1], half()]; this.turned = stamp;
    return told;
  }
  tell(now: number): FrameReport | null {
    const [before, last] = this.halves, all = joined(before.all, last.all), late = joined(before.late, last.late);
    if (!all.frames) return null;
    const fps = all.frames * 1000 / all.span, worst = Math.max(before.worst, last.worst);
    // While the frames are slow nothing is said of the world: its states are taken in on the thread that is late.
    let causes = Math.round(fps) < POOR_FPS || worst > LONG_FRAME
      ? frameCauses(late.frames ? late : all, Math.max(before.heaviest, last.heaviest), Math.max(before.busy, last.busy), this.counts)
      : this.worldCauses(now, before, last);
    const poor = causes.length > 0;
    if (poor) this.kept = { causes, until: now + HOLD };
    else if (this.kept && now < this.kept.until) causes = this.kept.causes;
    const told: FrameReport = { fps, worst, poor, causes, rate: `${Math.round(fps)} FPS · pior ${time(worst)}` };
    if (this.detailed) told.detail = this.detail(all.frames, before, last);
    return told;
  }
  // The detail of the last second, over its `frames`: each part of them, on average and in the frame it weighed most on,
  // in milliseconds to the tenth; what was counted on them likewise; how many constructions were on the screen, and what
  // the page says of how it draws (`note`).
  detail(frames: number, before: HalfWindow, last: HalfWindow): FrameDetail {
    const parts = sum(before.parts, last.parts), peaks = most(before.peaks, last.peaks),
      tallied = sum(before.tallied, last.tallied), tallyPeaks = most(before.tallyPeaks, last.tallyPeaks),
      line = (label: string, total: number, peak: number, figure: (value: number) => string): FrameDetailLine => ({ label, mean: figure(total / frames), worst: figure(peak) }),
      labels = [...PARTS.map(([part]) => part), ...parts[OTHERS] ? [OTHERS] : [], OUTSIDE];
    return {
      parts: labels.map(label => line(label, parts[label] || 0, peaks[label] || 0, fine)),
      tallies: Object.entries(TALLIES).map(([name, label]) => line(label, tallied[name] || 0, tallyPeaks[name] || 0, n => Math.round(n).toLocaleString(locale()))),
      shown: this.counts.constructions ?? 0, notes: { ...this.notes },
    };
  }
  // What is wrong with the world while the frames are drawn in time: it goes on slower than the time that passes,
  // or its picture stood still, as it does now when the state due has not come.
  worldCauses(now: number, before: HalfWindow, last: HalfWindow): string[] {
    const arrived = this.arrived;
    if (!arrived || !this.source) return [];
    const states = before.states + last.states, gaps = before.gaps + last.gaps, { field, told, ping } = this.source,
      pace = states >= PACED ? (before.played + last.played) / gaps : 1,
      still = Math.max(before.still, last.still, now - arrived.now - arrived.due);
    if (pace < SLOW_WORLD) {
      const going = tr`${percent(pace)} do tempo real`, rate = `${Math.round(states * 1000 / gaps)} estados/s`;
      // Arrivals include time waiting on this page's thread; a healthy server alone cannot attribute that delay to the network.
      return [!field ? tr`simulação lenta: o mundo anda a ${going}`
        : told !== null && told < SLOW_WORLD ? tr`servidor lento: o mundo anda a ${going}, ${rate}` : tr`atualizações atrasadas: o mundo chega a ${going}, ${rate}`];
    }
    if (still > STALL) return [field ? tr`servidor ou rede: até ${time(still)} sem estado novo` + (ping ? `, ping ${Math.round(ping)} ms` : '')
      : tr`simulação irregular: até ${time(still)} sem estado novo`];
    return [];
  }
}

// The video card as the browser names it (client-performance.ts), without what only a driver reads: the vendor ANGLE
// puts before it, the ids of the device and the models of the shaders.
export function cardName(renderer: string | null | undefined): string {
  if (!renderer) return tr('não informada pelo navegador');
  const fields = renderer.match(/^ANGLE \((.*)\)$/)?.[1]?.split(', ') ?? [renderer];
  return (fields[1] ?? fields[0] ?? '').replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+[vp]s_\d_\d/g, '').trim();
}
// The lines under the detail of the frames: what was on the screen and how near it was drawn (`note`), on what card
// (`gpu`, the name the browser gives) and on how much screen, in its points (`screen`) and in the pixels drawn.
export function detailLines(detail: FrameDetail, { gpu, screen, pixels }: { gpu: string | null | undefined; screen: readonly number[]; pixels: readonly number[] }): string[] {
  const { shown, notes } = detail;
  return [tr`Veículos e estruturas na tela: ${shown.toLocaleString(locale())}` + (notes.vehicles ? ` · ${notes.vehicles}` : ''),
    ...notes.ground ? [`Terreno: ${notes.ground}`] : [], tr`Placa de vídeo: ${cardName(gpu)}`,
    `Tela: ${screen.map(Math.round).join('×')} · ${pixels.map(Math.round).join('×')} pixels`];
}
