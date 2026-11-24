import type { Geometry, Shader, Texture } from 'pixi.js';
import type { Point } from './math.ts';
import type { Terrain, TerrainId, TerrainFeature, TerrainRock } from './terrain.ts';
import type { TerrainPaintGround } from './terrain-art.ts';
import type { Plant } from './flora-art.ts';
import type { StrataPlan, MaterialMesh } from './strata-art.ts';
import type { Road } from './roads.ts';
import type { Spans } from './ground-sight.ts';
import type { EffectCamera } from './effect-types.ts';
import type { RoadWork } from './road-machine-motion.ts';
type TerrainMesh = Mesh<MeshGeometry, Shader> & { gone?: string; full?: Float32Array };
type GroundMesh = ReturnType<typeof surfaceMesh>;
interface ChunkBounds { left: number; right: number; biome?: TerrainId | undefined }
interface TerrainBase { earth: GroundMesh; strata: TerrainMesh; stones?: Container | null | undefined; stale?: boolean }
interface DetailPart extends ChunkBounds { fine?: Graphics | null; props?: Graphics | null; cover?: TerrainMesh | null; frontCover?: TerrainMesh | null; soil?: Container | null; stale?: boolean; thinned?: boolean; plants?: Partial<Record<'cover' | 'frontCover', Plant[]>> }
interface TerrainChunk extends ChunkBounds {
 top?: number; overview?: boolean; wide?: boolean; bases?: Map<number, TerrainBase> | null; step?: number;
 earth?: GroundMesh | null; strata?: TerrainMesh | null; stones?: Container | null | undefined; grain?: Container | null; grainStep?: number;
 flora?: TerrainMesh | null; frontFlora?: TerrainMesh | null; ruins?: Graphics | null; soil?: Container | null; fine?: Container | null; props?: Container | null; frontCover?: Container | null;
 plants?: Plant[] | null; details?: DetailPart[] | null; floraIndices?: Partial<Record<'flora' | 'frontFlora', { full: Uint32Array; coarse: Uint32Array }>> | null; coarseFlora?: boolean;
}
export interface TerrainArt { grains?: Readonly<Record<string, Texture>> | undefined; flora?: Texture | undefined; farFlora?: Texture | undefined; masonry?: Texture | undefined }
interface Placed<T> { item: T; at: number; key: number }
interface FeatureIndex { of: TerrainFeature[]; rocksOf: TerrainRock[]; features: Placed<TerrainFeature>[]; rocks: Placed<TerrainRock>[]; reach: number }
interface Shown { x: number; y: number; zoom: number; first: number; last: number; step: number }
interface RoadDrawing { roads: readonly Road[]; step: number; left: number; right: number; work: string }
interface PresentedRoads { roads: readonly Road[]; windows: [number, number][]; key: string; base: readonly Road[]; works: readonly RoadWork[] | null | undefined }
type DrawingKey = 'earth' | 'strata' | 'stones' | 'grain' | 'flora' | 'frontFlora' | 'ruins' | 'soil' | 'fine' | 'props' | 'frontCover';
import { tr } from './i18n.ts';
import { number } from './format.ts';
import { Graphics, Container, Mesh, MeshGeometry } from 'pixi.js';
import { TERRAIN_PROFILES, RoughGround, underfootGround } from './terrain.ts';
import { drawGroundSurface, drawGroundDetail, earthFloor } from './terrain-art.ts';
import { strataPlan, strataTexture, buildStrata, buildSoilGrain } from './strata-art.ts';
import { plantFlora, plantCover, floraGeometry, coarseFloraIndices, splitFlora, drawFloraFeet } from './flora-art.ts';
import { drawRuins } from './ruins-art.ts';
import { anchorGraphics } from './world-anchor.ts';
import { simplifyGround, terrainStep, outlineError } from './terrain-lod.ts';
import { smoothstep } from './math.ts';
import { surfaceMesh, surfaceShader, strataShader, groundPlaces, pigmentTexture, terrainTextureShader, vegetationUniforms } from './terrain-surface.ts';
import { HazedGraphics } from './haze.ts';
import { drawRoads } from './road-art.ts';
import { roadAt } from './roads.ts';
import { roadsAtWork } from './road-machine-motion.ts';

// A new close-view stretch prepares a short surface and its strata together. Retain the same roughly twelve
// kilometres of nearby ground, so the smaller meshes do not turn a return into another cold preparation.
const CHUNK_METRES = 128, WIDE_METRES = 1024, OVERVIEW_METRES = 4096, KEPT_CHUNKS = 96, DETAIL_METRES = 64;
// Below this many pixels to the metre nothing of the detail of the ground is a pixel across, and below
// the other a tree is not: neither is drawn, and the detail of a stretch is not even built until the
// camera first comes that close to it.
// Leave the overview when LOD32 ends, before the flora appears. Its two-metre contour tolerance
// remains under a quarter of a CSS pixel throughout this range. Enter it just under that: the short
// stretches drawn at LOD32 below it are a hundred and more to a wide screen, each a few pixels across
// and a draw of its own, where the overview draws the same outline in four or five.
export const DETAIL_ZOOM = 3, FLORA_ZOOM = .14, OVERVIEW_ZOOM = .12, OVERVIEW_EXIT_ZOOM = .125;
// Between the overview and the whole outline the ground is drawn at the same coarse step (terrain-lod.ts) in stretches of
// a kilometre (`WIDE_METRES`): a wide screen there holds a hundred stretches of the near partition and more, each a few
// pixels of earth, strata, stones and trees drawn on its own, where it holds a dozen of these. A stretch of them grows the
// very trees its near stretches grow (`nearPlants`), and is drawn as they are: the same ground at the same scale, in fewer
// pieces. Leave them a little over where the whole outline begins to be drawn, and come back a little under it.
export const WIDE_ZOOM = .48, WIDE_EXIT_ZOOM = .5;
const COARSE_FLORA_ZOOM = .24, COARSE_FLORA_EXIT_ZOOM = .28;
// How many stretches of the partition asked for are painted a frame while the one shown is held (`handOver`).
const HANDOVER_PAINTS = 1;
// From this many pixels to the metre the ground is drawn with the bumps its running gear stands on (terrain.ts
// `RoughGround`), a scale of its own (`ROUGH`), finer than the whole outline: below it the highest of them, a stone of
// rock, is less than a pixel and a half, and a wheel on it as far off a line drawn without them.
export const BUMPS_ZOOM = 8;
export const ROUGH = -1;
const GRAIN_FULL_ZOOM = 12;

