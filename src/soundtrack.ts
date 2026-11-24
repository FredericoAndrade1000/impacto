import { standing } from './faction-ui.ts';
import type { StandingActor, StandingState } from './faction-ui.ts';

// The music of the game (music/*.mp3). It is of three moods, and the moment asks for one of them: the workshop
// has its own; the shared field is calm until a construction of another faction is in the senses of the player's,
// and tense from then until some time after the last sign of it. Within a mood the tracks follow one another in a
// drawn order, and a track gives way to the next — of its own mood or of another — over a few seconds.
export const MOODS = Object.freeze(['construction', 'calm', 'tense'] as const);
export type MoodName = typeof MOODS[number];
export type MusicTracks = Partial<Readonly<Record<MoodName, readonly string[]>>>;

// The mood needs only ownership and sensor presence, not a complete world.
export interface ThreatActor extends StandingActor { readonly ghost?: unknown }
export interface ThreatState extends StandingState {
  readonly actors: readonly ThreatActor[];
  readonly contacts?: { readonly length: number };
}
// The seconds one track takes to give way to another, how loud the music is beside the sounds of the world, and
// how long the field stays tense after the last sign of danger.
export const MUSIC_FADE = 4, MUSIC_LEVEL = .5, TENSE_HOLD = 30;

// The music found beside the game, by mood: a file is of the mood its name begins with (`found` is its address by its path).
export function tracksByMood(found: Readonly<Record<string, string>>): Record<MoodName, string[]> {
  const tracks: Record<MoodName, string[]> = { construction: [], calm: [], tense: [] };
  for (const mood of MOODS) tracks[mood] = Object.entries(found)
    .filter(([path]) => path.split('/').pop()?.startsWith(mood + '-'))
    .sort(([a], [b]) => a.localeCompare(b)).map(([, url]) => url);
  return tracks;
}

// Whether the shared field is dangerous for the player now: a construction of another faction stands in sight of
// theirs, or their sensors hold a mark of one — a radar's, a sound, a gun the watch of the base placed.
export function threatened(state: ThreatState | null | undefined): boolean {
  if (!state?.shared || !state.faction) return false;
  return state.actors.some(actor => !actor.ghost && standing(actor, state) === 'enemy') || Boolean(state.contacts?.length);
}

// Which mood the moment asks for, told frame by frame (`now` in seconds). Off the shared field — a bench of its own, a
// test — it is all workshop; on it danger comes before the workshop that stands there.
export class Mood {
  declare tenseUntil: number;
  constructor() { this.tenseUntil = -Infinity; }
  of({ edit, state }: { readonly edit?: boolean; readonly state?: ThreatState | null }, now: number): MoodName {
    if (!state?.shared) { this.tenseUntil = -Infinity; return 'construction'; }
    if (threatened(state)) this.tenseUntil = now + TENSE_HOLD;
    return now < this.tenseUntil ? 'tense' : edit ? 'construction' : 'calm';
  }
}

function shuffled(list: readonly string[], random: () => number): string[] {
  const drawn = [...list];
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)), a = drawn[i], b = drawn[j];
    if (a !== undefined && b !== undefined) { drawn[i] = b; drawn[j] = a; }
  }
  return drawn;
}

// The music as it plays: one track of the mood asked for, heard at `output` in `context`, each read from its
// address as it plays (`open` makes the element that does). Nothing plays until it is told to (`setPlaying`).
export interface SoundtrackOptions {
  readonly tracks: MusicTracks;
  readonly context: Pick<AudioContext, 'currentTime' | 'createGain' | 'createMediaElementSource'>;
  readonly output: AudioNode;
  readonly open?: (url: string) => HTMLAudioElement;
  readonly random?: () => number;
  readonly later?: (run: () => void, seconds: number) => unknown;
}
interface MusicVoice { element: HTMLAudioElement; gain: GainNode; url: string; mood: MoodName }
export class Soundtrack {
  declare readonly tracks: Partial<Record<MoodName, string[]>>;
  declare readonly context: Pick<AudioContext, 'currentTime' | 'createGain' | 'createMediaElementSource'>;
  declare readonly output: AudioNode;
  declare readonly open: (url: string) => HTMLAudioElement;
  declare readonly random: () => number;
  declare readonly later: (run: () => void, seconds: number) => unknown;
  declare mood: MoodName | null;
  declare playing: boolean;
  declare current: MusicVoice | null;
  declare readonly queues: Map<"construction" | "calm" | "tense", string[]>;
  declare readonly heard: Map<"construction" | "calm" | "tense", string>;
  constructor({ tracks, context, output, open = url => new Audio(url), random = Math.random, later = (run, seconds) => setTimeout(run, seconds * 1000) }: SoundtrackOptions) {
    this.tracks = {};
    for (const mood of MOODS) { const list = tracks[mood]; if (list) this.tracks[mood] = [...list]; }
    this.context = context; this.output = output; this.open = open; this.random = random; this.later = later;
    this.mood = null; this.playing = false; this.current = null; this.queues = new Map(); this.heard = new Map();
  }
  // The next track of a mood: every one of them before any comes again, and never the one just heard.
  next(mood: MoodName | null): string | undefined {
    if (mood === null) return;
    let queue = this.queues.get(mood);
    if (!queue?.length) {
      queue = shuffled(this.tracks[mood] || [], this.random);
      if (queue.length > 1 && queue[0] === this.heard.get(mood)) { const first = queue.shift(); if (first !== undefined) queue.push(first); }
      this.queues.set(mood, queue);
    }
    const url = queue.shift();
    if (url) this.heard.set(mood, url);
    return url;
  }
  setMood(mood: MoodName | null): void {
    if (mood === this.mood) return;
    this.mood = mood;
    if (this.playing) this.start();
  }
  // Silent, the track in the air stops where it is; heard again, it goes on from there if the mood is still its own.
  setPlaying(value: boolean): void {
    if (value === this.playing) return;
    this.playing = value;
    if (!value) this.current?.element.pause();
    else if (this.current && this.current.mood === this.mood) this.current.element.play().catch(() => {});
    else if (this.mood) this.start();
  }
  // A track of the mood comes in as the one in the air goes out.
  start(): void {
    const before = this.current, now = this.context.currentTime, url = this.next(this.mood);
    if (before) {
      before.element.ontimeupdate = before.element.onended = before.element.onerror = null;
      before.gain.gain.setTargetAtTime(0, now, MUSIC_FADE / 4); this.later(() => this.close(before), MUSIC_FADE);
    }
    this.current = null;
    if (!url || this.mood === null) return;
    const element = this.open(url), gain = this.context.createGain(), voice: MusicVoice = { element, gain, url, mood: this.mood };
    element.preload = 'auto'; gain.gain.value = 0;
    this.context.createMediaElementSource(element).connect(gain); gain.connect(this.output);
    // It gives way to the next of its mood as it comes to its end, and one that cannot be read is not drawn again.
    element.ontimeupdate = () => { if (element.duration - element.currentTime <= MUSIC_FADE) this.start(); };
    element.onended = () => this.start();
    element.onerror = () => { this.tracks[voice.mood] = (this.tracks[voice.mood] || []).filter(other => other !== url); this.queues.delete(voice.mood); this.start(); };
    gain.gain.setTargetAtTime(1, now, MUSIC_FADE / 4);
    this.current = voice; element.play().catch(() => {});
  }
  close(voice: MusicVoice): void { voice.element.pause(); voice.element.removeAttribute('src'); voice.element.load(); voice.gain.disconnect(); }
}
