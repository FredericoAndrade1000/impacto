import { BufferImageSource, CanvasSource, Matrix, Texture, Rectangle } from 'pixi.js';
import { Random, clamp } from './math.ts';
import { paintComponent, paintMetal, metalColor } from './component-art.ts';
import { cargoCanvasSize } from './cargo-art.ts';
import { holdsCargo } from './component-volume.ts';
import { MACHINE_KINDS, machineCanvas, machineFineness } from './machine-art.ts';
import { effectTilePixels, FLAME_FRAMES, FLAME_VARIANTS } from './effect-art.ts';
import { MATERIALS, STEEL_PAINT, metalOf } from './materials.ts';
import { context2d } from './canvas-art.ts';
import type { ArtCanvas, ArtContext, XY } from './canvas-art.ts';
import type { Point } from './math.ts';
import type { ModuleKind, MaterialId, MetalId } from './materials.ts';
import type { ComponentArtOptions, MachineCrop } from './vehicle-art-contract.ts';
import type { PaintDetail } from './hull-art.ts';
import type { EffectKind } from './effect-art.ts';
export interface TrackSurfaces { steel: Float32Array; rubber: Float32Array }
export interface ModuleTextureOptions extends ComponentArtOptions {
  trackSurfaces?: TrackSurfaces | null | undefined; wheelSurface?: Float32Array | null | undefined;
  moduleSurface?: Float32Array | null | undefined; frameSurface?: Float32Array | null | undefined; radarSurface?: Float32Array | null | undefined;
  details?: readonly PaintDetail[] | undefined; letteringMirror?: boolean | undefined; material?: MaterialId | undefined;
}
type PaintedPreviewOptions = Omit<ModuleTextureOptions, 'paint' | 'metal'> & { paint: number; metal?: MaterialId | MetalId | undefined };
export type PreviewTextureOptions = ModuleTextureOptions | PaintedPreviewOptions;
const paintedPreview = (options: PreviewTextureOptions): options is PaintedPreviewOptions => options.paint != null;
export interface PreviewTextureShape { left?: number; bottom?: number; width: number; height: number; points: readonly Point[];
  outlines?: readonly (readonly Point[])[]; contour?: string }
export interface ComponentDamageMark { u: number; v: number; radius?: number | undefined; radiusU?: number | undefined; depth?: number | undefined;
  dx?: number | undefined; dy?: number | undefined; strength?: number | undefined; kind: string }
export type PieceCanvasSource<C extends ArtCanvas = ArtCanvas> = CanvasSource & { resource: C };
export type PieceTexture<C extends ArtCanvas = ArtCanvas> = Texture<PieceCanvasSource<C>>;

function hasCanvasSource<C extends ArtCanvas>(texture: Texture, picture: C): texture is PieceTexture<C> {
  return texture.source instanceof CanvasSource && texture.source.resource === picture;
}
// Keep Texture.from's cache and defaults while retaining the source canvas's own API.
export function textureFromCanvas<C extends ArtCanvas>(picture: C): PieceTexture<C> {
  const texture = Texture.from(picture);
  if (!hasCanvasSource(texture, picture)) throw new TypeError('Canvas artwork lost its texture source.');
  return texture;
}


export function canvas(width: number, height: number): ArtCanvas {
  const c = typeof document === 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  c.width = width; c.height = height; return c;
}

// Read the small material once. It supplies brightness variation, never shapes,
// alpha or lighting direction; procedural geometry owns those.
export function surfaceGrain(image: CanvasImageSource, width = 400, height = width) {
  const c = canvas(width, height), ctx = context2d(c);
  ctx.drawImage(image, 0, 0, c.width, c.height);
  const pixels = ctx.getImageData(0, 0, c.width, c.height).data, shades = new Float32Array(c.width * c.height);
  let mean = 0;
  for (let i = 0; i < shades.length; i++) mean += shades[i]! = (pixels[i * 4]! + pixels[i * 4 + 1]! + pixels[i * 4 + 2]!) / 3;
  mean /= shades.length;
  for (let i = 0; i < shades.length; i++) shades[i]! = 1 + (shades[i]! - mean) * .6 / 255;
  return shades;
}

