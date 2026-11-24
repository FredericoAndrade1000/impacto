import type { Point } from './math.ts';

export type EffectQuality = 'high' | 'balanced' | 'low';
export interface EffectCamera extends Point { zoom: number; width: number; height: number }
export interface EffectView { left: number; right: number; bottom: number; top: number }
export interface EffectTerrain {
  points: readonly Point[];
  height(x: number): number;
}
export type { ArtCanvas as PaintCanvas, ArtContext as PaintContext } from './canvas-art.ts';

export interface LightSite extends Point { carrier?: string | undefined; carryX?: number; carryY?: number; displayX?: number; displayY?: number }
export interface EffectLight extends LightSite {
  age: number; life: number; size: number; strength: number; key?: string; tint?: number; phase?: number;
  wait?: number; lift?: number; blast?: boolean; effectActorId?: string | null | undefined;
  displayStrength?: number; displayTint?: number; sites?: LightSite[] | undefined;
  sprite?: import('pixi.js').Sprite | null;
}
