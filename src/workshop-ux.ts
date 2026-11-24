import type { PartDefinition } from './part-view.ts';
import type { PlateDefinition } from './mesh.ts';
import type { RoomHandle } from './editor.ts';
import type { RoomWall } from './frame-editing.ts';
import type { ConstructionKind } from './chassis-editing.ts';
import type { Editor, EditorPlateHit, EditorEdgeHit, EditorPointHit, EditorGear, EditorGearHit } from './editor.ts';
import type { Renderer } from './render.ts';
import type { UiView, UiModel } from './ui-model.ts';
import type { WorkshopTask } from './workshop-screen.ts';
import type { Point } from './math.ts';
import type { AuthoredConstruction, AuthoredComponent, AuthoredChassis, CompiledConstruction, CompiledPiece, CompiledPlate, CompiledModule, CompiledWeapon } from './construction-contract.ts';
import type { WeaponPresetId, WeaponFamilyId, AmmoId, WeaponId, CoreId } from './weapons.ts';
import type { MaterialId, MetalId } from './materials.ts';
import type { WeaponMountId } from './weapon-mounts.ts';
import type { SensorMode } from './combat-sensors.ts';
import type { ChassisMetalId } from './chassis.ts';
import type { NumericSetting, NumericSettingKey, SharedSetting, SettingChoice, SettingsEntry, WeaponSettingKey } from './piece-settings.ts';
import type { CanvasGesture } from './canvas-controls.ts';
import type { Camera, FramedCamera } from './camera.ts';

type Toast = (message: string, warning?: boolean) => void;
type PointerPosition = Pick<PointerEvent, 'clientX' | 'clientY'>;
interface WorkshopOptions { editor: Editor; renderer: Renderer; view: UiView; toast?: Toast; refresh?: () => void; openTask: (task: WorkshopTask) => void; selectTool?: () => void; project?: () => void; aim?: { active(): boolean; at(point: Point): void } | null; gesture?: () => CanvasGesture | null }
interface WeaponChoiceOptions { editor: Editor; view: UiView; renderer: Renderer; openTask: (task: WorkshopTask) => void; arsenal: HTMLElement; arsenalDialog: HTMLDialogElement; testArsenal: HTMLElement; refresh(): void; toast: Toast }
interface FrameGrowing { edge: RoomHandle | null; along: EditorEdgeHit | null; spot: EditorPointHit | null; from: Point; x: number; y: number; pointerId: number; plates: number; moved: boolean; way: 'plate' | 'along' | 'room' | null; u: number | null; drawn: ReturnType<Editor['drawRoom']>; laid: ReturnType<Editor['drawPlate']>; settled: boolean }
interface FrameGrowthState { dragging: boolean; pointer: PointerPosition | null; shaping: boolean | null; growing: FrameGrowing | null; offer: Point[] | null }
interface FrameGrowthEffects { editing(): boolean; alongAt(event: PointerPosition): EditorEdgeHit | null; worldAt(event: PointerPosition): Point; outlineAt(event: PointerPosition): EditorPlateHit | RoomHandle | null; attempt<T>(action: () => T): T | undefined; closeMenus(): void; offered(edge: RoomWall | null, at: PointerPosition): Point[] | null; paintOffer(): void; offerGrowth(held: boolean): void; refresh(): void; showAt(element: HTMLElement, x: number, y: number, gap?: number): void; metres(value: number): string; toast: Toast; readout: HTMLOutputElement }
interface FrameGrowthOptions { canvas: HTMLCanvasElement; editor: Editor; view: UiView; renderer: Renderer; state: FrameGrowthState; effects: FrameGrowthEffects; document?: Document; window?: Window }

import { tr } from './i18n.ts';
import { wrapAngle, clamp } from './math.ts';
import { WEAPON_PRESETS, isWeaponPresetId, WEAPON_FAMILIES, AMMO, CORES, KINETIC_AMMO, allowedAmmo, coreOf, fedAmmo, weaponOf, weaponOptions, cartridgeId, isCartridgeId } from './weapons.ts';
import { HOUSED, isMaterialId, MATERIALS, METALS, STEEL_PAINT, choosesMetal, metalOf, takesMetal } from './materials.ts';
import { metalColor } from './component-art.ts';
import { STOCKS } from './economy.ts';
import { pieceMass } from './mass-properties.ts';
import { WEAPON_MOUNTS } from './weapon-mounts.ts';
import { turnMagnets, turnStep, turnedHeading, turnPiece, turnsFree } from './turn-handle.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { sightText } from './sight-art.ts';
import { node, icon } from './dom-view.ts';
import { count, hex, volume, litres, number, power, thrust } from './format.ts';
import { reach, touching, clearOf, capture } from './touch.ts';
import { reserveState, cargoRoom } from './component-volume.ts';
import { carriesRoom, coincidentNodes, drawRoom, roomSpan } from './frame-editing.ts';
import { pointOf, selectedPoints } from './frame-points.ts';
import { alongEdge, snapAlong, headingAt } from './edge-plates.ts';
import { metresOf } from './grid.ts';
import { CHASSIS_ID, FIXED, chassisTopPlate, constructionKind } from './chassis-editing.ts';
import { chassisLabel, chassisName, chassisSkids, chassisTrack, isChassisMetalId } from './chassis.ts';
import { pieceSettings, typedSetting, selectionSettings, steppedSettings, typedSettings, applySettings, isWeaponSetting, madeOver, pieceFigures, gunFigures, selectionFigures, chassisFigures, enginePower, kindChoices, chassisMetalChoices, topPlateChoices, sensorChoices, mountChoices, ammoChoices, coreChoices, materialChoices, metalChoices, steelWorth, weight, ammunitionBoxChoice } from './piece-settings.ts';
import { structuredComponent } from './structured-editing.ts';
import { workshopActions } from './workshop-actions.ts';
import { groupSelectionHit, everyPiece, projectParts } from './workshop-selection.ts';
import { workshopContext } from './workshop-context.ts';
import { ammunitionFeed } from './workshop-checklist.ts';
import { cancels, partKeys } from './workshop-keys.ts';
import { WorkshopGuides } from './workshop-guides.ts';
import { weaponName } from './weapon-names.ts';

// Convenience layer over the workshop. It owns no game state: every action
// goes through the Editor or presses a control that already exists, and every
// reading comes from the same ScreenModel that paints the sidebar.
const ICONS = {
  engine: '<rect x="4" y="9" width="13" height="9" rx="1.5"/><path d="M7 9V6h7v3M17 12h3v4h-3M2 13h2M9 6V4m3 2V4"/>',
  fuel: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>',
  ammo: '<path d="M7 21V11c0-3 1.5-5.5 2-7 .5 1.5 2 4 2 7v10zM7 17h4M14 21v-7c0-2 1-3.8 1.5-5 .5 1.2 1.5 3 1.5 5v7zM14 18h3"/>',
  command: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="m7 12 2.5-3 2.5 4 2-2.5 3 1.5M9 21h6m-3-4v4"/>',
  sensor: '<circle cx="12" cy="12" r="2.5"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8m12.8-12.8a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7m7-7a5 5 0 0 1 0 7"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>', vertex: '<path d="M4 18 12 6l8 12"/><circle cx="12" cy="6" r="2.2"/>',
  join: '<path d="m3 5 7.3 5.8M21 5l-7.3 5.8M12 21v-6.8"/><circle cx="12" cy="12" r="2.4"/>',
  hopper: '<path d="M3 7h18l-3 11H6zM3 7l-1-2m19 2 1-2M8 12h8"/>',
  thruster: '<path d="M8 2h8v10l2 3H6l2-3zM8 6h8M8 9h8M10 18l2 4 2-4"/>',
  excavator: '<path d="M3 19h8M6 19v-5l5-7 5 3 3 7M11 7l1-3 6 4 2 8M17 16h5l-1 4h-5z"/>',
  drill: '<path d="M5 21h14M8 21V4h8v17M8 5l8 5-8 5 8 5M12 2v19m-2-3 4 2m-4-6 4 2"/>',
  builder: '<path d="M3 20h18M5 20v-5l6-8 6 4 3 7M11 7l1-4 7 6 2 9M3 20v-5h5v5m5 0v-5h5v5"/>',
  blade: '<path d="M2 20h20M4 18c2-2.5 4-3.5 8-3.5s6 1 8 3.5M6 14.5 9 8h6l3 6.5M3 8h18M12 8V4"/>',
  paver: '<path d="M2 20h20M3 17h11v-4H8L5 8H2M14 17h6l1-4h-7M6 13h8M17 13V9"/>',
  cistern: '<rect x="3" y="8" width="18" height="9" rx="4.5"/><path d="M10 8V5h4v3M7 17v2m10-2v2"/>',
  supply: '<rect x="2.5" y="10" width="9" height="9" rx="1"/><path d="m2.5 10 9 9m0-9-9 9"/><path d="M14 9.5h6.5V19H14zM15.5 9.5V7h3.5v2.5M14 13h6.5"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>', gun: '<path d="M2 9h14v5h-5l-1.5 4H6l1-4H2zM16 10.5h6v2h-6"/>',
  chassis: '<path d="M2 8.5h20v3.5H2zM5 12v1.5M19 12v1.5"/><circle cx="6.5" cy="16.5" r="3"/><circle cx="17.5" cy="16.5" r="3"/>',
  tracks: '<path d="M2 7h20v4H2z"/><rect x="2" y="13" width="20" height="7" rx="3.5"/><circle cx="7" cy="16.5" r="1.5"/><circle cx="12" cy="16.5" r="1.5"/><circle cx="17" cy="16.5" r="1.5"/>',
  fixed: '<path d="M2 20h20M4 20v-6a8 7 0 0 1 16 0v6M8 13.5h8M3 20l2-3m14 3 2-3"/>',
};
// One round per weapon family, drawn nose to the right, and the families from the lightest to the heaviest.
const ROUNDS: Record<WeaponFamilyId, string> = {
  machinegun: '<path d="M3 9.5h9l2 1.2h1.5c2.5 0 4.5.8 5.5 1.3-1 .5-3 1.3-5.5 1.3H14l-2 1.2H3zM5 9.5v5"/>',
  grenade: '<path d="M6 7.5h6.5a4.5 4.5 0 0 1 0 9H6zM9 7.5v9M12 7.5v9"/>',
  autocannon: '<path d="M2.5 8h9l2 1.5h3c2 0 4 1.5 5 2.5-1 1-3 2.5-5 2.5h-3l-2 1.5h-9zM5 8v8M13.5 9.5v5"/>',
  rocket: '<path d="M6.5 9.5H16l5 2.5-5 2.5H6.5zM6.5 9.5 3 6.5v11l3.5-3M10 9.5v5"/>',
  mortar: '<path d="M21 12c-1.5-3-4-4.2-6.5-4.2s-4.5 1.7-5 4.2c.5 2.5 2.5 4.2 5 4.2s5-1.2 6.5-4.2zM9.5 12h-3M3 9h3.5v6H3zM3 12h3.5"/>',
  cannon: '<path d="M2 12h7M15 12h7M19.5 10.3 22 12l-2.5 1.7M2 8.5 5.5 12 2 15.5M9 8.5h6v7H9z"/>',
  howitzer: '<path d="M3.5 8.5 5 7.5h7c4.5 0 7.5 2.5 9 4.5-1.5 2-4.5 4.5-9 4.5H5l-1.5-1zM7.5 7.5v9M9.5 7.5v9"/>',
};
const htmlChildren = (element: Element): HTMLElement[] => [...element.children].filter((child): child is HTMLElement => 'hidden' in child && 'dataset' in child);
const isConstructionKind = (kind: unknown): kind is ConstructionKind => kind === 'wheeled' || kind === 'tracked' || kind === 'aircraft' || kind === 'fixed';
const isMetalId = (id: unknown): id is MetalId => typeof id === 'string' && Object.hasOwn(METALS, id);
const isSensorMode = (id: unknown): id is SensorMode => id === 'visual' || id === 'radar' || id === 'sound';
const isMountId = (id: unknown): id is WeaponMountId => typeof id === 'string' && Object.hasOwn(WEAPON_MOUNTS, id);
const isAmmoId = (id: unknown): id is AmmoId => typeof id === 'string' && Object.hasOwn(AMMO, id);
const isCoreId = (id: unknown): id is CoreId => typeof id === 'string' && Object.hasOwn(CORES, id);
const numericKey = (key: unknown): key is NumericSettingKey => typeof key === 'string' && STEPPERS.some(own => own === key);
const iconPath = (key: string | undefined): string => Object.entries(ICONS).find(([id]) => id === key)?.[1] ?? '';
const svg = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const press = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
const DEG = Math.PI / 180;
const degrees = (angle: number) => (angle > 0 ? '+' : angle < 0 ? '−' : '') + number(Math.abs(angle / DEG), 2) + '°';
// The tone a material is shown by: that of its plates, or, of one no plate is made of, that of a piece of it.
const tone = (id: MaterialId | MetalId) => hex(isMaterialId(id) ? MATERIALS[id].color : metalColor(STEEL_PAINT, METALS[id].look));
// The round handle that turns a piece other than a gun stands TURN_CLEAR pixels off its side, at the first of these
// levers round from its heading that is in view: above it, below, behind, before.
const TURN_CLEAR = 24, TURN_LEVERS = [Math.PI / 2, -Math.PI / 2, Math.PI, 0] as const;
// The steppers of the bar, in the order they stand on it.
const STEPPERS = ['thicknessMm', 'sizeScale', 'length', 'barrelLength', 'calibre', 'barrels', 'rate', 'charge', 'projectile', 'cone', 'standoff', 'fill', 'magazine', 'angle', 'axleCount',
  'frameThicknessMm', 'gearScale', 'trackLength', 'trackHeight', 'trackX', 'suspension', 'armorMm', 'topPlateThicknessMm'] as const;
const STEP_ICONS: Record<NumericSettingKey, string> = {
  thicknessMm: '<path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4"/>',
  topPlateThicknessMm: '<path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4"/>',
  sizeScale: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6M3 3l6 6m6 6 6 6"/>',
  angle: '<path d="M4 19h16M4 19 18 5M10 19a6 6 0 0 0-1.8-4.2"/>',
  length: '<path d="M3 12h18M3 8v8M21 8v8M7 9l-3 3 3 3M17 9l3 3-3 3"/>',
  axleCount: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6m0 6v6M3 12h6m6 0h6"/>',
  frameThicknessMm: '<path d="M3 5h18M3 19h18M7 5v14M17 5v14M7 12h10"/>',
  gearScale: '<circle cx="12" cy="12" r="8"/><path d="m6 6 12 12M7 5H5v2m12 12h2v-2"/>',
  suspension: '<path d="M4 3h16M4 21h16M12 3v2.5l-5 1.5 10 3-10 3 10 3-5 1.5V21"/>',
  trackLength: '<path d="M3 12h18M3 8v8M21 8v8M7 9l-3 3 3 3M17 9l3 3-3 3"/>',
  trackHeight: '<path d="M12 3v18M8 3h8M8 21h8M9 7l3-3 3 3M9 17l3 3 3-3"/>',
  trackX: '<path d="M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3"/><circle cx="12" cy="12" r="3"/>',
  armorMm: '<path d="M12 3 4.5 6v5.5c0 4.3 3 7.6 7.5 9.5 4.5-1.9 7.5-5.2 7.5-9.5V6z"/>',
  barrelLength: '<path d="M2 10h14v4H2zM16 11h6v2h-6M5 8v8"/>',
  calibre: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  charge: '<path d="M8 21h8M9 21V9l3-6 3 6v12M9 13h6"/>',
  barrels: '<circle cx="12" cy="6" r="2.5"/><circle cx="6.5" cy="15" r="2.5"/><circle cx="17.5" cy="15" r="2.5"/><circle cx="12" cy="12" r="9"/>',
  projectile: '<path d="M3 9h10c3.5 0 6.5 1.5 8 3-1.5 1.5-4.5 3-8 3H3zM7 9v6"/>',
  cone: '<path d="M4 6v12M4 6l12 6-12 6M16 12h5"/>',
  standoff: '<path d="M3 8v8M3 12h9M9 9l3 3-3 3M15 5v14M19 5v14"/>',
  fill: '<rect x="6" y="3" width="12" height="18" rx="5"/><path d="M9 11h6v6H9z"/>',
  rate: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5 15.5 10M10 3h4M12 3v3"/>',
  magazine: '<rect x="7" y="3" width="10" height="18" rx="1.5"/><path d="M10 7.5h4M10 11.5h4M10 15.5h4"/>',
};

