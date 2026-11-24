import { nativeGroundResponse } from './native-dynamics.ts';
import type { GroundResponseRequest, GroundResponse } from './ground-response-contract.ts';

// Presentation data only. Mechanical and ballistic surface rules live in Rust.
export const GROUND_SURFACES = Object.freeze({
  soil: { name: 'Terra', color: 0x50564a, top: 0x81806a, dust: 0xa99c7f },
  rock: { name: 'Rocha', color: 0x535b58, top: 0x858b7e, dust: 0xa4aaa1 },
  concrete: { name: 'Concreto', color: 0x59605d, top: 0x90948a, dust: 0xb6b6a4 },
  gravel: { name: 'Cascalho', color: 0x5b594c, top: 0x918773, dust: 0xb5aa90 },
  sand: { name: 'Areia', color: 0x887851, top: 0xc1ad78, dust: 0xd0bc89 },
  mud: { name: 'Lama', color: 0x383f32, top: 0x606049, dust: 0x565039 },
  graded: { name: 'Terra batida', color: 0x6a6450, top: 0xa39b7e, dust: 0xb8ad8d },
  asphalt: { name: 'Asfalto', color: 0x3b3e40, top: 0x585b5a, dust: 0x8e908b },
});
export type GroundSurface = keyof typeof GROUND_SURFACES;
export type GroundProjectile = Pick<GroundResponseRequest, 'vx' | 'vy' | 'power' | 'ammo'> & { groundBounces?: number | null | undefined };
export type GroundNormal = Pick<GroundResponseRequest, 'nx' | 'ny'>;

export function groundResponse(projectile: GroundProjectile, normal: GroundNormal, surface: GroundResponseRequest['surface'] = 'soil'): GroundResponse | null {
  return nativeGroundResponse({ vx: projectile.vx, vy: projectile.vy, power: projectile.power,
    ammo: projectile.ammo, groundBounces: projectile.groundBounces || 0, nx: normal.nx, ny: normal.ny, surface });
}
