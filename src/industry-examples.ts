import { createStructuredTemplate } from './structured-templates.ts';
import { compileManufacture } from './structured-construction.ts';
import { designBill } from './economy.ts';
import { industrialAdmission } from './industry.ts';
import type { UpgradeId } from './industry.ts';
import type { ConstructionTemplateId } from './construction-template-catalogue.ts';
import type { MaterialId } from './materials.ts';

// Examples are ordinary workshop projects: the same Native admission, cost and
// installed-capacity rules apply when the player later manufactures them.
export const INDUSTRY_EXAMPLES = {
  'workshop-ii': { template: 'ifv', name: 'Veículo de apoio' },
  'workshop-iii': { template: 'heavy', name: 'Blindado de esteiras' },
  'hangar-i': { template: 'air-scout', name: 'Aeronave de reconhecimento' },
  'hangar-ii': { template: 'air-supply', name: 'Transportador aéreo de suprimentos' },
  'processing-ii': { template: 'scout', name: 'Explorador com aço de alta dureza', material: 'hha' },
  'processing-iii': { template: 'scout', name: 'Explorador com blindagem de titânio', material: 'titanium' },
} as const satisfies Record<UpgradeId, { template: ConstructionTemplateId; name: string; material?: MaterialId }>;

function compileExample(id: UpgradeId) {
  const choice = INDUSTRY_EXAMPLES[id], draft = createStructuredTemplate(choice.template);
  draft.name = choice.name;
  if ('material' in choice) for (const plate of draft.plates) if (plate.material === 'steel') plate.material = choice.material;
  const { construction, compiled } = compileManufacture(draft);
  return { source: construction, compiled, cost: designBill(compiled), admission: industrialAdmission(construction, compiled) };
}
export type IndustryExample = ReturnType<typeof compileExample>;
const examples = new Map<UpgradeId, IndustryExample>();
// No preview compile in the frame loop. Each fixed example is admitted once,
// on demand, and opening it copies the document so edits cannot change the cache.
export function industryExample(id: UpgradeId): IndustryExample {
  let example = examples.get(id);
  if (!example) { example = compileExample(id); examples.set(id, example); }
  return example;
}
export const industryExampleSource = (id: UpgradeId): IndustryExample['source'] => structuredClone(industryExample(id).source);
