import type { CompiledConstruction } from './construction-contract.ts';
import type { NativePowertrain } from './native-contract.gen.ts';
import type { World } from './physics.ts';
import type { SceneActor, LiveModule } from './scene-contract.ts';
import type { Vehicle } from './vehicle.ts';
import type { WeaponId, WeaponPreset, Trajectory, WeaponFamilyId } from './weapons.ts';
import type { Point } from './math.ts';
import type { BallisticLauncher } from './ballistic-contract.ts';
import type { SquadUnit, SquadOrders, SquadMove, SquadHaul, SquadAttack, SquadCommand, SquadMember, SquadSide, SquadPointOrder, SquadBurn, SquadSpan, SquadLandingSpan, SquadLandingReason, SquadGroundBattery, SquadView, FuelRefusal, SquadDeposit, SquadGunWay, SquadCounter, SquadLaidGun } from './squad-contract.ts';
import { isSquadHaulBlock } from './squad-contract.ts';
import { decodeScriptedDecision, decodeLineOfFire } from './scripted-contract.ts';
import type { ScriptedDecision, SquadAction, PilotContact, PilotRequest, PilotBounds } from './scripted-contract.ts';
export type { SquadUnit, SquadOrders, SquadMove, SquadHaul, SquadAttack, SquadSide, SquadCommand, SquadView } from './squad-contract.ts';
import { clamp } from './math.ts';
import { WEAPON_PRESETS, KINETIC_AMMO, blastReach, fedAmmo, propellantCharges, allowedTrajectories, weaponSettings, weaponOf } from './weapons.ts';
import { firingSolution } from './ballistics.ts';
import { ammunitionSupply } from './component-volume.ts';
import { TURN_SECONDS, AIR_TURN_SECONDS } from './economy.ts';
import { REVERSE_SHARE, WORLD_EDGE } from './battle-rules.ts';
import { SENSOR_MODES, COMMAND_CAMERA_RANGE } from './combat-sensors.ts';
import { turnedLauncher, aloftPose } from './turn-about.ts';
import { terrainSpeed, groundBraking, BRAKING } from './terrain-speed.ts';
import { RESERVE_STEP } from './deposits.ts';
import { SLING_BRISK, slung } from './sling.ts';
import { AIR_DENSITY, airDensity, thrustAltitude, thrustShare } from './atmosphere.ts';
import { phrase } from './i18n.ts';

type LiveWeapon = Extract<LiveModule, { kind: 'weapon' }>;
type StrikeLauncher = Pick<LiveWeapon, 'x' | 'y' | 'angle' | 'weaponPreset'> & { weaponMount: { min: number; max: number } };
type ThrustColumn = [number, number, number];
interface Uplift { up: number; centre: Point; sideways: [number, number]; poise: number }
interface FlightCourse { mass: number; hovers: number; speed: number; gains: number; slows: number; burns(speed: number): number }
interface CruiseCourse extends FlightCourse { leans: number; facing: number; turns: boolean }
interface ShownGun extends Point { axis: number; min: number; max: number; reach: number }
interface StrikeTarget extends Point { guns: ShownGun[]; region?: { anchor: number; radius: number; top: number } }
interface StrikePlace { x: number; height: number; bearing: number; score: number; lo: number; hi: number; top: number }
interface Engagement { only: string | undefined; lost?: boolean }
interface PreparedDecision { unit: SquadUnit; halted: string; ordered: boolean; engaged: Engagement | null; request: PilotRequest | null }
interface AloftPlace { x: number; height: number; facing?: number | undefined; vx?: number | undefined }
type FlightDestination = { x: number } & ({ height: number; land?: false } | { land: true; height?: number });
function requiredActor(world: World, id: string): SceneActor {
  const actor = world.actor(id); if (!actor) throw new Error('Construção ausente do campo: ' + id); return actor;
}
function requiredVehicle(world: World, id: string): Vehicle {
  const vehicle = requiredActor(world, id).vehicle; if (!vehicle) throw new Error('Construção sem veículo: ' + id); return vehicle;
}
function requiredMove(unit: SquadUnit): SquadMove {
  if (!unit.move) throw new Error('Veículo sem destino de movimento.'); return unit.move;
}
function requiredHaul(unit: SquadUnit): SquadHaul {
  if (!unit.haul) throw new Error('Veículo sem ordem de coleta.'); return unit.haul;
}
function pointOrder(order: SquadAttack | null): SquadPointOrder {
  if (!order?.point) throw new Error('Ataque sem ponto de bombardeio.'); return order;
}

// What a vehicle does with its guns when nobody tells it what to shoot.
export const STANCES = Object.freeze({
  hold: { name: 'Segurar fogo', help: 'Aponta, mas só atira com uma ordem de ataque. Com você fora do campo, revida se for atingido.' },
  return: { name: 'Revidar', help: 'Fica no lugar e atira de volta quando ele, ou uma construção da facção ao alcance da arma dele, é atingido.' },
  fire: { name: 'Fogo livre', help: 'Atira nos inimigos detectados e pode virar ou se reposicionar até 120 m de onde recebeu a postura para conseguir tiro. Mover, coletar, trabalhar e o controle manual têm prioridade. Parar interrompe a perseguição; uma nova postura ou reposicionamento permite retomá-la.' },
} as const);
// Only the lasting orders cross a save or a change of keeper. Contacts, wear and
// pilot decisions belong to the current squad, never to the transferred orders.
export function unitOrders({ stance, fireAt, move, attack, haul, halt }: SquadOrders): SquadOrders {
  return { stance, fireAt, move, attack, haul, halt };
}
export const RETURN_FIRE_SECONDS = 30; // a vehicle that was hit, or saw one of its side hit within its reach, keeps answering for this long
export const HEARD_SECONDS = 6;       // a fresh contact is told to the player for this long
export const HEARD_AGAIN = 15;        // and an enemy lost and found again is not told more often than this
export const ARRIVAL = 1.5;           // metres from the ordered place that count as there
export const SETTLED = 1;             // m/s under which a vehicle there counts as stopped there: its brakes stop it in a step or two
export const GAP = 3;                 // metres the squad leaves between two vehicles of the side, from the end of one to the start of the next
export const ROOM = 7;                // metres of length taken for a vehicle whose frame tells none
export const DEPOT_INSET = 25;        // metres inside the edge of its base where a hauler stops to unload
export const FREE_FIRE_RADIUS = 120;  // metres around the human-authorized position, independent of ballistic reach
export const FREE_FIRE_CLIMB = FREE_FIRE_RADIUS; // and metres over it an aircraft climbs at the most for a shot (Squad.strikeTarget)
const FIRE_INSET = 20, FIRE_STEP = 10; // room for physical braking and one short approach at a time
export const HAUL_SCARE = 1000;       // an armed enemy in sight whose guns reach a worker within this many metres pauses its automatic work or ends its haul
export const MARK_SCARE = 300;        // and one held only as a mark, a radar blip or a sound, within this many
export const SCARE_HOLD = 60;         // seconds enemies that only show themselves hold a worker, at the most,
export const SCARE_WINDOW = 300;      // in any this many seconds (Squad.endangered)
export const COUNTER_ERROR = 120;     // metres: a gun its base places no closer than this is not worth the shells
const PATIENCE = 8;
const TURN_GAIN = 3;                  // seconds a turning about is to save over backing the whole way, beyond the time it takes
const LEAST_BRAKING = .5;             // m/s² the least counted on to stop down a slope, whose weight takes the rest of `BRAKING`
const TIPPING = .75;                  // the share of what would lift a vehicle off its rear gear that its stop is braked at
const GRAVITY = 9.81;                 // m/s² the weight of a vehicle pulls it down by
const BRAKES = 5;                     // m/s² all of the brakes of a vehicle take off it, where its ground holds as much (game_motion.rs)
const SLIP_SPEED = 1.5;               // m/s under which a drivetrain pulls as it does at this speed (game_motion.rs)
const GRIP_SHARE = .8;                // the share of the grip under its running gear a pilot pushes firm ground with at the most
const LOOSE: readonly (string | null | undefined)[] = ['sand', 'mud'];        // grounds that hold a gear spinning on them as hard as one that grips (game_terrain.rs `sliding`)
const LOAD_BACK = .3;                 // share of its weight a second the least load on its gear that a pilot counts on comes back by
const RIDING = 2;                     // m/s under which the gear of a vehicle follows the bumps under it, which take none of its weight off it
const STUCK_SPEED = .3;               // m/s under which a vehicle pushed on stands (game_motion.rs)
const LEAN_WAIT = 1;                  // seconds a vehicle its pilot pushes on gains no speed before he puts his foot down
const LEAN_GAIN = .1;                 // m/s it is to gain for that
const LEAN_SHORT = 1;                 // m/s short of its speed, at the most, it is to go no faster than for that
const LEAN_HIT = 20;                  // m/s² it is stopped by, past what brakes and slopes take off it, when it meets something in its way
const PACE_GAIN = 2;                  // m/s² a vehicle at a pace is pushed or held back by, for every m/s it is short of it or past it
const PACE_SURGE = .5;                // m/s² of that, at the most, beyond what holds its speed
const PACE_SUM = 1;                   // m/s² more every second for every m/s it has been short of its pace or past it
const PACE_SUM_MOST = 2;              // and m/s² of that at the most
const PACE_START = 1;                 // m/s² more every second a vehicle at a pace that is to go on stands
const PACE_STOP = .5;                 // m/s² it slows by to a stop where its way at a pace ends
const PACE_HELD = .1;                 // m/s under which a vehicle at a pace that is to stop is stopped on all of its brakes
const CREEP = .01;                    // the least throttle a vehicle at a pace is driven on: none at all is its brake
const PACE_LOOK = .5;                 // seconds without a look after which the pilot of a vehicle at a pace takes it up afresh
const TOW_PACE = 2;                   // m/s for an automatic tow: take up slack without a running start
export const LOADING_APPROACH = .45;  // fine parking for loading, shared by haulers and the builder's crane
export const EDGE = 5;                // metres inside the reach of a vein, or the edge of a base, that a place to stop keeps
const FARTHEST = 100;                 // metres from where a vehicle is sent that a free place is looked for, before it goes there all the same
const ROLLING = 1;                    // m/s away from the place it is sent to: faster than this, a vehicle is stopped before it is driven there
const FLIGHT_SLOWING = .9;            // the share of what its thrusters slow it by at the most, along the field and up, it is planned to slow down to the place or the height by (`flight`): what is left holds it level as it is slowed
const FLIGHT_CLOSING: readonly [number, number, number, number] = [1, .6, .3, 1.5]; // m/s it is to go at the most for each metre it has left to the place; up to its height on its way, and down to it, gently — as the ground it flies over changes under it, it would swing past it —; and to its height over the place: it comes to them as a damped spring comes to rest
const FLIGHT_FLOOR = 6;               // metres over the ground under it and ahead of it it is flown no lower than
const STACKED = 6;                    // metres of height over the ground within which two vehicles of the side keep apart along the field
const LANDING_SLOPE = .25;            // the rise to the metre of the ground under its length, about 14°, an aircraft comes down on at the most
const FLIGHT_AHEAD = 5;               // seconds of its way ahead, as fast as it goes, the ground it is flown over the highest of is looked at — what it takes to climb over it —
const FLIGHT_BEHIND = 1;              // and behind it, so that it does not come down as soon as it is past a crest
const FLIGHT_LOOK = 4;                // metres between two points of that ground at the least
const FLIGHT_POINTS = 32;             // points of it looked at at the most
const FLIGHT_SERVO = 1;               // seconds in which its keys ask its thrusters to make up what it climbs slower or faster than planned (game_hover.rs): sooner, a heavy one swings past its height on a crowded field
const FLIGHT_ALONG = .25;             // and what it goes along the field slower or faster than planned by, where much of what speeds it up comes as it is leant, a second or so after it is asked
const FLIGHT_ROUND = .5;              // the most of what it is off the speed planned a round of its pilot is to make up — on a crowded field rounds come slower
const FLIGHT_DIVE = .5;               // the share of its weight it is let fall by at the most asked down as it is asked along the field (game_hover.rs `DIVE`)
const FLIGHT_LEAD = .45;              // seconds ahead its speed along the field is read at, by what leaning as it leans now speeds it up by
const FLIGHT_TURN = 1.2;              // seconds it is reckoned to take to lean the other way, flat out, before it slows down as hard as it is leant to (game_hover.rs `LEVEL`)
const FLIGHT_LEAN = 60 * Math.PI / 180; // the most its flight computer leans it either way (game_hover.rs `LEAN`)
const FLIGHT_UPRIGHT = 75 * Math.PI / 180; // the most a thruster points off up, as the hull leans, for what it pushes with to hold it up (game_hover.rs `UPRIGHT`)
const FLIGHT_BALANCE_LEAN = 15 * Math.PI / 180; // and how far it is leant, at the most, for thrusters further over to turn it back as the others hold it up, past what it hovers at (game_hover.rs `BALANCE_LEAN`, `held_up`)
const FLIGHT_CLEARANCE = .5;          // and the metres the lowest of its outline is kept over the ground near it, leant no further than keeps it so (game_hover.rs `CLEARANCE`)
const FLIGHT_FLARE = 3;               // metres the lowest of its outline, leant as far as it slows down at, is flown over the ground ahead of it at the least on its way: its flight computer keeps it that much more over ground that rises under it to lean it so (game_hover.rs `LEVELLING`), and a long one flown lower is leant little and slowed late
export const FLIGHT_HOMING = 15;      // m/s an aircraft is reckoned to go at the least: a job reckons the time of its way so (supply-dispatch.ts `travel`), and its pilot reads what it burns to the metre only faster
const FLIGHT_RESERVE = 15;            // seconds of what it burns hovering that it is to have left as it lands home (`reserve`)
const FLIGHT_MARGIN = 1.5;            // how much more than it burns hovering an aircraft is reckoned to burn on a trip of a job (`flightFuel`)
// What its thrusters burn a second for each newton they push an aircraft with, in litres: 108 kg of fuel for each kN an hour,
// at 0.835 kg to the litre (game_hover.rs `SPECIFIC_FUEL`, game_motion.rs `FUEL_KG_PER_LITRE`).
const THRUST_LITRES = .108 / .835 / 3600;
const LIGHTER = .02;                  // the share of its weight an aircraft that did not get off the ground loaded is to lose, or gain, before it is the same no more
const TOUCHDOWN = 6;                  // metres off the place it comes down at from which an aircraft that may come down anywhere of a stretch comes down where it is (`touchdown`)
const TOUCHDOWN_SPEED = 3;            // and m/s along the field it is to be slowed to for that
const LANDING_DRIFT = 1;              // m/s along the field an aircraft over its place is slowed to at the most before it starts down there
const LANDING_STILL = .25;            // and m/s it is slowed to, steered over its place as it starts down, before it falls there with its thrusters idling, which hold it along the field no more (game_hover.rs): it drifts by that until they slow it at the last
const LANDING_OFF = .5;               // and the metres off its place it may fall at the most, with what it drifts by on its way down (`descentCost`, `falls`) and once its thrusters slow it at the last (`FLIGHT_DAMPING`)
const LANDING_LEAN = 5 * Math.PI / 180; // and how far it may lean off the lean it hovers still at (`flight`, `poise`) as it starts down: its flight computer turns it level as it falls, and leant further the thrusters that turn it push it along
const FLIGHT_DAMPING = 2;             // 1/s its flight computer slows it along the field by for each m/s it goes, once its thrusters hold it up again (game_hover.rs `DAMPING`)
const LANDING_BURN = .9;              // the share of what its thrusters speed it up by upwards over its weight its flight computer slows it by as it comes down to the ground (game_hover.rs `FLARE`)
const LANDING_TOUCH = .5;             // and m/s it touches the ground at (game_hover.rs `TOUCH`)
const LANDING_SETTLING = .25;         // and the metres over the ground it is held at that for, the rest of the way down (game_hover.rs `SETTLING`)
const LANDING_MARGIN = 1.1;           // how much longer and more than it is reckoned to take coming down so it is reckoned to take: the steps of its flight computer and the lean it comes down at make some 3 % of a difference either way
const FUEL_SAMPLE = 1;                // seconds over which what an aircraft burns is read
const FUEL_METRE = .25;               // the share a new reading of what it burns to the metre takes of the one kept
const CRUISE_STEADY = .05;            // the share of its speed under which what an aircraft gained or lost of it over a reading, and the height it came down by over the metres it went, leave it read as cruising (`homeward`)
const HOMING_MARGIN = 1.2;            // how much more than it is reckoned to burn going along the field and up it is reckoned to burn (`flightLitres`): flown well, the aircraft of the test server burnt up to a sixth more than reckoned — on short ways, which they overshoot —, and land with their reserve whole so
const SLING_TAKE_UP = .5;             // m/s an aircraft climbs at the most while the load on its sling still bears on the ground
const SLING_CARRIED = .9;             // the share of the weight of that load its sling is to bear for it to be off the ground
const SLING_DOWN = .5;                // the share of all it may come down by an aircraft is asked to set a load down on its sling by
const SLING_SLACK = .05;              // the share of the weight of that load under which its sling bears none of it: it is set down
const SLING_REST = .5;                // seconds its sling is to bear none of it for that, past the bounce of the load as it touches
// How much more than it weighs now the thrusters an aircraft has left once one of them is lost are to hold it up by, level
// (`lifts`), for its pilot to go on with what it does (`steady`): as much as the Oficina asks of all of them with all it
// carries full (game_construction.rs `LIFT_MARGIN`). So it climbs at 2.4 m/s² straight up and holds its height leant to
// 36.9°, as the least aircraft the Oficina passes does: it flies as any aircraft its pilot was made for, which reckons what
// it may do from the thrusters it has (`flight`).
export const HOLDING = 1.25;
// What an aircraft of a design weighing `mass` kg burns a second holding itself up, in litres: what its thrusters burn so as
// it was built (`flight.hoverLitres`, game_hover.rs), and as much more as it weighs more than it was built. One whose
// thrusters hold it up at no rate known is reckoned to burn more than any tank holds.
function hoverRate(blueprint: CompiledConstruction, mass: number) {
  const hovers = blueprint?.flight?.hoverLitres, built = blueprint?.fixedAssembly?.mass;
  return hovers !== undefined && hovers > 0 && built > 0 ? hovers * mass / built : Infinity;
}
// What an aircraft of a design weighing `mass` kg is reckoned to take coming down `height` metres to the ground, in seconds
// and litres, as its pilot brings it down to land (`fly`) and its flight computer slows it (game_hover.rs `descent`) to a
// ground `altitude` metres over sea level — its thrusters pushing as they do in the air of that ground, where they slow
// it, and the air holding it back as little as it does where it starts to fall, so that it is reckoned to fall no slower
// than it does (atmosphere.ts) —:
// falling from a hover with its thrusters idling (`flight.idleLitres`), as fast as the air under it lets it
// (`powertrain.dragUnder`), until it must be slowed by `LANDING_BURN` of what they speed it up by upwards over its weight,
// held level (`flight.liftN`) — and by the air as it goes — to fall at `LANDING_TOUCH` `LANDING_SETTLING` metres over the
// ground; then held at that the rest of the way. Slowed, they burn for what they push it with as they burn holding it up
// (`hoverRate`). One they do not hold up takes what it takes to fall, idling; one whose thrusters hold it up by as much as
// is not known is reckoned to burn more than any tank holds. All of it to the side of more (`LANDING_MARGIN`). The way home
// of an aircraft is reckoned by it (`Squad.flightLitres`). Nothing for no height.
export function descentCost(blueprint: CompiledConstruction, mass: number, height: number, altitude: number = 0) {
  const lift = (blueprint?.flight?.liftN ?? NaN) * thrustShare(altitude), idles = blueprint?.flight?.idleLitres ?? 0, hovers = hoverRate(blueprint, mass), far = Math.max(0, height);
  if (!(far > 0)) return { seconds: 0, litres: 0 };
  if (!Number.isFinite(lift) || !(mass > 0)) return { seconds: Infinity, litres: Infinity };
  const slowing = LANDING_BURN * (lift / mass - GRAVITY), k = Math.max((blueprint?.powertrain?.dragUnder || 0) * airDensity(altitude + far) / AIR_DENSITY / mass, 1e-9),
    touch = LANDING_TOUCH, burns = (slowed: number) => Math.max(idles, hovers * (GRAVITY + slowed) / GRAVITY), rate = Math.sqrt(k * GRAVITY),
    // As a body does in air that holds it back by `k` for the square of its speed: falling from rest for `t` seconds, how
    // fast it falls and how far it fell — ln cosh, as it may be worked out however long it falls —; slowed from `v` to
    // touch, how far and how long.
    speed = (t: number) => Math.sqrt(GRAVITY / k) * Math.tanh(rate * t), fell = (t: number) => (rate * t + Math.log1p(Math.exp(-2 * rate * t)) - Math.LN2) / k,
    braked = (v: number) => Math.log1p(k * (v * v - touch * touch) / (slowing + k * touch * touch)) / (2 * k),
    braking = (v: number) => (Math.atan(v * Math.sqrt(k / slowing)) - Math.atan(touch * Math.sqrt(k / slowing))) / Math.sqrt(k * slowing);
  // How long it falls before it is slowed: where the two ways down add up to all but the last of the height — or to all of
  // it, for one they do not hold up —, by halves.
  const settling = slowing > 0 ? Math.min(far, LANDING_SETTLING) : 0, above = far - settling,
    down = (t: number) => fell(t) + (slowing > 0 ? braked(speed(t)) : 0);
  let lo = 0, hi = 1;
  while (down(hi) < above) hi *= 2;
  for (let i = 0; i < 48; i++) { const t = (lo + hi) / 2; if (down(t) > above) hi = t; else lo = t; }
  if (!(slowing > 0)) return { seconds: LANDING_MARGIN * lo, litres: LANDING_MARGIN * idles * lo, falls: lo };
  const slow = Math.max(0, braking(speed(lo))), held = settling / touch;
  return { seconds: LANDING_MARGIN * (lo + slow + held), litres: LANDING_MARGIN * (idles * lo + burns(slowing) * slow + burns(0) * held), falls: lo };
}
// How an aircraft is flown `far` metres along the field the way `way` points, `altitude` metres over sea level, by its
// pilot (`fly`): flat out, front first where turning about for it saves the time it takes (`turnsAloft`, at the speed it
// goes now, `speed`). Its flight computer pushes it along with the thrusters that point that way in a level hull, and leans
// it for the rest (game_hover.rs; `thrust`, `uplift`): it is flown level where those push it along by as much as leaning
// it would, and else leant as far as it may be (`FLIGHT_LEAN`, and no further than the others still hold it up), in the
// thin air up there (atmosphere.ts), and no harder with a load on its sling than its flight computer flies them
// (`SLING_BRISK`). It goes as
// fast as that holds it against the air the way it shows it then (`speed`; game_motion.rs `Powertrain::air`); it is sped up
// from a hover by three quarters of what that pushes it by — the air holds it back the faster it goes — (`gains`), and
// slowed by what its pilot plans to slow it by leaning it (`leans`) and by what the air holds it back by at half that speed
// (`slows`). What it burns a second going `v` m/s (`burns`): what holds it up (`hoverRate`) and, flown level, what its
// thrusters burn pushing it against the air apart from that (`THRUST_LITRES`), or, leant, what holds it up pushing against
// its weight and the air together. What it weighs (`mass`), burns hovering (`hovers`), and the way it faces then, from
// facing `facing`.
function cruise(world: World, id: string, thrust: Uplift, way: number, altitude: number, far: number = Infinity, speed: number = 0, facing: number = requiredActor(world, id).facing || 1): CruiseCourse {
  const actor = requiredActor(world, id), vehicle = requiredVehicle(world, id), mass = laden(world, id), air: Partial<NativePowertrain> = vehicle.drivetrain ?? {},
    share = thrustShare(altitude), thin = airDensity(altitude) / AIR_DENSITY, hovers = hoverRate(actor.blueprint, mass),
    turns = way !== facing && (air.drag ?? 0) > 0 && (air.dragAstern ?? 0) > (air.drag ?? 0) &&
      far / Math.max(Math.abs(speed), FLIGHT_HOMING) * (1 - Math.sqrt((air.drag ?? 0) / (air.dragAstern ?? 0))) > AIR_TURN_SECONDS + TURN_GAIN,
    faces = turns ? way : facing, reach = thrust.sideways[way * faces * (actor.facing || 1) > 0 ? 1 : 0] * share,
    lift = thrust.up * share / mass, tipped = Math.min(GRAVITY * Math.tan(FLIGHT_LEAN), Math.sqrt(Math.max(0, lift * lift - GRAVITY * GRAVITY))),
    level = reach >= mass * tipped, lean = level ? 0 : Math.atan2(tipped, GRAVITY), sling = slung(world, id) ? SLING_BRISK * mass : Infinity,
    drag = (((faces === way ? air.drag : air.dragAstern) || 0) * Math.cos(lean) + (air.dragUnder || 0) * Math.sin(lean)) * thin,
    push = Math.min(level ? reach : reach + mass * tipped, sling), top = push > 0 ? Math.sqrt(push / Math.max(drag, 1e-9)) : 0,
    leans = FLIGHT_SLOWING * Math.min(tipped, sling / mass);
  return { mass, hovers, facing: faces, turns, speed: top, gains: .75 * push / mass, leans, slows: leans + drag * top * top / (4 * mass),
    burns: v => level ? hovers + THRUST_LITRES * drag * v * v : hovers * Math.hypot(1, drag * v * v / (mass * GRAVITY)) };
}
// And how it is flown up, `altitude` metres over sea level: flat out, slowed by its weight (`fly`), as fast as what its
// thrusters push it up with over its weight, held level (`thrust`, `uplift`), holds it against the air on its top; sped up
// and slowed as along the field, and burning what holds it up and what pushes it against the air.
function climbing(world: World, id: string, thrust: Uplift, altitude: number) {
  const actor = requiredActor(world, id), mass = laden(world, id), hovers = hoverRate(actor.blueprint, mass),
    climbs = thrust.up * thrustShare(altitude) / mass - GRAVITY, drag = (requiredVehicle(world, id).drivetrain?.dragOver || 0) * airDensity(altitude) / AIR_DENSITY,
    top = climbs > 0 ? Math.sqrt(mass * climbs / Math.max(drag, 1e-9)) : 0;
  return { mass, hovers, speed: top, gains: .75 * climbs, slows: FLIGHT_SLOWING * GRAVITY + drag * top * top / (4 * mass),
    burns: (v: number) => hovers + THRUST_LITRES * drag * v * v };
}
// The litres an aircraft is reckoned to burn going `far` metres one way to a hover, as `go` has it (`cruise`, `climbing`),
// from a hover or already going that way at `toward` m/s: sped up to as fast as it goes, or, short of the way that takes,
// to what it is still slowed from in what is left of it; on at that and slowed down. What it burns to the metre at that
// pace — `scale` times as much, as it was read to burn cruising against that (`homeward`) —, what holds it up over the
// time speeding up and slowing down take beyond going all the way at that pace, and what speeds it up. Nothing for no
// way, and more than any tank holds where it does not go.
function legLitres(far: number, go: FlightCourse, scale: number = 1, toward: number = 0) {
  if (!(far > 0)) return 0;
  if (!(go.speed > 0 && go.gains > 0 && go.slows > 0 && Number.isFinite(go.hovers))) return Infinity;
  const start = clamp(toward, 0, go.speed),
    peak = Math.max(start, Math.min(go.speed, Math.sqrt((2 * far * go.gains * go.slows + go.slows * start * start) / (go.gains + go.slows))));
  return scale * go.burns(peak) / peak * far + go.hovers * ((peak - start) ** 2 / (2 * go.gains * peak) + peak / (2 * go.slows)) +
    THRUST_LITRES * go.mass * (peak - start);
}
// Why the pilot of an aircraft sends it to land by itself, which is no order of the player's to a vehicle on a job of its
// faction (supply-dispatch.ts `playerOrder`): home for its fuel (`homeward`), or, for a thruster it lost, home to be mended
// or down where it is (`mend`).
export const PILOT_LANDINGS = Object.freeze(['fuel', 'mend', 'forced']);
// What an aircraft its pilot has waiting to be mended says while it stands on its skids with nothing else to do (`crippled`).
const MENDING = 'mending';
// An aircraft that goes for a target from the air (`strike`) stands off it by as far as a gun of its family hits at, at the
// most, in metres — and no farther than `STRIKE_SIGHT` of what its own sensors see —; keeps it `STRIKE_SECTOR` radians inside
// the edges of what its gun turns to; weighs `STRIKE_BEARINGS` lines to it within those; counts a place `STRIKE_CLEAR` radians
// outside what a gun the target shows turns to as within it; flies no lower than `STRIKE_FLOOR` metres over the ground there;
// and weaves `STRIKE_WEAVE` metres either way across its line to the target, turning for the other end `STRIKE_TURN` metres
// short of one. It goes there only once it has had no shot for `STRIKE_PATIENCE` seconds where it is, or none it may take
// there out of the way of the target's guns.
const STRIKE_RANGE: Readonly<Partial<Record<WeaponFamilyId, number>>> = Object.freeze({ machinegun: 400, autocannon: 900, cannon: 1500, rocket: 700, grenade: 350 });
const STRIKE_SIGHT = .85;
const STRIKE_SECTOR = .3;
const STRIKE_BEARINGS = 9;
const STRIKE_CLEAR = .15;
const STRIKE_FLOOR = 10;
const STRIKE_FARTHEST = 2;           // times the range it stands off at the farthest, kept over a stretch of the field
const STRIKE_WEAVE = 15;
const STRIKE_TURN = 5;
const STRIKE_CLIMB = 15;              // metres over or under the height it is at that it is sent to at a time, on its way there
const STRIKE_LOOK = 10;               // metres between two points of the ground under its line to the target that are looked at
const STRIKE_PATIENCE = 1.5;
const STRIKE_TURNABOUT = 150;         // metres nearer than where it stands off a target as it faces that it is to stand off it turned about, to turn about in the air for it
// What a pilot says of a gun that has a shot and waits on it: its servo laying it, a round going in, its barrel cooling, an
// ally in its way.
const WAITING = Object.freeze(['servo-aligning', 'reloading', 'cooling', 'ally-in-line']);
const WORKS_BESIDE = Object.freeze({ digs: 'carries', carries: 'digs' }); // the work at a vein that stands beside each (Squad.beside)
// Why a haul of an aircraft ends where it stands: the stretch it works its vein from has no ground it comes down on (`landing`).
const NO_LANDING = 'no-landing';
// Why it ends at home: its tanks full do not take it to its vein and back (`homeward`).
export const OUT_OF_RANGE = 'out-of-range';
// Why an aircraft on a haul stays on its skids where it stands (Squad.grounded), said while it does.
const GROUNDED = Object.freeze(['too-heavy', 'fuel-home', 'immobile']);
// Why an aircraft that keeps its fuel to come home (Squad.homing) does not take an order of the player's (Squad.fuelRefusal),
// in a few words: it is on its way home for its fuel (`returning`), or the order would leave it short of the way there and
// home from there (`short`); and so of an order none of those it was given took (`FUEL_REFUSED_ALL`).
const FUEL_REFUSED = Object.freeze({ returning: 'voltando à base para reabastecer', short: 'sem combustível para ir e voltar à base' });
const FUEL_REFUSED_ALL = Object.freeze({ returning: 'Voltando à base para reabastecer · ordem recusada pela volta automática.',
  short: 'Sem combustível para ir e voltar à base · ordem recusada pela volta automática.' });
