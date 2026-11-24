import { CONSTRUCTION_TEMPLATES, FIXTURE_TEMPLATES } from './construction-template-catalogue.ts';
import { validateStructuredConstruction, compileStructuredConstruction } from './structured-construction.ts';
import { automaticFinish } from './vehicle-details.ts';
import { constructionCatalogue } from './construction-admission.ts';
import { initNativeDynamics, nativeTemplateSource } from './native-dynamics.ts';
import type { TemplateId } from './construction-template-catalogue.ts';
import type { WeaponPresetId } from './weapons.ts';
import type { SensorMode } from './combat-sensors.ts';

export interface TemplateOptions { preset?: WeaponPresetId; dual?: boolean; highArc?: boolean;
  sensorModes?: SensorMode[]; stretch?: number; armourScale?: number; engineScale?: number }

await initNativeDynamics();

// Display names are catalogued assets; Rust alone authors dimensions, slots,
// equipment, sensors and sectors.
export const templateCatalogue = () => ({ ...constructionCatalogue(),
  templates: [...CONSTRUCTION_TEMPLATES, ...FIXTURE_TEMPLATES].map(({ id, name }) => ({ id, name })) });
export function structuredTemplateSource(id: TemplateId, options: TemplateOptions = {}) {
  const source = validateStructuredConstruction(nativeTemplateSource({ version: 1, id, options, catalogue: templateCatalogue() }));
  return { ...source, appearance: automaticFinish(compileStructuredConstruction(source)) };
}
export function createStructuredTemplate(id: TemplateId, options: TemplateOptions = {}) {
  return validateStructuredConstruction(structuredTemplateSource(id, options));
}
