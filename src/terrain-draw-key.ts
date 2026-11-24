import type { Point } from './math.ts';

interface DrawingFields {
  seed?: number | undefined; length?: number | undefined; center?: number | undefined;
  material?: string | undefined; minX?: number | undefined; maxX?: number | undefined; spacing?: number | undefined;
}
export interface TerrainDrawingSettings extends DrawingFields {
  points?: readonly Point[] | null; sectors?: readonly { start: number; end: number; surface: string }[] | null;
}
interface KeyDescriptor {
  id: string; weather: string; seed: number | undefined; length: number | undefined; center: number | undefined;
}
export type TerrainDrawKey = KeyDescriptor & (
  | { concrete: false }
  | { concrete: true; material: string | undefined; minX: number | undefined; maxX: number | undefined;
      spacing: number | undefined; points: number[]; sectors: (number | string)[] }
);

// One derived drawing cache, not another terrain authority. Worker/network
// snapshots clone arrays, so compare their concrete contents without hashing or
// allocating on unchanged frames. Copy primitives only after a profile changes.
const descriptorFields: readonly (keyof DrawingFields)[] = ['seed', 'length', 'center'];
const profileFields: readonly (keyof DrawingFields)[] = ['material', 'minX', 'maxX', 'spacing'];

function sameFields(previous: DrawingFields, settings: DrawingFields, fields: readonly (keyof DrawingFields)[]): boolean {
  for (const field of fields) if (previous[field] !== settings[field]) return false;
  return true;
}
function samePoints(saved: readonly number[], points: readonly Point[]): boolean {
  if (saved.length !== points.length * 2) return false;
  let i = 0;
  for (const point of points) {
    if (saved[i * 2] !== point.x || saved[i * 2 + 1] !== point.y) return false;
    i++;
  }
  return true;
}
function sameSectors(saved: readonly (number | string)[], sectors: TerrainDrawingSettings['sectors']): boolean {
  if (!sectors || saved.length !== sectors.length * 3) return false;
  let i = 0;
  for (const sector of sectors) {
    if (saved[i * 3] !== sector.start || saved[i * 3 + 1] !== sector.end || saved[i * 3 + 2] !== sector.surface) return false;
    i++;
  }
  return true;
}

export function terrainDrawKey(id: string, settings: TerrainDrawingSettings = {}, weather = 'clear', previous?: TerrainDrawKey): TerrainDrawKey {
  const points = settings.points, concrete = Boolean(points), sectors = settings.sectors;
  if (previous?.id === id && previous.weather === weather && previous.concrete === concrete &&
      sameFields(previous, settings, descriptorFields) && (!concrete || previous.concrete && points &&
        sameFields(previous, settings, profileFields) && samePoints(previous.points, points) &&
        sameSectors(previous.sectors, sectors))) return previous;
  const key: KeyDescriptor & { concrete: false } = { id, weather, concrete: false, seed: settings.seed, length: settings.length, center: settings.center };
  return points ? { ...key, concrete: true, material: settings.material, minX: settings.minX, maxX: settings.maxX, spacing: settings.spacing,
    points: points.flatMap(p => [p.x, p.y]), sectors: (sectors || []).flatMap(s => [s.start, s.end, s.surface]) } : key;
}
