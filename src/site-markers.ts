import { Container, Graphics, Sprite } from 'pixi.js';
import { HazedGraphics } from './haze.ts';
import { anchorGraphics } from './world-anchor.ts';
import { drawPostArt } from './base-art.ts';
import { POST_EYE, POST_NAME, POST_RADIUS } from './territory.ts';
import { factionName } from './faction-ui.ts';
import { roadKindText } from './road-site.ts';
import { compileStructuredConstruction } from './structured-construction.ts';
import { workShape, drawWork } from './work-art.ts';
import { pileLook, pileSize } from './cargo-art.ts';
import { clamp } from './math.ts';
import { tr } from './i18n.ts';
import type { Text, Texture, ColorSource, TextStyleOptions } from 'pixi.js';
import type { Point } from './math.ts';
import type { Terrain } from './terrain.ts';
import type { Camera } from './camera.ts';
import type { FieldView } from './faction-ui.ts';
import type { FactionView } from './field-contract.ts';
import type { WorkShape } from './work-art.ts';
import type { PileLook } from './cargo-art.ts';
import type { SupplyBill } from './economy-contract.ts';
import type { AuthoredConstruction, CompiledConstruction } from './construction-contract.ts';
import type { BaseMaterials } from './base-materials.ts';
import type { BaseFootprint } from './base-art.ts';
import type { FlagChoice } from './flag.ts';
import type { RoadSpan } from './roads.ts';
import type { PostIntent } from './post-placement.ts';
import type { RoadIntent, RoadPlan } from './road-placement.ts';
import type { VehicleLabelBox } from './vehicle-labels.ts';

type SiteGround = Pick<Terrain, 'height'>;
type Bounds = Pick<WorkShape, 'minX' | 'maxX' | 'minY' | 'maxY'>;
type SiteShape = (Bounds | WorkShape) & { ground: SiteGround };
type SiteFaction = Pick<NonNullable<FieldView['faction']>, 'flag'> & Partial<Pick<NonNullable<FieldView['faction']>, 'posts' | 'outposts' | 'works' | 'heaps' | 'roadworks'>>;
export type SitePostPreview = PostIntent & { refused: boolean };
export type SiteRoadPreview = Omit<RoadIntent, 'kind'> & RoadPlan & { refused: boolean };
export interface SiteBox { kind: 'post' | 'work' | 'heap' | 'road'; id: string; label: { x: number; left: number; right: number; top: number; bottom: number }; area: { left: number; right: number; top: number; bottom: number } }
export interface SiteMarkerOptions {
  text(text: string, fill: ColorSource, size?: number, weight?: TextStyleOptions['fontWeight']): Text;
  flagTexture(flag: FlagChoice): Texture | null;
  pilePicture(look: PileLook): { texture: Texture };
  markHeight(x: number): number;
}
export interface SiteMarkerFrame {
  world: Container; worksLayer: Container | undefined; labels: Container; shadows: Container; ground: SiteGround;
  camera: Pick<Camera, 'zoom' | 'width' | 'height' | 'x' | 'toScreen'>; baseMaterials: BaseMaterials | null | undefined;
}
interface PostDrawing { ground: SiteGround; x: number; radius: number; facing: number | undefined; scale: number; banner: string; color: number | undefined; built: number; flag: Point }
interface WorkDrawing { shape: WorkShape; percent: number; scale: number }
interface RoadDrawing { ground: SiteGround; scale: number; x0: number; x1: number; from: number; to: number }
interface MarkFields { id: string; label: Text }
interface WorkMark extends MarkFields {
  kind: 'work'; art: Graphics; back?: HazedGraphics; source?: AuthoredConstruction; blueprint?: CompiledConstruction;
  shape?: SiteShape | null; drawn?: PostDrawing | WorkDrawing | null;
}
interface HeapMark extends MarkFields { kind: 'heap'; art: Sprite; stock?: SupplyBill; look?: PileLook; size?: ReturnType<typeof pileSize> }
interface RoadMark extends MarkFields { kind: 'road'; art: Graphics; drawn?: RoadDrawing }
type SiteMark = WorkMark | HeapMark | RoadMark;
interface PostMark { works: HazedGraphics; front: Graphics; label: Text; drawn: PostDrawing | null }
type PostEntry = { key: string; post: FactionView['posts'][number]; mine: true; asked?: never } |
  { key: string; post: FactionView['outposts'][number]; mine: false; asked?: never } |
  { key: string; post: SitePostPreview & { radius: number }; asked: true; mine?: never };
