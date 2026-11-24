import type { CargoKind } from './economy-contract.ts';

export interface DepositTone { plate: number; heap: number; shade: number; light: number }

// Shared ore colours: cargo artwork needs the palette, not the field scenery renderer.
// `plate` is the sign on a survey post, inside the same dark edge for every material (deposit-art.js). Petroleum's is
// a dark slate: the darkest of the four, but lighter than that edge, so that the edge reads as the rim of a plate as
// it does on the others and not as a pale ring round a hole.
export const DEPOSIT_TONES = Object.freeze({
  ferro: { plate: 0xb98a6a, heap: 0x8c7462, shade: 0x75604f, light: 0xa38a74 },
  ligas: { plate: 0x9fb4c4, heap: 0x8c979b, shade: 0x747f83, light: 0xa7b1b4 },
  silica: { plate: 0xdccf9a, heap: 0xb3a987, shade: 0x988f70, light: 0xcbc19c },
  petroleo: { plate: 0x5a5363, heap: 0x5f594d, shade: 0x3f4442, light: 0x1f1e20 },
} satisfies Record<CargoKind, DepositTone>);
