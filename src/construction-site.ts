import { within } from './ground-sight.ts';
import { CRANE_REACH } from './work-arm.ts';
import { OUTSIDE, FOREIGN, territoryRefusal } from './territory.ts';
import { phrase, translate } from './i18n.ts';
import type { Spans } from './ground-sight.ts';

export interface ConstructionSpan { minX: number; maxX: number }
export interface SiteGround { height(x: number): number }
export interface SiteOptions {
  span: ConstructionSpan | null; limits: ConstructionSpan; explored?: Spans | null; own?: Spans | null;
  foreign?: readonly Spans[]; home?: number | null; ground: SiteGround; taken?: readonly ConstructionSpan[];
}

// Where a structure may stand on the shared field: the same rules on the field (server/field-construction.ts) and on the
// page that chooses the place, each with what it knows. A structure is not made at a base: it is a works (an obra) at a
// place of the field, and it stands there on ground its faction has seen, within its territory and in that of no other
// faction (territory.ts), not too steep, clear of the structures and works the faction has there, and this far from its own
// base — from the middle of the base to the nearest of the structure —: none stands in a base.
export const HOME_CLEARANCE = 150;
// A construction works at a works, or at a structure it takes down, from beside it: the end of it no further from that
// than this, in whole metres. Its builder puts the works up, or takes the structure down, from there, and its supply
// pieces unload into the works there; from further off neither does anything. It is as far as the loader crane of a builder
// of the reference size reaches out of its column (work-arm.ts `CRANE_REACH`, 6.8 m), which stands on its construction.
export const BUILD_REACH = Math.ceil(CRANE_REACH);
// How far a structure keeps from the faction's own constructions and works, in metres, and how steep the ground under it may
// be, in degrees: as far as it rises and falls under the structure over as wide as the structure is. The structure stands
// level all the same, on a footing that fills the room the slope leaves under it (fixed-footing.ts).
export const SITE_CLEARANCE = .8, STEEPEST_SLOPE = 30;

// How far a place is from a stretch of the field: nothing within it.
const apart = (span: ConstructionSpan, x: number) => Math.max(0, span.minX - x, x - span.maxX);
// How far two stretches of the field are from each other, end to end: nothing where they overlap.
export const gap = (a: ConstructionSpan, b: ConstructionSpan) => Math.max(0, a.minX - b.maxX, b.minX - a.maxX);

// Why a structure that would take up `span` may not stand there, in words, or nothing when it may. `limits` are the ends of
// the field it may come to; `explored` the ground its faction has seen (nothing on a field without fog, where it knows all
// of it); `own` the territory of its faction and `foreign` those of the others, as far as it is told them (no `own`: no
// territory is read); `home` the middle of its base, or nothing for a faction without one; `ground` the height of the
// ground; and `taken` the stretches of the structures and works of the faction there. Unknown ground is refused before its
// territories, its slope or what stands on it is read: a place asked for is no scouting tool.
export function siteRefusalMessage({ span, limits, explored = null, own = null, foreign = [], home = null, ground, taken = [] }: SiteOptions) {
  if (!span || !Number.isFinite(span.minX + span.maxX)) return phrase('Posição no campo inválida.');
  if (span.minX < limits.minX || span.maxX > limits.maxX) return phrase('A estrutura passa do limite do campo.');
  if (explored && !within(explored, span.minX, span.maxX)) return phrase('Terreno desconhecido: escolha chão já visto.');
  const held = own ? territoryRefusal(span, own, foreign) : '';
  if (held) return held === OUTSIDE ? phrase(OUTSIDE) : phrase(FOREIGN);
  if (home !== null && Number.isFinite(home) && apart(span, home) < HOME_CLEARANCE) return phrase`Perto demais da base: no mínimo ${HOME_CLEARANCE} m.`;
  const samples = Math.max(2, Math.ceil((span.maxX - span.minX) / .5)),
    heights = Array.from({ length: samples + 1 }, (_, i) => ground.height(span.minX + (span.maxX - span.minX) * i / samples));
  if (!heights.every(Number.isFinite)) return phrase('Posição no campo inválida.');
  if (Math.max(...heights) - Math.min(...heights) > Math.tan(STEEPEST_SLOPE * Math.PI / 180) * (span.maxX - span.minX) + 1e-9)
    return phrase`Encosta íngreme demais: no máximo ${STEEPEST_SLOPE}°.`;
  if (taken.some(other => span.maxX + SITE_CLEARANCE >= other.minX && span.minX - SITE_CLEARANCE <= other.maxX))
    return phrase('Não há espaço aí: afaste das estruturas e obras vizinhas.');
  return null;
}
export const siteRefusal = (options: SiteOptions): string => translate(siteRefusalMessage(options) ?? '');