// What the player is told of an order to `total` vehicles that their fuel return kept as many of them as there are `reasons`
// from, by the first of those, as a phrase his page says in its language (i18n.ts `phrase`): of an order none of them took,
// why; of one some took, how many did not, and why.
export function fuelRefused(reasons: readonly FuelRefusal[], total: number) {
  const why = reasons[0], count = reasons.length;
  if (why === undefined) throw new Error('Recusa de combustível sem motivo.');
  return count === total ? phrase(FUEL_REFUSED_ALL[why]) : count === 1 ? phrase('Ordem recusada para 1 aeronave pela volta automática: {0}.', phrase(FUEL_REFUSED[why])) :
    phrase('Ordem recusada para {0} aeronaves pela volta automática: {1}.', count, phrase(FUEL_REFUSED[why]));
}
const IDLE = Object.freeze({ move: null, attack: null, haul: null, halt: '' }); // a vehicle with no orders
// The ways a pilot sends its vehicle on by itself to fire: to get a shot on the ground (`freeFire`) and from the air
// (`strike`). Any order, and a change of stance, ends them.
const LOCAL_LEGS = Object.freeze(['fire', 'strike']);
const usableGun = (m: LiveModule): m is LiveWeapon => m.kind === 'weapon' && m.health > 0 && m.attached !== false && !m.barrelDisabled;
// What a vehicle going `speed` m/s the way `heading` points needs to hold that speed on the ground under it, in m/s²: what its
// weight takes up the slope it stands on, or gives it down one, and what rolling over that ground and the air, as dense
// as it is at its height (atmosphere.ts), take (`need`);
// what its engine gives it at the most its pilot drives it with there (`engine`), and the share of its throttle that is
// (`share`); and what all of its brakes take off it (`brakes`). The throttle of a vehicle asks for that share of what its
// drivetrain pulls, which the ground may not hold: a pilot asks no more of it than `GRIP_SHARE` of what the ground holds
// under the share of its weight its gear bears (`load`: the least of late, `bearing`), short of what even firm ground holds
// a gear that spins on it by (game_terrain.rs `SurfaceKind::sliding`). Its gear does not break loose, and one a jolt broke
// loose grips again. Sand and mud hold a gear that spins as hard as one that grips (`LOOSE`): on them he asks for all they
// hold, as much as flooring it would give. The pilot does not look at the slip. As the core works them out
// (game_motion.rs), by the grip the core tells of its ground (`groundGrip`): none where nothing of it touches the ground,
// and then he gives it nothing until it is down again, which keeps its gear from landing spun up.
function drivetrain(vehicle: Vehicle, heading: number, speed: number, load: number) {
  const drive: Partial<NativePowertrain> = vehicle.drivetrain || {}, slope = vehicle.groundSlope || 0, level = Math.cos(slope), mass = vehicle.mass,
    carried = vehicle.carrierMass || mass, grip = GRAVITY * level * (vehicle.groundGrip || 0), held = GRAVITY * (vehicle.groundGrip || 0) * load,
    pull = Math.min(drive.maxDriveForce || 0, (drive.powerKw || 0) * 1000 * (drive.efficiency || 0) / Math.max(Math.abs(speed), SLIP_SPEED)),
    share = pull > 0 ? Math.min(1, (LOOSE.includes(vehicle.groundSurface) ? 1 : GRIP_SHARE) * mass * held / pull) : 1;
  return { need: GRAVITY * Math.sin(slope) * heading + (GRAVITY * (vehicle.groundResistance || 0) * level * mass +
      (drive.drag || 0) * airDensity(vehicle.y) / AIR_DENSITY * speed * speed) / carried,
    engine: pull * share * clamp(vehicle.traction ?? 1, 0, 1) / carried, share,
    brakes: Math.min(BRAKES, grip) * mass / carried };
}
// The least share of its weight the springs of the gear of a vehicle going `speed` m/s along `leg` have pressed it on the
// ground with of late (`groundLoad`), at `time`: as low as that went, and no faster back up than `LOAD_BACK`. The bumps a
// gear rides over take its weight off it by turns, and a pilot who pushed it as hard as its whole weight holds would have
// it break loose over each of them. Slower than `RIDING` it bears what it bears now: a vehicle set down on the ground
// does not start as if it hopped.
function bearing(leg: SquadMove, vehicle: Vehicle, speed: number, time: number) {
  const load = vehicle.groundLoad ?? 1;
  let kept = leg.bearing;
  if (!kept || time - kept.at > PACE_LOOK || Math.abs(speed) < RIDING) kept = leg.bearing = { low: load, at: time };
  kept.low = Math.min(load, kept.low + LOAD_BACK * (time - kept.at));
  kept.at = time;
  return kept.low;
}
// Whether the pilot of a vehicle that is to go on along `leg` at `wanted` m/s has his foot down, at `time`. Something in
// its way holds it — the face of a step, a bump its gear sits against, soft ground it bogs down in — when it is stopped
// short all at once (faster than `LEAN_HIT`, which no brake or slope does), or when for `LEAN_WAIT` it gained no speed
// (`LEAN_GAIN`) and went no faster than half of what it is to go, or than it stands at (`STUCK_SPEED`), though he pushed
// it on all the while (`pushing`): then he gives it all its drivetrain has, flat out, until it goes as fast as it is to
// go, or he no longer pushes it on, when he doses its throttle by the grip of its ground again (`drivetrain`). The face a
// gear leans on holds it as the ground does (game_motion.rs `drive`), which the pilot cannot tell from the ground under it.
// So does he where his dosing holds it short of what it is to go by more than `LEAN_SHORT` all the same: over the bumps
// of the ground at speed the least of what they leave its gear bearing holds its throttle back, though a gear they lift
// barely spins up and grips again at once; flat out it goes as fast as a driver who floors it.
function leaning(leg: SquadMove, speed: number, wanted: number, time: number, pushing: boolean) {
  if (wanted <= STUCK_SPEED) { leg.lean = null; return false; }
  let lean = leg.lean;
  if (!lean || time - lean.at > PACE_LOOK) lean = leg.lean = { down: false, since: time, top: speed, speed, at: time };
  const hit = time > lean.at && (lean.speed - speed) / (time - lean.at) > LEAN_HIT,
    held = Math.max(STUCK_SPEED, wanted / 2, wanted - LEAN_SHORT);
  if (!pushing || speed > lean.top + LEAN_GAIN) Object.assign(lean, { since: time, top: speed });
  lean.at = time; lean.speed = speed;
  lean.down = pushing && (lean.down ? speed < wanted : hit || speed < held && time - lean.since >= LEAN_WAIT);
  if (!lean.down && speed >= held) Object.assign(lean, { since: time, top: speed });
  return lean.down;
}
// The controls that bring an automatic vehicle to `target` m/s along the way `heading` points, and keep it
// there, at every look of its pilot: the push it needs to hold its speed on the ground it is on (`drivetrain`), as much
// again for every m/s it is short of the target or past it (`PACE_GAIN`), and what it has been short of it or past it as
// it rolled near it, summed over its looks (`PACE_SUM`), which takes up what the ground does that is not worked out. Standing where it
// is to go on, it is not held back, nor counted on to roll down a slope, and it is pushed the harder every second it
// stands (`PACE_START`) — a bump of the ground its wheels sit against may hold it —, by as much less every second once it
// rolls. A working machine limits that correction to `PACE_SURGE`; an ordinary trip uses the available effort. When its
// stopping envelope is the limit, `slowing` feeds that same planned deceleration forward instead of pulling against it.
// A push is that share of its engine, and a hold back that share of its brakes: up a slope it goes on without
// rolling back, and down one it holds its speed on its brakes, neither pulled up short nor let go. Held where it stands
// all the same, it is driven flat out (`leaning`).
export function paced(leg: SquadMove, vehicle: Vehicle, heading: number, speed: number, target: number, time: number, { surge = PACE_SURGE, slowing = 0, lean = true }: { surge?: number; slowing?: number; lean?: boolean } = {}) {
  const short = target - speed, { need, engine, share, brakes } = drivetrain(vehicle, heading, speed, bearing(leg, vehicle, speed, time)),
    standing = Math.abs(speed) < PACE_HELD && target > PACE_HELD, near = PACE_SURGE / PACE_GAIN;
  let servo = leg.servo;
  if (!servo || time - servo.at > PACE_LOOK) servo = leg.servo = { sum: 0, start: 0, at: time };
  const passed = time - servo.at;
  if (standing) servo.start = Math.min(PACE_SUM_MOST, servo.start + PACE_START * passed);
  else {
    servo.start = Math.max(0, servo.start - PACE_START * passed);
    if (Math.abs(short) < near) servo.sum = clamp(servo.sum + PACE_SUM * short * passed, -PACE_SUM_MOST, PACE_SUM_MOST);
  }
  servo.at = time;
  const push = (standing ? Math.max(0, need) : need) - slowing + servo.sum + servo.start + clamp(PACE_GAIN * short, -surge, surge),
    braking = push < 0 && !standing;
  if (!lean) leg.lean = null;
  else if (leaning(leg, speed, target, time, !braking)) return { throttle: heading, brake: 0 };
  if (braking) return { throttle: 0, brake: Math.min(1, -push / brakes) };
  return { throttle: heading * share * (engine > 0 ? clamp(push / engine, CREEP, 1) : 1), brake: 0 };
}
// The guns that answer fire nobody sees: those made to drop their rounds on a place.
const curved = (gun: LiveWeapon) => ['mortar', 'howitzer'].includes(weaponOf(gun.weaponPreset || 'rh120')?.family ?? '');
// The arcs a gun bombards by: the automatic one, which is either, where it has it; else its own, then the others it
// may fire; never the line of sight.
const arcs = (preset: WeaponId): Trajectory[] => {
  const specification: WeaponPreset = weaponOf(preset) ?? WEAPON_PRESETS.rh120;
  return allowedTrajectories(preset).includes('auto') ? ['auto'] :
    [...new Set([specification.trajectory, ...allowedTrajectories(preset)])].filter((way): way is Trajectory => !!way && way !== 'direct');
};
const RELAY = 2; // metres a gun moves before the arc it bombards by is worked out again
// How far a gun of a preset reaches on level ground by the arcs it bombards by (not the line of sight, which a gun
// raised to it would carry for tens of kilometres): worked out once, by halving.
const reaches = new Map<WeaponId, number>();
export function arcReach(preset: WeaponId) {
  if (!reaches.has(preset)) {
    let best = 0;
    for (const trajectory of arcs(preset)) {
      const settings = weaponSettings((weaponOf(preset) ?? WEAPON_PRESETS.rh120).family, { preset, trajectory, charge: 'auto' }),
        reached = (far: number) => firingSolution({ x: 0, y: 0 }, { x: far, y: 0 }, settings).reachable;
      let near = 0, beyond = 200000;
      for (let i = 0; i < 24; i++) { const far = (near + beyond) / 2; if (reached(far)) near = far; else beyond = far; }
      best = Math.max(best, near);
    }
    reaches.set(preset, best);
  }
  return reaches.get(preset)!;
}
// Whether a construction is an aircraft by its design (chassis.ts), whatever is left of its thrusters: it flies to its work
// and comes down beside it to work there on its skids.
export const aircraft = (actor: Pick<SceneActor, 'blueprint'> | null | undefined) => actor?.blueprint?.chassis?.model === 'aircraft';
// The litres an aircraft of a design is reckoned to burn flying for `seconds` weighing `mass` kg: what its thrusters burn a
// second holding it up (`hoverRate`), and `FLIGHT_MARGIN` of that for climbing and leaning into its way, over those seconds
// and `FLIGHT_RESERVE` more — as a trip of a vehicle on the ground is reckoned (supply-dispatch.ts `fuel`). One whose
// thrusters hold it up at no rate known is reckoned to need more than any tank holds.
export function flightFuel(blueprint: CompiledConstruction, mass: number, seconds: number) {
  const rate = hoverRate(blueprint, mass);
  if (!Number.isFinite(rate)) return Infinity;
  return Math.ceil(rate * FLIGHT_MARGIN * (seconds + FLIGHT_RESERVE) + 2);
}
// Whether the thrusters of an aircraft that still work push it up harder than it weighs now, and level — `margin` times
// harder, where it is given —, in the air they breathe at the height it is at (`held`). One that carries more than they
// lift so — its load behind the thrusters that are left, say, or too much for the thin air high up — does not take off.
// What it holds up on a sling it weighs as with it (`laden`).
export function lifts(world: World, id: string, margin: number = 1) {
  const vehicle = world.actor(id)?.vehicle;
  return Boolean(vehicle) && held(world, id) > margin * laden(world, id) * GRAVITY;
}
// The highest an aircraft is flown, the height over sea level of its place (`vehicle.y`) with its centre of mass where the
// thrusters it has that work, thinning with the air they breathe (atmosphere.ts `thrustShare`), still hold it up `HOLDING`
// times what it weighs now, level — so that it climbs and leans there as its pilot flies it, under the height they hold
// it up at no more than once, where it would hang with nothing to spare to go along. About 1 km at the least for one they
// hold up so at their full thrust, all of which they give up to there (atmosphere.ts `RATED_ALTITUDE`), and nowhere
// (-Infinity) for one they do not: that one is flown at its floor over the ground.
export function ceiling(world: World, id: string) {
  const vehicle = world.actor(id)?.vehicle, lift = vehicle && uplift(world, id);
  return lift ? thrustAltitude(HOLDING * laden(world, id) * GRAVITY / lift.up) - lift.centre.y + vehicle.y : 0;
}
// What the thrusters of an aircraft that still work push it up with, in newtons, held level so (`lifts`), in the air they
// breathe at the height of its centre of mass.
function held(world: World, id: string) {
  const { up, centre } = uplift(world, id);
  return up * thrustShare(centre.y);
}
// What the thrusters of an aircraft that still work push it up with at sea level, level, and its centre of mass (`up`,
// `centre`), and what they push it along the field with in a level hull, towards less x and towards more (`sideways`): each
// as it points in its hull and as it stands about that centre, as the hull would hover level, however it leans now — in the
// air, leant into its way —, as its flight computer reckons what they hold it up with (`heldUp`); and what those that
// point further over push it along the field with, towards more x, holding it up still as it weighs now (`poise`).
function uplift(world: World, id: string): Uplift {
  const vehicle = requiredVehicle(world, id), turn = vehicle.angle || 0, c = Math.cos(turn), s = Math.sin(turn), local = vehicle.localCenter ?? { x: 0, y: 0 },
    centre = { x: vehicle.x + c * local.x - s * local.y, y: vehicle.y + s * local.x + c * local.y }, sideways: [number, number] = [0, 0], level: ThrustColumn[] = [];
  for (const m of world.modules) if (m.actorId === id && m.kind === 'thruster' && m.health > 0 && m.attached !== false) {
    const most = m.thrustN || 0, x = -most * Math.sin((m.angle || 0) - turn), y = most * Math.cos((m.angle || 0) - turn),
      dx = (m.x ?? centre.x) - centre.x, dy = (m.y ?? centre.y) - centre.y, along = c * dx + s * dy, over = c * dy - s * dx;
    sideways[x > 0 ? 1 : 0] += Math.abs(x);
    level.push([x, y, along * y - over * x]);
  }
  return { up: heldUp(level).up, centre, sideways, poise: heldUp(level, laden(world, id) * GRAVITY / thrustShare(centre.y)).push };
}
// What thrusters push an aircraft up with at the most with no torque about its centre of mass, each as it pushes it along
// the field, up and about that centre (`columns`), in newtons and newton-metres: all of each that turns it neither way and
// of those on the side that turns it the less, and of the others as much as turns it back as much, first those that push
// it up the most for what they turn it; of those that point no further off up than `FLIGHT_UPRIGHT`. Where those all turn
// it the same way — its centre of mass gone past all of them on one side, as the tanks of one with its main thruster near
// that centre run dry —, those further over — a jet laid along its hull —, which hold it up by nothing, turn it back for
// as much of them as they can, so long as what they push it along the field with is no more than leaning it
// `FLIGHT_BALANCE_LEAN` bears of all that holds it up — or, where the first of the others takes more, than leaning it as far
// as it hovers on that one alone, and never further than `FLIGHT_LEAN` —, those that push it along the least for what they
// turn it first: so it is still flown, as its flight computer still holds it up (game_hover.rs `held_up`, which this is) — all it
// pushes it up with (`up`), and what those further over push it along the field with, towards more x, as they turn it
// back (`push`): to the most it is held up by, or to `weight` newtons, held up still, at which it hovers leant to bear
// that push, as its flight computer holds it (`poised`).
function heldUp(columns: readonly ThrustColumn[], weight: number = Infinity) {
  const upright = (c: ThrustColumn) => c[1] > 0 && c[1] >= Math.cos(FLIGHT_UPRIGHT) * Math.hypot(c[0], c[1]), sides: [ThrustColumn[], ThrustColumn[]] = [[], []];
  let up = 0;
  for (const c of columns.filter(upright)) if (Math.abs(c[2]) < 1e-6 * c[1]) up += c[1]; else sides[c[2] > 0 ? 1 : 0].push(c);
  const turns = (side: readonly ThrustColumn[]) => side.reduce((sum, c) => sum + Math.abs(c[2]), 0), [less, more]: [ThrustColumn[], ThrustColumn[]] = turns(sides[1]) <= turns(sides[0]) ? [sides[1], sides[0]] : [sides[0], sides[1]];
  let left = turns(less);
  up += less.reduce((sum, c) => sum + c[1], 0);
  more.sort((a, b) => b[1] / Math.abs(b[2]) - a[1] / Math.abs(a[2]));
  // Where those all turn it one way, those further over that turn it back, each with how much of its torque is left.
  const way = !less.length && more.length ? Math.sign(more[0]![2]) : 0,
    over = columns.filter(c => !upright(c) && c[2] * way < 0).map(c => ({ c, spare: Math.abs(c[2]) })).sort((a, b) => Math.abs(a.c[0]) / a.spare - Math.abs(b.c[0]) / b.spare);
  let along = 0, push = 0, next = 0, bears = Math.tan(FLIGHT_BALANCE_LEAN);
  for (const c of more) {
    const share = Math.min(1, Math.max(0, left) / Math.abs(c[2]));
    up += share * c[1];
    left -= share * Math.abs(c[2]);
    // What of this one is left, given torque by torque as those further over turn it back: each gives as it is given so
    // much up for each of them, of this one and of itself, and so much along the field.
    let rest = (1 - share) * Math.abs(c[2]);
    while (rest > 0 && next < over.length && up < weight) {
      const o = over[next]!, lifts = c[1] / Math.abs(c[2]) + o.c[1] / Math.abs(o.c[2]), pushes = Math.abs(o.c[0]) / Math.abs(o.c[2]);
      if (!(lifts > 0)) return { up, push };
      if (!(up > 0)) bears = Math.max(bears, Math.min(pushes / lifts, Math.tan(FLIGHT_LEAN)));
      const room = pushes > bears * lifts ? Math.max(0, bears * up - along) / (pushes - bears * lifts) : Infinity,
        given = Math.min(rest, o.spare, room, (weight - up) / lifts);
      if (!(given > 0)) break;
      up += lifts * given; along += pushes * given; push += o.c[0] / Math.abs(o.c[2]) * given; rest -= given; o.spare -= given;
      if (given === room) return { up, push };
      if (!(o.spare > 0)) next++;
    }
    if (rest > 0) break;
  }
  return { up, push };
}
// The outline of an aircraft as its flight computer reads it (game_hover.rs `Underneath`): the corners of what touches the
// ground about its centre of mass, in a level hull, and where that centre is.
function outline(world: World, id: string) {
  const actor = requiredActor(world, id), vehicle = requiredVehicle(world, id), turn = vehicle.angle || 0, c = Math.cos(turn), s = Math.sin(turn),
    local = vehicle.localCenter ?? { x: 0, y: 0 };
  return { centre: { x: vehicle.x + c * local.x - s * local.y, y: vehicle.y + s * local.x + c * local.y },
    points: (actor.contactContours ?? []).flat().map(p => ({ x: p.x - local.x, y: p.y - local.y })) };
}
// How far an aircraft may be leant either way where it is, at the most: as far as its flight computer leans it (`FLIGHT_LEAN`),
// and, near the ground, no further than keeps the lowest of its outline `FLIGHT_CLEARANCE` over the ground under it, turned
// about its centre of mass (game_hover.rs `tilt`) — a long one, low, is leant little. None where it is lower than that level.
function leanable(world: World, id: string) {
  const { centre, points } = outline(world, id), span = points.reduce((most, p) => Math.max(most, Math.hypot(p.x, p.y)), 0),
    clear = (lean: number) => {
      const c = Math.cos(lean), s = Math.sin(lean);
      return points.reduce((least, p) => Math.min(least, centre.y + s * p.x + c * p.y - world.terrain.height(centre.x + c * p.x - s * p.y)), Infinity);
    }, side = (way: number) => {
      if (clear(way * FLIGHT_LEAN) >= FLIGHT_CLEARANCE) return FLIGHT_LEAN;
      let fits = 0, not = FLIGHT_LEAN;
      for (let i = 0; i < 8; i++) { const middle = (fits + not) / 2; if (clear(way * middle) >= FLIGHT_CLEARANCE) fits = middle; else not = middle; }
      return fits;
    };
  if (!points.length || centre.y - world.terrain.height(centre.x) > 2 * span + FLIGHT_CLEARANCE) return FLIGHT_LEAN;
  return clear(0) >= FLIGHT_CLEARANCE ? Math.min(side(1), side(-1)) : 0;
}
// How high an aircraft is to be flown over the ground, at the least, for the lowest of its outline, leant either way by
// `lean`, to be `FLIGHT_FLARE` over it: of where it is, the metres over the ground it stands at (`vehicle.y`).
function flare(world: World, id: string, lean: number) {
  const vehicle = requiredVehicle(world, id), { centre, points } = outline(world, id),
    lowest = points.reduce((low, p) => Math.min(low, ...[-1, 1].map(way => Math.sin(way * lean) * p.x + Math.cos(lean) * p.y)), 0);
  return FLIGHT_FLARE - lowest + vehicle.y - centre.y;
}
// What the thrusters of an aircraft that still work can do with it as it weighs now, held level (`held`): speed it up upwards
// over its weight (`climbs`), and along the field each way, towards less x and towards more (`along`), in m/s²: by what
// those that point that way in a level hull push it with (`uplift`, `sideways`), and by leaning it as far as it may be
// there (`leanable`) and they still hold it up at its height — all of it as its flight computer reckons how far its keys
// ask it along the field each way (game_hover.rs `fly`, `side`), so that it is asked as hard as its pilot means: reckoned
// on leaning alone, one with jets laid along its hull would be pushed the way they point several times harder than asked,
// and swing past where it is sent. What leaning alone speeds it up by (`leans`) is what its pilot plans to slow it down by:
// planned on its jets as well, it would come to its place faster than its keys hold it to the plan, and go past it. What
// those that point off up push it along the field with, towards more x, as it hovers still (`poise`, `uplift`). And
// how hard the air holds it back for the square of how fast it goes, for each kilogram of it, in 1/m, as dense as the air
// is at its height (atmosphere.ts): as it falls level, by what it shows the air under it (`falls`), and leant back as far
// to slow down along the field, by that and by what it shows the air the way it goes (`brakes`; game_motion.rs
// `Powertrain::air`). What its pilot plans to stop on (`fly`). With a load on its sling, as heavy as the two of them
// (`laden`) — the air on the load not reckoned —, and along the field no harder than its flight computer flies them
// (`SLING_BRISK`).
export function flight(world: World, id: string) {
  const actor = requiredActor(world, id), vehicle = requiredVehicle(world, id), mass = laden(world, id), thrust = uplift(world, id), share = thrustShare(thrust.centre.y),
    lift = thrust.up * share / mass, brisk = slung(world, id) ? SLING_BRISK : Infinity,
    leant = Math.min(GRAVITY * Math.tan(leanable(world, id)), Math.sqrt(Math.max(0, lift * lift - GRAVITY * GRAVITY)), brisk),
    along: [number, number] = [Math.min(leant + thrust.sideways[0] * share / mass, brisk), Math.min(leant + thrust.sideways[1] * share / mass, brisk)], lean = Math.atan2(leant, GRAVITY),
    air: Partial<NativePowertrain> = vehicle.drivetrain ?? {}, ahead = (vehicle.vx || 0) * (actor.facing || 1) >= 0 ? air.drag : air.dragAstern,
    thin = airDensity(vehicle.y) / AIR_DENSITY / mass;
  return { climbs: lift - GRAVITY, along, leans: leant, poise: thrust.poise * share / mass, falls: (air.dragUnder || 0) * thin, brakes: ((ahead || 0) * Math.cos(lean) + (air.dragUnder || 0) * Math.sin(lean)) * thin };
}
// What an aircraft weighs with what it holds up on a sling (sling.ts `slung`), in kg.
export const laden = (world: World, id: string) => (world.actor(id)?.vehicle?.mass ?? 0) + (slung(world, id)?.mass ?? 0);
// The most an aircraft takes up on its sling, in kg: what its thrusters hold it up with (`held`) over `HOLDING` times its
// weight, less its own mass — as the field reckons it (game_towing.rs `tow_lift`), and as its pilot then flies it (`lifts`).
export function slingLimit(world: World, id: string) {
  const vehicle = world.actor(id)?.vehicle;
  return vehicle ? Math.max(0, held(world, id) / (GRAVITY * HOLDING) - vehicle.mass) : 0;
}
// Whether an aircraft holds itself up as its pilot flies it: on all of its thrusters, as the Oficina passed it, or on those
// left of them once one is lost — destroyed or torn off, when it pushes nothing — holding it up `HOLDING` times what it
// weighs now, where it is. A thruster pushes all it has while it works, damaged or not.
export function steady(world: World, id: string) {
  return !world.modules.some(m => m.actorId === id && m.kind === 'thruster' && !(m.health > 0 && m.attached !== false)) || lifts(world, id, HOLDING);
}
// How far guns of a construction reach: a curved-fire gun by its arcs; any other no farther than the construction's own
// sensors see — its command optic at the least —, for it fires at what they hold. By default its guns that work, whatever
// rounds they have, which do not show: how far another side reckons it reaches.
export function gunReach(world: World, id: string, guns: readonly LiveWeapon[] = world.modules.filter(usableGun).filter(m => m.actorId === id)) {
  const sensors = world.modules.filter((m): m is Extract<LiveModule, { kind: 'sensor' }> => m.actorId === id && m.kind === 'sensor' && m.health > 0 && m.attached !== false),
    sight = Math.max(COMMAND_CAMERA_RANGE, ...sensors.map(m => (SENSOR_MODES[m.sensorMode ?? 'visual'] || SENSOR_MODES.visual).range));
  return Math.max(0, ...guns.map(gun => {
    const far = arcReach(gun.weaponPreset || 'rh120');
    return curved(gun) ? far : Math.min(far, sight);
  }));
}

