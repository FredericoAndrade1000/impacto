import type { FieldView, FactionView } from './faction-ui.ts';
import type { FieldPanelOptions, FieldPanelView, GroundHoldsMemo } from './field-panel.ts';
import type { SoundSystem } from './audio.ts';
import type { TerrainId } from './terrain.ts';
import type { Deposit } from './deposits.ts';
import type { SupplyBill } from './economy-contract.ts';

export interface FabricationNotice { factionId: string; name: string; price: SupplyBill }
export interface UiModelOptions {
  view: UiView; editor: Editor; state: FieldView | null | undefined; network: UiNetwork; session: UiSession; terrainId: TerrainId;
  obstruction: { reason: string } | null | undefined; aimSolution?: FlightSolution | null;
  modulePreview: CanvasModulePreview | null | undefined; sound: Pick<SoundSystem, 'enabled' | 'musicOn' | 'backgroundAlerts' | 'volume' | 'unavailable' | 'context'>;
  choice?: Pick<FieldPanelOptions, 'picked' | 'armed' | 'focus'> | null; deposits?: readonly Deposit[]; touch?: boolean;
  vehicle?: SpeedReading | null; camera?: { locked: boolean; name: string } | null; shotsHeld?: boolean; instant?: boolean;
  fabrication?: FabricationNotice | null;
}
import type { CompiledConstruction, CompiledModule, WithAbsentSlots } from './construction-contract.ts';
import type { DrawingModule } from './scene-drawing-contract.ts';
import type { ConnectionState } from './connection-state.ts';
import type { BindingProperties, OptionEntry } from './dom-view.ts';
import type { FlightSolution } from './ballistic-contract.ts';
import type { SpeedReading } from './vehicle-speed.ts';
import type { CanvasModulePreview } from './canvas-controls.ts';

type UiModule = WithAbsentSlots<CompiledModule | DrawingModule>;
export type ResolvedArmament = WeaponSettings & { preset: WeaponId };
export interface UiNetwork extends ConnectionState {
  designs: ReadonlyMap<string, { blueprint: import('./construction-contract.ts').AuthoredConstruction }>;
  selected?: string | null; manualActorId?: string | null; faction?: FactionView | null; pingMs?: number;
}
export type UiScene = FieldView;
import type { Editor } from './editor.ts';
import type { Point, Pose } from './math.ts';
import type { AuthoredDetail } from './construction-contract.ts';
import type { WeaponOverrides, WeaponId, WeaponFamilyId, WeaponSettings, AmmoId, Trajectory } from './weapons.ts';
import type { ModulePlacementOptions } from './structured-editing.ts';
import type { ModuleKind } from './materials.ts';

export interface ArmamentIntent extends WeaponOverrides { preset: WeaponId; id?: WeaponFamilyId; trajectory: Trajectory }
export interface UiPlacement extends ModulePlacementOptions {
  kind: ModuleKind | 'plate';
}
export interface DetailEditView {
  corners: Point[] | null; host?: readonly Point[] | undefined;
  carried: { detail: AuthoredDetail; pose: Pose & { mirrored: boolean }; hidden: boolean; paint: number } | null;
  hover: Point[] | null; ghosts: Point[][]; guides: Point[][];
}
export interface UiView {
  editor: Editor; mode: 'edit' | 'test'; trial: 'armour' | 'terrain' | null;
  buildTool: 'select' | 'module' | 'plate' | 'track'; repeatPlacement: boolean; testTool: 'fire' | 'inspect';
  aim: Point; placement: UiPlacement; weapon: ArmamentIntent; linked: Set<string>;
  loadouts: Record<string, Pick<WeaponSettings, 'trajectory' | 'detonation' | 'charge'>>;
  exterior?: boolean; cameraFree?: boolean; detailEdit?: DetailEditView | null;
}
export interface UiSession {
  paused: boolean; generation: number; requestSerial: number; ready: boolean; physicsMs: number | undefined;
  testDistance: number; fitPending: 'controlled' | 'placed' | null; slowed: boolean;
  fieldMobility?: GroundHoldsMemo;
}
export interface UiInput {
  driveKeys?: ReadonlySet<string>; lookKeys?: ReadonlySet<string>; stick?: Point | null;
}

import { tr, translate } from './i18n.ts';
import { MODULES } from './materials.ts';
import { WEAPON_PRESETS, DEFAULT_WEAPON_PRESETS, AMMO, KINETIC_AMMO, weaponSettings, allowedAmmo, allowedTrajectories, fedAmmo, BARREL_GLOW, barrelLimit, isWeaponPresetId, weaponOf } from './weapons.ts';
import { chargeSpeed } from './ballistics.ts';
import { blueprintMass, blueprintPowertrain, installedPower } from './mass-properties.ts';
import { ammunitionSupply } from './component-volume.ts';
import { pieceCost, formatCredits } from './construction-cost.ts';
import { servoStatus, aimLimitText } from './weapon-presentation.ts';
import { number, partViews } from './part-view.ts';
import { pointOf } from './frame-points.ts';
import { PLACEMENT_FIELDS } from './ui-fields.ts';
import { compileBlueprint, isVehicleDesign } from './persistence.ts';
import { yardText, stockFigures, stockWants, captureBar, duelPanel } from './faction-ui.ts';
import { designBill, roomText, bill, STOCK_IDS } from './economy.ts';
import { fieldPanel } from './field-panel.ts';
import { compactStock } from './field-navigation.ts';
import { chassisCapacity } from './workshop-capacity.ts';
import { connectionNotice } from './connection-state.ts';
import { workshopAdmissionMessage } from './workshop-checklist.ts';
import { speed, power, specificPower, kilometres, distance } from './format.ts';
import { RANGE_NOTE, HOVER_NOTE, flightTime } from './workshop-context.ts';
import { CONSTRUCTION_LIMITS } from './construction-limits.ts';
import { TRIAL_TARGETS } from './battle-rules.ts';
import { industryReason } from './industry-ui.ts';
import { weaponName, weaponFeed } from './weapon-names.ts';

