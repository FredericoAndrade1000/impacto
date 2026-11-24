import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';

// Admission and operational population planning share the same human capacity.
export const ROOM_LIMITS = Object.freeze({ players: 32, perAddress: 2, newPerAddressPerDay: 3,
  perFaction: CONSTRUCTION_LIMITS, library: 100 });
