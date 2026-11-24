import { materialCanvas, paintModuleCanvas, previewCanvas } from './textures.ts';
import { paintHullCanvas, hullBaseTone, paintAuthoredDetails } from './hull-art.ts';
import { paintChassisCanvas, paintGuardCanvas } from './chassis-art.ts';
import { fenderLine } from './hull-details.ts';
import { paintMainLight } from './main-light.ts';
import type { ArtCanvas, XY } from './canvas-art.ts';
import type { HullArtwork, HullLayout, HullSurfaces } from './hull-art.ts';
import type { ModuleTextureOptions, PreviewTextureShape, TrackSurfaces } from './textures.ts';
import type { WeatheringMaps } from './weathering.ts';
import type { MaterialId, MetalId, ModuleKind } from './materials.ts';
export interface TextureMaterials {
  hullSurfaces?: HullSurfaces | null | undefined; frameSurface?: Float32Array | null | undefined;
  wheelSurface?: Float32Array | null | undefined; trackSurfaces?: TrackSurfaces | null | undefined;
  radarSurface?: Float32Array | null | undefined; weathering?: WeatheringMaps | null | undefined;
}
interface RequestBase { options: ModuleTextureOptions; layout?: never; shape?: PreviewTextureShape | null; kind?: never; width?: never; height?: never }
type PaintedHull = Omit<RequestBase, 'shape' | 'layout' | 'options'> & { type: 'hull'; shape: HullArtwork; layout: HullLayout; options: ModuleTextureOptions & { paint: number } };
type PaintedChassis = Omit<RequestBase, 'shape' | 'options'> & { type: 'chassis'; shape: Parameters<typeof paintChassisCanvas>[0]; options: ModuleTextureOptions & { paint: number } };
type PaintedGuard = Omit<RequestBase, 'shape' | 'options'> & { type: 'guard'; shape: Parameters<typeof paintGuardCanvas>[0] & { key: string }; options: Omit<ModuleTextureOptions, 'metal'> & { paint: number; metal?: MaterialId | MetalId | undefined } };
type PaintedModule = Omit<RequestBase, 'kind' | 'width' | 'height'> & { type: 'module'; kind: ModuleKind; width: number; height: number };
type PaintedMaterial = Omit<RequestBase, 'options'> & { type: 'material'; options: ModuleTextureOptions & { material: MaterialId | undefined } };
export type TexturePaintRequest = PaintedHull | PaintedChassis | PaintedGuard | PaintedModule | PaintedMaterial;


// The same normalized outlines supply the small canvas and a held edit's solid rim: one for each part of a chassis
// between its gaps, the first of them its `points`.
// A mudguard is a band, not a filled wheel well. Its two open lines close at the feet.
type TextureShape = Pick<PaintedChassis, 'type' | 'shape'> | Pick<PaintedGuard, 'type' | 'shape'> | Pick<Exclude<TexturePaintRequest, PaintedChassis | PaintedGuard>, 'type' | 'shape'>;
export function texturePreviewShape(request: Pick<PaintedChassis, 'type' | 'shape'> | Pick<PaintedGuard, 'type' | 'shape'>): PreviewTextureShape;
export function texturePreviewShape(request: TextureShape): PreviewTextureShape | null | undefined;
export function texturePreviewShape({ type, shape }: TextureShape): PreviewTextureShape | null | undefined {
  if (type !== 'chassis' && type !== 'guard') return shape;
  const guard = type === 'guard', width = guard ? shape.w : shape.width, height = guard ? shape.h : shape.height,
    left = guard ? shape.x - width / 2 : shape.left, bottom = guard ? shape.y - height / 2 : shape.top - height;
  let outlines: (readonly XY[])[];
  if (!guard) outlines = (shape.layout.decks ?? shape.layout.outlines).map(outline => outline.map(p => [p.x, p.y] as const));
  else if (shape.kind === 'skirt') outlines = [shape.points];
  else {
    const line = (off: number) => fenderLine(shape.inner + off, shape.feet, shape.round + off, shape.half)
      .map(([u, v]) => [shape.axle.x + u, shape.axle.y + v] as const);
    outlines = [[...line(shape.outer - shape.inner), ...line(0).reverse()]];
  }
  const laid = outlines.map(points => points.map(([x, y]) => ({ x: x - left, y: y - bottom })));
  return { left, bottom, width, height, contour: shape.key, points: laid[0]!, outlines: laid };
}

export function previewTextureCanvas(request: TexturePaintRequest) {
  if (request.type === 'guard') return previewCanvas(request.options, texturePreviewShape(request));
  const { type, layout, options } = request, paint = type === 'hull' && layout.cast
    ? hullBaseTone(options.paint, true).reduce((rgb, v) => rgb * 256 + Math.round(v), 0) : options.paint;
  return previewCanvas(paint === options.paint ? options : { ...options, paint }, texturePreviewShape(request));
}

// The worker and the synchronous fallback paint the same serializable request.
// Materials belong to setup, not to each description or its cache key.
export function paintTextureCanvas(request: TexturePaintRequest, materials: TextureMaterials): ArtCanvas {
  const { type, options, shape, layout, kind, width, height } = request;
  if (type === 'material') return materialCanvas(options.material, materials.hullSurfaces?.concrete);
  let painted;
  if (type === 'hull') painted = paintHullCanvas(shape, options.paint, layout, materials.hullSurfaces, materials.weathering);
  else if (type === 'chassis') painted = paintChassisCanvas(shape, options.paint, materials.frameSurface, materials.weathering);
  else if (type === 'guard') painted = paintGuardCanvas(shape, options.paint, materials.frameSurface, materials.weathering, options.metal);
  else if (type === 'module') painted = paintModuleCanvas(kind, width, height,
    { ...options, ...materials, moduleSurface: materials.hullSurfaces?.outside });
  else throw Error('Unknown texture painting: ' + type);
  if (type === 'hull' && shape.side === 'outside') paintAuthoredDetails(painted,
    { ...shape, letteringMirror: options.letteringMirror, polygon: shape.points.map(p => ({ x: p.x + shape.left, y: p.y + shape.bottom })) }, layout.details, options.paint, materials.weathering);
  else if (type === 'chassis') paintAuthoredDetails(painted,
    { left: shape.left, bottom: shape.top - shape.height, width: shape.width, height: shape.height, letteringMirror: options.letteringMirror }, options.details, options.paint, materials.weathering);
  else if (type === 'module') paintAuthoredDetails(painted,
    { left: options.crop ? -options.crop.W / 2 + options.crop.x : -width / 2,
      bottom: options.crop ? options.crop.H / 2 - options.crop.y - height : -height / 2, width, height, letteringMirror: options.letteringMirror },
    options.details, options.paint ?? 0x68765a, materials.weathering);
  return type === 'hull' && shape.side === 'inside' || type === 'module' && (kind === 'wheel' || kind === 'track')
    ? painted : paintMainLight(painted);
}
