import type { Container } from 'pixi.js';
import type { Point } from './math.ts';
import type { EffectCamera, EffectTerrain } from './effect-types.ts';
interface Bounds { left: number; right: number; top: number }
interface EffectChild { visible: boolean; renderable: boolean; alpha: number; children?: readonly EffectChild[]; particleChildren?: readonly unknown[]; renderPipeId?: string; context?: { instructions: readonly unknown[] } }
import { Mesh, MeshGeometry, Texture } from 'pixi.js';

function firstAfter(points: readonly Point[], x: number) {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid]!.x <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

// Use the exact piecewise-linear contact outline, including narrow peaks and
// depressions. Only the two view-range endpoints require height interpolation.
// What lies over it up to `top` is a strip of upright quads, one to each stretch
// of the outline: two corners to each of its points, on it and at the top, in
// `corners` from `left` (`count` points). An outline that only goes on along the
// ground needs no triangulation, and the view of a whole region is laid out in a
// fraction of a millisecond, where cutting its polygon into triangles took up to
// ten on every frame the view was dragged. `corners` are those of the strip
// before, laid out again in place while they have room.
export function effectSurfaceStrip(terrain: EffectTerrain, { left, right, top }: Bounds, corners: Float32Array = new Float32Array(0)) {
  const points = terrain.points, first = firstAfter(points, left);
  let end = first;
  while (end < points.length && points[end]!.x < right) end++;
  const count = end - first + 2;
  if (corners.length < count * 4) corners = new Float32Array(count * 8);
  const lay = (at: number, x: number, y: number) => { corners[at * 4] = corners[at * 4 + 2] = x - left; corners[at * 4 + 1] = y; top = Math.max(top, y + 1); };
  lay(0, left, terrain.height(left));
  for (let i = first; i < end; i++) lay(i - first + 1, points[i]!.x, points[i]!.y);
  lay(count - 1, right, terrain.height(right));
  for (let at = 0; at < count; at++) corners[at * 4 + 3] = top;
  return { corners, count, bounds: { left, right, top } };
}
// The corners of the triangles of a strip of `count` points, two to each quad: the first of a longer strip are those
// of a shorter one.
function stripOrder(count: number) {
  const order = new Uint32Array((count - 1) * 6);
  for (let i = 0, at = 0; i < count - 1; i++, at += 6) {
    const low = i * 2;
    order[at] = low; order[at + 1] = low + 1; order[at + 2] = low + 2;
    order[at + 3] = low + 1; order[at + 4] = low + 3; order[at + 5] = low + 2;
  }
  return order;
}

function hasEffects(container: EffectChild, mask: EffectChild): boolean {
  for (const child of container.children || []) {
    if (child === mask || !child.visible || !child.renderable || child.alpha <= 0) continue;
    if (child.particleChildren) { if (child.particleChildren.length) return true; continue; }
    if (child.renderPipeId === 'graphics') { if (child.context!.instructions.length) return true; continue; }
    if (child.renderPipeId) return true;
    if (hasEffects(child, mask)) return true;
  }
  return false;
}

// A mesh that is no sprite uses Pixi's stencil mask, rather than a sprite alpha-mask/filter.
// All actor and ambient hosts share one cached GPU geometry. A host keeps its
// original place in the scene tree, so this does not flatten vehicle depth.
// The outline is counted from the left end of the stretch it covers, and every
// mask stands there: the hosts stay where they are, and what they hold with them.
// The strip is laid into corners kept from one stretch to the next, and the
// geometry is handed as much of them as the stretch has points.
export class EffectSurfaceClip {
  declare tileSize: number; declare corners: Float32Array; declare uvs: Float32Array | null; declare order: Uint32Array | null; declare count: number;
  declare geometry: MeshGeometry; declare hosts: Map<Container, { mask: Mesh<MeshGeometry>; visible: boolean }>;
  declare terrain: EffectTerrain | null; declare outline: readonly Point[] | null; declare bounds: Bounds | null; declare builds: number;
  constructor({ tileSize = 64 } = {}) {
    this.tileSize = tileSize; this.corners = new Float32Array(0); this.uvs = this.order = null; this.count = 0;
    this.geometry = new MeshGeometry({ positions: new Float32Array(8), uvs: new Float32Array(8), indices: new Uint32Array(0) });
    this.geometry.batchMode = 'no-batch';
    this.hosts = new Map(); this.terrain = null; this.outline = null; this.bounds = null;
    this.builds = 0;
  }
  attach(host: Container | null | undefined) {
    if (!host || host.destroyed) return null;
    if (this.hosts.has(host)) return this.hosts.get(host)!.mask;
    const mask = new Mesh({ geometry: this.geometry, texture: Texture.WHITE }); mask.label = 'effects:ground-surface';
    if (this.bounds) mask.x = this.bounds.left;
    host.addChild(mask); host.mask = mask;
    this.hosts.set(host, { mask, visible: host.visible }); return mask;
  }
  detach(host: Container) {
    const entry = this.hosts.get(host); if (!entry) return;
    if (!host.destroyed) {
      if (host.mask === entry.mask) host.mask = null;
      host.visible = entry.visible;
    }
    if (!entry.mask.destroyed) {
      if (entry.mask.parent) entry.mask.parent.removeChild(entry.mask);
      entry.mask.destroy();
    }
    this.hosts.delete(host);
  }
  update(terrain: EffectTerrain | null | undefined, camera: EffectCamera | null | undefined) {
    if (!terrain?.points?.length || !camera || ![camera.x, camera.y, camera.width, camera.height, camera.zoom].every(Number.isFinite) || camera.zoom <= 0) return false;
    const left = camera.x - camera.width / (2 * camera.zoom), right = camera.x + camera.width / (2 * camera.zoom),
      top = camera.y + camera.height / (2 * camera.zoom), tile = this.tileSize;
    if (terrain === this.terrain && terrain.points === this.outline && this.bounds &&
      left >= this.bounds.left + tile * .2 && right <= this.bounds.right - tile * .2 && top <= this.bounds.top - tile * .2) return false;
    const strip = effectSurfaceStrip(terrain, { left: Math.floor(left / tile) * tile - tile,
      right: Math.ceil(right / tile) * tile + tile, top: Math.ceil(top / tile) * tile + tile }, this.corners), geometry = this.geometry;
    if (strip.corners !== this.corners) { this.corners = strip.corners; this.uvs = new Float32Array(strip.corners.length); this.order = stripOrder(strip.corners.length / 4); }
    this.terrain = terrain; this.outline = terrain.points; this.bounds = strip.bounds; this.count = strip.count;
    geometry.positions = this.corners.subarray(0, strip.count * 4); geometry.uvs = this.uvs!.subarray(0, strip.count * 4);
    geometry.indices = this.order!.subarray(0, (strip.count - 1) * 6);
    for (const { mask } of this.hosts.values()) if (!mask.destroyed) mask.x = this.bounds.left;
    this.builds++; return true;
  }
  sync() {
    let active = false;
    for (const [host, entry] of this.hosts) {
      if (host.destroyed) { this.detach(host); continue; }
      // Empty actor hosts should not execute stencil passes merely because
      // they retain particle containers or invisible pooled flash sprites.
      host.visible = Boolean(this.terrain && hasEffects(host, entry.mask));
      if (host.visible) active = true;
    }
    return active;
  }
  clear() { for (const host of this.hosts.keys()) this.detach(host); }
  destroy() { this.clear(); this.geometry.destroy(true); this.terrain = null; }
}