export const DECISION_STEPS = 6; // a vehicle decides ten times a second; the physics stays at 60 Hz with one rigid solve per frame

// What hits leave on a part of a construction, which only grows with them: of a plate its holes and marks, of a piece its
// marks and the health it lost. What the ground did to it in a fall or a hard landing (the core's `groundMarks` and
// `groundDamage`, game_contact_damage.rs) is no hit, and is left out.
export const plateWear = (plate: { revision?: number; markRevision?: number; groundMarks?: number }) => (plate.revision || 0) + (plate.markRevision || 0) - (plate.groundMarks || 0);
export const pieceWear = (piece: Pick<LiveModule, 'health' | 'markRevision' | 'groundMarks' | 'groundDamage'>) => (piece.markRevision || 0) - (piece.groundMarks || 0) - piece.health - (piece.groundDamage || 0);

// One decision of the rule pilot of the core, which holds its place: where it aims its guns, which it fires, the
// contact it acts on and why it does what it does. An order may name the only enemy it engages.
const pilotRequest = (actorId: string, arenaBounds: PilotBounds, targetId: string | undefined) => ({ actorId, arenaBounds, ...(targetId ? { targetId } : {}) });
const pilotAction = (decision: ScriptedDecision): SquadAction => {
  const distance = decision.diagnostics?.nearestFreshContactDistance;
  if (distance !== null && (!Number.isFinite(distance) || distance < 0))
    throw new Error('Leitura de ameaça do piloto inválida.');
  return { ...decision.action, targetId: decision.targetId, contact: decision.contact, diagnostics: decision.diagnostics };
};
export function scriptedDecision(world: World, actorId: string, arenaBounds: PilotBounds, targetId?: string) {
  return pilotAction(decodeScriptedDecision(world.game().call({ op: 'scriptedDecision', ...pilotRequest(actorId, arenaBounds, targetId) })));
}

// The player's side of a field. Every vehicle of the team takes orders; at most
// one is under the player's own hands. An order lasts until it is done, replaced
// or the vehicle is taken over. Orders become ordinary inputs of the field.
// The field is one player's vehicles on the shared field, as the player's side has it (`Side`, server/room.ts): its
// world, a roster, the constructions out of action and the bounds its pilots are given; it takes inputs and turns a vehicle about, tells
// which enemies the side holds and which it sees, the veins it knows and the place nearest a construction to bring a load
// to — its base or a post — (`deposit`, `veinAt`, `depot` and `load`), and the guns its base places by their fire (`batteries`).
export class Squad {
  declare side: SquadSide;
  declare sampled: number | null;
  declare wear: Map<string, number>;
  declare manual: string | null;
  declare units: Map<string, SquadUnit>;
  declare contacts: Map<string, { seenAt: number; event: string }>;
  declare rooms: WeakMap<CompiledConstruction, number>;
  // The first sample creates this field. Readers follow prepareDecision's
  // sample, including decide's prepared batch and its counter call below.
  declare placed: SquadGroundBattery[] | undefined;

  constructor(side: SquadSide) {
    this.side = side; this.sampled = null; this.wear = new Map(); this.manual = null; this.units = new Map(); this.contacts = new Map(); this.rooms = new WeakMap(); this.sync();
  }
  get members() { return this.side.roster.filter(m => m.team === 'local'); }
  // Vehicles are published on the field and removed from it.
  sync() {
    const members = this.members;
    for (const m of members) if (!this.units.has(m.id)) this.units.set(m.id,
      { stance: 'return', fireAt: null, move: null, attack: null, haul: null, halt: '', alertUntil: -Infinity, answerUntil: -Infinity, heardAt: -Infinity,
        heard: null, threat: false, scare: null, activity: 'idle', reason: '', targetId: null, counter: null, counters: new Map() });
    if (this.units.size > members.length) for (const id of [...this.units.keys()]) if (!members.some(m => m.id === id)) this.units.delete(id);
    for (const unit of this.units.values()) if (unit.terrainPlan && unit.terrainPlan.leg !== unit.move) delete unit.terrainPlan;
    if (this.manual && !this.units.has(this.manual)) this.manual = null;
    return members;
  }
  unit(id: string): SquadUnit {
    const unit = this.units.get(id); if (!unit) throw new Error('Veículo ausente do esquadrão: ' + id); return unit;
  }
  alive(id: string) { return this.units.has(id) && !this.side.defeats[id]; }
  // A vehicle with something to do. The others only watch, and may look around less often: so does a
  // hauler while it loads or unloads, which only waits.
  busy(id: string) {
    const unit = this.units.get(id);
    const time = this.side.world.time;
    return Boolean(unit && (unit.move || unit.attack || unit.stance === 'fire' || unit.alertUntil > time || unit.answerUntil > time));
  }
  // An enemy still on the field and in the fight, by what the side is told of it (`foe`): an enemy lost from sight is
  // one still, whatever became of it, until the side sees it out of the fight or gone.
  enemy(id: string) { return this.side.foe(id); }
  // Whether the side may be shown where an enemy is and which it is: it has it in sight or on its radar.
  sighted(id: string) { return this.side.sighted(id); }
  // Letting go is an input like any other: the trigger let go, the shot it waited to lay dropped, the brakes on.
  release(id: string) {
    this.side.input(id, { type: 'trigger', active: false, cancel: true });
    this.side.input(id, { type: 'drive', throttle: 0, brake: 1 });
  }