interface AskedDrawing { asked: SiteRoadPreview; scale: number; ground: SiteGround; from: number; to: number }
type RoadPreviewGraphics = Graphics & { drawn?: AskedDrawing };
export interface SiteMarkers extends SiteMarkerFrame {
  text: SiteMarkerOptions['text'] | undefined; flagTexture: SiteMarkerOptions['flagTexture'] | undefined;
  pilePicture: SiteMarkerOptions['pilePicture'] | undefined; markHeight: SiteMarkerOptions['markHeight'] | undefined;
  boxes: Map<string, SiteBox>; marks: Map<string, SiteMark>; posts: Map<string, PostMark>;
  postAsked: SitePostPreview | null; roadAsked: SiteRoadPreview | null; siteArt?: Container | null;
  roadPreview?: RoadPreviewGraphics | null; roadBlind?: Graphics | null;
}

function placeBaseLabel(label: Text, flag: Point, zoom: number) { label.position.set(flag.x, flag.y + 3 / zoom); label.scale.set(1 / zoom, -1 / zoom); }
const destroyMark = (made: SiteMark) => { made.art.destroy({ context: true }); if ('back' in made) made.back?.destroy({ context: true }); made.label.destroy(); };
const destroyPost = (made: PostMark) => { made.works.destroy({ context: true }); made.front.destroy({ context: true }); made.label.destroy(); };

// The base of another faction is marked in the colour of an enemy, and named in a lighter one; out of the faction's
// sight it keeps this much of itself. It is shown while it stands within this many metres past a side of the view.
export const FOREIGN_BASE = 0xeba383, FOREIGN_LABEL = 0xf3c6ae, UNSEEN_BASE = .6, BASE_VIEW = 30;

// A works and a heap of the faction are named in these, and shown while they stand within this many metres past a side of the view.
const WORK_LABEL = 0xe2e9cf, HEAP_LABEL = 0xe0d6a8, SITE_VIEW = 30;

// The works of a post is drawn as the post it becomes, as far as it has come (base-art.ts `drawPostArt`), by steps of this
// share of it: drawn again at each step, not at every bit of it. The place being chosen for a post is drawn as one not begun,
// in the colour of the faction, or in this one while the field would refuse it.
const POST_STEP = .02, POST_REFUSED = 0xe0806e;

// A road asked for is marked and named in these over its ground; the stretch being chosen for one in the first, or in the
// second while the field would refuse it.
const ROAD_MARK = 0xd9cf9f, ROAD_LABEL = 0xe6ddb8, ROAD_CHOSEN = 0xedba79, ROAD_REFUSED = 0xffad9b;

const ROAD_STROKE = { width: 2, alpha: .85, cap: 'round' } as const;

// A line of dashes a little over the ground of `spans` — at `height` of a place —, counted from `x0`, as far as they lie
// from `from` to `to`, about the view; and a stake at each of `ends` that lies there. `unit` is a pixel of the view, in metres.
function dashes(g: Graphics, spans: readonly RoadSpan[], x0: number, from: number, to: number, unit: number, height: (x: number) => number, ends: readonly number[] = []) {
  const period = 15 * unit, dash = 9 * unit, at = (x: number) => height(x) + 2 * unit;
  for (const [a, b] of spans) {
    const lo = Math.max(a, from), hi = Math.min(b, to);
    for (let s = x0 + Math.floor((lo - x0) / period) * period; s < hi; s += period) {
      const p = Math.max(s, lo), q = Math.min(s + dash, hi);
      if (q > p) g.moveTo(p, at(p)).lineTo((p + q) / 2, at((p + q) / 2)).lineTo(q, at(q));
    }
  }
  for (const x of ends) if (x >= from && x <= to) g.moveTo(x, height(x)).lineTo(x, height(x) + 12 * unit);
  return g;
}

