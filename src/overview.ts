import type { Point } from './math.ts';
import type { DrawingShotBlock } from './scene-drawing-contract.ts';
import type { FieldView } from './faction-ui.ts';
import type { Spans } from './ground-sight.ts';
import type { depositMarks } from './faction-ui.ts';
export interface OverviewGround {minX:number;maxX:number;height(x:number):number}
interface OverviewActor {x:number;vehicle?:{x?:number|undefined;y?:number|undefined}|null|undefined}
interface OverviewArc extends Point {actorId?:string|null|undefined;points:readonly Point[];fade:number}
type OverviewDeposit<Mark=ReturnType<typeof depositMarks>[number]> = Mark extends unknown ? Mark & Partial<Record<Exclude<'material'|'supplied',keyof Mark>,never>> : never;
interface OverviewPost {x:number;takedown?:unknown;seen?:boolean}
export interface OverviewScene {
 ground:OverviewGround;camera:{x:number;width:number;zoom:number};state:FieldView;time?:number;
 shots?:DrawingShotBlock|null|undefined;back?:number;arcs?:readonly OverviewArc[];aim?:{path:readonly Point[];reachable:boolean}|null;
 deposits?:readonly OverviewDeposit[];fog?:{explored:Spans;seen:Spans}|null;encounters?:readonly{x:number;alpha:number;approximate?:boolean}[];
}
interface OverviewProjection {width:number;height:number;sx:(x:number)=>number;sy:(y:number)=>number}
interface ShotReach {lo:number;hi:number;top:number}
import { clamp } from './math.ts';
import { SHOT_WORDS, SHOT_X, SHOT_Y, SHOT_VX, SHOT_VY, SHOT_AGE } from './shots.ts';
import { contains } from './ground-sight.ts';
import { contactMarks, ghostFade } from './faction-ui.ts';
import { distance } from './format.ts';

// The narrowest stretch of field the strip shows, and the lowest sky it draws over the relief.
const MIN_SPAN = 1500, MIN_SKY = 300;
// A round is a dot of the strip, and thousands of them stand on the same few pixels. The strip is divided
// into cells this many pixels across, and a cell with rounds in it is drawn once: no closer could two dots be
// told apart. Heights are placed in a cell by a table of this many steps of the scale.
const CELL = 3, STEPS = 512;
const TINTS:Readonly<Record<string,string>> = { own: '#ffd095', ally: '#b4d28b', other: '#eba383', wreck: '#8f9a93', aim: '#e6cf92', short: '#d99373', shot: '#fff4d2', edge: '#1d2924',
  ferro: '#b98a6a', ligas: '#9fb4c4', silica: '#dccf9a', petroleo: '#2e2c31', still: '#6c7770', base: '#e4f2bd', battery: '#ff8f6b',
  ground: '#5d7152', sight: '#73895f', unseen: '#26323c', mist: '#1a242d8c', encounter: '#f08f78', heap: '#cbbd8a' };
// Ground the faction never saw stands this many pixels over the foot of the strip, level.
const UNSEEN_RISE = 8;
// A territory is a band this many pixels tall along the foot of the strip, this opaque, with an edge on top this opaque.
const TERRITORY_BAND = 6, TERRITORY_FILL = .5, TERRITORY_EDGE = 1;
// The territories of the others are drawn first, then those of allies, and the faction's own over them.
const TERRITORY_ORDER:Readonly<Record<string,number>> = Object.freeze({ other: 0, ally: 1, own: 2 });
// A vein is a mark of the strip while the stretch shown leaves each of them this many pixels: a strip
// that shows the whole world would be nothing but marks.
const DEPOSIT_ROOM = 7;
function actorX(actor:OverviewActor):number;
function actorX(actor:OverviewActor|null|undefined):number|undefined;
function actorX(actor:OverviewActor|null|undefined):number|undefined {return actor?.vehicle?.x ?? actor?.x;}