// Points and nonoverlapping sectors are ordered along the ground. A new visible chunk reads only
// its own span, rather than scanning hundreds of kilometres of points whenever the camera moves.
function bound<Key extends string, Item extends Record<Key, number>>(items: readonly Item[], key: Key, value: number, after = false) {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1, at = items[middle]![key];
    if (at < value || after && at === value) low = middle + 1; else high = middle;
  }
  return low;
}
// The features of a ground by where each begins, with the longest of them, and its rocks by where each peaks: a stretch
// finds what it holds among the few that begin about it, not among the thousands of a whole map, every time a chunk is
// painted. Each keeps its place in the ground's own order, which is the order a stretch tells them in. Made once a ground.
const indexes = new WeakMap<Terrain, FeatureIndex>();
function featureIndex(terrain: Terrain): FeatureIndex {
  let index = indexes.get(terrain);
  if (index?.of === terrain.features && index.rocksOf === terrain.rocks) return index;
  const placed = <Key extends string, Item extends Record<Key, number>>(list: readonly Item[], key: Key): Placed<Item>[] => list.map((item, at) => ({ item, at, key: item[key] })).sort((a, b) => a.key - b.key);
  index = { of: terrain.features, rocksOf: terrain.rocks, features: placed(terrain.features, 'start'), rocks: placed(terrain.rocks, 'peak'),
    reach: terrain.features.reduce((most, f) => Math.max(most, f.end - f.start), 0) };
  indexes.set(terrain, index); return index;
}
// Of what an index holds by its key from `from` up to `to`, what `holds` says, in the ground's own order.
function within<T>(placed: readonly Placed<T>[], from: number, to: number, holds: (item: T) => boolean): T[] {
  const found = [];
  for (let i = bound(placed, 'key', from), end = bound(placed, 'key', to); i < end; i++) if (holds(placed[i]!.item)) found.push(placed[i]!);
  return found.sort((a, b) => a.at - b.at).map(entry => entry.item);
}

// An overview needs fewer independent draws, as well as fewer corners. Keep a second partition of
// the same outline, still bounded by each biome and anchored locally. Its buffers never serve a
// close view, where the shorter stretches retain the precision needed to show millimetres.
function partition(terrain: Terrain, metres: number, overview = false, wide = false): TerrainChunk[] {
  const chunks = [], start = terrain.points[0]!.x, end = terrain.points.at(-1)!.x;
  for (let left = start; left < end;) {
    const region = terrain.regionAt(left), stop = region.end > left && region.end < end ? region.end : end,
      parts = Math.ceil((stop - left) / metres), width = (stop - left) / parts;
    for (let i = 0; i < parts; i++) {
      const a = left + i * width, b = i === parts - 1 ? stop : left + (i + 1) * width;
      let top = Math.max(terrain.height(a), terrain.height(b));
      for (let p = bound(terrain.points, 'x', a, true); p < terrain.points.length && terrain.points[p]!.x < b; p++) top = Math.max(top, terrain.points[p]!.y);
      chunks.push({ left: a, right: b, biome: region.id, top, overview, wide });
    }
    left = stop;
  }
  return chunks;
}

const PARTS = ['earth', 'strata', 'stones', 'grain', 'flora', 'frontFlora', 'ruins', 'soil', 'fine', 'props', 'frontCover'] as const;
function hide(chunk: Partial<Record<DrawingKey, Container | null | undefined>>) {
  for (const name of PARTS) if (chunk[name]) chunk[name]!.visible = false;
}

// What a drawing made for the scene holds goes with it: its context, and the corners of each mesh in it.
function discard(drawn: Container) {
  drawn.removeFromParent();
  const geometries: Geometry[] = [];
  const visit = (child: Container): void => { if (child instanceof Mesh) geometries.push(child.geometry); for (const nested of child.children) visit(nested); };
  visit(drawn);
  drawn.destroy({ children: true, context: true }); for (const geometry of geometries) geometry.destroy(true);
}
// The low growth of a stretch of detail (`cover`, `frontCover`), but for the plants of it that stand where `gone` says:
// their corners are drawn together, and what was drawn of them is kept for when they stand again.
function thin(drawn: TerrainMesh, plants: readonly Plant[], gone: (plant: Plant) => boolean) {
  const flags = plants.map(plant => gone(plant) ? 1 : 0), key = flags.join('');
  if (key === (drawn.gone ?? '0'.repeat(plants.length))) return;
  drawn.gone = key;
  const buffer = drawn.geometry.getBuffer('aPosition'), positions = drawn.geometry.positions, full = drawn.full ??= positions.slice();
  flags.forEach((out, i) => {
    for (let k = 0; k < 8; k += 2) {
      positions[i * 8 + k] = full[i * 8 + (out ? 0 : k)]!; positions[i * 8 + k + 1] = full[i * 8 + (out ? 1 : k + 1)]!;
    }
  });
  buffer.update();
}

