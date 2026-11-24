import { speed } from './format.ts';

interface SpeedActor {
  id: string; preset?: string | undefined; facing?: number | undefined; defeated?: boolean | undefined; ghost?: unknown;
  vehicle?: { enabled?: boolean | undefined; vx?: number | undefined; vy?: number | null | undefined; flying?: boolean | undefined } | null | undefined;
}
export interface SpeedState {
  actors?: readonly SpeedActor[] | undefined;
  squad?: { units?: readonly { id: string; move?: unknown }[] | undefined } | null | undefined;
}
export interface SpeedReading { speed: string; moving: boolean; reverse: boolean }

// How fast the vehicle the dock speaks of goes, read from the frame: reading it gives it no order.
export function vehicleSpeed(state: SpeedState | null | undefined, id: string | null | undefined): SpeedReading | null {
  const actor = state?.actors?.find(actor => actor.id === id);
  if (!actor || actor.defeated || actor.ghost) return null;
  // Uncontrolled vehicles use the public pose, which omits internal settings
  // such as `enabled`; its vehicle preset and velocity still identify the readout.
  const vehicle = actor.vehicle;
  if (!vehicle || !(vehicle.enabled === true || vehicle.enabled !== false && actor.preset === 'vehicle')) return null;
  const vx = vehicle.vx, vy = vehicle.vy ?? 0;
  if (typeof vx !== 'number' || !Number.isFinite(vx) || !Number.isFinite(vy)) return null;
  const velocity = Math.hypot(vx, vy);
  // It is under way from half a kilometre an hour, whichever way it goes — along the field, up or down —, or while the squad
  // has it on its way somewhere (`move`), however slowly it goes for a while: an aircraft sent home hangs all but still over
  // its place before it is let down there, the higher the longer (squad.ts `fly`), and one that turns from one way to the
  // other goes at none for a moment. Backwards against the way it faces, but in the air, where an aircraft flies either way
  // without turning about.
  const sent = Boolean(state?.squad?.units?.find(unit => unit.id === id)?.move);
  return { speed: speed(velocity), moving: velocity * 3.6 >= .5 || sent, reverse: !vehicle.flying && velocity > .05 && vx * (actor.facing || 1) < -.05 };
}
