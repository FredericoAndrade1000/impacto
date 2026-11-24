import { clamp } from './math.ts';
import { sceneIndex } from './scene-frame.ts';
import { ContactSoundGate } from './contact-sound-gate.ts';
import { SuspensionSoundGate } from './suspension-sound-gate.ts';
import { SoundBufferBank, SOUND_PROFILES, LOOP_PAD } from './sound-art.ts';
import { WORK_HOLD, LIFT_HOLD } from './work-arm.ts';
import { Soundtrack, MUSIC_LEVEL } from './soundtrack.ts';
import { Gearbox, ENGINE_IDLE, CRAWL } from './gearbox.ts';
import { weaponOf, isWeaponId } from './weapons.ts';
import type { SoundBufferOptions, SoundProfile, SoundProfileName } from './sound-art.ts';
import type { MoodName, SoundtrackOptions } from './soundtrack.ts';
import type { ContactSoundEvent } from './contact-sound-gate.ts';
import type { SuspensionActor, SuspensionPart } from './suspension-sound-gate.ts';
import type { VehicleSnapshot } from './vehicle.ts';
import type { ActorService } from './construction-service.ts';
import type { CargoLoad } from './economy-contract.ts';

export type SoundContext = Pick<AudioContext, 'currentTime' | 'state' | 'sampleRate' | 'destination' | 'resume' | 'createGain' | 'createDynamicsCompressor' | 'createBuffer' | 'createConvolver' | 'decodeAudioData' | 'createBufferSource' | 'createBiquadFilter' | 'createStereoPanner' | 'createMediaElementSource'>;
export interface SoundSystemOptions {
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly contextFactory?: () => SoundContext;
  readonly sounds?: SoundBufferOptions;
  readonly music?: Omit<SoundtrackOptions, 'context' | 'output'> | null;
}
export interface SoundObservation { readonly x?: number | undefined; readonly y?: number | undefined }
export interface SoundPoint extends SoundObservation { readonly x: number }
export interface SoundListener extends SoundPoint { readonly zoom?: number; readonly width?: number; readonly height?: number }
export interface Hearing extends SoundPoint { readonly y: number; readonly depth: number; readonly aboard: boolean }
export interface SoundCueEvent extends ContactSoundEvent {
  readonly componentId?: string | undefined;
  readonly actorId?: string | null | undefined;
  readonly material?: string;
  readonly surface?: string;
  readonly weapon?: string | null | undefined;
  readonly caliberMm?: number;
  readonly power?: number;
  readonly sourceKind?: string | undefined;
  readonly kind?: string;
  readonly ground?: boolean;
  readonly strength?: number;
  readonly impulse?: number;
}
export interface SpatialSoundEvent extends SoundCueEvent { readonly x: number; readonly y: number }
export interface SoundCue {
  readonly profile: SoundProfileName;
  readonly duration: number;
  readonly filter: number;
  readonly volume: number;
  readonly priority: number;
  readonly reach?: number;
  readonly echo?: number;
  readonly rate?: number;
  readonly loop?: boolean;
}
type AudioDriveKey = 'vx' | 'vy' | 'engine' | 'flying' | 'powerKw' | 'throttle' | 'brake' | 'driveSpeed' | 'traction' | 'maxSpeed' | 'angle' | 'groundSlope' | 'fuelRate' | 'slip';
export type AudioVehicle = Readonly<{ [Key in AudioDriveKey | 'x' | 'y']?: VehicleSnapshot[Key] | undefined } & { chassisId?: string | null | undefined }>;
export interface AudioActor extends SuspensionActor {
  readonly id: string;
  readonly facing?: number | undefined;
  readonly vehicle?: AudioVehicle | null | undefined;
  readonly field?: {
    readonly building?: unknown;
    readonly service?: ActorService | null | undefined;
  } | null | undefined;
}
export interface AudioModule extends SuspensionPart {
  readonly thrust?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly burning?: boolean | undefined;
  readonly cargo?: Readonly<CargoLoad> | null | undefined;
  readonly servoVelocity?: number | undefined;
  readonly barrelAngle?: number | undefined;
}
export interface AudioState { readonly time: number; readonly actors?: readonly AudioActor[] | undefined; readonly modules?: readonly AudioModule[] | undefined }
interface AudioIndex {
  readonly actors: ReadonlyMap<string, AudioActor>;
  get(id: string | undefined, type: 'module'): AudioModule | null;
}
export interface SoundShot extends SoundPoint {
  readonly y: number;
  readonly number?: number | undefined;
  readonly n?: number | undefined;
  readonly fragment?: boolean | undefined;
  readonly spall?: boolean | undefined;
  readonly weapon?: string | null | undefined;
  readonly preset?: string | null | undefined;
  readonly vx?: number | undefined;
  readonly vy?: number | undefined;
  readonly age?: number | undefined;
}
export interface SoundReceiveOptions {
  readonly active?: boolean;
  readonly listener?: SoundListener | null;
  readonly hands?: string | null | undefined;
  readonly following?: string | null | undefined;
  readonly shots?: readonly SoundShot[] | null;
  readonly time?: number;
}
type AlertKind = keyof typeof ALERTS;
type FlybyProfile = 'flyby-bullet' | 'flyby-shell';
type DriveProfile = 'brake-squeal' | 'engine-turbo' | 'jet';
interface SoundLoop { sources: [AudioBufferSourceNode, ...AudioBufferSourceNode[]]; nodes: AudioNode[] }
interface PannedLoop extends SoundLoop { filter: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode }
interface PlaceLoop extends PannedLoop { source: AudioBufferSourceNode }
interface EngineLoop extends PannedLoop {
  motor: AudioBufferSourceNode; rolling: AudioBufferSourceNode; rollFilter: BiquadFilterNode; rollGain: GainNode;
  tracked: boolean; gearbox: Gearbox; level: number; turboLevel: number;
}
interface VoiceBase extends SoundLoop { priority: number; endAt: number; ended?: boolean }
interface AlertVoice extends VoiceBase { alertKind: AlertKind }
interface VoiceChain { filter: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode; echo: GainNode; voice: FieldVoice | null }
interface FieldVoice extends VoiceBase {
  profile: SoundProfileName; at: number; x: number | undefined; y: number; gun: string | null; level: number; loudest: number;
  chain: VoiceChain; loop?: boolean; follow?: { actor: string }; quietAt?: number;
}
type SoundVoice = AlertVoice | FieldVoice;
interface FlybySample { key: string; x: number; y: number; time: number }
interface FlybyHistory { x: number; y: number; earX: number; earY: number; age: number; time: number; done: boolean }
interface FireEmitter { x: number; y: number; actorId: string | null | undefined; componentId: string | undefined; actorObserved: boolean; strength: number; time: number }
interface LoopPlace extends SoundPoint { key: string; level: number; rate?: number }
type VehicleActor = AudioActor & { readonly vehicle: AudioVehicle };
const hasVehicle = (actor: AudioActor): actor is VehicleActor => actor.vehicle != null;
interface DrivePlace { actor: VehicleActor; profile: DriveProfile; volume: number; point?: SoundPoint; rate?: number; cutoff?: number }
const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