// Selection is an intent. Resolving a missing selection chooses an available
// component; resolving a destroyed selection preserves its identity and state.
// Painting the screen never changes the intent or invents a working gun: one
// asked of the construction is of it, and a construction with none has none.
const uiTrajectory = (preset: WeaponId | 'custom' | undefined, mounted: boolean): Trajectory => mounted && allowedTrajectories(preset).includes('auto') ? 'auto' : 'low';
export function armamentIntent(config: WeaponOverrides & { id?: WeaponFamilyId } = {}): ArmamentIntent {
  const preset = config.preset ?? (config.id ? DEFAULT_WEAPON_PRESETS[config.id] : undefined) ?? 'rh120';
  const controls = ['platform', 'componentId', 'ammo', 'detonation', 'aimAngle', 'charge', 'fuzeTime'] as const;
  return { preset, ...Object.fromEntries(controls.filter(key => config[key] !== undefined).map(key => [key, config[key]])),
    trajectory: uiTrajectory(preset, config.platform === 'vehicle') };
}
export function resolveArmament(intent: WeaponOverrides & { id?: WeaponFamilyId }, modules: readonly UiModule[], requiredMounted = false): ResolvedArmament {
  const guns = modules.filter(m => m.kind === 'weapon');
  const mounted = requiredMounted || intent.platform === 'vehicle';
  const gun = mounted ? (guns.find(m => m.id === intent.componentId) ||
    guns.find(working) || guns[0]) : undefined;
  const presetId = gun?.weaponPreset ?? intent.preset ?? (intent.id ? DEFAULT_WEAPON_PRESETS[intent.id] : undefined) ?? 'rh120';
  const preset = weaponOf(presetId) ?? WEAPON_PRESETS.rh120;
  const { detonation, aimAngle, charge, fuzeTime } = intent;
  // A gun on a vehicle fires the ammunition it was built to be fed; only the one the test of armour is struck with
  // is handed another.
  const ammo = mounted ? fedAmmo(gun || { weaponPreset: presetId }) : intent.ammo;
  // That one has a low arc, which its strikes go along the line drawn without (armour-strike.ts). Mounted weapons keep
  // their automatic solution when supported: a roof mortar cannot lower its barrel into a low ground-level arc.
  const resolved = weaponSettings(preset.family, { ammo, trajectory: uiTrajectory(presetId, mounted), detonation, aimAngle, charge, fuzeTime, preset: presetId,
    platform: mounted ? 'vehicle' : 'ground', componentId: gun?.id });
  return { ...resolved, preset: presetId };
}

// A gun is known by its place in the design: every copy of a construction, and
// every time it is put back on the field, answers to the same switches.
export const pieceKey = (id: unknown) => String(id).slice(String(id).lastIndexOf(':') + 1);
const working = (m: UiModule) => m.health !== 0 && m.attached !== false && !m.barrelDisabled;
// The UI chooses the trajectory from the gun and platform; fuze and charge remain the gun's own.
export const loadout = (weapon: Pick<WeaponSettings, 'preset' | 'platform' | 'detonation' | 'charge'>): Pick<WeaponSettings, 'trajectory' | 'detonation' | 'charge'> => ({ trajectory: uiTrajectory(weapon.preset, weapon.platform === 'vehicle'), detonation: weapon.detonation, charge: weapon.charge });
// The other guns switched on to fire with the weapon in hand. One of its model fires as it does: the fuze and
// charge chosen on the screen are those of every such gun. One of another model keeps the loadout it was last
// given. Each has its own reload; one that cannot fire is left out.
export function linkedArmament(view: Partial<Pick<UiView, 'linked' | 'loadouts'>>, modules: readonly UiModule[], weapon: WeaponSettings) {
  if (weapon.platform !== 'vehicle' || !view.linked?.size) return [];
  const linked = view.linked;
  return modules.filter(m => m.kind === 'weapon' && m.id !== weapon.componentId && linked.has(pieceKey(m.id)) && working(m))
    .map(m => ({ componentId: m.id, ...loadout((m.weaponPreset || 'rh120') === weapon.preset ? weapon
      : resolveArmament({ platform: 'vehicle', componentId: m.id, ...view.loadouts?.[pieceKey(m.id)] }, modules, true)) }));
}

// Whether a vehicle flies: whether its thrusters that work push with anything (game_hover.rs).
export const flies = (actor: { vehicle?: { thrustN?: number | undefined } | null | undefined } | null | undefined) => (actor?.vehicle?.thrustN ?? 0) > 0;
// A and D drive, S brakes on all of the brakes: the held keys are all there is to driving. A vehicle that `flies` is
// taken up by W and down by S, and along the field by A and D whatever else is held, or by the stick on the screen of a
// phone (`input.stick`, touch.ts `initStick`) as far as it is pushed each way: with nothing asked, it hovers.
export function driveIntent(input: UiInput = {}, flying = false) {
  const keys = input.driveKeys || new Set(), left = keys.has('a'), right = keys.has('d'), brake = keys.has('s') ? 1 : 0;
  if (flying) {
    const stick = input.stick, held = (key: string) => Number(keys.has(key));
    return { left, right, brake: 0, throttle: stick ? stick.x : held('d') - held('a'), rise: stick ? stick.y : held('w') - held('s') };
  }
  return { left, right, brake, throttle: brake ? 0 : Number(right) - Number(left) };
}
// The arrow keys look around: the way the held ones take the view, to the right and upwards.
export function lookIntent(input: UiInput = {}) {
  const keys = input.lookKeys || new Set(), held = (key: string) => Number(keys.has(key));
  return { x: held('arrowright') - held('arrowleft'), y: held('arrowup') - held('arrowdown') };
}