  // Whether an order to vehicles may be given at all, refused in words as `command` refuses it, before anything changes for
  // it: an order the squad knows, with a place, a stance, a vein the faction knows and no base stills, or an enemy. Returns
  // the vein of a haul.
  check(data: SquadCommand) {
    const order = data.order;
    if (order === 'stance' && !Object.hasOwn(STANCES, data.stance)) throw new Error('Postura desconhecida.');
    if (order === 'move' && (!Number.isFinite(data.x) || data.y != null && !Number.isFinite(data.y))) throw new Error('Destino inválido.');
    // A haul is ordered on a vein the faction knows of: of any other place the refusal says the same, whatever lies there.
    if (order === 'haul') {
      const deposit = this.side.deposit(data.depositId);
      if (!deposit) throw new Error('Jazida desconhecida: escolha uma que a facção já encontrou. Explore o campo para achar outras.');
      if (deposit.stilled) throw new Error('Essa jazida fica perto demais de uma base: escolha outra.');
      return deposit;
    }
    if (order === 'attack' && !this.enemy(data.targetId)) throw new Error('Alvo inválido.');
    if (order === 'bombard' && (!Number.isFinite(data.point?.x) || !Number.isFinite(data.point?.y))) throw new Error('Ponto de ataque inválido.');
    if (!['stance', 'move', 'attack', 'bombard', 'stop', 'home'].includes(order)) throw new Error('Ordem desconhecida.');
    return null;
  }
  command(data: SquadCommand) {
    const order = data.order; this.sync();
    if (order === 'control') {
      if (data.id != null && !this.alive(data.id)) throw new Error('Este veículo não pode ser controlado.');
      if (data.id === this.manual) return;
      if (this.manual) {
        const unit = this.unit(this.manual);
        this.release(this.manual);
        if (unit?.stance === 'fire') unit.fireAt = this.position(this.manual);
      }
      this.manual = data.id ?? null;
      if (this.manual) { Object.assign(this.obey(this.manual), IDLE, { fireAt: null, reason: '', targetId: null }); this.release(this.manual); }
      return;
    }
    const deposit = this.check(data), ids = [...new Set(data.ids || [])].filter(id => this.alive(id) && id !== this.manual), at = (id: string) => this.position(id);
    if (order === 'stance') {
      for (const id of ids) {
        const unit = this.unit(id); unit.stance = data.stance;
        if (LOCAL_LEGS.includes(unit.move?.purpose ?? '')) unit.move = null;
        unit.fireAt = data.stance === 'fire' ? this.position(id) : null;
        if (data.stance === 'fire' && !unit.haul && !unit.move && !unit.attack) this.obey(id);
        if (data.stance === 'hold') unit.attack = null;
      }
      return;
    }
    if (order === 'move') {
      // A point of the sky, as high over the ground there as a vehicle that flies is flown at the least or higher, sends
      // those that fly there at that height over the ground (`fly`); a point lower, or under the ground, or one with no
      // height, is the ground there, where those that fly come down (`landing`).
      const above = typeof data.y === 'number' && Number.isFinite(data.y) ? data.y - this.side.world.terrain.height(data.x) : -Infinity,
        sky = above >= FLIGHT_FLOOR ? { height: above, sky: true as const } : null,
        down = sky ? [] : ids.filter(id => this.flier(id)).sort((a, b) => at(a) - at(b)), placing = new Set(ids);
      // Each of the others gets its own place, in the order they stand, end to end about the place with the gap between
      // them, clear of where the rest of the side stands or goes. Sent onto a vein the faction knows, they stop within its
      // reach, where what stands still is loaded from it, as near the place as that lets them, beside those that work it
      // the other way (`beside`).
      const span = this.span(), vein = this.side.veinAt(data.x),
        lo = Math.max(span.lo, vein ? vein.x - vein.reach + EDGE : -Infinity),
        hi = Math.min(span.hi, vein ? vein.x + vein.reach - EDGE : Infinity),
        line = ids.filter(id => !down.includes(id)).sort((a, b) => at(a) - at(b)), rooms = line.map(id => this.room(id));
      let edge = data.x - (rooms.reduce((sum, room) => sum + room, 0) + GAP * (line.length - 1)) / 2;
      // Each keeps apart from those at about the height it goes at: an aircraft sent up there from those flown there, not
      // from what stands on the ground under it (`clear`).
      for (const [i, id] of line.entries()) {
        const site = vein?.id ? this.side.deposit(vein.id, id) : null, area = site?.area,
          left = area ? area.lo + ARRIVAL : lo, right = area ? area.hi - ARRIVAL : hi, flier = this.flier(id),
          x = this.clear(id, clamp(edge + rooms[i]! / 2, left, right), left, right, site ? this.beside(id, site, placing) : placing, false, flier ? sky!.height : 0);
        edge += rooms[i]! + GAP;
        Object.assign(this.obey(id), { haul: null, move: { ...this.leg(id, x), purpose: 'order', ...(flier ? sky : {}) } }); placing.delete(id);
      }
      // Those that fly come down about the place after them, in the order they stand, each where it finds room clear of
      // where the others stop.
      for (const id of down) { this.land(id, 'order', this.landing(id, data.x, placing)); placing.delete(id); }
      return;
    }
    // Sent home, each goes to the base or the post nearest it (`depot`), in the order they stand: one that flies comes down
    // there (`land`), where it is filled up; one that drives stops inside its edge, as a hauler stops there to unload
    // (`haul`), or where it is when it stands in it already; with neither, it stops where it is.
    if (order === 'home') {
      for (const id of ids.slice().sort((a, b) => at(a) - at(b))) {
        if (this.flier(id)) { this.land(id, 'order'); continue; }
        const place = this.side.depot?.(id), x = at(id);
        if (!place) { Object.assign(this.obey(id), IDLE); continue; }
        const goal = Math.abs(x - place.x) <= place.radius ? x : place.x + Math.sign(x - place.x) * (place.radius - DEPOT_INSET);
        Object.assign(this.obey(id), { haul: null, attack: null,
          move: { ...this.leg(id, this.clear(id, goal, place.x - place.radius + EDGE, place.x + place.radius - EDGE)), purpose: 'home' } });
      }
      return;
    }
    // To a known pickup and back to base with its compatible containers, again and again.
    if (order === 'haul') {
      if (!deposit) throw new Error('Coleta sem jazida conferida.');
      // One that stands where it tipped part of its load out begins by taking what it has left home: there it would not be filled up.
      for (const id of ids) Object.assign(this.obey(id), { move: null,
        haul: { depositId: data.depositId, ...(deposit.refined ? { refined: true } : { material: deposit.material }),
          phase: this.side.tipped?.(id) ? 'home' : 'out' } satisfies SquadHaul });
      return;
    }
    if (order === 'attack') {
      for (const id of ids) this.obey(id).attack = { targetId: data.targetId };
      return;
    }
    if (order === 'bombard') {
      for (const id of ids) this.obey(id).attack = { point: { x: data.point.x, y: data.point.y } };
      return;
    }
    for (const id of ids) Object.assign(this.obey(id), IDLE, { fireAt: null });
  }
  // A way to drive: the place, how near the vehicle has come to it and when it last came nearer.
  // The way to a place: how near the vehicle has got, and since when it gets no nearer. Sent there while it rolls the other
  // way, it has to stop first (`turning`).
  leg(id: string, x: number): SquadMove {
    const at = this.position(id), vx = requiredActor(this.side.world, id).vehicle?.vx || 0;
    return { x, best: Math.abs(x - at), since: this.side.world.time, turning: vx * Math.sign(x - at) < -ROLLING };
  }
  // A vehicle something held where it stood — being built, or turning about — takes up the way it was sent on
  // from where it is: how long it has got no nearer counts from now, not from when it was sent. On its way to a vein it
  // works out again where to stop there: that follows the way it faces, and a vehicle turned about has its tool and its
  // containers at the other end.
  resume(id: string) {
    const unit = this.units.get(id);
    if (unit?.haul) { delete unit.haul.blocked; delete unit.haul.parkedAt; }
    if (unit?.haul?.phase === 'out') unit.move = null;
    if (unit?.move) Object.assign(unit.move, { best: Math.abs(unit.move.x - this.position(id)), since: this.side.world.time });
  }
  // Whether a vehicle flies on thrusters (ui-model.ts `flies`).
  flier(id: string) { return (this.side.world.actor(id)?.vehicle?.thrustN ?? 0) > 0; }
  // An aircraft sent to land, by an order — Mover to a place of the ground, or home (`command`) — or for its fuel
  // (`homeward`), its rounds (`strike`) or a thruster it lost (`mend`): at the place of the ground it was sent to (`at`),
  // or else at a clear place in the base or the post nearest it (`depot`), where it is filled up as any vehicle once it
  // stands on its skids, or where it is if its side has none. It goes there as a Move sends it and comes down there
  // (`fly`); a gun it was told to fire with it leaves for it. Anywhere of its base or post will do for it, or of the stretch
  // it is given (`within`), as it comes down there (`touchdown`).
  land(id: string, why: SquadLandingReason, at: number | null = null, within: SquadSpan | null = null) {
    const place = at === null && this.side.depot?.(id), inside = place ? { lo: place.x - place.radius + EDGE, hi: place.x + place.radius - EDGE } : null,
      x = at !== null ? at : place && inside ? this.clear(id, place.x, inside.lo, inside.hi) : this.position(id), stretch = within ?? inside;
    Object.assign(this.obey(id), { haul: null, attack: null, move: { ...this.leg(id, x), purpose: 'land', land: why, ...(stretch ? { within: stretch } : {}) } });
  }
  // An aircraft coming down where any place of a stretch will do (`leg.within`) — that starts down only within `ARRIVAL`
  // of its place (`fly`) —, slowed near its place to the pace it comes down at, over level ground of the stretch clear of
  // the side, comes down where it is.
  touchdown(id: string, unit: SquadUnit) {
    const leg = unit.move;
    if (!leg?.land || !leg.within) return;
    const within = leg.within, vehicle = this.side.world.actor(id)?.vehicle;
    if (!vehicle?.flying) return;
    const x = this.position(id), off = Math.abs(x - leg.x);
    if (off > ARRIVAL && off <= TOUCHDOWN && Math.abs(vehicle.vx || 0) <= TOUCHDOWN_SPEED && x >= within.lo && x <= within.hi &&
      this.level(id, x) && this.clear(id, x, x, x, new Set([id]), true) !== null) leg.x = x;
  }
  // Where an aircraft sent to land at `at` comes down: the place nearest it, within `FARTHEST` — and from `lo` to `hi`,
  // where it is to come down within a stretch of the field —, where the ground under its length is level enough (`level`)
  // and no vehicle of the side stands or is sent (`clear`; those landing with it, `placing`, hold nothing yet); at `at` all
  // the same if there is none, or nowhere when it is to come down there or not at all (`strict`).
  landing(id: string, at: number, placing: Set<string>, options?: Partial<SquadLandingSpan> & { strict?: false }): number;
  landing(id: string, at: number, placing: Set<string>, options: Partial<SquadLandingSpan> & { strict: true }): number | null;
  landing(id: string, at: number, placing: Set<string>, { lo: from = -Infinity, hi: to = Infinity, strict = false }: Partial<SquadLandingSpan> = {}): number | null {
    const span = this.span(), lo = Math.max(span.lo, from), hi = Math.min(span.hi, to);
    for (let step = 0; step <= FARTHEST; step++) for (const x of step ? [at - step, at + step] : [at]) {
      if (x < lo || x > hi || !this.level(id, x)) continue;
      const place = this.clear(id, x, lo, hi, placing, true);
      if (place !== null && this.level(id, place)) return place;
    }
    return strict ? null : clamp(at, lo, hi);
  }
  // Whether an aircraft may come down at `x`: the ground under its length rises no more than `LANDING_SLOPE` to the metre
  // there. With `to`, whether it may anywhere from `x` to `to`, as it is told half a metre at a time.
  level(id: string, x: number, to: number = x) {
    const terrain = this.side.world.terrain, half = this.room(id) / 2,
      flat = (at: number) => Math.abs(terrain.height(at + half) - terrain.height(at - half)) <= LANDING_SLOPE * 2 * half;
    for (let at = x; at < to; at += .5) if (flat(at)) return true;
    return flat(to);
  }
  // Why an aircraft of the squad on its skids does not take off to go on with its haul, in a word: its thrusters do not
  // lift what it carries now (`too-heavy`), or none of them works (`immobile`); or, away from its base or post (`depot`),
  // what it burns on the whole way there leaves it short of its reserve (`fuel-home`, `homeFuel`, `reserve`), where it waits
  // for a supply vehicle — while it keeps its fuel to come home (`homing`). Nothing when it may.
  grounded(id: string, depot: import('./squad-contract.ts').SquadDepot | null) {
    const world = this.side.world, vehicle = requiredVehicle(world, id);
    if (!lifts(world, id)) return (vehicle.thrustN ?? 0) > 0 ? 'too-heavy' : 'immobile';
    const away = depot ? Math.max(0, Math.abs(depot.x - vehicle.x) - depot.radius) : 0;
    return away > 0 && this.homing(id) && (vehicle.fuelLitres ?? 0) < this.homeFuel(id) + this.reserve(id) ? 'fuel-home' : '';
  }
  // Whether the tanks of a vehicle that still hold fuel are full.
  topped(id: string) {
    return this.side.world.modules.every(m => m.actorId !== id || m.kind !== 'fuel' || !(m.health > 0) || m.attached === false ||
      m.fuelLitres >= m.capacityLitres - .5);
  }
  // An aircraft in the air whose fuel takes it to the nearest of its base and posts with little to spare is sent to land
  // there (`land`). What it burns to the metre is read as it cruises (`burn`): over each `FUEL_SAMPLE` it goes faster than
  // `FLIGHT_HOMING` one way, gaining or losing no more than `CRUISE_STEADY` of its speed and coming down by no more than
  // that of the metres it goes — not speeding up, slowing down nor turning about, which its way reckons apart, nor falling
  // with its thrusters idling —, against what it is reckoned to burn so (`cruise`), a reading eased into the one kept
  // (`scale`): what its thrusters, its hull and what it carries make of its flight that is not reckoned. What it needs is
  // what its whole way home takes (`homeFuel`) — along the field, up where the ground there is higher, and down from as
  // high as it is —, and its reserve (`reserve`): one that crosses the field at 300 m/s, what flying home so takes; one high
  // over its base, what it takes to come down.
  // One already landing is let be, but one coming down where it works (`land: 'work'`) — and not there either in its base
  // or post, home from its work or to load there for it (supply-dispatch.ts `home`, `depot`): it goes where it would be sent
  // for its fuel, and is free on its way for its next job, whose fuel the job reckons (supply-dispatch.ts `offer`). One on a
  // haul goes home by it, and takes it up again from there once it is filled up (`haul`, `fuel`); one on a job of its
  // faction's keeps it as well (supply-dispatch.ts `fuelling`). One that does not keep its fuel to come home (`homing`) is
  // read all the same, and never sent home for it.
  homeward(id: string, unit: SquadUnit) {
    const world = this.side.world, actor = world.actor(id), vehicle = actor?.vehicle;
    if (!vehicle?.flying || !((vehicle.thrustN ?? 0) > 0)) { unit.burn = null; return; }
    const now = world.time, litres = vehicle.fuelLitres ?? 0, read = unit.burn, vx = vehicle.vx || 0;
    if (!read) unit.burn = { at: now, litres, x: vehicle.x, y: vehicle.y, vx, scale: null };
    else if (now - read.at >= FUEL_SAMPLE) {
      const span = now - read.at, burnt = read.litres - litres, gone = Math.abs(vehicle.x - read.x), speed = gone / span,
        steady = speed > FLIGHT_HOMING && burnt > 0 && vx * read.vx > 0 && Math.abs(vx - read.vx) <= CRUISE_STEADY * speed &&
          read.y - vehicle.y <= CRUISE_STEADY * gone,
        go = steady && cruise(world, id, uplift(world, id), Math.sign(vx), vehicle.y, 0), reckoned = go ? go.burns(speed) / speed : 0,
        scale = reckoned > 0 && Number.isFinite(reckoned) ? burnt / gone / reckoned : null;
      unit.burn = { at: now, litres, x: vehicle.x, y: vehicle.y, vx,
        scale: scale === null ? read.scale : read.scale === null ? scale : read.scale + (scale - read.scale) * FUEL_METRE };
    }
    const home = !unit.haul && unit.move?.land === 'work' && this.side.depot?.(id);
    if (unit.move?.land && unit.move.land !== 'work' || !this.homing(id) || home && Math.abs(unit.move!.x - home.x) <= home.radius) return;
    if (litres > this.homeFuel(id, unit.burn) + this.reserve(id)) return;
    // Sent home so on its way to its vein after it left home full (`full`), it does not reach it and come back: it gives up
    // its haul at home (`far`).
    if (unit.haul && !unit.haul.blocked) {
      if (unit.haul.phase === 'out' && unit.haul.full) unit.haul.far = true;
      Object.assign(unit.haul, { phase: 'home', fuel: true }); unit.move = null;
    } else this.land(id, 'fuel');
  }
  // The litres an aircraft is reckoned to burn on its whole way home, from where it is to the middle of the nearest of its
  // base and posts (`depot`), by which it is sent to come down (`land`) — or down where it is, where its side has none —,
  // coming down there (`flightLitres`): along the field as it was read to burn (`burn`, `homeward`), up as much as the
  // ground there is higher than under it, and down from as high over the ground as it is, which it holds on its way.
  homeFuel(id: string, burn: SquadBurn | null | undefined = null) {
    const place = this.side.depot?.(id);
    return this.flightLitres(id, this.aloft(id), { x: place ? place.x : this.position(id), height: 0, land: true }, burn);
  }
  // What an aircraft is to have left as it comes down home: what it burns hovering, as heavy as it is now (`hoverRate`), for
  // `FLIGHT_RESERVE`.
  reserve(id: string) {
    const actor = requiredActor(this.side.world, id);
    return hoverRate(actor.blueprint, laden(this.side.world, id)) * FLIGHT_RESERVE;
  }
  // Where an aircraft is: along the field, and how high over the ground there; how fast it goes along it, and the way it faces.
  aloft(id: string) {
    const x = this.position(id), actor = requiredActor(this.side.world, id), vehicle = actor.vehicle;
    return { x, height: Math.max(0, (vehicle?.y ?? 0) - this.side.world.terrain.height(x)), vx: vehicle?.vx || 0, facing: actor.facing || 1 };
  }
  // The litres an aircraft is reckoned to burn flying from one place to another, each a place along the field and a height
  // over the ground there (`from`, `to`) — `to.land` where it comes down there; `from.vx`, how fast it goes along the field
  // there, and `from.facing`, the way it faces there —, as its pilot flies it (`fly`): along the field at the height over the
  // ground of the point of the sky it is sent to, or, sent to land, at the one it is at and no lower than its floor; climbing
  // as the ground under its way rises from where it is to where it goes, and to that height; and coming down from it at the
  // end of its way, to the ground or to the point of the sky lower than it. Where the ground falls away under its way it
  // comes down as it goes, and that is not reckoned. Along the field as it cruises there (`cruise`, `legLitres`) — as much
  // more or less as it was read to burn cruising (`burn`, `homeward`) —, from as fast as it goes there its way: going the
  // other way, it is slowed to a hover first, as its pilot plans to slow it, and comes back as far as that takes it; turned
  // about for it, it hovers meanwhile (`AIR_TURN_SECONDS`). Up as it climbs (`climbing`), each `HOMING_MARGIN` more, and
  // down as it comes down (`descentCost`).
  flightLitres(id: string, from: AloftPlace, to: FlightDestination, burn: SquadBurn | null | undefined = null) {
    const world = this.side.world, actor = requiredActor(world, id), mass = laden(world, id), ground = (x: number) => world.terrain.height(x), thrust = uplift(world, id),
      along = Math.abs(to.x - from.x), way = Math.sign(to.x - from.x) || 1, held = to.land ? Math.max(FLIGHT_FLOOR, from.height) : to.height,
      up = Math.max(0, ground(to.x) - ground(from.x)) + Math.max(0, held - from.height), down = to.land ? held : Math.max(0, from.height - to.height),
      altitude = Math.max(ground(from.x), ground(to.x)) + held, vx = from.vx || 0, away = Math.max(0, -vx * way),
      // Going the other way, it is slowed as its pilot plans it (`fly`): leant back once it has leant the other way, and by
      // the air the way it goes now (`flight`).
      lean = away > 0 ? cruise(world, id, thrust, way, altitude).leans : 0, hold = away > 0 ? flight(world, id).brakes : 0,
      stop = !(away > 0) ? 0 : !(lean > 0) ? Infinity : away * FLIGHT_TURN + (hold > 1e-9 ? Math.log1p(hold * away * away / lean) / (2 * hold) : away * away / (2 * lean)),
      stopping = !(away > 0) ? 0 : FLIGHT_TURN + (hold > 1e-9 ? Math.atan(away * Math.sqrt(hold / lean)) / Math.sqrt(hold * lean) : away / lean),
      go = cruise(world, id, thrust, way, altitude, along + stop, away > 0 ? 0 : vx, from.facing),
      flown = along > 0 ? legLitres(along + stop, go, burn?.scale ?? 1, Math.max(0, vx * way)) + go.hovers * ((go.turns ? AIR_TURN_SECONDS : 0) + stopping) : 0;
    return HOMING_MARGIN * (flown + legLitres(up, climbing(world, id, thrust, altitude))) + descentCost(actor.blueprint, mass, down, ground(to.x)).litres;
  }
  // Whether an aircraft keeps its fuel to come home, as its side has it (Side.homing): its pilot sends it home for its fuel
  // (`homeward`), and it takes no order of the player's that would leave it short of that (`fuelRefusal`). By default it does.
  homing(id: string) { return this.side.homing?.(id) ?? true; }
  // Why an aircraft that keeps its fuel to come home (`homing`) does not take an order of the player's (`fuelRefused`), or
  // nothing when it takes it. On its way home for its fuel (`homeward`) — in the air, sent to land for it or on its haul
  // home for it — it takes none but one that takes it home: Base, or Mover to the ground of its base or a post
  // (`returning`). Else it takes one that sends it somewhere only with the fuel to go there and come home from there — to
  // the middle of the base or post nearest there, as for its fuel (`homeFuel`), but where it comes down within one —, with
  // its reserve to spare (`flightLitres`, `reserve`, `short`): to the point of the sky it is sent to, or down to the place of
  // the ground; over the enemy it is sent to attack, where its side holds it, or the point it is sent to bombard, as high as
  // it is and no lower than it strikes from (`STRIKE_FLOOR`); down by the vein of a haul. Parar and a stance send it nowhere:
  // it takes them but on its way home for its fuel, and its pilot sends it home from where it is when it has to. Nothing of
  // what does not fly, nor of the one in the player's hands, who flies it as he will.
  fuelRefusal(id: string, data: SquadCommand) {
    const unit = this.units.get(id), vehicle = this.side.world.actor(id)?.vehicle, order = data.order;
    if (!unit || !vehicle || id === this.manual || !this.flier(id) || !this.homing(id) || ['stance', 'home'].includes(order)) return '';
    const to = this.destination(id, data), place = to?.land && this.side.depot?.(id, to.x);
    if (vehicle.flying && (unit.move?.land === 'fuel' || unit.haul?.fuel && unit.haul.phase === 'home'))
      return place && Math.abs(to!.x - place.x) <= place.radius ? '' : 'returning';
    if (!to) return '';
    const burn = unit.burn, back = this.side.depot?.(id, to.x), home = back && !(to.land && Math.abs(to.x - back.x) <= back.radius) ? back.x : to.x,
      start = this.aloft(id), along = Math.abs(to.x - start.x),
      facing = cruise(this.side.world, id, uplift(this.side.world, id), Math.sign(to.x - start.x) || start.facing, 0, along, start.vx, start.facing).facing,
      need = this.flightLitres(id, start, to, burn) + this.flightLitres(id, { ...(to.land ? { x: to.x, height: 0 } : to), facing }, { x: home, height: 0, land: true }, burn) +
        this.reserve(id);
    return (vehicle.fuelLitres ?? 0) < need ? 'short' : '';
  }
  // Where an order of the player's sends an aircraft (`fuelRefusal`), as a place along the field and a height over the ground
  // there, or the ground there (`land`); nowhere for one that holds it where it is, or one whose place its side does not hold.
  destination(id: string, data: SquadCommand): FlightDestination | null {
    const span = this.span(), ground = (x: number) => this.side.world.terrain.height(x), at = (x: number) => clamp(x, span.lo, span.hi),
      over = (x: number) => ({ x: at(x), height: Math.max(STRIKE_FLOOR, this.aloft(id).height) });
    if (data.order === 'move') {
      const x = at(data.x), above = typeof data.y === 'number' && Number.isFinite(data.y) ? data.y - ground(data.x) : -Infinity;
      return above >= FLIGHT_FLOOR ? { x, height: above } : { x, land: true };
    }
    if (data.order === 'bombard') return over(data.point.x);
    if (data.order === 'attack') { const held = this.side.whereabouts?.(data.targetId); return held ? over(held.x) : null; }
    if (data.order === 'haul') { const vein = this.side.deposit(data.depositId); return vein ? { x: at(vein.x), land: true } : null; }
    return null;
  }
  // An aircraft that loses a thruster in the air — destroyed or torn off: the others push as they did — is flown on what
  // the thrusters it has left can do with it, as its pilot reckons it at every round (`flight`). Where the thrusters it has left
  // do not hold it up as its pilot flies it (`steady`), it is sent to be mended (`mend`), and is so (`unit.mend`) until they
  // do again — mended, or lighter —, when it takes its haul or its job up again where it is in it (`haul`, supply-dispatch.ts
  // `fuelling`). On its skids with nothing else to do meanwhile, it says so (`MENDING`). A loss is told by what its
  // thrusters push with at the most (`thrustN`), which a repair gives back. One on its skids takes off only where those left
  // lift it (`grounded`), and its pilot looks at what it lost there once it is in the air; so is one in the player's hands
  // looked at once he lets go of it, and any order of his takes the place of being mended (`obey`). What it burns a second
  // holding up what it weighs is the same on fewer thrusters (game_hover.rs `SPECIFIC_FUEL`, by the newton): that is not
  // read again.
  crippled(id: string, unit: SquadUnit) {
    const world = this.side.world, actor = world.actor(id), vehicle = actor?.vehicle;
    if (!vehicle || !aircraft(actor)) return;
    const thrust = vehicle.thrustN || 0, kept = unit.thrust ?? thrust, lost = vehicle.flying && thrust < kept - 1e-6;
    unit.thrust = vehicle.flying ? thrust : Math.max(kept, thrust);
    if (unit.mend && steady(world, id)) { delete unit.mend; if (unit.halt === MENDING) unit.halt = ''; }
    else if (lost && !steady(world, id)) this.mend(id, unit);
    if (unit.mend && !vehicle.flying && !unit.move && !unit.haul) unit.halt = MENDING;
  }
  // Where an aircraft in the air its thrusters left no longer hold up as its pilot flies it goes (`crippled`). It comes down
  // where it is — on the level ground nearest it (`landing`), or right there where they do not hold it up at all (`lifts`) —
  // when that is all it may do: they do not hold it up, its side has no base nor post, or its fuel does not take it to the
  // nearest of them with its reserve to spare (`homeFuel`, by what it was read to burn, and `reserve`); what it was doing
  // ends there, and it waits there for a supply vehicle to mend it. Else it goes there to come down (`land`), where the base
  // mends it as it fills it up, standing still out of combat (SharedRoom.serve): what it was told to do ends, but a haul,
  // which it goes home by as for its fuel (`homeward`), and takes up again from there once it is mended.
  mend(id: string, unit: SquadUnit) {
    const world = this.side.world, vehicle = requiredVehicle(world, id), x = this.position(id), place = this.side.depot?.(id), held = lifts(world, id),
      need = this.homeFuel(id, unit.burn) + this.reserve(id);
    if (!held || !place || (vehicle.fuelLitres ?? 0) < need) this.land(id, 'forced', held ? this.landing(id, x, new Set([id])) : x);
    else if (unit.haul && !unit.haul.blocked) { Object.assign(unit.haul, { phase: 'home', mend: true }); unit.move = null; }
    else this.land(id, 'mend');
    unit.mend = true;
  }
  // A new order clears why the last one ended, and what its pilot was mending it for (`mend`).
  obey(id: string) {
    const unit = this.unit(id);
    if (LOCAL_LEGS.includes(unit.move?.purpose ?? '')) unit.move = null;
    delete unit.hopped; delete unit.takeoff; delete unit.mend;
    return Object.assign(unit, { halt: '', haltEvent: null });
  }
  position(id: string) { const actor = requiredActor(this.side.world, id); return actor.vehicle?.x ?? actor.x; }
  // Where a construction of the field is, along it and up: a vehicle by its body, on the ground or in the air, and a
  // structure by its origin.
  place(id: string): Point {
    const actor = requiredActor(this.side.world, id);
    if (actor.vehicle) return actor.vehicle;
    if (actor.y === undefined) throw new Error('Estrutura sem altura publicada.');
    return { x: actor.x, y: actor.y };
  }
  // How far apart two constructions of the field are: the straight line between them, along the field and up alike.
  apart(id: string, other: string) { const a = this.place(id), b = this.place(other); return Math.hypot(b.x - a.x, b.y - a.y); }
  // The stretch of the field a vehicle can be sent to: its ground, short of each end by as much as the field holds a
  // vehicle from it (`WORLD_EDGE`). A place beyond is as far as the vehicle can go that way: it is sent there instead,
  // and its order ends where the field holds it, not on a way that seems shut.
  span() { const { minX, maxX } = this.side.world.terrain; return { lo: minX + WORLD_EDGE, hi: maxX - WORLD_EDGE }; }
  // How long a vehicle is, end to end, by the plates of its frame; one whose frame tells nothing is taken as a common one.
  room(id: string) {
    const blueprint = this.side.world.actor(id)?.blueprint;
    if (!blueprint?.plates?.length) return ROOM;
    if (!this.rooms.has(blueprint)) {
      const ends = blueprint.plates.flatMap(p => { const half = Math.abs(Math.cos(p.angle || 0)) * p.length / 2; return [p.x - half, p.x + half]; });
      this.rooms.set(blueprint, Math.max(...ends) - Math.min(...ends));
    }
    return this.rooms.get(blueprint)!;
  }
  // The nearest place to `x`, between `lo` and `hi`, that no other vehicle of the side stands at or is going to: sent
  // to one place, or to one vein, or home to unload, the squad does not stack its vehicles — on a field where they drive
  // through each other they would stand in one. A vehicle of the squad on its way somewhere holds the place it goes to;
  // any other vehicle of the side, the place it stands at; each holds its own length and the gap. A structure holds
  // none: vehicles drive through it, and stand in it to take in what it digs. Those being placed with this
  // one (`placing`) hold nothing yet, nor, at a vein, those that work it the other way (`beside`). With `x` taken it is
  // the nearest place just clear of one of them, on the side the vehicle comes from when two are as near; with none
  // within `FARTHEST` it goes to `x` all the same. Only what the squad drives keeps apart: the vehicle in the player's
  // hands goes where it is driven. Only those at about the height over the ground it is to stand at (`height`, the ground
  // by default) hold a place against it, within `STACKED` of it (`heldHeight`): an aircraft in the air is sent over a
  // vehicle on the ground, and a vehicle on the ground under one in the air, as two in the air at heights apart. What an
  // aircraft carries on its sling holds none against it: it is set down where the aircraft comes down to set it down.
  clear(id: string, x: number, lo: number, hi: number, placing?: Set<string>, strict?: false, height?: number): number;
  clear(id: string, x: number, lo: number, hi: number, placing: Set<string>, strict: true, height?: number): number | null;
  clear(id: string, x: number, lo: number, hi: number, placing: Set<string> = new Set([id]), strict: boolean = false, height: number = 0): number | null {
    const room = this.room(id), start = clamp(x, lo, hi), side = Math.sign(this.position(id) - start) || 1, load = slung(this.side.world, id)?.id,
      taken = this.side.roster.flatMap(m => m.team === 'opponent' || placing.has(m.id) || m.id === load || this.side.defeats[m.id] || !this.side.world.actor(m.id)?.vehicle ||
        Math.abs(this.heldHeight(m.id) - height) >= STACKED ? [] : [{ x: this.held(m.id), apart: (room + this.room(m.id)) / 2 + GAP }]),
      free = (place: number) => place >= lo && place <= hi && taken.every(other => Math.abs(other.x - place) >= other.apart - 1e-6);
    if (free(start)) return start;
    const near = (a: number, b: number) => Math.abs(Math.abs(a - start) - Math.abs(b - start)) > 1e-6 ? Math.abs(a - start) - Math.abs(b - start) : (b - a) * side,
      place = taken.flatMap(other => [other.x - other.apart, other.x + other.apart]).filter(free).sort(near)[0];
    return place !== undefined && Math.abs(place - start) <= FARTHEST ? place : strict ? null : start;
  }
  // The place a vehicle of the side holds against the others (`clear`): the one the squad sends it to, or where it stands.
  held(id: string) { return this.units.get(id)?.move?.x ?? this.position(id); }
  // How high over the ground a vehicle of the side holds its place (`clear`): an aircraft of the squad on its way at the
  // height it is flown at, and on the ground once sent to land; any other aircraft in the air as high as it is; anything
  // else on the ground.
  heldHeight(id: string) {
    const move = this.units.get(id)?.move, vehicle = this.side.world.actor(id)?.vehicle;
    if (move?.land) return 0;
    if (move?.height != null) return move.height;
    return vehicle?.flying ? vehicle.y - this.side.world.terrain.height(vehicle.x) : 0;
  }
  // Those that hold no place against a vehicle at a vein (`deposit`): those placed with it (`placing`), and the vehicles of
  // the side that stand within its reach, or are sent there, and work it the other way (Side.role). One that only digs and
  // one that carries off what is dug stand side by side across the field, as a lorry is loaded beside an excavator:
  // neither keeps the other out of the material. Two of a kind keep apart all the same.
  beside(id: string, deposit: import('./squad-contract.ts').SquadDeposit, placing: Set<string> = new Set([id])) {
    const field = this.side, there = field.roster.filter(m => m.team !== 'opponent' && !placing.has(m.id) && !field.defeats[m.id] &&
        field.world.actor(m.id)?.vehicle && Math.abs(this.held(m.id) - deposit.x) <= deposit.reach),
      role = there.length ? field.role?.(id, deposit.material) : null, other = role ? WORKS_BESIDE[role] : undefined;
    return other ? new Set([...placing, ...there.filter(m => field.role?.(m.id, deposit.material) === other).map(m => m.id)]) : placing;
  }