// No more than MAX_SOUND_VOICES sound at once; past that the least of them gives way (`giveWay`): it falls silent in
// FADE seconds, as it would at its end.
export const MAX_SOUND_VOICES = 24, FADE = .018;
// Many of one sound at once are not heard piling up (`play`): of a recording no more than MAX_PROFILE_VOICES sound
// together, the oldest giving way. Of those starting together, within TOGETHER seconds of each other — less than the
// turn of the fastest gun —, one as near as MERGE_REACH metres to another is heard in that one, which swells up to
// SWELL_MOST times as loud, and the others share the loudness of one: each at 1/√(1 + the others). Never two shots
// of one gun: each is heard.
export const MAX_PROFILE_VOICES = 4;
export const TOGETHER = .05, MERGE_REACH = 5, SWELL_MOST = Math.SQRT2;
// What happened over a frame is heard over as long, each when it happened in it, as late as the longest of the
// frames of late (`receive`): a burst keeps its beat however unevenly the frames come. A frame longer than FRAME_MOST
// seconds is heard in that long. The wait is kept for LAG_HOLD seconds after the longest frame, then eases back by
// LAG_EASE of the time going by.
export const FRAME_MOST = .25, LAG_HOLD = 1, LAG_EASE = .1;
// No more than MAX_ENGINE_LOOPS engines sound at once, the loudest as heard, each with its running gear.
export const MAX_ENGINE_LOOPS = 8;
// Drive recordings follow the current physical state, not application edges.
// Their padded loops keep their original pitch; only their mix changes.
const BRAKE_MOVING = .2, BRAKE_FULL_SPEED = 12, DRIVE_REST = .8;
// Native fuel flow follows delivered engine work. Flow per installed kW is an
// audio proxy, not boost: 3 is listening sensitivity, not a fuel-model conversion.
const TURBO_FLOW_GAIN = 3;
type KnownDrive = AudioVehicle & { readonly throttle: number; readonly brake: number; readonly driveSpeed: number };
const knowsDrive = (body: AudioVehicle | null | undefined): body is KnownDrive => finite(body?.throttle) && finite(body?.brake) && finite(body?.driveSpeed);
const brakesOn = (body: AudioVehicle): boolean => (body.brake ?? 0) > 0 || body.throttle === 0 || body.driveSpeed === 0;
const driveEase = (profile: SoundProfileName): number => ['engine-turbo', 'jet'].includes(profile) ? .16 : ENGINE_EASE;
// Native gives an explicit partial brake precedence over its automatic full stop.
// A zero target confirms that stop only with released/opposing input, not by itself.
function brakeSquealVolume(body: AudioVehicle): number {
  if (!knowsDrive(body) || body.brake < 0 || !((body.traction ?? 0) > 0)) return 0;
  const along = (body.vx || 0) * Math.cos(body.angle || 0) + (body.vy || 0) * Math.sin(body.angle || 0), speed = Math.abs(along);
  if (!Number.isFinite(speed) || speed <= BRAKE_MOVING) return 0;
  const share = body.brake > 0 ? Math.min(1, body.brake)
    : body.driveSpeed === 0 && (body.throttle === 0 || along * body.throttle < 0) ? 1 : 0;
  // A volume curve, not a new brake-force model: light applications stay soft,
  // and the same recording opens up gradually with speed, without changing pitch.
  return share * (.6 + .4 * share) * Math.min(1, speed / BRAKE_FULL_SPEED);
}
// An engine is heard by its power (`engineVoice`): ENGINE_STEP decibels louder for every doubling of it, ENGINE_DEEPEN
// semitones lower, and reaching further as its power to the ENGINE_SPREAD. One of ENGINE_POWER kW is as loud as
// ENGINE_LOUD says and reaches as far as its profile (sound-art.ts): 80 m at 150 kW, 150 m at 600 and 200 m at 1100. One
// of more than ENGINE_MOST kW, the most of a tank's, is heard as one of that. A vehicle of another faction is not told its
// power (server/fog.ts), and is heard as one of ENGINE_POWER.
export const ENGINE_POWER = 300, ENGINE_MOST = 1100, ENGINE_STEP = 2, ENGINE_DEEPEN = 1, ENGINE_SPREAD = .45;
export function engineVoice(powerKw: number | undefined) {
  const share = Math.min(powerKw !== undefined && powerKw > 0 ? powerKw : ENGINE_POWER, ENGINE_MOST) / ENGINE_POWER;
  return { volume: share ** (ENGINE_STEP / (20 * Math.log10(2))), pitch: share ** (-ENGINE_DEEPEN / 12), reach: SOUND_PROFILES.diesel.reach * share ** ENGINE_SPREAD };
}
// An engine sounds as fast as its gearbox turns it (gearbox.ts): its recording plays ENGINE_RATE times as fast at idle,
// and faster as how fast it turns to the ENGINE_RATE_GROWTH. It is ENGINE_LOUD loud turning at its rated speed pressed
// on all the way, and ENGINE_HUSH of that at idle: the louder the harder it is pressed on and the faster it turns, and
// its highs open the same way. It follows them within ENGINE_EASE seconds, quick enough to be heard shift.
export const ENGINE_LOUD = .195, ENGINE_HUSH = .52, ENGINE_RATE = .8, ENGINE_RATE_GROWTH = .6, ENGINE_EASE = .04;
// A vehicle the page is not told the pedals and the top speed of (server/fog.ts) is heard pressed on as UNSEEN_PULL
// while it goes, and as if its top speed were UNSEEN_TOP metres a second.
const UNSEEN_PULL = .5, UNSEEN_TOP = { track: 20, wheel: 30 };
export const MAX_FIRE_LOOPS = 6;
export const MAX_FIRE_EMITTERS = 64;
export const MAX_WORK_LOOPS = 3, MAX_SERVO_LOOPS = 3;
// A round that passes by the ears (`hearing`) is heard once, as it passes: where it came nearest them, once it goes
// away from them. Only one that came from elsewhere — one nearest as it leaves its gun is the player's own, and heard
// by its shot. It passes within FLYBY_NEAR metres of their place, or as far as they stand out of the screen; the
// nearer, the louder, and as loud as its distance from the ears lets it (`soundPosition`). A gun firing fast is heard
// pass so often and no more.
export const FLYBY_NEAR = 12;
export const FLYBY_VOLUME = { 'flyby-bullet': .12, 'flyby-shell': .25 };
const FLYBY_OLD = .2; // seconds a round has flown at its nearest, to be one that came from elsewhere
const FLYBY_GAP = { 'flyby-bullet': .25, 'flyby-shell': .25 };
const FLYBY_HISTORY = .5;
const flybyProfile = (shot: SoundShot): FlybyProfile | null => {
  if (shot.fragment || shot.spall) return null;
  const preset = isWeaponId(shot.preset) ? weaponOf(shot.preset) : undefined;
  return ['machinegun', 'autocannon'].includes(shot.weapon || preset?.family || '') ? 'flyby-bullet' : 'flyby-shell';
};
// An artistic speed scale for the existing recording, not a Doppler solver.
// Its full tail plays at this constant rate; a fast pass is shorter and higher.
export const flybyRate = (speed: number): number => Number.isFinite(speed) && speed >= 0 ? clamp((speed / 600) ** .18, .65, 1.45) : 1;
// A gun turning faster than this, in radians a second, is heard; at SERVO_FULL and over, as loud and as fast as its motor goes.
const SERVO_TURNING = .03, SERVO_FULL = .8;
// Bring quiet field effects forward by 3 dB before the existing peak protection.
// Alerts and music keep their separate gains; no output makeup follows the limiter.
const FIELD_LEVEL = 10 ** (3 / 20);
// How loud a sound of the interface is beside the volume of the sounds.
const CUE_LEVEL = .5;
// How far a gun's shot is heard at half its loudness grows with its calibre: MUZZLE_REACH metres times the calibre in
// millimetres to the power MUZZLE_GROWTH — 135 m for a 7.62, 185 m for a 12.7, 700 m for a 120 and 820 m for a 155.
export const MUZZLE_REACH = 40, MUZZLE_GROWTH = .6;
// A gun's shot is louder by MUZZLE_STEP decibels for every doubling of its calibre, as the ear weighs it (A-weighted, at
// its loudest eighth of a second): its volume, MUZZLE_LOUDEST for a 155, falls by that step down to the smallest, and
// the level of each recording (sound-art.ts) sets a 7.62, a 12.7, a 25 and a 120 on that same line. A shot echoes
// (`echo`, see ECHO_SPREAD) as big as its gun: all of it for a 155, and as the square root of the calibre below.
export const MUZZLE_STEP = 3.5, MUZZLE_LOUDEST = .9;
export const muzzleVolume = (caliber: number): number => MUZZLE_LOUDEST * (caliber / 155) ** (MUZZLE_STEP / (20 * Math.log10(2)));
// A blast echoes as the square root of its power, all of it from BLAST_ECHO on: from as loud as a blast is heard.
const BLAST_ECHO = 700;
// The cues of the interface, each a profile of the bank (sound-art.ts): an enemy that came into the squad's senses, and
// bad news of a vehicle.
export const ALERTS = Object.freeze({ contact: 'alert-contact', grave: 'alert-grave' });
export const ALERT_GAP = 1.5; // seconds before a cue is played again
// Every cue is heard for as long as its recording lasts. A round is heard strike as hard as the power it has left:
// a glancing one or one into the ground no louder than one stopped by a plate. A body that lands hard on the ground
// is heard by the work of its landing. A shot and a blast echo over the field (`echo`) as big as they are, the rest
// not at all.
const caliberByWeapon: Readonly<Record<string, number>> = { machinegun: 12.7, autocannon: 25, cannon: 120, rocket: 84 };
export function soundCue(event: SoundCueEvent): SoundCue | null {
  const metal = !['concrete', 'ceramic', 'fiberglass', 'glass', 'plastic', 'rubber', 'soil'].includes(event.material || ''),
    strike = (event.power || 40) / 750;
  const cue = (profile: SoundProfileName, filter: number, volume: number, priority: number, reach = 0, echo = 0): SoundCue => ({ profile, duration: SOUND_PROFILES[profile].duration, filter, volume, priority, ...reach && { reach }, ...echo && { echo } });
  if (event.type === 'muzzle') {
    const caliber = event.caliberMm || caliberByWeapon[event.weapon || ''] || 25;
    const profile = event.weapon === 'rocket' ? 'rocket' : ['mortar', 'grenade'].includes(event.weapon || '') ? 'gun-lob' : caliber >= 60 ? 'gun-cannon' : caliber >= 18 ? 'gun-auto' : caliber >= 10 ? 'gun-heavy' : 'gun-light';
    const echo = Math.min(1, Math.sqrt(caliber / 155) * (profile === 'gun-auto' ? 1.75 : 1));
    return cue(profile, profile === 'rocket' ? 5500 : 12500, muzzleVolume(caliber), 3, MUZZLE_REACH * caliber ** MUZZLE_GROWTH, echo);
  }
  if (event.type === 'explosion') {
    const power = Math.max(0, event.power ?? 600), fuel = (event.sourceKind || event.kind || event.source) === 'fuel';
    return cue(fuel || power >= 220 ? 'blast-heavy' : 'blast-small', 11000, clamp(.33 + Math.sqrt(power / 600) * .57, .35, .95), 4, 0, Math.min(1, Math.sqrt(power / BLAST_ECHO)));
  }
  const ground = (volume: number, priority: number): SoundCue => cue('ground-hit', ['concrete', 'asphalt'].includes(event.surface || '') ? 6500 : 2300, volume, priority);
  if (event.type === 'ricochet') return event.ground ? ground(clamp(strike, .05, .15), 2) : cue('ricochet', 12000, clamp(strike, .08, .24), 2);
  if (['blocked', 'penetration'].includes(event.type)) {
    const profile = !metal ? 'hard-hit' : (event.caliberMm ?? 0) >= 25 ? 'metal-hit-heavy' : 'metal-hit';
    return cue(profile, metal ? 10000 : 4800, clamp(strike, .08, .5), 1);
  }
  if (event.type === 'module') return cue('mechanical', 6500, .18, 2);
  if (event.type === 'destroyed') return cue('breakup', 6500, .2, 2);
  if (event.type === 'suspension') return cue('suspension', 3200, .04 + .14 * Math.sqrt(clamp(event.strength || 0, 0, 1)), 1);
  if (event.type === 'ground') return event.contactPair
    ? cue('suspension', 4000, clamp(Math.log1p(Math.max(0, event.impactEnergy || 0)) / 75, .03, .14), 1)
    : ground(clamp(strike, .05, .14), 1);
  if (event.type === 'debris') return cue(metal ? 'clunk' : 'hard-hit', metal ? 8000 : 3000, finite(event.impactEnergy) ? clamp(Math.log1p(Math.max(0, event.impactEnergy)) / 32, .02, .24) : clamp((event.impulse || 0) / 2600, .04, .24), 1);
  return null;
}
// The player hears the field from a place, his ears (`hearing`): with the crew of the vehicle in his hands while the
// view shows it, or just beside it; else from the middle of the view. They stand out of the screen, as far as a
// quarter of the width the view shows (EAR_DEPTH) and no nearer than EAR_NEAREST metres: the wider the view, the
// further they stand from all it shows. The crew's stand at the vehicle while the view is no wider than CREW_VIEW
// metres, a vehicle and what is about it, and step out as the view opens wider than that.
export const EAR_DEPTH = .25, EAR_NEAREST = 4, CREW_VIEW = 150;
export function hearing(camera: SoundListener, crew: SoundObservation | null | undefined = null): Hearing {
  const zoom = camera.zoom || 1, wide = (camera.width || 0) / zoom, tall = (camera.height || 0) / zoom,
    aboard = crew != null && Math.abs(Number(crew.x) - camera.x) <= wide && Math.abs((crew.y || 0) - (camera.y || 0)) <= tall,
    place = aboard && crew ? crew : camera;
  return { x: Number(place.x), y: place.y || 0, depth: Math.max(EAR_NEAREST, (wide - (aboard ? CREW_VIEW : 0)) * EAR_DEPTH), aboard };
}
// A sound is heard as in the open air, from how far it is from the ears: at half its loudness `reach` metres off (a
// profile's own, sound-art.ts, or a cue's), as the inverse of the distance further, and dying out over some times
// that. The air takes its highs first (ISO 9613-1, 20 °C and 70 % humidity): r metres off, what is over AIR_HIGHS
// /√(r·(1 + r/AIR_MIDDLE)) hertz — 16 kHz at 10 m, 5 kHz at 100 m, 1.1 kHz at a kilometre. It comes from its side
// of the ears (`pan`). What the hills about the field send back of it (`echo`, `echoResponse`) fades the same way
// but ECHO_SPREAD times slower: near, a shot drowns its echo; far off, the echo is most of what is heard of it.
const AIR_HIGHS = 50000, AIR_MIDDLE = 1000, CLEAREST = 16000;
const PAN_NEAR = 12; // metres: ears nearer the screen than this hear a sound from its side as if they stood this far
export const HEARD_LEAST = .01; // a sound fainter than this is not played
export const ECHO_SPREAD = 6;
const faded = (distance: number, reach: number): number => reach / (reach + distance) * Math.exp(-distance / (reach * 8));
export function soundPosition(point: SoundObservation, ears: Hearing, reach = 60) {
  const dx = Number(point.x) - ears.x, distance = Math.hypot(dx, (point.y || 0) - ears.y, ears.depth), volume = faded(distance, reach);
  return { volume: volume < HEARD_LEAST ? 0 : volume, echo: faded(distance, reach * ECHO_SPREAD), pan: .85 * dx / Math.hypot(dx, Math.max(ears.depth, PAN_NEAR)),
    cutoff: Math.min(CLEAREST, AIR_HIGHS / Math.sqrt(distance * (1 + distance / AIR_MIDDLE))) };
}
// The echo of the field, the same for every sound (a convolver plays it, `unlock`): what the hills about it send
// back, the louder for the more of it each sound sends (`echo` of a cue and of its place). The nearest hills are each
// heard as a slap of their own (ECHO_SLAPS: how many seconds late, from which side — -1 the left —, and how loud
// beside the sound itself), the later the duller and the more smeared; after them every slope further off rolls back
// as one low rumble, ECHO_RUMBLE loud, swelling for ECHO_SWELL seconds and dying away over ECHO_FADE seconds after,
// rolling now louder on one side and now on the other (a swell every ECHO_ROLL seconds or so), to ECHO_LENGTH. Each
// comes through as much air as it went further — ECHO_PATH metres for every second late — and over ground and slopes
// that take its highs ECHO_DULL times sooner. The same field always: its rumble is drawn from a fixed seed.
export const ECHO_LENGTH = 3;
const ECHO_SLAPS: readonly (readonly [number, number, number])[] = [[.23, -.7, .13], [.51, .6, .1], [.86, -.3, .07], [1.37, .8, .045]];
const ECHO_RUMBLE = .16, ECHO_START = .12, ECHO_SWELL = .35, ECHO_FADE = .6, ECHO_ROLL = .25, ECHO_PATH = 343, ECHO_DULL = 2;
export function echoResponse(rate: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const length = Math.round(ECHO_LENGTH * rate), sides: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(length), new Float32Array(length)];
  let seed = 20261020;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647, noise = () => random() * 2 - 1,
    pole = (late: number) => 1 - Math.exp(-2 * Math.PI * AIR_HIGHS / ECHO_DULL / Math.sqrt(late * ECHO_PATH * (1 + late * ECHO_PATH / AIR_MIDDLE)) / rate),
    // A sound laid into a side from its sample `first` on, `size` samples long and `loud` over it all: noise swelling
    // as `swell` of the seconds into it says, through the air of its way (both looked up every 64 samples).
    lay = (side: Float32Array, first: number, size: number, loud: number, swell: (t: number) => number): void => {
      const sound = new Float32Array(size); let one = 0, two = 0, energy = 0;
      for (let i = 0, a = 0, shape = 0; i < size; i++) {
        if (i % 64 === 0) { a = pole((first + i) / rate); shape = swell(i / rate); }
        one += a * (noise() * shape - one); two += a * (one - two); sound[i] = two; energy += two * two;
      }
      const scale = loud / Math.sqrt(energy || 1);
      for (let i = 0; i < size && first + i < length; i++) side[first + i] = (side[first + i] ?? 0) + (sound[i] ?? 0) * scale;
    };
  for (const [late, side, loud] of ECHO_SLAPS) {
    const smear = .004 + .008 * late, angle = (side + 1) * Math.PI / 4;
    for (const [sideSamples, share] of [[sides[0], Math.cos(angle)], [sides[1], Math.sin(angle)]] satisfies [Float32Array, number][])
      lay(sideSamples, Math.round(late * rate), Math.round(smear * 6 * rate), loud * share, t => Math.exp(-t / smear));
  }
  for (const side of sides) {
    const swells: [number, number][] = [];
    for (let t = random() * ECHO_ROLL; t < ECHO_LENGTH; t += ECHO_ROLL * (.5 + random())) swells.push([t, .3 + random()]);
    const roll = (t: number): number => .35 + swells.reduce((sum, [at, height]) => sum + height * Math.exp(-(((t - at) / (ECHO_ROLL * .4)) ** 2)), 0);
    lay(side, Math.round(ECHO_START * rate), length - Math.round(ECHO_START * rate), ECHO_RUMBLE * Math.SQRT1_2,
      t => (1 - Math.exp(-t / ECHO_SWELL)) * Math.exp(-t / ECHO_FADE) * roll(t));
  }
  return sides;
}

