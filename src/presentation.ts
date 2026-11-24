import type { Point } from './math.ts';
import type { FieldView } from './faction-ui.ts';
import type { GeometrySource, FrameActor, FrameBody, SceneSample } from './scene-frame.ts';
import type { ShotBlock, ShotLegend, ShotView } from './shots.ts';
import type { SceneEventBase, EventPoint } from './scene-contract.ts';
import type { SlowStrike } from './slow-motion.ts';
interface PresentationActor extends FrameActor {vehicle?: (FrameBody & {flying?:boolean|undefined;thrustN?:number|undefined;vy?:number|undefined}) | null | undefined}
export interface PresentationState extends GeometrySource {
 time:number;shared?:boolean|undefined;pace?:number|undefined;controlledActor?:string|null|undefined;shots?:ShotBlock<ShotLegend>|undefined;
 actors?:readonly PresentationActor[];
}
export interface ShotViewport {left:number;right:number;top:number;bottom:number;whole?:number}
interface TrailPoint extends Point {time:number;corner?:boolean;vx?:number;vy?:number;length?:number}
interface TrailMetadata {ammo?:string|undefined;weapon?:string|null|undefined;preset?:string|null|undefined;poweredTrail?:boolean|null|undefined;actorId?:string|null|undefined;radius?:number|undefined}
interface PrimaryFlight extends SceneEventBase {type:'flight';id:string;points:EventPoint[];fragment?:false}
function isPrimaryFlight(event:SceneEventBase):event is PrimaryFlight {
 if (event.type!=='flight'||!event.id||event.fragment) return false;
 if (!Array.isArray(event.points)) throw new TypeError('A trajetória de voo não tem pontos.');
 return true;
}
interface PrimaryPath extends TrailMetadata {id:string;n?:number;points:TrailPoint[];terminal?:boolean;fragment?:false}
interface TrailPacket extends TrailMetadata {id:string;key:number|string;points:TrailPoint[];terminal:boolean;arc?:ArcPoint[]}
interface FadedPoint extends Point {time:number;fade:number}
interface ArcPoint extends Point {fade:number}
export interface ShotTrail extends TrailMetadata {id:string;x:number;y:number;vx:number;vy:number;points:FadedPoint[];terminal:boolean;age:number;fade:number}
export interface FallenArc extends TrailMetadata {id:string;points:ArcPoint[];x:number;y:number;flight:number;age:number;fade:number}
export interface ShownPath extends PrimaryPath, Point {number:number|undefined;vx?:number;vy?:number;length?:number;time?:number;age?:number}
export type PresentedShot = (ShotView | ShownPath) & {fragment?:false;fade?:never};
export interface ProjectileSpecks {count:number;x:Float64Array;y:Float64Array;kind:Uint32Array;kinds:readonly ShotLegend[]}
interface AlongPaths {ends:Map<number,number>;places:Map<number|string,number>;sieve:Uint8Array}
interface RemoteClock {time:number;at:number;measuredAt:number;measuredTime:number;pace:number;maxPace:number;pendingPace:number}
interface HistoryEntry<State> {state:State;changeTime:number;maxPace:number;pace:number}
export interface PresentationSample<State extends PresentationState=FieldView> {
 alpha:number;time:number;state:State;previous:State|null;scene:SceneSample<State>;
 view?:ShotViewport|null;trailReach?:number;events?:SceneEventBase[];shots?:PresentedShot[];specks?:ProjectileSpecks;shotTrails?:ShotTrail[];fallenArcs?:FallenArc[];
}
export type PresentationFrame<State extends PresentationState=FieldView> = PresentationSample<State> & {
 events:SceneEventBase[];shots:PresentedShot[];specks:ProjectileSpecks;shotTrails:ShotTrail[];fallenArcs:FallenArc[];previousDisplay:PresentationSample<State>|null;
};
interface PresentOptions<State> {prepare?:(state:State)=>void;update?:(dt:number)=>void;consume?:(event:SceneEventBase,offset:number)=>void}
interface ReceiveOptions {now?:number;paused?:boolean;pace?:number;flight?:Readonly<SlowStrike>|null;visible?:boolean;maxPace?:number}
import { clamp, lerp } from './math.ts';
import { sampleScene } from './scene-frame.ts';
import { SHOT_WORDS, SHOT_KIND, SHOT_X, SHOT_Y, SHOT_VX, SHOT_VY, SHOT_AGE, SHOT_RADIUS, shotCount, shotId, shotAt } from './shots.ts';

const damageEvents = new Set(['blocked', 'penetration', 'ricochet', 'module', 'explosion', 'spall', 'secondary-impact', 'secondary-ray']);
// How long the tail of a round that has ended stays, and how old the far end of a live tail may be.
const PRIMARY_TRAIL_LIFE = .14;
const PRIMARY_TRAIL_SECONDS = 8;
const MAX_PRIMARY_TRAILS = 128;
const MAX_PRIMARY_TRAIL_POINTS = 40;
// The turns a round took this long before it stopped are shown whole in its tail, down to this strength at the first of them.
const LAST_TURNS = .1, TURNED_STRENGTH = .6;
// The whole arc of a round that flew this long stays where it fell: the last one of each gun.
const FALLEN_ARC_FLIGHT = 1;
const FALLEN_ARC_LIFE = 5;
const MAX_FALLEN_ARCS = 8;
// The arc is there to correct the next aim by where the round fell. It is drawn from that
// end: nothing over the first part of the flight, so that no line hangs over the gun seen
// from near, and in full from this share of the flight on.
const FALLEN_ARC_HIDDEN = .3, FALLEN_ARC_FULL = .7;
// An age is kept in single precision: a round is taken for born this much of a second before its age says so.
const UNBORN = 1e-6;
// m/s up or down faster than which an aircraft that does not fly is in the air, not standing on its skids: coasting up on
// the speed it climbed at, or falling. It touches down at 0.5 (game_hover.rs `TOUCH`).
const ADRIFT = 1;
// How long the motor of a rocket lays its smoke.
const BURN = .8;
// A short reserve of remote states absorbs delivery jitter without predicting physics.
const REMOTE_DELAY = .075, REMOTE_HISTORY = 6, REMOTE_GAP = .5;