// The same offered room as Shift+drag, kept at its starting depth. A selected
// outer plate gives a finger a precise way to create it without aiming a pull.
export function createCompartmentFromPlate(editor: Editor, plateId: string | null) {
  editor.commit();
  const edge = editor.plateSpans().find(span => span.id === plateId);
  if (!carriesRoom(edge)) return null;
  editor.begin();
  try {
    const middle = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 },
      drawn = editor.drawRoom(edge, middle, null), committed = editor.commit();
    if (!drawn || !committed) return null;
    editor.select(drawn.plates[1]);
    return drawn;
  } catch (error) { editor.cancel(); throw error; }
}


// Arsenal intent belongs to the dialogue and the document it was opened for.
export function createWeaponChoice({ editor, view, renderer, openTask, arsenal, arsenalDialog, testArsenal, refresh, toast }: WeaponChoiceOptions) {
  let weaponChoice: { kind: 'replace' | 'mount'; id: string; documentKey: string } | null = null;
  const authored = (id: string | null | undefined) => editor.source.components.find(part => part.id === id), editing = () => view.mode === 'edit';
  // The open dialogue keeps its target tied to this document.
  function clearWeaponChoice() {
    weaponChoice = null;
    delete arsenalDialog.dataset.swap; delete arsenalDialog.dataset.mount; delete arsenalDialog.dataset.currentPreset;
  }
  function weaponChoiceTarget() {
    const current = weaponChoice;
    if (!current || current.documentKey !== editor.documentKey) return null;
    return current.kind === 'replace' ? authored(current.id)?.kind === 'weapon' && authored(current.id)
      : editor.plateSpans().find(plate => plate.id === current.id);
  }
  function beginWeaponChoice(kind: 'replace' | 'mount', id: string) {
    clearWeaponChoice();
    weaponChoice = { kind, id, documentKey: editor.documentKey };
    if (kind === 'replace') {
      const preset = authored(id)?.weaponPreset;
      arsenalDialog.dataset.swap = 'true'; arsenalDialog.dataset.currentPreset = preset;
      arsenalDialog.dataset.family = preset ? weaponOf(preset)?.family ?? '' : '';
    } else arsenalDialog.dataset.mount = 'true';
    arsenal.click();
  }
  for (const button of [arsenal, testArsenal])
    button.addEventListener('click', () => { if (weaponChoice && !weaponChoiceTarget()) clearWeaponChoice(); }, true);

  arsenalDialog.addEventListener('close', clearWeaponChoice);
  // A plate is a convenient way to open the arsenal: the weapon starts out square to it, and the cursor owns its pose.
  function placeWeapon(preset: WeaponPresetId, plateId: string) {
    const name = tr(WEAPON_PRESETS[preset]?.name);
    if (!name) throw new Error(tr('Arma desconhecida.'));
    editor.commit();
    const edge = editor.plateSpans().find(span => span.id === plateId),
      normal = edge?.normal || edge && { x: edge.b.y - edge.a.y, y: edge.a.x - edge.b.x };
    view.placement = { kind: 'weapon', weaponPreset: preset, angle: normal ? Math.atan2(normal.y, normal.x) : Math.PI };
    view.buildTool = 'module'; renderer.modulePreview = null;
    openTask('build'); toast('Posicione ' + name + '.');
    return true;
  }

  function replaceWeapon(preset: WeaponPresetId) {
      if (!weaponChoice) return false;
      if (!weaponChoiceTarget()) {
        clearWeaponChoice(); refresh();
        throw new Error(tr('A peça escolhida não está mais neste projeto. Selecione a peça novamente.'));
      }
      if (!editing()) throw new Error(tr('Volte à Oficina para aplicar esta arma ao projeto.'));
      const { kind, id } = weaponChoice;
      try {
        if (kind === 'mount') placeWeapon(preset, id);
        else {
          // The boxes that fed only the gun replaced take its calibre (editor.ts `editProperty`): it is said, and so is a gun
          // left with no round of its calibre aboard.
          const before = new Map(editor.source.components.map(part => [part.id, part.ammoPreset]));
          editor.commit(); editor.select(id); editor.editProperty('weaponPreset', preset, true);
          const moved = editor.source.components.filter(part => part.kind === 'ammo' && part.ammoPreset !== before.get(part.id)).length,
            unfed = ammunitionFeed(editor.blueprint.modules).unfed.some(gun => gun.id === id);
          toast(tr('Arma trocada por ') + tr(WEAPON_PRESETS[preset].name) + (moved ? tr` · ${moved === 1 ? tr('a caixa de munição passou') : tr`${moved} caixas de munição passaram`} para o calibre dela` +
            (unfed ? tr`, mas não cabe um tiro: ${moved === 1 ? 'aumente-a' : 'aumente-as'}.` : '.') : unfed ? tr(' · falta munição do calibre dela.') : '.'));
        }
      } catch (error) {
        editor.rejectEdit(error); refresh();
        throw new Error(editor.blockedEdit!.message, { cause: error });
      }
      clearWeaponChoice(); refresh();
      return true;
    }

  return { beginWeaponChoice, clearWeaponChoice, replaceWeapon };
}

// What a gun of a design with no box of its rounds aboard is offered (workshop-checklist.ts `ammunitionFeed`): of the boxes
// no gun takes, the one that would hold the most of its rounds (`ammunitionBoxChoice`), to be put to them; with none that
// holds one, a new box of them. None for a gun that is fed.
export function boxOffer(blueprint: Pick<CompiledConstruction, 'modules'>, gunId: string) {
  const { unfed, idle } = ammunitionFeed(blueprint.modules), gun = unfed.find(module => module.id === gunId);
  if (gun?.kind !== 'weapon') return null;
  const cartridge = cartridgeId(gun.weaponPreset), ammo = fedAmmo(gun),
    [best] = idle.map(box => ({ box, ...ammunitionBoxChoice(box, cartridge, ammo) })).filter(choice => choice.fits).sort((a, b) => b.rounds - a.rounds);
  return { cartridge, box: best?.box ?? null, rounds: best?.rounds ?? 0 };
}

const precision = (setting: Pick<NumericSetting, 'key'>) => setting.key.startsWith('track') ? 3 : setting.key === 'length' ? 3 : ['angle', 'barrelLength'].includes(setting.key) ? 2 : ['frameThicknessMm', 'suspension', 'calibre', 'standoff'].includes(setting.key) ? 1 : 0;
export const shown = (setting: Pick<SharedSetting, 'key' | 'value'>) => setting.value === null ? '' : String(Number(setting.value.toFixed(precision(setting))));

export function createPlacementControls({ editor, view, refresh, document = globalThis.document }: { editor: Editor; view: UiView; refresh(): void; document?: Document }) {
  const editing = () => view.mode === 'edit';
  const placementControls = node('div', 'placement-shape'), placementInputs = new Map<'sizeScale' | 'angle', { label: HTMLLabelElement; caption: HTMLSpanElement; input: HTMLInputElement }>();
  placementControls.hidden = true;
  const placementMount = node('label', 'field-label'), placementMountName = node('span', '', tr('Montagem')), placementMountChoice = node('select');
  placementMountChoice.id = 'placement-mount-preset'; placementMount.htmlFor = placementMountChoice.id;
  placementMount.append(placementMountName, placementMountChoice); placementControls.append(placementMount);
  for (const key of ['sizeScale', 'angle'] as const) {
    const label = node('label', 'field-label'), caption = node('span'), input = node('input');
    input.id = 'placement-' + key; input.type = 'number'; input.inputMode = 'decimal'; input.dataset.placementSetting = key;
    label.htmlFor = input.id; label.append(caption, input); placementControls.append(label);
    placementInputs.set(key, { label, caption, input });
  }
  document.querySelector<HTMLElement>('#component-placement-cost')!.before(placementControls);
  const placementProperties = () => editing() && view.buildTool === 'module' && !view.placement.copies && !view.placement.plates
    ? pieceSettings(null, structuredComponent(view.placement.kind, view.placement, 'placement-intent'), { snap: editor.snap }) : [];
  const isPlacementControl = (target: EventTarget | null): target is HTMLInputElement | HTMLSelectElement =>
    target !== null && 'tagName' in target && (target.tagName === 'INPUT' || target.tagName === 'SELECT') &&
    'value' in target && typeof target.value === 'string' && 'dataset' in target;
  placementControls.addEventListener('change', event => {
    const target = event.target;
    if (!isPlacementControl(target)) return;
    if (target === placementMountChoice) {
      if (target.value === '') delete view.placement.mountPreset;
      else { const choice = mountChoices(view.placement.weaponPreset).find(choice => choice.id === target.value); if (choice) view.placement.mountPreset = choice.id; }
      refresh(); return;
    }
    const setting = placementProperties().find(setting => setting.key === target.dataset.placementSetting);
    if (!setting) return;
    const value = typedSetting(setting, target.value);
    if (Number.isFinite(value) && (setting.key === 'sizeScale' || setting.key === 'angle')) view.placement[setting.key] = value / setting.per;
    target.value = shown({ ...setting, value: Number.isFinite(value) ? value : setting.value });
    refresh();
  });
  placementControls.addEventListener('keydown', event => {
    const target = event.target;
    if (!isPlacementControl(target)) return;
    if (!target.matches('input') || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') {
      const setting = placementProperties().find(setting => setting.key === target.dataset.placementSetting);
      if (setting) target.value = shown(setting);
    }
    target.blur();
  });
  function describePlacementSettings() {
    const settings = placementProperties(); placementControls.hidden = !settings.length;
    const weapon = editing() && view.buildTool === 'module' && view.placement.kind === 'weapon' && !view.placement.copies && !view.placement.plates;
    placementMount.hidden = !weapon;
    if (weapon) {
      const choices = mountChoices(view.placement.weaponPreset), key = choices.map(choice => choice.id).join(':');
      if (placementMountChoice.dataset.choices !== key) {
        placementMountChoice.dataset.choices = key;
        const automatic=node('option','',tr('Automática · parede ou teto')); automatic.value='';
        placementMountChoice.replaceChildren(automatic,...choices.map(choice => {
          const mount = WEAPON_MOUNTS[choice.id], option = node('option', '', choice.name + (('exposed' in mount && mount.exposed) ? tr(' · externa') : ''));
          option.value = choice.id; return option;
        }));
      }
      const chosen = view.placement.mountPreset;
      placementMountChoice.value = chosen && choices.some(choice => choice.id === chosen) ? chosen : '';
    }
    for (const [key, { label, caption, input }] of placementInputs) {
      const setting = settings.find(setting => setting.key === key); label.hidden = !setting;
      if (!setting) continue;
      caption.textContent = `${setting.label}${setting.unit ? ` (${setting.unit})` : ''}`;
      input.min = String(setting.min); input.max = String(setting.max); input.step = String(setting.fine);
      if (document.activeElement !== input) input.value = shown(setting);
    }
  }

  return describePlacementSettings;
}

export function installPaletteKeys({ viewport, sidebar, canvas, editing, palette, chooseChassis, press, view, joinPoints, document = globalThis.document }: { viewport: HTMLElement; sidebar: HTMLElement; canvas: HTMLCanvasElement; editing(): boolean; palette: HTMLElement; chooseChassis(): void; press(selector: string): void; view: UiView; joinPoints(): void; document?: Document }) {
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if ([...document.querySelectorAll<HTMLDialogElement>('dialog')].some(dialog => dialog.open)) return;
    // With Adicionar open over the workshop, its number keys still install: the tiles shown are those of its category.
    // Nothing else is heard through an open panel.
    const adding = editing() && !sidebar.hidden && sidebar.dataset.workshopTask === 'build';
    if (viewport.inert && !adding) return;
    const idle = !viewport.inert && (event.target === document.body || event.target === canvas);
    if (event.key === 'Enter' && idle) { event.preventDefault(); press(editing() ? '#go-field' : '#go-workshop'); return; }
    const target = event.target;
    if (!editing() || target && 'matches' in target && typeof target.matches === 'function' && target.matches('input,select,textarea,[contenteditable=true]')) return;
    // A number takes the part of that number in the category open in Adicionar, or last open there.
    const tile = /^[1-9]$/.test(event.key) && htmlChildren(palette).filter(tile => !tile.hidden)[Number(event.key) - 1];
    if (tile) { event.preventDefault(); tile.click(); }
    if (event.key.toLowerCase() === 'r' && !event.shiftKey && !viewport.inert) { event.preventDefault(); chooseChassis(); }
    if (event.key.toLowerCase() === 'j' && !event.shiftKey && !viewport.inert && view.buildTool === 'select') { event.preventDefault(); joinPoints(); }
  });

}