// Different emitters start at stable phases of the same recording, so engines
// do not all pulse in unison. Identity changes only the offset, never the timbre or rate.
function loopPhase(id: string | null): number {
  let hash = 2166136261;
  for (const c of String(id)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0) / 4294967296;
}
// A loop of the bank (sound-art.ts), starting within its padded loop region.
function startLoop(ctx: SoundContext, buffer: AudioBuffer, name: SoundProfileName, id: string | null, at = ctx.currentTime): AudioBufferSourceNode {
  const source = ctx.createBufferSource(), length = SOUND_PROFILES[name].duration;
  source.buffer = buffer; source.loop = true; source.loopStart = LOOP_PAD; source.loopEnd = LOOP_PAD + length;
  source.start(at, LOOP_PAD + loopPhase(id) * length);
  return source;
}
function stopLoop(loop: SoundLoop): void {
  for (const source of loop.sources) { try { source.stop(); } catch {} }
  for (const node of loop.nodes) node.disconnect();
}
interface SoundParam extends AudioParam { soundTarget?: number }
function resetApproach(parameter: SoundParam): void { delete parameter.soundTarget; }
function approach(parameter: SoundParam, value: number, now: number, smoothing = .1): void {
  // Do not enqueue identical automation sixty times a second on idle loops.
  const target = parameter.soundTarget;
  if (target === undefined || !Number.isFinite(target) || Math.abs(target - value) > .001) {
    parameter.soundTarget = value; parameter.setTargetAtTime(value, now, smoothing);
  }
}