// Bake into the existing cache picture. Multiplying RGB leaves every edge and
// transparent opening exactly as drawn, with no extra sprite or work per frame.
export function paintSurface(ctx: ArtContext, shades: Float32Array, sourceWidth = ctx.canvas.width) {
  const { width, height } = ctx.canvas, image = ctx.getImageData(0, 0, width, height), pixels = image.data,
    sourceHeight = shades.length / sourceWidth,
    columns = Array.from({ length: width }, (_, x) => Math.floor(x * sourceWidth / width));
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y * sourceHeight / height) * sourceWidth;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (!pixels[at + 3]!) continue;
      const shade = shades[row + columns[x]!]!;
      pixels[at]! *= shade; pixels[at + 1]! *= shade; pixels[at + 2]! *= shade;
    }
  }
  ctx.putImageData(image, 0, 0);
}

// Track rims, rubber bands and moving shoes share the generated material maps.
// Masks come from their native geometry; neither material can alter an edge.
export function paintTrackSurface(ctx: ArtContext, surfaces: TrackSurfaces | null | undefined, style: string | undefined, widthM = 1, heightM = 1) {
  if (!surfaces) return;
  const { width, height } = ctx.canvas, image = ctx.getImageData(0, 0, width, height), pixels = image.data,
    size = Math.sqrt(surfaces.steel.length), physical = style === 'track',
    dx = physical ? widthM * 200 / width : size / width, dy = physical ? heightM * 200 / height : size / height,
    columns = Array.from({ length: width }, (_, x) => Math.floor(x * dx) % size);
  for (let y = 0; y < height; y++) {
    const row = (Math.floor(y * dy) % size) * size;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4; if (!pixels[at + 3]!) continue;
      const rubber = style === 'road' || style === 'roller' ? Math.hypot(x + .5 - width / 2, y + .5 - height / 2) > width * (style === 'road' ? .4 : .38)
        : physical && pixels[at]! + 2 >= pixels[at + 1]! && pixels[at]! < 100,
        shades = rubber ? surfaces.rubber : surfaces.steel,
        shade = shades[row + columns[x]!]!;
      pixels[at]! *= shade; pixels[at + 1]! *= shade; pixels[at + 2]! *= shade;
    }
  }
  ctx.putImageData(image, 0, 0);
}

// Large surfaces keep the grain's physical scale instead of stretching a square over a long part.
// Reflection joins the repeat smoothly; only RGB changes, never a cutout or the part's geometry. A canvas that is a piece
// of a bigger picture (`at`) has the grain of that picture where it is: its columns from `at.x` of that picture's on,
// and its foot `at.y` of them over the foot of that picture.
export function paintSurfaceMetres(ctx: ArtContext, shades: Float32Array, shape: { width: number; height: number }, at: Partial<Point> | null = null) {
  const size = Math.sqrt(shades.length), { width, height } = ctx.canvas,
    image = ctx.getImageData(0, 0, width, height), pixels = image.data,
    dx = shape.width * 200 / width, dy = shape.height * 200 / height, { x: left = 0, y: bottom = 0 } = at ?? {},
    reflected = (value: number) => { const n = value % (size * 2); return n < size ? n : size * 2 - 1 - n; },
    columns = Array.from({ length: width }, (_, x) => reflected(Math.floor((left + x + .5) * dx)));
  for (let y = 0; y < height; y++) {
    const row = reflected(Math.floor((bottom + height - y - .5) * dy)) * size;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (!pixels[at + 3]!) continue;
      const shade = shades[row + columns[x]!]!;
      pixels[at]! *= shade; pixels[at + 1]! *= shade; pixels[at + 2]! *= shade;
    }
  }
  ctx.putImageData(image, 0, 0);
}

