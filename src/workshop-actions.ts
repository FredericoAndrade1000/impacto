import type { AuthoredConstruction, CompiledConstruction } from './construction-contract.ts';
import type { EditorPlateSpan } from './editor.ts';
import type { WeaponId } from './weapons.ts';

export interface WorkshopAction { available: boolean; reason: string }
import { tr } from './i18n.ts';
import { carriesRoom, coincidentNodes } from './frame-editing.ts';
import { selectedPoints } from './frame-points.ts';
import { WEAPON_PRESETS, weaponOf, cartridgeId } from './weapons.ts';
import { chassisTopPlate } from './chassis-editing.ts';

const unavailable = (reason: string): WorkshopAction => ({ available: false, reason });
const available = (): WorkshopAction => ({ available: true, reason: '' });

export function workshopActions({ source, blueprint, spans }: { source: AuthoredConstruction; blueprint: CompiledConstruction; spans: readonly EditorPlateSpan[] }, ids: Iterable<string>) {
  const selected = new Set(ids), plates = source.plates.filter(plate => selected.has(plate.id)),
    floor = selected.size === 1 && chassisTopPlate([...selected][0]!),
    one = selected.size === 1 ? plates[0] || (floor && {id:[...selected][0]}) : null,
    edge = one && spans.find(span => span.id === one.id),
    result = { split: unavailable(''), grow: unavailable(''), removeRoom: unavailable(''), remove: unavailable(''),
      join: unavailable(''),
      title: edge ? !edge.normal ? tr('Chapa') :
        edge.normal.y < -.5 ? tr('Piso') : edge.normal.y > .5 ? tr('Teto') : edge.normal.x < 0 ? tr('Chapa frontal') : tr('Chapa traseira') : '' };
  const components = source.components.filter(part => selected.has(part.id)), points = selectedPoints(selected);
  if (floor || plates.length || components.length || points.nodes.length || points.vertices.length || points.stretches.length) result.remove = available();
  // Ends join explicitly when selected together, or when one has others at
  // exactly its authored coordinate. Division stays an edge operation.
  if (points.nodes.length > 1 || points.nodes.length === 1 && coincidentNodes(source, points.nodes[0]!).length) result.join = available();
  if (!one || !edge) return result;
  if (!floor) result.split = available();
  if (carriesRoom(edge)) result.grow = available();
  if (!floor && edge.normal && blueprint.rooms.length) result.removeRoom = available();
  if (floor) result.title = tr('Piso do chassi');
  return result;
}

// Prefer a weapon without a stocked compatible box, then preserve a compatible
// choice. No installed weapon means the player's catalogue choice stays useful.
export function suggestedAmmunition(blueprint: CompiledConstruction, current: WeaponId = 'rh120'): WeaponId {
  const modules = blueprint.modules || [], presets = [...new Set(modules.filter(part => part.kind === 'weapon').map(part => cartridgeId(part.weaponPreset)))],
    stocked = new Set(modules.filter(part => part.kind === 'ammo' && part.rounds > 0).map(part => part.ammoPreset));
  return presets.find(preset => !stocked.has(preset)) || (presets.includes(current) ? current : presets.at(-1)) ||
    (weaponOf(current) ? current : 'rh120');
}