// The capture handlers and the visual offer share one gesture state.
export function installFrameGrowth({ canvas, editor, view, renderer, state: frameGesture, effects, document = globalThis.document, window = globalThis.window }: FrameGrowthOptions) {
  const { editing, alongAt, worldAt, outlineAt, attempt, closeMenus, offered, paintOffer, offerGrowth, refresh, showAt, metres, toast } = effects;
  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    // From a point of the frame no room is pulled: an end of plates draws a plate from it, a point of the chassis lays
    // plates along it; let go where it was pressed, either is added to the selection or taken from it.
    const spot = editing() && renderer.ready ? editor.pickPoint(worldAt(event), reach(9) / renderer.camera.zoom, { nearest: true }) : null;
    const end = spot?.kind === 'node', edge = spot ? null : outlineAt(event), along = end ? null : alongAt(event), room = carriesRoom(edge);
    if (!room && !along && !end) return;
    event.stopImmediatePropagation(); event.preventDefault();
    canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    attempt(() => editor.commit());
    frameGesture.dragging = true; renderer.hoverId = renderer.vertexHover = null; closeMenus();
    frameGesture.offer = room ? offered(edge, event) : null;
    frameGesture.growing = { edge: room ? edge : null, along, spot, from: worldAt(event), x: event.clientX, y: event.clientY, pointerId: event.pointerId, plates: editor.source.plates.length,
      moved: false, way: end ? 'plate' : null, u: along?.at ?? null, drawn: null, laid: null, settled: false };
    paintOffer();
  }, true);
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (!frameGesture.growing) return;
    event.stopImmediatePropagation();
    frameGesture.pointer = { clientX: event.clientX, clientY: event.clientY };
    // A finger, which shakes more than the mouse, goes further before it drags.
    const pulled = Math.hypot(event.clientX - frameGesture.growing.x, event.clientY - frameGesture.growing.y);
    if (!frameGesture.growing.moved && pulled < reach(3)) return;
    if (!frameGesture.growing.moved) { frameGesture.growing.moved = true; frameGesture.shaping = true; editor.begin(); }
    const at = worldAt(event), box = canvas.getBoundingClientRect();
    // A drag more along the edge than away from it lays plates on it; one away from it pulls a room out of it.
    if (!frameGesture.growing.way) {
      if (pulled < reach(6)) return;
      const heading = frameGesture.growing.along && headingAt(frameGesture.growing.along, frameGesture.growing.along!.at), dx = at.x - frameGesture.growing.from.x, dy = at.y - frameGesture.growing.from.y;
      frameGesture.growing.way = heading && (!frameGesture.growing.edge || Math.abs(dx * heading.x + dy * heading.y) >= Math.abs(dx * heading.y - dy * heading.x)) ? 'along' : 'room';
    }
    if (frameGesture.growing.way !== 'room') {
      if (frameGesture.growing.way === 'plate') { const spot = frameGesture.growing.spot; if (spot?.kind === 'node') frameGesture.growing.laid = editor.drawPlate(spot, at, reach(9) / renderer.camera.zoom); }
      else {
        frameGesture.growing.u = alongEdge(frameGesture.growing.along!, at, frameGesture.growing.u);
        frameGesture.growing.laid = editor.layPlates(frameGesture.growing.along!, editor.snap ? snapAlong(frameGesture.growing.along!, frameGesture.growing.along!.at) : frameGesture.growing.along!.at,
          editor.snap ? snapAlong(frameGesture.growing.along!, frameGesture.growing.u!) : frameGesture.growing.u!);
      }
      editor.preview();
      // What the plates drawn meet is lit: the end of plates one is joined to, and where plates are divided for them.
      const refused = (editor.blockedEdit?.until ?? 0) > Date.now() && editor.blockedEdit!.message;
      frameGesture.offer = null; renderer.edgeHover = null; renderer.joinTargets = frameGesture.growing.laid ? editor.meets : []; canvas.style.cursor = 'crosshair'; paintOffer();
      effects.readout.hidden = !refused; effects.readout.toggleAttribute('data-refused', Boolean(refused)); effects.readout.textContent = refused || '';
      if (refused) showAt(effects.readout, event.clientX - box.left, event.clientY - box.top);
      return;
    }
    frameGesture.growing.drawn = editor.drawRoom(frameGesture.growing.edge, frameGesture.growing.from, at);
    editor.preview();
    const refused = (editor.blockedEdit?.until ?? 0) > Date.now() && editor.blockedEdit!.message;
    // Where its feet divide the plate it stands on is lit.
    renderer.edgeHover = frameGesture.growing.drawn ? null : frameGesture.growing.edge; renderer.joinTargets = editor.meets; canvas.style.cursor = 'crosshair';
    frameGesture.growing.settled = Boolean(frameGesture.growing.drawn || refused); paintOffer();
    effects.readout.hidden = false; effects.readout.toggleAttribute('data-refused', Boolean(refused));
    effects.readout.textContent = frameGesture.growing.drawn ? `${metres(frameGesture.growing.drawn.length)} × ${metres(frameGesture.growing.drawn.depth)} m` : refused || tr('Puxe para fora da chapa');
    showAt(effects.readout, event.clientX - box.left, event.clientY - box.top);
  }, true);
  function endGrowth(event: PointerEvent | null, cancelled = false) {
    if (!frameGesture.growing) return;
    event?.stopImmediatePropagation();
    const { moved, drawn, laid, way, from, spot, pointerId, plates } = frameGesture.growing;
    frameGesture.growing = frameGesture.offer = null; frameGesture.shaping = false; frameGesture.dragging = false; renderer.edgeHover = null; renderer.joinTargets = []; canvas.style.cursor = '';
    effects.readout.hidden = true; effects.readout.removeAttribute('data-refused'); paintOffer();
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    if (cancelled) { editor.cancel(); editor.blockedEdit = null; refresh(); return; }
    if (!moved) { const chosen = spot?.key ?? editor.pick(from, reach(5) / renderer.camera.zoom); if (chosen) editor.select(chosen, { toggle: true }); refresh(); return; }
    const refused = (editor.blockedEdit?.until ?? 0) > Date.now() && editor.blockedEdit!.message,
      made = way === 'room' ? drawn : laid;
    if (attempt(() => editor.commit()) && made) {
      editor.select(way === 'room' ? drawn!.plates[1]! : laid!); refresh();
      // In symmetric editing the plates laid across the axis are counted too.
      const count = editor.source.plates.length - plates;
      toast(way === 'room' ? tr('Compartimento criado.') : count > 1 ? tr`${count} chapas criadas.` : tr('Chapa criada.'));
    } else if (refused) toast(refused, true);
  }
  canvas.addEventListener('pointerup', event => endGrowth(event), true);
  canvas.addEventListener('pointercancel', event => endGrowth(event, true), true);
  document.addEventListener('keydown', event => {
    if (!frameGesture.growing || !cancels(event)) return;
    event.stopImmediatePropagation(); event.preventDefault(); endGrowth(null, true);
  }, true);
  // Pressing or letting go of Shift over a plate changes what a drag would do.
  for (const type of ['keydown', 'keyup'] as const) document.addEventListener(type, event => {
    if (event.key === 'Shift' && !frameGesture.growing && !frameGesture.dragging) offerGrowth(type === 'keydown');
  });
  window.addEventListener('blur', () => offerGrowth(false));


}

const sectorRadius = (weapon: Pick<CompiledModule, 'width'>) => Math.max(.35, Math.min(1.1, weapon.width));
export function handlePoints(weapon: CompiledWeapon) {
    const mount = weapon.weaponMount, radius = sectorRadius(weapon),
      at = (angle: number, distance: number) => ({ x: weapon.x + Math.cos(angle) * distance, y: weapon.y + Math.sin(angle) * distance });
    const closed = Math.abs(mount.max-mount.min)<8*DEG;
    return { min: at(weapon.angle + mount.min, radius*(closed ? .75 : 1)), max: at(weapon.angle + mount.max, radius*(closed ? 1.25 : 1)) };
  }

export function editWeaponSector({ editor, weapon, grip, point, readout, refresh }: { editor: Editor; weapon: CompiledWeapon; grip: 'min' | 'max'; point: Point; readout: HTMLOutputElement; refresh(): void }) {
    const mount = weapon.weaponMount, capacity = WEAPON_MOUNTS[mount.preset],
      angle = Math.atan2(point.y - weapon.y, point.x - weapon.x);
    const offset = Math.round(wrapAngle(angle - weapon.angle) / DEG) * DEG,
      value = grip === 'min' ? clamp(offset, capacity.min, mount.max) : clamp(offset, mount.min, capacity.max),
      key = (grip === 'min') !== Boolean(mount.mirrored) ? 'sectorMin' : 'sectorMax';
    readout.textContent = 'Setor ' + degrees(grip === 'min' ? value : mount.min) + tr(' a ') + degrees(grip === 'max' ? value : mount.max);
    if (value === mount[grip]) return;
    try { editor.editProperty(key, mount.mirrored ? -value : value); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && ['STRUCTURED_CONSTRUCTION', 'CONSTRUCTION_OVERLAP'].includes(error.code))) throw error;
      editor.rejectEdit(error); refresh();
    }
  }