// A stretch of the field marked for a road (`faction.roadworks`): dashes over its ground and a stake at each end.
function drawStretch(g: Graphics, ground: SiteGround, { x0, x1 }: Pick<RoadIntent, 'x0' | 'x1'>, from: number, to: number, unit: number, color: number) {
  anchorGraphics(g, from, ground.height(clamp(from, x0, x1)));
  return dashes(g, [[x0, x1]], x0, from, to, unit, x => ground.height(x), [...new Set([x0, x1])]).stroke({ ...ROAD_STROKE, color, width: 2 * unit });
}

// The stretch being chosen for a road (`previewRoad`), marked as a road is: bright over what the road makes there (`spans`),
// faint over what it passes over as it is (`over`) — the whole of it in the colour of a refusal where the field would refuse
// it —, on `g`; and on `blind`, over the mist, the ground of it its faction never saw (`unknown`) in that colour, as high as
// the bank of mist lets go of the ground there (`lifted`, Renderer.markHeight): a line on that ground would draw its relief.
// A stake at each end.
function drawAsked(g: Graphics, blind: Graphics, ground: SiteGround, { x0, x1, refused, spans, over, unknown }: SiteRoadPreview, from: number, to: number, unit: number, lifted: (x: number) => number) {
  for (const drawn of [g, blind]) anchorGraphics(drawn, from, ground.height(clamp(from, x0, x1)));
  const height = (x: number) => ground.height(x), color = refused ? ROAD_REFUSED : ROAD_CHOSEN, width = 2 * unit,
    ends = [...new Set([x0, x1])], unseen = (x: number) => unknown.some(([a, b]) => x >= a - 1e-6 && x <= b + 1e-6);
  dashes(g, over, x0, from, to, unit, height).stroke({ ...ROAD_STROKE, color, width, alpha: .35 });
  dashes(g, spans, x0, from, to, unit, height, ends.filter(x => !unseen(x))).stroke({ ...ROAD_STROKE, color, width });
  dashes(blind, unknown, x0, from, to, unit, lifted, ends.filter(unseen)).stroke({ ...ROAD_STROKE, color: ROAD_REFUSED, width });
}