  // Everything a hit leaves on a construction of the side, the player's own or an ally's: holes, marks and lost
  // health (`plateWear`, `pieceWear`). Only what grows is a hit: a repair, which mends the construction or puts a new one
  // in its place, is none, and nor is what the ground did to it in a fall.
  // A vehicle that was hit answers (`alertUntil`); one of the side hit within the reach of a vehicle's guns — as far from it
  // as they reach, up and down alike (`apart`) — has it answer too (`answerUntil`). One pass per round of decisions: a host that deals a round over several steps says which round it is.
  sample(round: number = this.side.world.time) {
    const world = this.side.world;
    if (this.sampled === round) return;
    this.sampled = round;
    this.sync();
    for (const [key, contact] of this.contacts) if (world.time - contact.seenAt >= HEARD_AGAIN) this.contacts.delete(key);
    const wear = new Map(this.side.roster.filter(m => m.team !== 'opponent' && !this.side.defeats[m.id]).map(m => [m.id, 0]));
    for (const p of world.plates) if (p.actorId !== undefined && wear.has(p.actorId)) wear.set(p.actorId, wear.get(p.actorId)! + plateWear(p));
    for (const m of world.modules) if (wear.has(m.actorId)) wear.set(m.actorId, wear.get(m.actorId)! + pieceWear(m));
    const hit = [...wear].filter(([id, now]) => now > (this.wear.get(id) ?? Infinity) + 1e-9).map(([id]) => id);
    this.wear = wear;
    for (const [id, unit] of hit.length ? this.units : []) {
      if (hit.includes(id)) unit.alertUntil = world.time + RETURN_FIRE_SECONDS;
      const others = hit.filter(other => other !== id);
      if (others.length && others.some(other => this.apart(id, other) <= this.reach(id))) unit.answerUntil = world.time + RETURN_FIRE_SECONDS;
    }
    // The guns on the ground the base holds closely enough to be answered, as it has them this round: a shell falls on no
    // gun that fired from the air (base-watch.ts `ALOFT`).
    this.placed = this.side.batteries.filter(mark => mark.y === undefined && mark.error <= COUNTER_ERROR);
  }