// `attributes` are four numbers to a corner, by name: the colours of plants (`aColor`), the places of the earth (`aPlace`).
function mesh(parent: Container, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, texture: Texture, origin: Point, attributes: Readonly<Record<string, Float32Array>> = {}, shader: Shader | null | undefined = null): TerrainMesh {
  const geometry = new MeshGeometry({ positions, uvs, indices });
  for (const [name, buffer] of Object.entries(attributes)) geometry.addAttribute(name, { buffer, format: 'float32x4', stride: 16 });
  // The transform of a mesh of its own goes to the GPU as it is: moving the camera rewrites no vertex.
  geometry.batchMode = 'no-batch';
  const made = new Mesh({ geometry, texture, ...(shader ? { shader } : {}) }); made.position.set(origin.x, origin.y); parent.addChild(made);
  return made;
}
// A material owns one shared sampler; each chunk owns only these compact meshes.
function grainMeshes(parent: Container, parts: Readonly<Record<string, MaterialMesh>>, textures: Readonly<Record<string, Texture>>) {
  const group = parent.addChild(new Container()), origin = Object.values(parts)[0]!;
  group.position.set(origin.x, origin.y);
  for (const [kind, part] of Object.entries(parts)) if (part.indices.length)
    mesh(group, part.positions, part.uvs, part.indices, textures[kind]!, { x: part.x - origin.x, y: part.y - origin.y });
  return group;
}
// What a chunk draws stands at its left end, as its meshes do, and holds its places counted from there.
const drawing = (parent: Container, left: number, made = new Graphics()) => anchorGraphics(parent.addChild(made), left, 0);