// Owns the drawings, cached geometry and hit boxes of field work. Shared flag
// and pile textures come from explicit providers and retain their renderer owner.
export class SiteMarkers {
  constructor({ text, flagTexture, pilePicture, markHeight }: Partial<SiteMarkerOptions> = {}) {
    Object.assign(this, { text, flagTexture, pilePicture, markHeight });
    this.boxes = new Map<string, SiteBox>(); this.marks = new Map<string, SiteMark>(); this.posts = new Map<string, PostMark>();
    this.postAsked = this.roadAsked = null;
  }
  frame({ world, worksLayer, labels, shadows, ground, camera, baseMaterials }: SiteMarkerFrame) {
    Object.assign(this, { world, worksLayer, labels, shadows, ground, camera, baseMaterials }); return this;
  }
  draw(faction: SiteFaction | null | undefined, obstacles: VehicleLabelBox[]) { this.drawWorks(faction, obstacles); this.drawPosts(faction, obstacles); }
  previewPost(post: SitePostPreview | null) { this.postAsked = post; }
  previewRoad(road: SiteRoadPreview | null) { this.roadAsked = road; }
  workBounds(id: string | null | undefined) { const made = this.marks.get('work:' + id); return made && 'shape' in made ? made.shape ?? null : null; }
  heapSize(id: string | null | undefined) { const made = this.marks.get('heap:' + id); return made && 'size' in made ? made.size ?? null : null; }
  postLabel(text: string, color: number) {
    const label = this.world.addChild(this.text!(text, color, 13, '600')); label.anchor.set(.5, 1); return label;
  }
  clear() {
    for (const made of this.marks.values()) destroyMark(made);
    for (const made of this.posts.values()) destroyPost(made);
    this.roadBlind?.destroy({ context: true }); this.siteArt?.destroy({ children: true, context: true });
    this.roadBlind = this.roadPreview = this.siteArt = this.postAsked = this.roadAsked = null;
    this.marks.clear(); this.posts.clear(); this.boxes.clear();
  }
  // The art of a post (base-art.ts `drawPostArt`) in `works` and `front`, as it was drawn (`drawn`) or drawn again when the
  // post, its flag (`flown`), its colour, the ground, the scale of the view or how far its works have come, by steps of
  // `POST_STEP`, is another; `post` is where it stands, as far as it serves to each side and how it faces.
  drawnPost(drawn: PostDrawing | null | undefined, works: Graphics, front: Graphics, post: BaseFootprint, flown: FlagChoice, color: number | undefined, progress = 1): PostDrawing {
    const ground = this.ground, scale = 2 ** (Math.round(Math.log2(this.camera.zoom) * 3) / 3), texture = this.flagTexture!(flown),
      banner = JSON.stringify(flown) + (texture ? '' : '…'), built = progress >= 1 ? 1 : Math.max(0, Math.floor(progress / POST_STEP + 1e-6) * POST_STEP);
    if (drawn && drawn.ground === ground && drawn.x === post.x && drawn.radius === post.radius && drawn.facing === post.facing &&
      drawn.scale === scale && drawn.banner === banner && drawn.color === color && drawn.built === built) return drawn;
    for (const made of [works, front]) anchorGraphics(made, post.x, 0);
    return { ground, x: post.x, radius: post.radius, facing: post.facing, scale, banner, color, built,
      flag: drawPostArt(works, front, post, ground, 1 / scale, flown, texture, color, this.baseMaterials, built) };
  }