// The sounds of the world are the recordings of the bank (sound-art.ts), read once; impact voices and engine loops
// are bounded independently of visual particle and rigid body counts.
// `sounds` is where the bank reads them (`files` by profile, and how a file is `load`ed); `music` is what
// the soundtrack is made with (soundtrack.ts: its tracks by mood). Without them the game has none.
export class SoundSystem {
  declare readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  declare readonly contextFactory: () => SoundContext;
  declare readonly soundsMade: SoundBufferOptions;
  declare readonly musicMade: Omit<SoundtrackOptions, 'context' | 'output'> | null;
  declare enabled: boolean;
  declare musicOn: boolean;
  declare volume: number;
  declare backgroundAlerts: boolean;
  declare active: boolean;
  declare shown: boolean;
  declare unavailable: boolean;
  declare context: SoundContext | null;
  declare readonly voices: SoundVoice[];
  declare readonly engines: Map<string, EngineLoop>;
  declare readonly fires: Map<string, PannedLoop>;
  declare readonly fireEmitters: Map<string, FireEmitter>;
  declare readonly contactGate: ContactSoundGate;
  declare readonly suspensionGate: SuspensionSoundGate;
  declare readonly recentEvents: Map<string, number>;
  declare ears: Hearing;
  declare readonly chains: VoiceChain[];
  declare lastStateTime: number | null;
  declare alerted: Partial<Record<AlertKind, number>>;
  declare alertVoice: AlertVoice | null;
  declare mood: MoodName | null;
  declare readonly flybys: Map<number, FlybyHistory>;
  declare flybyAt: Partial<Record<FlybyProfile, number>>;
  declare flybySample: FlybySample | null;
  declare flybyListener: { key: string; vx: number | undefined; vy: number | undefined };
  declare readonly loads: Map<string, { load: number; until: number }>;
  declare readonly lifts: Map<string, number>;
  declare readonly pours: Map<string, PlaceLoop>;
  declare readonly servos: Map<string, PlaceLoop>;
  declare readonly works: Map<string, PlaceLoop>;
  declare barrels: Map<string, { angle: number; time: number; speed: number; }> | undefined;
  declare master?: GainNode;
  declare alertBus?: GainNode;
  declare ambience?: GainNode;
  declare loopDuck?: GainNode;
  declare echo?: ConvolverNode;
  declare bank?: SoundBufferBank;
  declare preparing?: Promise<void>;
  declare musicBus?: GainNode;
  declare soundtrack?: Soundtrack;
  declare masterTarget?: number;
  declare alertTarget?: number;
  declare musicTarget?: number;
  declare onChange?: () => void;
  declare beats: { time: number; at: number; lag: number; longest: number } | null | undefined;
  constructor({ storage, contextFactory, sounds = {}, music = null }: SoundSystemOptions = {}) {
    if (!storage) { try { storage = globalThis.localStorage; } catch {} }
    this.storage = storage; this.contextFactory = contextFactory || (() => {
      // Older Safari publishes the same Web Audio constructor under its prefix.
      const audioWindow: typeof globalThis & { webkitAudioContext?: typeof AudioContext } = globalThis;
      const Context = audioWindow.AudioContext || audioWindow.webkitAudioContext;
      if (!Context) throw new Error('Web Audio is unavailable');
      return new Context();
    });
    let prefs: { enabled?: unknown; music?: unknown; volume?: unknown; backgroundAlerts?: unknown } = {};
    try {
      const saved: unknown = JSON.parse(storage?.getItem('impacto.sound.v1') || '{}');
      if (saved && typeof saved === 'object') prefs = {
        enabled: 'enabled' in saved ? saved.enabled : undefined,
        music: 'music' in saved ? saved.music : undefined,
        volume: 'volume' in saved ? saved.volume : undefined,
        backgroundAlerts: 'backgroundAlerts' in saved ? saved.backgroundAlerts : undefined,
      };
    } catch {}
    this.enabled = prefs.enabled !== false; this.musicOn = prefs.music !== false; this.volume = clamp(typeof prefs.volume === 'number' && Number.isFinite(prefs.volume) ? prefs.volume : 0.35, 0, 1);
    this.backgroundAlerts = prefs.backgroundAlerts !== false;
    this.active = false; this.voices = []; this.engines = new Map(); this.fires = new Map(); this.fireEmitters = new Map(); this.contactGate = new ContactSoundGate(); this.suspensionGate = new SuspensionSoundGate(); this.recentEvents = new Map();
    this.ears = { x: 12, y: 1.5, depth: EAR_NEAREST, aboard: false }; this.chains = []; this.context = null; this.unavailable = false; this.lastStateTime = null; this.alerted = {}; this.alertVoice = null;
    this.soundsMade = sounds; this.musicMade = music; this.mood = null; this.shown = true;
    this.flybys = new Map(); this.flybyAt = {}; this.flybySample = null; this.flybyListener = { key: 'view', vx: 0, vy: 0 };
    this.loads = new Map(); this.lifts = new Map(); this.pours = new Map(); this.servos = new Map(); this.works = new Map();
  }
  persist(): void { try { this.storage?.setItem('impacto.sound.v1', JSON.stringify({ enabled: this.enabled, music: this.musicOn, volume: this.volume, backgroundAlerts: this.backgroundAlerts })); } catch {} }
  async unlock(): Promise<void> {
    if (!this.enabled || this.unavailable) return;
    if (this.context?.state === 'running' && this.bank?.ready) return;
    try {
      if (!this.context) {
        const ctx = this.contextFactory(); this.context = ctx;
        this.master = ctx.createGain(); this.master.gain.value = 0;
        const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -12; compressor.knee.value = 18; compressor.ratio.value = 6;
        const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -4; limiter.knee.value = 0; limiter.ratio.value = 20;
        if (limiter.attack) limiter.attack.value = 0;
        if (limiter.release) limiter.release.value = .08;
        // Linear headroom after compression contains peaks from coincident explosions.
        const output = ctx.createGain(); output.gain.value = .85;
        this.master.connect(compressor); compressor.connect(limiter); limiter.connect(output); output.connect(ctx.destination);
        // The two notification cues have their own volume gate. They can be heard with the tab hidden
        // without reopening the field, its echo or its loops, and retain the same compressor and limiter.
        this.alertBus = ctx.createGain(); this.alertBus.gain.value = 0; this.alertBus.connect(compressor);
        this.ambience = ctx.createGain(); this.loopDuck = ctx.createGain(); this.ambience.gain.value = 1; this.loopDuck.gain.value = 1;
        this.ambience.connect(this.loopDuck); this.loopDuck.connect(this.master);
        // The field's echo, made once: every voice sends it its share (`chain`).
        const [left, right] = echoResponse(ctx.sampleRate), field = ctx.createBuffer(2, left.length, ctx.sampleRate);
        field.getChannelData(0).set(left); field.getChannelData(1).set(right);
        this.echo = ctx.createConvolver(); this.echo.normalize = false; this.echo.buffer = field; this.echo.connect(this.master);
        this.bank = new SoundBufferBank(ctx, this.soundsMade); this.preparing = this.bank.prepare();
        if (this.musicMade) {
          this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0; this.musicBus.connect(ctx.destination);
          this.soundtrack = new Soundtrack({ ...this.musicMade, context: ctx, output: this.musicBus }); this.soundtrack.setMood(this.mood);
        }
      }
      if (this.context.state === 'suspended') await this.context.resume();
      await this.preparing;
      this.updateMaster(); this.updateMusic(); this.onChange?.();
    } catch { this.unavailable = true; this.onChange?.(); }
  }
  get alertsActive(): boolean { return this.enabled && (this.shown ? this.active : this.backgroundAlerts); }
  updateMaster(): void {
    const target = this.enabled && this.active && this.shown ? this.volume * FIELD_LEVEL : 0,
      alertTarget = this.alertsActive ? this.volume : 0;
    if (this.context && this.master && target !== this.masterTarget) { this.masterTarget = target; this.master.gain.setTargetAtTime(target, this.context.currentTime, 0.02); }
    if (this.context && this.alertBus && alertTarget !== this.alertTarget) { this.alertTarget = alertTarget; this.alertBus.gain.setTargetAtTime(alertTarget, this.context.currentTime, .02); }
    if (!alertTarget && this.alertVoice) this.endVoice(this.alertVoice);
  }
  // The music goes by the switch and the volume of the sounds, and by its own switch (the music alone off, the sounds
  // on), but not by the world: it plays at the bench, where no world is shown, and while the game is paused. A page
  // out of sight has no music; only the separate notification channel can remain audible.
  updateMusic(): void {
    if (!this.soundtrack || !this.context || !this.musicBus) return;
    const heard = this.enabled && this.musicOn && this.shown && this.context.state === 'running', target = heard ? this.volume * MUSIC_LEVEL : 0;
    if (target !== this.musicTarget) { this.musicTarget = target; this.musicBus.gain.setTargetAtTime(target, this.context.currentTime, .05); }
    this.soundtrack.setPlaying(heard);
  }
  // The mood of the moment (soundtrack.ts), told as often as it is known.
  setMood(mood: MoodName | null): void { if (mood !== this.mood) { this.mood = mood; this.soundtrack?.setMood(mood); } }
  setShown(value: boolean): void {
    this.shown = Boolean(value);
    if (!this.shown) this.stop({ keepAlerts: this.alertsActive && this.volume > 0 });
    this.updateMaster(); this.updateMusic();
  }
  setEnabled(value: boolean): void { this.enabled = Boolean(value); if (!value) this.stop(); this.updateMaster(); this.updateMusic(); this.persist(); this.onChange?.(); }
  setMusic(value: boolean): void { this.musicOn = Boolean(value); this.updateMusic(); this.persist(); this.onChange?.(); }
  setBackgroundAlerts(value: boolean): void { this.backgroundAlerts = Boolean(value); this.updateMaster(); this.persist(); this.onChange?.(); }
  setVolume(value: number): void { this.volume = clamp(Number(value) || 0, 0, 1); this.updateMaster(); this.updateMusic(); this.persist(); this.onChange?.(); }
  setActive(value: boolean): void { this.active = Boolean(value); if (!value) this.stop({ keepAlerts: this.alertsActive && this.volume > 0 }); this.updateMaster(); }
  stop({ keepAlerts = false }: { keepAlerts?: boolean } = {}): void {
    for (const voice of [...this.voices]) if (!keepAlerts || !('alertKind' in voice)) this.endVoice(voice);
    for (const engine of this.engines.values()) stopLoop(engine);
    for (const fire of this.fires.values()) stopLoop(fire);
    for (const loop of [...this.pours.values(), ...this.servos.values(), ...this.works.values()]) stopLoop(loop);
    this.engines.clear(); this.fires.clear(); this.fireEmitters.clear(); this.pours.clear(); this.servos.clear(); this.works.clear(); this.loads.clear(); this.lifts.clear(); this.flybys.clear(); this.flybyAt = {};
    this.flybySample = null;
    if (this.loopDuck && this.context) { this.loopDuck.gain.cancelScheduledValues?.(this.context.currentTime); this.loopDuck.gain.setValueAtTime(1, this.context.currentTime); }
    this.contactGate.clear(); this.suspensionGate.clear(); this.recentEvents.clear(); this.lastStateTime = null; this.beats = null;
  }
  endVoice(voice: SoundVoice): void {
    if (voice.ended) return; voice.ended = true;
    if (this.alertVoice === voice) this.alertVoice = null;
    const i = this.voices.indexOf(voice); if (i >= 0) this.voices.splice(i, 1);
    if ('chain' in voice && voice.chain.voice === voice) voice.chain.voice = null;
    for (const source of voice.sources) { try { source.stop(); } catch {} }
    voice.nodes.forEach(n => n.disconnect());
  }
  // Room for a voice of `priority` starting `at`, among those still sounding then (MAX_SOUND_VOICES).
  reserveVoice(priority: number, at = this.context?.currentTime ?? 0): boolean {
    const sounding = this.voices.filter(v => v.endAt > at);
    if (sounding.length < MAX_SOUND_VOICES) return true;
    const lowest = sounding.reduce((a, b) => a.priority <= b.priority ? a : b);
    if (lowest.priority > priority) return false;
    this.giveWay(lowest, at); return true;
  }
  // A voice gives way to one starting `at`: a recording falls silent then, in FADE seconds as at its end, and one not
  // begun by then is not heard; anything else stops.
  giveWay(voice: SoundVoice, at: number): void {
    if (!('chain' in voice) || voice.at >= at) { this.endVoice(voice); return; }
    voice.endAt = Math.min(voice.endAt, at + FADE); this.shape(voice, this.context?.currentTime ?? at); voice.sources[0].stop(voice.endAt);
  }
  // A cue of the interface (`ALERTS`), not a sound of the field: it has no place to be heard from, and is as loud
  // wherever the camera is. Alerts share one voice: grave interrupts contact,
  // while contact waits for the next event after grave ends. The game's mute and each kind's repeat gap still apply.
  alert(kind: AlertKind): void {
    const ctx = this.context, profile = ALERTS[kind];
    if (!profile || !ctx || !this.alertBus || ctx.state !== 'running' || !this.alertsActive || !(this.volume > 0) || !this.bank?.ready) return;
    const now = ctx.currentTime;
    if (this.alertVoice && this.alertVoice.endAt <= now) this.endVoice(this.alertVoice);
    if (this.alertVoice && (kind !== 'grave' || this.alertVoice.alertKind === 'grave')) return;
    const buffer = this.bank.get(profile);
    if (!buffer || now - (this.alerted[kind] ?? -Infinity) < ALERT_GAP) return;
    if (this.alertVoice) this.endVoice(this.alertVoice);
    if (!this.reserveVoice(5)) return;
    this.alerted[kind] = now;
    const { duration, level } = SOUND_PROFILES[profile], source = ctx.createBufferSource(), gain = ctx.createGain();
    source.buffer = buffer; gain.gain.value = level;
    source.connect(gain); gain.connect(this.alertBus); source.start(now); source.stop(now + duration);
    const voice: AlertVoice = { alertKind: kind, priority: 5, endAt: now + duration, sources: [source], nodes: [source, gain] };
    this.alertVoice = voice;
    this.voices.push(voice); source.onended = () => this.endVoice(voice);
  }
  // A sound of the field, from where it happened (`soundPosition`), `beat` seconds from now (`receive`). A recording
  // plays through a chain of the voices' own — a filter for the air, a gain, a side, and its share of the field's echo
  // (`echo` of the cue, louder against the sound the further off it is) — made once and kept: a sound makes one node,
  // its source. See MAX_PROFILE_VOICES for many of one sound at once.
  play(event: SoundObservation & Partial<SoundCueEvent>, cue: SoundCue | null, beat = 0, followActor: string | null = null): FieldVoice | undefined {
    const ctx = this.context, profile: SoundProfile | null = cue && SOUND_PROFILES[cue.profile],
      heard = cue && profile && soundPosition(event, this.ears, cue.reach || profile.reach);
    if (!this.shown || !cue || !heard || !this.loopDuck || !this.master || !this.echo || cue.volume * heard.volume < HEARD_LEAST || !ctx || ctx.state !== 'running' || !this.bank?.ready) return;
    const buffer = this.bank.get(cue.profile);
    if (!buffer) return;
    const now = ctx.currentTime, at = now + beat, x = event.x, y = event.y || 0, gun = event.type === 'muzzle' && (event.componentId || event.id) || null,
      level = cue.volume * heard.volume * SOUND_PROFILES[cue.profile].level,
      kin = () => this.voices.filter((v): v is FieldVoice => 'profile' in v && v.profile === cue.profile && v.endAt > at),
      twin = kin().find(v => (v.follow?.actor ?? null) === followActor && Math.abs(v.at - at) < TOGETHER && Math.hypot(Number(v.x) - Number(x), v.y - y) < MERGE_REACH && !(gun && v.gun === gun));
    if (twin) {
      twin.loudest = Math.max(twin.loudest, level); twin.level = Math.min(Math.hypot(twin.level, level), twin.loudest * SWELL_MOST);
      this.shape(twin, now); return;
    }
    if (kin().length >= MAX_PROFILE_VOICES) {
      const oldest = kin().reduce((a, b) => a.at <= b.at ? a : b);
      if (oldest.priority > cue.priority) return;
      this.giveWay(oldest, at);
    }
    if (!this.reserveVoice(cue.priority, at)) return;
    if (event.type === 'explosion') {
      this.loopDuck.gain.cancelScheduledValues?.(now);
      this.loopDuck.gain.setTargetAtTime(.4, at, .008); this.loopDuck.gain.setTargetAtTime(1, at + .15, .2);
    }
    const looping = cue.loop === true, rate = !looping && finite(cue.rate) && cue.rate > 0 ? clamp(cue.rate, .25, 4) : 1,
      together = looping ? 0 : kin().filter(v => Math.abs(v.at - at) < TOGETHER).length,
      chain = this.chains.find(c => !c.voice) || this.chain(ctx, this.master, this.echo),
      source = looping ? startLoop(ctx, buffer, cue.profile, followActor, at) : ctx.createBufferSource();
    if (!looping) { source.buffer = buffer; source.playbackRate.setValueAtTime(rate, at); }
    source.connect(chain.filter);
    for (const [parameter, value] of [[chain.filter.frequency, Math.min(cue.filter, heard.cutoff)], [chain.pan.pan, heard.pan],
      [chain.echo.gain, (cue.echo || 0) * heard.echo / heard.volume]] satisfies [AudioParam, number][]) {
      parameter.cancelScheduledValues(now); parameter.setValueAtTime(value, at);
    }
    const voice: FieldVoice = { profile: cue.profile, priority: cue.priority, at, endAt: looping ? Infinity : at + cue.duration / rate, x, y, gun, level: level / Math.sqrt(1 + together), loudest: level,
      chain, sources: [source], nodes: [source],
      ...(looping && { loop: true }), ...(followActor !== null && { follow: { actor: followActor } }) };
    if (looping) {
      chain.gain.gain.cancelScheduledValues(now); chain.gain.gain.setValueAtTime(0, at);
      resetApproach(chain.gain.gain);
    }
    chain.voice = voice; this.shape(voice, now);
    this.voices.push(voice); source.onended = () => this.endVoice(voice);
    if (!looping) { source.start(at); source.stop(voice.endAt); }
    return voice;
  }
  // The loudness of a voice from its start, to a fade at its end.
  shape(voice: FieldVoice, now: number): void {
    const gain = voice.chain.gain.gain, level = Math.max(.0001, voice.level);
    if (voice.loop && voice.endAt === Infinity) {
      approach(gain, voice.level, Math.max(now, voice.at), driveEase(voice.profile)); return;
    }
    if (voice.loop) {
      const fading = Math.max(now, voice.endAt - FADE);
      gain.cancelScheduledValues(fading); gain.setTargetAtTime(0, fading, FADE / 8); return;
    }
    gain.cancelScheduledValues(now); gain.setValueAtTime(level, Math.max(now, voice.at));
    gain.setValueAtTime(level, Math.max(now, voice.endAt - FADE)); gain.exponentialRampToValueAtTime(.0001, voice.endAt);
  }
  chain(ctx: SoundContext, master: GainNode, echo: ConvolverNode): VoiceChain {
    const chain: VoiceChain = { filter: ctx.createBiquadFilter(), gain: ctx.createGain(), pan: ctx.createStereoPanner(), echo: ctx.createGain(), voice: null };
    chain.filter.type = 'lowpass'; chain.gain.gain.value = 0; chain.echo.gain.value = 0;
    chain.filter.connect(chain.gain); chain.gain.connect(chain.pan); chain.pan.connect(master);
    chain.gain.connect(chain.echo); chain.echo.connect(echo);
    this.chains.push(chain); return chain;
  }
  // The engines of the vehicles as they go at `time`, each turned by a gearbox of its own (gearbox.ts): ahead or backing
  // (against the way it faces), pressed on, braking and climbing as its vehicle is. Not that of a vehicle in the air
  // (`flying`): its keys ask its flight computer, and its engine, there for its tools, turns nothing and burns nothing
  // there (game.rs) — heard so, it would rev as fast as it flies. Its thrusters are heard (`updateDriveVoices`).
  updateEngines(state: AudioState, time: number): void {
    const ctx = this.context;
    if (!ctx || !this.bank || !this.ambience) return;
    const trackedActors = new Set((state.modules || []).filter(m => m.kind === 'track' && Number(m.health) > 0 && m.attached !== false).map(m => m.actorId));
    const heard = (state.actors || []).filter((a): a is VehicleActor => hasVehicle(a) && Boolean(a.vehicle.engine) && !a.vehicle.flying).map(actor => {
      const voice = engineVoice(actor.vehicle.powerKw);
      return { actor, voice, position: soundPosition(actor.vehicle, this.ears, voice.reach) };
    }).filter(e => e.position.volume >= 0.02).sort((a, b) => b.position.volume * b.voice.volume - a.position.volume * a.voice.volume).slice(0, MAX_ENGINE_LOOPS);
    const wanted = new Set(heard.map(e => e.actor.id));
    for (const [id, e] of this.engines) if (!wanted.has(id)) { stopLoop(e); this.engines.delete(id); }
    for (const { actor, voice, position } of heard) {
      const body = actor.vehicle, tracked = trackedActors.has(actor.id); let engine = this.engines.get(actor.id);
      if (engine && engine.tracked !== tracked) { stopLoop(engine); this.engines.delete(actor.id); engine = undefined; }
      if (!engine) {
        const gear = tracked ? 'tracks' : 'wheels',
          motorSound = this.bank.get('diesel'), gearSound = this.bank.get(gear);
        if (!motorSound || !gearSound) continue;
        const motor = startLoop(ctx, motorSound, 'diesel', actor.id);
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1400;
        const gain = ctx.createGain(); gain.gain.value = 0;
        const pan = ctx.createStereoPanner(); motor.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.ambience);
        const rolling = startLoop(ctx, gearSound, gear, actor.id);
        const rollFilter = ctx.createBiquadFilter(); rollFilter.type = 'lowpass'; rollFilter.frequency.value = 2500;
        const rollGain = ctx.createGain(); rollGain.gain.value = 0; rolling.connect(rollFilter); rollFilter.connect(rollGain); rollGain.connect(pan);
        engine = { motor, filter, gain, pan, rolling, rollFilter, rollGain, tracked, gearbox: new Gearbox(tracked), level: 0, turboLevel: 0, sources: [motor, rolling], nodes: [motor, filter, gain, pan, rolling, rollFilter, rollGain] }; this.engines.set(actor.id, engine);
      }
      const now = ctx.currentTime, throttle = body.throttle, told = finite(throttle), facing = actor.facing === 1 ? 1 : -1,
        along = (body.vx || 0) * Math.cos(body.angle || 0) + (body.vy || 0) * Math.sin(body.angle || 0),
        braking = told && brakesOn(body),
        backing = told && throttle && !braking ? throttle * facing < 0 : along * facing < -CRAWL, way = backing ? -facing : facing,
        pull = told ? braking ? 0 : Math.min(1, Math.abs(throttle)) : Math.abs(along) > CRAWL ? UNSEEN_PULL : 0,
        { turning, dip } = engine.gearbox.update({ speed: Math.max(0, along * way), top: finite(body.maxSpeed) && body.maxSpeed > 0 ? body.maxSpeed : UNSEEN_TOP[tracked ? 'track' : 'wheel'],
          pull, braking, backing, climb: Math.sin(body.groundSlope || 0) * way }, time),
        rise = (turning - ENGINE_IDLE) / (1 - ENGINE_IDLE);
      engine.level = voice.volume * (ENGINE_HUSH + (1 - ENGINE_HUSH) * (.6 * pull + .4 * rise)) * position.volume;
      approach(engine.motor.playbackRate, voice.pitch * ENGINE_RATE * (turning / ENGINE_IDLE) ** ENGINE_RATE_GROWTH, now, ENGINE_EASE);
      approach(engine.filter.frequency, Math.min(position.cutoff, 900 + pull * 950 + rise * 700), now, ENGINE_EASE);
      approach(engine.gain.gain, ENGINE_LOUD * engine.level * (1 - dip) * SOUND_PROFILES.diesel.level, now, ENGINE_EASE);
      approach(engine.pan.pan, position.pan, now);
      const flow = knowsDrive(body) && !braking && finite(body.fuelRate) && body.fuelRate >= 0 && finite(body.powerKw) && body.powerKw > 0
        ? clamp(body.fuelRate / body.powerKw * TURBO_FLOW_GAIN, 0, 1) : 0;
      // RPM colours the measured effort without closing the texture on a shift.
      // The existing eased gain and quiet reuse window retain the current source.
      engine.turboLevel = voice.volume * flow * (.6 + .4 * clamp(rise, 0, 1));
      // The running gear is heard as fast as it turns: a gear that slips where the vehicle stands is not silent. It is as
      // loud beside its engine whatever the power of it: the heavier the vehicle, the louder both.
      const rolled = Math.abs(body.vx || 0) + Math.abs(body.slip || 0);
      approach(engine.rolling.playbackRate, clamp(.4 + rolled * .16, .4, 2.8), now);
      approach(engine.rollFilter.frequency, Math.min(position.cutoff, tracked ? 3400 : 1700), now);
      approach(engine.rollGain.gain, body.traction ? Math.min(tracked ? .22 : .118, rolled * .0346) * voice.volume * position.volume * SOUND_PROFILES[tracked ? 'tracks' : 'wheels'].level : 0, now);
    }
  }
  driveSound(actor: VehicleActor, profile: DriveProfile, volume = 1, point: SoundObservation = actor.vehicle): FieldVoice | undefined {
    const existing = this.voices.find((voice): voice is FieldVoice => 'profile' in voice && voice.loop === true && voice.profile === profile && voice.follow?.actor === actor.id && voice.endAt === Infinity);
    if (existing) return existing;
    // Loops share the ordinary voice budget. They never evict an effect or an alert;
    // even a fading source continues to occupy its slot until it actually ends.
    const now = this.context?.currentTime; if (now === undefined) return;
    let total = 0, same = 0;
    for (const voice of this.voices) if (voice.endAt > now) { total++; if ('profile' in voice && voice.profile === profile) same++; }
    if (same >= MAX_PROFILE_VOICES || total >= MAX_SOUND_VOICES) return;
    const { duration, filter } = SOUND_PROFILES[profile];
    return this.play(point, { profile, duration, filter, volume, priority: 1, loop: true }, 0, actor.id);
  }
  // Current braking, engine load and public jet thrust choose at most four emitters per profile.
  // A quiet loop fades before it is retired, so brief load/pedal changes reuse it.
  updateDriveVoices(state: AudioState): void {
    if (!this.context) return;
    const now = this.context.currentTime, places: DrivePlace[] = [], wanted = new Set<FieldVoice>(), counts = new Map<DriveProfile, number>(), wheels = new Set<string>(),
      jets = new Map<string, { x: number; y: number; weight: number; power: number; thrust: number }>();
    for (const m of state.modules || []) {
      if (!(Number(m.health) > 0) || m.attached === false) continue;
      if (m.kind === 'wheel') wheels.add(m.actorId);
      if (m.kind !== 'thruster' || !(finite(m.thrust) && m.thrust > 0)) continue;
      const thrust = clamp(m.thrust, 0, 1), weight = Math.max(.1, (m.width || .64) * (m.height || 1.31)),
        jet = jets.get(m.actorId) || { x: 0, y: 0, weight: 0, power: 0, thrust: 0 };
      jet.x += m.x * weight; jet.y += m.y * weight; jet.weight += weight;
      jet.power += thrust * thrust * weight; jet.thrust = Math.max(jet.thrust, thrust); jets.set(m.actorId, jet);
    }
    for (const actor of state.actors || []) {
      if (!hasVehicle(actor)) continue;
      const body = actor.vehicle, jet = !actor.ghost && jets.get(actor.id);
      if (body && jet) places.push({ actor, profile: 'jet', volume: Math.min(.32, .18 * Math.sqrt(jet.power)),
        point: { x: jet.x / jet.weight, y: jet.y / jet.weight }, rate: .75 + .35 * Math.sqrt(jet.thrust), cutoff: 1800 + 5200 * jet.thrust });
      if (!knowsDrive(body)) continue;
      const brake = wheels.has(actor.id) ? brakeSquealVolume(body) : 0;
      if (brake > 0) places.push({ actor, profile: 'brake-squeal', volume: brake });
      const turbo = this.engines.get(actor.id)?.turboLevel;
      if (turbo !== undefined && turbo > 0) places.push({ actor, profile: 'engine-turbo', volume: turbo });
    }
    // Match play()'s cue audibility for the soft brake; its profile gain must not
    // impose a second cut on light applications. Turbo keeps its existing gate.
    const heard = places.map(place => {
      const profile = SOUND_PROFILES[place.profile], position = soundPosition(place.point || place.actor.vehicle, this.ears, profile.reach);
      return { ...place, position, level: place.volume * profile.level * position.volume };
    }).filter(place => (place.profile === 'brake-squeal' ? place.volume * place.position.volume : place.level) >= HEARD_LEAST).sort((a, b) => b.level - a.level);
    for (const place of heard) {
      const count = counts.get(place.profile) || 0;
      if (count >= MAX_PROFILE_VOICES) continue;
      counts.set(place.profile, count + 1);
      const voice = this.driveSound(place.actor, place.profile, place.volume, place.point);
      if (!voice) continue;
      wanted.add(voice); delete voice.quietAt;
      const profile = SOUND_PROFILES[place.profile], body = place.point || place.actor.vehicle;
      voice.x = body.x; voice.y = body.y || 0; voice.level = place.level;
      approach(voice.chain.filter.frequency, Math.min(place.cutoff ?? profile.filter, place.position.cutoff), now);
      if (place.rate) approach(voice.sources[0].playbackRate, place.rate, now, .2);
      approach(voice.chain.pan.pan, place.position.pan, now);
      approach(voice.chain.gain.gain, place.level, now, driveEase(place.profile));
    }
    for (const voice of [...this.voices]) if ('profile' in voice && voice.loop && voice.follow && voice.endAt === Infinity && !wanted.has(voice)) {
      voice.quietAt ??= now; voice.level = 0;
      approach(voice.chain.gain.gain, 0, now, driveEase(voice.profile));
      if (now - voice.quietAt >= DRIVE_REST) this.endVoice(voice);
    }
  }
  updateFires(state: AudioState, events: readonly SoundCueEvent[] | null | undefined, index: AudioIndex): void {
    const time = state.time || 0, ctx = this.context;
    if (!ctx || !this.bank || !this.ambience) return;
    for (const event of events || []) {
      if (event.type !== 'burn' || typeof event.x !== 'number' || typeof event.y !== 'number') continue;
      const stamp = finite(event.time) ? event.time : time;
      if (stamp < time - .3) continue;
      const key = `${event.actorId || ''}:${event.componentId || event.id || `${Math.round(event.x * 4)},${Math.round(event.y * 4)}`}`,
        previous = this.fireEmitters.get(key);
      if (previous && stamp <= previous.time) continue;
      this.fireEmitters.delete(key);
      this.fireEmitters.set(key, { x: event.x, y: event.y, actorId: event.actorId, actorObserved: previous?.actorObserved || Boolean(event.actorId && index.actors.has(event.actorId)), componentId: event.componentId || event.id, strength: clamp(event.strength ?? .7, 0, 1), time: stamp });
      while (this.fireEmitters.size > MAX_FIRE_EMITTERS) { const oldest = this.fireEmitters.keys().next(); if (oldest.done) break; this.fireEmitters.delete(oldest.value); }
    }
    const candidates = [];
    for (const [key, emitter] of this.fireEmitters) {
      const module = index.get(emitter.componentId, 'module');
      if (time - emitter.time > .3 || module?.burning === false || emitter.actorObserved && !(emitter.actorId && index.actors.has(emitter.actorId))) { this.fireEmitters.delete(key); continue; }
      const position = soundPosition(module || emitter, this.ears, SOUND_PROFILES.fire.reach), level = position.volume * emitter.strength;
      if (level >= .015) candidates.push({ key, emitter, position, level });
    }
    candidates.sort((a, b) => b.level - a.level); candidates.length = Math.min(candidates.length, MAX_FIRE_LOOPS);
    const wanted = new Set(candidates.map(c => c.key));
    for (const [key, fire] of this.fires) if (!wanted.has(key)) { stopLoop(fire); this.fires.delete(key); }
    for (const { key, emitter, position, level } of candidates) {
      let fire = this.fires.get(key);
      if (!fire) {
        const sound = this.bank.get('fire'); if (!sound) continue;
        const source = startLoop(ctx, sound, 'fire', key);
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = position.cutoff;
        const gain = ctx.createGain(); gain.gain.value = 0;
        const pan = ctx.createStereoPanner(); pan.pan.value = position.pan;
        source.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.ambience);
        fire = { filter, gain, pan, sources: [source], nodes: [source, filter, gain, pan] }; this.fires.set(key, fire);
      }
      approach(fire.gain.gain, .14 * level * SOUND_PROFILES.fire.level, ctx.currentTime, .12);
      approach(fire.filter.frequency, Math.min(7500, position.cutoff), ctx.currentTime);
      approach(fire.pan.pan, position.pan, ctx.currentTime);
    }
  }
  // A sound of the bank as the interface plays it (a part put in place in the workshop): from the middle, as loud as
  // the sounds are set, whether a world is shown or not.
  cue(profile: SoundProfileName): void {
    const ctx = this.context, buffer = this.enabled && this.shown && ctx?.state === 'running' && this.bank?.ready && this.bank.get(profile);
    if (!buffer || !ctx) return;
    const source = ctx.createBufferSource(), gain = ctx.createGain(); source.buffer = buffer;
    gain.gain.value = this.volume * CUE_LEVEL * SOUND_PROFILES[profile].level;
    source.connect(gain); gain.connect(ctx.destination); source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start(); source.stop(ctx.currentTime + SOUND_PROFILES[profile].duration);
  }
  // The rounds of the frame on screen (`shots`, those the view shows as rounds), each followed for its nearest to the
  // place of the ears; see FLYBY_NEAR.
  updateFlybys(shots: readonly SoundShot[] | null | undefined, time: number): void {
    const ears = this.ears, motion = this.flybyListener, previous = this.flybySample,
      dt = previous ? time - previous.time : 0, shift = previous ? Math.hypot(ears.x - previous.x, ears.y - previous.y) : 0,
      aboard = motion.key !== 'view', speed = Math.hypot(motion.vx || 0, motion.vy || 0),
      reset = previous && (motion.key !== previous.key || dt < 0 || dt > FLYBY_HISTORY ||
        (aboard ? shift > Math.max(5, speed * Math.max(0, dt) * 2 + 1) : shift > Math.max(5,120*Math.max(0,dt))));
    if (!Number.isFinite(time) || !Number.isFinite(ears.x + ears.y)) return;
    if (reset) { this.flybys.clear(); if (dt < 0) this.flybyAt = {}; }
    else if (previous && dt === 0) return;
    this.flybySample = { key: motion.key, x: ears.x, y: ears.y, time };
    const near = Math.max(FLYBY_NEAR, ears.depth), seen = new Set<number>();
    for (const shot of shots || []) {
      const number = shot.number ?? shot.n, profile = flybyProfile(shot);
      if (number == null || !profile || !Number.isFinite(shot.x + shot.y)) continue;
      seen.add(number);
      const was = this.flybys.get(number), step = was ? time - was.time : 0,
        current = { x: shot.x, y: shot.y, earX: ears.x, earY: ears.y, age: shot.age ?? 0, time, done: was?.done || false };
      this.flybys.set(number, current);
      if (!was || was.done || !(step > 0) || step > FLYBY_HISTORY) continue;
      // The closest point on this relative segment survives a fast round
      // crossing between two pictures. Camera panning is never physical motion.
      const ax = was.x - (aboard ? was.earX : ears.x), ay = was.y - (aboard ? was.earY : ears.y), bx = shot.x - ears.x, by = shot.y - ears.y,
        dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
      if (!(length2 > 1e-12) || bx * dx + by * dy <= 0) continue;
      current.done = true;
      const at = clamp(-(ax * dx + ay * dy) / length2, 0, 1), distance = Math.hypot(ax + dx * at, ay + dy * at),
        age = was.age + (current.age - was.age) * at;
      if (age < FLYBY_OLD || distance > near || time - (this.flybyAt[profile] ?? -Infinity) < FLYBY_GAP[profile]) continue;
      const vx = finite(shot.vx) ? shot.vx : (shot.x - was.x) / step,
        vy = finite(shot.vy) ? shot.vy : (shot.y - was.y) / step,
        earVX = aboard ? finite(motion.vx) ? motion.vx : (ears.x - was.earX) / step : 0,
        earVY = aboard ? finite(motion.vy) ? motion.vy : (ears.y - was.earY) / step : 0,
        rate = flybyRate(Math.hypot(vx - earVX, vy - earVY));
      this.flybyAt[profile] = time;
      this.play({ x: was.x + (shot.x - was.x) * at, y: was.y + (shot.y - was.y) * at, time, id: String(number) },
        { profile, rate, duration: SOUND_PROFILES[profile].duration, filter: 14000,
          volume: FLYBY_VOLUME[profile] * Math.sqrt(1 - distance / near), priority: 1 });
    }
    for (const [number, was] of this.flybys) if (!seen.has(number) && time - was.time > FLYBY_HISTORY) this.flybys.delete(number);
  }
  // A hopper whose load changes is being loaded at a site or emptied at the base or on the ground: the ore pours, for
  // as long as it goes on changing and as long again as its arm goes on working (WORK_HOLD).
  updatePours(state: AudioState, time: number): void {
    const pouring: LoopPlace[] = [], seen = new Set<string>();
    for (const m of state.modules || []) {
      if (m.kind !== 'hopper' || m.attached === false) continue;
      const load = Object.values(m.cargo || {}).reduce((sum, units) => sum + units, 0), was = this.loads.get(m.id);
      seen.add(m.id);
      if (!was) { this.loads.set(m.id, { load, until: -Infinity }); continue; }
      if (Math.abs(load - was.load) > 1e-6) Object.assign(was, { load, until: time + WORK_HOLD });
      if (time < was.until) pouring.push({ key: m.id, x: m.x, y: m.y, level: .16 });
    }
    for (const id of this.loads.keys()) if (!seen.has(id)) this.loads.delete(id);
    this.keepLoops(this.pours, 'ore', pouring, MAX_WORK_LOOPS);
  }
  // A gun that turns to aim is heard turning: louder and higher the faster it turns. Of a gun of another faction a page
  // is told where its barrel lies and not how fast its servo turns it (server/fog.ts): it is heard by how far it turned since.
  updateServos(state: AudioState): void {
    const turning: LoopPlace[] = [], time = state.time || 0, barrels = this.barrels ||= new Map(), seen = new Set<string>();
    for (const m of state.modules || []) {
      if (m.kind !== 'weapon') continue;
      let speed = Math.abs(m.servoVelocity || 0);
      if (m.servoVelocity === undefined && finite(m.barrelAngle)) {
        let was = barrels.get(m.id);
        seen.add(m.id);
        if (!was || time < was.time) barrels.set(m.id, was = { angle: m.barrelAngle, time, speed: 0 });
        else if (time > was.time) {
          const turned = m.barrelAngle - was.angle;
          Object.assign(was, { speed: Math.abs(Math.atan2(Math.sin(turned), Math.cos(turned))) / (time - was.time), angle: m.barrelAngle, time });
        }
        speed = was.speed;
      }
      if (Number(m.health) <= 0 || speed < SERVO_TURNING) continue;
      const share = Math.min(1, speed / SERVO_FULL);
      turning.push({ key: m.id, x: m.x, y: m.y, level: .1 * (.35 + .65 * share), rate: .8 + .35 * share });
    }
    for (const id of barrels.keys()) if (!seen.has(id)) barrels.delete(id);
    this.keepLoops(this.servos, 'servo', turning, MAX_SERVO_LOOPS);
  }
  // A construction the base is building or mending is heard being worked on, from the middle of it, until it is done;
  // and one whose builders put up or take down a structure on the field (`field.building`), from its cranes, for as long
  // as they go on (LIFT_HOLD).
  updateWorks(state: AudioState): void {
    const time = state.time || 0, worked = new Map<string, LoopPlace & { x: number; y: number; parts: number; cranes: boolean }>(), lifts = this.lifts;
    for (const actor of state.actors || []) {
      if (actor.field?.building && !actor.ghost) lifts.set(actor.id, time + LIFT_HOLD);
      const service = actor.field?.service, cranes = (lifts.get(actor.id) ?? -Infinity) > time && !actor.ghost;
      if (cranes || service && (service.kind === 'build' || service.kind === 'repair') && service.until > time) worked.set(actor.id, { key: actor.id, x: 0, y: 0, parts: 0, level: .14, cranes });
    }
    for (const [id, until] of lifts) if (!(until > time) || until - time > LIFT_HOLD) lifts.delete(id);
    for (const m of state.modules || []) {
      const place = worked.get(m.actorId);
      if (place && (!place.cranes || m.kind === 'builder' && m.attached !== false)) { place.x += m.x; place.y += m.y; place.parts++; }
    }
    this.keepLoops(this.works, 'workshop', [...worked.values()].filter(p => p.parts).map(p => ({ ...p, x: p.x / p.parts, y: p.y / p.parts })), MAX_WORK_LOOPS);
  }
  // Loops of one profile for the places that sound it, the loudest `most` of them: each started once, moved and set
  // to its level on every look, and stopped when its place no longer sounds.
  keepLoops(loops: Map<string, PlaceLoop>, profile: SoundProfileName, places: readonly LoopPlace[], most: number): void {
    const ctx = this.context; if (!ctx || !this.bank || !this.ambience) return;
    const definition: SoundProfile = SOUND_PROFILES[profile], now = ctx.currentTime, reach = definition.reach,
      chosen = places.map(place => ({ ...place, position: soundPosition(place, this.ears, reach) }))
        .filter(place => place.position.volume * place.level >= .004).sort((a, b) => b.position.volume * b.level - a.position.volume * a.level).slice(0, most),
      wanted = new Set(chosen.map(place => place.key));
    for (const [key, loop] of loops) if (!wanted.has(key)) { stopLoop(loop); loops.delete(key); }
    for (const place of chosen) {
      let loop = loops.get(place.key);
      if (!loop) {
        const buffer = this.bank.get(profile);
        if (!buffer) continue;
        const source = startLoop(ctx, buffer, profile, place.key), filter = ctx.createBiquadFilter(), gain = ctx.createGain(), pan = ctx.createStereoPanner();
        filter.type = 'lowpass'; filter.frequency.value = place.position.cutoff; gain.gain.value = 0; pan.pan.value = place.position.pan;
        source.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.ambience);
        loop = { source, filter, gain, pan, sources: [source], nodes: [source, filter, gain, pan] }; loops.set(place.key, loop);
      }
      approach(loop.gain.gain, place.level * place.position.volume * SOUND_PROFILES[profile].level, now, .12);
      approach(loop.filter.frequency, place.position.cutoff, now); approach(loop.pan.pan, place.position.pan, now);
      if (place.rate) approach(loop.source.playbackRate, place.rate, now);
    }
  }
  // A frame of the field: what happened (`events`) up to the time of the field it shows (`time`), heard from the view
  // (`listener`: the camera, its place, its zoom and the pixels it shows) or from the vehicle in the player's hands
  // (`hands`, its id); see `hearing`. Each event is heard as far into the frame as it came (`beat`): the frame since
  // the last is heard over as long as it lasted, as late as the longest frame of late (FRAME_MOST, LAG_HOLD).
  receive(state: AudioState, events: readonly SoundCueEvent[] | null | undefined, { active = true, listener = null, hands = null, following = null, shots = null, time = state.time || 0 }: SoundReceiveOptions = {}): void {
    if (listener) {
      const crew = hands ? state.actors?.find(actor => actor.id === hands)?.vehicle : null;
      this.ears = hearing(listener, crew);
      const watched=following && state.actors?.find(actor=>actor.id===following)?.vehicle;
      this.flybyListener = this.ears.aboard && crew ? { key: 'crew:' + hands, vx: crew.vx, vy: crew.vy }
        : watched ? {key:'watch:'+following,vx:watched.vx,vy:watched.vy} : { key: 'view', vx: 0, vy: 0 };
    }
    this.setActive(active);
    if (!this.shown || !this.enabled || !active || !this.context || this.context.state !== 'running' || !this.bank?.ready || !this.ambience) return;
    if (Number.isFinite(state.time) && this.lastStateTime !== null && state.time < this.lastStateTime - 1e-6) this.stop();
    this.lastStateTime = Number.isFinite(state.time) ? state.time : this.lastStateTime;
    const index: AudioIndex = sceneIndex(state);
    for (const voice of [...this.voices]) if (voice.endAt <= this.context.currentTime) this.endVoice(voice);
    const now = this.context.currentTime, last = this.beats,
      frame = last && time > last.time ? Math.min(FRAME_MOST, now - last.at) : 0,
      pace = frame > 0 && last ? frame / (time - last.time) : 0, kept = last ? last.lag - Math.max(0, now - Math.max(last.at, last.longest + LAG_HOLD)) * LAG_EASE : 0,
      lag = Math.max(frame, kept), beat = (event: SoundCueEvent): number => Math.max(0, lag - Math.max(0, time - (finite(event.time) ? event.time : time)) * pace);
    this.beats = { time, at: now, lag, longest: frame >= kept || !last ? now : last.longest };
    const cues = [...(events || []), ...this.suspensionGate.sample(state, index)].map(event => ({ event, cue: soundCue(event.type === 'explosion' ? { ...event, sourceKind: event.sourceKind || index.get(event.componentId || event.id, 'module')?.kind || index.get(typeof event.source === 'string' ? event.source : undefined, 'module')?.kind } : event) })).filter((e): e is { event: SpatialSoundEvent; cue: SoundCue } => e.cue !== null && typeof e.event.x === 'number' && typeof e.event.y === 'number').sort((a, b) => b.cue.priority - a.cue.priority);
    let played = 0;
    for (const { event, cue } of cues) {
      const stamp = finite(event.time) ? event.time : state.time || 0,
        key = [event.type, event.contactPair || event.id || event.source || '', event.actorId || '', stamp, event.x, event.y, event.material || ''].join(':');
      if (this.recentEvents.has(key)) continue;
      this.recentEvents.set(key, stamp); while (this.recentEvents.size > 512) { const oldest = this.recentEvents.keys().next(); if (oldest.done) break; this.recentEvents.delete(oldest.value); }
      if (!this.contactGate.accepts(event, stamp) || played >= 12) continue;
      this.play(event, cue, beat(event));
      played++;
    }
    this.updateEngines(state, time);
    this.updateDriveVoices(state);
    this.updateFires(state, events, index);
    this.updateFlybys(shots, time);
    this.updatePours(state, state.time || 0);
    this.updateServos(state);
    this.updateWorks(state);
    // Loops together are heard about as loud as the loudest engine among them: they are lowered by the root of how many
    // there are, an engine counted by the square of its loudness beside the loudest's — one far off counts for little —,
    // and a fire for .7.
    const levels = [...this.engines.values()].map(e => e.level), loudest = Math.max(0, ...levels),
      engines = loudest > 0 ? levels.reduce((sum, level) => sum + (level / loudest) ** 2, 0) : 0;
    approach(this.ambience.gain, 1 / Math.sqrt(Math.max(1, engines + this.fires.size * .7)), this.context.currentTime, .15);
  }
}