// One small, mipped repeat for native mineral polygons, shared by all sites or ruins.
export function mineralTexture(shades: Float32Array) {
  const size = 256, source = Math.sqrt(shades.length), data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = Math.floor((x < size / 2 ? x : size - 1 - x) * source / (size / 2)),
      v = Math.floor((y < size / 2 ? y : size - 1 - y) * source / (size / 2)),
      value = clamp(Math.round(248 + (shades[v * source + u]! - 1) * 800), 215, 255);
    data.set(([value, value, value, 255] as const), (y * size + x) * 4);
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: size, height: size,
    format: 'rgba8unorm', addressMode: 'repeat', scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true }) });
}
const MINERAL_SCALE = new Matrix().scale(1.6 / 256, 1.6 / 256);
export const mineralFill = (color: number, texture: Texture | null | undefined, matrix = MINERAL_SCALE) => texture ? { color, texture, textureSpace: 'global' as const, matrix } : color;

const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
function hash(x: number, y: number, seed: number) { let h = Math.imul(x + seed, 374761393) ^ Math.imul(y, 668265263); h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967295; }
function noise(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function fbm(x: number, y: number, seed: number) { return noise(x, y, seed) * 0.55 + noise(x * 2.15, y * 2.15, seed + 17) * 0.27 + noise(x * 4.9, y * 4.9, seed + 39) * 0.13 + noise(x * 10.2, y * 10.2, seed + 91) * 0.05; }

// Paint of each armour before shading: the four originals keep their tone.
const MATERIAL_TONES: Record<MaterialId, readonly [number, number, number]> = { steel: ([101, 117, 111] as const), aluminum: ([164, 179, 170] as const), ceramic: ([181, 167, 140] as const), concrete: ([143, 145, 129] as const),
  hha: ([80, 93, 101] as const), titanium: ([150, 156, 166] as const), fiberglass: ([171, 173, 124] as const), glass: ([126, 196, 204] as const) };
export function materialCanvas(material: MaterialId | undefined, concreteSurface?: Float32Array | null) {
  const c = canvas(512, 128), ctx = context2d(c), image = ctx.createImageData(c.width, c.height), random = new Random(7241);
  const metallic = !MATERIALS[material!]!?.brittle, glass = material === 'glass', laminate = material === 'fiberglass',
    base = MATERIAL_TONES[material!] || MATERIAL_TONES.concrete;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const n = fbm(x / 44, y / 25, 124), grain = random.range(-1, 1),
      top = 1 - Math.min(1, y / 8), bottom = 1 - Math.min(1, (c.height - 1 - y) / 7);
    let shade = .84 + n * .24 + grain * (metallic ? .025 : .04);
    if (metallic) {
      // A broad reflection and longitudinal grain read as worked metal without
      // repeating high-contrast stripes along every armour plate.
      shade += Math.exp(-(((y - 35) / 25) ** 2)) * .105 + (noise(x / 80, y / 1.8, 481) - .5) * .04;
      shade += top * .23 - bottom * .16;
      if (y === 1) shade += .12;
    } else if (glass) shade = .9 + n * .12 + top * .22 - bottom * .12;
    else shade += noise(x / 3, y / 3, 84) * .07 + top * .09 - bottom * .08;
    const i = (y * c.width + x) * 4;
    image.data[i] = clamp(base[0] * shade, 0, 255); image.data[i + 1] = clamp(base[1] * shade, 0, 255); image.data[i + 2] = clamp(base[2] * shade, 0, 255);
    // Glass lets the inside show through its middle and keeps a denser rim.
    image.data[i + 3] = glass ? 118 + 120 * Math.max(top, bottom) : 255;
  }
  ctx.putImageData(image, 0, 0);
  if (glass) {
    // Plies seen edge-on and a few slanted glints.
    for (const y of ([40, 66, 92] as const)) { ctx.fillStyle = 'rgba(226,250,250,.20)'; ctx.fillRect(0, y, 512, 1.2); }
    for (let i = 0; i < 9; i++) {
      const x = random.range(0, 512), reach = random.range(24, 70);
      ctx.strokeStyle = 'rgba(244,255,255,' + random.range(.10, .26) + ')'; ctx.lineWidth = random.range(1.5, 5);
      ctx.beginPath(); ctx.moveTo(x, 118); ctx.lineTo(x + reach, 10); ctx.stroke();
    }
  } else if (laminate) {
    // Woven plies: strata along the plate, crossed by the weft.
    for (let y = 9; y < 122; y += 9) { ctx.fillStyle = 'rgba(74,78,46,.30)'; ctx.fillRect(0, y, 512, 1); ctx.fillStyle = 'rgba(228,230,188,.13)'; ctx.fillRect(0, y + 1, 512, 1); }
    for (let x = 0; x < 512; x += 6) { ctx.fillStyle = 'rgba(70,74,44,' + random.range(.05, .16) + ')'; ctx.fillRect(x, 0, 1, 128); }
  } else if (metallic) {
    for (let i = 0; i < 56; i++) { ctx.strokeStyle = 'rgba(216,225,204,' + random.range(.025, .10) + ')'; ctx.lineWidth = random.range(.3, .7); ctx.beginPath(); const x = random.range(0, 512), y = random.range(5, 123); ctx.moveTo(x, y); ctx.lineTo(x + random.range(3, 64), y + random.range(-.6, .6)); ctx.stroke(); }
  } else {
    for (let i = 0; i < 200; i++) { ctx.fillStyle = random.next() > 0.5 ? '#c1bcb066' : '#454b4733'; ctx.beginPath(); ctx.ellipse(random.range(0, 512), random.range(0, 128), random.range(0.3, 1.9), random.range(0.4, 1.4), 0, 0, Math.PI * 2); ctx.fill(); }
  }
  if (material === 'concrete' && concreteSurface) paintSurface(ctx, concreteSurface, 512);
  return c;
}

