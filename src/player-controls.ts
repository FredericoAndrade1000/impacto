import { tr } from './i18n.ts';
import { driveIntent } from './ui-model.ts';
import { number } from './format.ts';
import { aimLimitText } from './weapon-presentation.ts';
import { MODULES, MATERIALS, isMaterialId } from './materials.ts';
import { GROUND_SURFACES } from './ground-impact.ts';
import type { Point } from './math.ts';
import type { StickPosition } from './touch.ts';
import type { WeaponSettings } from './weapons.ts';
import type { FlightSolution } from './ballistic-contract.ts';
import type { ControlArmament, UiView } from './ui-model.ts';
import type { GroundSurface } from './ground-impact.ts';

export interface PlayerControlInput {
  pointerFire: boolean; keyFire: boolean; spacePan: boolean; stick: StickPosition | null;
  driveKeys: Set<string>; lookKeys: Set<string>; lookReleased: Set<string>;
}
export type { ControlArmament } from './ui-model.ts';
export interface PlayerCommandPayloads {
  trigger: { active: boolean; aim: Point; weapon: ControlArmament; queue: boolean; cancel: boolean };
  drive: { throttle: number; brake: number; rise?: number };
  fire: { aim: Point; weapon: ControlArmament; queue: boolean };
}
interface PlayerControlEffects {
  get(selector: string): Pick<HTMLElement, 'textContent'>;
  manualControl(): boolean;
  armament(): ControlArmament;
  command<Type extends keyof PlayerCommandPayloads>(type: Type, data: PlayerCommandPayloads[Type]): Promise<unknown>;
  toast(message: string, error?: boolean): void;
  requestUI(): void;
  flies(): boolean;
}
export interface PlayerRenderer {
  aim: Point;
  weapon: WeaponSettings;
  aimingSolution(): FlightSolution | null;
  weaponObstruction(state: undefined, solution: FlightSolution | null): { reason: string } | null;
  impactPrediction(state: undefined, solution: FlightSolution): ReturnType<typeof import('./impact-preview.ts').predictImpact>;
}
export interface PlayerControlOptions {
  renderer: PlayerRenderer;
  view: Pick<UiView, 'mode'>; input: PlayerControlInput; effects: PlayerControlEffects;
}
export interface TriggerOptions { queue?: boolean; cancel?: boolean }
function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  throw error;
}
function knownGround(surface: unknown): surface is GroundSurface {
  return typeof surface === 'string' && Object.hasOwn(GROUND_SURFACES, surface);
}
function groundName(surface: unknown): string {
  return knownGround(surface) ? GROUND_SURFACES[surface].name : tr('Solo');
}
function armourName(id: string): string {
  if (!isMaterialId(id)) throw new TypeError('Unknown armour material ' + id);
  return tr(MATERIALS[id].name);
}

// Keyboard, pointer and touch share trigger/drive intent and its release.
export function createPlayerControls({ renderer, view, input, effects }: PlayerControlOptions) {
  const $ = (selector: string) => effects.get(selector);
  function syncTrigger({ queue = false, cancel = false }: TriggerOptions = {}): void {
    if (!effects.manualControl()) return;
    effects.command('trigger', { active: input.pointerFire || input.keyFire, aim: renderer.aim, weapon: effects.armament(), queue, cancel }).catch((error: unknown) => { effects.toast(errorText(error), true); input.pointerFire = input.keyFire = false; });
  }
  function syncDrive() {
    if (!effects.manualControl()) return;
    const { throttle, brake, rise } = driveIntent(input, effects.flies());
    effects.command('drive', { throttle, brake, ...(rise === undefined ? {} : { rise }) }).catch((error: unknown) => effects.toast(errorText(error), true));
    effects.requestUI();
  }
  function stopControls() {
    input.pointerFire = input.keyFire = input.spacePan = false; input.stick = null;
    input.driveKeys.clear(); input.lookKeys.clear(); input.lookReleased.clear();
    syncTrigger({ cancel: true }); syncDrive();
  }
  function updateBallisticHUD() {
    const solution = renderer.aimingSolution();
    const obstruction = renderer.weaponObstruction(undefined, solution);
    const charge = renderer.weapon.variableCharge && solution && renderer.weapon.charges.find(c => c.value === solution.charge);
    const chargeInfo = charge && solution ? ` · ${charge.name}${renderer.weapon.charge === 'auto' ? ' (auto)' : ''} · ${number(solution.speed, 0)} m/s` : '';
    const impact = solution?.reachable ? renderer.impactPrediction(undefined, solution) : null, f = number;
    // A refused request has no impact forecast. Range/near can still explain the native nearest-round miss.
    const short = solution?.miss ?? 0;
    $('#ballistic-info').textContent = obstruction ? obstruction.reason : !solution ? tr('Armamento indisponível') : !solution.reachable ?
      `${aimLimitText(solution)}${solution.limit === 'sector' ? '' : ' · a ' + f(short) + tr(' m da mira')}${chargeInfo}` :
      `${f(solution.distance)} m · voo ${f(solution.time < 0.1 ? solution.time * 1000 : solution.time)} ${solution.time < 0.1 ? 'ms' : 's'}${chargeInfo}`;
    // Where the round first touches, how inclined it arrives (0° is square on) and how much armour lies in its way. It is
    // read in a test alone, where no ally stands in the line.
    $('#impact-info').textContent = solution?.reachable === false ? '' : !impact ? tr('Sem impacto até a mira') : [
      impact.owner.type === 'module' ? tr(MODULES[impact.owner.object.kind].name) : impact.owner.type === 'ground' ?
        groundName(impact.surface) : armourName(impact.owner.material.id),
      f(impact.angleDegrees) + '°', impact.traversedMm ? f(impact.traversedMm) + ' mm' : '', impact.bounce ? 'ricochete' : ''].filter(Boolean).join(' · ');
  }
  // A trigger pulled on an aim the gun cannot reach says why nothing leaves the barrel.
  function explainSilence() {
    const solution = renderer.aimingSolution();
    if (solution?.reachable === false) effects.toast(aimLimitText(solution) + tr(': a arma não dispara.'));
  }
  async function fire() {
    if (!effects.manualControl()) return;
    try {
      await effects.command('fire', { aim: renderer.aim, weapon: effects.armament(), queue: true });
    } catch (error) { effects.toast(errorText(error), true); input.pointerFire = input.keyFire = false; }
  }


  function installTrigger(trigger: HTMLElement): void {
    trigger.onclick = event => { if (event.detail === 0) fire(); };
    trigger.addEventListener('pointerdown', event => { if (view.mode === 'test' && event.button === 0) { input.pointerFire = true; trigger.setPointerCapture(event.pointerId); syncTrigger({ queue: true }); explainSilence(); } });
    for (const type of ['pointerup', 'pointercancel'] as const) trigger.addEventListener(type, () => { input.pointerFire = false; syncTrigger(); });

  }
  return { syncTrigger, syncDrive, stopControls, fire, updateBallisticHUD, explainSilence, installTrigger };
}
