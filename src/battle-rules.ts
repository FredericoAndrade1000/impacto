import type { ConstructionTemplateId } from './construction-template-catalogue.ts';

// The persistent field and the private proving ground share the real seeded world generator.
export const MAIN_WORLD = Object.freeze({ terrain: 'world', seed: 6173, mapLength: 512000 });
export const TRIAL_WORLD = Object.freeze({ terrain: 'world', seed: 6173, mapLength: 32768, center: -13676 });
// Distances from X=12, facing left. Every target is seated on the unmodified terrain.
export const TRIAL_TARGETS = Object.freeze(([
  { template: 'recon', distance: 144, role: 'direct' }, { template: 'ifv', distance: 272, role: 'direct' },
  { template: 'truck', distance: 680, role: 'direct' }, { template: 'heavy', distance: 864, role: 'direct' },
  { template: 'bunker', distance: 1088, role: 'direct' }, { template: 'howitzer', distance: 1840, role: 'direct' },
  { template: 'bunker', distance: 8000, role: 'artillery' }, { template: 'howitzer', distance: 19596, role: 'artillery' },
] as const satisfies readonly { template: ConstructionTemplateId; distance: number; role: 'direct' | 'artillery' }[]).map(target => Object.freeze(target)));
export type TrialTarget = typeof TRIAL_TARGETS[number];
// Whose the targets of the proving ground are (trial-targets.ts).
export const TRIAL_TARGET_OWNER = 'alvo';
// The share of its top speed a vehicle backs at. The same number is in the core (REVERSE_SHARE).
export const REVERSE_SHARE = 0.4;
// How far above or below the field an aim may be put, in metres: far above the top of any arc and far under the lowest
// ground. Between the two it goes where it is put. The same number is in the core (AIM_SKY).
export const AIM_SKY = 50000;
// How far short of each end of its ground the shared field holds a vehicle, in metres. The same number is in the core (WORLD_EDGE).
export const WORLD_EDGE = 10;
// What a faction of the shared field keeps of a construction of another that its sensors lost, in seconds:
// the ghost of one it saw, the mark of one a radar held, the mark of one it heard.
export const GHOST_SECONDS = 30, BLIP_SECONDS = 10, SOUND_SECONDS = 3;
// And of a gun the watch of its base placed by its fire (server/base-watch.ts): the mark of where it stood, this
// long after the last round of it that was followed or heard.
export const BATTERY_SECONDS = 60;
// The ground of a faction's own base is always clear, this far past each end of it: the workshop stands there.
export const BASE_MARGIN = 50;
// A construction feels what strikes it and hears its own gun with no eye at all: of what flies and what happens
// this near it, by the straight line to it — to each side, over it and under it alike —, its faction is told.
export const FELT_REACH = 16;
// Where the sky begins over ground a faction does not see (ground-mist.ts, server/fog.ts): this many metres over
// ground it knows, and over ground it never saw, over the bank of mist — whole this high, gone this much higher.
export const LOW_AIR = 12, MIST_HEIGHT = 40, MIST_FADE = 80;