// The rounds that fly along a path are a few of thousands. A number is looked up among theirs only when its low
// bits are those of one of them: a byte read for nearly every round, where a search of the map would be made.
const SIEVE = 4095;
// A round of the block is not shown from it before it was born, nor while a path of the delivery tells where it is.
const hidden = (paths:AlongPaths,number:number,age:number,gap:number,time:number) => gap > age + UNBORN || paths.sieve[number & SIEVE] === 1 && time <= paths.ends.get(number)! + 1e-10;
// One round of a block as an object, where it was `back` seconds before its snapshot: it only flew on, so it
// was that much of its velocity behind.
function flownBack(shots:ShotBlock<ShotLegend>,index:number,back:number):ShotView {
  const shot = shotAt(shots, index);
  shot.x -= shot.vx * back; shot.y -= shot.vy * back; shot.age = Math.max(0, shot.age - back);
  return shot;
}

// A real change of direction between two recorded chords, as at a ricochet.
function turns(a:Point,p:Point,b:Point) {
  const ax = p.x - a.x, ay = p.y - a.y, bx = b.x - p.x, by = b.y - p.y, scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return scale > 1e-12 && (ax * bx + ay * by) / scale < .98;
}

// The whole flight in a bounded number of points: behind the freshest substeps the arc keeps one point
// for every stretch of its time, a stretch that grows with the flight, so a long arc stays evenly drawn.
function compactPrimaryPoints(source:readonly TrailPoint[]):TrailPoint[] {
  // Bound unusual multi-contact packets before the simplification pass. Keeping
  // their newest real suffix is preferable to joining across discarded turns.
  const points = source.slice(-96);
  if (points.length <= MAX_PRIMARY_TRAIL_POINTS) return points;
  // Keep the freshest substeps exact for interpolation in this delivery.
  const fresh = points.splice(-8), kept = [points[0]!], stretch = (points.at(-1)!.time - points[0]!.time) / (MAX_PRIMARY_TRAIL_POINTS - 10);
  // Preserve visible direction changes, including the real ricochet point.
  for (let i = 1; i < points.length; i++) if (points[i]!.corner || points[i]!.time - kept.at(-1)!.time >= stretch) kept.push(points[i]!);
  kept.push(...fresh);
  while (kept.length > MAX_PRIMARY_TRAIL_POINTS) kept.shift();
  return kept;
}

function primaryPoint(a:TrailPoint,b:TrailPoint,time:number):TrailPoint {
  const t = b.time > a.time ? clamp((time - a.time) / (b.time - a.time), 0, 1) : 1;
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), time };
}

