// The sounds of the world are recordings: one `sounds/<profile>.mp3` per effect, made with a model of sound
// effects and chosen by ear (README, "Sons"). They are read once, when the sound is unlocked, never on the simulation
// thread or while a shot is processed. A one-shot lasts its profile's `duration`; a loop is that long, and its file
// carries `LOOP_PAD` seconds of the loop itself before and after it, so that where the file begins and ends — which
// a decoder may move by a few milliseconds — does not matter. `level` is how much louder the profile plays, the balance of the game as it
// is heard (README, "Sons"). `reach` is how far from the ears, in metres, it is heard at half its loudness: a blast
// over the hills, a round on a plate only near. A gun's shot has none of its own: it reaches as far as its calibre
// (audio.ts, MUZZLE_REACH).
export const LOOP_PAD = .1;
export interface SoundProfile {
  readonly duration: number;
  readonly level: number;
  readonly reach?: number;
  readonly filter?: number;
  readonly loop?: boolean;
}
export const SOUND_PROFILES = Object.freeze({
  // One approved recording each: Tiro 03 for Minimi/MAG and Tiro 50 for M2 (art/references/sound-study-20261019/
  // selection/manifest.json). Keep the complete 0.8 s tails. The levels set a 7.62, a 12.7, a 25 and a 120 on the
  // line of a gun's loudness by its calibre (audio.ts, MUZZLE_STEP), as each is played and heard (A-weighted, its
  // loudest eighth of a second); a mortar of 81 and a rocket of 84 are as loud as they were.
  'gun-light': { duration: .8, level: 3.294 },
  'gun-heavy': { duration: .8, level: 4.263 },
  'gun-auto': { duration: 1, level: 1.665 },
  'gun-cannon': { duration: 2.5, level: 1.307 },
  'gun-lob': { duration: 1.2, level: 4.163 },
  rocket: { duration: 2, level: 1.707 },
  'blast-small': { duration: 3.5, level: 1.05, reach: 300 },
  // C3 (+6 dB) and C1 (leading wait removed), approved in vehicle-sfx-previews-20261022.
  // Keep each complete tail; smaller metal strikes retain the previous recording (audio.ts).
  'blast-heavy': { duration: 8, level: 1.58, reach: 700 },
  'metal-hit': { duration: .6, level: 1.13, reach: 60 },
  'metal-hit-heavy': { duration: 2.81, level: 1.13 * 10 ** (3 / 20), reach: 60 }, // +3 dB requested after listening
  'hard-hit': { duration: .7, level: 4.82, reach: 50 },
  // One chosen ground strike for soil and concrete; their surface filters differ in soundCue.
  'ground-hit': { duration: 2.5, level: 6.3, reach: 50 },
  ricochet: { duration: 1, level: 1.2, reach: 60 },
  mechanical: { duration: .6, level: 1.64, reach: 30 },
  breakup: { duration: .8, level: 1.17, reach: 150 },
  // An engine is heard by its power and as fast as it turns (audio.ts, `engineVoice`): this is one of 300 kW.
  diesel: { duration: 2, loop: true, level: 2.04, reach: 110 },
  // These sustained textures sit 5 dB lower: 2 dB softer before shared dynamics after the field's 3 dB lift.
  tracks: { duration: 2, loop: true, level: 1.48 * 10 ** (-5 / 20), reach: 50 },
  wheels: { duration: 2, loop: true, level: 1.81 * 10 ** (-5 / 20), reach: 40 },
  // Padded loops from the approved brake24 metal and turbo29 hold, at their original pitch.
  // The pneumatic recording is retired; turbo gain is 6 dB below the previous audition.
  'brake-squeal': { duration: 4, loop: true, level: .4, reach: 35, filter: 8000 },
  'engine-turbo': { duration: 1.4, loop: true, level: .10024, reach: 70, filter: 8000 },
  // Approved suspension 13, jet 11 and fire 15 keep the study's gameplay demo levels
  // (art/references/vehicle-audio-variations-20261030/selection.json). Loops use offline crossfades.
  fire: { duration: 16, loop: true, level: 5.9091097705317965, reach: 40 },
  suspension: { duration: .7, level: 3.4409361912155663, reach: 35 },
  jet: { duration: 8, loop: true, level: 2.055326425054152, reach: 160, filter: 7000 },
  // A round passing by the ears, heard once as it passes (audio.ts, `updateFlybys`): a bullet or a shell.
  'flyby-bullet': { duration: .8, level: 1.79, reach: 15 },
  'flyby-shell': { duration: 1.6, level: 1.34, reach: 40 },
  // Ore pouring into a hopper or out of it, the motor of a gun turning to aim, and a part put in place: a heavy piece of
  // steel set down, in the workshop and when a part of a construction falls.
  ore: { duration: 2, loop: true, level: 1.87, reach: 40 },
  servo: { duration: 2, loop: true, level: 1.92, reach: 20 },
  clunk: { duration: .6, level: 1.26, reach: 40 },
  // The base at work on a construction it builds or mends (audio.ts, `updateWorks`): power tools, welding, steel struck.
  workshop: { duration: 3, loop: true, level: 1.56, reach: 50 },
  // The cues of the interface (audio.ts, `ALERTS`): an enemy in the senses of the squad, and bad news of a vehicle. They
  // are heard from no place, and over the music; no reach is theirs. Keep them 3 dB softer,
  // independently of the field's lift, on their own foreground/background volume gate.
  'alert-contact': { duration: .8, level: 3.28 * 10 ** (-3 / 20), reach: 0 },
  'alert-grave': { duration: .8, level: 3.28 * 10 ** (-3 / 20), reach: 0 },
} satisfies Record<string, SoundProfile>);

// The files found beside the game, by profile (`found` is the address of each by its path).
export type SoundProfileName = keyof typeof SOUND_PROFILES;
export function isSoundProfile(name: string | undefined): name is SoundProfileName {
  return name !== undefined && Object.hasOwn(SOUND_PROFILES, name);
}
export function soundFiles(found: Readonly<Record<string, string>>): Map<SoundProfileName, string> {
  const files = new Map<SoundProfileName, string>();
  for (const [path, url] of Object.entries(found)) {
    const name = path.split('/').pop()?.match(/^(.+)\.mp3$/)?.[1];
    if (isSoundProfile(name)) files.set(name, url);
  }
  return files;
}
export interface SoundBufferOptions {
  readonly files?: ReadonlyMap<SoundProfileName, string>;
  readonly load?: (url: string) => Promise<ArrayBuffer>;
}

// The recordings as the context plays them. One that cannot be read is left out: what would have played it is silent.
export class SoundBufferBank {
  declare readonly context: Pick<BaseAudioContext, 'decodeAudioData'>;
  declare readonly files: ReadonlyMap<SoundProfileName, string>;
  declare readonly load: (url: string) => Promise<ArrayBuffer>;
  declare readonly buffers: Map<SoundProfileName, AudioBuffer>;
  declare ready: boolean;
  constructor(context: Pick<BaseAudioContext, 'decodeAudioData'>, { files = new Map(), load = url => fetch(url).then(response => response.arrayBuffer()) }: SoundBufferOptions = {}) {
    this.context = context; this.files = files; this.load = load; this.buffers = new Map(); this.ready = false;
  }
  async prepare(): Promise<void> {
    await Promise.all([...this.files].map(async ([key, url]) => {
      try { this.buffers.set(key, await this.context.decodeAudioData(await this.load(url))); } catch {}
    }));
    this.ready = true;
  }
  get(name: SoundProfileName): AudioBuffer | undefined { return this.buffers.get(name); }
}