  // The server may prepare ordinary pilots together. Haul parking and explicit bombardment keep their scalar order.
  prepareDecision(member: Pick<SquadMember, 'id'>, round: number): PreparedDecision | null {
    this.sample(round);
    const unit = this.unit(member.id);
    if (member.id === this.manual) { Object.assign(unit, { activity: 'manual', reason: '', targetId: null, counter: null }); return null; }
    this.crippled(member.id, unit);
    this.homeward(member.id, unit);
    if (unit.attack?.targetId && !this.enemy(unit.attack.targetId)) unit.attack = null;
    const halted = unit.haul ? this.haul(member.id, unit) : '', ordered = Boolean(unit.move && !LOCAL_LEGS.includes(unit.move.purpose ?? '') || unit.attack || unit.haul);
    unit.counter = null;
    if (unit.counters.size && !this.placed!.length) unit.counters.clear();
    const engaged = unit.attack?.point ? null : this.engaged(member.id, unit.attack?.targetId);
    return { unit, halted, ordered, engaged, request: engaged && pilotRequest(member.id, this.side.arenaBounds, engaged.only) };
  }
  decide(member: Pick<SquadMember, 'id'>, round: number, { prepared = this.prepareDecision(member, round), decision }: { prepared?: PreparedDecision | null; decision?: ScriptedDecision } = {}) {
    if (!prepared) return null;
    const { unit, ordered, engaged, request } = prepared, world = this.side.world;
    let { halted } = prepared, action;
    if (unit.attack?.point) action = this.bombard(member, unit);
    else {
      if (!engaged || !request) throw new Error('Decisão automática sem pedido de piloto.');
      action = pilotAction(decision ?? decodeScriptedDecision(world.game().call({ op: 'scriptedDecision', ...request })));
      if (engaged.lost) this.searching(member.id, action);
      // An enemy that comes into the vehicle's senses is worth a warning before the first hit: which sense picked it up
      // (sight, radar or sound) and where, as far as the side may be told: of one it holds in sight or on its radar, the
      // place; of one only heard, or picked up by this vehicle alone, the side of the vehicle it is on.
      const contact = action.contact, sensing = Boolean(contact?.detected && contact.age < 1);
      let encounter;
      if (sensing && contact) {
        // Identity stays on the server, even for sound. Several observers of one
        // enemy share one encounter; changing sensors or a brief gap is no new one.
        const key = action.targetId ? 'enemy:' + action.targetId : 'observer:' + member.id;
        encounter = this.contacts.get(key);
        if (!encounter) {
          encounter = { seenAt: world.time, event: member.id + ':' + world.time };
          const channel = contact.channel || contact.source, placed = channel !== 'sound' && !!action.targetId && this.sighted(action.targetId);
          if (!contact.sharedSound) Object.assign(unit, { heardAt: world.time, heard: { event: encounter.event, ...(placed ? { x: Math.round(contact.x), channel } :
            { side: contact.x < this.position(member.id) ? -1 : 1, channel }) } });
        }
        encounter.seenAt = world.time; this.contacts.set(key, encounter);
      }
      const distance = action.diagnostics!.nearestFreshContactDistance;
      unit.threat = this.endangered(member.id, unit, distance !== null && distance <= HAUL_SCARE);
      // Every threatened worker retreats, even when another observer already
      // announced the encounter. Repeated readings never replace its home leg.
      if (unit.haul && !unit.haul.fled && unit.threat) {
        Object.assign(unit.haul, { fled: true, threat: encounter?.event });
        if (['out', 'load'].includes(unit.haul.phase)) { unit.haul.phase = 'home'; unit.move = null; }
        halted = this.haul(member.id, unit) || 'enemy-near';
      }
      const allowed = Boolean(unit.attack) || unit.stance === 'fire' ||
        unit.stance === 'return' && (unit.alertUntil > world.time || unit.answerUntil > world.time);
      if (!allowed) { action.fire = false; for (const gun of action.also || []) gun.fire = false; }
      // Why a gun that may fire is silent; a gun that may not only says what it sees.
      const reason = action.diagnostics?.reason || '';
      unit.reason = allowed ? reason : reason === 'firing' ? 'holding' : reason === 'search-contact' ? reason : '';
      unit.targetId = action.targetId ?? null;
      unit.activity = action.fire ? 'firing' : unit.attack ? 'attacking' : 'watching';
      // With leave to fire, no order and nothing in its own senses, a vehicle answers the fire its base placed.
      if (allowed && !ordered && !sensing && !action.fire && this.placed!.length) {
        unit.counter = this.counter(member, unit);
        if (unit.counter) action = this.bombard(member, unit, unit.counter, curved);
      }
      // A fresh, placed contact that none of the guns can reach may be on the other side of their elevation
      // sectors. Only artillery turns for it, with leave to fire, and only when the turn gives it an arc.
      if (allowed && (unit.stance !== 'fire' || ordered) && !unit.counter && sensing && contact && contact.confidence >= .32 &&
        !['sound', 'none'].includes(contact.channel || contact.source) && reason === 'no-ballistic-solution')
        this.turnForFire(member, unit, this.firePoint(unit, action), action);
    }
    if (halted) unit.halt = halted;
    if (this.flier(member.id)) this.strike(member, unit, action);
    this.freeFire(member, unit, action);
    if (unit.move) {
      const leg = unit.move;
      if (this.turnsAloft(member.id, unit, action.contact)) this.turnAloft(member.id, action);
      Object.assign(action, this.drive(member.id, unit, action.contact));
      if (!unit.move && ['order', 'home'].includes(leg.purpose ?? '') && unit.stance === 'fire' &&
        Math.abs(this.position(member.id) - leg.x) <= ARRIVAL && Math.abs(requiredActor(world, member.id).vehicle?.vx || 0) < SETTLED)
        unit.fireAt = this.position(member.id);
      if (unit.move) unit.activity = action.fire ? 'moving-firing' : 'moving';
      // A failed trip out tries home once. A blocked return keeps its purpose,
      // without retrying the same obstruction every turn, until helped or reordered.
      else if (isSquadHaulBlock(unit.reason)) {
        unit.halt = unit.reason;
        if (unit.haul) {
          const outbound = ['out', 'load'].includes(unit.haul.phase);
          unit.haul.interrupted ||= unit.reason; unit.haul.phase = 'home';
          if (!outbound || unit.reason === 'immobile') unit.haul.blocked = unit.reason;
          else this.haul(member.id, unit);
        }
      }
      // A leg of a haul that got there goes on at once with what the haul does there: stopped in its base, it may be
      // held for a service before its next turn.
      else if (unit.haul) unit.halt = this.haul(member.id, unit) || unit.halt;
    }
    // A confirmed obstruction stays visible while the guns have nothing else to report.
    if (unit.halt && (!unit.reason || unit.reason === 'search-contact')) unit.reason = unit.halt;
    if (unit.haul && !action.fire) unit.activity = 'hauling';
    return action;
  }
  // The same measured point also serves the existing reversed-weapon solution cache.
  firePoint(unit: SquadUnit, action: SquadAction) {
    const { contact, targetId } = action;
    if (!contact) throw new Error('Ponto de tiro sem contato do piloto.');
    if (!unit.turnAim || unit.turnAim.targetId !== targetId ||
      Math.hypot(contact.x - unit.turnAim.point.x, contact.y - unit.turnAim.point.y) > RELAY)
      unit.turnAim = { targetId, point: { x: contact.x, y: contact.y } };
    return unit.turnAim;
  }
  // Local combat creates ordinary legs, never a second driver or a target-position cache.
  // Explicit orders, automatic work and a Stop retain their own authority.
  freeFire(member: Pick<SquadMember, 'id'>, unit: SquadUnit, action: SquadAction) {
    const id = member.id, ownLeg = () => unit.move?.purpose === 'fire',
      stop = () => { if (ownLeg()) unit.move = null; };
    // An aircraft gets its shot from the air (`strike`).
    if (unit.stance !== 'fire' || unit.attack || unit.haul || unit.move && !ownLeg() || this.flier(id)) { stop(); return; }
    const vehicle = this.side.world.actor(id)?.vehicle;
    if (!vehicle?.config?.enabled) { stop(); return; }
    const region = this.side.freeFireRegion(id, unit.fireAt);
    if (!region || region.anchor === null) { stop(); return; }
    if (!Number.isFinite(region.anchor) || !Number.isFinite(region.radius) || region.radius <= FIRE_INSET)
      throw new Error('Região de fogo livre inválida.');
    const span = this.span(), lo = Math.max(span.lo, region.anchor - region.radius + FIRE_INSET),
      hi = Math.min(span.hi, region.anchor + region.radius - FIRE_INSET), x = this.position(id);
    if (lo > hi || unit.halt) { stop(); return; }
    const go = (goal: number, approach = false) => {
      const target = this.clear(id, clamp(goal, lo, hi), approach ? Math.max(lo, Math.min(x, goal)) : lo,
        approach ? Math.min(hi, Math.max(x, goal)) : hi, new Set([id]), true);
      if (target === null || Math.abs(target - x) <= ARRIVAL) { stop(); return; }
      const leg = unit.move, heading = Math.sign(target - x);
      if (leg && ownLeg() && Math.sign(leg.x - x) === heading) {
        if (leg.x >= lo && leg.x <= hi && Math.abs(leg.x - x) <= Math.abs(target - x) &&
          this.clear(id, leg.x, leg.x, leg.x, new Set([id]), true) !== null) return;
        // A nearer contact changes the destination, not the vehicle's progress.
        // Translate its best remaining distance by the same signed goal shift;
        // only actual travel can renew the ordinary driver's progress clock.
        leg.best = Math.max(0, leg.best + (target - leg.x) * heading);
        leg.x = target;
        return;
      }
      unit.move = { ...this.leg(id, target), purpose: 'fire' };
    }, contact = action.contact,
      fresh = contact?.detected && contact.visible && contact.source !== 'memory' && Number.isFinite(contact.age) && contact.age >= 0 && contact.age < 1 &&
        contact.confidence >= .32 && Number.isFinite(contact.x) && Number.isFinite(contact.y) &&
        ['visual', 'radar'].includes(contact.channel || contact.source) && !!action.targetId && this.enemy(action.targetId),
      local = fresh && Math.abs(contact.x - region.anchor) <= region.radius;
    if (!fresh || Math.abs(x - region.anchor) > region.radius) {
      if (region.home && Math.abs(x - region.anchor) > 8) go(region.anchor);
      else stop();
      return;
    }
    const reason = action.diagnostics!.reason;
    if (unit.counter || !this.armed(member).fed.length || action.diagnostics!.viableShots > 0 ||
      !['terrain-cover', 'no-ballistic-solution'].includes(reason)) { stop(); return; }
    if (reason === 'no-ballistic-solution' && this.turnForFire(member, unit, this.firePoint(unit, action), action, () => true)) return;
    // The movement region is no ballistic arena: turning in place may engage a farther enemy.
    if (!local) {
      if (region.home && Math.abs(x - region.anchor) > 8) go(region.anchor);
      else stop();
      return;
    }
    const heading = Math.sign(contact.x - x), apart = (this.room(id) + Math.max(ROOM, contact.width || 0)) / 2 + GAP,
      advance = Math.min(FIRE_STEP, Math.max(0, Math.abs(contact.x - x) - apart)),
      goal = clamp(x + heading * advance, lo, hi);
    if ((goal - x) * heading <= ARRIVAL) { stop(); return; }
    go(goal, true);
  }
  // An aircraft of the squad goes for its target from the air: the enemy it was sent to attack, the point it was sent to
  // bombard or, free to fire and in the air, the enemy its pilot engages (`strikeTarget`). It flies either way. Where its
  // pilot has a shot (`action.fire`, or a gun that waits on one: `WAITING`) and the guns the target shows do not turn to
  // it (`exposed`), it stays and fires, hovering. Once it has had none such for `STRIKE_PATIENCE`, it stands off the
  // target where its gun has it well within what it turns to, as far off as that gun hits at and its sensors see, outside
  // what the guns the target shows turn to and reach where it can be (`standoff`), and weaves across its line to the
  // target there rather than hang still; its pilot fires on the way as it can. Where it would stand off it nearer by
  // `STRIKE_TURNABOUT` turned about — a target behind it, its gun pointed ahead —, it turns about in the air for that
  // (`turnAloft`), hovering meanwhile, rather than fly on past the target. Free to fire,
  // it stays over the stretch it may go about in for that (`freeFireRegion`). A Move, a landing or a haul comes first; with
  // nothing to go for it hovers where it is. Out of rounds — sent to attack, or once it fired in the air — it goes to land
  // where it is filled up (`land`).
  strike(member: Pick<SquadMember, 'id'>, unit: SquadUnit, action: SquadAction) {
    const id = member.id, world = this.side.world, vehicle = world.actor(id)?.vehicle, now = world.time,
      own = () => unit.move?.purpose === 'strike', drop = () => { if (own()) unit.move = null; unit.weave = null; };
    if (!vehicle?.flying) unit.fought = false;
    else if (action.fire) unit.fought = true;
    if (!vehicle?.config?.enabled || !(vehicle.fuelLitres > 0) || unit.move && !own() || unit.haul) { drop(); return; }
    const { guns, fed } = this.armed(member);
    if (vehicle.flying && guns.length && !fed.length && (unit.attack || unit.fought)) { drop(); unit.fought = false; this.land(id, 'ammo'); return; }
    const family = (gun: LiveWeapon) => (weaponOf(gun.weaponPreset || 'rh120') ?? WEAPON_PRESETS.rh120).family,
      gun = fed.filter(gun => STRIKE_RANGE[family(gun)] && gun.weaponMount).sort((a, b) => (STRIKE_RANGE[family(b)] ?? 0) - (STRIKE_RANGE[family(a)] ?? 0))[0],
      target = gun && this.strikeTarget(id, unit, action);
    if (!target || !gun) { unit.shotAt = null; drop(); return; }
    // A shot it may take where it is, out of the way of the target's guns: it stays, and stays a while after one.
    if ((action.fire || WAITING.includes(unit.reason)) && !this.exposed(target, gun)) unit.shotAt = now;
    if (now - (unit.shotAt ?? -Infinity) <= STRIKE_PATIENCE) { drop(); return; }
    const place = this.standoff(id, gun, target);
    if (vehicle.flying && this.strikesTurned(id, gun, target, place) && this.turnAloft(id, action)) { drop(); return; }
    if (!place) { drop(); return; }
    // The two ends of its weave, either way across its line to the target from the place; at one, it makes for the other.
    const weave = unit.weave ||= { way: 1 }, ground = world.terrain.height(vehicle.x), across = { x: -Math.sin(place.bearing), y: Math.cos(place.bearing) },
      end = (way: number) => ({ x: clamp(place.x + across.x * STRIKE_WEAVE * way, place.lo, place.hi),
        height: Math.min(place.top, Math.max(STRIKE_FLOOR, place.height + across.y * STRIKE_WEAVE * way)) });
    let point = end(weave.way), turned = false;
    if (Math.hypot(point.x - vehicle.x, point.height - (vehicle.y - ground)) <= STRIKE_TURN) { weave.way = -weave.way; point = end(weave.way); turned = true; }
    // It climbs or comes down to it a little at a time: asked for all of a climb at once, a flight computer spends all its
    // thrusters on it and drifts along the field meanwhile.
    const up = vehicle.y - ground, height = clamp(point.height, up - STRIKE_CLIMB, up + STRIKE_CLIMB);
    if (!own()) unit.move = { ...this.leg(id, point.x), purpose: 'strike', height };
    else Object.assign(requiredMove(unit), { x: point.x, height }, turned ? { best: Math.abs(point.x - vehicle.x), since: now } : {});
  }
  // What an aircraft goes for from the air (`strike`), with the guns it shows when the side has it in sight (`shown`): the
  // point it was sent to bombard; the enemy it was sent to attack, where its own sensors have it, or else where its side
  // holds it (Side.whereabouts); free to fire and in the air, the enemy its pilot engages as long as its own sensors see it or
  // hold it on their radar and it stands within the stretch of the field it may go about in for that, as a vehicle on the
  // ground goes for one (`freeFire`), with that stretch (`region`) and how high it may climb over it (`top`): no higher than
  // `FREE_FIRE_CLIMB` over where it was as it first looked for a shot after it was given leave (`fireHeight`). Nothing else.
  strikeTarget(id: string, unit: SquadUnit, action: SquadAction): StrikeTarget | null {
    const attack = unit.attack, contact = action.contact, sensed = Boolean(contact?.detected && contact.visible && contact.age < 1 &&
      ['visual', 'radar'].includes(contact.channel || contact.source) && Number.isFinite(contact.x) && Number.isFinite(contact.y));
    if (attack?.point) return { x: attack.point.x, y: attack.point.y, guns: [] };
    if (attack?.targetId) {
      const held = sensed && action.targetId === attack.targetId ? contact : this.side.whereabouts?.(attack.targetId);
      return held ? { x: held.x, y: held.y, guns: this.shown(attack.targetId) } : null;
    }
    const region = unit.stance === 'fire' && this.side.freeFireRegion(id, unit.fireAt), vehicle = requiredVehicle(this.side.world, id);
    if (!region || region.anchor === null || !vehicle.flying) return null;
    const fireHeight = unit.fireHeight?.anchor === region.anchor ? unit.fireHeight : (unit.fireHeight = { anchor: region.anchor, y: vehicle.y });
    if (!sensed || !contact || !action.targetId || !this.enemy(action.targetId) || Math.abs(contact.x - region.anchor) > region.radius) return null;
    return { x: contact.x, y: contact.y, guns: this.shown(action.targetId), region: { ...region, anchor: region.anchor, top: fireHeight.y + FREE_FIRE_CLIMB } };
  }
  // The guns an enemy the side has in sight shows (Side.whereabouts): where each stands, what it turns to about the axis it
  // stands on and how far it reaches (`gunReach`). Of one out of sight, none are known.
  shown(targetId: string) {
    const world = this.side.world;
    if (!this.side.whereabouts?.(targetId)?.seen) return [];
    return world.modules.filter(usableGun).filter(m => m.actorId === targetId && m.weaponMount).map(m => ({ x: m.x, y: m.y, axis: m.angle,
      min: m.weaponMount.min, max: m.weaponMount.max, reach: gunReach(world, targetId, [m]) }));
  }
  // Whether an aircraft in the air that goes for a target (`strike`) would stand off it nearer by `STRIKE_TURNABOUT` turned
  // about (turn-about.ts `aloftPose`) than where it stands off it as it faces (`place`, none where it has none): how far
  // each is from where its hull would be.
  strikesTurned(id: string, gun: LiveWeapon, target: StrikeTarget, place: StrikePlace | null) {
    const world = this.side.world, actor = requiredActor(world, id), vehicle = requiredVehicle(world, id), ground = (x: number) => world.terrain.height(x),
      pose = aloftPose(actor), turned = this.standoff(id, turnedLauncher(actor, gun, pose.along), target, pose),
      off = (spot: StrikePlace | null, from: Point) => spot ? Math.hypot(spot.x - from.x, spot.height + ground(spot.x) - from.y) : Infinity;
    return Boolean(turned) && off(turned, pose) + STRIKE_TURNABOUT < off(place, vehicle);
  }
  // An aircraft its pilot turns about in the air (Side.turnAbout) flies on meanwhile as this decision has it fly, its guns
  // silent from this decision on until it faces the other way (SharedRoom.turn).
  turnAloft(id: string, action: SquadAction) {
    if (!this.side.turnAbout?.(id)) return false;
    Object.assign(action, { fire: false, cancel: true });
    delete action.also;
    return true;
  }
  // Where an aircraft stands off a target with a gun (`strike`): of `STRIKE_BEARINGS` lines from the gun to the target,
  // `STRIKE_SECTOR` inside the edges of what it turns to as the aircraft hovers level — its axis as the hull holds it now,
  // less how far the hull leans —, as far along each as the gun hits at (`STRIKE_RANGE`) and the aircraft's sensors see
  // (`STRIKE_SIGHT`), the place for the aircraft at the far end — or where the line crosses the edge of the field or of
  // the stretch it is kept over, no farther than `STRIKE_FARTHEST` times that, or comes up to the height it climbs to at the
  // most there (`top`) —, at least `STRIKE_FLOOR` over the ground there, from which the line runs clear of the ground the
  // side knows. Of those, one outside what each gun the target shows turns to, by `STRIKE_CLEAR` at least, or out of its
  // reach; then the one nearest the middle of its own gun's turn and the range. Nothing when none will do. With the place,
  // the line it lies on (`bearing`), the stretch it is kept over (`lo`, `hi`) and how high over the ground there it may climb
  // (`top`). Of the hull as it is, or as `vehicle` has it — where its origin is and how it leans.
  standoff(id: string, gun: StrikeLauncher, target: StrikeTarget, vehicle: Pick<Vehicle, 'x' | 'y' | 'angle'> = requiredVehicle(this.side.world, id)): StrikePlace | null {
    const side = this.side, world = side.world, ground = (x: number) => world.terrain.height(x),
      known = (x: number) => !side.knowsGround || side.knowsGround(x),
      sensors = world.modules.filter((m): m is Extract<LiveModule, { kind: 'sensor' }> => m.actorId === id && m.kind === 'sensor' && m.health > 0 && m.attached !== false && m.sensorMode !== 'sound'),
      sight = Math.max(COMMAND_CAMERA_RANGE, ...sensors.map(m => (SENSOR_MODES[m.sensorMode ?? 'visual'] || SENSOR_MODES.visual).range)),
      range = Math.min(STRIKE_RANGE[(weaponOf(gun.weaponPreset || 'rh120') ?? WEAPON_PRESETS.rh120).family] ?? 0, STRIKE_SIGHT * sight),
      axis = gun.angle - (vehicle.angle || 0), mount = gun.weaponMount!, middle = axis + (mount.min + mount.max) / 2,
      first = axis + mount.min + STRIKE_SECTOR, last = axis + mount.max - STRIKE_SECTOR, offset = { x: gun.x - vehicle.x, y: gun.y - vehicle.y },
      span = this.span(), region = target.region,
      lo = Math.max(span.lo, region ? region.anchor - region.radius : -Infinity), hi = Math.min(span.hi, region ? region.anchor + region.radius : Infinity),
      top = region?.top ?? Infinity,
      // Whether a line from the gun to the target runs over the ground the side knows under it, short of the target.
      clear = (from: Point) => {
        const length = Math.hypot(target.x - from.x, target.y - from.y), count = Math.min(80, Math.ceil(Math.abs(target.x - from.x) / STRIKE_LOOK));
        for (let i = 1; i < count; i++) {
          const t = i / count, x = from.x + (target.x - from.x) * t;
          if ((1 - t) * length > STRIKE_LOOK && known(x) && from.y + (target.y - from.y) * t <= ground(x) + 1) return false;
        }
        return true;
      },
      exposed = (place: Point) => this.exposed(target, place);
    let best: StrikePlace | null = null;
    for (let i = 0; i < STRIKE_BEARINGS; i++) {
      // Along a line whose far end lies off the stretch it is kept over, it stands at the edge of that stretch, nearer or
      // farther off — as far as twice the range at the most —, a place worth less the farther it is.
      const bearing = first > last ? middle : first + (last - first) * i / (STRIKE_BEARINGS - 1), cos = Math.cos(bearing), sin = Math.sin(bearing),
        far = target.x - cos * range - offset.x, edge = clamp(far, lo, hi),
        along = Math.min(edge === far ? range : Math.abs(cos) > 1e-6 ? (target.x - offset.x - edge) / cos : -1,
          sin < -1e-6 ? (top + offset.y - target.y) / -sin : Infinity),
        muzzle = { x: target.x - cos * along, y: target.y - sin * along },
        x = muzzle.x - offset.x, height = muzzle.y - offset.y - ground(x);
      if (along > 0 && along <= range * STRIKE_FARTHEST && height >= STRIKE_FLOOR && clear(muzzle)) {
        const score = (exposed(muzzle) ? Math.PI * 2 : 0) + Math.abs(bearing - middle) + Math.abs(along - range) / range;
        if (!best || score < best.score) best = { x, height, bearing, score, lo, hi, top: top - ground(x) };
      }
      if (first > last) break;
    }
    return best;
  }
  // Whether one of the guns the target shows (`target.guns`) reaches a place and turns to it, counting `STRIKE_CLEAR`
  // radians past the edges of what it turns to as within them.
  exposed(target: StrikeTarget, place: Point) {
    const turn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
    return target.guns.some(g => { const bearing = turn(Math.atan2(place.y - g.y, place.x - g.x) - g.axis);
      return Math.hypot(place.x - g.x, place.y - g.y) <= g.reach && bearing >= g.min - STRIKE_CLEAR && bearing <= g.max + STRIKE_CLEAR; });
  }
  // One contextual collection order: a tool without cargo stays at the vein and
  // extracts into its pile. A container takes that pile home, unloads, and repeats;
  // one with both pieces extracts and carries its own output.
  // A vein is emptied — less than a step (`RESERVE_STEP`) left in it —, and the faction knows it when it sees the site so: the hauler
  // itself as it works there, or anybody else of the faction; or when one of its own digs it, with an eye or none.
  // It comes back by itself, a little at a time, and what the faction last knew of it may be old: a hauler sent there goes to
  // see, and judges it where it works it (`empty`). The haul is of that one vein, the one the player chose: no
  // other is taken in its place, which may lie where the player would not send a hauler. A hauler that finds it empty
  // waits for it no longer and says why: it goes home, with what it carries, and the haul ends there once it is unloaded.
  // A tool without cargo ends its haul where it stands. A place that is gone — a cargo dropped on the field and taken —
  // is made for no longer, wherever the hauler was in its trip.
  // So does a hauler an enemy endangers (`endangered`), wherever it was in its trip: it has no vein to go
  // to any more, and stays at home until it is sent again. An order to move is the player's to give: that one is obeyed.
  // One that tipped part of its load out on the way is sent home with the rest (`lightened`).
  // Returns why the haul ended, when it did for want of a piece to carry in, of its vein or what it held, or of a vein no base stills, or for an enemy.
  haul(id: string, unit: SquadUnit) {
    const field = this.side;
    if (!field.depot || !field.load) throw new Error('Coleta sem logística da facção.');
    const base = field.depot(id);
    if (!base) throw new Error('Coleta sem base de entrega.');
    const haul = requiredHaul(unit), x = this.position(id), load = field.load(id),
      vehicle = requiredVehicle(field.world, id), air = aircraft(field.world.actor(id)),
      end = (reason: string) => { if (reason === 'enemy-near') unit.haltEvent = haul.threat; unit.haul = unit.move = null; return reason; },
      full = load.full === true || load.room > 0 && load.carried >= load.room - .5,
      // An aircraft flies to the place it works at and comes down there (`land: 'work'`), or home for its fuel (`'fuel'`) or
      // to be mended (`'mend'`); on its skids within what it comes down off a place by (`ARRIVAL`), it stays. By its vein it
      // takes off to come down again once, and no more (`hopped`): standing there it says what its tool does not reach. It
      // does not take off where it may not (`grounded`), and says why while it stays — nor where it tried to as heavy as it
      // is, and came down again where it was (`takeoff`): its thrusters do not hold its load up level, even all of them
      // lifting more than it weighs. Any place of the stretch it works from will do (`within`, `touchdown`).
      alight = (target: number, near: boolean, why: SquadLandingReason = 'work', within: SquadSpan | null = null) => {
        if (!vehicle.flying && Math.abs(target - x) <= ARRIVAL) return null;
        if (!vehicle.flying) {
          if (near && unit.hopped) return null;
          const tried = unit.takeoff, failed = tried && Math.abs(tried.x - x) <= ARRIVAL && Math.abs(vehicle.mass - tried.mass) < tried.mass * LIGHTER,
            stays = failed ? 'too-heavy' : this.grounded(id, base);
          if (stays) { unit.halt = stays; return null; }
          unit.takeoff = { x, mass: vehicle.mass };
        }
        if (!near) delete unit.hopped; else if (!vehicle.flying) unit.hopped = true;
        return { ...this.leg(id, target), land: why, ...(within ? { within } : {}) };
      },
      // Park so the arm reaches the actual deposit. If all loading places are
      // taken, wait just outside the area and try again when another hauler leaves.
      // An aircraft comes down no nearer the ends of its stretch than it comes down off the place it is sent to, and in the
      // middle of one narrower than that, on ground it may come down on (`landing`): with none there, it does not go.
      out = (deposit: SquadDeposit) => {
        if (!deposit.area) throw new Error('Coleta sem área de trabalho.');
        const { lo, hi, goal, digs } = deposit.area, inset = air ? ARRIVAL : LOADING_APPROACH, middle = (lo + hi) / 2,
          from = air ? Math.min(lo + inset, middle) : lo + inset, to = air ? Math.max(hi - inset, middle) : hi - inset,
          // Fill the far end first, leaving the near bay for the next transporter.
          wanted = digs ? goal : x < goal ? hi - inset : lo + inset, beside = this.beside(id, deposit),
          place = air ? this.landing(id, clamp(wanted, from, to), beside, { lo: from, hi: to, strict: true }) : this.clear(id, wanted, from, to, beside, true);
        if (air && place === null && !this.level(id, from, to)) return NO_LANDING;
        if (place === null) haul.waiting = true; else delete haul.waiting;
        let target = place;
        if (target === null) {
          const side = Math.sign(x - goal) || -1, span = this.span(), aside = side < 0 ? lo - this.room(id) - GAP : hi + this.room(id) + GAP;
          target = air ? this.landing(id, aside, new Set([id])) : this.clear(id, aside, span.lo, span.hi);
        }
        if (air) return alight(target, Math.abs(x - deposit.x) <= deposit.reach, 'work', place === null ? null : { lo: from, hi: to });
        return Math.abs(target - x) > LOADING_APPROACH ? this.leg(id, target) : null;
      },
      go = (deposit: SquadDeposit) => { const leg = out(deposit); if (leg === NO_LANDING) return end(NO_LANDING); unit.move = leg; return ''; };
    if (haul.blocked) return haul.blocked;
    if (air && GROUNDED.includes(unit.halt)) unit.halt = '';
    // One that got away from where it took off took off (`takeoff`).
    if (unit.takeoff && Math.abs(x - unit.takeoff.x) > 2 * ARRIVAL) delete unit.takeoff;
    // An aircraft on its skids at home with its tanks full leaves full (`full`), till it comes down away from home.
    if (air && !vehicle.flying) {
      if (Math.abs(base.x - x) > base.radius) delete haul.full;
      else if (this.topped(id)) haul.full = true;
    }
    if (!load.room && !load.extracts && !haul.fled && !haul.interrupted) return end('no-room');
    const interrupted = haul.fled ? 'enemy-near' : haul.interrupted === 'no-loader' ? 'no-loader' : haul.interrupted ? 'haul-interrupted' : null,
      deposit = interrupted ? null : field.deposit(haul.depositId, id), dug = deposit && !deposit.stilled,
      spent = haul.refined ? 'supplies-spent' : 'vein-spent:' + haul.material, empty = 'vein-empty:' + haul.material,
      lack = interrupted || (deposit ? 'no-deposit' : spent);
    if (!interrupted && !load.room && (!dug || haul.phase === 'load' && !((deposit.left ?? NaN) >= RESERVE_STEP))) return end(dug ? empty : lack);
    // Working there, it finds the vein empty and nothing in its pile: it goes home, and stops there (`empty`). A
    // trip of the dispatch for a ready pile (`once`) ends at home whatever it found.
    if (dug && !haul.once && haul.phase === 'load' && !((deposit.left ?? NaN) >= RESERVE_STEP) && !(deposit.stock > 1e-6)) haul.empty = true;
    // A new collection order may be given with a full container already aboard.
    // Deliver it first, even when a functioning tool could still work the vein.
    if (full && ['out', 'load'].includes(haul.phase)) { haul.phase = 'home'; unit.move = null; }
    // An unavailable work area prevents collecting, not delivering cargo that
    // is already aboard. A return leg and unloading need only the base.
    if (dug && !deposit.area && ['out', 'load'].includes(haul.phase)) {
      if (!(load.carried > 0)) return end('no-loader');
      haul.phase = 'home'; unit.move = null;
    }
    if (!deposit) { unit.halt = lack; if (haul.phase === 'out') unit.move = null; }
    else if (haul.empty) unit.halt = empty;
    if (haul.phase === 'out' && !unit.move) {
      if (!dug) { if (load.carried > 0 || !deposit) haul.phase = 'home'; else return end(lack); }
      else if (deposit.area!.ready) { haul.phase = 'load'; delete haul.waiting; }
      else if (go(deposit)) return NO_LANDING;
    }
    // Pickup already tried this real site. Deliver a partial load once its ready pile is out and the load has not grown
    // for `PATIENCE` (`gained`: what it carried when it last grew there, and when; the squad's own, which neither its
    // screen nor a save is told); an empty transporter waits for actual production. A tool that digs beside a hauler
    // fills it by the bucket and keeps the pile empty: a pause of its digger — short of fuel, refuelled, parked anew —
    // ends none of that, and the hauler takes no sliver home for it.
    if (haul.phase !== 'load') delete unit.gained;
    else if (!unit.gained || load.carried > unit.gained.carried) unit.gained = { carried: load.carried, at: field.world.time };
    if (haul.phase === 'load') {
      if (!dug || haul.empty || load.carried > 0 && load.waiting && field.world.time - unit.gained!.at >= PATIENCE || haul.once && !(deposit.stock > 1e-6))
        haul.phase = 'home';
      else if (!deposit.area!.ready) haul.phase = 'out';
    }
    // A free parking place can still leave a workshop-mounted tool short of the
    // ground. Let the suspension settle, but never keep an idle outbound order
    // there forever. Waiting for an occupied bay or driving toward it is different.
    if (haul.phase !== 'out' || unit.move || haul.waiting || Math.hypot(vehicle?.vx || 0, vehicle?.vy || 0) >= SETTLED)
      delete haul.parkedAt;
    else {
      haul.parkedAt ??= field.world.time;
      if (field.world.time - haul.parkedAt > PATIENCE) {
        if (!(load.carried > 0)) return end('no-loader');
        haul.interrupted = 'no-loader'; haul.phase = 'home'; delete haul.parkedAt;
        unit.halt = 'no-loader';
      }
    }
    // Home, an aircraft comes down in its base, or its post: it unloads only on its skids there.
    if (haul.phase === 'home' && !unit.move) {
      const there = Math.abs(base.x - x) <= base.radius, inside = { lo: base.x - base.radius + EDGE, hi: base.x + base.radius - EDGE },
        stop = there ? x : base.x + Math.sign(x - base.x) * (base.radius - DEPOT_INSET);
      if (there && !vehicle?.flying) haul.phase = 'unload';
      else if (air) unit.move = alight(this.landing(id, stop, new Set([id]), inside), false, haul.mend ? 'mend' : haul.fuel ? 'fuel' : 'work', inside);
      else unit.move = this.leg(id, this.clear(id, stop, inside.lo, inside.hi));
    }
    if (haul.phase === 'unload' && load.carried <= 0) {
      // An aircraft goes on once its tanks are filled up there, while its faction has fuel to fill them with (Side
      // `fuelled`) — or whatever, home for its fuel —, but where they full did not take it to its vein (`far`). Home to be
      // mended (`mend`), it goes on once its thrusters hold it up again as its pilot flies it (`steady`).
      if (haul.far) return end(OUT_OF_RANGE);
      if (haul.mend) { if (!steady(field.world, id)) return ''; delete haul.mend; }
      if (air && !this.topped(id) && (haul.fuel || field.fuelled)) return '';
      delete haul.fuel;
      if (haul.once) return end(''); // The dispatcher gives the next ready pickup; manual rounds keep repeating.
      if (!dug) return end(lack);
      if (haul.empty) return end(empty);
      if (!deposit.area) return end('no-loader');
      haul.phase = 'out';
      if (go(deposit)) return NO_LANDING;
    }
    return '';
  }
  // A hauler that tipped part of its load out to weigh less takes what it has left home: it neither stays at its
  // vein nor turns back to it to fill up again, with room to spare though it has. From home its haul goes on as ever.
  // Lighter, it may get where the ground held it: a drive it was on is given its time over again, and an order
  // that ended because it was stuck says so no longer. Returns whether that changed where it was going.
  lightened(id: string) {
    const unit = this.units.get(id), turned = !!unit?.haul && ['out', 'load'].includes(unit.haul.phase);
    if (unit?.haul?.blocked?.startsWith('stuck-')) delete unit.haul.blocked;
    if (turned && unit?.haul) { unit.haul.phase = 'home'; unit.move = null; }
    else if (unit?.move) unit.move.since = this.side.world.time;
    if (unit?.halt.startsWith('stuck-')) { unit.halt = unit.reason = ''; unit.haltEvent = null; }
    return turned;
  }
  // The one construction a pilot ordered onto an enemy looks at, as the core takes it (`only`). An enemy that left the
  // field while the side held it is looked for all the same, and found nowhere, as one out of the pilot's senses: the
  // core is given a vehicle of the side to look for instead, which it never takes for an enemy. With no other vehicle of
  // the side on the field the pilot decides on its own, and is kept from what it found (`lost`, `searching`).
  engaged(id: string, targetId: string | undefined): Engagement {
    const side = this.side;
    if (!targetId || side.world.actor(targetId)) return { only: targetId };
    const friend = side.roster.find(m => m.team !== 'opponent' && m.id !== id && side.world.actor(m.id));
    return friend ? { only: friend.id } : { only: undefined, lost: true };
  }
  // A pilot that looks for an enemy it will not find: it holds its fire and its gun where it lies, and has nobody in its sights.
  searching(id: string, action: SquadAction) {
    const aim = this.side.world.actor(id)?.aim;
    Object.assign(action, { fire: false, targetId: null, contact: null }, aim && Number.isFinite(aim.x) && Number.isFinite(aim.y) ? { aim: { x: aim.x, y: aim.y } } : {});
    delete action.also;
    if (action.diagnostics) action.diagnostics = { ...action.diagnostics, reason: 'search-contact' };
  }

