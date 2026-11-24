import { tr } from './i18n.ts';
import { escapeHTML } from './dom-view.ts';
import { plateCorners, localToWorld } from './math.ts';
import { gridRegions } from './armor-grid.ts';
import { componentPolygon, isRunningGear } from './assembly.ts';
import { installedWeaponShapes } from './weapon-art.ts';
import { weaponAngle, mountedWeaponPolygons } from './weapon-geometry.ts';
import { within } from './hull-details.ts';
import { trackWheels, TRACK_BELT } from './running-gear.ts';
import type { Point, PlateGeometry } from './math.ts';
import type { MaterialGrid } from './armor-grid.ts';
import type { ComponentGeometry } from './assembly.ts';
import type { WeaponMountProjection } from './construction-contract.ts';
import type { ModuleKind } from './materials.ts';

interface PreviewPlate extends PlateGeometry { id: string; ballisticGrid?: MaterialGrid; chassis?: object }
type PreviewModule = ComponentGeometry & { id: string; exposed?: boolean; weaponMount?: WeaponMountProjection | null | undefined };
export interface PreviewConstruction {
  plates: readonly PreviewPlate[]; modules: readonly PreviewModule[];
  bodyPanels: readonly { poly: readonly Point[] }[];
  chassis?: { outlines: readonly (readonly Point[])[] } | null | undefined;
  appearance: { paint: string };
}
interface PicturePiece { poly: readonly Point[]; fill: string | undefined; stroke?: string }
interface PictureShapes { chassis: readonly (readonly Point[])[]; pieces: PicturePiece[]; gunShapes: PicturePiece[] }
const MODULE_COLORS: Partial<Record<ModuleKind, string>> = { sensor: '#527c84', command: '#4e8073', track: '#283b30', wheel: '#344937', engine: '#53655c', fuel: '#948d64', ammo: '#b4a676', weapon: '#596a50', excavator: '#a49a67', drill: '#8d9792', builder: '#a99760', blade: '#a38f48', paver: '#7d7660', thruster: '#8e918c' };

// The outline of each plate as it stands: of one shot through, each part of it that is left.
const plateOutlines = (plates: readonly PreviewPlate[]): Point[][] => plates.flatMap(p => p.ballisticGrid ? gridRegions(p.ballisticGrid).map(region =>
  [[region.minX, region.minY], [region.maxX, region.minY], [region.maxX, region.maxY], [region.minX, region.maxY]]
    .map(([x, y]) => localToWorld(p, x!, y!))) : [plateCorners(p)]);
// The shapes of a gun as it is laid: a mounted one keeps what stands fixed on its host's axis, and the rest along its barrel.
function gunShapes(m: PreviewModule): PicturePiece[] {
  const posed = mountedWeaponPolygons(m);
  return installedWeaponShapes(m).map((shape, index) => {
    // Both views preserve the same Native material role order.
    if (posed) return { poly: posed[index]!, fill: shape.color };
    const angle = weaponAngle(m), c = Math.cos(angle), s = Math.sin(angle), poly: Point[] = [];
    for (let i = 0; i < shape.points.length; i += 2) poly.push({ x: m.x + shape.points[i]! * c - shape.points[i + 1]! * s, y: m.y + shape.points[i]! * s + shape.points[i + 1]! * c });
    return { poly, fill: shape.color };
  });
}
// The bodies a design shows from outside: its plates close them.
const bodyFaces = (blueprint: PreviewConstruction) => blueprint.plates.length >= 3 ? blueprint.bodyPanels.map(face => face.poly) : [];