export function paintDamage(ctx: ArtContext, marks: readonly ComponentDamageMark[], material: MaterialId | undefined, widthM = 1, heightM = .25) {
  paintComponentDamage(ctx, marks, widthM, heightM, Boolean(MATERIALS[material!]!?.brittle));
}

// Three cached stages of soot use the ordinary burn-stain painter. The same
// seeded patches grow between stages and remain after the flames stop.
export function paintComponentSoot(ctx: ArtContext, widthM: number, heightM: number, stage: number, id = '') {
  let seed=193;for(const letter of String(id))seed=(Math.imul(seed,31)+letter.charCodeAt(0))|0;
  const r=new Random(seed),marks=Array.from({length:3},()=>({kind:'burn',u:r.range(.2,.8),v:r.range(.25,.85),
    radius:Math.min(widthM,heightM)*(.15+.05*stage),strength:stage*.4}));
  ctx.save();ctx.globalAlpha=(ctx.globalAlpha??1)*(.18+.18*stage);
  paintComponentDamage(ctx,marks,widthM,heightM);ctx.restore();
}

export function paintComponentDamage(ctx: ArtContext, marks: readonly ComponentDamageMark[], widthM: number, heightM: number, brittle = false) {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  for (const mark of marks) {
    const x = clamp(mark.u, 0, 1) * width, y = clamp(mark.v, 0, 1) * height;
    const radius = Number(mark.radius) > 0 ? Math.max(.65, mark.radius! / widthM * width) : clamp((mark.radiusU || 0.025) * width, 1.2, width * 0.2);
    const aspect = widthM / heightM * height / width;
    const strength = clamp(mark.strength || 0.3, 0.05, 3);
    const random = new Random(Math.round(mark.u * 91471 + mark.v * 81797));
    ctx.save(); ctx.translate(x, y); ctx.scale(1, aspect);
    if (Number(mark.depth) > 0 && Number(mark.radius) > 0) {
      // A dent shades the actual thinning depth and contact footprint. It never
      // erases texture alpha or creates an opening outside the clipped regions.
      ctx.rotate(Math.atan2(-(mark.dy ?? -1), mark.dx ?? 0));
      ctx.scale(clamp(mark.depth! / mark.radius!, .015, 1), 1);
      ctx.globalAlpha = (ctx.globalAlpha ?? 1) * clamp(.3 + mark.depth! / heightM * 2, .3, .85);
    } else if (mark.kind === 'ricochet') {
      ctx.rotate(Math.atan2(-(mark.dy ?? 0), mark.dx ?? 1));
    }
    // The measured radius bounds the worked surface. Only a faint feather of
    // dust extends beyond it; a broad dark disk would suggest swollen metal.
    const burned = mark.kind === 'burn', scraped = mark.kind === 'ricochet',
      outer = radius * (burned ? 1.5 : 1.18);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, outer);
    halo.addColorStop(0, burned ? '#3a382c70' : '#38443524');
    halo.addColorStop(.55, burned ? '#3c3b303b' : '#36433210'); halo.addColorStop(1, '#36433200');
    ctx.fillStyle = halo; ctx.fillRect(-outer, -outer, outer * 2, outer * 2);
    const phase = random.range(0, Math.PI * 2), phase2 = random.range(0, Math.PI * 2),
      phase3 = random.range(0, Math.PI * 2), contour: XY[] = [];
    for (let i = 0; i < 48; i++) {
      const angle = i * Math.PI / 24,
        edge = .875 + Math.sin(angle * 3 + phase) * .060 + Math.sin(angle * 5 + phase2) * .035 + Math.sin(angle * 7 + phase3) * .018;
      contour.push(([Math.cos(angle) * radius * edge, Math.sin(angle) * radius * edge * (scraped ? .34 : 1)] as const));
    }
    const outline = (start = 0, end = 48, closed = false) => {
      ctx.beginPath();
      for (let i = start; i < end; i++) {
        const p = contour[i % 48]!; i === start ? ctx.moveTo(...p) : ctx.lineTo(...p);
      }
      if (closed) ctx.closePath();
    };
    if (burned) {
      // Soot has a feathered stain and uneven deposit, without a hard rim or
      // black aperture. Existing material remains opaque underneath the paint.
      ctx.fillStyle = '#35372bc2'; outline(0, 48, true); ctx.fill();
      for (let i = 0; i < 7; i++) {
        const x = random.range(-.6, .6) * radius, y = random.range(-.6, .6) * radius,
          r = random.range(.15, .32) * radius,
          deposit = ctx.createRadialGradient(x, y, 0, x, y, r);
        deposit.addColorStop(0, '#68654c2a'); deposit.addColorStop(1, '#68654c00');
        ctx.fillStyle = deposit; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    } else {
      // A mostly planar patch of abraded metal replaces the old radial bevel.
      // The short, broken lower glints indicate a depression rather than a ball.
      const face = ctx.createLinearGradient ? ctx.createLinearGradient(0, -radius, radius * .28, radius) :
        ctx.createRadialGradient(0, -radius, 0, 0, radius, radius * 2);
      face.addColorStop(0, '#303830d9'); face.addColorStop(.28, '#677064d6');
      face.addColorStop(.65, '#b8b9a5db'); face.addColorStop(1, '#788371b8');
      ctx.fillStyle = face; outline(0, 48, true); ctx.fill();
      if (mark.kind === 'hole') {
        // A dark core belongs only to a reported perforation. The material's
        // clipped regions still own the opening; this paint never erases alpha.
        ctx.save(); ctx.scale(.46, .46); ctx.fillStyle = '#171b16e6';
        outline(0, 48, true); ctx.fill(); ctx.restore();
      }
      ctx.strokeStyle = '#1e281eb8'; ctx.lineWidth = Math.max(.35, radius * .020);
      outline(27, 35); ctx.stroke(); outline(37, 42); ctx.stroke();
      ctx.strokeStyle = '#e2dfc3bd'; ctx.lineWidth = Math.max(.30, radius * .016);
      outline(4, 10); ctx.stroke(); outline(13, 17); ctx.stroke();
      const scratches = scraped ? 8 : 3 + Math.floor(strength);
      for (let i = 0; i < scratches; i++) {
        const y = random.range(-.52, .52) * radius * (scraped ? .34 : 1),
          start = random.range(-.69, -.10) * radius, end = Math.min(radius * .70, start + random.range(.25, .80) * radius);
        ctx.strokeStyle = i % 3 ? '#d0d0b58c' : '#263327a0'; ctx.lineWidth = Math.max(.24, radius * .012);
        ctx.beginPath(); ctx.moveTo(start, y); ctx.lineTo(end, y + random.range(-.035, .035) * radius); ctx.stroke();
      }
      if (brittle) for (let i = 0; i < 6; i++) {
        const angle = random.range(0, Math.PI * 2), mid = radius * random.range(.97, 1.10), end = radius * random.range(1.12, 1.28);
        ctx.strokeStyle = '#34413084'; ctx.lineWidth = Math.max(.28, radius * .013); ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * radius * .82, Math.sin(angle) * radius * .82);
        ctx.lineTo(Math.cos(angle + .04) * mid, Math.sin(angle + .04) * mid);
        ctx.lineTo(Math.cos(angle - .035) * end, Math.sin(angle - .035) * end); ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// Small persistent decals share the component-damage painter and texture cache.
// UV-seeded variants give each impact a stable silhouette without per-frame art.
export function createBodyImpactTexture(kind: string, variant: number) {
  // 192 px keeps the broken edge smooth at inspection zoom. The handful of
  // kind/variant textures are persistent and created once, never during motion.
  const size = 192, c = canvas(size, size), ctx = context2d(c),
    mark = { u: .5 + variant * .013, v: .5 - variant * .009,
      radiusU: .16, kind, strength: 1 };
  ctx.translate(size / 2 - mark.u * size, size / 2 - mark.v * size);
  paintComponentDamage(ctx, ([mark] as const), 1, 1);
  return textureFromCanvas(c);
}

// The picture of the particles of the effects (effects.ts), a tile of `PARTICLE_TILE` pixels for each look of each kind;
// the jet of a thruster (effects.ts `ThrusterJets`) is drawn with the four after the flames, three of its plume and one
// of its core.
const PARTICLE_TILE = 128;
// Two 64x128 flame frames occupy each old square slot: the image has always
// used only its middle 52 pixels. All 64 source frames fit the same GPU atlas.
const FLAME_TILES = Array.from({length:FLAME_FRAMES * FLAME_VARIANTS},(_,i)=>{const cell=Math.floor(i/2);return cell<4?16+cell:20+cell;}),
  JET_TILE = 20 + FLAME_FRAMES * FLAME_VARIANTS/2, DENSE_TILE = JET_TILE + 4, PARTICLE_TILES = DENSE_TILE + 4;
// Keep the original tile coordinates, but omit transparent margins from smoke
// geometry. One clear texel remains around every visible texel for linear sampling.
function smokeTrim(pixels: Uint8ClampedArray, size: number) {
  let left = size, top = size, right = -1, bottom = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (pixels[(y * size + x) * 4 + 3]) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  left = Math.max(0, left - 1); top = Math.max(0, top - 1);
  right = Math.min(size - 1, right + 1); bottom = Math.min(size - 1, bottom + 1);
  return new Rectangle(left, top, right - left + 1, bottom - top + 1);
}
export function paintParticleAtlas(flames: CanvasImageSource | null = null, smokeTrims?: Map<number, Rectangle>) {
  const size = PARTICLE_TILE, c = canvas(size * 4, size * Math.ceil(PARTICLE_TILES / 4)), ctx = context2d(c),
    tiles: (readonly [number, EffectKind, number])[] = [...Array.from({ length: 8 }, (_, variant) => [variant, 'smoke', variant] as const),
      ...Array.from({ length: 4 }, (_, variant) => [8 + variant, 'fire', variant] as const),
      ...FLAME_TILES.map((tile,variant)=>[tile,'flame',variant] as const), [20, 'shockwave', 0],
      [14, 'dust', 0], [15, 'muzzle', 0], [21, 'flash', 0], [22, 'muzzle', 1], [23, 'muzzle', 2],
      ...Array.from({ length: 3 }, (_, variant) => [JET_TILE + variant, 'plume', variant] as const), [JET_TILE + 3, 'jetcore', 0],
      ...Array.from({ length: 4 }, (_, variant) => [DENSE_TILE + variant, 'dense-smoke', variant] as const)];
  const scratch=flames?null:canvas(size,size),scratchCtx=(scratch ? context2d(scratch) : null);
  for (const [tile, kind, variant] of tiles) {
    const flame=kind==='flame',width=flame?size/2:size,x=tile%4*size+(flame?variant%2*width:0),y=Math.floor(tile/4)*size;
    if(flame&&flames){ctx.drawImage(flames,variant%8*width,Math.floor(variant/8)*size,width,size,x,y,width,size);continue;}
    const image = ctx.createImageData(size, size);
    image.data.set(effectTilePixels(kind, variant, size));
    // Read the pixels already painted in memory; no canvas/GPU readback.
    if (smokeTrims && (kind === 'smoke' || kind === 'dense-smoke')) smokeTrims.set(tile, smokeTrim(image.data, size));
    if(flame){scratchCtx!.putImageData(image,0,0);ctx.drawImage(scratch!,0,0,size,size,x,y,width,size);}
    else ctx.putImageData(image, x, y);
  }
  const offset = (tile: number) => { ctx.save(); ctx.translate(tile % 4 * size, Math.floor(tile / 4) * size); };
  offset(12); let g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, '#ffffff'); g.addColorStop(0.2, '#ffffffaa'); g.addColorStop(0.55, '#ffffff30'); g.addColorStop(1, '#ffffff00'); ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128); ctx.restore();
  offset(13); g = ctx.createLinearGradient(0, 64, 128, 64); g.addColorStop(0, '#ffffff00'); g.addColorStop(0.7, '#ffffff88'); g.addColorStop(0.91, '#ffffffff'); g.addColorStop(1, '#ffffff00'); ctx.fillStyle = g; ctx.fillRect(0, 56, 128, 16); ctx.restore();
  return c;
}
export function createParticleAtlas(flames: CanvasImageSource | null = null) {
  const size = PARTICLE_TILE, trims = new Map<number, Rectangle>(), source = textureFromCanvas(paintParticleAtlas(flames, trims)).source;
  const textures = Array.from({ length: PARTICLE_TILES }, (_, tile) => {
    if (FLAME_TILES.includes(tile)) return null;
    const trim = trims.get(tile), x = tile % 4 * size, y = Math.floor(tile / 4) * size;
    return trim ? new Texture({ source, frame: new Rectangle(x + trim.x, y + trim.y, trim.width, trim.height),
      orig: new Rectangle(0, 0, size, size), trim }) : new Texture({ source, frame: new Rectangle(x, y, size, size) });
  });
  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => textures[from + i]!);
  return { smoke: range(0, 8), denseSmoke: range(DENSE_TILE, 4), fire: range(8, 4),
    flame: FLAME_TILES.map((tile,i)=>new Texture({source,frame:new Rectangle(tile%4*size+i%2*size/2,Math.floor(tile/4)*size,size/2,size)})),shockwave: textures[20]!,
    glow: textures[12]!, spark: textures[13]!, dust: textures[14]!, muzzle: textures[15]!,
    jet: ([textures[15]!, textures[22]!, textures[23]!] as const), flash: textures[21]!, plume: range(JET_TILE, 3), jetcore: textures[JET_TILE + 3]! };
}

