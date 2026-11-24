export interface GroundResponseRequest {
  vx: number; vy: number; power: number; nx: number; ny: number;
  ammo?: string | null | undefined;
  groundBounces?: number | null | undefined;
  surface?: string | null | undefined;
}
export interface GroundResponse { vx: number; vy: number; power: number; retained: number; cosine: number }
function response(value: unknown): value is GroundResponse {
  return value !== null && typeof value === 'object' &&
    'vx' in value && typeof value.vx === 'number' && Number.isFinite(value.vx) &&
    'vy' in value && typeof value.vy === 'number' && Number.isFinite(value.vy) &&
    'power' in value && typeof value.power === 'number' && Number.isFinite(value.power) &&
    'retained' in value && typeof value.retained === 'number' && Number.isFinite(value.retained) &&
    'cosine' in value && typeof value.cosine === 'number' && Number.isFinite(value.cosine);
}
// Only admit the returned shape; surface physics and ricochet remain in Rust.
export function decodeGroundResponse(value: unknown): GroundResponse | null {
  if (value === null || response(value)) return value;
  throw new TypeError('Invalid Native ground response.');
}
