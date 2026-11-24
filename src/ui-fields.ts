import { tr } from './i18n.ts';
import { WEAPON_PRESETS } from './weapons.ts';
import { escapeHTML } from './dom-view.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { metres, distance } from './format.ts';
import type { OptionEntry } from './dom-view.ts';

export interface FieldDescriptor { id: string; label: string; key?: string; options?: readonly OptionEntry[] }
export interface PlacementFieldDescriptor extends FieldDescriptor { key: 'weaponPreset' | 'ammoPreset' | 'sensorMode' }
const namedOptions = (catalogue: Readonly<Record<string, { name: string }>>): OptionEntry[] => Object.entries(catalogue).map(([id, item]) => [id, item.name]);
const field = (id: string, label: string, details: Omit<FieldDescriptor, 'id' | 'label'> = {}): FieldDescriptor => ({ id, label, ...details });
const placement = (id: string, label: string, key: PlacementFieldDescriptor['key'], options: readonly OptionEntry[]): PlacementFieldDescriptor => ({ id, label, key, options });

// These descriptors generate the forms of the side panel: each is a list to choose from. The settings of a
// piece already installed are not here: they are on the bar that floats over it (`piece-settings.ts`).
export const PLACEMENT_FIELDS: readonly PlacementFieldDescriptor[] = [
  placement('new-weapon-preset', tr('Arma'), 'weaponPreset', namedOptions(WEAPON_PRESETS)),
  placement('new-ammo-preset', 'Calibre', 'ammoPreset', namedOptions(WEAPON_PRESETS)),
  placement('new-sensor-mode', tr('Detecção'), 'sensorMode', Object.entries(SENSOR_MODES).map(([mode, sensor]) =>
    [mode, tr`${sensor.name} · até ${metres(sensor.range)}`])),
];
// How far from the gun the round of the test of armour strikes, in metres (armour-strike.ts `arrival`): it says how fast
// the round comes.
export const STRIKE_DISTANCES = Object.freeze([10, 100, 500, 1000, 2000]);
export const TEST_FIELDS = [
  field('mounted-weapon', tr('Arma instalada')),
  field('propellant-charge', tr('Carga propulsora')),
  field('detonation', tr('Detonação')),
  field('test-distance', tr('Distância'), { options: STRIKE_DISTANCES.map(n => [n, distance(n)]) }),
];
export function fieldHTML({ id, label, options = [] }: FieldDescriptor): string {
  return `<label class="field-label" id="field-${id}" for="${id}">${label}<select id="${id}">${options.map(([value, text]) =>
    `<option value="${escapeHTML(value)}">${escapeHTML(text)}</option>`).join('')}</select></label>`;
}
// Each place of the page that holds a form (`data-field`) gets it.
export function mountForms(): void {
  const fields = new Map([...PLACEMENT_FIELDS, ...TEST_FIELDS].map(field => [field.id, field]));
  for (const host of document.querySelectorAll<HTMLElement>('[data-field]')) {
    const descriptor = host.dataset.field && fields.get(host.dataset.field);
    if (!descriptor) throw new Error('Campo ausente: ' + host.dataset.field);
    host.outerHTML = fieldHTML(descriptor);
  }
}