  // The posts the player's faction has on the shared field (`faction.posts`) and those of others it knows of (`outposts`,
  // as the field last told it of them), each a place drawn behind the field as a base is (base-art.ts `drawPostArt`) under
  // a label: its own named as a post — and as being taken down, while it is —, the others in the colour of an enemy and
  // under the flag of their faction, named with it and as sheltered while its faction is away, paler out of sight as they
  // were last seen; and the place being chosen for a post (`previewPost`), as one not begun. Only those about the view are
  // shown, each drawn again only when it or the view is another (`drawnPost`); one no longer told of is let go. Where the
  // label of each post of the faction and its ground are on the screen this frame are kept for the marks of the panels
  // (`siteBoxes`), and every label is among what the labels of the constructions keep clear of (`obstacles`).
  drawPosts(faction: SiteFaction | null | undefined, obstacles: VehicleLabelBox[]) {
    const known = this.posts, camera = this.camera, zoom = camera.zoom, half = camera.width / zoom / 2, shown = new Set(),
      own = (faction?.posts ?? []).map((post): PostEntry => ({ key: 'own:' + post.id, post, mine: true })),
      others = (faction?.outposts ?? []).map((post): PostEntry => ({ key: 'other:' + post.id, post, mine: false })),
      asked: PostEntry[] = this.postAsked ? [{ key: 'asked', post: { ...this.postAsked, radius: POST_RADIUS }, asked: true }] : [],
      told = new Set([...own, ...others, ...asked].map(item => item.key));
    for (const [key, art] of known) if (!told.has(key)) { destroyPost(art); known.delete(key); }
    for (const { key, post, mine, asked: chosen } of [...own, ...others, ...asked]) {
      if (Math.abs(post.x - camera.x) > half + post.radius + BASE_VIEW) continue;
      let art = known.get(key);
      if (!art) {
        const works = this.worksLayer!.addChild(new HazedGraphics()), front = new Graphics();
        this.world.addChildAt(front, this.world.getChildIndex(this.shadows));
        art = { works, front, drawn: null, label: this.postLabel('', mine ? 0xcfe3a8 : FOREIGN_LABEL) };
        known.set(key, art);
      }
      const color = chosen ? post.refused ? POST_REFUSED : undefined : mine ? undefined : FOREIGN_BASE;
      art.drawn = this.drawnPost(art.drawn, art.works, art.front, post, mine ? faction!.flag : 'flag' in post ? post.flag ?? faction!.flag : faction!.flag, color, chosen ? 0 : 1);
      const name = chosen ? '' : mine ? tr(POST_NAME) + (post.takedown ? tr` · desmontando ${Math.floor(post.takedown.progress * 100 + 1e-6)}%` : '') :
        tr(POST_NAME) + ' · ' + factionName(post) + (post.sheltered ? tr(' · protegido') : '');
      if (art.label.text !== name) art.label.text = name;
      art.works.visible = art.front.visible = true; art.label.visible = Boolean(name);
      art.works.alpha = art.front.alpha = art.label.alpha = mine || chosen || post.seen ? 1 : UNSEEN_BASE;
      placeBaseLabel(art.label, art.drawn.flag, zoom);
      shown.add(key);
      if (!name) continue;
      const { minX, minY, maxX, maxY } = art.label.getBounds();
      if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY ||
        maxX < 0 || minX > camera.width || maxY < 0 || minY > camera.height) continue;
      obstacles.push({ x: (minX + maxX) / 2, y: minY, width: maxX - minX, top: 0, bottom: maxY - minY });
      if (!mine) continue;
      const ground = this.ground.height(post.x), a = camera.toScreen(post.x - post.radius, ground + POST_EYE), b = camera.toScreen(post.x + post.radius, ground);
      this.boxes.set('post:' + post.id, { kind: 'post', id: post.id, label: { x: (minX + maxX) / 2, left: minX, right: maxX, top: minY, bottom: maxY },
        area: { left: Math.min(minX, a.x, b.x), right: Math.max(maxX, a.x, b.x), top: Math.min(minY, a.y, b.y), bottom: Math.max(maxY, a.y, b.y) } });
    }
    for (const [key, art] of known) if (!shown.has(key)) art.works.visible = art.front.visible = art.label.visible = false;
  }

  // The works of the player's faction on the shared field (`faction.works`), each the structure it becomes standing pale
  // where it will stand, filled in as far as it is put up (work-art.ts), under a label that names it and says how far it
  // has come; the heaps of its material (`faction.heaps`), each a pile of crates on the ground (cargo-art.ts `pileLook`)
  // under a label; the roads it asked for (`faction.roadworks`), each its stretch marked over the ground (`drawStretch`)
  // with a label in the earth under it; and the stretch being chosen for one (`previewRoad`). Nothing of them off that
  // field, nor of another faction's: they are told to their faction alone. Only
  // those about the view are shown. A works is compiled once, and drawn again only when how far it has come, to the
  // percent, the ground or the scale of the view is another; one no longer told of is let go. Where each label and what
  // it marks with what it labels stand on the screen this frame are kept for the marks of the panels (`siteBoxes`), and the
  // labels are among what the labels of the constructions keep clear of (`obstacles`).
  drawWorks(faction: SiteFaction | null | undefined, obstacles: VehicleLabelBox[]) {
    const boxes = this.boxes, known = this.marks;
    boxes.clear();
    if (!faction) {
      for (const made of known.values()) { made.art.visible = made.label.visible = false; if ('back' in made && made.back) made.back.visible = false; }
      if (this.roadPreview) this.roadPreview.visible = this.roadBlind!.visible = false;
      return;
    }
    const works = faction.works ?? [], heaps = faction.heaps ?? [], roads = faction.roadworks ?? [], asked = this.roadAsked;
    if (!this.siteArt) {
      if (!works.length && !heaps.length && !roads.length && !asked) return;
      this.siteArt = new Container(); this.world.addChildAt(this.siteArt, this.world.getChildIndex(this.shadows));
    }
    const told = new Set([...works.map(work => 'work:' + work.id), ...heaps.map(heap => 'heap:' + heap.id), ...roads.map(road => 'road:' + road.id)]);
    for (const [key, made] of known) if (!told.has(key)) { destroyMark(made); known.delete(key); }
    const ground = this.ground, camera = this.camera, zoom = camera.zoom, half = camera.width / zoom / 2,
      scale = 2 ** (Math.round(Math.log2(zoom) * 3) / 3), siteArt = this.siteArt!, labels = this.labels, words = this.text!;
    function mark(kind: 'work', id: string, fill: number): WorkMark;
    function mark(kind: 'heap', id: string, fill: number): HeapMark;
    function mark(kind: 'road', id: string, fill: number): RoadMark;
    function mark(kind: SiteMark['kind'], id: string, fill: number): SiteMark {
      let made = known.get(kind + ':' + id);
      if (!made) {
        const art = kind === 'heap' ? new Sprite() : new Graphics();
        const label = labels.addChild(words('', fill, 12, '600')); label.anchor.set(.5, 1);
        if (art instanceof Sprite) made = { kind: 'heap', id, art: siteArt.addChild(art), label };
        else made = kind === 'road' ? { kind, id, art: siteArt.addChild(art), label } : { kind: 'work', id, art: siteArt.addChild(art), label };
        known.set(kind + ':' + id, made);
      }
      return made;
    }
      // A label over what it names, and where the two are on the screen: `area` is what it labels, in the world.
    const place = (made: SiteMark, text: string, x: number, y: number, area: Bounds) => {
        const label = made.label;
        if (label.text !== text) label.text = text;
        label.position.set(x, y); label.scale.set(1 / zoom, -1 / zoom); label.visible = made.art.visible = true;
        const { minX, minY, maxX, maxY } = label.getBounds(), a = camera.toScreen(area.minX, area.maxY), b = camera.toScreen(area.maxX, area.minY);
        boxes.set(made.kind + ':' + made.id, { kind: made.kind, id: made.id, label: { x: (minX + maxX) / 2, left: minX, right: maxX, top: minY, bottom: maxY },
          area: { left: Math.min(minX, a.x, b.x), right: Math.max(maxX, a.x, b.x), top: Math.min(minY, a.y, b.y), bottom: Math.max(maxY, a.y, b.y) } });
        obstacles.push({ x: (minX + maxX) / 2, y: minY, width: maxX - minX, top: 0, bottom: maxY - minY });
      },
      near = (minX: number, maxX: number) => maxX >= camera.x - half - SITE_VIEW && minX <= camera.x + half + SITE_VIEW;
    for (const work of works) {
      const made = mark('work', work.id, WORK_LABEL);
      // The works of a post is the post it becomes, as far as it has come, under a label where its flag will fly.
      if (work.post) {
        made.back ??= this.worksLayer!.addChild(new HazedGraphics());
        const y = ground.height(work.x), percent = Math.floor(work.progress * 100 + 1e-6);
        if (made.shape?.ground !== ground) made.shape = { ground, minX: work.x - POST_RADIUS, maxX: work.x + POST_RADIUS, minY: y, maxY: y + POST_EYE };
        if (!near(made.shape.minX, made.shape.maxX)) { made.art.visible = made.back.visible = made.label.visible = false; continue; }
        made.drawn = this.drawnPost(made.drawn && 'flag' in made.drawn ? made.drawn : null, made.back, made.art, { x: work.x, radius: POST_RADIUS, facing: work.facing }, faction.flag, undefined, work.progress);
        made.back.visible = true;
        place(made, tr`Obra · ${tr(POST_NAME)} · ${percent}%`, made.drawn.flag.x, made.drawn.flag.y + 3 / zoom, made.shape);
        continue;
      }
      if (made.source !== work.blueprint) { made.source = work.blueprint; made.blueprint = compileStructuredConstruction(work.blueprint); made.shape = null; }
      if (made.shape?.ground !== ground) made.shape = { ground, ...workShape(made.blueprint!, ground, work.x, work.facing) };
      const shape = made.shape!, percent = Math.floor(work.progress * 100 + 1e-6);
      if (!('faces' in shape)) throw new TypeError('A obra não tem uma forma compilada.');
      if (!near(shape.minX, shape.maxX)) { made.art.visible = made.label.visible = false; continue; }
      if (!made.drawn || !('shape' in made.drawn) || made.drawn.shape !== shape || made.drawn.percent !== percent || made.drawn.scale !== scale) {
        anchorGraphics(made.art, work.x, shape.minY);
        drawWork(made.art, shape, percent / 100, 1 / scale);
        made.drawn = { shape, percent, scale };
      }
      place(made, tr`Obra · ${String(work.name)} · ${percent}%`, (shape.minX + shape.maxX) / 2, shape.maxY + .45, shape);
    }
    for (const heap of heaps) {
      const made = mark('heap', heap.id, HEAP_LABEL);
      if (made.stock !== heap.stock) {
        const look = pileLook(heap.stock);
        Object.assign(made, { stock: heap.stock, look, size: pileSize(look) });
      }
      const look = made.look!, size = made.size!, art = made.art, y = ground.height(heap.x);
      if (!near(heap.x - size.width / 2, heap.x + size.width / 2)) { art.visible = made.label.visible = false; continue; }
      art.texture = this.pilePicture!(look).texture;
      art.anchor.set(.5, 1); art.position.set(heap.x, y - .03); art.width = size.width; art.height = size.height; art.scale.y = -Math.abs(art.scale.y);
      place(made, 'Material', heap.x, y + size.height + .45, { minX: heap.x - size.width / 2, maxX: heap.x + size.width / 2, minY: y, maxY: y + size.height });
    }
    // A road is marked over twice the width of the view about it, and again when the view comes to an end of that. Its label
    // stands in the earth under the middle of the road, or under the edge of the view the road goes on past; its mark on the
    // panels is that label alone: the ground along it is still the field's to click on.
    const from = camera.x - 2 * half, to = camera.x + 2 * half;
    for (const road of roads) {
      const made = mark('road', road.id, ROAD_LABEL), drawn = made.drawn;
      if (!near(road.x0, road.x1)) { made.art.visible = made.label.visible = false; continue; }
      if (!drawn || !('x0' in drawn) || drawn.ground !== ground || drawn.scale !== scale || drawn.x0 !== road.x0 || drawn.x1 !== road.x1 || camera.x - half < drawn.from || camera.x + half > drawn.to) {
        drawStretch(made.art, ground, road, from, to, 1 / scale, ROAD_MARK);
        made.drawn = { ground, scale, x0: road.x0, x1: road.x1, from, to };
      }
      const x = clamp(clamp((road.x0 + road.x1) / 2, camera.x - half * .7, camera.x + half * .7), road.x0, road.x1), y = ground.height(x) - 6 / zoom,
        percent = Math.floor((road.kind === 'asphalt' ? (road.graded + road.paved) / 2 : road.graded) * 100 + 1e-6);
      if (made.label.anchor.y !== 0) made.label.anchor.set(.5, 0);
      place(made, tr`Estrada · ${roadKindText(road.kind)} · ${percent}%`, x, y, { minX: x, maxX: x, minY: y, maxY: y });
    }
    // Of the stretch being chosen, what lies on ground never seen is drawn over the mist, among the labels.
    const preview: RoadPreviewGraphics = this.roadPreview ??= this.siteArt.addChild(new Graphics()), blind = this.roadBlind ??= this.labels.addChild(new Graphics());
    preview.visible = blind.visible = Boolean(asked);
    if (asked && (preview.drawn?.asked !== asked || preview.drawn.scale !== scale || preview.drawn.ground !== ground ||
      camera.x - half < preview.drawn.from || camera.x + half > preview.drawn.to)) {
      drawAsked(preview, blind, ground, asked, from, to, 1 / scale, x => this.markHeight!(x));
      preview.drawn = { asked, scale, ground, from, to };
    }
  }
}
