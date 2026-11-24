import { createConstruction } from '../src/construction-templates.ts';
import type { CommanderModel } from './commander-contract.ts';

// A small, explicit catalogue of normal player designs. Quotes and execution
// share the same source; Native still owns admission, weight, cost and weapons.
export function commanderBlueprint(model: CommanderModel) {
  return model === 'scout-20mm' ? createConstruction('scout', { preset: 'rh202', armourScale: 2 }) : createConstruction(model);
}