export function initWorkshopUX({ editor, renderer, view, toast = () => {}, refresh = () => {}, openTask, selectTool = () => {}, project = () => openTask('project'), aim = null,
  gesture = () => null }: WorkshopOptions) {
  const viewport = document.querySelector<HTMLElement>('#viewport')!, sidebar = document.querySelector<HTMLElement>('.sidebar')!, inspector = document.querySelector<HTMLElement>('#project-inspector')!, canvas = renderer.canvas,
    palette = document.querySelector<HTMLElement>('.component-palette')!, arsenal = document.querySelector<HTMLElement>('#catalog-edit')!,
    arsenalDialog = document.querySelector<HTMLDialogElement>('#arsenal-dialog')!;
  const frameGesture: FrameGrowthState = { dragging: false, pointer: null, shaping: null, growing: null, offer: null };
  let grip: 'min' | 'max' | 'turn' | null = null, gripAt: Point | null = null, turning: { lever: number; magnets: number[]; from: Point | null; refused: number | null } | null = null, cameraSeen = '';

  const editing = () => view.mode === 'edit';
  // An edit the compiler refuses is shown where it happened, like any other.
  const attempt = <T>(action: () => T): T | undefined => {
    try { return action(); }
    catch (error) { editor.rejectEdit(error); toast(editor.blockedEdit!.message, true); return undefined; }
    finally { refresh(); }
  };
  const authored = (id: string | null | undefined) => editor.source.components.find(part => part.id === id);
  const weaponChoice = createWeaponChoice({ editor, view, renderer, openTask, arsenal, arsenalDialog,
    testArsenal: document.querySelector<HTMLElement>('#catalog-test')!, refresh, toast });
  const { beginWeaponChoice, clearWeaponChoice } = weaponChoice;
  // The chassis is selected alone: its bar and grips are shown.
  const chassisShown = () => editing() && view.buildTool === 'select' && renderer.ready && editor.selection === CHASSIS_ID && editor.selectionIds.size === 1;

  // Component tiles: pictures and number keys, arsenal included. Each category numbers its own tiles, in the order shown.
  palette.append(arsenal);
  const tiles = htmlChildren(palette), tileKeys = partKeys(tiles.map(tile => tile.dataset.component || 'weapon'));
  for (const [index, button] of tiles.entries()) {
    if (button === arsenal) {
      arsenal.append(node('kbd', '', String(tileKeys[index])));
      arsenal.title = tr('Abrir o Arsenal para escolher e instalar uma arma · tecla ') + tileKeys[index];
      continue;
    }
    const label = (button.textContent ?? '').trim();
    button.innerHTML = svg(iconPath(button.dataset.component)) + `<span>${label}</span><kbd>${tileKeys[index]!}</kbd>`;
    button.title = tr`Instalar ${label.toLowerCase()} · tecla ${tileKeys[index]!}`;
  }

  installPaletteKeys({ viewport, sidebar, canvas, editing, palette, chooseChassis, press, view, joinPoints });
  // R: the chassis is selected, and its bar opens over it.
  function chooseChassis() {
    if (!editing() || !editor.blueprint.chassis) return;
    selectTool(); editor.select(CHASSIS_ID); openTask('adjust'); refresh();
  }

  // Hover: say what a click will take before the click happens. A place under the pointer is told in the
  // frame the design is made in: with the workshop in the field, that is the frame of the board standing there.
  const worldAt = (event: PointerPosition) => {
    const box = canvas.getBoundingClientRect();
    return renderer.board.camera.toWorld(event.clientX - box.left, event.clientY - box.top);
  };
  // The plate or bed under the pointer, unless a component lies over it.
  const outlineAt = (event: PointerPosition) => {
    if (!editing() || view.buildTool !== 'select' || !renderer.ready) return null;
    const zoom = renderer.camera.zoom, point = worldAt(event);
    return authored(editor.pick(point, reach(5) / zoom)) ? null : editor.pickPlate(point, reach(7) / zoom) ?? editor.pickBed(point, reach(7) / zoom);
  };
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    frameGesture.pointer = { clientX: event.clientX, clientY: event.clientY };
    let hover = null, vertex = null;
    if (editing() && view.buildTool === 'select' && event.buttons === 0) {
      const zoom = renderer.camera.zoom, point = worldAt(event);
      vertex = editor.pickPoint(point, reach(9) / zoom);
      const id = editor.pick(point, reach(5) / zoom);
      if (groupSelectionHit(editor, { piece: id, node: vertex })) vertex = null;
      if (id && authored(id)) hover = id;
      if (hover && !canvas.style.cursor) canvas.style.cursor = 'grab';
    }
    renderer.hoverId = hover; renderer.vertexHover = vertex;
    offerGrowth(event.shiftKey && event.buttons === 0);
  });
  canvas.addEventListener('pointerleave', () => { frameGesture.pointer = renderer.hoverId = renderer.vertexHover = null; offerGrowth(false); });
  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    frameGesture.dragging = true; renderer.hoverId = null; closeMenus();
    // Whether this press takes hold of the frame: a node, or a plate nothing lies over.
    const zoom = renderer.camera.zoom, point = worldAt(event);
    frameGesture.shaping = Boolean(editing() && view.buildTool === 'select' && event.button === 0 && renderer.ready &&
      (editor.pickPoint(point, reach(9) / zoom) || !authored(editor.pick(point, reach(5) / zoom)) && editor.pickPlate(point, reach(7) / zoom)));
  });
  for (const type of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(type, () => { frameGesture.dragging = false; frameGesture.shaping = false; });

  // With Shift held, a plate offers a bay near the pointer. Its support is
  // divided automatically; pulling the plate out gives the room its
  // depth. Dragged along it instead, the edge of the plate — going on over the
  // plates that continue it, end to end — or the top of the chassis gets new
  // plates over the stretch dragged (edge-plates.ts): the way the drag first
  // goes says which. A point of the frame pulls no room: from an end of plates,
  // a drag any way draws a new plate from it (Editor.drawPlate), and from a
  // point of the chassis it lays plates along the top of the chassis.
  // The pull is taken before the workshop's own
  // gesture, which would select instead; a Shift+click that never moves still
  // adds to or takes from the selection.
  const ghost = node('div', 'build-ghost'); ghost.hidden = true;
  ghost.innerHTML = '<svg><polygon/></svg>'; canvas.after(ghost);
  // The offer stays through the press and the first of the pull, until the
  // room itself is drawn in its place.
  function paintOffer() {
    ghost.hidden = !frameGesture.offer || Boolean(frameGesture.growing?.settled) || !editing();
    if (!ghost.hidden) ghost.querySelector('polygon')!.setAttribute('points', frameGesture.offer!.map(point => {
      const spot = renderer.board.camera.toScreen(point.x, point.y); return spot.x.toFixed(1) + ',' + spot.y.toFixed(1);
    }).join(' '));
  }
  function offered(edge: RoomWall | null, at: PointerPosition) {
    const drawn = carriesRoom(edge) ? drawRoom(editor.source, editor.blueprint, roomSpan(edge, worldAt(at), 1.8, { snap: editor.snap }), worldAt(at), null, { snap: editor.snap }) : null;
    return drawn?.source ? drawn.polygon : null;
  }
  function offerGrowth(held: boolean) {
    if (frameGesture.growing) return;
    frameGesture.offer = held && frameGesture.pointer && renderer.ready && !editor.pickPoint(worldAt(frameGesture.pointer), reach(9) / renderer.camera.zoom) ? offered(outlineAt(frameGesture.pointer), frameGesture.pointer) : null;
    if (frameGesture.offer) canvas.style.cursor = 'crosshair'; else if (canvas.style.cursor === 'crosshair') canvas.style.cursor = renderer.edgeHover ? 'grab' : '';
    paintOffer();
  }
  // The edge under the pointer new plates may be laid along, unless a component lies over it.
  const alongAt = (event: PointerPosition) => {
    if (!editing() || view.buildTool !== 'select' || !renderer.ready) return null;
    const zoom = renderer.camera.zoom, point = worldAt(event);
    return authored(editor.pick(point, reach(5) / zoom)) ? null : editor.pickEdge(point, reach(7) / zoom);
  };
  installFrameGrowth({ canvas, editor, view, renderer, state: frameGesture,
    effects: { editing, alongAt, worldAt, outlineAt, attempt, closeMenus, offered, paintOffer, offerGrowth, refresh, showAt,
      metres: (value: number) => metres(value), toast, get readout() { return readout; } } });

  const metres = (value: number) => number(value, 2);
  const guides = new WorkshopGuides(canvas, editor, renderer);
  let frameGuide = false;
  // The workshop already ignores a double click on a point of the frame; here it removes it: a node between two plates
  // joins them, a point of the chassis lets its line run straight past (its ends stay). One that has just divided a
  // plate is spent: the node it made stays.
  canvas.addEventListener('dblclick', (event: MouseEvent) => {
    if (event.defaultPrevented || !editing() || view.buildTool !== 'select' || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    const point = worldAt(event), spot = editor.pickPoint(point, reach(9) / renderer.camera.zoom);
    if (!spot || groupSelectionHit(editor, { piece: editor.pick(point, reach(5) / renderer.camera.zoom), node: spot })) return;
    event.preventDefault(); editor.commit();
    if (attempt(() => spot.kind === 'node' ? editor.removeNode(spot) : editor.removeChassisPoint(spot.index))) toast(spot.kind === 'node' ? tr('Nó removido.') : tr('Ponto do chassi removido.'));
    else if (editor.blockedEdit) toast(editor.blockedEdit!.message, true);
  });

  // The selected object owns its inspector; only editing handles follow the canvas.
  const bar = node('div', 'selection-bar'); bar.id = 'selection-settings'; bar.hidden = true; bar.style.display = 'none';
  const selectionHost = document.querySelector<HTMLElement>('#workshop-selection-host')!,
    selectionEmpty = document.querySelector<HTMLElement>('#workshop-selection-empty')!;
  // The pieces picked as on the drawing: the one pressed alone, or with Shift or Ctrl taken into the selection or out of
  // it. Whatever was being installed is let go.
  function pick(ids: string | readonly string[], toggle = false) {
    if (!editing()) return;
    editor.commit();
    if (view.buildTool !== 'select') selectTool();
    editor.select(ids, { toggle }); openTask('adjust'); refresh();
  }
  // Ctrl+A: every piece of the project.
  const selectAll = () => pick(everyPiece(editor.blueprint));
  // The pieces of the project listed beside it, the paint of the hull at their head. Pointing at one in the list
  // marks it on the drawing.
  const partsPanel = document.querySelector<HTMLElement>('#workshop-parts')!, partList = document.querySelector<HTMLElement>('#workshop-part-list')!;
  let partsKey = '';
  partList.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest<HTMLElement>('[data-part]')?.dataset.part;
    if (id) pick(id, event.shiftKey || event.ctrlKey || event.metaKey);
  });
  partList.addEventListener('pointerover', event => { if (event.pointerType === 'mouse') renderer.hoverId = (event.target instanceof Element ? event.target.closest<HTMLElement>('[data-part]') : null)?.dataset.part ?? null; });
  partList.addEventListener('pointerleave', () => { renderer.hoverId = null; });
  // What the construction is, on wheels, on tracks, as an aircraft or fixed in its place, chosen under the paint of its
  // hull: what each would carry, or why it cannot be.
  const KIND_ICONS: Record<ConstructionKind, string> = { wheeled: ICONS.chassis, tracked: ICONS.tracks, aircraft: ICONS.thruster, [FIXED]: ICONS.fixed },
    kindName = (kind: ConstructionKind) => kind === FIXED ? tr('Fixa') : tr(chassisLabel(kind)),
    kindButton = node('button', 'workshop-kind'), kindMenu = node('div', 'ammo-menu kind-menu');
  kindButton.type = 'button'; kindButton.setAttribute('aria-haspopup', 'true'); kindMenu.hidden = true;
  partList.before(kindButton); partsPanel.append(kindMenu);
  kindButton.addEventListener('click', () => {
    if (!kindMenu.hidden) { kindMenu.hidden = true; return; }
    const current = constructionKind(editor.source);
    kindMenu.innerHTML = ("<small>" + tr("Tipo da construção") + "</small>") + kindChoices(editor.source).map(choice =>
      `<button type="button" data-kind="${choice.id}"${choice.disabled ? ' disabled' : ''}${choice.id === current ? ' aria-current="true"' : ''}>` +
      `${svg(KIND_ICONS[choice.id])}<div><b>${choice.name}</b><span>${choice.detail}</span></div></button>`).join('');
    kindMenu.hidden = false;
  });
  kindMenu.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const kind = target.closest<HTMLElement>('[data-kind]:not(:disabled)')?.dataset.kind;
    if (!isConstructionKind(kind)) return;
    kindMenu.hidden = true;
    if (kind === constructionKind(editor.source)) return;
    editor.commit();
    if (attempt(() => editor.setConstructionKind(kind)))
      toast(kind === FIXED ? tr('Construção fixa: sem chassi.') : `${tr(chassisName(kind))} · ${metres(editor.blueprint.chassis!.length)} m.`);
  });
  document.addEventListener('pointerdown', event => {
    if (!kindMenu.hidden && event.target instanceof Node && !kindMenu.contains(event.target) && !kindButton.contains(event.target)) kindMenu.hidden = true;
  });
  function describeParts(c: UiModel) {
    partsPanel.hidden = !c.edit;
    if (!c.edit) { kindMenu.hidden = true; return; }
    const kind = constructionKind(editor.source);
    if (kindButton.dataset.kind !== kind) {
      kindButton.dataset.kind = kind; kindMenu.hidden = true;
      kindButton.innerHTML = svg(KIND_ICONS[kind]) + `<span>${kindName(kind)}</span>` + svg(ICONS.chevron!);
      kindButton.title = tr`${kindName(kind)} · escolher rodas, esteiras, aeronave ou construção fixa`;
      kindButton.setAttribute('aria-label', tr`Tipo da construção: ${kindName(kind).toLowerCase()}`);
    }
    const parts = projectParts(editor.blueprint), key = parts.map(part => part.id + ':' + part.kind + ':' + part.name).join('|');
    if (key !== partsKey) {
      partsKey = key;
      partList.replaceChildren(...parts.map(part => {
        const item = node('li'), button = node('button');
        button.type = 'button'; button.dataset.part = part.id; button.title = part.name;
        button.innerHTML = svg(part.kind === 'weapon' ? ICONS.gun : iconPath(part.kind)); button.append(node('span', '', part.name));
        item.append(button); return item;
      }));
    }
    for (const button of partList.querySelectorAll<HTMLElement>('[data-part]')) {
      const picked = String(editor.selectionIds.has(button.dataset.part ?? ''));
      if (button.getAttribute('aria-pressed') !== picked) button.setAttribute('aria-pressed', picked);
    }
  }
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', tr('Peças selecionadas'));
  const stepper = (key: NumericSettingKey) => `<span class="bar-step" data-step="${key}"><label for="bar-${key}">${svg(STEP_ICONS[key])}<span class="sr-only"></span></label><button type="button" data-dir="-1">−</button>` +
    `<input id="bar-${key}" type="number" inputmode="${key.startsWith('track') || ['frameThicknessMm', 'angle', 'length', 'barrelLength', 'calibre'].includes(key) ? 'decimal' : 'numeric'}" aria-describedby="bar-${key}-unit bar-${key}-scope bar-${key}-range"><em id="bar-${key}-unit"></em><button type="button" data-dir="1">+</button>` +
    `<small id="bar-${key}-scope" class="bar-step-scope" hidden></small><small id="bar-${key}-range" class="bar-step-range" hidden></small></span>`;
  bar.innerHTML = '<output class="bar-fact"></output>' +
    `<button data-act="frame" aria-haspopup="true"><em class="swatch"></em><span></span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="topPlate" aria-haspopup="true"><em class="swatch"></em><span></span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="material" aria-haspopup="true"><em class="swatch"></em><span></span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="metal" aria-haspopup="true"><em class="swatch"></em><span></span>${svg(ICONS.chevron!)}</button>` +
    STEPPERS.map(stepper).join('') +
    `<button data-act="ammo" aria-haspopup="true"><span></span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="sensor" aria-haspopup="true" title="${tr("Escolher como este sensor detecta")}"><span>${tr("Detecção")}</span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="mount" aria-haspopup="true"><span>${tr("Montagem")}</span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="munition" aria-haspopup="true"><span>${tr("Munição")}</span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="core" aria-haspopup="true"><span>${tr("Penetrador")}</span>${svg(ICONS.chevron!)}</button>` +
    `<button data-act="vent" aria-pressed="false"><span>${tr("Painéis de alívio")}</span></button>` +
    `<button data-act="vertex" title="${tr("Dividir esta chapa ao meio com um novo nó · ou duplo clique na chapa")}">${svg(ICONS.vertex!)}Dividir</button>` +
    `<button data-act="join" title="${tr("Juntar as pontas escolhidas num ponto só, onde está a primeira · J")}">${svg(ICONS.join!)}Juntar</button>` +
    ("<button data-act=\"grow\" title=\"" + tr("Criar um compartimento a partir desta chapa: até 1,8 × 0,6 m") + "\">" + tr("Criar compartimento") + "</button>") +
    `<button data-act="weapon" title="${tr("Instalar uma arma nesta chapa · abre o Arsenal")}">${svg(ICONS.gun!)}Arma</button>` +
    `<button data-act="swap" title="${tr("Trocar por outro modelo do Arsenal · a munição muda junto")}">${svg(ICONS.swap!)}Trocar</button>` +
    ("<button data-act=\"duplicate\" title=\"" + tr("Duplicar · Ctrl+D") + "\"><svg><use href=\"#i-copy\"/></svg>" + tr("Duplicar") + "</button>") +
    ("<button data-act=\"delete\" class=\"danger\" title=\"" + tr("Remover · X") + "\"><svg><use href=\"#i-trash\"/></svg>" + tr("Remover") + "</button>") +
    ("<button data-act=\"compartment\" class=\"danger\" title=\"" + tr("Remover as chapas deste compartimento; componentes permanecem no projeto") + "\"><svg><use href=\"#i-trash\"/></svg>" + tr("Remover compartimento") + "</button>");
  selectionHost.append(bar);
  const action = (name: string) => bar.querySelector<HTMLButtonElement>(`[data-act="${name}"]`)!;
  for (const [name, label] of [['vertex', tr('Dividir')], ['join', tr('Juntar')], ['swap', tr('Trocar')], ['duplicate', tr('Duplicar')], ['delete', tr('Remover')]] as const) {
    const button = action(name), icon = button.querySelector<SVGSVGElement>('svg')!;
    icon.setAttribute('aria-hidden', 'true');
    button.classList.add('icon-action'); button.setAttribute('aria-label', label);
    button.replaceChildren(icon, node('span', 'action-label', label));
  }
  const guidance = node('p', 'selection-guidance'), primary = node('div', 'selection-primary'),
    more = node('div', 'selection-more'), secondary = node('div', 'selection-secondary');
  // Under the words that a gun has no box of its rounds aboard, the box it is offered (`feedGun`).
  const feeder = node('button'); feeder.type = 'button'; feeder.dataset.act = 'feed'; feeder.hidden = true;
  const fieldGroups: HTMLDivElement[] = [];
  guidance.hidden = true;
  more.setAttribute('role', 'group'); more.setAttribute('aria-label', tr('Mais opções'));
  more.append(node('div', 'selection-more-heading', tr('Mais opções')), secondary);
  const mainActions = ['join', 'grow', 'weapon', 'sensor', 'munition', 'core', 'vent', 'swap', 'duplicate', 'delete', 'compartment'];
  for (const child of htmlChildren(bar)) {
    if (child.matches('.bar-fact')) continue;
    (mainActions.includes(child.dataset.act ?? '') || ['thicknessMm', 'sizeScale'].includes(child.dataset.step ?? '') ? primary : secondary).append(child);
  }
  for (const [name, label, selectors] of [
    ['plates', tr('Chapas'), ['[data-act="material"]', '[data-step="thicknessMm"]', '[data-step="length"]']],
    ['parts', tr('Componentes'), ['[data-act="metal"]', '[data-step="sizeScale"]']],
    // A gun is made over as a gun and as its rounds: the rounds it is fed are chosen with them.
    ['weapon', tr('Arma'), ['[data-step="barrelLength"]', '[data-step="calibre"]', '[data-step="barrels"]', '[data-step="rate"]']],
    // How the round it is fed is made goes with the choice of it; the blow-out panels of its compartment with the belt or
    // magazine they hold.
    ['ammunition', tr('Munição'), ['[data-act="munition"]', '[data-act="core"]', '[data-step="cone"]', '[data-step="standoff"]', '[data-step="fill"]',
      '[data-step="charge"]', '[data-step="projectile"]', '[data-step="magazine"]', '[data-act="vent"]']],
    ['orientation', tr('Orientação'), ['[data-step="angle"]']],
    ['frame', tr('Chassi'), ['[data-act="frame"]']],
    ['topPlate', tr('Piso do chassi'), ['[data-act="topPlate"]', '[data-step="topPlateThicknessMm"]']],
    ['gear', tr('Rodagem'), ['[data-step="gearScale"]', '[data-step="axleCount"]',
      '[data-step="trackLength"]', '[data-step="trackHeight"]', '[data-step="trackX"]', '[data-step="suspension"]', '[data-step="armorMm"]']],
  ] as const) {
    const group = node('div', 'selection-field-group'), heading = node('b', 'selection-group-heading', label);
    group.dataset.group = name; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    group.append(heading, ...selectors.map(selector => (primary.querySelector(selector) || secondary.querySelector(selector))!)); fieldGroups.push(group);
  }
  let selectionReview: { source: AuthoredConstruction; key: string; actions: ReturnType<typeof workshopActions>; mounts: ReturnType<typeof mountChoices>; sensors: ReturnType<typeof sensorChoices> } | undefined;
  // The first view answers how to change the selected object. Longer readings remain below its controls.
  bar.append(...fieldGroups, primary, guidance, feeder, bar.querySelector<HTMLElement>('.bar-fact')!, more);
  function optionsOf() {
    const source = editor.source, key = [...editor.selectionIds].join('|');
    if (frameGesture.dragging && selectionReview?.key === key) return selectionReview;
    if (selectionReview?.source !== source || selectionReview.key !== key) {
      if (selectionReview) closeMenus();
      const part = editor.selectionIds.size === 1 ? authored(editor.selection) : null;
      selectionReview = { source, key, actions: workshopActions({ source, blueprint: editor.blueprint, spans: editor.plateSpans() }, editor.selectionIds),
        mounts: part?.kind === 'weapon' ? mountChoices(part.weaponPreset) : [],
        sensors: part?.kind === 'sensor' ? sensorChoices() : [] };
    }
    return selectionReview;
  }
  // The pieces of a selection as the settings read them: each as compiled, with the component its author wrote.
  const told = (pieces: readonly PartDefinition[]): SettingsEntry[] => pieces.map(piece => ({ piece, part: (piece.chassis ? editor.source.chassis :
    piece.material ? editor.source.plates.find(plate => plate.id === piece.id) : authored(piece.id)) ?? null }));
  // Each field names its own subset even when the whole construction is selected.
  const settingsOf = () => selectionSettings(editing() ? told(editor.selectedPieces) : [], { snap: editor.snap });
  // Pieces that do not share a value show none.
  // The next piece uses the same size and angle limits as an installed one.
  // These are the existing placement intent, not a draft document or history
  // edit. The ordinary preview plans that intent at the current cursor point.
  const describePlacementSettings = createPlacementControls({ editor, view, refresh });
  // Pieces with no room for the value asked of them stayed as they were: they are shown, and it is said.
  function stayed(refused: readonly string[]) {
    if (!refused.length) return false;
    editor.rejectEdit(new Error((refused.length === 1 ? tr('Uma peça ficou como estava') : refused.length + tr(' peças ficaram como estavam')) + tr(': não há espaço para esse valor.')), { ids: [...refused] });
    toast(editor.blockedEdit!.message, true);
    return true;
  }
  // A setting changes only the explicit pieces. Physical refusals come from the compiler.
  function put(key: NumericSettingKey, values: ReadonlyMap<string, number>) {
    try {
      editor.commit();
      if (isWeaponSetting(key)) return makeOver(key, values);
      const { refused } = applySettings(editor, key, values);
      if (stayed(refused)) return false;
      return true;
    } catch (error) {
      editor.rejectEdit(error);
      toast(editor.blockedEdit!.message, true);
    } finally { refresh(); }
  }
  // The gun chosen made over by one of its settings: it becomes the gun of that name, and the boxes that fed it alone feed
  // the rounds of its cartridge (editor.ts `weaponPreset`).
  function makeOver(key: WeaponSettingKey, values: ReadonlyMap<string, number>) {
    const [[id, value] = []] = values, part = id === undefined ? undefined : authored(id);
    if (part?.kind !== 'weapon' || value === undefined) return false;
    const made = madeOver(part.weaponPreset ?? 'rh120', key, value);
    if (!made) { toast(tr('Essa arma não pode ser feita assim.'), true); return false; }
    editor.editProperty('weaponPreset', made, true);
    return true;
  }
  // A press of − or + takes every piece one step from where it is; with none left to go, it says why nothing changed.
  function nudge(key: NumericSettingKey, direction: number) {
    const setting = settingsOf().find(candidate => candidate.key === key);
    if (!setting) return;
    const values = steppedSettings(setting, direction);
    if (values.size) put(key, values); else toast(setting.ends[direction < 0 ? 0 : 1]);
  }
  // A typed value is kept as each piece takes it; the field then shows what the pieces have.
  bar.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const key = target.closest<HTMLElement>('.bar-step')?.dataset.step, setting = settingsOf().find(candidate => candidate.key === key);
    if (!setting) return;
    const text = target.value, values = typedSettings(setting, text), wanted = text.trim() === '' ? NaN : Number(text.replace(',', '.')),
      limited = Number.isFinite(wanted) ? setting.each.filter(own => wanted < own.min || wanted > own.max).length : 0,
      done = values.size ? put(setting.key, values) : true;
    if (done && limited) toast(tr`${limited === 1 ? tr('Uma peça ficou') : limited + tr(' peças ficaram')} no limite.`);
    const now = settingsOf().find(candidate => candidate.key === key);
    if (now) target.value = shown(now);
  });
  bar.addEventListener('keydown', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.matches('.bar-step input') || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') {
      const setting = settingsOf().find(setting => setting.key === target.closest<HTMLElement>('.bar-step')!.dataset.step);
      if (setting) target.value = shown(setting);
    }
    target.blur();
  });
  // The ammunition of a reserve is chosen on the box itself: what each calibre
  // would give in this box, and which of them the installed weapons can fire.
  const ammoMenu = node('div', 'ammo-menu'); ammoMenu.hidden = true; bar.append(ammoMenu);
  // The armour of a plate is chosen on the plate too: what this very plate
  // would weigh, resist and cost in each material, at the thickness it has or
  // at the least one that material stands as a plate.
  const materialMenu = node('div', 'ammo-menu material-menu'); materialMenu.hidden = true; bar.append(materialMenu);
  // How a sensor detects and what a weapon stands on are chosen from one list each, with what tells its entries apart.
  const choiceMenu = node('div', 'ammo-menu'); choiceMenu.hidden = true; bar.append(choiceMenu);
  function closeMenus(but: HTMLElement | null = null) { for (const menu of [ammoMenu, materialMenu, choiceMenu]) if (menu !== but) menu.hidden = true; }
  // Keep the chosen menu visible within the inspector.
  function openMenu(menu: HTMLElement) {
    menu.hidden = false; menu.scrollTop = 0;
    menu.scrollIntoView({ block: 'nearest' });
  }
  const platesOf = (pieces: readonly CompiledPiece[]) => pieces.filter((piece): piece is CompiledPlate => Boolean(piece.material && !piece.chassis));
  const metalParts = () => editor.source.components.filter(part => editor.selectionIds.has(part.id) && choosesMetal(part));
  function listMaterials(plates: readonly PlateDefinition[]) {
    const title = plates.length === 1 ? tr('Material desta chapa · ') + count(plates[0]!.thicknessMm) + ' mm' : tr`Material destas ${plates.length} chapas`;
    materialMenu.innerHTML = `<small>${title}</small>` + materialChoices(plates, !editor.blueprint.vehicle.enabled).map(({ id, name, tag, note, detail }) =>
      `<button type="button" data-material="${id}" title="${note}"${plates.every(plate => plate.material === id) ? ' aria-current="true"' : ''}>` +
        `<em class="swatch" style="--tone:${tone(id)}"></em><div><b>${name}<em>${tag}</em></b><span>${detail}</span></div></button>`).join('');
  }
  function toggleMaterials() {
    const plates = platesOf(editor.selectedPieces);
    closeMenus(materialMenu);
    if (!materialMenu.hidden || !plates.length) { materialMenu.hidden = true; return; }
    listMaterials(plates); openMenu(materialMenu);
  }
  function chooseMaterial(id: MaterialId) {
    const plates = platesOf(editor.selectedPieces), changing = plates.filter(plate => plate.material !== id); materialMenu.hidden = true;
    if (!changing.length || !MATERIALS[id]) return;
    editor.commit();
    const done = attempt(() => applySettings(editor, 'material', new Map(changing.map(plate => [plate.id, id]))));
    if (!done || stayed(done.refused)) return;
    const now = platesOf(editor.selectedPieces), mass = weight(now.reduce((sum, plate) => sum + pieceMass(plate), 0));
    toast(now.length === 1 ? tr`Chapa em ${tr(MATERIALS[id].name).toLowerCase()} · ${now[0]!.thicknessMm > plates[0]!.thicknessMm ? count(now[0]!.thicknessMm) + ' mm · ' : ''}${mass} · ≈ ${steelWorth(now[0]!.thicknessMm, id)} mm de aço.`
      : tr`${now.length} chapas em ${tr(MATERIALS[id].name).toLowerCase()} · ${mass}.`);
  }
  // The rounds the guns of this construction fire (weapons.ts `cartridgeId`): those its boxes may hold.
  const carriedWeapons = () => editor.source.components.filter(part => part.kind === 'weapon').map(part => cartridgeId(part.weaponPreset ?? 'rh120'));
  // What a calibre on this construction is fed: what its guns are, or the first it takes.
  const fedOf = (preset: WeaponId) => fedAmmo(editor.source.components.find(part => part.kind === 'weapon' && cartridgeId(part.weaponPreset ?? 'rh120') === preset)
    ?? { weaponPreset: preset });
  // Rounds and their mass for the installed box, were it to hold `preset`.
  const stock = (part: Extract<AuthoredComponent, { kind: 'ammo' }>, preset: WeaponId) => {
    const box = editor.blueprint.modules.find(module => module.id === part.id), ammoType = fedOf(preset),
      choice = box ? ammunitionBoxChoice(box, preset, ammoType) : { rounds: 0, mass: 0, fits: false };
    return choice;
  };
  function listAmmunition(part: Extract<AuthoredComponent, { kind: 'ammo' }>) {
    // Weakest first within each family: by the power of a round, then by calibre.
    const of = (id: WeaponId) => weaponOf(id) ?? WEAPON_PRESETS.rh120,
      carried = carriedWeapons(), weakest = (a: WeaponId, b: WeaponId) => of(a).power - of(b).power || of(a).caliberMm - of(b).caliberMm,
      used = [...new Set(carried)].sort(weakest),
      row = (preset: WeaponId) => {
        const { rounds, mass, fits } = stock(part, preset), guns = carried.filter(id => id === preset).length;
        return `<button type="button" data-ammo="${preset}"${preset === part.ammoPreset ? ' aria-current="true"' : ''}${fits ? '' : ' disabled'}>` +
          svg(ROUNDS[of(preset).family] || ROUNDS.cannon) +
          `<div><b>${weaponName(preset)}</b><span>${fits ? count(rounds) + (rounds === 1 ? tr(' tiro · ') : tr(' tiros · ')) + weight(mass) : tr('não cabe nesta caixa')}` +
          `${guns ? ' · alimenta ' + (guns === 1 ? '1 arma' : guns + ' armas') : ''}</span></div></button>`;
      },
      group = ([family, title]: (typeof WEAPON_FAMILIES)[number]) => {
        const presets = Object.keys(WEAPON_PRESETS).filter(isWeaponPresetId).filter(id => WEAPON_PRESETS[id].family === family && !used.includes(id) && stock(part, id).fits).sort(weakest);
        return presets.length ? `<small>${title}</small>` + presets.map(row).join('') : '';
      };
    const others = WEAPON_FAMILIES.map(group).join('');
    ammoMenu.innerHTML = used.length ? ("<small>" + tr("Armas deste veículo") + "</small>") + used.map(row).join('') +
      (others ? ("<details class=\"ammo-other\"><summary aria-label=\"" + tr("Outros calibres") + "\">" + tr("Outros calibres") + "</summary>") + others + '</details>' : '') : others;
  }
  function toggleAmmunition() {
    const part = authored(editor.selection);
    closeMenus(ammoMenu);
    if (!ammoMenu.hidden || part?.kind !== 'ammo') { ammoMenu.hidden = true; return; }
    listAmmunition(part); openMenu(ammoMenu);
  }
  function chooseAmmunition(preset: WeaponId) {
    const part = authored(editor.selection); ammoMenu.hidden = true;
    if (part?.kind !== 'ammo' || part.ammoPreset === preset || !isCartridgeId(preset)) return;
    editor.commit();
    if (!attempt(() => { editor.editProperty('ammoPreset', preset, true); return true; })) return;
    const changed = authored(part.id);
    if (changed?.kind !== 'ammo') return;
    const { rounds } = stock(changed, preset);
    toast(tr`Caixa de ${weaponName(preset)}: ${count(rounds)} tiros` +
      (carriedWeapons().includes(preset) ? '.' : tr(' · nenhuma arma usa esse calibre.')));
  }
  // The gun selected, with no box of its rounds aboard, fed from the bar (`boxOffer`): a box no gun takes is put to its
  // rounds, as that box's own list would put it; with none, a new box of them is installed as the ammunition tile of
  // Adicionar installs one, these rounds chosen for it.
  function feedGun() {
    const gun = authored(editor.selection), offer = gun?.kind === 'weapon' ? boxOffer(editor.blueprint, gun.id) : null;
    if (!offer) return;
    const { box, cartridge, rounds } = offer;
    editor.commit();
    if (box) {
      const done = attempt(() => applySettings(editor, 'ammoPreset', new Map([[box.id, cartridge]])));
      if (done && !stayed(done.refused)) toast(tr`Caixa de ${weaponName(cartridge)}: ${count(rounds)} tiros` + '.');
      return;
    }
    palette.querySelector<HTMLElement>('[data-component="ammo"]')?.click();
    if (view.buildTool !== 'module' || view.placement.kind !== 'ammo') return;
    view.placement.ammoPreset = cartridge; refresh();
    toast(tr`Posicione a caixa de ${weaponName(cartridge)}.`);
  }
  // The entries of the list a button of the bar opens, and the property of the component each of them sets, or what
  // choosing one of them does.
  const CHOICES = {
    // The one material of the structure and its entire running gear.
    frame: { title: tr('Material do chassi e da rodagem'), of: () => chassisMetalChoices(editor.source), has: (chassis: AuthoredChassis) => chassis.metal ?? 'steel',
      apply: (id: ChassisMetalId) => editor.setChassisMetal(id), said: (id: ChassisMetalId) => tr`Chassi e rodagem de ${tr(METALS[id].name).toLowerCase()}: ${chassisFigures(editor.blueprint)}.` },
    topPlate: { key: 'topPlateMaterial', title: tr('Piso do chassi'), of: () => topPlateChoices(editor.source),
      has: (chassis: AuthoredChassis) => chassis.topPlate?.material ?? 'none',
      said: (id: MaterialId | 'none') => id === 'none' ? tr('Piso do chassi removido.') : tr`Piso em ${tr(MATERIALS[id].name).toLowerCase()}; selecione a chapa para criar compartimentos.` },
    // What a component other than a weapon is made of: a metal or, for some, glass fibre or plastic (materials.ts `pieceMetals`).
    // Of a sensor or a command post only the housing is of it (materials.ts `HOUSED`).
    metal: { title: tr('Material deste componente'),
      said: (id: MetalId, part: AuthoredComponent) => HOUSED.includes(part?.kind) && id !== 'steel'
        ? tr`Carcaça em ${tr(METALS[id].name).toLowerCase()} · paga em ${tr(STOCKS[METALS[id].stock])}; o equipamento, em Ferro.`
        : tr`Peça em ${tr(METALS[id].name).toLowerCase()} · paga em ${tr(STOCKS[METALS[id].stock])}.` },
    sensor: { key: 'sensorMode', title: tr('Detecção deste sensor'), of: () => sensorChoices(), has: (part: AuthoredComponent) => part.sensorMode,
      said: (id: SensorMode) => tr`Sensor trocado: ${tr(SENSOR_MODES[id].name).toLowerCase()}.` },
    mount: { key: 'mountPreset', title: tr('Montagem desta arma'), of: (part: AuthoredComponent) => mountChoices(part.weaponPreset), has: (part: AuthoredComponent) => part.mount?.preset,
      said: (id: WeaponMountId) => tr`Montagem trocada: ${tr(WEAPON_MOUNTS[id].name).toLowerCase()}.` },
    // Chosen here and kept in the field: the gun fires this ammunition only, and so do the others of its calibre.
    munition: { key: 'weaponAmmo', title: tr('Munição desta arma'), of: (part: AuthoredComponent) => ammoChoices(part.weaponPreset), has: fedAmmo,
      said: (id: AmmoId, part: AuthoredComponent) => { const others = carriedWeapons().filter(preset => preset === cartridgeId(part.weaponPreset ?? 'rh120')).length - 1;
        return tr`Munição trocada: ${tr(AMMO[id].name).toLowerCase()}${others ? tr` · também ${others === 1 ? tr('na outra arma') : tr`nas outras ${others} armas`} deste calibre` : ''}.`; } },
    // What its kinetic round's penetrator is made of: the gun becomes the one of that name, and its rounds a cartridge of their own.
    core: { title: tr('Penetrador desta munição'), of: (part: AuthoredComponent) => coreChoices(part.weaponPreset ?? 'rh120'),
      said: (id: CoreId) => tr`Penetrador de ${tr(CORES[id].name).toLowerCase()}: a munição passa a ter nome próprio, e as caixas precisam dela.` },
  };
  // What a list of the bar chooses for: the chassis as written, or the component selected.
  type ChoiceAction = keyof typeof CHOICES;
  const isChoiceAction = (act: unknown): act is ChoiceAction => typeof act === 'string' && Object.hasOwn(CHOICES, act);
  const chosen = (act: ChoiceAction) => ['frame', 'topPlate'].includes(act) ? editor.selection === CHASSIS_ID ? editor.source.chassis : null : authored(editor.selection);
  function toggleChoices(act: ChoiceAction) {
    const part = chosen(act), open = !choiceMenu.hidden && choiceMenu.dataset.act === act;
    closeMenus();
    const metals = act === 'metal' ? metalParts() : [];
    if (open || (!part && !metals.length)) return;
    choiceMenu.dataset.act = act;
    // A metal is told as an armour is: by its tone, and with what sets it apart beside its name.
    const metal = ['metal', 'frame', 'topPlate'].includes(act); choiceMenu.classList.toggle('material-menu', metal);
    const component = part && 'kind' in part ? part : null, chassis = part && 'model' in part ? part : null;
    const current = act === 'frame' ? chassis?.metal ?? 'steel' : act === 'topPlate' ? chassis?.topPlate?.material ?? 'none' : component ? act === 'sensor' ? component.sensorMode : act === 'mount' ? component.mount?.preset : act === 'core' ? coreOf(component.weaponPreset ?? 'rh120') : fedAmmo(component) : undefined;
    const choices: readonly SettingChoice[] = act === 'metal' ? metalChoices(editor.source, metals) : act === 'mount' ? optionsOf().mounts : act === 'sensor' ? optionsOf().sensors : act === 'frame' ? CHOICES.frame.of() : act === 'topPlate' ? CHOICES.topPlate.of() : component ? act === 'core' ? CHOICES.core.of(component) : CHOICES.munition.of(component) : [],
      title = act === 'metal' && metals.length > 1 ? tr`Material de ${metals.length} componentes selecionados` : CHOICES[act].title;
    choiceMenu.innerHTML = `<small>${title}</small>` + choices.map(choice =>
      `<button type="button" data-choice="${choice.id}"${choice.disabled ? ' disabled' : ''}${act === 'metal' ? metals.every(part => metalOf(part).id === choice.id) ? ' aria-current="true"' : '' : choice.id === current ? ' aria-current="true"' : ''}>` +
      (metal && (isMaterialId(choice.id) || isMetalId(choice.id)) ? `<em class="swatch" style="--tone:${tone(isMaterialId(choice.id) ? choice.id : isMetalId(choice.id) ? choice.id : 'steel')}"></em>` : '') +
      `<div><b>${choice.name}${choice.tag ? `<em>${choice.tag}</em>` : ''}</b><span>${choice.detail}</span></div></button>`).join('');
    openMenu(choiceMenu);
  }
  function choose(id: string) {
    const act = choiceMenu.dataset.act; choiceMenu.hidden = true;
    if (!isChoiceAction(act)) return;
    const part = chosen(act);
    if (act === 'metal') {
      if (!isMetalId(id)) return;
      const changing = metalParts().filter(part => takesMetal(part, id) && metalOf(part).id !== id);
      if (!changing.length) return;
      editor.commit();
      const done = attempt(() => applySettings(editor, 'metal', new Map(changing.map(part => [part.id, id]))));
      if (done && !stayed(done.refused)) toast(changing.length === 1 ? CHOICES.metal.said(id, changing[0]!) : tr`${changing.length} componentes em ${tr(METALS[id].name).toLowerCase()}.`);
      return;
    }
    if (!part) return;
    const chassis = 'model' in part ? part : null, component = 'kind' in part ? part : null;
    const current = act === 'frame' ? chassis?.metal ?? 'steel' : act === 'topPlate' ? chassis?.topPlate?.material ?? 'none' : component ? act === 'sensor' ? component.sensorMode : act === 'mount' ? component.mount?.preset : act === 'core' ? coreOf(component.weaponPreset ?? 'rh120') : fedAmmo(component) : undefined;
    if (current === id) return;
    editor.commit();
    let message = '';
    const applied = attempt(() => {
      if (act === 'frame' && chassis && isChassisMetalId(id)) { editor.setChassisMetal(id); message = CHOICES.frame.said(id); }
      else if (act === 'topPlate' && chassis && (id === 'none' || isMaterialId(id))) { editor.editProperty('topPlateMaterial', id, true); message = CHOICES.topPlate.said(id); }
      else if (act === 'sensor' && component?.kind === 'sensor' && isSensorMode(id)) { editor.editProperty('sensorMode', id, true); message = CHOICES.sensor.said(id); }
      else if (act === 'mount' && component?.kind === 'weapon' && isMountId(id)) { editor.editProperty('mountPreset', id, true); message = CHOICES.mount.said(id); }
      else if (act === 'munition' && component?.kind === 'weapon' && isAmmoId(id)) { editor.editProperty('weaponAmmo', id, true); message = CHOICES.munition.said(id, component); }
      else if (act === 'core' && component?.kind === 'weapon' && isCoreId(id)) {
        const gun = component.weaponPreset ?? 'rh120', place = weaponOptions(gun)?.core, made = place ? madeOver(gun, 'core', place.choices[place.names.indexOf(id)]!) : null;
        if (!made) { toast(tr('Essa arma não pode ser feita assim.'), true); return false; }
        editor.editProperty('weaponPreset', made, true); message = CHOICES.core.said(id);
      }
      else return false;
      return true;
    });
    if (applied) toast(message);
  }
  bar.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const ammo = target.closest<HTMLElement>('[data-ammo]')?.dataset.ammo, act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    const material = target.closest<HTMLElement>('[data-material]')?.dataset.material, choice = target.closest<HTMLElement>('[data-choice]')?.dataset.choice;
    const direction = Number(target.closest<HTMLElement>('[data-dir]')?.dataset.dir);
    if (isCartridgeId(ammo)) { chooseAmmunition(ammo); return; }
    if (isMaterialId(material)) { chooseMaterial(material); return; }
    if (choice) { choose(choice); return; }
    if (target.closest<HTMLElement>('.ammo-menu')) return;
    if (act === 'ammo') { toggleAmmunition(); return; }
    if (act === 'material') { toggleMaterials(); return; }
    if (isChoiceAction(act)) { toggleChoices(act); return; }
    closeMenus();
    const step = target.closest<HTMLElement>('.bar-step')?.dataset.step;
    if (direction && numericKey(step)) nudge(step, direction);
    else if (act === 'vertex') { editor.commit(); if (attempt(() => editor.splitPlateMiddle(editor.selection!)) === false && editor.blockedEdit) toast(editor.blockedEdit!.message, true); }
    else if (act === 'grow') {
      const drawn = attempt(() => createCompartmentFromPlate(editor, editor.selection));
      if (drawn) toast(tr('Compartimento criado.'));
      else if ((editor.blockedEdit?.until ?? 0) > Date.now()) toast(editor.blockedEdit!.message, true);
    }
    else if (act === 'swap') {
      // The arsenal opens on the family of the weapon it replaces.
      beginWeaponChoice('replace', editor.selection!);
    }
    else if (act === 'weapon') beginWeaponChoice('mount', editor.selection!);
    else if (act === 'compartment') {
      const plate = editor.selection; editor.commit();
      const gone = attempt(() => editor.removeRoom(plate!));
      if (gone) toast(gone > 1 ? tr`${gone} compartimentos removidos.` : tr('Compartimento removido.'));
    }
    else if (act === 'duplicate') duplicate();
    else if (act === 'delete') removeSelection();
    else if (act === 'join') joinPoints();
    else if (act === 'feed') feedGun();
    else if (act === 'vent') ventGun();
  });
  // Blow-out panels on the compartment of the gun chosen, or none: it becomes the gun of that name (`madeOver`).
  function ventGun() {
    const part = editor.selectionIds.size === 1 ? authored(editor.selection) : null;
    if (part?.kind !== 'weapon') return;
    const id = part.weaponPreset ?? 'rh120', vented = Boolean(weaponOf(id)?.made?.vent), made = madeOver(id, 'vent', vented ? 0 : 1);
    if (!made) { toast(tr('Essa arma não pode ser feita assim.'), true); return; }
    if (attempt(() => { editor.commit(); editor.editProperty('weaponPreset', made, true); return true; }))
      toast(vented ? tr('Painéis de alívio retirados.') : tr('Painéis de alívio instalados: a explosão da munição pronta sai pelo teto do compartimento.'));
  }
  // A stretch of the chassis removed alone is a gap, and a gap removed is chassis again: it is said which.
  function removeSelection() {
    const removal = optionsOf().actions.remove, [only] = editor.selectionIds.size === 1 ? editor.selectionIds : [],
      onlyPoint = pointOf(only), stretch = onlyPoint?.kind === 'stretch' ? onlyPoint.index : null, gap = stretch !== null && Boolean(editor.source.chassis?.points[stretch]?.gap);
    if (!removal.available) { if (removal.reason) toast(removal.reason, true); return; }
    if (attempt(() => { editor.commit(); editor.remove(); return true; }) && stretch !== null) toast(gap ? tr('Chassi de volta neste trecho.') : tr('Vão aberto neste trecho.'));
  }
  // J, or the button, joins the chosen ends. Double-clicking an edge divides it;
  // it does not detach a junction.
  function joinPoints() {
    if (!optionsOf().actions.join.available) { toast(selectedPoints(editor.selectionIds).nodes.length ? tr('Nenhuma outra ponta neste ponto: escolha mais pontas com Shift.') : tr('Escolha as pontas de chapa para juntar.'), true); return; }
    attempt(() => { editor.commit(); return editor.joinPoints(); });
  }
  // Copies use the same cursor, preview and confirmation as any installation.
  function duplicate() {
    const intent = attempt(() => { editor.commit(); return editor.duplicate(); });
    if (!intent) return;
    view.placement = { ...intent.copies[0]?.component, ...intent, kind: intent.copies[0]?.component.kind ?? 'plate' };
    view.buildTool = 'module'; renderer.modulePreview = null;
    openTask('build'); refresh();
  }
  // A point of the frame selected alone, as the bar names it.
  function pointName(key: string) {
    const point = pointOf(key)!, chassis = editor.source.chassis?.points || [];
    if (point.kind === 'node') {
      const together = new Set([point.id, ...coincidentNodes(editor.source, point.id)]),
        plates = editor.source.plates.filter(plate => together.has(plate.a) || together.has(plate.b)).length;
      return plates > 1 ? tr`Ponta de ${plates} chapas` : tr('Ponta de chapa');
    }
    if (point.kind === 'vertex') return !point.index ? tr('Frente do chassi') : point.index === chassis.length - 1 ? tr('Traseira do chassi') : tr('Ponto do chassi');
    return chassis[point.index]?.gap ? tr('Vão do chassi') : tr('Trecho do chassi');
  }
  function describeSelection(c: UiModel) {
    const pieces = c.edit ? c.selection : [], one = pieces.length === 1 ? pieces[0]!.definition : null,
      part = one && !one.material ? authored(one.id) : null, chassis = one?.chassis ? one : null,
      points = c.edit ? [...editor.selectionIds].filter(pointOf) : [], chosen = pieces.length + points.length;
    selectionEmpty.hidden = !c.edit || Boolean(chosen);
    if (!chosen) { bar.hidden = true; bar.style.display = 'none'; closeMenus(); return; }
    bar.hidden = false; bar.style.display = '';
    const review = optionsOf(), available = review.actions;
    if (more.dataset.selection !== review.key) { more.dataset.selection = review.key; closeMenus(); }
    // What the selection weighs and costs, after what a tank holds, an engine gives (`enginePower`), a thruster pushes with
    // (`thrustN`) or a tool asks of the engines (`workKw`). Points of the frame alone are named.
    const fact = bar.querySelector<HTMLElement>('.bar-fact')!, tank = one?.kind === 'fuel' ? reserveState(one) : null, room = one && !one.material ? cargoRoom(one) : 0,
      sight = one && editor.blueprint.sights.find(candidate => candidate.id === one.id),
      lead = sight ? sightText(sight) + ' · ' : tank ? count(tank.capacityLitres) + ' L · ' :
        one?.kind === 'ammo' ? count(reserveState(one).rounds) + tr(' tiros · ') :
        one?.kind === 'engine' ? enginePower(editor.blueprint, one) + ' · ' :
        one?.kind === 'thruster' ? thrust(one.thrustN) + ' · ' :
        one?.workKw !== undefined && (one.workKw ?? 0) > 0 ? 'pede ' + power(one.workKw) + ' · ' :
        room && one ? (one.kind === 'cistern' ? litres(Math.floor(room * 1000)) : volume(room)) + ' · ' : '',
      // A gun the workshop makes over tells what it is and does, in lines of their own (`gunFigures`).
      gun = part?.kind === 'weapon' ? part.weaponPreset ?? 'rh120' : null, gunLines = one && gun && part?.kind === 'weapon' ? gunFigures(one, gun, fedAmmo(part)) : null,
      figure = !pieces.length ? points.length === 1 ? pointName(points[0]!) : tr`${points.length} pontos` :
        chassis ? chassisFigures(editor.blueprint) : gunLines ? gunLines.join('\n') : one ? (one.material ? metres(one.length) + ' m · ' : lead) + pieceFigures(one) : selectionFigures(editor.blueprint, pieces.map(piece => piece.definition));
    if (fact.dataset.figure !== figure) { fact.dataset.figure = figure; fact.replaceChildren(...figure.split('\n').map(line => node('span', '', line))); }
    fact.title = !pieces.length ? '' : chassis ? tr('Comprimento · peso do chassi com a rodagem · preço') : !one ? tr('Peso e preço das peças selecionadas') : gunLines && gunLines.length > 1 ? tr('O que a arma é, até onde a munição escolhida alcança e o que ela perfura ou explode · cadência, recuo e calor do cano · alimentação · peso · preço · a munição como é feita, a velocidade de saída, o peso e o preço do tiro') : (one.material ? tr('Comprimento efetivo · ') : sight ? sight.mode === 'radar' ? tr('Alcance do radar para fora: a blindagem do veículo o bloqueia, menos a de fibra de vidro · ') : tr('Alcance da visão para fora, com tempo limpo · ') : tank ? tr('Combustível · ') : one.kind === 'engine' ? tr('Potência · ') + (editor.blueprint.chassis ? tr('todos os motores por tonelada, com tudo cheio · ') : '') : one.kind === 'thruster' ? tr('Empuxo · ') : (one.workKw ?? 0) > 0 ? tr('Potência que pede do motor · ') : room ? tr('Capacidade · ') : '') + (room ? tr('peso vazio') : tr('peso')) + tr(' · preço');
    const material = action('material'), plates = platesOf(pieces.map(piece => piece.definition)); material.hidden = !plates.length;
    if (plates.length) {
      // Plates of more than one armour say so, in the tone of the first.
      const label = plates.every(plate => plate.material === plates[0]!.material) ? tr(MATERIALS[plates[0]!.material].short) : tr('VÁRIOS');
      material.querySelector<HTMLElement>('.swatch')!.style.setProperty('--tone', tone(plates[0]!.material));
      material.title = plates.length === 1 ? tr('Trocar o material desta chapa') : tr('Trocar o material destas chapas');
      material.setAttribute('aria-label', plates.length === 1 ? tr`Material da chapa: ${label.toLowerCase()}` : tr`Material de ${plates.length} chapas: ${label.toLowerCase()}`);
      material.children[1]!.textContent = pieces.length > 1 ? `${label} · ${plates.length} ${plates.length === 1 ? 'chapa' : 'chapas'}` : label;
    } else materialMenu.hidden = true;
    // A field names how many selected pieces it affects. Unrelated pieces stay selected and unchanged.
    const settings = selectionSettings(told(pieces.map(piece => piece.definition)), { snap: editor.snap }), batch = pieces.length > 1,
      scopes = { thicknessMm: ['chapa', 'chapas'], length: ['chapa', 'chapas'], sizeScale: [tr('componente'), 'componentes'], angle: [tr('peça'), tr('peças')], axleCount: ['chassi', 'chassis'],
        frameThicknessMm: ['chassi', 'chassis'], gearScale: ['chassi', 'chassis'], suspension: ['chassi', 'chassis'], armorMm: ['chassi', 'chassis'],
        trackLength: ['esteira', 'esteiras'], trackHeight: ['esteira', 'esteiras'], trackX: ['esteira', 'esteiras'],
        topPlateThicknessMm: [tr('chapa superior'), tr('chapas superiores')], barrelLength: ['arma', 'armas'], calibre: ['arma', 'armas'], charge: ['arma', 'armas'], barrels: ['arma', 'armas'],
        projectile: ['arma', 'armas'], rate: ['arma', 'armas'], magazine: ['arma', 'armas'], cone: ['arma', 'armas'], standoff: ['arma', 'armas'], fill: ['arma', 'armas'] };
    for (const step of bar.querySelectorAll<HTMLElement>('.bar-step')) {
      const setting = settings.find(candidate => candidate.key === step.dataset.step), label = step.querySelector('label')!, less = step.querySelector<HTMLButtonElement>('[data-dir="-1"]')!, input = step.querySelector('input')!, unit = step.querySelector('em')!, more = step.querySelector<HTMLButtonElement>('[data-dir="1"]')!;
      step.hidden = !setting;
      if (!setting) continue;
      if (label.title !== setting.label) {
        label.title = setting.label; label.querySelector<HTMLElement>('.sr-only')!.textContent = setting.label; unit.textContent = setting.unit;
        input.setAttribute('aria-label', setting.label);
        less.title = tr`Diminuir · ${setting.label.toLowerCase()}`; more.title = tr`Aumentar · ${setting.label.toLowerCase()}`;
        less.setAttribute('aria-label', less.title); more.setAttribute('aria-label', more.title);
      }
      for (const key of ['min', 'max'] as const) if (input[key] !== String(setting[key])) input[key] = String(setting[key]);
      const fine = setting.key === 'angle' || !setting.fine ? 'any' : String(setting.fine);
      if (input.step !== fine) input.step = fine;
      less.disabled = !steppedSettings(setting, -1).size; more.disabled = !steppedSettings(setting, 1).size;
      const scope = step.querySelector<HTMLElement>('.bar-step-scope')!, range = step.querySelector<HTMLElement>('.bar-step-range')!, affected = setting.ids.length,
        target = `${affected} ${scopes[setting.key][affected === 1 ? 0 : 1]}`;
      scope.hidden = false;
      scope.textContent = batch ? `${setting.label} · ${target}` : setting.label;
      range.hidden = setting.value !== null;
      range.textContent = tr`Vários · ${number(setting.range[0], precision(setting))}–${number(setting.range[1], precision(setting))}${setting.unit ? ' ' + setting.unit : ''}`;
      input.title = batch ? tr`${setting.label} de ${target} · digite para igualar; −/+ ajustam cada uma` : setting.label;
      input.placeholder = setting.value === null ? '—' : '';
      if (document.activeElement !== input && input.value !== shown(setting)) input.value = shown(setting);
    }
    // One material is used by the frame and all of its running gear.
    const frame = action('frame'), frameMetal = chassis && METALS[editor.source.chassis!.metal ?? 'steel']; frame.hidden = !frameMetal;
    if (frameMetal) {
      frame.querySelector<HTMLElement>('.swatch')!.style.setProperty('--tone', tone(frameMetal.id));
      const frameLabel = tr`Material · ${tr(frameMetal.short)}`;
      if (frame.children[1]!.textContent !== frameLabel) frame.children[1]!.textContent = frameLabel;
      frame.title = tr`Material do chassi e da rodagem: ${tr(frameMetal.name).toLowerCase()} · os limites estruturais são recalculados`;
      frame.setAttribute('aria-label', tr`Material do chassi e da rodagem: ${tr(frameMetal.name).toLowerCase()}`);
    }
    const topPlate = action('topPlate'), covering = chassis && editor.source.chassis!.topPlate;
    topPlate.hidden = !chassis;
    if (chassis) {
      const material = covering && MATERIALS[covering.material], label = tr`Piso · ${material ? tr(material.short) : tr('Sem chapa')}`;
      topPlate.querySelector<HTMLElement>('.swatch')!.style.setProperty('--tone', material && covering ? tone(covering.material) : 'transparent');
      if (topPlate.children[1]!.textContent !== label) topPlate.children[1]!.textContent = label;
      topPlate.title = tr('Chapa que acompanha o chassi e fecha a carroceria · escolher material ou remover');
      topPlate.setAttribute('aria-label', label);
    }
    action('vertex').hidden = Boolean(chassis) || !available.split.available;
    action('grow').hidden = !available.grow.available;
    action('weapon').hidden = !one?.material || Boolean(chassis);
    action('compartment').hidden = !available.removeRoom.available;
    action('sensor').hidden = review.sensors.length < 2;
    const mount = action('mount'); mount.hidden = review.mounts.length < 2;
    if (!mount.hidden && part?.kind === 'weapon' && one?.kind === 'weapon') mount.title = tr`${part.mount?.preset ? tr(WEAPON_MOUNTS[part.mount.preset].name) : tr('Montagem')} · ${count(one.weaponMount.maxSpeed * 180 / Math.PI)}°/s · escolher outra montagem`;
    const munition = action('munition'); munition.hidden = part?.kind !== 'weapon' || allowedAmmo(part.weaponPreset).length < 2;
    if (!munition.hidden && part?.kind === 'weapon') {
      const name = tr(AMMO[fedAmmo(part)].name);
      if (munition.firstChild!.textContent !== name) munition.firstChild!.textContent = name;
      munition.title = tr`Munição desta arma: ${name.toLowerCase()} · só se troca aqui na Oficina`;
    }
    // A kinetic round may have its penetrator made of another material: it is told by what it is made of.
    const core = action('core'), gunId = part?.kind === 'weapon' ? part.weaponPreset ?? 'rh120' : null,
      cored = gunId && part?.kind === 'weapon' && KINETIC_AMMO.includes(fedAmmo(part)) ? coreOf(gunId) : null;
    core.hidden = !cored;
    if (cored) {
      const name = tr`Penetrador · ${tr(CORES[cored].name).toLowerCase()}`;
      if (core.firstChild!.textContent !== name) core.firstChild!.textContent = name;
      core.title = tr`Penetrador desta munição: ${tr(CORES[cored].name).toLowerCase()} · escolher outro material`;
    }
    // A gun whose ready rounds lie in a compartment may have its roof made of blow-out panels.
    const vent = action('vent'), vented = part?.kind === 'weapon' && Boolean(weaponOf(part.weaponPreset ?? 'rh120')?.made?.vent);
    vent.hidden = part?.kind !== 'weapon' || !(vented || weaponOptions(part.weaponPreset ?? 'rh120')?.panels);
    if (!vent.hidden) {
      if (vent.getAttribute('aria-pressed') !== String(vented)) vent.setAttribute('aria-pressed', String(vented));
      vent.title = vented ? tr('Painéis de alívio no teto do compartimento: se a munição pronta explodir, a explosão sai por cima e poupa o veículo · clique para retirar')
        : tr('Pôr painéis de alívio no teto do compartimento: se a munição pronta explodir, a explosão sai por cima e poupa o veículo · a arma fica mais pesada e mais cara');
    }
    const metal = action('metal'), metals = metalParts(), made = metals.length ? metalOf(metals[0]!) : null; metal.hidden = !made;
    if (made) {
      const alike = metals.every(part => metalOf(part).id === made.id), label = alike ? tr(made.short) : tr('VÁRIOS');
      metal.querySelector<HTMLElement>('.swatch')!.style.setProperty('--tone', tone(made.id));
      metal.children[1]!.textContent = batch ? `${label} · ${metals.length} ${metals.length === 1 ? tr('componente') : tr('componentes')}` : label;
      metal.title = batch ? tr`Material de ${metals.length} componentes · escolher outro` : tr('Material desta peça · escolher outro');
      metal.setAttribute('aria-label', batch ? tr`Material de ${metals.length} componentes: ${label.toLowerCase()}` : tr`Material da peça: ${label.toLowerCase()}`);
    }
    if (action('sensor').hidden && mount.hidden && munition.hidden && core.hidden && metal.hidden && frame.hidden) choiceMenu.hidden = true;
    const reserve = part?.kind === 'ammo' ? part : null, ammo = action('ammo');
    ammo.hidden = !reserve; if (!reserve) ammoMenu.hidden = true;
    if (reserve) {
      const { mass } = stock(reserve, reserve.ammoPreset ?? 'rh120'), idle = !carriedWeapons().includes(reserve.ammoPreset ?? 'rh120'),
        label = weaponName(reserve.ammoPreset ?? 'rh120');
      if (ammo.firstChild!.textContent !== label) ammo.firstChild!.textContent = label;
      ammo.toggleAttribute('data-idle', idle);
      ammo.title = tr`Escolher a munição desta caixa · ${weight(mass)} de munição` +
        (idle ? tr(' · nenhuma arma instalada usa esse calibre') : '');
      const group = new Set(carriedWeapons()).size === 1 && !idle ? secondary : primary;
      if (ammo.parentElement !== group) group.append(ammo);
    }
    action('swap').hidden = one?.kind !== 'weapon';
    action('join').hidden = !available.join.available;
    // Removing a stretch of the chassis opens a gap in it, and removing a gap closes it.
    const lone = !pieces.length && points.length === 1 ? pointOf(points[0]) : null,
      removal = lone?.kind === 'stretch' ? editor.source.chassis?.points[lone.index]?.gap ? tr('Fechar o vão: o chassi volta neste trecho') : tr('Abrir um vão neste trecho')
        : lone?.kind === 'vertex' ? tr('Tirar este ponto do chassi') : lone?.kind === 'node' ? tr('Tirar este nó, unindo as duas chapas') : '';
    action('delete').hidden = !available.remove.available;
    action('delete').querySelector<HTMLElement>('.action-label')!.textContent = tr('Remover');
    action('delete').setAttribute('aria-label', chosen > 1 ? tr`Remover ${chosen} peças selecionadas` : removal || tr('Remover'));
    action('delete').title = chosen > 1 ? tr`Remover a seleção inteira: ${chosen} peças · X` : (removal || tr('Remover')) + ' · X';
    const copyable = pieces.filter(piece => !piece.definition.chassis).length;
    action('duplicate').hidden = !copyable;
    action('delete').hidden ||= !points.length && pieces.every(piece => piece.definition.chassis);
    action('duplicate').setAttribute('aria-label', copyable > 1 ? tr`Duplicar ${copyable} peças selecionadas` : tr('Duplicar'));
    action('duplicate').title = copyable > 1 ? tr`Duplicar ${copyable} peças selecionadas · Ctrl+D` : tr('Duplicar · Ctrl+D');
    // An end of plates alone says how to join it with others, and how to draw a plate from it.
    const message = batch ? '' : chassisTopPlate(one?.id) ? tr('Use Criar compartimento para fechar a carroceria. O piso acompanha o chassi; material e espessura valem para todo o piso.') :
      chassis ? editor.source.chassis!.model === 'tracked'
        ? tr('Arraste o centro da esteira para movê-la; as pontas mudam o comprimento e a alça de cima muda a altura. O casco fica no lugar.')
        : tr`Arraste os pontos e os trechos · ${touching() ? tr('dois toques põem') : tr('dois cliques põem')} ou tiram um ponto` :
      lone?.kind === 'node' && !available.join.available ?
        (touching() ? tr('Arraste esta ponta até outra para juntar. Segure e arraste para qualquer lado para criar uma chapa a partir dela; segure outras pontas para escolhê-las.')
          : tr('Arraste esta ponta até outra para juntar. Shift+arrastar para qualquer lado cria uma chapa a partir dela; Shift+clique escolhe outras pontas.')) :
      one?.material ? available.grow.reason || tr('Arraste o meio da chapa para movê-la; as pontas mudam sua forma.') : '';
    // A gun with no round of its calibre aboard, a box too small for one and a box no gun takes are told on the piece, as
    // they are marked on it (workshop-checklist.ts `ammunitionFeed`).
    const feed = !batch && (one?.kind === 'weapon' || one?.kind === 'ammo') ? ammunitionFeed(editor.blueprint.modules) : null, of = (list: readonly CompiledModule[] | undefined) => list?.some(piece => piece.id === one?.id),
      boxless = of(feed?.unfed) && !feed!.small.some(box => (box.ammoPreset || 'rh120') === cartridgeId(one?.weaponPreset || 'rh120')),
      fault = of(feed?.small) ? tr('Pequena demais para um tiro da arma: aumente-a.') : boxless ? tr('Sem caixa de munição do calibre desta arma: não fabrica.') :
        of(feed?.unfed) ? tr('A caixa do calibre desta arma é pequena demais para um tiro: não fabrica.') :
        of(feed?.idle) ? tr('Nenhuma arma usa o calibre desta caixa: troque o calibre ou tire a caixa.') : '';
    guidance.hidden = !(fault || message); guidance.textContent = fault || message; guidance.toggleAttribute('data-marked', Boolean(fault));
    // A gun with no box of its rounds is offered one: a box no gun takes put to its rounds, or a new one to install.
    const offer = boxless && part?.kind === 'weapon' ? boxOffer(editor.blueprint, part.id) : null;
    feeder.hidden = !offer;
    if (offer) {
      const label = offer.box ? tr('Passar a caixa sem uso para este calibre') : tr('Instalar caixa deste calibre');
      if (feeder.textContent !== label) feeder.textContent = label;
      feeder.title = offer.box ? tr`A caixa de ${weaponName(offer.box.ammoPreset)} não alimenta nenhuma arma: passa a guardar ${count(offer.rounds)} tiros desta.`
        : tr`Posicionar uma caixa de munição de ${weaponName(offer.cartridge)}.`;
    }
    for (const group of fieldGroups) {
      if (group.dataset.group === 'gear') group.querySelector('b')!.textContent = chassis && editor.source.chassis?.model === 'tracked' ? tr('Esteira') : chassis && editor.source.chassis?.model === 'aircraft' ? tr('Esquis') : tr('Rodagem');
      // A gun alone says which of its settings make the gun and which its rounds.
      group.querySelector('b')!.hidden = !batch && !(chassis && ['frame', 'gear', 'topPlate'].includes(group.dataset.group ?? '')) &&
        !(gun && ['weapon', 'ammunition'].includes(group.dataset.group ?? ''));
      group.hidden = !htmlChildren(group).slice(1).some(child => !child.hidden);
    }
    more.hidden = !htmlChildren(secondary).some(child => !child.hidden);
  }

  // Aim handles of the selected weapon: the two limits of its sector, dragged about the pivot. Behind it stands the round
  // handle that turns the whole gun about it, its sector with it, as it turns any other piece (`turner`). Its breech
  // turns with the barrel: it has no angle of its own.
  const handles = Object.fromEntries((['min', 'max'] as const).map(role => {
    const handle = node('button', 'aim-handle'); handle.type = 'button'; handle.dataset.role = role; handle.title = tr('Limite do setor de tiro · arraste para ajustar');
    handle.hidden = true; viewport.append(handle); return [role, handle];
  })) as Record<'min' | 'max', HTMLButtonElement>;
  // The round handle that turns the piece selected alone (turn-handle.ts), made once and stood by whichever it is.
  const turner = node('button', 'turn-handle'); turner.type = 'button'; turner.innerHTML = icon('i-rotate'); turner.hidden = true;
  viewport.append(turner);
  const readout = node('output', 'aim-readout'); readout.hidden = true; viewport.append(readout);
  // The points of the chassis are taken on the drawing, as the nodes of the hull are (main.ts, the 'vertex' gesture): one
  // dragged says how long the chassis is, at an end, or how high the point is; or why it stops. An end of plates, a plate
  // or a group dragged, and a plate drawn with Chapa, say only why they stop; a gun moved alone says it by its preview.
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    const held = gesture();
    if (held && (held.type === 'hull' || held.type === 'edge' || held.type === 'move' || held.type === 'plate') && (held.type === 'plate' || held.moved) && !editor.weaponMovePreview) {
      const refused = (editor.blockedEdit?.until ?? 0) > Date.now() && editor.blockedEdit!.message, box = canvas.getBoundingClientRect();
      readout.toggleAttribute('data-refused', Boolean(refused)); readout.textContent = refused || ''; readout.hidden = !refused;
      if (refused) showAt(readout, event.clientX - box.left, event.clientY - box.top);
      return;
    }
    if (held?.type !== 'vertex' || !held.moved) return;
    const refused = (editor.blockedEdit?.until ?? 0) > Date.now() && editor.blockedEdit!.message, point = editor.source.chassis?.points[held.handle.index],
      height = point && tr`${metres(metresOf(point.y))} m de altura`,
      said = refused || point && (held.handle.end ? `${metres(editor.blueprint.chassis!.length)} m` + (point.y ? ` · ${height}` : '') : height),
      box = canvas.getBoundingClientRect();
    readout.toggleAttribute('data-refused', Boolean(refused)); readout.textContent = said || ''; readout.hidden = !said;
    if (said) showAt(readout, event.clientX - box.left, event.clientY - box.top);
  });
  for (const type of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(type, () => {
    if (!stretching && !grip) { readout.hidden = true; readout.removeAttribute('data-refused'); }
  });
  // Track place along the design, length and height have separate grips; it stays on the floor, and how high the hull
  // rides over it is the suspension of the bar. Their readout names the measure, or why the grip stops.
  type GearGrip = EditorGear['grip'];
  const GRIPS: Record<GearGrip, { title(spot: EditorGear): string; says(): string }> = {
    axle: { title: () => tr('Eixo · arraste para levá-lo para a frente ou para trás'), says: () => '' },
    track: { title: spot => tr`${spot.end === 'front' ? tr('Frente') : tr('Traseira')} da esteira · arraste para mudar o comprimento`,
      says: () => { const track = chassisTrack(editor.source.chassis!); return tr`${metres(track.rear - track.front)} m de comprimento`; } },
    'track-position': { title: () => tr('Centro da esteira · arraste para levá-la para a frente ou para trás'),
      says: () => { const track = chassisTrack(editor.source.chassis!); return `Horizontal ${metres((track.front + track.rear) / 2)} m`; } },
    'track-height': { title: () => tr('Altura da esteira · arraste para cima ou para baixo'),
      says: () => tr`${metres(chassisTrack(editor.source.chassis!).height)} m de altura` },
    // The skids of an aircraft: the ends of the runner, the runner with its legs, and each leg.
    skid: { title: spot => tr`${spot.end === 'front' ? tr('Frente') : tr('Traseira')} do patim · arraste para mudar o comprimento`,
      says: () => { const skids = chassisSkids(editor.source.chassis!); return tr`Patim de ${metres(skids.rear - skids.front)} m`; } },
    'skid-position': { title: () => tr('Esquis · arraste para levá-los para a frente ou para trás'),
      says: () => { const skids = chassisSkids(editor.source.chassis!); return `Horizontal ${metres((skids.front + skids.rear) / 2)} m`; } },
    'skid-leg': { title: spot => tr`Perna ${spot.index ? tr('de trás') : tr('da frente')} dos esquis · arraste para levá-la para a frente ou para trás`,
      says: () => { const { legs } = chassisSkids(editor.source.chassis!); return tr`Pernas a ${metres(legs[1]! - legs[0]!)} m uma da outra`; } },
  };
  // Where they stand in the field, each with the name of its button.
  const gripSpots = () => editor.chassisGear().map(spot => ({ ...spot, kind: spot.grip }));
  const chassisGrips = new Map<string, HTMLButtonElement>();
  let stretching: { key: string; kind: GearGrip; hit: EditorGearHit; start: Point; sx: number; sy: number; moved: boolean } | null = null;
  function finishGrip(event: PointerEvent | null = null, cancel = false) {
    if (!stretching && !grip) return;
    const refused = (!stretching || stretching.moved) &&
      (editor.blockedEdit?.until ?? 0) > Date.now() && editor.blockedEdit!.message;
    stretching = null; grip = null; turning = null; frameGesture.dragging = false;
    readout.hidden = true; readout.removeAttribute('data-refused');
    if (event?.currentTarget instanceof Element && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel) {
      editor.cancel(); editor.blockedEdit = null; refresh();
    } else {
      attempt(() => editor.commit());
      if (refused) toast(refused, true);
    }
  }
  function stretch(event: PointerEvent) {
    if (!stretching) return;
    if (!stretching.moved) {
      stretching.moved = Math.hypot(event.clientX - stretching.sx, event.clientY - stretching.sy) >= 3;
      if (!stretching.moved) return;
    }
    const at = worldAt(event), { hit, start } = stretching;
    editor.moveGear(hit, { x: hit.x + at.x - start.x, y: hit.y + at.y - start.y }); editor.preview();
    const refused = (editor.blockedEdit?.until ?? 0) > Date.now() && editor.blockedEdit!.message, said = refused || GRIPS[stretching.kind].says();
    readout.toggleAttribute('data-refused', Boolean(refused));
    readout.textContent = said; readout.hidden = !said;
  }
  // The button of a grip, made the first time it is shown.
  function chassisGrip(key: string, kind: GearGrip) {
    if (chassisGrips.has(key)) return;
    const handle = node('button', 'chassis-grip'); handle.type = 'button'; handle.dataset.kind = kind; handle.hidden = true;
    handle.textContent = kind === 'track-position' || kind === 'skid-position' ? '↔' : kind === 'track-height' ? '↕' : '';
    handle.style.cursor = kind === 'track-height' ? 'ns-resize' : 'ew-resize';
    viewport.append(handle);
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !chassisShown()) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      editor.commit(); const hit = editor.gearHandle(key); if (!hit) return; stretching = { key, kind, hit, start: worldAt(event), sx: event.clientX, sy: event.clientY, moved: false };
      editor.begin(); frameGesture.dragging = true;
    });
    handle.addEventListener('pointermove', event => { if (stretching?.key === key) stretch(event); });
    const release = (event: PointerEvent) => { if (stretching?.key === key) finishGrip(event); };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) handle.addEventListener(type, release);
    chassisGrips.set(key, handle);
  }
  // The gaps of the chassis, dashed where its frame would be, in the workshop: a stretch of it removed is one, and one
  // removed is chassis again (Editor.remove).
  const gapMarks = node('div', 'chassis-gaps');
  gapMarks.hidden = true; canvas.after(gapMarks);
  let gapsSeen = '';
  function showGaps(camera: Camera | FramedCamera) {
    const gaps = (renderer.ready && editing() ? editor.chassisGaps() : []).filter(stretch => stretch.gap).map(({ a, b }) => {
      const from = camera.toScreen(a.x, a.y), to = camera.toScreen(b.x, b.y);
      return { left: from.x, top: from.y, width: Math.hypot(to.x - from.x, to.y - from.y), angle: Math.atan2(to.y - from.y, to.x - from.x) };
    }), drawn = JSON.stringify(gaps);
    gapMarks.hidden = !gaps.length;
    if (drawn === gapsSeen) return;
    gapsSeen = drawn;
    gapMarks.replaceChildren(...gaps.map(({ left, top, width, angle }) => {
      const mark = node('i');
      Object.assign(mark.style, { left: left + 'px', top: top + 'px', width: width + 'px', transform: `rotate(${angle}rad)` }); return mark;
    }));
  }
  // In symmetric editing (symmetry.ts), the axis the frame is mirrored about: a thin line through the construction.
  const axisMark = node('div', 'symmetry-axis');
  axisMark.hidden = true; canvas.after(axisMark);
  let axisSeen = '';
  function showAxis(camera: Camera | FramedCamera) {
    const frame = renderer.ready && editing() && editor.symmetric ? editor.blueprint.frame : null;
    axisMark.hidden = !frame;
    if (!frame) return;
    const ys = [...frame.nodes, ...editor.chassisPoints().map(point => point.foot), ...editor.blueprint.modules].map(point => point.y),
      top = camera.toScreen(frame.origin.x, Math.max(...ys, frame.origin.y) + 1), bottom = camera.toScreen(frame.origin.x, Math.min(...ys, frame.origin.y) - 1),
      seen = [top.x, top.y, bottom.y].map(value => value.toFixed(1)).join('|');
    if (seen === axisSeen) return;
    axisSeen = seen;
    Object.assign(axisMark.style, { left: top.x + 'px', top: Math.min(top.y, bottom.y) + 'px', height: Math.abs(bottom.y - top.y) + 'px' });
  }
  // What a finger installs is told beside the piece, above it: the panel that tells it too is closed on a phone.
  const placing = node('output', 'aim-readout'); placing.hidden = true; viewport.append(placing);
  // A readout of the point a pointer is on stands clear of it: well above a finger, which covers what is under it.
  // `gap`, the pixels it keeps from a point no finger is on.
  // Beside a finger, a readout too wide for the room there is narrowed to it, in more lines.
  function showAt(label: HTMLElement, x: number, y: number, gap?: number) {
    const cover = renderer.camera.cover(), area = { left: cover.left, top: cover.top, right: canvas.clientWidth - cover.right,
        bottom: canvas.clientHeight - cover.bottom },
      place = () => clearOf(x, y, label.offsetWidth, label.offsetHeight, area, gap, gap);
    label.style.maxWidth = '';
    let at = place();
    if (at.room !== undefined && at.room < label.offsetWidth) { label.style.maxWidth = Math.max(120, at.room) + 'px'; at = place(); }
    label.style.left = at.x + 'px'; label.style.top = at.y + 'px';
  }
  // The piece the round handle turns: one selected alone with an angle of its own, which every component has; a plate is
  // shaped by its ends instead.
  const turnable = (): CompiledModule | null => {
    const piece = editing() && view.buildTool === 'select' && editor.selectionIds.size === 1 ? editor.selected : null;
    return piece?.kind && authored(piece.id) ? piece : null;
  };
  const mounted = () => {
    const piece = turnable();
    return piece?.kind === 'weapon' && piece.weaponMount ? piece : null;
  };
  function sectorGrip(event: PointerEvent) {
    const weapon = mounted(); if (!grip || grip === 'turn' || !weapon) return;
    const box = canvas.getBoundingClientRect(); gripAt = { x: event.clientX - box.left, y: event.clientY - box.top };
    editWeaponSector({ editor, weapon, grip, point: worldAt(event), readout, refresh });
  }
  for (const role of ['min', 'max'] as const) {
    const handle = handles[role];
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !mounted()) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      editor.commit(); editor.begin(); grip = role; frameGesture.dragging = true; readout.hidden = false; sectorGrip(event);
    });
    handle.addEventListener('pointermove', event => { if (grip === role) sectorGrip(event); });
    const release = (event: PointerEvent) => {
      if (grip === role) finishGrip(event);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) handle.addEventListener(type, release);
  }
  // Where the round handle stands, `lever` round from the heading of `piece`: behind a gun, a quarter past the radius of
  // its sector, clear of the two handles of the sector; off any other piece, TURN_CLEAR pixels past its side — twice that
  // for a finger —, however small the piece is drawn.
  function turnSpot(piece: CompiledModule, lever: number) {
    const way = piece.angle + lever, distance = piece.kind === 'weapon' && piece.weaponMount ? sectorRadius(piece) * 1.25
      : (Math.abs(Math.sin(lever)) > .5 ? piece.height : piece.width) / 2 + reach(TURN_CLEAR) / renderer.board.camera.zoom;
    return { x: piece.x + Math.cos(way) * distance, y: piece.y + Math.sin(way) * distance };
  }
  // The lever of the handle not in hand: behind a gun, on its bore; above any other piece, or below, behind or before
  // it, the first of these that no panel over the field covers.
  function restingLever(piece: CompiledModule) {
    if (piece.kind === 'weapon' && piece.weaponMount) return Math.PI;
    const camera = renderer.board.camera, cover = camera.cover(), margin = reach(12);
    return TURN_LEVERS.find(lever => {
      const at = turnSpot(piece, lever), spot = camera.toScreen(at.x, at.y);
      return spot.x >= cover.left + margin && spot.x <= camera.width - cover.right - margin &&
        spot.y >= cover.top + margin && spot.y <= camera.height - cover.bottom - margin;
    }) ?? TURN_LEVERS[0];
  }
  // The round handle dragged: the piece turns about its pivot (`turnedHeading`), with the lever and the magnets it had
  // at the press, as one change of the history. A heading refused is said beside the handle, in the colour of a refusal,
  // until another is taken; the piece stays as it last stood. Only pressed, it leaves the piece as it is.
  function turnBy(event: PointerEvent) {
    const piece = turnable(); if (!piece || !turning) return;
    const box = canvas.getBoundingClientRect(); gripAt = { x: event.clientX - box.left, y: event.clientY - box.top };
    if (turning.from) {
      if (Math.hypot(event.clientX - turning.from.x, event.clientY - turning.from.y) < 3) return;
      turning.from = null;
    }
    const heading = turnedHeading(piece, turning.lever, worldAt(event), turning.magnets, event.shiftKey && turnsFree(piece), turnStep(piece));
    if (heading === turning.refused) return;
    turning.refused = turnPiece(editor, heading) ? heading : null;
    const refused = turning.refused !== null && editor.blockedEdit?.message;
    readout.toggleAttribute('data-refused', Boolean(refused)); readout.textContent = refused || ''; readout.hidden = !refused;
    if (refused) refresh();
  }
  turner.addEventListener('pointerdown', event => {
    const piece = turnable();
    if (event.button !== 0 || !piece) return;
    event.preventDefault(); capture(turner, event.pointerId);
    editor.commit(); editor.begin(); grip = 'turn'; frameGesture.dragging = true;
    turning = { lever: restingLever(piece), magnets: turnMagnets(editor.blueprint.plates, piece), from: { x: event.clientX, y: event.clientY }, refused: null };
    turnBy(event);
  });
  turner.addEventListener('pointermove', event => { if (grip === 'turn') turnBy(event); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) turner.addEventListener(type, event => { if (grip === 'turn') finishGrip(event); });
  window.addEventListener('blur', () => finishGrip());
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key !== 'Escape' || !editing() || !stretching && !grip) return;
    event.preventDefault(); event.stopImmediatePropagation(); finishGrip(null, true);
  }, true);

  // Handles and placement feedback follow the camera.
  function follow() {
    const camera = renderer.board.camera, screen = (point: Point) => camera.toScreen(point.x, point.y);
    guides.render(camera, { active: editing(), shaping: Boolean(frameGesture.shaping), frameGuide: frameGuide && !inspector.hidden }); showGaps(camera); showAxis(camera); paintOffer();
    // The grips of the gear stand on it.
    const spots = renderer.ready && (stretching || chassisShown()) ? gripSpots() : [];
    for (const spot of spots) chassisGrip(spot.key, spot.kind);
    for (const [key, handle] of chassisGrips) {
      const at = spots.find(spot => spot.key === key);
      handle.hidden = !at || Boolean(stretching && stretching.key !== key);
      if (!at || handle.hidden) continue;
      const title = GRIPS[at.kind].title(at);
      if (handle.title !== title) { handle.title = title; handle.setAttribute('aria-label', title); }
      const spot = screen(at);
      handle.style.left = spot.x + 'px'; handle.style.top = spot.y + 'px';
      if (stretching) showAt(readout, spot.x, spot.y - 18);
    }
    // A resting pointer keeps aiming at what it covers while the camera travels.
    if (frameGesture.pointer && !editing() && aim?.active()) {
      const seen = camera.x + ':' + camera.y + ':' + camera.zoom;
      if (seen !== cameraSeen) { cameraSeen = seen; aim.at(worldAt(frameGesture.pointer)); }
    }
    const weapon = renderer.ready ? mounted() : null, points = weapon && handlePoints(weapon);
    for (const role of ['min', 'max'] as const) {
    const handle = handles[role];
      handle.hidden = !points?.[role] || Boolean(grip && grip !== role);
      if (!points?.[role]) continue;
      const spot = screen(points[role]);
      handle.style.left = spot.x + 'px'; handle.style.top = spot.y + 'px';
      // Under a finger, the readout keeps clear of the finger, wherever on the arc it has dragged the handle to.
      if (grip === role) touching() && gripAt ? showAt(readout, gripAt.x, gripAt.y) : showAt(readout, spot.x, spot.y);
    }
    // The round handle stands by the piece selected alone, the lever it was taken by kept while it is in hand.
    const piece = renderer.ready ? turnable() : null;
    turner.hidden = !piece || Boolean(grip && grip !== 'turn');
    if (!turner.hidden && piece) {
      const title = tr`Girar ${piece.kind === 'weapon' ? 'a arma' : tr('a peça')} · arraste, de 15 em 15°; com Shift, livre`,
        spot = screen(turnSpot(piece, grip === 'turn' && turning ? turning.lever : restingLever(piece)));
      if (turner.title !== title) { turner.title = title; turner.setAttribute('aria-label', title); }
      turner.style.left = spot.x + 'px'; turner.style.top = spot.y + 'px';
      if (grip === 'turn') touching() && gripAt ? showAt(readout, gripAt.x, gripAt.y) : showAt(readout, spot.x, spot.y);
    }
    // The piece a finger is installing shows above the finger, and what it says of the place above the piece.
    const preview = editing() && touching() ? renderer.modulePreview : null;
    placing.hidden = !preview?.feedback;
    if (preview?.feedback) {
      placing.textContent = preview.feedback;
      placing.toggleAttribute('data-refused', Boolean(preview.overlap || preview.refused));
      const spot = screen(preview), half = Math.max(preview.width || 0, preview.height || 0) * camera.zoom / 2;
      showAt(placing, spot.x, spot.y - half, 8);
    }
  }

  // A short project summary opens the full figures in Projeto.
  const stats = node('button', 'build-stats'), status = node('div', 'field-status');
  stats.type = 'button'; stats.setAttribute('aria-label', tr('Revisão do projeto')); stats.onclick = project;
  status.innerHTML = '<i></i><b></b><span></span>'; status.hidden = true;
  viewport.append(stats);
  // The weapon reading shares the controls' footer. Its real height
  // keeps every line clear of the field and pedals, without separate offsets.
  document.querySelector<HTMLElement>('#field-dock')!.append(status);
  function describeConstruction(c: UiModel) {
    stats.hidden = !c.edit;
    if (!c.edit) return;
    frameGuide = c.selection.some(piece => piece.definition.material);
    // The weight over what the chassis carries is the one figure in red: why is in its title.
    const html = workshopContext([], c.figures).summary.map(({ label, value, title, over }) =>
      `<span${title ? ` title="${title}"` : ''}${over ? ' data-over' : ''}><small>${label}</small>${value}</span>`).join('') + '<svg aria-hidden="true"><use href="#i-next"/></svg>';
    if (stats.dataset.html !== html) { stats.dataset.html = html; stats.innerHTML = html; }
  }
  // The gun in hand, over the field: nothing is said where nothing fires, nor in the test of armour, which has no gun
  // in hand. Inspecting a test, the piece picked stands in its place, its dot in the colour of what is left of it; and a
  // design that became a wreck in a test is told so there, its dot as that of a gun that does not fire.
  function describeArmament(c: UiModel) {
    const told = c.inspection || c.wreck;
    status.hidden = !c.gunTold && !told;
    if (status.hidden) return;
    const dot = status.querySelector('i')!, title = status.querySelector('b')!, detail = status.querySelector('span')!, runtime = c.bindings['weapon-runtime']!;
    status.dataset.state = c.inspection ? 'inspecting' : String(runtime.data?.state ?? '');
    dot.style.background = c.inspection?.color ?? '';
    title.textContent = told ? told.title : weaponOf(c.weapon.preset) ? weaponName(c.weapon.preset) : tr('Arma');
    detail.textContent = told ? told.detail : String(c.bindings['ammo-tag']?.text ?? '') + ' · ' + String(runtime.text ?? '');
    detail.hidden = !detail.textContent;
  }

  // A dialog opens at its top, wherever the first focus tried to scroll it.
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog'))
    new MutationObserver(() => { if (dialog.open) dialog.scrollTop = 0; })
      .observe(dialog, { attributes: true, attributeFilter: ['open'] });

  return {
    follow,
    render(c: UiModel) {
      arsenal.classList.toggle('active', c.edit && view.buildTool === 'module' && view.placement.kind === 'weapon');
      describeSelection(c); describePlacementSettings(); describeConstruction(c); describeArmament(c); describeParts(c);
    },
    // Ctrl+D copies as the button of the bar does.
    duplicate() { if (editing()) duplicate(); },
    remove() { if (editing()) removeSelection(); },
    selectAll,
    cancelWeaponChoice: clearWeaponChoice,
    // The arsenal installs a new weapon, or replaces the one chosen with "Trocar".
    replaceWeapon: weaponChoice.replaceWeapon,
  };
}
