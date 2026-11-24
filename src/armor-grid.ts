// Presentation projection of the native material grid. These rectangles are
// cached draw data; only the fixed bit grid is returned on a cold admission.
export interface GridBounds { minX: number; maxX: number; minY: number; maxY: number }
export interface MaterialGrid {
  version: number;
  nx: number;
  ny: number;
  bounds: GridBounds;
  bits: string;
}

const regions = new WeakMap<MaterialGrid, GridBounds[]>();
export function gridRegions(grid: MaterialGrid): GridBounds[] {
  const cached = regions.get(grid);
  if (cached) return cached;
  const { nx, ny, bounds, bits } = grid;
  if (grid.version !== 1 || !Number.isInteger(nx) || nx < 1 || nx > 256 ||
      !Number.isInteger(ny) || ny < 1 || ny > 16 || typeof bits !== 'string' ||
      bits.length !== Math.ceil(nx * ny / 8) * 2 || !/^[0-9a-f]*$/i.test(bits) ||
      !bounds || !Object.values(bounds).every(Number.isFinite) ||
      !(bounds.maxX > bounds.minX && bounds.maxY > bounds.minY))
    throw new Error('Grade de blindagem inválida.');
  const bytes = Uint8Array.from({ length: bits.length / 2 }, (_, i) => parseInt(bits.slice(i * 2, i * 2 + 2), 16)),
    occupied = (i: number) => Boolean(bytes[i >> 3]! & (1 << (i & 7))), result: GridBounds[] = [],
    dx = (bounds.maxX - bounds.minX) / nx, dy = (bounds.maxY - bounds.minY) / ny;
  let previous = new Map<string, GridBounds>();
  for (let y = 0; y < ny; y++) {
    const row = new Map<string, GridBounds>();
    for (let x = 0; x < nx;) {
      if (!occupied(y * nx + x)) { x++; continue; }
      const start = x; while (x < nx && occupied(y * nx + x)) x++;
      const key = start + ':' + x, old = previous.get(key);
      if (old) { old.maxY = bounds.minY + (y + 1) * dy; row.set(key, old); }
      else {
        const box = { minX: bounds.minX + start * dx, maxX: bounds.minX + x * dx,
          minY: bounds.minY + y * dy, maxY: bounds.minY + (y + 1) * dy };
        result.push(box); row.set(key, box);
      }
    }
    previous = row;
  }
  regions.set(grid, result); return result;
}