export function controlContext(view: Pick<UiView, 'mode'>, state: UiScene | null | undefined, network: Pick<UiNetwork, 'enabled' | 'connected' | 'selected' | 'manualActorId'>) {
  const edit = view.mode === 'edit', shared = Boolean(network.enabled);
  // A squad answers to the player: the vehicle taken over is under manual control, the others follow orders.
  // It is the player's own constructions on the shared field; a test has the one construction of the design.
  const squad = !edit && state?.squad || null;
  const actorId = squad ? squad.manual : shared ? network.selected : 'local';
  const actor = state?.actors?.find(actor => actor.id === actorId);
  // A squad with no vehicle in hand drives itself. A wreck is in nobody's hands (wreck.ts): the field lets go of one
  // when it becomes one, and a test of the design that became one (trial-targets.ts) has nothing in hand until restored.
  const autopilot = Boolean(squad && !actorId);
  return { edit, shared, actorId, actor, autopilot, squad,
    // The frame owns geometry and armament; current connection metadata owns permission.
    manual: !edit && !autopilot && !actor?.defeated && (!shared || network.connected && Boolean(actorId) && Boolean(actor) && network.manualActorId === actorId) };
}
export function screenContext(view: UiView, editor: Editor, state: UiScene | null | undefined, network: UiNetwork) {
  const c = controlContext(view, state, network), { edit, shared, actorId, actor } = c;
  const source = !edit && shared && actorId ? network.designs.get(actorId)?.blueprint : null,
    blueprint: CompiledConstruction = source ? compileBlueprint(source) : editor.blueprint;
  const selectedId = editor.selection;
  const modules: UiModule[] = edit || !state ? blueprint?.modules || [] : state.modules.filter(m => m.actorId === actorId);
  // The points of the frame selected beside the pieces (frame-points.ts): ends of plates, points and stretches of the chassis.
  const points = edit ? [...editor.selectionIds].filter(id => pointOf(id)) : [];
  const context = { ...c, blueprint, modules, source: edit ? editor.source : null, points,
    vehicle: edit ? null : actor?.vehicle || null,
    isVehicle: (actor && !edit ? actor.preset : blueprint?.preset) === 'vehicle',
    weapons: modules.filter((m): m is UiModule & { kind: 'weapon' } => m.kind === 'weapon'),
    weapon: resolveArmament(view.weapon, modules, !edit && shared) };
  if (edit) {
    const selection = partViews(blueprint, null, editor.selectionIds);
    return { ...context, edit: true as const, selection, selected: selection.find(part => part.id === selectedId) };
  }
  const selection = partViews(blueprint, state, editor.selectionIds);
  return { ...context, edit: false as const, selection, selected: selection.find(part => part.id === selectedId) };
}

const text = (value: BindingProperties['text']) => ({ text: value });
const visible = (value: unknown) => ({ hidden: !value });
// The gauges of the vehicle the panel speaks of: each it has, with its words, how full it is and whether it runs short.
const gauges = (stats: FieldPanelView['stats']): Record<string, BindingProperties> => Object.fromEntries((['fuel', 'rounds', 'cargo', 'whole', 'supplies'] as const).flatMap(id => {
  const gauge = stats?.[id];
  return [['stat-' + id, { hidden: !gauge, title: gauge?.title ?? '', classes: { low: Boolean(gauge && 'low' in gauge && gauge.low) } }], ['stat-' + id + '-text', text(gauge?.text ?? '')],
    ...(id === 'rounds' ? [] : [['stat-' + id + '-bar', { attr: { style: `--fill: ${Math.round((gauge && 'share' in gauge ? gauge.share : 0) * 100)}%` } }]])];
}));
const list = (options: readonly OptionEntry[], value: BindingProperties['value'], disabled = false) => ({ options, value, disabled });
// What a gun holds ready and how its crew fills it again, as the frame tells them (`loaded`, `feedReload`), in the words of
// the line over the field: a belt or a magazine against what it holds (weapon-names.ts `weaponFeed`); the crew topping the
// belt up or putting rounds back in the magazine, which the gun fires from meanwhile; and, the belt or magazine empty, the
// change the gun waits for (`waiting`) and, of a belt, how much of it is ahead (`share`); its compartment wrecked by a hit
// (`beltCut`), that it is fed no more. A gun loaded by hand, and a frame that tells neither, tell no feed.
function gunFeed(gun: UiModule | undefined, preset: WeaponId) {
  const loaded = gun && 'loaded' in gun && typeof gun.loaded === 'number' ? gun.loaded : null,
    refill = gun && 'feedReload' in gun && typeof gun.feedReload === 'number' ? gun.feedReload : 0, feed = weaponFeed(preset);
  if (loaded === null || !feed || feed.kind === 'hand') return null;
  if (gun && 'beltCut' in gun && gun.beltCut) return { waiting: true, share: 0, status: tr('compartimento destruído'), text: tr('Compartimento da munição destruído') };
  const belt = feed.kind === 'belt', waiting = refill > 0 && loaded <= 0;
  return { waiting, share: waiting && belt && feed.reloadS ? Math.min(1, refill / feed.reloadS) : 0,
    status: !waiting ? '' : belt ? tr('trocando a cinta') : tr('repondo o pente'),
    text: waiting ? belt ? tr`Trocando a cinta · ${number(refill, 0)} s` : tr`Repondo o pente · ${loaded}/${feed.rounds}`
      : refill > 0 ? belt ? tr`completando a cinta · ${loaded}/${feed.rounds}` : tr`repondo o pente · ${loaded}/${feed.rounds}`
        : belt ? tr`cinta ${loaded}/${feed.rounds}` : tr`pente ${loaded}/${feed.rounds}` };
}
// A piece installed is named as its button names it, where its name says something else.
const PLACED: Partial<Record<ModuleKind | 'plate' | 'select', string>> = { fuel: 'tanque', plate: 'chapa' };
// A design this near what its chassis carries is told so beside its weight.

// What a test of the design says of its controls as it starts: to the keys and the mouse, or to a finger (`touch`).
// The test of armour is struck along a line drawn from where the round comes from to where it goes, or level at the
// piece clicked (armour-strike.ts); one finger draws there, and two move the view. `fires`, that the design on the
// proving ground has a gun to fire; `flies`, that it has thrusters to fly with.
export function trialHint({ kind = 'armour', touch = false, fires = true, flies = false } = {}) {
  const fire = touch ? tr('toque para mirar e Fogo dispara') : tr('clique ou segure para disparar');
  if (kind === 'armour') return tr('Arraste de onde vem o tiro até onde ele vai · ') +
    (touch ? tr('toque no projeto para um tiro na horizontal · dois dedos movem a vista.') : tr('clique no projeto para um tiro na horizontal.'));
  const drive = flies ? touch ? tr('o controle à esquerda pilota') : tr('W/S sobem e descem e A/D vão para os lados')
    : touch ? tr('os botões à esquerda conduzem') : 'A/D conduzem e S freia';
  return tr('Campo de provas · terreno do mundo · ') + drive + (fires ? ' · ' + fire : '') + '.';
}
// What of a test the player sees into (faction-ui.ts `seenFromOutside`): the design, in the test of armour, and on the
// proving ground while it is inspected. Driven there, it is seen from outside, as the vehicle in the player's hands is on
// the field; the targets always are.
export const trialOpened = ({ trial, testTool }: Pick<UiView, 'trial' | 'testTool'>) => new Set(trial === 'armour' || testTool === 'inspect' ? ['local'] : []);