// What a picture of a design is drawn of, from the side: the chassis under it all, its body, its pieces and plates — the
// running gear after them — and its guns.
function pictureShapes(blueprint: PreviewConstruction) {
  const plates = plateOutlines(blueprint.plates).map(poly => ({ poly, fill: '#839080', stroke: '#d4d4b6' }));
  const modules = blueprint.modules.map(m => ({ kind: m.kind, poly: componentPolygon(m), fill: MODULE_COLORS[m.kind], stroke: '#263a2f' }));
  // The chassis under it all, as its outlines are from the side, one for each part between gaps: the rail of a wheeled
  // one, the tub of a tracked one.
  const chassis = blueprint.chassis?.outlines || [];
  const pieces = [...modules.filter(m => !isRunningGear(m)), ...plates, ...modules.filter(isRunningGear)];
  return { chassis, faces: bodyFaces(blueprint), pieces, gunShapes: blueprint.modules.filter(m => m.kind === 'weapon').flatMap(gunShapes) };
}

function pictureBounds({ chassis, pieces, gunShapes }: PictureShapes) {
  const points = [...pieces, ...gunShapes].flatMap(p => p.poly).concat(chassis.flat());
  if (!points.length) return null;
  const minX = Math.min(...points.map(p => p.x)) - 0.7, maxX = Math.max(...points.map(p => p.x)) + 0.7;
  const minY = Math.min(...points.map(p => p.y)) - 0.15, maxY = Math.max(...points.map(p => p.y)) + 0.35;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

// The same box as the card's SVG, for the field's validity border without serializing a picture.
export function constructionBounds(blueprint: PreviewConstruction) {
  const bounds = pictureBounds(pictureShapes(blueprint));
  return bounds ? { x: bounds.minX, y: -bounds.maxY, width: bounds.width, height: bounds.height } : { x: 0, y: 0, width: 300, height: 120 };
}

export function constructionSVG(blueprint: PreviewConstruction) {
  const shapes = pictureShapes(blueprint), { chassis, faces, pieces, gunShapes } = shapes, bounds = pictureBounds(shapes);
  if (!bounds) return ("<svg viewBox=\"0 0 300 120\" aria-hidden=\"true\"><path d=\"M120 60h60m-30-30v60\" stroke=\"#718769\" stroke-width=\"2\"/><text x=\"150\" y=\"110\" text-anchor=\"middle\" fill=\"#94a687\" font-size=\"10\">" + tr("ESPAÇO PARA CONSTRUIR") + "</text></svg>");
  const { minX, maxX, minY, maxY, width, height } = bounds;
  const svgPoly = (poly: readonly Point[], fill: string | undefined, stroke = '') => `<polygon points="${poly.map(p => `${p.x},${-p.y}`).join(' ')}" fill="${escapeHTML(fill)}"${stroke ? ` stroke="${escapeHTML(stroke)}" stroke-width="0.017"` : ''}/>`;
  let content = chassis.map(outline => svgPoly(outline, '#3b463c', '#263a2f')).join('');
  for (const face of faces) content += svgPoly(face, blueprint.appearance.paint);
  content += pieces.map(p => svgPoly(p.poly, p.fill, p.stroke)).join('');
  content += gunShapes.map(shape => svgPoly(shape.poly, shape.fill)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${-maxY} ${width} ${height}" aria-hidden="true">${content}<path d="M${minX} ${-minY}H${maxX}" stroke="#5e6b54" stroke-width="0.018"/></svg>`;
}

// The mark of a design in the column of the field (squad-ux.ts), made to tell one design from another at the size of a
// button: what is seen of it from outside, from the side, in one colour. Each part that makes its shape is a shape of its
// own, with a fine gap round it where it lies over another: the chassis; each gun, never thinner than `THINNEST`, under the
// hull it goes out of; the hull its plates close; and each piece that stands out of the hull — a sensor, a body carried in
// the open, a tool. What is within the hull is not seen. Its running gear is in a paler tone (`GEAR`) with its wheels in
// the full one: a hub in each tyre, and along a track its road wheels, its sprocket and its idler.
//
// `damage` is how damaged each piece of it is, by its id, of those that are (part-view.ts `damageTone`): each part is drawn
// in the layer of the worst of its pieces — the chassis in that of its plates —, a plate of the hull as a line along it over
// the hull, never thinner than `EDGE`, and a piece within the hull over the hull, where nothing stands out of it.
//
// It fills a box `width` × `height` pixels as far as its shape lets it, in pixels to the hundredth, and the same box
// whatever is damaged. Each layer (`LAYERS`) is the mask of a colour: white where what is drawn in it shows, so that a gap
// shows what is behind it; nothing where none of it is. A design with nothing in it has none.
const GAP = .6, THINNEST = .8, EDGE = 1.2, GEAR = '#666', HUB = .55;
const LAYERS = Object.freeze({ whole: '', hurt: 'hurt', lost: 'lost' });
type DamageTone = typeof LAYERS[keyof typeof LAYERS];
interface SilhouetteOptions { width?: number; height?: number; damage?: Readonly<Record<string, DamageTone>> }
interface SilhouetteDisc extends Point { r: number }
interface PartInk { shade?: string | undefined; damage?: DamageTone; over?: boolean; d?: string }
type SilhouettePart = PartInk & (
  { polys: readonly (readonly Point[])[]; thin?: boolean; discs?: never; lines?: never; thickness?: never } |
  { discs: SilhouetteDisc[]; polys?: never; thin?: never; lines?: never; thickness?: never } |
  { lines: [Point, Point][]; thickness: number; polys?: never; thin?: never; discs?: never }
);
export function constructionSilhouette(blueprint: PreviewConstruction, { width = 54, height = 25, damage = {} }: SilhouetteOptions = {}) {
  const faces = bodyFaces(blueprint), outside = (m: PreviewModule) => m.exposed || !faces.some(face => within(m, face)),
    tone = (piece: { id: string }): DamageTone => damage[piece.id] || '', worst = (pieces: readonly { id: string }[]): DamageTone => pieces.map(tone).reduce<DamageTone>((a, b) => a === 'lost' || b === 'lost' ? 'lost' : a || b, ''),
    disc = (x: number, y: number, r: number, shade: string | undefined, hurt: DamageTone): SilhouettePart => ({ discs: [{ x, y, r }], shade, damage: hurt }),
    frame = blueprint.plates.filter(p => p.chassis), hull = blueprint.plates.filter(p => !p.chassis),
    inner = (m: PreviewModule) => m.kind !== 'weapon' && !isRunningGear(m) && !outside(m);
  // The parts in the order they are drawn, each over those before it: its outlines, its discs or its lines, its tone and
  // its layer. What is drawn of its damage alone is drawn over the hull, under what stands out of it.
  const candidates: SilhouettePart[] = [
    { polys: [...(blueprint.chassis?.outlines || []), ...plateOutlines(frame)], damage: worst(frame) },
    ...blueprint.modules.filter(m => m.kind === 'weapon').map(m => ({ polys: gunShapes(m).map(shape => shape.poly), thin: true, damage: tone(m) })),
    { polys: [...faces, ...plateOutlines(hull)] },
    ...hull.filter(tone).map((p): SilhouettePart => ({ lines: [[localToWorld(p, -p.length / 2, 0), localToWorld(p, p.length / 2, 0)]], thickness: p.thicknessMm / 1000, damage: tone(p), over: true })),
    ...blueprint.modules.filter(m => tone(m) && inner(m)).map(m => ({ polys: [componentPolygon(m)], damage: tone(m), over: true })),
    ...blueprint.modules.filter(m => m.kind !== 'weapon' && !isRunningGear(m) && outside(m)).map(m => ({ polys: [componentPolygon(m)], damage: tone(m) })),
    ...blueprint.modules.filter(isRunningGear).flatMap(m => {
      if (m.kind === 'wheel') return [disc(m.x, m.y, m.height / 2, GEAR, tone(m)), disc(m.x, m.y, m.height / 2 * HUB, undefined, tone(m))];
      const { radius, end, road, low } = trackWheels(m.width, m.height), r = radius - TRACK_BELT * m.height,
        c = Math.cos(m.angle || 0), s = Math.sin(m.angle || 0);
      return [{ polys: [componentPolygon(m)], shade: GEAR, damage: tone(m) },
        ...[{ x: -end.x, y: end.y }, ...road.map(x => ({ x, y: low })), end].map(p => disc(m.x + c * p.x - s * p.y, m.y + s * p.x + c * p.y, r, undefined, tone(m)))];
    }),
  ];
  const parts = candidates.map(part => ({ ...part, polys: (part.polys || []).filter(poly => poly.length >= 3), damage: part.damage || '' }))
    .filter(part => part.polys.length || part.discs || part.lines);
  const points = parts.filter(part => !part.over)
    .flatMap(part => [...part.polys.flat(), ...(part.discs || []).flatMap(d => [{ x: d.x - d.r, y: d.y - d.r }, { x: d.x + d.r, y: d.y + d.r }])]);
  if (!points.length) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y), minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys),
    scale = Math.min((width - 2 * GAP) / Math.max(maxX - minX, 1e-6), (height - 2 * GAP) / Math.max(maxY - minY, 1e-6)),
    left = (width - (maxX - minX) * scale) / 2, top = (height - (maxY - minY) * scale) / 2,
    n = (value: number) => Math.round(value * 100) / 100, X = (x: number) => n(left + (x - minX) * scale), Y = (y: number) => n(top + (maxY - y) * scale);
  for (const part of parts) part.d = part.lines ? part.lines.map(([a, b]) => `M${X(a.x)} ${Y(a.y)}L${X(b.x)} ${Y(b.y)}`).join('') : part.polys.map(poly => {
    // Every outline goes the same way round, so that where those of one part overlap they fill as one.
    const area = poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]!; return sum + p.x * q.y - q.x * p.y; }, 0), at: [number, number][] = [];
    for (const p of area < 0 ? [...poly].reverse() : poly) {
      const x = X(p.x), y = Y(p.y), last = at.at(-1);
      if (!last || last[0] !== x || last[1] !== y) at.push([x, y]);
    }
    return at.length >= 3 ? 'M' + at.map(([x, y]) => x + ' ' + y).join('L') + 'Z' : '';
  }).join('');
  // In a layer, what is drawn in another is black: it cuts what is under it, and its gap with it.
  const drawn = (layer: DamageTone) => parts.map(part => {
    const lit = part.damage === layer, fill = lit ? part.shade : '#000', ink = fill ? ` fill="${fill}"` : '';
    if (part.discs) return part.discs.map(d => `<circle cx="${X(d.x)}" cy="${Y(d.y)}" r="${n(d.r * scale)}"${ink}/>`).join('');
    // A gun and a damaged plate are drawn with an edge of their own, so that what is thinner than a pixel still shows.
    if (part.thin || part.lines) {
      const line = part.lines ? n(Math.max(EDGE, part.thickness * scale)) : THINNEST, shape = part.lines ? ' fill="none"' : '';
      return `<path d="${part.d}"${shape || ' fill="#000"'} stroke-width="${n(line + 2 * GAP)}"/>` + (lit ? `<path d="${part.d}"${shape} stroke="#fff" stroke-width="${line}"/>` : '');
    }
    return `<path d="${part.d}"${ink}/>`;
  }).join('');
  const mask = (layer: DamageTone) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><g fill="#fff" stroke="#000" stroke-width="${2 * GAP}" ` +
    `stroke-linejoin="round" paint-order="stroke">${drawn(layer)}</g></mask><rect width="${width}" height="${height}" fill="#fff" mask="url(#m)"/></svg>`;
  const layerMask = (layer: DamageTone) => parts.some(part => part.damage === layer) ? mask(layer) : '';
  return { whole: layerMask(LAYERS.whole), hurt: layerMask(LAYERS.hurt), lost: layerMask(LAYERS.lost) };
}
