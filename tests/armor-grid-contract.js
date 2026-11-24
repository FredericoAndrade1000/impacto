import assert from 'node:assert/strict';

// Decode the public cold DTO independently of the renderer's merged rectangles.
export function armorGrid(plate) {
  const g = plate.ballisticGrid;
  assert.equal(g?.version, 1);
  assert(Number.isInteger(g.nx) && g.nx >= 1 && g.nx <= 256);
  assert(Number.isInteger(g.ny) && g.ny >= 1 && g.ny <= 16);
  assert(g.nx * g.ny <= 4096);
  assert.match(g.bits, /^[0-9a-f]*$/);
  assert.equal(g.bits.length, 2 * Math.ceil(g.nx * g.ny / 8));
  assert(g.bits.length <= 1024, 'historic damage cannot grow the canonical grid');
  const bytes = Uint8Array.from({ length: g.bits.length / 2 }, (_, i) => parseInt(g.bits.slice(2*i, 2*i+2), 16)),
    dx = (g.bounds.maxX-g.bounds.minX)/g.nx, dy = (g.bounds.maxY-g.bounds.minY)/g.ny,
    occupied = i => Boolean(bytes[i >> 3] & (1 << (i & 7))), cells = [];
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) if (occupied(y*g.nx+x)) {
    const cx = g.bounds.minX+(x+.5)*dx, cy = g.bounds.minY+(y+.5)*dy;
    cells.push({ x, y, area: dx*dy, second: dx*dy*(cx*cx+cy*cy+(dx*dx+dy*dy)/12) });
  }
  return { ...g, dx, dy, occupied, cells, area: cells.length*dx*dy,
    second: cells.reduce((sum,c) => sum+c.second, 0) };
}