// The picture of a piece is painted for the closest view and mostly shown many times smaller, its fins, grilles
// and bolts finer than a pixel of the screen. With `mipmaps` the GPU keeps it halved level by level, made anew
// from the canvas on every upload, and reads between the two levels nearest the size it is shown at: fine work
// fades into its tone instead of crawling as moiré while the piece moves or turns.
export function pieceTexture<C extends ArtCanvas>(picture: C, { mipmaps = true, dynamic = false } = {}): PieceTexture<C> {
  const source = Object.assign(new CanvasSource({ resource: picture, scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: mipmaps }), { resource: picture });
  return new Texture({ dynamic, source });
}

// A texture painted once for the whole game takes its picture painted anew, on a canvas of its own (Renderer.repaint):
// what shows it, or a tile of it, goes on showing it, and it is uploaded again from the new canvas.
export function repaintTexture(texture: PieceTexture, picture: ArtCanvas) {
  texture.source.resource = picture; texture.source.update();
}

export function resizePicture(source: CanvasSource, width: number, height: number) {
  if (source.width === width && source.height === height) return;
  // Pixi chooses the mipmap count on first upload, not on canvas resize.
  // Keep the source and its users, but allocate GPU storage at the new size.
  source.unload(); source.resize(width, height);
}

export const FRAME_SURFACE_KINDS = new Set(['engine', 'hopper', 'cistern', 'supply', 'excavator', 'drill', 'builder', 'blade', 'paver', 'thruster']);
// Where a part of a road machine painted on its own (machine-art.ts `paintMachine`, its `crop`) is in the picture of its
// whole box, as `paintSurfaceMetres` takes it. Both pictures use canonical coordinates.
function cropGrain(crop: MachineCrop, height: number) {
  const perMetre = machineFineness(crop.W, crop.H);
  return { x: crop.x * perMetre,
    y: Math.round(crop.H * perMetre) - crop.y * perMetre - height };
}
// The same painter serves the workshop and the field's background worker.
export function paintModuleCanvas(kind: ModuleKind, width = 5.04, height = 0.74, options: ModuleTextureOptions = {}) {
  const trackPixels = Math.max(1024, Math.min(3072, Math.ceil(width * 200 / 128) * 128));
  // A piece that carries a load and one of machine-art.ts are painted as long and as tall as they are.
  const textureCanvas = holdsCargo({ kind }) ? canvas(...cargoCanvasSize(width, height)) : MACHINE_KINDS.has(kind) ? canvas(...machineCanvas(width, height, options.crop))
    : canvas(kind === 'track' ? trackPixels : 400, kind === 'track' ? Math.max(48, Math.round(trackPixels * height / width)) : kind === 'fuel' ? clamp(Math.round(400 * height / width), 128, 1024) : kind === 'wheel' ? 400 : 260);
  const ctx = context2d(textureCanvas);
  const finish = paintComponent(ctx, kind, width, height, options);
  if (!options.overlay && (kind === 'track' || kind === 'wheel' && ['road', 'sprocket', 'idler', 'roller'].includes(options.style!)))
    paintTrackSurface(ctx, options.trackSurfaces, kind === 'track' ? 'track' : options.style, width, height);
  // A piece of another metal than steel shows the tone of it; one in the paint of its construction (cargo-art.ts), the paint.
  if (options.paint === undefined) paintMetal(ctx, metalOf(options).look,
    kind === 'wheel' && !options.style ? textureCanvas.width * .305 : undefined);
  if (kind === 'wheel' && !options.style && Number(options.armorMm) > 0)
    paintComponent(ctx, kind, width, height, { ...options, style: 'guard' });
  if (kind === 'wheel' && !options.style && options.wheelSurface) paintSurface(ctx, options.wheelSurface);
  if ((kind === 'fuel' || kind === 'command') && options.moduleSurface) paintSurface(ctx, options.moduleSurface, 512);
  if (FRAME_SURFACE_KINDS.has(kind) && options.frameSurface)
    paintSurfaceMetres(ctx, options.frameSurface, { width, height }, options.crop && cropGrain(options.crop, textureCanvas.height));
  if (kind === 'sensor' && options.sensorMode === 'radar' && options.radarSurface)
    paintSurfaceMetres(ctx, options.radarSurface, { width, height });
  finish?.();
  return textureCanvas;
}
// The temporary picture has one colour. Meshes supply a component's shape;
// a hull sprite needs its polygon's transparent surroundings as well, and a
// chassis in parts between its gaps each of its outlines.
export function previewCanvas(options: PreviewTextureOptions = {}, shape: PreviewTextureShape | null | undefined = null) {
  const c = canvas(64, 48), ctx = context2d(c);
  let tone: number;
  if (paintedPreview(options)) tone = options.paint;
  else tone = options.material
    ? (MATERIAL_TONES[options.material] || MATERIAL_TONES.concrete).reduce((rgb, channel) => rgb * 256 + channel, 0)
    : metalColor(STEEL_PAINT, metalOf(options).look);
  // Glass keeps its centre's alpha (118/255) while the detailed picture arrives.
  ctx.fillStyle = '#' + tone.toString(16).padStart(6, '0') + (options.material === 'glass' ? '76' : '');
  if (shape) {
    ctx.save();
    ctx.setTransform(c.width / shape.width, 0, 0, -c.height / shape.height, 0, c.height);
    ctx.beginPath();
    for (const points of shape.outlines ?? ([shape.points] as const)) { points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); }
    ctx.fill();
    ctx.restore();
  } else ctx.fillRect(0, 0, c.width, c.height);
  return c;
}