// Every visible property is derived from the document, current frame or session.
// DOM bindings have no independent game state or lifecycle callbacks.
// `choice` is the player's on the field — who is picked, the order waiting for its click and the
// construction the workshop would replace — and `deposits` are the sites of its ground: with them the
// side panel is told by `fieldPanel`, block by block, and painted here.
//
// The page is at the workshop or on the field (`view.mode`, 'edit' or 'test'): on the shared field the workshop is
// the design standing at the base with the field going on about it, and away from it, the design on a bench of its
// own. Or the page is in a test of the design (`view.trial`): of armour, the design on flat ground struck with a gun
// of the player's choice along the lines the player draws, or on the proving ground — `terrainId` says which —,
// driven and fired with its own guns.
// A test is told no field: `network` is told as not joined.
// `touch` says the player points with a finger: what the workshop says of installing speaks of the finger, and the
// vehicle in hand is driven and fired with the buttons over the field. `vehicle` is how fast the vehicle the dock speaks
// of goes (`vehicleSpeed`), and `camera` the vehicle the camera goes with, or would, and whether it does. `shotsHeld`
// says the guns of the faction wait for its rounds in the air to come down (construction-limits.ts, `SHOT_BUDGET`), and
// `fabrication` the vehicle the player went to fabricate that the stocks alone kept from it (faction-ui.ts `stockWants`).
export function screenModel({ view, editor, state, network, session, terrainId,
  obstruction, aimSolution = null, modulePreview, sound, choice = null, deposits = [], touch = false, vehicle = null, camera = null, shotsHeld = false, instant = false,
  fabrication = null }: UiModelOptions) {
  const c = screenContext(view, editor, state, network);
  const { edit, shared, autopilot, weapon } = c, inspecting = !edit && view.testTool === 'inspect';
  const b: CompiledConstruction = editor.blueprint, mass = blueprintMass(b), drivetrain = blueprintPowertrain(b);
  // The ground is the field's in both of its tabs; in a test, the test's own.
  const terrain = shared ? state?.terrain || 'flat' : terrainId;
  const mounted = weapon.platform === 'vehicle', gun = c.weapons.find(m => m.id === weapon.componentId);
  const armed = !mounted || gun && working(gun);
  // Fired from a construction, there is something to fire only while one of its guns still does, and nothing of a wreck
  // does (`wrecked`). The test of armour is struck along the lines the player draws, its design a wreck or not.
  const wrecked = !edit && Boolean(c.actor?.defeated), fires = !mounted || !wrecked && c.weapons.some(working);
  const rounds = mounted ? ammunitionSupply(c.modules, gun?.weaponPreset || weapon.preset, c.actorId ?? undefined)
    .reduce((sum, m) => sum + (m.rounds || 0), 0) : Infinity;
  const servo = mounted && !edit && gun?.weaponMount ? servoStatus({ ...gun, weaponMount: gun.weaponMount }) : servoStatus(null), aligning = servo.aligning;
  const supply = (preset: WeaponId) => ammunitionSupply(c.modules, preset, c.actorId ?? undefined).reduce((sum, m) => sum + (m.rounds || 0), 0);
  const reload = mounted ? gun?.reload || 0 : 0, heat = mounted ? gun?.barrelTemperature ?? 0 : 0,
    fed = mounted ? gunFeed(gun, gun?.weaponPreset || weapon.preset) : null;
  // How much of its reload a gun still has ahead of it, of the whole that follows a shot; of a belt being changed, of the
  // change.
  const loading = fed?.share ? fed.share : reload > .05 ? Math.min(1, reload * (weaponOf(gun?.weaponPreset || weapon.preset) ?? WEAPON_PRESETS.rh120).rate / 60) : 0;
  const unreachable = mounted && !edit && aimSolution?.reachable === false;
  const blocked = unreachable || obstruction && !aligning;
  const model = weaponOf(weapon.preset) ?? WEAPON_PRESETS.rh120;
  const tools = view.buildTool, placement = view.placement, repeating = Boolean(view.repeatPlacement),
    assistedPlacement = editor.snap && tools === 'module' && placement.kind !== 'weapon' &&
      (placement.copies?.length || 0) <= 1 && !placement.plates?.length;
  // The calibres of a box to install; one of a gun made over, which a box is being installed for (workshop-ux.ts `feedGun`),
  // is among them while it is chosen.
  const ammoOptions: OptionEntry[] = [...placement.ammoPreset && !isWeaponPresetId(placement.ammoPreset) ? [[placement.ammoPreset, weaponName(placement.ammoPreset)] as const] : [],
    ...Object.entries(WEAPON_PRESETS).map(([id, preset]) => [id, tr(preset.name)] as const)];
  const copyCalibres = [...new Set((placement.copies || []).filter(copy => copy.component.kind === 'ammo')
    .map(copy => weaponName(copy.component.ammoPreset ?? 'rh120')))];
  // The figures of the design: over it its weight, its power and its range (`SUMMARY_FIGURES`), and the others in
  // Revisão; its top speed is an estimate, on firm, level ground.
  // What the design weighs is told against what its chassis carries: with its fuel, its ammunition and its cargo full,
  // as the chassis is asked to carry it. Over what it carries, the figure says so, and by how much in its title; a
  // structure that stands without one is told its weight alone. A vehicle with no engine or no tank is told so of its power and
  // its range; a structure has neither. The range of an aircraft is how long its tank keeps it hovering, full, and it has no
  // top speed on the ground.
  const tonnes = mass / 1000, chassis = b.chassis, capacity = chassisCapacity(b), t = (kg: number) => number(kg / 1000), drives = Boolean(b.vehicle?.enabled),
    engined = b.modules.some(module => module.kind === 'engine'), tanked = b.modules.some(module => module.kind === 'fuel'),
    aircraft = chassis?.model === 'aircraft', hovers = b.flight?.hoverLitres ?? 0,
    tank = b.modules.filter(module => module.kind === 'fuel').reduce((sum, module) => sum + (module.capacityLitres ?? 0), 0),
    figures = !edit ? [] : [
    chassis ? { label: tr('PESO'), value: `${t(chassis.loadedKg)} / ${t(chassis.limitKg)} t`, over: Boolean(capacity?.over),
      title: (capacity?.over ? tr`${capacity.margin} do chassi · com` : tr('Com')) + tr` combustível, munição e carga cheios; vazio: ${t(chassis.emptyKg)} t` }
      : { label: tr('PESO'), value: `${number(tonnes)} t` },
    ...(drives ? [
      engined ? { label: tr('POTÊNCIA'), value: power(installedPower(b)), title: tr`Todos os motores · ${specificPower(installedPower(b), tonnes)}` }
        : { label: tr('POTÊNCIA'), value: '—', title: tr('Sem motor') },
      aircraft ? tanked && hovers > 0 ? { label: tr('AUTONOMIA'), value: flightTime(tank / hovers), title: HOVER_NOTE }
        : { label: tr('AUTONOMIA'), value: '—', title: tanked ? tr('Sem propulsor') : tr('Sem tanque') }
        : engined && tanked ? { label: tr('AUTONOMIA'), value: kilometres(Math.round(drivetrain.rangeKm)), title: RANGE_NOTE }
          : { label: tr('AUTONOMIA'), value: '—', title: tanked ? tr('Sem motor') : tr('Sem tanque') }] : []),
    ...(drives && engined && !aircraft ? [{ label: tr('MÁXIMA ESTIMADA'), value: speed(drivetrain.maxSpeed), title: tr('Em piso firme e plano.') }] : []),
    // What its hoppers, its cisterns and its supply pieces hold, for a design that has any.
    ...[roomText(editor.blueprint)].filter(Boolean).map(carries => ({ label: 'CARGA', value: carries, title: tr('Caçambas, cisternas e suprimentos: a carga pesa no veículo') }))];
  // What the design is paid from, each piece from the stock of what it is made of.
  const price = edit && shared ? designBill(b) : null;
  // A design with a command post sees with its eyes, as the core tells them of it: with none that sees out
  // ahead — a design faces left — it is told so, where the problems of a design are told.
  const blind = !edit || !b.modules.some(m => m.kind === 'command') || b.eyes.some(eye => eye.left > 0) ? '' :
    b.eyes.length ? tr('Sem visão à frente: só vê para trás.') : tr('Sem visão à frente: ponha uma câmera por fora ou um vidro blindado.');
  // The side panel of the field: which blocks it has in this situation and what each says.
  const faction = shared && network.faction || null,
    admissionReason = edit ? workshopAdmissionMessage(b, editor.manufactureIssues) || industryReason(editor.source, faction, b) : '',
    panel = fieldPanel({ tab: view.mode, shared, connected: Boolean(network.connected), state: state ?? null, faction, playerId: network.playerId ?? null,
      mobility: session.fieldMobility ||= {},
      ...(choice ?? {}), price, admissionReason, commanded: editor.blueprint.modules.some(m => m.kind === 'command'),
      drives: isVehicleDesign(editor.source), deposits, pingMs: network.pingMs ?? 0, touch, instant }),
    quote = panel.publish, service = (id: string) => { const work = panel.services.find(job => job.id === id);
      return work ? { hidden: false, text: work.text, disabled: work.disabled, title: work.title } : { hidden: true }; },
    capture = captureBar(faction, state?.time ?? 0), duel = duelPanel(faction?.duel);
  // The guns have their block while the player fires: the gun the test of armour is struck with always, those of a
  // construction when it has one.
  const weaponBlock = panel.situation ? panel.weapon : !edit && (!mounted || c.weapons.length > 0), trial = view.trial;
  // The gun in hand is told over the field, under the controls (`gunTold`): the side panel does not say it again. The
  // test of armour has none in hand: its gun is told in the panel. Inspecting a test, the same line tells the piece
  // picked — its name, its thickness and how much of it is left —, or how to pick one (`inspection`). Not inspected, a
  // design that became a wreck in a test says so on that line, and how to have it whole again (`wreck`).
  const gunTold = c.manual && mounted && fires && !inspecting, picked = inspecting && !shared ? c.selected : null, health = picked?.health;
  const inspection = !inspecting || shared ? null : picked ? { title: picked.name + (picked.definition.material ? ' · ' + number(picked.definition.thicknessMm, 0) + ' mm' : ''),
    detail: health ? health.percent + ' · ' + health.status : '', color: health?.color ?? '' }
    : { title: (touch ? tr('Toque') : tr('Clique')) + tr(' numa peça para ver os danos'), detail: '', color: '' };
  const wreck = wrecked && !shared && !inspecting ? { title: tr('Fora de combate'), detail: tr('Comando destruído · Restaurar recomeça') } : null;
  const notice = connectionNotice(network, view.trial), connection = edit && session.ready && !notice?.compact ? null : notice;
  // New can be refused while replacing is affordable; its reason must be readable without hovering.
  const newRefusal = (quote?.spawn.disabled ? quote.spawn.title || quote.text : quote?.text) || '';
  const replacementRefusal = quote?.replace?.disabled ? quote.replace.title || '' : '',
    separateReplacementRefusal = replacementRefusal && replacementRefusal !== newRefusal;
  const standing = panel.faction?.standing;
  // Beside the name in the dock, the speed of the vehicle it speaks of: of the one in hand always, and of one commanded
  // while it goes any way, or is on its way somewhere (`vehicleSpeed`). Beside its buttons, the one that has the camera go
  // with it. Neither is in the test of armour.
  const armour = view.trial === 'armour', dockSpeed = !edit && !armour && vehicle && (c.manual || vehicle.moving) ? vehicle.speed : '',
    follow = !edit && !armour ? camera : null, cameraLabel = follow?.locked ? tr('Soltar câmera') : tr('Fixar câmera');
  const bindings: Record<string, BindingProperties> = {
    'field-dock-speed': { hidden: !dockSpeed, text: dockSpeed, attr: { 'aria-label': dockSpeed ? 'Velocidade: ' + dockSpeed : '' } },
    'field-dock-reverse': visible(Boolean(dockSpeed && vehicle?.reverse)),
    'camera-lock': { hidden: !follow,
      title: !follow ? '' : follow.locked ? tr`Soltar câmera · parar de seguir ${follow.name}` : tr`Fixar câmera · seguir ${follow.name} sem assumir o controle`,
      attr: { 'aria-pressed': String(Boolean(follow?.locked)), 'aria-label': cameraLabel } },
    'connection-notice': { hidden: !connection, data: { compact: Boolean(connection?.compact) } },
    'connection-title': text(connection?.title ?? ''), 'connection-detail': text(connection?.detail ?? ''),
    'connection-retry': { hidden: !connection?.retry, text: connection?.retryText ?? tr('Tentar agora') },
    'connection-reload': visible(Boolean(connection?.reload)),
    'connection-servers': visible(Boolean(connection && !network.playerId)),
    'connection-workshop': visible(!session.ready && !connection?.compact),
    'workshop-placement': visible(edit && tools !== 'select'),
    'workshop-placement-hint': text(tools === 'plate' ? tr('Arraste do início ao fim da chapa.') :
      (touch ? tr('Arraste para instalar.') : tr('Clique para instalar.')) + (assistedPlacement ? tr(' Encaixe alinha apoios próximos.') : '')),
    'workshop-repeat': { checked: Boolean(view.repeatPlacement) },
    'workshop-placement-cancel': { text: repeating ? tr('Concluir') : tr('Cancelar'),
      attr: { title: (repeating ? tr('Concluir instalação') : tr('Cancelar instalação')) + ' · C' } },
    'body-paint': { value: b.appearance?.paint || '#68765a', disabled: !edit },
    undo: { disabled: !edit || !editor.past.length }, redo: { disabled: !edit || !editor.future.length },
    // History remains reachable from every workshop task and while its panel is hidden.
    'workshop-history': visible(edit),
    // Workspace navigation and workshop surfaces have their own controllers; bindings retain only their contents.
    reset: visible(trial), 'edit-controls': { data: { installing: tools !== 'select' } }, 'test-controls': visible(weaponBlock),
    // The pointer fires only where there is something to fire and somebody to fire it.
    viewport: { data: { tool: edit ? tools : autopilot ? 'command' : !inspecting && (shared && !c.manual || !fires) ? 'drive' : view.testTool } },
    // The colours of the pieces by what is left of them are told while the design is seen into: on the proving ground,
    // only while it is inspected (`trialOpened`).
    inspect: { hidden: shared, attr: { 'aria-pressed': inspecting } }, 'health-legend': visible(!shared && (trial !== 'terrain' || inspecting)),
    'construction-feedback': text(modulePreview?.reason || modulePreview?.feedback || admissionReason || blind),
    'new-module-settings': visible(tools === 'module' && !placement.plates?.length),
    // With the guns of a construction the block is the gun in hand and what is chosen of it: the catalogue, the round
    // and the distance are of the test of armour. There the block is its gun, named with its calibre, what it fires
    // and, for a round that strikes by its speed, from how far: the strike drawn says what it does, the panel nothing
    // of an aim, a reload nor a charge, which change nothing of it.
    'weapon-heading': visible(mounted), 'current-weapon-preview': visible(mounted), 'ballistic-info': visible(mounted),
    'catalog-test': visible(!mounted),
    'ammo-options': visible(!mounted),
    'impact-info': visible(mounted && !shared),
    'trial-targets-details': visible(!edit && view.trial === 'terrain'),
    'trial-targets-info': { text: tr('Alvos desde a partida: ') +
      TRIAL_TARGETS.filter(target => target.role === 'direct').map(target => distance(target.distance)).join(' · ') +
      tr('. Artilharia: ') + TRIAL_TARGETS.filter(target => target.role === 'artillery').map(target => distance(target.distance)).join(tr(' e ')) +
      tr('. O alcance depende da arma e da montagem.') },
    'mounted-weapon-field': visible(mounted && (!shared || c.weapons.length > 1)), 'linked-weapons-field': visible(mounted && !edit && c.weapons.length > 1),
    'mounted-weapon': list(c.weapons.length ? c.weapons.map((m, i) => [m.id, `${i + 1}. ${weaponName(m.weaponPreset || 'rh120')}` +
      (m.barrelDisabled ? tr(' · cano inutilizado') : m.health === 0 ? tr(' · inutilizada') : m.attached === false ? tr(' · solta do casco') : m.elevationDisabled ? tr(' · elevação travada') : '')]): [['', tr('Nenhuma arma instalada')]], gun?.id),
    'weapon-description': { hidden: false, text: weaponName(weapon.preset) },
    // In the test of armour the round chosen is the one lit among its buttons.
    'ammo-tag': { hidden: !mounted, text: tr(AMMO[weapon.ammo].short) },
    'propellant-charge-field': visible(mounted && weapon.variableCharge),
    'propellant-charge': list([['auto', tr('Automática')], ...weapon.charges.map(charge =>
      [String(charge.value), `${translate(charge.name)} · ${Math.round(chargeSpeed(weapon, charge.value))} m/s`] as const)], String(weapon.charge ?? 'auto'), autopilot),
    // A shell set to burst in the air bursts where a gun in hand aims; in the test of armour, where the line drawn ends
    // (armour-strike.ts). Struck first, it bursts on what it struck.
    'detonation-field': visible(weapon.ammo === 'he'),
    detonation: list([['impact', tr('Ao atingir')], ['airburst', tr('Explosão aérea ') + (mounted ? tr('no ponto de mira') : tr('no fim da linha'))]], weapon.detonation),
    'test-distance-field': visible(!mounted && KINETIC_AMMO.includes(weapon.ammo)), 'test-distance': { value: String(session.testDistance) },
    // A finger drives the vehicle in hand and fires its gun with the buttons over the field, for as long as it has one
    // that fires; the test of armour is struck by the finger itself.
    'touch-pad': visible(touch && c.manual && mounted && !inspecting),
    // While the gun reloads, the trigger fills back up: pressed then, it fires once the round is in.
    'touch-fire': { hidden: !fires, disabled: !c.manual || !armed || Boolean(obstruction) && !aligning || rounds <= 0,
      data: { state: loading ? 'reloading' : 'ready' }, style: { '--reload': loading.toFixed(3) } },
    // Only a gun of the construction tells its rounds: it is told over the field when it is in hand. One of a wreck fires no more.
    'weapon-runtime': { hidden: gunTold || !mounted, data: { state: wrecked || blocked || servo.disabled ? 'blocked' : aligning ? 'aligning' : 'ready' },
      text: wrecked ? tr('Fora de combate') : !armed ? gun?.barrelDisabled ? tr('Cano inutilizado') : tr('Arma inutilizada') : rounds <= 0 ? tr('Sem munição compatível') :
        servo.disabled ? tr('Elevação travada · ') + number(rounds, 0) + tr(' munições') :
          unreachable ? aimLimitText(aimSolution) : aligning ? tr`Apontando · faltam ${number(servo.errorDegrees, 1)}° · o tiro sai ao alinhar` : obstruction ? obstruction.reason :
            (fed?.waiting ? fed.text : reload > .05 ? 'Recarga · ' + number(reload) + ' s' : tr('Pronta')) + (heat >= BARREL_GLOW ? ' · ' + tr('Cano superaquecido') : heat >= barrelLimit(gun?.weaponPreset) ? ' · ' + tr('Cano quente') : '') +
            (fed && !fed.waiting ? ' · ' + fed.text : '') + ' · ' + number(rounds, 0) + tr(' munições') },
    // The field's side of the panel, block by block: each is there only when the situation has it.
    'network-connection': { hidden: !panel.connection || Boolean(connection), text: panel.connection },
    'invite-panel': visible(panel.faction?.invites.length), 'field-empty': visible(panel.empty), 'field-empty-text': text(panel.emptyText),
    'field-recovery': { hidden: !panel.recovery, text: panel.recovery }, 'recover-faction': { hidden: !panel.recover, text: panel.recover },
    'unit-panel': visible(panel.stats || panel.advice || panel.services.length || panel.held || panel.control),
    'unit-stats': visible(panel.stats), ...gauges(panel.stats),
    'stat-cargo-label': text(panel.stats?.cargo?.label ?? tr('Carga')),
    'unit-advice': { hidden: !panel.advice, text: panel.advice },
    // The services are a line of what there is to ask, and open on a click into their buttons.
    'unit-services': visible(panel.services.length), 'unit-offer': text(panel.services.map(work => work.text.split(' · ')[0]).join(' · ')),
    'unit-cancel': service('cancel'), 'unit-repair': service('repair'), 'unit-dump': service('dump'),
    'unit-held': { hidden: !panel.held, text: panel.held },
    'unit-control': visible(panel.control),
    'publish-industry': visible(edit && Boolean(industryReason(editor.source, faction, b))),
    'publish-new': { ...(quote?.spawn ?? { disabled: true }), attr: { 'aria-describedby': newRefusal ? 'publish-refused' : '' } },
    // What publishing asks of each stock, in red where the faction has less, and how long building takes.
    ...Object.fromEntries(STOCK_IDS.flatMap(id => { const cost = quote?.costs.find(c => c.id === id);
      return [['cost-' + id, { hidden: !cost, title: cost?.title ?? '', classes: { short: Boolean(cost?.short) } }], ['cost-' + id + '-n', text(cost?.text ?? '')]]; })),
    'cost-time': { hidden: !quote, title: quote?.time ?? '' }, 'cost-time-n': text(quote ? quote.seconds + ' s' : ''),
    'publish-models': visible(quote?.unpaid),
    'publish-refused': { hidden: !newRefusal, text: newRefusal },
    'publish-replace': quote?.replace ? { hidden: false, ...quote.replace } : { hidden: true },
    'replace-reason': { hidden: !separateReplacementRefusal, text: separateReplacementRefusal ? replacementRefusal : '' },
    // The page of the faction: where it stands among the nations of the field by its wealth, over the roll of them all;
    // its members, whoever it may invite, and leaving it while another member keeps it.
    'faction-place': text(standing ? standing.place + 'º' : ''),
    'faction-wealth': { text: standing?.points ?? '', title: standing?.title ?? '' },
    'faction-of': text(standing ? tr`entre ${standing.of} ${standing.of === 1 ? tr('nação') : tr('nações')} no campo` : ''),
    'member-count': text(panel.faction?.members.length ?? ''),
    'request-section': visible(panel.faction?.requests.length), 'request-count': text(panel.faction?.requests.length ?? ''),
    'invitable-section': visible(panel.faction?.invitable.length), 'invitable-count': text(panel.faction?.invitable.length ?? ''),
    'leave-faction': visible(panel.faction?.leave),
    // Over the field: the four stocks, what waits in the yard while there is some, and how many vehicles and structures the
    // faction has, each against its limit.
    'faction-hud': visible(faction && (!edit || capture)), ...Object.fromEntries(stockFigures(faction?.stock ?? bill()).map(figure => ['stock-' + figure.id,
      text(edit ? figure.text : compactStock(faction?.stock?.[figure.id]) + (figure.id === 'combustivel' ? ' L' : ''))])),
    'faction-yard': { hidden: !yardText(faction), text: yardText(faction) },
    'faction-vehicles': { text: tr`Veículos ${faction?.counts.vehicles ?? 0}/${CONSTRUCTION_LIMITS.vehicles}`,
      attr: { 'aria-label': tr`Veículos ${faction?.counts.vehicles ?? 0} de ${CONSTRUCTION_LIMITS.vehicles}.` } },
    'faction-structures': { text: tr`Estruturas ${faction?.counts.fixed ?? 0}/${CONSTRUCTION_LIMITS.fixed}`,
      attr: { 'aria-label': tr`Estruturas ${faction?.counts.fixed ?? 0} de ${CONSTRUCTION_LIMITS.fixed}, incluindo obras em andamento.` } },
    // While its guns wait for its rounds in the air to come down, the faction is told so under them.
    'faction-shots': visible(shotsHeld),
    'faction-duel': { hidden: !duel, data: { ended: faction?.duel?.phase !== 'playing' } },
    'duel-text': text(duel?.text ?? ''), 'duel-hint': text(duel?.hint ?? ''),
    // Under them, while a base is being taken — the faction's own, or one it takes —, how that goes, over a bar of how far it went.
    'faction-capture': { hidden: !capture, data: { own: Boolean(capture?.own) } }, 'capture-text': text(capture?.text ?? ''),
    'capture-hint': { hidden: !capture?.hint, text: capture?.hint ?? '' }, 'capture-bar': { attr: { style: `--fill: ${Math.round((capture?.share ?? 0) * 100)}%` } },
    'sound-toggle': { attr: { 'aria-pressed': sound.enabled } }, 'sound-toggle-text': text(sound.enabled ? tr('Som') : tr('Silenciado')),
    exterior: { hidden: !edit, attr: { 'aria-pressed': Boolean(view.exterior), title: view.exterior ? tr('Ver por dentro: o que está dentro da carroceria · F') : tr('Ver por fora: a carroceria cobre o que está dentro · F') } },
    symmetric: { hidden: !edit, attr: { 'aria-pressed': Boolean(editor.symmetric) } },
    'snap-grid': { hidden: !edit, attr: { 'aria-pressed': Boolean(editor.snap),
      'aria-label': tr('Grade de 5 cm'),
      title: tr('Ligar ou desligar a grade de 5 cm. O apoio em chapas próximas funciona nos dois modos; medidas digitadas mantêm a precisão.') } },
    'add-plate': { attr: { 'aria-pressed': tools === 'plate' } },
    'music-toggle': { attr: { 'aria-pressed': sound.musicOn } }, 'music-toggle-text': text(sound.musicOn ? tr('Música') : tr('Sem música')),
    'background-alerts-toggle': { attr: { 'aria-pressed': Boolean(sound.backgroundAlerts) } },
    'background-alerts-state': text(sound.backgroundAlerts ? tr('Ligados') : tr('Desligados')),
    'sound-volume': { value: Math.round(sound.volume * 100) },
    'sound-status': text(sound.unavailable ? tr('Áudio indisponível') : !sound.enabled ? tr('Sem som') : sound.context?.state === 'running' ? Math.round(sound.volume * 100) + '%' : touch ? tr('Toque para ativar') : tr('Clique para ativar')),
    'component-placement-cost': text(edit && tools === 'module' && modulePreview && !modulePreview.refused
      ? formatCredits([...modulePreview.modules, ...(modulePreview.plates || [])].reduce((total, piece) => total + pieceCost(piece), 0)) : ''),
    'new-weapon-field': visible(placement.kind === 'weapon'),
    'new-ammo-assist': visible(placement.kind === 'ammo' || copyCalibres.length > 0),
    'new-ammo-summary': text(copyCalibres.length ? tr('Munição das cópias: ') + copyCalibres.join(' · ') + '.' : tr('Confira o calibre escolhido. A caixa começa cheia.')),
    'new-ammo-field': visible(placement.kind === 'ammo'), 'new-sensor-field': visible(placement.kind === 'sensor'),
  };
  for (const field of PLACEMENT_FIELDS) if (field.key) bindings[field.id] = { value: placement[field.key] };
  bindings['new-ammo-preset']!.options = ammoOptions;
  // What is being installed titles the inspector while it is: a weapon by its model, a piece by its kind.
  const copies = (placement.copies?.length || 0) + (placement.plates?.length || 0),
    placedKind = tools === 'module' ? placement.kind : tools,
    partLabel = placedKind in MODULES ? Object.entries(MODULES).find(([id]) => id === placedKind)?.[1].name : undefined,
    placementTitle = tr('Instalar ') + (copies ? copies + (copies === 1 ? tr(' cópia') : tr(' cópias')) :
    tools === 'module' && placement.kind === 'weapon' ? weaponName(placement.weaponPreset ?? 'rh120') :
      PLACED[placedKind] ?? (partLabel ? translate(partLabel).toLowerCase() : tr('componente')));
  // The design is driven with the keys and the buttons over the field, but in a test of armour, where it stands still. Over
  // the field, what each stock of the faction keeps waiting or does not cover.
  return { ...c, manufactureIssues: edit ? editor.manufactureIssues : [], bindings, panel, fires, gunTold, inspection, wreck, driven: view.trial !== 'armour', flies: !edit && flies(c.actor), figures, dockSpeed, inspecting, placementTitle, touch, terrain,
    wants: faction && !edit ? stockWants(faction, fabrication?.factionId === faction.id ? fabrication : null) : {},
    terrainSettings: (!edit || shared) && state?.terrainSettings || {},
    weather: !edit || shared ? state?.weather || 'clear' : 'clear',
    ammoButtons: (Object.keys(AMMO).filter((id): id is AmmoId => Object.hasOwn(AMMO, id))).map(id => ({ id, active: weapon.ammo === id, disabled: !allowedAmmo(weapon.preset).includes(id) })),
    // One switch a gun: the one in hand always fires, the others fire with it while switched on.
    weaponButtons: mounted && !edit ? c.weapons.map((m, i) => {
      const lead = m.id === gun?.id, linked = !lead && Boolean(view.linked?.has(pieceKey(m.id))), preset = m.weaponPreset || 'rh120';
      return { id: m.id, label: `${i + 1} · ${weaponName(preset)}`, lead, linked, out: !working(m),
        status: !working(m) ? 'inutilizada' : supply(preset) <= 0 ? tr('sem munição') : (m.barrelTemperature ?? 0) >= BARREL_GLOW ? tr('cano superaquecido') : (m.barrelTemperature ?? 0) >= barrelLimit(preset) ? tr('cano quente') :
          gunFeed(m, preset)?.status || ((m.reload ?? 0) > .25 ? 'recarga ' + number(m.reload ?? 0) + ' s' : lead ? tr('em uso') : linked ? 'ligada' : 'desligada') };
    }) : [] };
}

export type UiModel = ReturnType<typeof screenModel>;
export type WorkshopSelection = ReturnType<typeof partViews>[number];

export type ControlArmament = ResolvedArmament & { also?: ReturnType<typeof linkedArmament> };
