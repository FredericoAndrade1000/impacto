import type { PlateDefinition } from './mesh.ts';
import type { CompiledConstruction, CompiledPiece, CompiledModule, WithAbsentSlots } from './construction-contract.ts';
import type { DrawingScene, DrawingPlate, DrawingDefinition, DrawingModule } from './scene-drawing-contract.ts';
export type PartDefinition = WithAbsentSlots<PlateDefinition | DrawingDefinition | CompiledModule | DrawingModule>;
type PartObservation = DrawingPlate | DrawingModule;
export interface PartHealth { fraction: number; status: string; label: string; percent: string; color: string }
export interface PartView<Definition extends PartDefinition = PartDefinition, Observation extends PartObservation | null = PartObservation | null> { id: string; definition: Definition; physical: Observation; actorId: string; name: string; readonly health: PartHealth | null }
import { tr } from './i18n.ts';
import { MATERIALS, MODULES } from './materials.ts';
import { sceneFrame } from './scene-frame.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { chassisName } from './chassis.ts';
import { number } from './format.ts';
import { weaponName } from './weapon-names.ts';

export { number } from './format.ts';
// The plates of a chassis are the chassis to the player: named for its model.
export const partName = (part: PartDefinition) => part.chassis ? tr(chassisName(part.chassis.model)) : part.material ? tr('Chapa de ') + tr(MATERIALS[part.material].name).toLowerCase() :
  part.kind === 'weapon' ? (part.weaponPreset ? weaponName(part.weaponPreset) : tr(MODULES.weapon.name)) : part.kind === 'sensor' ?
    tr((part.sensorMode ? SENSOR_MODES[part.sensorMode] : SENSOR_MODES.visual).name) : tr(MODULES[part.kind].name);

// The shares of what is left of a piece the condition of it is told by: of a plate, under `SPENT` its material is spent and
// under `HOLED` it is shot through over a good share of it; of a component, under `WORN` it is damaged.
const SPENT = .03, HOLED = .65, WORN = .95;
function health(part: PartDefinition, physical: PartObservation | null): PartHealth | null {
  if (!physical) return null;
  const plate = !('kind' in physical);
  let fraction: number;
  if ('kind' in physical) {
    const { health, maxHealth } = physical;
    if (health === undefined || maxHealth === undefined) return null;
    fraction = health / maxHealth;
  } else fraction = physical.integrity;
  let status = tr('Íntegro');
  if (!('kind' in physical) && part.material) {
    status = fraction < SPENT ? tr('Material esgotado') : fraction < HOLED ? tr('Perfuração extensa') : fraction < .98 ? tr('Perfuração parcial') :
      physical.marks.length ? MATERIALS[part.material].brittle ? tr('Trincas e marcas de impacto') : tr('Marcas de impacto') : status;
  } else if ('kind' in physical) status = physical.detonated && ['fuel', 'ammo'].includes(physical.kind) ? tr('Inutilizado · reserva perdida') : physical.barrelDisabled ? tr('Cano avariado · não dispara') :
    physical.health === 0 ? tr('Inutilizado') : physical.burning ? tr('Em chamas') : physical.attached === false ? tr('Solto da estrutura') :
      physical.elevationDisabled ? tr('Mecanismo de elevação travado') : physical.mantletHoles?.length ? tr('Mantelete perfurado') :
        fraction < WORN ? tr('Avariado') : physical.marks?.length ? tr('Marcas leves · funcionando') : status;
  const percent = Number((fraction * 100).toFixed(2));
  return { fraction, status, label: plate ? tr('Material restante') : tr('Integridade'),
    percent: fraction < 1 && percent === 100 ? '>99,99%' : number(percent, 2) + '%',
    color: fraction > .7 ? '#b4c786' : fraction > .35 ? '#d9b178' : '#cb8761' };
}
// How a piece on the field, as the frame tells it, colours the picture of its construction in the column (squad-ux.ts):
// `lost` — torn off, burst, shot away, or a plate whose material is spent —, `hurt` — a component damaged or whose gun does
// not fire or lay, a plate shot through over a good share of it —, or nothing, whole: a few small holes in a plate are no
// damage to tell there.
export function damageTone(physical: PartObservation) {
  if (physical.attached === false) return 'lost';
  if (!('kind' in physical)) return physical.integrity < SPENT ? 'lost' : physical.integrity < HOLED ? 'hurt' : '';
  if (physical.detonated) return 'lost';
  if (physical.health === undefined) return '';
  if (!(physical.health > 0)) return 'lost';
  return physical.barrelDisabled || physical.elevationDisabled || physical.maxHealth !== undefined && physical.health / physical.maxHealth < WORN ? 'hurt' : '';
}

// A definition and its optional live state resolve once. The bar of the workshop, the inspection and
// the commands retain the same reference ID instead of finding another representation.
export function partViews(blueprint: CompiledConstruction, state?: null | undefined, ids?: Iterable<string> | null): PartView<CompiledPiece, null>[];
export function partViews(blueprint: CompiledConstruction, state: DrawingScene | null | undefined, ids?: Iterable<string> | null): PartView[];
export function partViews(blueprint: CompiledConstruction, state: DrawingScene | null | undefined = null, ids: Iterable<string> | null = null): PartView[] {
  const wanted = ids === null ? null : [...ids];
  if (wanted?.length === 0) return [];
  const frame = sceneFrame(state || blueprint), parts = wanted ? wanted.flatMap(id => { const part = frame.byId.get(id); return part ? [part] : []; }) : frame.parts;
  return parts.map(({ definition: part, data }) => {
    const physical = state ? ('definition' in data ? data : 'actorId' in data ? data : null) : null;
    let known: PartHealth | null | undefined;
    return { id: part.id, definition: part, physical, actorId: physical?.actorId || 'local', name: partName(part),
      get health() { return known === undefined ? known = health(part, physical) : known; } };
  });
}