export function overviewSpan(metres:number) {
  return distance(metres);
}
// The stretch that holds everything worth seeing at once: what the camera shows, who stands on the field,
// the arc of the aim, the rounds in the air and the guns the base placed by their fire.
export function overviewRange(ground:OverviewGround,points:readonly(number|null|undefined)[]) {
  const xs = points.filter((point):point is number=>Number.isFinite(point)), low = Math.min(...xs), high = Math.max(...xs),
    pad = Math.max((high - low) * .08, (MIN_SPAN - (high - low)) / 2),
    lo = Math.max(ground.minX, low - pad), hi = Math.min(ground.maxX, high + pad);
  return hi > lo ? { lo, hi } : { lo: ground.minX, hi: ground.maxX };
}

// How high up the strip a height stands, from 0 at the lowest ground to 1 at the top of its sky. Heights
// are not to the scale of distances, and one smooth scale serves them all: near the ground it is close to
// even, so the relief and a flat shot keep their shapes, and it gathers gently with height, so that the
// kilometres of a howitzer's arc fit over hills still worth reading. No line breaks where it crosses a hilltop.
export function overviewScale(relief:number,sky:number) {
  const top = relief + sky, knee = Math.max(relief * 1.5, top / 8), reach = Math.asinh(top / knee);
  return (height:number) => Math.min(1, Math.asinh(height / knee) / reach);
}
// A path of the world as points of the strip. A straight chord of the world is a curve on the scale of
// heights, steepest by the ground: a long one is drawn through points of its own, a few pixels apart, or
// the first chord of a fast round would leave the gun as a straight line with a corner at its end.
export function overviewPath(points:readonly Point[],sx:(x:number)=>number,sy:(y:number)=>number,step=1):[number,number][] {
  let from = points[0]!, x = sx(from.x), y = sy(from.y);
  const path:[number,number][] = [[x, y]], to = (point:Point) => {
    const nx = sx(point.x), ny = sy(point.y), pieces = Math.min(48, Math.ceil(Math.hypot(nx - x, ny - y) / 3));
    for (let k = 1; k < pieces; k++) path.push([x + (nx - x) * k / pieces, sy(from.y + (point.y - from.y) * k / pieces)]);
    path.push([nx, ny]); from = point; x = nx; y = ny;
  };
  for (let i = step; i < points.length - 1; i += step) to(points[i]!);
  to(points.at(-1)!);
  return path;
}
const reaches = new WeakMap<Float64Array,ShotReach>();
// How far the rounds in the air reach, to either side and upwards. Read once from a block, however many frames
// show it: the stretch and the sky of the strip need no more of a long volley than these three numbers.
export function shotReach(shots:DrawingShotBlock|null|undefined):ShotReach {
  const known = shots && reaches.get(shots.data);
  if (known) return known;
  let lo = Infinity, hi = -Infinity, top = -Infinity;
  if (!shots) return { lo, hi, top };
  const data = shots.data;
  for (let at = 0; at < data.length; at += SHOT_WORDS) {
    const x = data[at + SHOT_X]!, y = data[at + SHOT_Y]!;
    if (!Number.isFinite(x + y)) continue;
    if (x < lo) lo = x; if (x > hi) hi = x; if (y > top) top = y;
  }
  const reach = { lo, hi, top }; reaches.set(data, reach); return reach;
}
// The field in one strip: its relief where the faction knows it, the territories it is told of, the veins the faction knows of, the base of the faction and those of others it knows of, its posts and those of others it knows of, who stands where, the
// works and the heaps of the faction, the arc of the aim, the rounds in the air and the guns the watch of the base placed by their fire.
export class Overview {
  declare element:HTMLElement;declare canvas:HTMLCanvasElement;declare label:HTMLOutputElement;declare context:CanvasRenderingContext2D;
  declare lo:number|null;declare hi:number|null;declare ground:OverviewGround|null;declare air:number|null;declare held:boolean;declare cells:Uint8Array;declare rows:Uint32Array;declare dots:number[];
  constructor(element:HTMLElement) {
    this.element = element; this.canvas = element.querySelector<HTMLCanvasElement>('canvas')!; this.label = element.querySelector<HTMLOutputElement>('output')!;
    this.context = this.canvas.getContext('2d')!; this.lo = this.hi = this.ground = this.air = null; this.held = false;
    this.cells = new Uint8Array(0); this.rows = new Uint32Array(STEPS + 1); this.dots = [];
  }
  // The place of the field under a pointer.
  worldX(clientX:number) {
    const box = this.canvas.getBoundingClientRect();
    return this.lo! + clamp((clientX - box.left) / box.width, 0, 1) * (this.hi! - this.lo!);
  }
  draw(scene:OverviewScene|null) {
    this.element.hidden = !scene;
    if (!scene) { this.lo = this.hi = this.ground = this.air = null; return; }
    // `shots` are the rounds in the air as the latest snapshot has them, and `back` how long before it the display is: at `time`.
    // `deposits` are the veins the faction knows of, as marks of the ground: where each lies, its material, the share of its reserve it had when last seen and whether it is dug.
    const { ground, camera, state, time = state.time, shots = null, back = 0, arcs = [], aim = null, deposits = [], fog = null, encounters = [] } = scene, own = state.controlledActor || 'local',
      half = camera.width / camera.zoom / 2,
      // The snapshot already admits only the faction's own, seen and remembered actors.
      // Fixed defences have no vehicle; their place is actor.x.
      actors = (state.actors || []).filter(actor => Number.isFinite(actorX(actor)) && (!actor.vehicle || Number.isFinite(actor.vehicle.y!))),
      ownTeam = actors.find(actor => actor.id === own)?.team,
      // The works and the heaps of the faction are told to it alone: those of another are never on its strip.
      sites = state.shared ? (state.faction?.works || []).filter(work => Number.isFinite(work.x)) : [],
      heaps = state.shared ? (state.faction?.heaps || []).filter(heap => Number.isFinite(heap.x)) : [], flying = shotReach(shots),
      batteries = state.shared ? contactMarks(state, time).filter(mark => mark.kind === 'battery') : [],
      wanted = overviewRange(ground, [camera.x - half, camera.x + half, ...actors.map(actorX), ...sites.map(site => site.x), ...heaps.map(heap => heap.x), flying.lo, flying.hi, ...batteries.map(mark => mark.x),
        state.shared ? state.faction?.activity?.x : null,
        ...arcs.flatMap(arc => [arc.points[0]!.x, arc.x]), ...(aim ? [aim.path[0]!.x, aim.path.at(-1)!.x] : []), ...encounters.map(band => band.x)]);
    // While a pointer holds the strip it stands still under it.
    if (this.ground !== ground || this.lo == null) Object.assign(this, { ground, ...wanted });
    else if (!this.held) { this.lo! += (wanted.lo - this.lo!) * .18; this.hi! += (wanted.hi - this.hi!) * .18; }
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2), width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
    }
    // On a field with fog (`fog`, the ground in sight and the ground known: ground-mist.ts) the relief is that of the
    // ground the faction knows, and the heights of the rest are not read: the scale is of what is drawn.
    const c = this.context, span = this.hi! - this.lo!, sx = (x:number) => (x - this.lo!) / span * width, known = (x:number) => !fog || contains(fog.explored, x),
      columns = Math.ceil(width / 2), places = Array.from({ length: columns + 1 }, (_, i) => this.lo! + span * i / columns),
      heights = places.map(x => known(x) ? ground.height(x) : null), told = heights.filter(h => h !== null),
      marked = [...actors.filter(actor => actor.vehicle).map(actor => actor.vehicle!), ...(aim?.path || []), ...arcs.flatMap(arc => arc.points)],
      floor = Math.min(...(told.length ? told : marked.length ? marked.map(p => p.y!) : [0])), relief = Math.max(Math.max(floor, ...told) - floor, 40), base = height - 4,
      highest = Math.max(MIN_SKY, ...[{ y: flying.top }, ...(aim?.path || []), ...arcs.flatMap(arc => arc.points)].map(p => (p.y - floor - relief) * 1.08));
    this.air = this.air == null ? highest : this.air! + (highest - this.air!) * .18;
    const share = overviewScale(relief, this.air!), sy = (h:number) => base - (height - 10) * share(h - floor),
      line = (points:readonly Point[],step=1) => {
        c.beginPath(); overviewPath(points, sx, sy, step).forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
      },
      ring = (x:number,y:number,radius:number,tint:string,alpha=1) => {
        c.globalAlpha = alpha; c.beginPath(); c.arc(sx(x), sy(y), radius, 0, Math.PI * 2);
        c.lineWidth = 3; c.strokeStyle = TINTS.edge!; c.stroke(); c.lineWidth = 1.4; c.strokeStyle = tint; c.stroke(); c.globalAlpha = 1;
      };
    c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, width, height); c.lineJoin = c.lineCap = 'round';
    // The relief, a run of known ground at a time: its earth, lighter where the faction has it in sight now, and its outline.
    // `runs` are the stretches of the strip, by the heights read along it, that are all of one kind.
    const edge = (i:number) => i / columns * width, level = base - UNSEEN_RISE, rise = (x:number) => known(x) ? sy(ground.height(x)) : level,
      runs = (of:(index:number)=>boolean) => { const found:[number,number][] = []; let from = -1;
        for (let i = 0; i <= columns + 1; i++) { const one = i <= columns && of(i);
          if (one && from < 0) from = i; else if (!one && from >= 0) { found.push([from, i - 1]); from = -1; } }
        return found; },
      earth = ([from,to]:[number,number],tint:string) => { c.beginPath(); c.moveTo(edge(from), height);
        for (let i = from; i <= to; i++) c.lineTo(edge(i), sy(heights[i]!));
        c.lineTo(edge(to), height); c.closePath(); c.fillStyle = tint; c.fill(); },
      shown = runs(i => heights[i]! !== null);
    for (const run of shown) earth(run, TINTS.ground!);
    if (fog) for (const run of runs(i => heights[i]! !== null && contains(fog.seen, places[i]!))) earth(run, TINTS.sight!);
    for (const [from, to] of shown) {
      c.beginPath(); for (let i = from; i <= to; i++) i > from ? c.lineTo(edge(i), sy(heights[i]!)) : c.moveTo(edge(i), sy(heights[i]!));
      c.lineWidth = 1; c.strokeStyle = '#a9bb8d'; c.stroke();
    }
    // Ground never seen is dark and level, with no relief, and the strip is dim over it from foot to top.
    for (const [from, to] of runs(i => heights[i]! === null)) {
      const left = edge(Math.max(0, from - 1)), wide = edge(Math.min(columns, to + 1)) - left;
      c.fillStyle = TINTS.mist!; c.fillRect(left, 0, wide, level); c.fillStyle = TINTS.unseen!; c.fillRect(left, level, wide, height - level);
    }
    // On the shared field, the territories the faction is told of (room.ts `territories`): its own and its allies' whole, and
    // another's only as far as the faction explored, so that the strip gives away no base it never saw.
    if (state.shared) this.drawTerritories(state.faction?.territory ?? [], { width, height, sx });
    // Recent encounters tint a few columns beneath the icons, including an approximate place heard nearby.
    for (const band of encounters) {
      if (!Number.isFinite(band.x) || band.x < this.lo! || band.x > this.hi! || !(band.alpha > 0)) continue;
      const wide = Math.min(width, band.approximate ? 10 : 6), x = clamp(sx(band.x) - wide / 2, 0, width - wide), alpha = clamp(band.alpha, 0, 1);
      c.fillStyle = c.strokeStyle = TINTS.encounter!; c.lineWidth = 1;
      c.globalAlpha = alpha * .25; c.fillRect(x, 0, wide, height);
      c.globalAlpha = alpha * .55; c.strokeRect(x + .5, .5, wide - 1, height - 1); c.globalAlpha = 1;
    }
    // The veins of the stretch: a lozenge on the ground each, in the colour of its material, paler as it is dug out.
    const dug = deposits.filter(deposit => deposit.x >= this.lo! && deposit.x <= this.hi!);
    for (const deposit of dug) {
      if (dug.length * DEPOSIT_ROOM > width && deposit.type !== 'airdrop') continue;
      const x = sx(deposit.x), y = rise(deposit.x) - 1;
      c.beginPath();
      if (deposit.type === 'airdrop') c.rect(x - 3, y - 3, 6, 6);
      else { c.moveTo(x, y - 3.4); c.lineTo(x + 2.8, y); c.lineTo(x, y + 3.4); c.lineTo(x - 2.8, y); c.closePath(); }
      c.globalAlpha = deposit.active ? .45 + .55 * clamp(deposit.share, 0, 1) : .7;
      c.fillStyle = deposit.active ? deposit.supplied ? TINTS.heap! : TINTS[deposit.material!]! : TINTS.still!; c.fill();
      c.globalAlpha = 1; c.lineWidth = 1; c.strokeStyle = TINTS.edge!; c.stroke();
    }
    // What the camera shows.
    const left = clamp(sx(camera.x - half), 0, width), right = clamp(sx(camera.x + half), 0, width), wide = Math.max(3, right - left);
    c.fillStyle = '#ffffff1f'; c.fillRect(Math.min(left, width - wide), 0, wide, height);
    c.lineWidth = 1; c.strokeStyle = '#f1e6c4cc'; c.strokeRect(Math.min(left, width - wide) + .5, .5, wide - 1, height - 1);
    // On the shared field, the bases of others the faction knows of, those of the stretch, and the base of the faction,
    // told from where the player's construction stands, or the camera without one.
    if (state.shared) for (const other of state.faction?.bases ?? []) if (other.x >= this.lo! && other.x <= this.hi!) this.drawForeignBase(other, sx(other.x), rise(other.x));
    if (state.shared && state.faction?.base) this.drawBase(state.faction.base, { width, height, sx, sy, ground,
      from: actorX(actors.find(actor => actor.id === own)) ?? camera.x });
    // And the posts of others the faction knows of, and its own, those of the stretch.
    if (state.shared) for (const [posts, mine] of ([[state.faction?.outposts ?? [], false], [state.faction?.posts ?? [], true]] satisfies [readonly OverviewPost[],boolean][]))
      for (const post of posts) if (post.x >= this.lo! && post.x <= this.hi!) this.drawPost(post, sx(post.x), rise(post.x), mine);
    for (const arc of arcs) if (!arc.actorId || arc.actorId === own) {
      c.globalAlpha = .5 * arc.fade; line(arc.points); c.lineWidth = 1.2; c.strokeStyle = TINTS.shot!; c.stroke();
      ring(arc.x, arc.y, 3.2, TINTS.shot!, arc.fade);
    }
    if (aim) {
      const tint = aim.reachable ? TINTS.aim! : TINTS.short!, end = aim.path.at(-1)!;
      line(aim.path, Math.ceil(aim.path.length / 64)); c.lineWidth = 3; c.strokeStyle = TINTS.edge! + '99'; c.stroke(); c.lineWidth = 1.3; c.strokeStyle = tint; c.stroke();
      ring(end.x, end.y, 3.4, tint);
    }
    // Vehicles are triangles, fixed defences squares, work in progress an open square with crossed braces, and a heap of
    // material a low bar on the ground. Fixed squares stand on a wider foot, visible independently of their tint.
    const marker = (x:number,y:number,size:number,tint:string,shape:'mobile'|'building'|'fixed',alpha=1) => {
      const half = size * .8, top = y - half * 2;
      c.globalAlpha = alpha; c.beginPath();
      if (shape === 'mobile') { c.moveTo(x, y - size - 1); c.lineTo(x + half, y + 1); c.lineTo(x - half, y + 1); c.closePath(); }
      else c.rect(x - half, top, half * 2, half * 2);
      if (shape !== 'building') { c.fillStyle = tint; c.fill(); }
      c.lineWidth = shape === 'building' ? 3 : 1; c.strokeStyle = TINTS.edge!; c.stroke();
      if (shape === 'building') {
        c.lineWidth = 1.4; c.strokeStyle = tint; c.stroke();
        c.beginPath(); c.moveTo(x - half, top); c.lineTo(x + half, y); c.moveTo(x + half, top); c.lineTo(x - half, y); c.stroke();
      }
      if (shape === 'fixed') {
        c.beginPath(); c.moveTo(x - half - 1.5, y + 1.5); c.lineTo(x + half + 1.5, y + 1.5);
        c.lineWidth = 3; c.strokeStyle = TINTS.edge!; c.stroke(); c.lineWidth = 1.4; c.strokeStyle = tint; c.stroke();
      }
      c.globalAlpha = 1;
    };
    for (const actor of actors) {
      // A wreck is nobody's, on the field and on the proving ground, the design under test as well; on the shared field
      // the whole faction is on the player's side.
      const kind = actor.defeated ? 'wreck' : actor.id === own ? 'own' : (state.shared ?
          actor.ownerId === state.localPlayerId || state.faction != null && actor.team === state.faction.id :
          ownTeam != null && actor.team === ownTeam) ? 'ally' : 'other',
        x = actorX(actor), y = actor.vehicle ? sy(actor.vehicle.y!) : rise(x), size = kind === 'own' ? 5.5 : 4.5,
        shape = actor.field?.service?.kind === 'build' ? 'building' : actor.vehicle ? 'mobile' : 'fixed';
      marker(sx(x), y, size, TINTS[kind]!, shape, ghostFade(actor, time));
    }
    for (const site of sites) marker(sx(site.x), rise(site.x), 4.5, TINTS.ally!, 'building');
    for (const heap of heaps) {
      const x = sx(heap.x), y = rise(heap.x);
      c.beginPath(); c.rect(x - 3.5, y - 3, 7, 3); c.fillStyle = TINTS.heap!; c.fill(); c.lineWidth = 1; c.strokeStyle = TINTS.edge!; c.stroke();
    }
    // A gun the watch of the base placed: a reticle on the ground there, on a bar as long as the place may be off, with a
    // ring that closes on it at each word of the gun.
    for (const mark of batteries) {
      const x = sx(mark.x), y = rise(mark.x) - 6, wide = sx(mark.x + mark.radius) - x;
      c.globalAlpha = mark.alpha;
      if (wide >= 6) { c.fillStyle = TINTS.battery!; c.fillRect(x - wide, y + 5, wide * 2, 2); }
      for (const [stroke, tint] of ([[3.4, TINTS.edge!], [1.5, TINTS.battery!]] satisfies [number,string][])) {
        c.beginPath(); c.arc(x, y, 3.6, 0, Math.PI * 2);
        c.moveTo(x - 6.5, y); c.lineTo(x - 1.5, y); c.moveTo(x + 1.5, y); c.lineTo(x + 6.5, y); c.moveTo(x, y - 6.5); c.lineTo(x, y - 1.5); c.moveTo(x, y + 1.5); c.lineTo(x, y + 6.5);
        c.lineWidth = stroke; c.strokeStyle = tint; c.stroke();
      }
      if (mark.pulse < 1) { c.globalAlpha = 1 - mark.pulse; c.beginPath(); c.arc(x, y, 5 + 11 * (1 - mark.pulse), 0, Math.PI * 2); c.lineWidth = 1.4; c.strokeStyle = TINTS.battery!; c.stroke(); }
      c.globalAlpha = 1;
    }
    this.drawShots(shots, back, { width, height, span, floor, ceiling: relief + this.air!, sx, sy });
    const text = overviewSpan(span); if (this.label.textContent !== text) this.label.textContent = text;
  }
  // The territories of the strip, each a band along its foot in the colour of the faction it is of — that of its leader, or the
  // tint of its side where none is told —, with a more opaque edge on top.
  drawTerritories(held:readonly {kind:string;color:string|null;spans:Spans}[],{width,height,sx}:Pick<OverviewProjection,'width'|'height'|'sx'>) {
    const c = this.context;
    for (const { kind, color, spans } of [...held].sort((a, b) => TERRITORY_ORDER[a.kind]! - TERRITORY_ORDER[b.kind]!))
      for (const [from, to] of spans) {
        const left = Math.max(0, sx(from)), right = Math.min(width, sx(to));
        if (right - left < 1) continue;
        c.fillStyle = color || TINTS[kind]!;
        c.globalAlpha = TERRITORY_FILL; c.fillRect(left, height - TERRITORY_BAND, right - left, TERRITORY_BAND);
        c.globalAlpha = TERRITORY_EDGE; c.fillRect(left, height - TERRITORY_BAND, right - left, 1);
      }
    c.globalAlpha = 1;
  }
  // The base: a pennant on its ground, over the stretch of the strip it covers. A base off the strip is the way to it
  // at that end of the strip, and how far it is.
  drawBase(base:{x:number;radius:number},{width,height,sx,sy,ground,from}:OverviewProjection & {ground:OverviewGround;from:number}) {
    const c = this.context, tint = TINTS.base!;
    if (base.x >= this.lo! && base.x <= this.hi!) {
      const x = sx(base.x), y = sy(ground.height(base.x)), left = Math.max(0, sx(base.x - base.radius)), right = Math.min(width, sx(base.x + base.radius));
      if (right - left >= 3) { c.globalAlpha = .55; c.fillStyle = tint; c.fillRect(left, height - 3, right - left, 3); c.globalAlpha = 1; }
      c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 12);
      c.lineWidth = 3; c.strokeStyle = TINTS.edge!; c.stroke(); c.lineWidth = 1.4; c.strokeStyle = tint; c.stroke();
      c.beginPath(); c.moveTo(x, y - 12.5); c.lineTo(x + 7.5, y - 9.5); c.lineTo(x, y - 6.5); c.closePath();
      c.fillStyle = tint; c.fill(); c.lineWidth = 1; c.strokeStyle = TINTS.edge!; c.stroke();
      return;
    }
    const way = base.x > this.hi! ? 1 : -1, x = way > 0 ? width - 4 : 4, y = height - 10, words = 'base ' + overviewSpan(Math.abs(base.x - from));
    c.beginPath(); c.moveTo(x, y); c.lineTo(x - way * 6, y - 4.5); c.lineTo(x - way * 6, y + 4.5); c.closePath();
    c.fillStyle = tint; c.fill(); c.lineWidth = 1; c.strokeStyle = TINTS.edge!; c.stroke();
    c.font = '600 10px ui-sans-serif, system-ui, sans-serif'; c.textBaseline = 'middle'; c.textAlign = way > 0 ? 'right' : 'left';
    c.lineWidth = 3; c.strokeStyle = TINTS.edge!; c.strokeText(words, x - way * 9, y); c.fillStyle = tint; c.fillText(words, x - way * 9, y);
  }
  // A post, at `x` over its ground at `y`, smaller than a base: one of the faction's own (`mine`) a pennant on its mast in
  // the tint of its base, paler while it is being taken down; one of another's a square flag in the colour of an enemy,
  // paler while the faction does not have it in sight.
  drawPost(post:OverviewPost,x:number,y:number,mine:boolean) {
    const c = this.context, tint = mine ? TINTS.base! : TINTS.other!;
    c.globalAlpha = (mine ? !post.takedown : post.seen) ? 1 : .55;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 8);
    c.lineWidth = 3; c.strokeStyle = TINTS.edge!; c.stroke(); c.lineWidth = 1.2; c.strokeStyle = tint; c.stroke();
    c.beginPath();
    if (mine) { c.moveTo(x, y - 8.5); c.lineTo(x + 5, y - 6.5); c.lineTo(x, y - 4.5); c.closePath(); } else c.rect(x, y - 8.5, 4.5, 3.5);
    c.fillStyle = tint; c.fill(); c.lineWidth = 1; c.strokeStyle = TINTS.edge!; c.stroke();
    c.globalAlpha = 1;
  }
  // The base of another faction, at `x` over its ground at `y`: a square flag on its mast, in the colour of an enemy,
  // paler while the faction does not have it in sight.
  drawForeignBase(base:{seen?:boolean},x:number,y:number) {
    const c = this.context, tint = TINTS.other!;
    c.globalAlpha = base.seen ? 1 : .55;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 12);
    c.lineWidth = 3; c.strokeStyle = TINTS.edge!; c.stroke(); c.lineWidth = 1.4; c.strokeStyle = tint; c.stroke();
    c.beginPath(); c.rect(x, y - 12.5, 7, 5.5);
    c.fillStyle = tint; c.fill(); c.lineWidth = 1; c.strokeStyle = TINTS.edge!; c.stroke();
    c.globalAlpha = 1;
  }
  // The rounds in the air, each where the display has it: `back` seconds before its snapshot, and no farther
  // back than it has flown. One pass over the words marks the cells that hold a round, and a dot is drawn for
  // each cell, where the first round found in it stands: a few rounds are drawn as ever, and thousands cost
  // no more dots than the strip has cells.
  drawShots(shots:DrawingShotBlock|null,back:number,{width,height,span,floor,ceiling,sx,sy}:OverviewProjection & {span:number;floor:number;ceiling:number}) {
    if (!shots?.data.length) return;
    const c = this.context, columns = Math.ceil(width / CELL), last = Math.ceil(height / CELL) - 1, rows = this.rows, dots = this.dots;
    if (this.cells.length !== columns * (last + 1)) this.cells = new Uint8Array(columns * (last + 1)); else this.cells.fill(0);
    // The row of a height is read off a table of the scale, which is not worked out for every round.
    for (let step = 0; step <= STEPS; step++) rows[step]! = clamp(Math.floor(sy(floor + ceiling * step / STEPS) / CELL), 0, last) * columns;
    const cells = this.cells, data = shots.data, lo = this.lo!, kx = width / span / CELL, ky = STEPS / ceiling;
    dots.length = 0;
    for (let at = 0; at < data.length; at += SHOT_WORDS) {
      const age = data[at + SHOT_AGE]!, flown = back < age ? back : age, x = data[at + SHOT_X]! - data[at + SHOT_VX]! * flown,
        y = data[at + SHOT_Y]! - data[at + SHOT_VY]! * flown, column = (x - lo) * kx, step = (y - floor) * ky;
      // A round off either end of the strip, or nowhere at all, has no dot.
      if (!(column >= 0 && column < columns && step - step === 0)) continue;
      const cell = rows[step < 0 ? 0 : step > STEPS ? STEPS : step | 0]! + (column | 0);
      if (!cells[cell]) { cells[cell] = 1; dots.push(sx(x), sy(y)); }
    }
    if (!dots.length) return;
    // A dot is a light core in a dark ring. The rings of all of them are filled first and the cores over them:
    // a crowd is one shape with one edge, and two fills however many rounds are in it.
    for (const [radius, tint] of ([[3, TINTS.edge!], [1.8, TINTS.shot!]] satisfies [number,string][])) {
      c.beginPath();
      for (let i = 0; i < dots.length; i += 2) { c.moveTo(dots[i]! + radius, dots[i + 1]!); c.arc(dots[i]!, dots[i + 1]!, radius, 0, Math.PI * 2); }
      c.fillStyle = tint; c.fill();
    }
  }
}