// Playback never changes the solver timestep. Terminal rounds retain their
// swept path until the visual clock reaches contact, even if they disappear
// entirely between two physics snapshots.
export class FramePresentation<State extends PresentationState=FieldView> {
  declare state:State|null;declare previous:State|null;declare display:PresentationSample<State>|null;declare flight:Readonly<SlowStrike>|null;declare pieces:[number,number][]|null;declare pace:number|null;
  declare history:HistoryEntry<State>[];declare clock:RemoteClock|null;declare pending:SceneEventBase[];declare paths:PrimaryPath[];declare effectTime:number|null;declare paused:boolean;declare along:AlongPaths;declare late:Uint8Array;
  declare shotTrailHistory:Map<number|string,TrailPacket>;declare shotTrailCache:{time:number;reach:number;trails:ShotTrail[]}|null;declare fallenArcs:Map<string,TrailPacket>;declare specks:ProjectileSpecks;
  declare start:number|null;declare received:number;declare duration:number;declare changeTime:number;
  constructor() { this.clear(); }
  clear() {
    this.state = this.previous = this.display = this.flight = this.pieces = this.pace = null;
    this.history = []; this.clock = null;
    this.pending = []; this.paths = []; this.effectTime = null; this.paused = true;
    this.along = { ends: new Map(), places: new Map(), sieve: new Uint8Array(SIEVE + 1) };
    // The numbers of the rounds a delivery brings paths of, looked for in the state before it (`joined`).
    this.late = new Uint8Array(SIEVE + 1);
    this.shotTrailHistory = new Map(); this.shotTrailCache = null; this.fallenArcs = new Map();
    // The rounds in view that are told as a place and a kind: kept from one frame to the next, and as long as the densest of them.
    this.specks = { count: 0, x: new Float64Array(256), y: new Float64Array(256), kind: new Uint32Array(256), kinds: [] };
  }
  // A hidden shared field still receives its authoritative state and the separate squad/faction notices.
  // Its next picture starts there, without recreating unseen shots or joining a rocket trail across the gap.
  // Existing particles age in one update; no missed simulation steps are run on this thread.
  rest(now=0,update:(dt:number)=>void=()=>{}) {
    const time = this.state?.time ?? null;
    if (time !== null) update(Math.max(0, time - (this.effectTime ?? time)));
    this.previous = this.display = this.flight = this.pieces = null;
    this.history.length = 0; this.clock = null;
    this.pending.length = 0; this.paths.length = 0;
    this.along.ends.clear(); this.along.places.clear(); this.along.sieve.fill(0);
    this.shotTrailHistory.clear(); this.shotTrailCache = null; this.fallenArcs.clear();
    this.start = this.effectTime = time; this.received = now; this.duration = 8; this.changeTime = -Infinity;
    this.specks.count = 0;
  }
  // A state of a local world is shown over as long as it took to come: the time it brings, over the `pace` the world
  // went at against the player's time (slowed in a test of armour, slow-motion.ts) — the flight of a round struck at the
  // design, from `flight.from` until it strikes at `flight.until`, at the pace of its flight (`flight.pace`), and what
  // came before the round was struck at the pace of the state before. One that brings no time — news of an aim, of an
  // order — takes the place of the last without cutting short the showing of the step that led to it.
  receive(state:State,events:readonly SceneEventBase[]=[],{now=0,paused=false,pace=1,flight=null,visible=true,maxPace=1}:ReceiveOptions={}) {
    if (this.state && state.time < this.state!.time - 1e-8) this.clear();
    if (state.shared && !visible) { this.state = state; this.paused = paused; this.pace = pace; return; }
    const told = this.state, same = Boolean(this.state) && !state.shared && !paused && !this.paused && Math.abs(state.time - this.state!.time) < 1e-10;
    if (!same) {
      this.previous = this.state; this.received = now;
      this.start = this.previous?.time ?? state.time;
      const step = state.time - this.start!, before = this.pace ?? 1;
      this.flight = flight?.until! > this.start! + 1e-12 ? flight : null; this.pace = pace;
      // The world time of the step in its three paces: before the round was struck, its flight, and the rest.
      const early = this.flight ? clamp(this.flight.from - this.start!, 0, step) : 0,
        flown = this.flight ? clamp(Math.min(this.flight.until, state.time) - this.start! - early, 0, step - early) : 0;
      this.pieces = [[early, before], [flown, this.flight?.pace ?? 1], [step - early - flown, pace]];
      this.duration = Math.max(8, this.pieces.reduce((sum, [world, at]) => sum + world / at, 0) * 1000);
    }
    // The core tells much of what a round does where it strikes at the start of the step it strikes in: seen as slowly as
    // the flight of a round struck at the design, none of it is shown before the round strikes.
    const struck = this.flight?.until;
    if (struck !== undefined) events = events.map(e => e.type !== 'flight' && (e.time ?? state.time) < struck ? { ...e, time: struck } : e);
    this.state = state; this.paused = paused;
    const damage = events.filter(e => damageEvents.has(e.type)), change = damage.length ? Math.min(...damage.map(e => e.time ?? state.time)) : -Infinity;
    this.changeTime = same && this.changeTime !== -Infinity ? Math.min(this.changeTime, change === -Infinity ? Infinity : change) : change;
    const skipped = this.buffer(state, now, paused, maxPace);
    // A path is kept while a frame may show it: one that ended after the frame shown last shows its round in the next.
    const from = Math.min(this.start!, this.clock?.time ?? this.start!), shown = Math.min(from, this.effectTime ?? from);
    this.paths = this.paths.filter(p => p.points.at(-1)!.time >= shown - 1e-8);
    this.paths.push(...this.joined(events.filter(isPrimaryFlight), told, from));
    this.pending.push(...events.filter(e => e.type !== 'flight'));
    this.pending.sort((a, b) => (a.time ?? state.time) - (b.time ?? state.time));
    if (skipped) this.discardBefore(this.clock!.time);
    else this.receivePaths();
    this.receiveShotTrails(events);
    if (this.effectTime == null) this.effectTime = this.start!;
  }
  // Only the shared field needs a delivery reserve. Its immutable states stay as references;
  // local tests and paused stepping retain their immediate, two-state presentation.
  buffer(state:State,now:number,paused:boolean,maxPace=1) {
    if (!state.shared || paused) { this.history = []; this.clock = null; return; }
    maxPace = Number.isFinite(maxPace) ? Math.max(1, maxPace) : 1;
    const ceiling = 1.1 * maxPace, intervalMax = Math.max(this.clock?.maxPace ?? 1, maxPace),
      intervalPace = this.clock?.maxPace! > maxPace ? this.clock!.pace : null;
    if (!this.clock || !this.previous?.shared) {
      this.history = [];
      this.clock = { time: state.time, at: now + REMOTE_DELAY * 1000, measuredAt: now,
        measuredTime: state.time, pace: clamp(state.pace ?? 1, .25, ceiling), maxPace, pendingPace: maxPace > 1 ? 2 : 0 };
    } else {
      const clock = this.clock!;
      if (clock.maxPace !== maxPace) {
        clock.maxPace = maxPace; clock.pace = clamp(state.pace ?? clock.pace, .25, ceiling);
        clock.measuredAt = now; clock.measuredTime = state.time; clock.pendingPace = maxPace > 1 ? 2 : 0;
      }
      const step = state.time - clock.measuredTime, gap = (now - clock.measuredAt) / 1000;
      clock.pace = clamp(clock.pace, .25, ceiling);
      // Measure across deliveries: callbacks arriving together must not halve the estimated pace.
      if (gap >= .1) {
        if (step > 0 && gap <= REMOTE_GAP) {
          clock.pace += (clamp(step / gap, .25, ceiling) - clock.pace) * (clock.pendingPace ? 1 : .2);
          // The first window can end inside a callback batch; the next spans its whole measured interval.
          clock.pendingPace = Math.max(0, clock.pendingPace - 1);
        }
        clock.measuredAt = now; clock.measuredTime = state.time;
      }
    }
    const replaced = this.history.at(-1)?.state.time === state.time ? this.history.pop() : null;
    let changeTime = this.changeTime;
    if (replaced && replaced.changeTime !== -Infinity)
      changeTime = changeTime === -Infinity ? replaced.changeTime : Math.min(changeTime, replaced.changeTime);
    for (let i = this.history.length - 1; i >= 0 && this.history[i]!.maxPace === maxPace; i--) this.history[i]!.pace = this.clock!.pace;
    this.history.push({ state, changeTime, maxPace: replaced?.maxPace ?? intervalMax, pace: replaced?.pace ?? intervalPace ?? this.clock!.pace });
    if (this.history.length > REMOTE_HISTORY) {
      this.clock!.time = Math.max(this.clock!.time, state.time - REMOTE_DELAY * this.clock!.pace);
      this.pruneHistory();
      return true;
    }
  }
  // The reserve can skip a long suspension or a burst of queued network callbacks. Effects from the
  // discarded poses are obsolete too; retaining them would rebuild and play the entire unseen battle.
  discardBefore(time:number) {
    this.pending = this.pending.filter(event => (event.time ?? this.state!.time) >= time - 1e-10);
    this.paths = this.paths.filter(path => path.points.at(-1)!.time >= time - 1e-10);
    this.receivePaths(); this.display = null;
  }
  pruneHistory() {
    while (this.history.length > 2 && this.history[1]!.state.time <= this.clock!.time) this.history.shift();
  }
  remoteTime(now:number) {
    const clock = this.clock!, elapsed = Math.max(0, (now - clock.at) / 1000);
    // A test pace belongs to the interval leading to its state. Finish the old reserve at its measured pace;
    // applying a slower limit on receipt would overflow that reserve before it could be shown.
    const indexed = this.history.some(entry => entry.maxPace > 1),
      next = indexed ? this.history.findIndex(entry => entry.state.time > clock.time + 1e-10) : -1,
      index = next < 0 ? this.history.length - 1 : next,
      phase = indexed ? this.history[index]! : null,
      change = phase ? this.history.findIndex((entry, i) => i > index && entry.maxPace !== phase.maxPace) : -1,
      until = change > 0 ? this.history[change - 1]!.state.time : this.state!.time,
      pace = phase?.pace ?? clock.pace, scale = phase?.maxPace ?? clock.maxPace;
    // Returning to a tab skips an obsolete reserve, always forwards. Ordinary jitter only
    // adjusts the clock's pace gently; a missing state is waited for, never extrapolated.
    if (elapsed > REMOTE_GAP) {
      clock.time = Math.max(clock.time, this.state!.time - REMOTE_DELAY * clock.pace);
      this.discardBefore(clock.time);
    }
    else if (elapsed > 0) {
      const target = this.state!.time + (now - this.received) / 1000 * pace - REMOTE_DELAY * pace,
        drift = target - (clock.time + elapsed * pace);
      clock.time = Math.min(until, clock.time + elapsed * pace * clamp(1 + drift * 2 / scale, .85, 1.15));
    }
    if (elapsed > 0) clock.at = now;
    this.pruneHistory();
    return clock.time;
  }
  // The paths of a delivery as a frame shows them: one for each round, from where the state before it (`told`) had
  // the round. A path is that of a step, and a delivery holds several steps: a round that met something on one of
  // them is hidden in the block until its path ends (`hidden`), and one that ended is in no block. Its path alone
  // would show it on that step only: missing over the steps before it, the round would be gone short of where it
  // struck, and what it struck would show ahead of it. Between two steps of its own in a delivery it only flew on,
  // and so it did from the state before, as that state has it: before that state's time — the frame shown now
  // (`from`) may be behind it — it is that much of its velocity behind, back to the end of the path that told it
  // before, or to its birth. The events are left as they came.
  joined(flights:readonly PrimaryFlight[],told:State|null,from:number):readonly PrimaryPath[] {
    if (!flights.length) return flights;
    const joined:PrimaryPath[] = [], index = new Map<number|string,number>();
    for (const flight of flights) {
      const key = flight.n ?? flight.id, at = index.get(key);
      if (at === undefined) { index.set(key, joined.length); joined.push(flight); }
      else joined[at]! = { ...flight, points: joined[at]!.points.concat(flight.points) };
    }
    const block = told?.shots, data = block?.data, late = this.late, wanted = new Map<number,number>();
    if (!shotCount(block)) return joined;
    // A path starts with a step: at the time of the state before, or after it. A time that went by the network is
    // to the microsecond.
    for (let at = 0; at < joined.length; at++) {
      const number = joined[at]!.n!;
      if (Number.isInteger(number) && joined[at]!.points[0]!.time > told!.time - 1e-6) { wanted.set(number, at); late[number & SIEVE] = 1; }
    }
    if (wanted.size) for (let at = 0; at < data!.length; at += SHOT_WORDS) {
      const number = data![at]!;
      if (late[number & SIEVE] !== 1 || !wanted.has(number)) continue;
      const x = data![at + SHOT_X]!, y = data![at + SHOT_Y]!, vx = data![at + SHOT_VX]!, vy = data![at + SHOT_VY]!, time = told!.time;
      if (!Number.isFinite(x + y + vx + vy)) continue;
      const path = joined[wanted.get(number)!]!, since = Math.max(from, time - data![at + SHOT_AGE]!, this.along.ends.get(number) ?? -Infinity), lead:TrailPoint[] = [];
      if (since < time - 1e-6) lead.push({ time: since, x: x - vx * (time - since), y: y - vy * (time - since), vx, vy });
      if (path.points[0]!.time > time + 1e-6) lead.push({ time, x, y, vx, vy });
      if (lead.length) joined[wanted.get(number)!]! = { ...path, points: lead.concat(path.points) };
    }
    for (const number of wanted.keys()) late[number & SIEVE] = 0;
    return joined;
  }
  // Which rounds fly along a path, by their numbers, and until when (`ends`): asked of every round a frame shows,
  // so worked out once a delivery. A path says little of its round: the few still in the air are found in the
  // block in one pass (`places`), for the kind and the age of each.
  receivePaths() {
    const { ends, places, sieve } = this.along, data = this.state!.shots?.data;
    ends.clear(); places.clear(); sieve.fill(0);
    let flying = 0;
    for (const path of this.paths) {
      const number = path.n!;
      if (!Number.isInteger(number)) continue;
      const end = path.points.at(-1)!.time;
      if (!(ends.get(number)! >= end)) ends.set(number, end);
      sieve[number & SIEVE] = 1; if (!path.terminal) flying++;
    }
    if (flying && data) for (let at = 0; at < data!.length; at += SHOT_WORDS) {
      const number = data![at]!;
      if (sieve[number & SIEVE] === 1 && ends.has(number)) places.set(number, at / SHOT_WORDS);
    }
  }
  // The share of the step from `start` to the state that is shown `now`: each piece of it at its pace (`pieces`).
  shown(now:number) {
    const step = this.state!.time - this.start!;
    if (!this.flight || !(step > 0)) return clamp((now - this.received) / this.duration, 0, 1);
    let seconds = (now - this.received) / 1000, world = 0;
    for (const [length, pace] of this.pieces!) {
      const takes = length / pace;
      if (seconds <= takes) return clamp((world + seconds * pace) / step, 0, 1);
      seconds -= takes; world += length;
    }
    return 1;
  }
  sample(now:number):PresentationSample<State>|null {
    if (!this.state) return null;
    if (this.paused) { this.history = []; this.clock = null; }
    let previous = this.previous, current = this.state, changeTime = this.changeTime,
      alpha = this.paused ? 1 : this.shown(now),
      time = lerp(this.start!, current.time, alpha);
    if (this.clock) {
      time = this.remoteTime(now);
      const after = (this.history[1]! || this.history[0]!)!;
      previous = this.history.length > 1 ? this.history[0]!.state : null;
      current = after.state; changeTime = after.changeTime;
      alpha = previous ? clamp((time - previous.time) / (current.time - previous.time), 0, 1) : 1;
    }
    const state = previous && time < changeTime - 1e-10 ? previous : current,
      blend = state === previous ? 1 : alpha;
    return { alpha: blend, time, state, previous, scene: sampleScene(state, previous, blend) };
  }
  present(sample:PresentationSample<State>|null,options?:PresentOptions<State>):PresentationFrame<State>|null;
  present(sample:PresentationSample<State>|null,{prepare=()=>{},update=()=>{},consume=()=>{}}:PresentOptions<State>={}) {
    if (!sample) return null;
    const previousDisplay = this.display;
    if (previousDisplay?.state !== sample.state) prepare(sample.state);
    // Fire follows the core's events. The rounds that met what this frame shows of the events
    // are in it where they met it: those that ended since the frame before.
    const since = this.effectTime ?? sample.time;
    sample.events = this.advance(sample.time, update, consume);
    Object.assign(sample, this.projectilesAt(sample, since));
    sample.shotTrails = this.shotTrailsAt(sample.time, sample.trailReach);
    sample.fallenArcs = this.fallenArcsAt(sample.time);
    this.display = sample; return { ...sample, previousDisplay };
  }
  // Where a vehicle of the sample is shown, for the camera to go with it: the one in the player's hands, or the one asked for.
  // It is in the air while it flies, and an aircraft also while it goes up or down faster than it ever sets down (`ADRIFT`):
  // out of fuel, its thrusters stopped.
  vehicleAt(sample:PresentationSample<State>|null,id?:string|null) {
    if (!sample) return null;
    if (id === undefined) id = Object.hasOwn(sample.state, 'controlledActor') ? sample.state.controlledActor : 'local';
    const scene = sample.scene || sampleScene(sample.state, sample.previous ?? this.previous, sample.alpha),
      body = scene.frame.actors.get(id!)?.vehicle, pose = body && scene.actor(id);
    return pose ? { id: `${id}:${body.chassisId || ''}`, time: sample.time, x: pose.x, y: pose.y,
      flying: Boolean(body.flying) || body.thrustN! > 0 && Math.abs(body.vy!) > ADRIFT } : null;
  }
  // The effects are stepped once a frame, to the time of the frame, however many events are due: a field firing
  // at once has a dozen on every frame, each at an instant of its own, and stepping thousands of particles up to
  // each would be most of the frame. An event is shown with how long after the last step it came, and what
  // it makes lives only the rest of the step that follows.
  advance(time:number,update:(dt:number)=>void,consume:(event:SceneEventBase,offset:number)=>void) {
    if (this.effectTime == null) this.effectTime = time;
    const due = [], from = this.effectTime;
    while (this.pending.length && (this.pending[0]!.time ?? time) <= time + 1e-10) {
      const event = this.pending.shift()!;
      consume(event, Math.max(0, Math.min(time, event.time ?? time) - from)); due.push(event);
    }
    update(Math.max(0, time - from)); this.effectTime = Math.max(from, time);
    return due;
  }
  // The rounds a path of the delivery tells the place of at this time: those within `view`, when one is stated. A round
  // whose path ended since the frame before (`since`) is in this one where it ended, as what it met there is: it is
  // seen to get there, however far it went from one frame to the next.
  shotsAt(time:number,view:ShotViewport|null=null,since=time):ShownPath[] {
    const result = new Map<string,ShownPath>();
    for (const path of this.paths) {
      const first = path.points[0]!, last = path.points.at(-1)!, arrived = path.terminal && last.time > since + 1e-10 && last.time <= time + 1e-10;
      if (!arrived && (time < first.time - 1e-10 || time > last.time + 1e-10 || path.terminal && time >= last.time - 1e-10)) continue;
      const at = Math.min(time, last.time);
      let point:Point & {vx?:number;vy?:number;length?:number;time?:number} = last;
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1]!, b = path.points[i]!;
        if (at <= b.time && b.time > a.time) {
          const alpha = arrived ? 1 : clamp((at - a.time) / (b.time - a.time), 0, 1);
          point = { x: arrived ? last.x : lerp(a.x, b.x, alpha), y: arrived ? last.y : lerp(a.y, b.y, alpha),
            vx: (b.x - a.x) / (b.time - a.time), vy: (b.y - a.y) / (b.time - a.time),
            length: Math.hypot(b.x - a.x, b.y - a.y) * alpha }; break;
        }
      }
      // The path heard of last is the one that tells of its round, in view or not.
      if (view && !(point.x >= view.left && point.x <= view.right && point.y >= view.bottom && point.y <= view.top)) result.delete(path.id);
      else result.set(path.id, { ...path, ...point, number: path.n });
    }
    return [...result.values()];
  }
  receiveShotTrails(events:readonly SceneEventBase[]) {
    // This small visual history is independent of moving shots.
    // Source flight events and simulation snapshots remain untouched.
    const start = Math.min(this.start!, this.clock?.time ?? this.start!),
      cutoff = start - PRIMARY_TRAIL_LIFE, history = this.shotTrailHistory, touched = new Set<TrailPacket>();
    this.shotTrailCache = null;
    for (const [key, path] of history) if (path.points.at(-1)!.time < cutoff - 1e-10) history.delete(key);
    for (const [gun, arc] of this.fallenArcs)
      if (arc.points.at(-1)!.time < start - FALLEN_ARC_LIFE) this.fallenArcs.delete(gun);
    // A tail is kept under the number of its round. The round heard of last is the last to lose its tail when
    // there are too many. `told` is what says of which kind the round is: its path, or its kind in the legend.
    const open = (key:number|string,told:TrailMetadata & {name?:string|null|undefined},id?:string) => {
      const packet:TrailPacket = history.get(key) || { id: id ?? shotId(told,key), key, points: [], terminal: false };
      if (!touched.has(packet)) { history.delete(key); history.set(key, packet); touched.add(packet); }
      packet.ammo = told.ammo ?? packet.ammo;packet.weapon = told.weapon ?? packet.weapon;packet.preset = told.preset ?? packet.preset;
      packet.poweredTrail = told.poweredTrail ?? packet.poweredTrail;packet.actorId = told.actorId ?? packet.actorId;packet.radius = told.radius ?? packet.radius;
      return packet;
    };
    const extend = (points:TrailPoint[],point:TrailPoint) => {
      const last = points.at(-1)!;
      if (last && (point.time < last.time - 1e-10 ||
        Math.abs(point.time - last.time) < 1e-10 && Math.hypot(point.x - last.x, point.y - last.y) < 1e-10)) return;
      // The recorded point is not edited: a corner is marked on a copy of it.
      const before = points.at(-2)!;
      if (before && !last.corner && turns(before, last, point)) points[points.length - 1]! = { ...last, corner: true };
      points.push(point);
    };
    // No more tails are kept than can be drawn: the newest rounds have them. They are at the end of the block
    // and are counted back from there, so a long volley is not gone through for the tails of its last rounds.
    const shots = this.state!.shots, count = shotCount(shots), data = shots?.data, kinds = shots?.kinds,
      whole = (at:number) => Number.isFinite(data![at + SHOT_X]! + data![at + SHOT_Y]!);
    let first = count;
    for (let index = count - 1, kept = 0; index >= 0 && kept < MAX_PRIMARY_TRAILS; index--)
      if (whole(index * SHOT_WORDS)) { kept++; first = index; }
    // A path is sent for what a snapshot cannot tell: the muzzle a round left, a ricochet, where it ended.
    // A path with no number is that of no round of a block, and is told from the others by its name.
    for (const path of events) {
      if (path.type !== 'flight' || path.fragment || !path.id || !Array.isArray(path.points)) continue;
      const key = path.n ?? path.id;
      // A round in the air that is not one of the newest has no tail, whatever it met.
      if (this.along.places.get(key)! < first) { history.delete(key); continue; }
      const source = path.points.filter(p => Number.isFinite(p.x + p.y + p.time));
      if (source.length < 2 || source.at(-1)!.time < cutoff - 1e-10) continue;
      const packet = open(key, path, path.id);
      for (const point of source) extend(packet.points, point);
      packet.terminal = Boolean(path.terminal);
    }
    // A round that only flew on is where the snapshot has it.
    for (let index = first; index < count; index++) {
      const at = index * SHOT_WORDS, number = data![at]!;
      if (!whole(at) || history.get(number)?.terminal) continue;
      const packet = open(number, kinds![data![at + SHOT_KIND]!]!);
      packet.radius = data![at + SHOT_RADIUS]!;
      extend(packet.points, { x: data![at + SHOT_X]!, y: data![at + SHOT_Y]!, time: this.state!.time });
    }
    // A tail nothing was heard of is that of a round no longer among the newest: it starts over, with no chord
    // across the gap, when the round is one of them again.
    for (const [key, packet] of history) if (!packet.terminal && !touched.has(packet)) history.delete(key);
    while (history.size > MAX_PRIMARY_TRAILS) history.delete(history.keys().next().value!);
    for (const packet of touched) {
      if (history.get(packet.key) !== packet) continue;
      if (packet.points.length > MAX_PRIMARY_TRAIL_POINTS) packet.points = compactPrimaryPoints(packet.points);
      // Of the shared field a round of another faction is told as nobody's (server/fog.ts): its arc is no gun's to aim by.
      if (packet.terminal && (packet.actorId || !this.state?.shared) && packet.points.length > 1 && packet.points.at(-1)!.time - packet.points[0]!.time >= FALLEN_ARC_FLIGHT) {
        const gun = packet.actorId + ':' + (packet.preset || packet.weapon), start = packet.points[0]!.time, flight = packet.points.at(-1)!.time - start;
        packet.arc = packet.points.map(p => ({ x: p.x, y: p.y,
          fade: clamp(((p.time - start) / flight - FALLEN_ARC_HIDDEN) / (FALLEN_ARC_FULL - FALLEN_ARC_HIDDEN), 0, 1) }));
        this.fallenArcs.delete(gun); this.fallenArcs.set(gun, packet);
      }
    }
    while (this.fallenArcs.size > MAX_FALLEN_ARCS) this.fallenArcs.delete(this.fallenArcs.keys().next().value!);
  }
  // The tail behind each round, back from its head for `reach` metres of flight:
  // the caller states the reach that fills a stretch of its screen, so a tail
  // is a short streak seen from near and the arc itself seen from afar.
  shotTrailsAt(time:number,reach=Infinity):ShotTrail[] {
    if (this.shotTrailCache?.time === time && this.shotTrailCache.reach === reach) return this.shotTrailCache.trails;
    const trails:ShotTrail[] = [], oldest = time - PRIMARY_TRAIL_SECONDS;
    for (const path of this.shotTrailHistory.values()) {
      const first = path.points[0]!, last = path.points.at(-1)!;
      if (!first || time <= first.time + 1e-10 || last.time <= time - PRIMARY_TRAIL_LIFE + 1e-10) continue;
      const points:FadedPoint[] = [], endTime = Math.min(time, last.time), age = Math.max(0, time - endTime);
      // A round that was turned on its way to where it stopped — off a plate, off a barrel, about
      // the inside of a hull — went that way in a step or two. Its tail goes back through every one
      // of those turns to the first, in good strength, and only from there fades over `reach`: cut
      // at `reach` from where the round stopped it would be a streak away from the hit, with
      // nothing to say how the round came there.
      let bent = 0;
      if (path.terminal) for (let i = path.points.length - 1, run = 0; i > 0 && last.time - path.points[i - 1]!.time <= LAST_TURNS; i--) {
        const a = path.points[i - 1]!, b = path.points[i]!;
        if (a.time > endTime) continue;
        const head = b.time > endTime ? primaryPoint(a, b, endTime) : b;
        run += Math.hypot(head.x - a.x, head.y - a.y);
        if (a.corner) bent = run;
      }
      const limit = reach + bent;
      let flown = 0;
      const append = (point:TrailPoint) => {
        const prior = points.at(-1)!, length = prior ? Math.hypot(prior.x - point.x, prior.y - point.y) : 0;
        if (prior && length < 1e-10) return;
        flown += length;
        const along = !bent ? 1 - flown / reach : flown <= bent ? 1 - (1 - TURNED_STRENGTH) * flown / bent : TURNED_STRENGTH * (1 - (flown - bent) / reach);
        points.push({ x: point.x, y: point.y, time: point.time,
          fade: clamp(Math.min(along, 1 - (endTime - point.time) / PRIMARY_TRAIL_SECONDS), 0, 1) });
      };
      for (let i = path.points.length - 1; i > 0 && flown < limit; i--) {
        const a = path.points[i - 1]!, b = path.points[i]!;
        if (a.time > endTime) continue;
        if (b.time < oldest) break;
        const head = b.time > endTime ? primaryPoint(a, b, endTime) : b, tail = a.time < oldest ? primaryPoint(a, b, oldest) : a,
          length = Math.hypot(head.x - tail.x, head.y - tail.y);
        append(head);
        // The tail ends within this chord: nothing behind it is looked at.
        if (flown + length > limit) {
          const t = (limit - flown) / length;
          append({ x: lerp(head.x, tail.x, t), y: lerp(head.y, tail.y, t), time: lerp(head.time, tail.time, t) });
          break;
        }
        append(tail);
      }
      points.reverse();
      if (points.length < 2) continue;
      const end = points.at(-1)!, before = points.at(-2)!, dt = end.time - before.time;
      trails.push({ id: path.id, ammo: path.ammo, weapon: path.weapon, preset: path.preset,
        poweredTrail: path.poweredTrail, radius: path.radius, actorId: path.actorId,
        x: end.x, y: end.y, vx: dt > 0 ? (end.x - before.x) / dt : 0, vy: dt > 0 ? (end.y - before.y) / dt : 0,
        points, terminal: path.terminal && time >= last.time - 1e-10, age,
        fade: (1 - age / PRIMARY_TRAIL_LIFE) ** 2 });
    }
    this.shotTrailCache = { time, reach, trails }; return trails;
  }
  // Where the last long shot of each gun went: its arc, fading out towards the muzzle, and the point it ended at.
  fallenArcsAt(time:number):FallenArc[] {
    const arcs:FallenArc[] = [];
    for (const path of this.fallenArcs.values()) {
      const end = path.points.at(-1)!, age = time - end.time;
      if (age < 0 || age >= FALLEN_ARC_LIFE) continue;
      arcs.push({ id: path.id, actorId: path.actorId, ammo: path.ammo, weapon: path.weapon, preset: path.preset,
        poweredTrail: path.poweredTrail, points: path.arc!, x: end.x, y: end.y, flight: end.time - path.points[0]!.time,
        age, fade: 1 - age / FALLEN_ARC_LIFE });
    }
    return arcs;
  }
  // The rounds a display frame shows, read from the words of the latest snapshot: the display may still hold
  // the state before a contact, and the rounds keep flying on the visual clock. A round with no path this
  // delivery only flew on: at a time before its snapshot it was that much of its velocity behind, and before it
  // was born it is not there. Nothing is made of a round outside `sample.view`, the stretch of field the caller
  // shows. Of those inside, `shots` are the ones told whole, as objects: what flies along a path and the newest
  // `view.whole` of the others. The rest are `specks`, a place and a kind of the legend each, in
  // buffers that hold until the next frame is asked for. With no view every round is told whole. The rounds that ended
  // after `since`, the time of the frame before, are there where they ended (`shotsAt`).
  projectilesAt(sample:Pick<PresentationSample<State>,'time'|'view'>|null,since=sample?.time):{shots:PresentedShot[];specks:ProjectileSpecks} {
    const shots:PresentedShot[] = [], specks = this.specks;
    specks.count = 0;
    if (!sample) return { shots, specks };
    const latest = this.state, block = latest!.shots, count = shotCount(block), time = sample.time, view = sample.view || null,
      gap = Math.max(0, latest!.time - time);
    specks.kinds = block?.kinds || [];
    if (count) {
      const data = block!.data, paths = this.along,
        left = view?.left ?? -Infinity, right = view?.right ?? Infinity, bottom = view?.bottom ?? -Infinity, top = view?.top ?? Infinity;
      let room = view?.whole ?? Infinity, points = 0, xs = specks.x, ys = specks.y, ks = specks.kind;
      // From the end of the block: the newest rounds are there, and they are the ones told whole.
      for (let index = count - 1, at = index * SHOT_WORDS; index >= 0; index--, at -= SHOT_WORDS) {
        const x = data![at + SHOT_X]! - data![at + SHOT_VX]! * gap, y = data![at + SHOT_Y]! - data![at + SHOT_VY]! * gap;
        if (!(x >= left && x <= right && y >= bottom && y <= top)) continue;
        const age = data![at + SHOT_AGE]!, kind = data![at + SHOT_KIND]!;
        if (hidden(paths, data![at]!, age, gap, time)) continue;
        if (room-- > 0) { shots.push(flownBack(block!, index, Math.min(gap, age))); continue; }
        if (points === xs.length) {
          const gx = new Float64Array(points*2);gx.set(specks.x);specks.x=gx;
          const gy = new Float64Array(points*2);gy.set(specks.y);specks.y=gy;
          const gk = new Uint32Array(points*2);gk.set(specks.kind);specks.kind=gk;
          xs = specks.x; ys = specks.y; ks = specks.kind;
        }
        xs[points] = x; ys[points] = y; ks[points++] = kind;
      }
      specks.count = points; shots.reverse();
    }
    for (const path of this.shotsAt(time, view, since)) shots.push(this.told(path,gap));
    return { shots, specks };
  }
  // A round a path tells the place of, with what the path does not say while the round is in the air: its kind
  // in full, and for how long it has flown.
  told(path:ShownPath,gap:number):PresentedShot {
    const place = this.along.places.get(path.number!), block = this.state!.shots;
    if (place === undefined) return path;
    const shot = shotAt(block!, place);
    return { ...shot, ...path, age: Math.max(0, shot.age - gap) };
  }
  // The round a camera follows: the one of that number for as long as it is shown, otherwise the newest whole
  // round of an actor `mine` accepts. A pass of its own, from the end of the block: no list is made of the rounds in the air.
  shotToFollow(sample:Pick<PresentationSample<State>,'time'>|null,number:number|null=null,mine:(actorId:string|null|undefined)=>boolean=()=>true):PresentedShot|null {
    if (!sample) return null;
    const latest = this.state, block = latest!.shots, count = shotCount(block), time = sample.time, gap = Math.max(0, latest!.time - time),
      paths = this.shotsAt(time), data = block?.data,
      shown = (at:number) => !hidden(this.along, data![at]!, data![at + SHOT_AGE]!, gap, time) && Number.isFinite(data![at + SHOT_X]! + data![at + SHOT_Y]!),
      flown = (at:number) => flownBack(block!, at / SHOT_WORDS, Math.min(gap, data![at + SHOT_AGE]!));
    if (number != null) {
      const path = paths.find(shot => shot.number === number);
      if (path) return this.told(path,gap);
      for (let at = (count - 1) * SHOT_WORDS; at >= 0; at -= SHOT_WORDS) if (data![at]! === number) { if (shown(at)) return flown(at); break; }
    }
    const path = paths.findLast(shot => mine(shot.actorId));
    if (path) return this.told(path,gap);
    const wanted = count ? block!.kinds.map(kind => Boolean(mine(kind.actorId))) : [];
    for (let at = (count - 1) * SHOT_WORDS; at >= 0; at -= SHOT_WORDS) if (wanted[data![at + SHOT_KIND]!] && shown(at)) return flown(at);
    return null;
  }
  // The rounds whose motor still burns, in view or not, each with where it was `step` seconds before: the smoke
  // it lays is there when the camera comes by. The block is not read while no kind in its legend has a motor.
  burningAt(sample:Pick<PresentationSample<State>,'time'>,step:number) {
    const burning:{x:number;y:number;from:Point}[] = [], latest = this.state, block = latest!.shots, count = shotCount(block), time = sample.time, gap = Math.max(0, latest!.time - time),
      lay = (x:number,y:number,vx:number|undefined,vy:number|undefined,age:number) => { const back = Math.min(step, age); burning.push({ x, y, from: { x: x - (vx || 0) * back, y: y - (vy || 0) * back } }); };
    if (!count || !block!.kinds.some(kind => kind.poweredTrail)) return burning;
    const data = block!.data, motor = block!.kinds.map(kind => kind.poweredTrail);
    for (const path of this.shotsAt(time)) {
      const place = this.along.places.get(path.number!), age = place === undefined ? NaN : data![place * SHOT_WORDS + SHOT_AGE]! - gap;
      if (path.poweredTrail && age < BURN) lay(path.x, path.y, path.vx, path.vy, Math.max(0, age));
    }
    for (let at = 0; at < data!.length; at += SHOT_WORDS) {
      const age = data![at + SHOT_AGE]!;
      if (!motor[data![at + SHOT_KIND]!] || age - gap >= BURN || hidden(this.along, data![at]!, age, gap, time)) continue;
      const back = Math.min(gap, age), vx = data![at + SHOT_VX]!, vy = data![at + SHOT_VY]!, x = data![at + SHOT_X]! - vx * back, y = data![at + SHOT_Y]! - vy * back;
      if (Number.isFinite(x + y)) lay(x, y, vx, vy, age - back);
    }
    return burning;
  }
}
