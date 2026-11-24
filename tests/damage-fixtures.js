import { managedWorld } from './mechanical-queries.js';
import { damageConstruction } from '../scripts/damage-fixtures.ts';
export { damageConstruction, face, interior } from '../scripts/damage-fixtures.ts';
export const damageWorld = (test, options = {}) => managedWorld(test, damageConstruction(options));