// Only presentation is partitioned. Contacts, sensors and projectiles continue
// to read the single authoritative terrain polyline, including chunk seams.
// A landscape is laid out in chunks of one biome each, and a chunk is painted
// when the camera first reaches it: a map of any length costs what is in view.
// A chunk is its trees and its ruins, behind the ground line, with a layer over them for works that stand there too; the earth under it, as strata and their
// grain; the first two metres of ground over them; and the detail a near view shows, built when the camera first comes close.
// `art` hands over the shared materials and plant atlas; without it those layers are left out.
function roughLocal(local: Omit<TerrainPaintGround, 'height' | 'surface' | 'materialAt'>, terrain: Terrain, left: number, right: number): TerrainPaintGround {
  const ground = new RoughGround(terrain, left, right);
  return Object.assign(local, { points: ground.section(left, right), height: (x: number) => ground.height(x),
    surface: (x: number) => ({ ...terrain.surface(x), y: ground.height(x) }), materialAt: (x: number) => terrain.materialAt(x) });
}
export class TerrainScene {
  declare earth: Container; declare props: Container; declare art: TerrainArt | null; declare chunks: TerrainChunk[]; declare wideChunks: TerrainChunk[]; declare overviewChunks: TerrainChunk[]; declare allChunks: TerrainChunk[]; declare activeChunks: TerrainChunk[];
  declare meter: { mark(name: string): void } | null; declare builds: number; declare painted: number; declare vegetationUniforms: ReturnType<typeof vegetationUniforms>; declare layers: Record<'flora' | 'works' | 'strata' | 'grain' | 'surface' | 'soil' | 'detail' | 'roads' | 'frontFlora' | 'frontCover', Container>; declare foreground: Container;
  declare tints: Map<Texture, Shader> | null; declare strataShader: Shader | null; declare surfaceShader: Shader | null; declare tones: Texture | null; declare pigment: Texture | null; declare plan: StrataPlan | null;
  declare terrain: Terrain | null; declare shown: Shown | null; declare refineAfter: number; declare roadArt: Graphics | null; declare workArt: Graphics | null; declare roadsDrawn: RoadDrawing | null; declare roadsView: [number, number, number] | null; declare works: readonly RoadWork[] | null; declare atWork: PresentedRoads | null; declare coarseFlora: boolean; declare floor: number;
  constructor(earth: Container, props: Container, art: TerrainArt | null = null) {
    this.earth = earth; this.props = props; this.art = art; this.chunks = []; this.wideChunks = []; this.overviewChunks = []; this.meter = null;
    this.allChunks = this.activeChunks = this.chunks; this.builds = 0; this.painted = 0;
    this.vegetationUniforms = vegetationUniforms();
    this.foreground = new Container();
    this.layers = { flora: earth.addChild(new Container()), works: earth.addChild(new Container()), strata: earth.addChild(new Container()), grain: earth.addChild(new Container()), surface: earth.addChild(new Container()), soil: earth.addChild(new Container()), detail: earth.addChild(new Container()), roads: earth.addChild(new Container()), frontFlora: this.foreground.addChild(new Container()), frontCover: this.foreground.addChild(new Container()) };
  }
  clear() {
    for (const chunk of this.allChunks) if (chunk.earth) this.forget(chunk);
    // What others have stood among the scenery, behind the ground line, is theirs to keep.
    for (const root of [...Object.values(this.layers).filter(layer => layer !== this.layers.works), this.props])
      for (const child of root.removeChildren()) child.destroy({ children: true, context: true });
    for (const shader of [...this.tints?.values() || [], this.strataShader, this.surfaceShader]) shader?.destroy();
    this.tints = this.strataShader = this.surfaceShader = null;
    this.tones?.destroy(true); this.pigment?.destroy(true); this.tones = this.pigment = this.plan = null;
    this.chunks = []; this.wideChunks = []; this.overviewChunks = []; this.allChunks = this.activeChunks = this.chunks;
    this.painted = 0; this.terrain = null; this.shown = null; this.refineAfter = 0; this.roadArt = this.roadsDrawn = this.roadsView = this.workArt = null;
    this.works = this.atWork = null; this.coarseFlora = false;
  }
  rebuild(terrain: Terrain) {
    this.clear(); this.builds++; this.terrain = terrain;
    this.plan = strataPlan(terrain); this.tones = strataTexture(this.plan); this.floor = earthFloor(terrain);
    this.pigment = pigmentTexture(terrain.seed);
    this.strataShader = strataShader(this.tones, this.pigment); this.surfaceShader = surfaceShader(this.pigment);
    this.tints = new Map([...new Set([this.art?.flora, this.art?.farFlora].filter((texture): texture is Texture => texture !== undefined))]
      .map(texture => [texture, terrainTextureShader(texture, this.vegetationUniforms)]));
    const start = terrain.points[0]!.x, end = terrain.points.at(-1)!.x;
    if (!TERRAIN_PROFILES[terrain.id]?.battle) { this.chunks.push({ left: start, right: end }); this.paint(this.chunks[0]!); return; }
    this.chunks = partition(terrain, CHUNK_METRES); this.wideChunks = partition(terrain, WIDE_METRES, false, true);
    this.overviewChunks = partition(terrain, OVERVIEW_METRES, true);
    this.allChunks = [...this.chunks, ...this.wideChunks, ...this.overviewChunks]; this.activeChunks = this.chunks;
  }
  // The ground of a chunk as its art reads it: the outline between its two ends, of one biome. `rough`, it is the ground
  // the running gear stands on, with the bumps over its line (`RoughGround`): what a near view stands on the ground
  // stands on them.
  local(chunk: ChunkBounds, rough = false): TerrainPaintGround {
    const terrain = this.terrain!, { left, right } = chunk, whole = !chunk.biome && left === terrain.points[0]!.x && right === terrain.points.at(-1)!.x;
    if (whole) return rough ? roughLocal({ ...terrain }, terrain, left, right) : terrain;
    const id = chunk.biome || terrain.id, index = featureIndex(terrain), local = { ...terrain, id, material: TERRAIN_PROFILES[id].surface, minX: left, maxX: right,
      points: [{ x: left, y: terrain.height(left) }, ...terrain.points.slice(bound(terrain.points, 'x', left, true), bound(terrain.points, 'x', right)),
        { x: right, y: terrain.height(right) }],
      sectors: terrain.sectors.slice(bound(terrain.sectors, 'end', left, true), bound(terrain.sectors, 'start', right)),
      features: within(index.features, left - index.reach, right, f => f.end > left && f.start < right &&
        (f.kind === 'plateau' || f.peak >= left && f.peak < right)),
      rocks: within(index.rocks, left, right, r => r.peak >= left && r.peak < right),
      height: (x: number) => terrain.height(x), surface: (x: number) => terrain.surface(x), materialAt: (x: number) => terrain.materialAt(x),
    };
    if (!rough) return local;
    return roughLocal(local, terrain, left, right);
  }
  // The surface of a chunk at a scale, as a mesh of its own in the surface layer, under the stones of the earth that
  // stand there already (`stones`): its whole outline or a coarser one (terrain-lod.ts), or with its bumps (`ROUGH`).
  surface(chunk: TerrainChunk, step: number, stones: Container | null | undefined = null) {
    const terrain = this.terrain!, { left, right } = chunk, layers = this.layers, drawn = anchorGraphics(new Graphics(), left, 0),
      original = this.local(chunk),
      // A complete test track is a Terrain instance: spreading it alone would lose its prototype
      // samplers. Coarse corners change only the drawing; all sampling keeps the original outline.
      local = step > 0 ? { ...original, points: simplifyGround(original.points, outlineError(step)),
        height: (x: number) => terrain.height(x), surface: (x: number) => terrain.surface(x), materialAt: (x: number) => terrain.materialAt(x) } : original;
    drawGroundSurface(local, drawn, step > 0, chunk.overview, step === ROUGH ? new RoughGround(terrain, left, right) : null);
    const earth = surfaceMesh(drawn.context, terrain, left, this.surfaceShader!); earth.position.copyFrom(drawn.position);
    drawn.destroy({ context: true });
    return stones?.parent === layers.surface ? layers.surface.addChildAt(earth, layers.surface.getChildIndex(stones)) : layers.surface.addChild(earth);
  }
  paint(chunk: TerrainChunk, step = 0) {
    if (chunk.overview) step = 32;
    const bases = chunk.bases ||= new Map(), visible = chunk.earth?.visible ?? true;
    let base = bases.get(step);
    // A surface drawn with the bumps of roads the field has laid since is drawn again, and what it was let go once its
    // place is taken: nothing of it is missing for a frame.
    if (base?.stale) {
      const old = base.earth;
      base.earth = this.surface(chunk, step, base.stones); base.stale = false; base.earth.visible = old.visible;
      if (chunk.earth === old) chunk.earth = base.earth;
      discard(old);
    }
    const previous = chunk.earth;
    if (!base) {
      const terrain = this.terrain!, { left, right } = chunk, layers = this.layers,
        // The surface with its bumps and the whole outline lie over the same earth, whichever is drawn first.
        twin = step === ROUGH ? bases.get(0) : step === 0 ? bases.get(ROUGH) : null;
      if (twin) base = { earth: this.surface(chunk, step, twin.stones), strata: twin.strata, stones: twin.stones };
      else {
        const strata = buildStrata(this.plan!, left, right, this.floor, Math.max(step, 0), Boolean(this.art?.grains) && !chunk.overview),
          earth = this.surface(chunk, step), bedEnd = strata.bedVertices * 2,
          places = groundPlaces(strata.positions, terrain, left);
        base = { earth, strata: mesh(layers.strata, strata.positions.subarray(0, bedEnd), strata.tones.subarray(0, bedEnd),
          strata.indices.subarray(0, strata.bedIndices), this.tones!, strata, { aPlace: places.subarray(0, bedEnd * 2) }, this.strataShader) };
        // Buried stones belong above the painted soil bands too: the same native
        // clast cannot disappear just because it lies within the first two metres.
        if (strata.clasts) {
          base.stones = layers.surface.addChild(new Container()); base.stones.position.set(left, 0);
          mesh(base.stones, strata.positions.subarray(bedEnd), strata.tones.subarray(bedEnd),
            strata.indices.subarray(strata.bedIndices).map(index => index - strata.bedVertices), this.tones!, { x: 0, y: 0 }, { aPlace: places.subarray(bedEnd * 2) }, this.strataShader);
          if (this.art?.grains) {
            const rock = strata.clastGrain!;
            mesh(base.stones, rock.positions, rock.uvs, rock.indices, this.art.grains.rock!, { x: 0, y: 0 }).alpha = .6;
          }
        }
        // Grain shows only up close. Keep one shared layer per chunk, upgrading it with the first full
        // outline; the coarse alternatives need neither a second grain nor another wood or detail layer.
        if (!chunk.overview && !chunk.wide && this.art?.grains && (!chunk.grain || step <= 0 && chunk.grainStep! > 0)) {
          this.release(chunk, 'grain');
          chunk.grain = grainMeshes(layers.grain, strata.grain!, this.art!.grains!);
          chunk.grain.alpha = .6; chunk.grainStep = step;
        }
      }
      bases.set(step, base);
      if (!previous) {
        const local = this.local(chunk);
        // The ruins whose middle is in the chunk stand among its trees, their feet hidden by the earth before them, seen
        // through the haze as the trees are (haze.ts).
        if (local.features.some(f => f.kind === 'ruins')) drawRuins(local, chunk.ruins = drawing(layers.flora, left, new HazedGraphics()), chunk.overview, this.art?.masonry);
        this.painted++;
      }
    }
    // Returning to a scale selects its existing buffers, rather than retaining the most detailed one
    // forever or rebuilding it on every zoom. Only one of the at most four bases is drawn.
    if (previous) for (const name of ['earth', 'strata', 'stones'] as const) if (chunk[name]) chunk[name].visible = false;
    Object.assign(chunk, { step, earth: base.earth, strata: base.strata, stones: base.stones });
    for (const name of ['earth', 'strata', 'stones'] as const) if (chunk[name]) chunk[name].visible = visible;
  }
  plant(chunk: TerrainChunk) {
    const terrain = this.terrain!, { left, right } = chunk;
    chunk.floraIndices = {}; chunk.coarseFlora = this.coarseFlora;
    const plants = chunk.plants = !this.art?.flora ? [] : chunk.wide || chunk.overview ? this.nearPlants(left, right)
      : plantFlora(terrain, left, right, chunk.biome || terrain.id, this.chunks.indexOf(chunk));
    if (!plants.length) return;
    const origin = { x: left, y: Math.round(terrain.height(left)) }, { behind, front } = splitFlora(plants);
    // The trees behind the ground line are painted from the atlas seen through the haze (`farFlora`), where there is one.
    for (const [name, row, picture] of [['flora', behind, this.art!.farFlora || this.art!.flora!], ['frontFlora', front, this.art!.flora!]] satisfies ['flora' | 'frontFlora', Plant[], Texture][]) if (row.length) {
      const quads = floraGeometry(row, origin, terrain.seed);
      const drawn = chunk[name] = mesh(this.layers[name], quads.positions, quads.uvs, quads.indices, picture, origin, { aColor: quads.colors, aPlant: quads.roots }, this.tints!.get(picture));
      const indices = chunk.floraIndices![name]! = { full: quads.indices, coarse: coarseFloraIndices(row) };
      if (this.coarseFlora) drawn.geometry.indices = indices.coarse;
    }
  }
  // The trees of the near stretches from `left` to `right` along the ground, each grown as its stretch grows it, those
  // that stand there: a wide stretch has them all, and no other, whether the near ones were ever drawn or not; and so does
  // a stretch of the overview held into the zoom of the trees (`handOver`).
  nearPlants(left: number, right: number) {
    const terrain = this.terrain!, plants = [];
    for (let i = bound(this.chunks, 'right', left); i < this.chunks.length && this.chunks[i]!.left < right; i++) {
      const near = this.chunks[i]!;
      for (const plant of near.plants ?? plantFlora(terrain, near.left, near.right, near.biome || terrain.id, i))
        if (plant.x >= left && plant.x < right) plants.push(plant);
    }
    return plants;
  }
  detail(chunk: TerrainChunk, viewLeft = chunk.left, viewRight = chunk.right, allowance = Infinity) {
    const terrain = this.terrain!;
    if (!chunk.details) {
      chunk.fine = this.layers.detail.addChild(new Container()); chunk.props = this.props.addChild(new Container());
      if (this.art?.flora) chunk.frontCover = this.layers.frontCover.addChild(new Container());
      if (this.art?.grains) chunk.soil = this.layers.soil.addChild(new Container());
      for (const part of [chunk.fine, chunk.props, chunk.frontCover, chunk.soil]) if (part) part.position.set(chunk.left, 0);
      const count = Math.ceil((chunk.right - chunk.left) / DETAIL_METRES), width = (chunk.right - chunk.left) / count;
      chunk.details = Array.from({ length: count }, (_, i) => ({ biome: chunk.biome, left: chunk.left + i * width, right: i === count - 1 ? chunk.right : chunk.left + (i + 1) * width }));
    }
    for (const [i, part] of chunk.details.entries()) {
      const visible = part.left <= viewRight && part.right >= viewLeft;
      // A stretch the roads changed over is built again before what it had is let go: nothing of it is missing for a frame.
      if (visible && (!part.fine || part.stale) && allowance > 0) {
        allowance--;
        if (part.stale) for (const name of ['fine', 'props', 'cover', 'frontCover', 'soil'] as const) if (part[name]) { discard(part[name]!); part[name] = null; }
        part.stale = false; part.plants = {};
        const index = this.chunks.indexOf(chunk), local = this.local(part, true),
          fine = part.fine = drawing(chunk.fine!, part.left), props = part.props = drawing(chunk.props!, part.left);
        fine.x -= chunk.left; props.x -= chunk.left;
        // Prepare only the detail entering the view, rather than the whole base stretch at once.
        drawGroundDetail(local, fine, props, {
          density: (part.right - part.left) / 143 * (chunk.biome ? Math.max(.27, Math.min(1, 430 / terrain.length)) : 1),
          salt: index * 32 + i, inset: 0,
        });
        if (this.art?.flora) {
          const cover = plantCover(local, part.left, part.right, index * 32 + i), { behind, front } = splitFlora(cover);
          drawFloraFeet(fine, [...chunk.plants!.filter(p => p.x >= part.left && p.x < part.right), ...cover], underfootGround(terrain));
          for (const [name, row, parent] of [['cover', behind, chunk.props!], ['frontCover', front, chunk.frontCover!]] satisfies ['cover' | 'frontCover', Plant[], Container][]) if (row.length) {
            const quads = floraGeometry(row, { x: part.left, y: 0 }, terrain.seed);
            part[name] = mesh(parent, quads.positions, quads.uvs, quads.indices, this.art.flora, { x: part.left - chunk.left, y: 0 }, { aColor: quads.colors, aPlant: quads.roots }, this.tints!.get(this.art.flora));
            part.plants![name] = row;
          }
        }
        const soil = this.art?.grains && buildSoilGrain(local, part.left, part.right);
        if (soil && Object.values(soil).some(part => part.indices.length)) {
          part.soil = grainMeshes(chunk.soil!, soil, this.art!.grains!); part.soil.x -= chunk.left; part.soil.alpha = .55;
        }
      }
      for (const drawn of [part.fine, part.props, part.cover, part.frontCover, part.soil]) if (drawn) drawn.visible = visible;
    }
    return allowance;
  }
  // The roads laid on the ground have changed over `spans` (roads.ts `unlike`): the detail of the ground there, which
  // grows nothing on a road and lays nothing on it, is built again when next seen, and the roads are drawn as they are.
  repaved(spans: Spans) {
    for (const chunk of this.chunks) for (const part of chunk.details ?? [])
      if (part.fine && spans.some(([a, b]) => part.left < b && part.right > a)) part.stale = true;
    // So is its surface drawn with bumps, which are those of the road where one lies (`Terrain.underfoot`).
    for (const chunk of this.chunks) {
      const rough = chunk.bases?.get(ROUGH);
      if (rough && spans.some(([a, b]) => chunk.left < b && chunk.right > a)) rough.stale = true;
    }
    this.roadsDrawn = null;
  }
  // The roads as the screen shows them (road-machine-motion.ts `roadsAtWork`): where machines make one (`works`, as told
  // to `showWork`), as far as their tools have come; elsewhere, as the field has laid them.
  presented() {
    const roads = this.terrain!.roads, works = this.works;
    if (this.atWork?.base !== roads || this.atWork.works !== works)
      this.atWork = { ...(works?.length ? roadsAtWork(roads, works) : { roads, windows: [], key: '' }), base: roads, works };
    return this.atWork;
  }
  // The roads over the earth of the view and of as much again on either side of it, drawn again when the view leaves
  // that, draws the ground at another scale, the roads change or the stretches machines make them on do: one drawing for
  // all of them, anchored in its middle, but for those stretches, which are drawn on every frame (`showWork`).
  showRoads(left: number, right: number, step: number) {
    this.roadsView = [left, right, step];
    const roads = this.terrain!.roads, drawn = this.roadsDrawn, shown = this.presented();
    if (drawn && drawn.roads === roads && drawn.step === step && drawn.work === shown.key && left >= drawn.left && right <= drawn.right) return;
    const from = left - (right - left), to = right + (right - left);
    this.roadsDrawn = { roads, step, left: from, right: to, work: shown.key };
    // Ground with no road laid on it has no drawing of roads at all.
    if (!shown.roads.length && !this.roadArt) return;
    this.roadArt ||= this.layers.roads.addChild(new Graphics());
    const g = anchorGraphics(this.roadArt, Math.round((from + to) / 2), 0);
    let at = from;
    for (const [a, b] of shown.windows) { if (a > at) drawRoads(g, this.terrain!, shown.roads, at, Math.min(a, to), step); at = Math.max(at, b); }
    if (to > at) drawRoads(g, this.terrain!, shown.roads, at, to, step);
  }
  // Where machines make a road (road-machine-motion.ts `worksOf`, none for no machine at work), the ground of their lanes as
  // far as their tools have come, drawn anew on every frame over the drawing of the rest, and the low growth on what they
  // made is gone; the rest of the roads is drawn again only when what they make changes how it is drawn.
  showWork(works: readonly RoadWork[]) {
    if (!this.terrain || !this.roadsView || !works.length && !this.works?.length) return;
    this.works = works;
    const shown = this.presented(), [left, right, step] = this.roadsView;
    if (this.roadsDrawn?.work !== shown.key) { this.roadsDrawn = null; this.showRoads(left, right, step); }
    const windows = shown.windows.filter(([a, b]) => b > left && a < right);
    if (windows.length || this.workArt) {
      this.workArt ||= this.layers.roads.addChild(new Graphics());
      const g = anchorGraphics(this.workArt, Math.round((left + right) / 2), 0);
      for (const [a, b] of windows) drawRoads(g, this.terrain!, shown.roads, Math.max(a, left), Math.min(b, right), step, false);
    }
    this.thinGrowth(shown);
  }
  // The low growth of the detail of the ground in view, but for what stands on a road the screen shows and the field has
  // not laid yet: the rest of it was built with none there.
  thinGrowth(shown: PresentedRoads) {
    const chunks = this.activeChunks, { first = 0, last = 0 } = this.shown ?? {};
    for (let c = first; c < last; c++) for (const part of chunks[c]!.details ?? []) {
      const over = shown.windows.some(([a, b]) => part.left < b && part.right > a);
      if (!over && !part.thinned) continue;
      part.thinned = over;
      for (const name of ['cover', 'frontCover'] as const) if (part[name] && part.plants?.[name])
        thin(part[name], part.plants[name], plant => over && roadAt(shown.roads, plant.x) !== null);
    }
  }
  release(chunk: Partial<Record<DrawingKey, Container | null | undefined>>, name: DrawingKey) {
    const part = chunk[name]; chunk[name] = null;
    // Each drawing owns its context and a mesh its corners; their textures belong to the scene or renderer. The earth
    // under two scales of a chunk is theirs together (`paint`), and goes with the first of them.
    if (part && !part.destroyed) discard(part);
  }
  forget(chunk: TerrainChunk) {
    chunk.plants = null; chunk.details = null; chunk.floraIndices = null;
    for (const base of chunk.bases?.values() || []) for (const name of ['earth', 'strata', 'stones'] as const) this.release(base, name);
    chunk.bases = null; chunk.earth = chunk.strata = chunk.stones = null;
    for (const name of ['grain', 'flora', 'frontFlora', 'ruins', 'soil', 'fine', 'props', 'frontCover'] as const) {
      this.release(chunk, name);
    }
    this.painted--;
  }
  // How near the ground of the last view is drawn, in the words of the meter of the frames: its scale and its stretches.
  scale() {
    const shown = this.shown;
    if (!shown) return '';
    const overview = this.activeChunks === this.overviewChunks, wide = this.activeChunks === this.wideChunks, count = shown.last - shown.first;
    const detail = overview ? tr('visão geral') : shown.step === ROUGH ? tr('com calombos')
      : shown.step ? tr`contorno de ${number(outlineError(shown.step), 3)} m` : tr('contorno inteiro');
    const span = number(overview ? OVERVIEW_METRES : wide ? WIDE_METRES : CHUNK_METRES, 0);
    return detail + (count === 1 ? tr` · ${count} trecho de ${span} m` : tr` · ${count} trechos de ${span} m`);
  }
  // Whether the partition shown (`shown`) stays a frame more for the one asked for (`target`). Over ground it has painted it
  // stays, at the scale it is shown at, while one stretch of the view a frame is painted in the other out of sight, as
  // the scales of one partition are; the other takes over once the ground of the view is painted in it. A zoom across
  // the limit of a partition costs a frame no more than one within it does: painting the stretches of the view all at
  // once, some thirty to a wide screen, held one frame up for some seventy milliseconds. Over ground the partition shown
  // has not painted, it is let go at once.
  handOver(target: readonly TerrainChunk[], shown: readonly TerrainChunk[], left: number, right: number, bottom: number, step: number, wooded: boolean) {
    for (let i = bound(shown, 'right', left), end = bound(shown, 'left', right, true); i < end; i++)
      if (!shown[i]!.earth && !(bottom > shown[i]!.top! + 80)) return false;
    let paints = HANDOVER_PAINTS, growth = 1, waiting = false;
    for (let i = bound(target, 'right', left), end = bound(target, 'left', right, true); i < end; i++) {
      const chunk = target[i]!;
      if (bottom > chunk.top! + 80) continue;
      if (!chunk.earth) {
        if (paints > 0) { this.paint(chunk, step); hide(chunk); paints--; } else waiting = true;
      }
      // Keep the old partition's trees until the new one has them too. Only one new wood is prepared per frame.
      if (chunk.earth && wooded && !chunk.plants) {
        if (growth > 0) { this.plant(chunk); hide(chunk); growth--; } else waiting = true;
      }
    }
    return waiting;
  }
  update(camera: EffectCamera, now = performance.now()) {
    this.coarseFlora = camera.zoom < COARSE_FLORA_ZOOM || this.coarseFlora && camera.zoom < COARSE_FLORA_EXIT_ZOOM;
    // Grain reaches zero before its detail meshes are hidden. Fading the two shared layers keeps
    // the cache and preparation budget intact, without a visible switch when zoom crosses 3 px/m.
    this.layers.grain.alpha = this.layers.soil.alpha = smoothstep((camera.zoom - DETAIL_ZOOM) / (GRAIN_FULL_ZOOM - DETAIL_ZOOM));
    // Keep the overview through a small zoom band: switching partitions on every wheel/pinch step
    // around the boundary would evict and rebuild the much larger set of short stretches.
    const before = this.shown, active = this.activeChunks, zoom = camera.zoom,
      overview = zoom < OVERVIEW_ZOOM || active === this.overviewChunks && zoom < OVERVIEW_EXIT_ZOOM,
      wide = !overview && (zoom < WIDE_ZOOM || active === this.wideChunks && zoom < WIDE_EXIT_ZOOM),
      asked = overview && this.overviewChunks.length ? this.overviewChunks : wide && this.wideChunks.length ? this.wideChunks : this.chunks,
      half = camera.width / (2 * zoom) + 24, left = camera.x - half, right = camera.x + half,
      bottom = Number.isFinite(camera.y) && Number.isFinite(camera.height) ? camera.y - camera.height / (2 * zoom) : -Infinity,
      wanted = zoom >= BUMPS_ZOOM ? ROUGH : terrainStep(zoom),
      // The partition shown is held, as it is shown, while the one asked for paints the ground of the view (`handOver`).
      held = asked !== active && Boolean(before) && this.handOver(asked, active, left, right, bottom, wanted, zoom >= FLORA_ZOOM),
      chunks = held ? active : asked, switched = chunks !== active;
    if (switched) for (let i = before?.first ?? 0, end = before?.last ?? this.activeChunks.length; i < end; i++) hide(this.activeChunks[i]!);
    this.activeChunks = chunks;
    const close = !held && zoom >= DETAIL_ZOOM, wooded = zoom >= FLORA_ZOOM, step = held ? before!.step : wanted,
      first = bound(chunks, 'right', left), last = bound(chunks, 'left', right, true);
    // Fast drags do not continually prepare detail that will have left the screen before it is useful.
    if (before && Math.max(Math.abs(camera.x - before.x) * camera.zoom, Math.abs((camera.y || 0) - before.y) * camera.zoom,
      Math.abs(Math.log(camera.zoom / before.zoom)) * camera.width) > 80) this.refineAfter = now + 70;
    this.shown = { x: camera.x, y: camera.y || 0, zoom: camera.zoom, first, last, step };
    let allowance = now >= this.refineAfter ? 1 : 0, growth = 1;
    // Reducing detail already in view saves work during the drag itself. It takes the same single
    // optional preparation slot as promotion or fine detail, which still wait for the camera to settle.
    for (let i = first; i < last; i++) {
      const chunk = chunks[i]!;
      if (chunk.earth && chunk.step! < step && !chunk.bases!.has(step) && !(bottom > chunk.top! + 80)) {
        this.paint(chunk, step); allowance = 0; break;
      }
    }
    let fresh = false, leftView = false;
    // Only the previous and current spans can change visibility. The ordered partition need not be scanned
    // over the whole world each frame; its last span is part of the camera record, not another artwork cache.
    const from = !before ? 0 : switched ? first : Math.min(first, before.first),
      to = !before ? chunks.length : switched ? last : Math.max(last, before.last);
    for (let i = from; i < to; i++) {
      const chunk = chunks[i]!, visible = i >= first && i < last && !(bottom > chunk.top! + 80);
      if (chunk.earth?.visible && !visible) leftView = true;
      if (visible && !chunk.earth) { this.paint(chunk, step); fresh = true; }
      if (!chunk.earth) continue;
      const kept = chunk.bases!.get(step);
      if (visible && (chunk.step !== step || kept?.stale)) {
        if (kept) this.paint(chunk, step);
        // A missing scale shares the optional detail budget. After a fast zoom or drag settles it is
        // prepared one chunk per frame; a cache hit switches immediately even while moving quickly.
        else if (allowance > 0) { this.paint(chunk, step); allowance--; }
      }
      // The meter of the frames (frame-meter.ts), when it is on, tells the trees and the detail apart from the ground.
      if (visible && wooded && !held && !chunk.plants && growth > 0) { this.meter?.mark('terrain'); this.plant(chunk); growth--; this.meter?.mark('scenery'); }
      if (visible && close) { this.meter?.mark('terrain'); allowance = this.detail(chunk, left, right, allowance); this.meter?.mark('scenery'); }
      chunk.earth.visible = chunk.strata!.visible = visible;
      if (chunk.stones) chunk.stones.visible = visible;
      // Native clasts keep their colour while their finish follows the shared grain fade.
      const finish = chunk.stones?.children[1];
      if (finish) finish.alpha = .6 * this.layers.grain.alpha;
      if (chunk.grain) chunk.grain.visible = visible && close;
      if (chunk.flora) chunk.flora.visible = visible && wooded;
      if (chunk.frontFlora) chunk.frontFlora.visible = visible && wooded;
      if (visible && wooded && chunk.plants && chunk.coarseFlora !== this.coarseFlora) {
        for (const name of ['flora', 'frontFlora'] as const) if (chunk[name])
          chunk[name]!.geometry.indices = chunk.floraIndices![name]![this.coarseFlora ? 'coarse' : 'full'];
        chunk.coarseFlora = this.coarseFlora;
      }
      if (chunk.ruins) chunk.ruins.visible = visible;
      if (chunk.fine) chunk.fine.visible = chunk.props!.visible = visible && close;
      if (chunk.frontCover) chunk.frontCover.visible = visible && close;
      if (chunk.soil) chunk.soil.visible = visible && close;
    }
    this.showRoads(left, right, step);
    // Ground out of view stays painted while there is room: for the chunks of some twelve kilometres, or for those of the
    // view and as much again to either side of it where a far view holds more. A far view dragged back over the ground it
    // showed a moment ago finds it painted, where one wider than the room let go of every chunk that left it at once.
    const room = Math.max(KEPT_CHUNKS, 3 * (last - first));
    if (!(fresh || leftView || switched) || this.painted <= room) return;
    // The farthest goes first.
    const away = (c: TerrainChunk) => Math.max(c.left - camera.x, camera.x - c.right),
      hidden = this.allChunks.filter(c => c.earth && !c.earth.visible).sort((a, b) => away(b) - away(a));
    while (this.painted > room && hidden.length) this.forget(hidden.shift()!);
  }
}
