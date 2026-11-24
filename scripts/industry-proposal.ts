// Economic sensitivity scenarios reuse the live catalogue; they are not a second admission policy.
import { INDUSTRY_UPGRADES, INDUSTRIAL_ENVELOPES, MATERIAL_LEVELS } from '../src/industry.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
export interface IndustryUpgrade { id: string; requires: readonly string[]; cost: SupplyBill }
export const INDUSTRY_PROPOSAL = { envelopes: INDUSTRIAL_ENVELOPES, materialLevels: MATERIAL_LEVELS,
  upgrades: INDUSTRY_UPGRADES.map(upgrade => ({ ...upgrade, requires: INDUSTRY_UPGRADES.filter(previous => previous.facility === upgrade.facility && previous.level === upgrade.level - 1).map(previous => previous.id) })) };