  // A construction made anew has no old wear to compare, and a repair may have
  // freed a blocked return. Take up its order as when another service ends.
  renewed(id: string) {
    this.wear.delete(id);
    const unit = this.units.get(id); unit?.laid?.clear();
    if (unit?.stance === 'fire' && (['blocked-way', 'immobile'].includes(unit.halt) || unit.halt?.startsWith('stuck-'))) unit.halt = '';
    this.resume(id);
  }
  // How far a vehicle answers for its side: as far as the farthest of its guns with rounds reaches (`gunReach`).
  reach(id: string) { return gunReach(this.side.world, id, this.armed({ id }).fed); }
  // Whether an enemy endangers a vehicle's automatic work now, by what its side holds of the enemies (`Side.threats`),
  // while its own senses and its side's have a fresh contact within `HAUL_SCARE` of it (`sensed`): one in sight with a gun
  // that works and reaches it (`gunReach`), no farther than that; or one held only as a mark, a blip of the radar or what
  // an ear heard, which may be anything (`reach` null), within `MARK_SCARE`. Each as far off as the straight line between
  // them, along the field and up alike: an aircraft high over a worker endangers it only as its guns reach so far. One in
  // sight with no gun, or one only remembered, holds nothing. Enemies that only show themselves hold a vehicle `SCARE_HOLD` seconds at the most in any
  // `SCARE_WINDOW` (`scare`): the window opens with the first reading that holds it, each reading after that spends the
  // time since the one before — a second at the most —, and once that is spent only fire holds it — its own hits and
  // shots, or a hit on its side within its reach (SupplyDispatch.safe) — until the window closes.
  endangered(id: string, unit: SquadUnit, sensed: boolean) {
    const time = this.side.world.time, at = this.place(id), since = unit.scare?.looked ?? time,
      held = sensed && (this.side.threats?.() ?? []).some(foe =>
        Math.hypot(foe.x - at.x, foe.y - at.y) <= (foe.reach === null ? MARK_SCARE : foe.reach > 0 ? Math.min(HAUL_SCARE, foe.reach) : -1));
    if (unit.scare) unit.scare.looked = time;
    if (!held) return false;
    if (!unit.scare || time - unit.scare.from >= SCARE_WINDOW) { unit.scare = { from: time, spent: 0, looked: time }; return true; }
    unit.scare.spent += Math.min(1, time - since);
    return unit.scare.spent < SCARE_HOLD;
  }
  // The guns of a vehicle that still work and have rounds to fire.
  armed(member: Pick<SquadMember, 'id'>, fits: (gun: LiveWeapon) => boolean = () => true) {
    const modules = this.side.world.modules.filter(m => m.actorId === member.id), guns = modules.filter(usableGun).filter(fits);
    return { guns, fed: guns.filter(gun => ammunitionSupply(modules, gun.weaponPreset || 'rh120').some(m => (m.rounds ?? 0) > 0)) };
  }
  // The fire a vehicle answers on its own: of the guns its base holds closely (`placed`), the nearest that one of its
  // curved-fire guns, with rounds, may fire at (`aimAt`). What it is laid on is the place as the base had it then: that
  // stands while the mark is held within half of what it may be off by, so that an arc is not worked out again at every
  // word of the gun, and is dropped with the mark.
  counter(member: Pick<SquadMember, 'id'>, unit: SquadUnit) {
    const { fed } = this.armed(member, curved), held = unit.counters, x = this.position(member.id), ground = this.side.world.terrain, refused: string[] = [];
    for (const id of [...held.keys()]) if (!this.placed!.some(mark => mark.id === id)) held.delete(id);
    if (!fed.length) return null;
    let about: SquadCounter | null = null;
    for (const mark of this.placed!.slice().sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))) {
      let order = held.get(mark.id);
      if (!order || Math.abs(order.point.x - mark.x) > mark.error / 2) held.set(mark.id, order = { id: mark.id, point: { x: mark.x, y: ground.height(mark.x) + 1 } });
      if (fed.some(gun => this.aimAt(member, unit, gun, order, refused))) return order;
      if (!about && this.canTurnForFire(member, unit, order)) about = order;
    }
    if (about) return about;
    if (refused.length) unit.reason = refused[0]!;
    return null;
  }

  // Fire at a place on the map, whatever is or is not seen there, with every gun that has rounds and may fire there
  // (`aimAt`). One that has rounds and no such arc holds its fire and says the place is out of its reach, and one kept
  // from it otherwise says what keeps it.
  // The place is that of the order to bombard, or the one the vehicle answers on its own (`order`), with the guns that fit (`fits`).
  bombard(member: Pick<SquadMember, 'id'>, unit: SquadUnit, order: SquadPointOrder = pointOrder(unit.attack), fits: (gun: LiveWeapon) => boolean = () => true): SquadAction {
    const { guns, fed } = this.armed(member, fits), held: string[] = [],
      [gun, ...others] = fed.map(gun => this.aimAt(member, unit, gun, order, held)).filter((way): way is SquadGunWay => !!way);
    Object.assign(unit, { targetId: null, activity: gun ? 'firing' : 'attacking',
      reason: gun ? 'bombarding' : held[0] || (fed.length ? 'point-out-of-reach' : 'no-armed-feed') });
    const action: SquadAction = { type: 'controls', throttle: 0, brake: 1, fire: Boolean(gun), aim: { ...order.point } };
    if (gun) Object.assign(action, gun, others.length ? { also: others } : {});
    // What cannot reach the place is still turned towards it, by its own arc and its whole charge: the core lays a gun
    // again at every step, and looking for a charge among them all where none will do is what that costs most.
    else Object.assign(action, { componentId: (fed[0] || guns[0])?.id ?? 'none' }, fed[0] ? { trajectory: arcs(fed[0].weaponPreset || 'rh120')[0] } : {});
    if (!gun) this.turnForFire(member, unit, order, action);
    return action;
  }
  // Keep movement and the player's hands first. A mortar that can already cover both sides has no reason to
  // turn; neither does a gun held by an ally, a reload, terrain cover or a place no orientation can reach.
  canTurnForFire(member: Pick<SquadMember, 'id'>, unit: SquadUnit, order: SquadPointOrder, fits: (gun: LiveWeapon) => boolean = curved) {
    if (!this.side.turnAbout || unit.move && unit.move.purpose !== 'fire' || unit.haul || !this.side.world.actor(member.id)?.vehicle?.config.enabled) return false;
    const { fed } = this.armed(member, fits);
    if (!fed.length || fed.some(gun => this.lay(unit, gun, order))) return false;
    return fed.some(gun => !this.harms(member.id, gun, order.point) && this.lay(unit, gun, order, true));
  }
  // Stop first, then use the ordinary timed field manoeuvre. The field holds it, cancels the trigger and keeps
  // its orders and wear; after turning, the real gun and line of fire are checked again before it shoots.
  turnForFire(member: Pick<SquadMember, 'id'>, unit: SquadUnit, order: SquadPointOrder, action: SquadAction, fits: (gun: LiveWeapon) => boolean = curved) {
    if (!this.canTurnForFire(member, unit, order, fits)) return false;
    const vehicle = requiredVehicle(this.side.world, member.id);
    if (Math.abs(vehicle.vx || 0) <= SETTLED && !this.side.turnAbout?.(member.id)) return false;
    if (unit.move?.purpose === 'fire') unit.move = null;
    Object.assign(action, { throttle: 0, brake: 1, fire: false, componentId: 'none', cancel: true });
    delete action.also;
    Object.assign(unit, { activity: 'attacking', reason: 'turn-to-fire' });
    return true;
  }
  // How a gun is laid on a place to bombard, if it may fire there (`lay`): not where its shell would burst near enough
  // to harm the vehicle, nor where its round would meet the vehicle itself on its way, or an ally that would stop it and
  // take no harm of it (the core's `lineOfFire`). What keeps it from firing there is told to `held`.
  aimAt(member: Pick<SquadMember, 'id'>, unit: SquadUnit, gun: LiveWeapon, order: SquadPointOrder, held: string[] = []) {
    if (this.harms(member.id, gun, order.point)) return void held.push('point-too-close');
    const way = this.lay(unit, gun, order),
      line = way && decodeLineOfFire(this.side.world.game().call({ op: 'lineOfFire', actorId: member.id, aim: order.point, ...way }));
    if (line) return void held.push(line + '-in-line');
    return way;
  }
  // Whether a round of `gun` that bursts at `point` would reach vehicle `id` with its blast or its fragments: they would
  // harm it as anyone (`blastReach`), as far as the straight line from the burst to it — an aircraft high enough over the
  // point is out of their way. One that strikes by its own motion bursts nowhere.
  harms(id: string, gun: LiveWeapon, point: Point) {
    const preset = gun.weaponPreset || 'rh120', settings = weaponSettings(weaponOf(preset)?.family, { preset, ammo: fedAmmo(gun) }), at = this.place(id);
    return !KINETIC_AMMO.includes(settings.ammo) && Math.hypot(point.x - at.x, point.y - at.y) - this.room(id) / 2 < blastReach(settings.blastRadius, settings.fragmentReach);
  }
  // How a gun is laid on the place it was told to bombard: by an arc that falls on it, not by the line of sight —
  // a round aimed straight at a far place falls short of it —, its own arc before the other, and by the charge that
  // arc takes. A gun has only the arcs its mount lets it rise or sink to: a howitzer that stands upright on its
  // roof reaches a place with the high one alone. Nothing when no arc of the gun falls on the place. It is worked
  // out when the order is given and again when the gun has moved, not at every decision: what was worked out is
  // kept by the order it was for — the order to bombard, or one the vehicle answers on its own — and goes with it.
  lay(unit: SquadUnit, gun: LiveWeapon, order: SquadPointOrder, turned = false) {
    const preset = gun.weaponPreset || 'rh120', family = weaponOf(preset)?.family, point = order.point, laid = unit.laid ||= new Map();
    if (!laid.has(order)) for (const old of laid.keys()) if (old !== unit.attack && old !== unit.turnAim && (old.id !== undefined ? unit.counters.get(old.id) : undefined) !== old) laid.delete(old);
    const guns = laid.get(order) || new Map<string, SquadLaidGun>(), solve = (launcher: BallisticLauncher): SquadGunWay | null => {
      for (const trajectory of arcs(preset)) {
        const solved = firingSolution(launcher, point, weaponSettings(family, { preset, trajectory, charge: 'auto' }));
        if (solved.reachable) return { componentId: gun.id, trajectory, ...(propellantCharges(preset).length > 1 ? { charge: solved.charge } : {}) };
      }
      return null;
    };
    laid.set(order, guns);
    let kept = guns.get(gun.id);
    if (!kept || Math.hypot(gun.x - kept.x, gun.y - kept.y) > RELAY || Math.abs(gun.angle - kept.angle) > .01)
      guns.set(gun.id, kept = { x: gun.x, y: gun.y, angle: gun.angle, way: solve(gun) });
    if (turned && !Object.hasOwn(kept, 'turned')) kept.turned = solve(turnedLauncher(requiredActor(this.side.world, gun.actorId), gun));
    return turned ? kept.turned : kept.way;
  }

  // Throttle towards the ordered place, no faster than it can still stop there on its brakes — which the weight of the
  // vehicle works against down a slope; up one it is not counted on, for the ground ahead may fall away past a crest —,
  // braked no harder than tips it onto its front (`tipping`), and the harder up a slope; pushed no harder than its ground
  // holds (`drivetrain`), and flat out where something in its way holds it all the same (`leaning`). The order ends with
  // the vehicle stopped at the place, or where the way is shut: one that got there still rolling is stopped there first.
  // A long way to go behind it, it turns about first (`turnsAbout`). A way gone at a pace of its own (`pace`, the road a
  // machine makes as it goes, supply-dispatch.ts) is gone at that pace (`paced`), slowing to a stop where it ends
  // (`PACE_STOP`); at none it is stopped where it is (`halt`), and how long it takes to get nearer counts from when it goes
  // again. It ends when its machine is done with it, not where it gets to: there the vehicle is held on its brakes while its
  // tools finish what they reach.
  drive(id: string, unit: SquadUnit, contact: PilotContact | null | undefined = null) {
    this.touchdown(id, unit);
    const world = this.side.world, vehicle = requiredActor(world, id).vehicle, x = this.position(id), leg = requiredMove(unit), dx = leg.x - x,
      distance = Math.abs(dx), heading = Math.sign(dx), speed = (vehicle?.vx || 0) * heading, climb = Math.sin(vehicle?.groundSlope || 0) * heading,
      arrival = unit.haul?.phase === 'out' || leg.arrival === LOADING_APPROACH ? LOADING_APPROACH : ARRIVAL, pacing = leg.pace !== undefined,
      towing = world.tows?.find(tow => tow.actorId === id && !tow.sling);
    if (vehicle?.config.enabled && (vehicle.thrustN ?? 0) > 0 && vehicle.fuelLitres > 0 && !towing && !pacing) return this.fly(id, unit, distance, heading);
    // A paced leg can already be inside the arrival margin while its tools still have ground to finish. Face its
    // nonzero heading before holding it there, braking before the turn. An ordinary Move still arrives without turning.
    if (vehicle?.config.enabled && !vehicle.fuelStarved && !towing && heading !== 0 && (pacing || distance > arrival) &&
      this.turnsAbout(id, unit, distance, heading, contact) &&
      (Math.abs(vehicle.vx || 0) > SETTLED || this.side.turnAbout?.(id))) return { throttle: 0, brake: 1 };
    if (distance <= arrival) {
      if (pacing && vehicle?.config.enabled) return this.halt(leg, vehicle);
      if (Math.abs(vehicle?.vx || 0) < SETTLED && !pacing) unit.move = null;
      return { throttle: 0, brake: 1 };
    }
    if (!vehicle?.config.enabled) { unit.move = null; unit.reason = 'immobile'; return { throttle: 0, brake: 1 }; }
    // Refuelling can make this same order possible again. Waiting for fuel must
    // not consume its progress timeout and erase the return to base.
    if (vehicle.fuelStarved) { leg.since = world.time; return { throttle: 0, brake: 1 }; }
    if (leg.pace === 0) { leg.since = world.time; return this.halt(leg, vehicle); }
    // Rolling away from the place when it was sent there, it stops on its brakes — wheels spun backwards hold the ground
    // worse, and are a vehicle that slips —, and how long it takes to get nearer is counted from where it stopped: a fast
    // vehicle is longer coming back to where it was told than a way that is shut is waited for.
    if (leg.turning) {
      if (speed < -ROLLING) return { throttle: 0, brake: 1 };
      Object.assign(leg, { turning: false, best: distance, since: world.time });
    }
    if (distance < leg.best - .5) { leg.best = distance; leg.since = world.time; }
    // Grade, cargo and mixed wheel contacts alone cannot prove a route impassable.
    // The speed envelope anticipates known terrain; only actual lack of progress
    // ends a trip, with the core's mobility reason or an obstruction in the way.
    // One gone at a pace waits as long again as it takes at that pace to come nearer by as much as counts.
    if (world.time - leg.since > PATIENCE + ((leg.pace ?? 0) > 0 ? .5 / leg.pace! : 0)) { unit.move = null; unit.reason = vehicle.stuck ? 'stuck-' + vehicle.stuck : 'blocked-way'; return { throttle: 0, brake: 1 }; }
    const safe = this.safeSpeed(id, leg);
    // Take up slack at walking pace; only lean on an obstruction once the cable
    // actually pulls back. Keep the ordinary arrival margin so breakaway drag
    // cannot strand the pair just outside it at an ever-smaller working pace.
    if (towing) {
      if (safe === 0) return { throttle: 0, brake: 1 };
      return paced(leg, vehicle, heading, speed,
        Math.min(safe, TOW_PACE, Math.sqrt(2 * PACE_STOP * (distance - arrival / 2))), world.time,
        { lean: (towing.tension ?? NaN) > 0 && (towing.anchorA.x - towing.anchorB.x) * heading > 0 });
    }
    if (pacing) return paced(leg, vehicle, heading, speed, Math.min(safe, leg.pace!, Math.sqrt(2 * PACE_STOP * (distance - arrival))), world.time);
    const tipping = this.tipping(id, heading, leg), slowing = Math.max(LEAST_BRAKING, Math.min(this.braking(id), tipping) + 9.81 * Math.min(0, climb)),
      stop = Math.sqrt(2 * slowing * (distance - arrival / 2)),
      allowed = Math.min(safe, stop);
    if (allowed === 0) return { throttle: 0, brake: 1 };
    // Fine parking still needs enough pull to start against native soil/rolling
    // resistance. At walking pace use its engine, then return to the speed servo.
    const starting = arrival < ARRIVAL && speed < SETTLED && allowed >= SETTLED;
    if (starting) {
      const { share } = drivetrain(vehicle, heading, speed, bearing(leg, vehicle, speed, world.time));
      return { throttle: heading * share, brake: 0 };
    }
    // Slowing for the place, or for what the ground ahead holds it to (a bend, the frontier, the end of the way it plans),
    // it is braked as planned all along, not pulled back short of it: on a bend under it, it only holds its speed.
    const ahead = unit.terrainPlan?.leg === unit.move && unit.terrainPlan.plan.ahead > 0;
    return paced(leg, vehicle, heading, speed, allowed, world.time, { surge: Infinity, slowing: stop < safe || ahead ? slowing : 0 });
  }
  // A vehicle that flies (ui-model.ts `flies`) is flown to the place along the field at the height over the ground it was
  // at when it set out, or at the one a point of the sky it was sent to stands at over the ground there (`leg.height`):
  // over the highest of the ground the side knows of on its way, from a little behind it (`FLIGHT_BEHIND`) to as far
  // ahead as it takes to climb over it (`FLIGHT_AHEAD`) and no further than the place, so that it goes over a valley
  // shorter than that and comes down only where all of that ground has fallen away; at the place, over the ground there;
  // never lower than `FLIGHT_FLOOR` over that ground, nor, on its way, than lets it be leant as far as it slows down at near
  // that ground (`flare`), and never higher than its thrusters hold it up at as its pilot flies it, in the thin air up
  // there (`ceiling`). It goes as fast as it can and still stops at the place and at that height: along the field
  // flat out until it must lean the other way (`FLIGHT_TURN`) to be slowed as hard as its
  // thrusters slow it, and the air as it goes fast, down falling with its thrusters idling until they must slow it so, and
  // up flat out until it must let them go to be slowed by its weight (`flight`, `FLIGHT_SLOWING`) — and no faster near the
  // place and the height than comes to them without swinging past them (`FLIGHT_CLOSING`). It ends hovering over the place
  // at that height, where its flight computer holds it (game_hover.rs).
  // Sent to land (`leg.land`), it comes down there instead, and the order ends as it stands on its skids; one that gets
  // no nearer comes down where it is. Asked to climb from the ground, it takes off. No speed is set for it: its keys ask
  // its thrusters for a share of all they can push it by (`FLIGHT_SERVO`), as much as keeps it to the speed it may go at,
  // and for no more in a round of its pilot than makes up some of what it is off that speed by (`FLIGHT_ROUND`). One that
  // hangs where it is, getting no nearer for as long as a vehicle on the ground, ends its order in a way that is shut.
  // With a load on its sling (sling.ts `slung`), it is flown with the lowest of the load as high as it would fly itself,
  // and takes it up straight, no faster than `SLING_TAKE_UP`, until the sling first bears the load (`SLING_CARRIED`,
  // `leg.borne`: a load that swings pulls on it by more and less than it weighs); it is reckoned to fly as heavy as the two
  // of them, and along the field no harder than its flight computer flies them (`flight`). Sent to land, it sets the load
  // down first, asked down by `SLING_DOWN` — its flight computer slows it for the load as it would for itself —, lets go
  // of it once the sling has borne none of it for `SLING_REST` (`Side.unhook`), and comes down clear of it (`landing`).
  fly(id: string, unit: SquadUnit, distance: number, heading: number) {
    const side = this.side, world = side.world, vehicle = requiredVehicle(world, id), x = this.position(id), leg = requiredMove(unit),
      ground = (at: number) => world.terrain.height(at), known = (at: number) => !side.knowsGround || side.knowsGround(at),
      sling = slung(world, id), deep = FLIGHT_FLOOR + (sling?.depth ?? 0);
    leg.height ??= Math.max(deep, vehicle.y - ground(x));
    const vx = vehicle.vx || 0, vy = vehicle.vy || 0, now = world.time, can = flight(world, id);
    // As fast as it may go and still stop at `left` metres from where it is, slowed by `slowing` m/s² from `turn` seconds
    // on and by the air as hard as `hold` says for the square of its speed — how far that takes is that of a body so slowed,
    // and how fast it may go is found by halves —, and no faster than `gain` m/s for each of those metres; and what its keys
    // ask to go so — along the field, as fast as it will go a moment on, as it is leant further than it hovers still at,
    // which jets that turn it back as they push it along lean it to (`poise`) —, by no more than makes up `FLIGHT_ROUND`
    // of it before its pilot looks again, which it is reckoned to go on at meanwhile.
    const round = clamp(now - (leg.flown ?? now - DECISION_STEPS / 60), 1 / 60, 1);
    leg.flown = now;
    const planned = (left: number, slowing: number, hold: number, gain: number, turn: number) => {
        if (!(slowing > 0)) return 0;
        const far = Math.abs(left), stop = (v: number) => v * turn + (hold > 1e-9 ? Math.log1p(hold * v * v / slowing) / (2 * hold) : v * v / (2 * slowing));
        let lo = 0, hi = Math.min(far / turn, 1000);
        for (let i = 0; i < 24; i++) { const v = (lo + hi) / 2; if (stop(v) > far) hi = v; else lo = v; }
        return Math.sign(left) * Math.min(gain * far, lo);
      }, servo = (speed: number, now: number, settle: number, faster: number, slower: number) => {
        const asked = (speed - now) / Math.max(settle, round / FLIGHT_ROUND), most = asked > 0 ? faster : slower;
        return most > 0 ? clamp(asked / most, -1, 1) : 0;
      }, ahead = vx + FLIGHT_LEAD * (can.poise - GRAVITY * Math.tan(vehicle.angle || 0)),
      along = (left: number) => servo(planned(left, FLIGHT_SLOWING * can.leans, can.brakes, FLIGHT_CLOSING[0], FLIGHT_TURN + round), ahead, FLIGHT_ALONG, can.along[1], can.along[0]);
    const reach = Math.min(distance, Math.max(FLIGHT_LOOK, Math.abs(vx) * FLIGHT_AHEAD)), back = Math.min(distance, Math.abs(vx) * FLIGHT_BEHIND),
      apart = Math.max(FLIGHT_LOOK, (reach + back) / FLIGHT_POINTS);
    let crest = ground(x);
    for (let at = -back; at <= reach; at += apart)
      if (known(x + heading * at)) crest = Math.max(crest, ground(x + heading * at));
    if (sling && (sling.tow.tension ?? NaN) >= SLING_CARRIED * sling.mass * GRAVITY) leg.borne = true;
    const bears = Boolean(sling) && !leg.borne,
      floor = Math.max(deep, distance > ARRIVAL ? Math.max(FLIGHT_FLOOR, flare(world, id, can.climbs > 0 ? Math.min(FLIGHT_LEAN, Math.acos(GRAVITY / (can.climbs + GRAVITY))) : 0)) : FLIGHT_FLOOR),
      up = Math.max(crest + floor, Math.min(crest + leg.height, ceiling(world, id))) - vehicle.y,
      closing = FLIGHT_CLOSING[distance > ARRIVAL ? (up > 0 ? 1 : 2) : 3],
      climb = servo(Math.min(up > 0 ? planned(up, FLIGHT_SLOWING * GRAVITY, 0, closing, round)
        : planned(up, FLIGHT_SLOWING * can.climbs, can.falls, closing, round), bears ? SLING_TAKE_UP : Infinity), vy, FLIGHT_SERVO, can.climbs,
        GRAVITY * (distance > ARRIVAL ? FLIGHT_DIVE : 1)),
      // Far off both the place and its height over the ground there, it climbs and goes along at once, leant towards the
      // point — sped up by its thrusters in the shares of the height and of the way it has left, as far as all they push it
      // with goes, so that it comes to both about together —, not straight up first: asked up flat out, all its thrusters
      // would go to climbing it (game_hover.rs `ASKED`). Not under its floor over the ground ahead of it, nor with that
      // ground higher than under it, nor going for a place to fire from (`strike`), up out of the way of guns: there it
      // climbs flat out first.
      way = (distance - ARRIVAL / 2) / up, lift = can.climbs + GRAVITY,
      shared = (Math.sqrt(GRAVITY * GRAVITY - (way * way + 1) * (GRAVITY * GRAVITY - lift * lift)) - GRAVITY) / (way * way + 1),
      sharing = !bears && climb >= 1 && up > 0 && can.climbs > 0 && distance > ARRIVAL && leg.purpose !== 'strike' &&
        vehicle.y - crest >= floor && crest <= ground(x) + 1,
      rise = sharing ? clamp(shared / can.climbs, 0, 1) : climb;
    // Over its place and slowed to `LANDING_DRIFT`, it starts down, steered over the place as it goes — its flight computer
    // lets it down only half as fast for that (game_hover.rs `DIVE`) — until it is all but still there and leant as it
    // hovers (`LANDING_STILL`, `LANDING_LEAN`), with no more than `LANDING_OFF` to drift by on its way down (`straight`):
    // from there it falls with its thrusters idling, which hold it along the field no more, and its flight computer slows
    // it with all of them at the last to touch the ground (`descentCost`). Let fall going faster, it would drift past the
    // place all the way down; leant over, it would be turned level as it fell by thrusters that push it along. One whose
    // thrusters cannot push it along the field either way (`flight`, `along`) falls at once: steered it would not be, and
    // lighter for the fuel it burns on its way down it would be steered only once it fell fast, swung over as its flight
    // computer leant it. Till it is over the place it holds its height and is brought there.
    // One sent down where it is, its thrusters holding it up no more, is down wherever it comes to stand on its skids.
    if (leg.land && (leg.down || distance <= ARRIVAL || leg.land === 'forced' && !vehicle.flying)) {
      if (!vehicle.flying) { unit.move = null; return { throttle: 0, brake: 0, rise: 0 }; }
      leg.down ||= Math.abs(vx) <= LANDING_DRIFT && Math.abs(x - leg.x) <= ARRIVAL;
      if (leg.down && sling) {
        leg.slack = (sling.tow.tension ?? NaN) < SLING_SLACK * sling.mass * GRAVITY ? leg.slack ?? now : null;
        if (leg.slack === null || now - leg.slack < SLING_REST || !side.unhook?.(id)) return { throttle: 0, brake: 0, rise: -SLING_DOWN };
        Object.assign(leg, { x: this.landing(id, x, new Set([id])), height: Math.max(FLIGHT_FLOOR, vehicle.y - ground(x)), down: false, straight: false, slack: null,
          best: Infinity, since: now });
        return { throttle: 0, brake: 0, rise: 0 };
      }
      if (leg.down) {
        const drifts = () => vx * (descentCost(requiredActor(world, id).blueprint, laden(world, id), vehicle.y - ground(x), ground(x)).falls! + 1 / FLIGHT_DAMPING);
        leg.straight ||= !(Math.min(...can.along) > 0) || Math.abs(vx) <= LANDING_STILL
          && Math.abs(Math.tan(vehicle.angle || 0) - can.poise / GRAVITY) <= Math.tan(LANDING_LEAN) && Math.abs(x + drifts() - leg.x) <= LANDING_OFF;
        return { throttle: leg.straight ? 0 : along(leg.x - x), brake: 0, rise: -1 };
      }
      return { throttle: along(leg.x - x), brake: 0, rise };
    }
    // Going, or climbing or coming down to its height over the place, it gets nearer: to the place, and to that height.
    const off = Math.hypot(distance, leg.land ? 0 : up);
    if (off < leg.best - .5 || Math.hypot(vx, vy) > SETTLED) { leg.best = Math.min(leg.best, off); leg.since = now; }
    if (now - leg.since > PATIENCE && leg.land) { Object.assign(leg, { x, best: 0, since: now }); return { throttle: 0, brake: 0, rise: 0 }; }
    if (now - leg.since > PATIENCE) { unit.move = null; unit.reason = 'blocked-way'; return { throttle: 0, brake: 0, rise: 0 }; }
    // Over the place, it is brought to its height there, and the order ends as it hovers so.
    if (distance <= ARRIVAL) {
      if (Math.hypot(vx, vy) < SETTLED && Math.abs(up) <= ARRIVAL) unit.move = null;
      return { throttle: 0, brake: 0, rise };
    }
    return { throttle: bears ? 0 : along(heading * (distance - ARRIVAL / 2)), brake: 0, rise };
  }
  // A vehicle at a pace that is to stop where it is: slowed as gently as it goes at its pace, and held on all of its brakes
  // once all but stopped.
  halt(leg: SquadMove, vehicle: Vehicle) {
    const vx = vehicle.vx || 0;
    return Math.abs(vx) > PACE_HELD ? paced(leg, vehicle, Math.sign(vx), Math.abs(vx), 0, this.side.world.time) : { throttle: 0, brake: 1 };
  }

  // How hard the brakes of a vehicle may stop it on the ground it is on (terrain-speed.ts `groundBraking`), in m/s²: ground
  // the side does not know is taken for the one that holds least, and a side that reads no ground counts on `BRAKING`. The
  // ground on to the place it is sent to, softer it may be, is the speed plan's (`safeSpeed`).
  braking(id: string) {
    const side = this.side, vehicle = requiredVehicle(side.world, id), x = this.position(id);
    if (!side.knowsGround) return BRAKING;
    return groundBraking(side.knowsGround(x) ? side.world.terrain.groundAt(x) : null, vehicle.drivetrain?.tracked, vehicle.groundPressureKPa || 0);
  }
  // How hard a vehicle sent the way `heading` points may brake to a stop, in m/s²: braking tips its weight onto the foremost
  // of its running gear along its way, and lifts it off the rest as the deceleration reaches g for every metre its centre of
  // mass stands behind that gear over each metre it stands over the ground. A share of that (`TIPPING`), for the springs
  // it dips on; as much as the brakes give, where it cannot be told. Worked out once for each way a leg goes.
  tipping(id: string, heading: number, leg: SquadMove) {
    if (leg.tipping?.heading === heading) return leg.tipping.value;
    const world = this.side.world, vehicle = requiredVehicle(world, id), c = Math.cos(vehicle.angle || 0), s = Math.sin(vehicle.angle || 0),
      center = vehicle.localCenter || { x: 0, y: 0 }, way = Math.sign(heading * c) || 1;
    let front = -Infinity, floor = 0, contacts = 0;
    for (const part of world.modules) if (part.actorId === id && ['wheel', 'track'].includes(part.kind) && part.health > 0 && part.attached !== false) {
      front = Math.max(front, way * (c * (part.x - vehicle.x) + s * (part.y - vehicle.y)) + (part.kind === 'track' ? part.width * .4 : 0));
      if (part.groundContact) { floor += part.groundContact.y; contacts++; }
    }
    const height = contacts ? vehicle.y + s * center.x + c * center.y - floor / contacts : 0, ahead = front - way * center.x,
      value = ahead > 0 && height > 0 ? 9.81 * TIPPING * ahead / height : BRAKING;
    leg.tipping = { heading, value };
    return value;
  }

  // A short braking corridor, kept by its unit so a field snapshot retains the
  // pilot's next decision. Native mass/centre and live gear decide its scale;
  // replacing or damaging the actor never keeps an old geometry plan. The player
  // at the controls does not enter drive at all.
  safeSpeed(id: string, leg: SquadMove) {
    if (!this.side.knowsGround) return Infinity;
    const world = this.side.world, actor = requiredActor(world, id), vehicle = requiredVehicle(world, id), x = this.position(id), heading = Math.sign(leg.x - x),
      unit = this.unit(id), kept = unit.terrainPlan,
      current = kept?.leg === leg && kept.actor === actor && kept.revision === actor.revision && kept.modules === world.modules,
      parts = current ? kept.parts : world.modules.filter(part => part.actorId === id), c = Math.cos(vehicle.angle || 0), s = Math.sin(vehicle.angle || 0);
    let lo = Infinity, hi = -Infinity, floor = 0, contacts = 0;
    for (const part of parts) if (['wheel', 'track'].includes(part.kind) && part.health > 0 && part.attached !== false) {
      const along = c * (part.x - x) + s * (part.y - vehicle.y), half = (part.kind === 'track' ? part.width * .8 : part.height) / 2;
      lo = Math.min(lo, along - half); hi = Math.max(hi, along + half);
      if (part.groundContact) { floor += part.groundContact.y; contacts++; }
    }
    const length = hi > lo ? hi - lo : this.room(id), center = vehicle.localCenter || { x: 0, y: 0 },
      height = contacts ? Math.max(.5, vehicle.y + s * center.x + c * center.y - floor / contacts) : length / 4,
      pressure = vehicle.groundPressureKPa || 0, speed = Math.max(0, vehicle.vx * heading), explored = this.side.faction?.explored,
      progress = kept ? (x - kept.x) * heading : 0;
    if (current && kept.terrain === world.terrain && kept.explored === explored &&
      kept.heading === heading && Math.abs(kept.to - leg.x) < ARRIVAL && progress >= 0 && progress < 2 && world.time - kept.time < .25 && speed < kept.speed + 2 &&
      Math.abs(kept.mass - vehicle.mass) < Math.max(1, vehicle.mass * .01) && Math.abs(kept.length - length) < .05 && Math.abs(kept.height - height) < .05 &&
      Math.abs(kept.pressure - pressure) < 1) return Math.sqrt(Math.max(0, kept.plan.braking2 - 2 * BRAKING * progress));
    const plan = terrainSpeed(world.terrain, x, leg.x, { speed, length, height, pressure, tracked: vehicle.drivetrain?.tracked ?? false, known: at => this.side.knowsGround!(at) });
    unit.terrainPlan = { leg, actor, revision: actor.revision, modules: world.modules, parts, terrain: world.terrain, explored,
      heading, to: leg.x, x, time: world.time, speed, mass: vehicle.mass, length, height, pressure, plan };
    return Math.sqrt(plan.speed2);
  }

  // Whether a vehicle sent `distance` metres the way `heading` points turns about before it goes. Backing, it goes at
  // `REVERSE_SHARE` of its speed, and turning about holds it `TURN_SECONDS`: it turns where that saves time enough on
  // the way. Not one with a gun that has an enemy ahead in its senses, nor one hit a moment ago: that one backs off
  // with its front to the fight. One on a way gone at a pace of its own — a machine making a road — turns about however
  // short the way: it works facing the way it goes.
  turnsAbout(id: string, unit: SquadUnit, distance: number, heading: number, contact: PilotContact | null | undefined) {
    const world = this.side.world, actor = requiredActor(world, id), top = actor.vehicle?.drivetrain?.maxSpeed || 0;
    if (heading === actor.facing || !(top > 0) || unit.alertUntil > world.time) return false;
    if (unit.move?.pace !== undefined) return true;
    return !this.fronted(id, contact) && distance / (top * REVERSE_SHARE) - distance / top > TURN_SECONDS + TURN_GAIN;
  }
  // Whether an aircraft in the air on its way (`unit.move`) turns about to fly there front first. The air holds it back by
  // what its hull shows the way it goes (game_motion.rs `Powertrain::air`): tail first, what it shows astern; pushed as
  // hard, front first it goes faster by the square root of how much less it shows ahead. Reckoned at the speed it goes —
  // or at `FLIGHT_HOMING`, as one not yet read going faster —, it turns where that saves `AIR_TURN_SECONDS` and
  // `TURN_GAIN` on the way: it is not steered while it turns. Not on its way to strike, where it faces as its gun has the
  // target (`strike`), nor with a gun that has an enemy ahead in its senses, nor hit a moment ago (`turnsAbout`).
  turnsAloft(id: string, unit: SquadUnit, contact: PilotContact | null | undefined) {
    const world = this.side.world, actor = world.actor(id), vehicle = actor?.vehicle, drag = vehicle?.drivetrain, leg = unit.move;
    if (!actor || !vehicle?.flying || !leg || leg.purpose === 'strike' || unit.alertUntil > world.time || !drag || !(drag.drag > 0 && drag.dragAstern > drag.drag)) return false;
    const x = this.position(id), heading = Math.sign(leg.x - x),
      saved = Math.abs(leg.x - x) / Math.max(Math.abs(vehicle.vx || 0), FLIGHT_HOMING) * (1 - Math.sqrt(drag.drag / drag.dragAstern));
    return heading !== 0 && heading !== actor.facing && !this.fronted(id, contact) && saved > AIR_TURN_SECONDS + TURN_GAIN;
  }
  // Whether a vehicle with a gun that works has an enemy ahead of it in its senses: it keeps its front to it.
  fronted(id: string, contact: PilotContact | null | undefined) {
    const world = this.side.world;
    return Boolean(contact?.detected && contact.age < 1 && (contact.x - this.position(id)) * requiredActor(world, id).facing > 0 &&
      world.modules.some(m => m.actorId === id && usableGun(m)));
  }

  view(): SquadView {
    const members = this.sync(), time = this.side.world.time;
    if (this.manual && !this.alive(this.manual)) this.manual = null;
    return { manual: this.manual, units: members.map(m => {
      const u = this.unit(m.id);
      return { id: m.id, role: m.role, defeated: Boolean(this.side.defeats[m.id]), stance: u.stance,
        move: u.move ? { x: u.move.x, ...(u.move.sky ? { height: u.move.height } : {}), ...(u.move.land ? { land: u.move.land } : {}),
          ...(u.move.purpose === 'home' ? { home: true } : {}) } : null,
        attack: u.attack ? structuredClone(u.attack) : null,
        haul: u.haul ? { ...u.haul } : null, counter: u.counter ? { x: u.counter.point.x } : null,
        alert: u.alertUntil > time, heard: time - u.heardAt < HEARD_SECONDS ? u.heard : null, activity: m.id === this.manual ? 'manual' : u.activity, reason: u.reason,
        ...(u.haltEvent ? { haltEvent: u.haltEvent } : {}),
        // The enemy its guns are on is named only while the side has it in sight or on its radar.
        targetId: u.targetId && this.sighted(u.targetId) ? u.targetId : null };
    }) };
  }
}
