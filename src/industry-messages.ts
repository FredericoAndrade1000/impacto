import { FACILITIES, missingIndustry } from './industry.ts';
import { phrase, phraseList } from './i18n.ts';
import type { WireMessage } from './message-contract.ts';
import type { FacilityId, IndustryLevels, IndustrialAdmission } from './industry.ts';

export const levelLabel = (level: number): string => ['—', 'I', 'II', 'III'][level] ?? String(level);
export const facilityName = (facility: FacilityId, level: number): WireMessage => phrase`${phrase(FACILITIES[facility])} ${levelLabel(level)}`;
export function industryRequirementMessage(admission: IndustrialAdmission, levels: IndustryLevels): WireMessage {
  if (admission.oversized) return phrase`O projeto excede o porte máximo de ${phrase(FACILITIES[admission.oversized])}. Reduza a massa vazia ou as dimensões.`;
  const missing = missingIndustry(admission, levels);
  return phrase`Requer ${phraseList(missing.map(need => facilityName(need.facility, need.level)))}. Veja as melhorias da base.`;
}
