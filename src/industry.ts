import { freezeRecord } from './immutable.ts';
import { choosesMetal } from './materials.ts';
import type { MaterialId, MetalId } from './materials.ts';
import type { CanonicalConstruction, CompiledConstruction } from './construction-contract.ts';
import type { SupplyBill, StockId } from './economy-contract.ts';
import type { WeaponId } from './weapons.ts';
import { WEAPON_PRESETS, weaponOf } from './weapons.ts';

export const FACILITIES = Object.freeze({ workshop: 'Oficina', hangar: 'Hangar', processing: 'Processamento' });
export type FacilityId = keyof typeof FACILITIES;
export interface IndustryLevels { workshop: 1 | 2 | 3; hangar: 0 | 1 | 2; processing: 1 | 2 | 3 }
export const BASIC_INDUSTRY: Readonly<IndustryLevels> = Object.freeze({ workshop: 1, hangar: 0, processing: 1 });
export const FULL_INDUSTRY: Readonly<IndustryLevels> = Object.freeze({ workshop: 3, hangar: 2, processing: 3 });
export interface IndustrialEnvelope { kg: number; length: number; height: number }
export const INDUSTRIAL_ENVELOPES = freezeRecord({
  workshop: [null, { kg: 20000, length: 10, height: 6 }, { kg: 40000, length: 14, height: 8 }, { kg: 80000, length: 18, height: 10 }],
  hangar: [null, { kg: 5000, length: 9, height: 5 }, { kg: 15000, length: 14, height: 8 }],
} satisfies Record<'workshop' | 'hangar', (IndustrialEnvelope | null)[]>);
export const MATERIAL_LEVELS = Object.freeze({ steel: 1, glass: 1, concrete: 1, aluminum: 2, hha: 2, plastic: 2,
  titanium: 3, ceramic: 3, fiberglass: 3 } satisfies Record<MaterialId | MetalId, number>);
export const INDUSTRY_UPGRADES = freezeRecord([
  { id: 'workshop-ii', facility: 'workshop', level: 2, name: 'Oficina II', description: 'Veículos e construções de até 40 t e 14 × 8 m. Libera radar, canhões automáticos acima de 20 mm, lançadores de apoio e obuseiro de 105 mm.',
    cost: { ferro: 60000, ligas: 2000, silica: 3000, combustivel: 300 }, seconds: 120 },
  { id: 'workshop-iii', facility: 'workshop', level: 3, name: 'Oficina III', description: 'Projetos terrestres de até 80 t e 18 × 10 m. Libera canhão de 120 mm e obuseiro de 155 mm.',
    cost: { ferro: 220000, ligas: 8000, silica: 12000, combustivel: 600 }, seconds: 240 },
  { id: 'hangar-i', facility: 'hangar', level: 1, name: 'Hangar I', description: 'Permite fabricar aeronaves pequenas de até 5 t e 9 × 5 m, com turbinas. Armamento e materiais avançados usam as outras instalações.',
    cost: { ferro: 60000, ligas: 8000, silica: 5000, combustivel: 300 }, seconds: 120 },
  { id: 'hangar-ii', facility: 'hangar', level: 2, name: 'Hangar II', description: 'Aeronaves de até 15 t e 14 × 8 m, para projetos maiores de transporte e apoio.',
    cost: { ferro: 180000, ligas: 18000, silica: 12000, combustivel: 500 }, seconds: 240 },
  { id: 'processing-ii', facility: 'processing', level: 2, name: 'Processamento II', description: 'Libera escolhas de alumínio, aço de alta dureza e plástico. Permite outras relações de peso e proteção, sem alterar a velocidade de refino.',
    cost: { ferro: 50000, ligas: 4000, silica: 5000, combustivel: 200 }, seconds: 120 },
  { id: 'processing-iii', facility: 'processing', level: 3, name: 'Processamento III', description: 'Libera escolhas de titânio, cerâmica e fibra de vidro, onde a peça permite esses materiais.',
    cost: { ferro: 160000, ligas: 16000, silica: 14000, combustivel: 500 }, seconds: 240 },
] as const satisfies readonly { id: string; facility: FacilityId; level: number; name: string; description: string; cost: SupplyBill; seconds: number }[]);
export type IndustryUpgrade = typeof INDUSTRY_UPGRADES[number];
export type UpgradeId = IndustryUpgrade['id'];
export const upgradeById = (id: unknown): IndustryUpgrade | undefined => INDUSTRY_UPGRADES.find(upgrade => upgrade.id === id);
export const isUpgradeId = (id: unknown): id is UpgradeId => Boolean(upgradeById(id));
export function isIndustryLevels(value: unknown): value is IndustryLevels {
  return value !== null && typeof value === 'object' && 'workshop' in value && [1, 2, 3].includes(Number(value.workshop)) &&
    'hangar' in value && [0, 1, 2].includes(Number(value.hangar)) && 'processing' in value && [1, 2, 3].includes(Number(value.processing)) &&
    typeof value.workshop === 'number' && typeof value.hangar === 'number' && typeof value.processing === 'number';
}
export const nextUpgrade = (levels: IndustryLevels, facility: FacilityId): IndustryUpgrade | undefined =>
  INDUSTRY_UPGRADES.find(upgrade => upgrade.facility === facility && upgrade.level === levels[facility] + 1);
export const upgradeShortages = (stock: SupplyBill, cost: SupplyBill): { id: StockId; amount: number }[] =>
  (Object.keys(cost) as StockId[]).filter(id => stock[id] + 1e-6 < cost[id]).map(id => ({ id, amount: Math.ceil(cost[id] - stock[id]) }));

export function weaponIndustryLevel(preset: WeaponId): 1 | 2 | 3 {
  // A gun made over is made where a gun of what it became is made: by its kind and its calibre.
  const weapon = weaponOf(preset) ?? WEAPON_PRESETS.rh120;
  if (weapon.family === 'cannon' || weapon.family === 'howitzer' && weapon.caliberMm >= 155) return 3;
  if (weapon.family === 'howitzer' || weapon.family === 'autocannon' && weapon.caliberMm > 20 ||
    weapon.family === 'grenade' || preset === 'hydra70') return 2;
  return 1;
}
export interface IndustryRequirement { facility: FacilityId; level: number }
export interface IndustrialAdmission {
  requirements: IndustryRequirement[];
  measurement: CompiledConstruction['manufacturing'];
  oversized: 'workshop' | 'hangar' | null;
}
// Read Native-canonical authoring for chosen materials and families, and Native
// manufacturing metrics for dry mass/geometry. Intrinsic turbine titanium is not
// a material choice. Payload, cosmetic details and aiming arcs do not change tier.
export function industrialAdmission(source: Pick<CanonicalConstruction, 'plates' | 'components' | 'chassis'>, compiled: Pick<CompiledConstruction, 'manufacturing'>): IndustrialAdmission {
  const levels: Record<FacilityId, number> = { workshop: 0, hangar: 0, processing: 1 },
    material = (id: MaterialId | MetalId): void => { levels.processing = Math.max(levels.processing, MATERIAL_LEVELS[id]); };
  for (const plate of source.plates) material(plate.material);
  if (source.chassis) {
    material(source.chassis.metal ?? 'steel');
    if (source.chassis.topPlate) material(source.chassis.topPlate.material);
  }
  for (const part of source.components) {
    if (choosesMetal(part)) material(part.metal ?? 'steel');
    if (part.kind === 'thruster') levels.hangar = Math.max(levels.hangar, 1);
    if (part.kind === 'sensor' && part.sensorMode === 'radar') levels.workshop = Math.max(levels.workshop, 2);
    if (part.kind === 'weapon') levels.workshop = Math.max(levels.workshop, weaponIndustryLevel(part.weaponPreset ?? 'rh120'));
    if (part.kind === 'ammo') levels.workshop = Math.max(levels.workshop, weaponIndustryLevel(part.ammoPreset ?? 'rh120'));
  }
  const body = source.chassis?.model === 'aircraft' ? 'hangar' : 'workshop', { emptyKg, envelope } = compiled.manufacturing;
  if (![emptyKg, envelope.lengthM, envelope.heightM].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid Native manufacturing metrics');
  const level = INDUSTRIAL_ENVELOPES[body].findIndex(limit => limit && emptyKg <= limit.kg + 1e-6 && envelope.lengthM <= limit.length + 1e-6 && envelope.heightM <= limit.height + 1e-6);
  levels[body] = Math.max(levels[body], level < 0 ? 1 : level);
  return { requirements: (Object.keys(FACILITIES) as FacilityId[]).filter(facility => levels[facility] > 0).map(facility => ({ facility, level: levels[facility] })),
    measurement: compiled.manufacturing, oversized: level < 0 ? body : null };
}
export const missingIndustry = (admission: IndustrialAdmission, levels: IndustryLevels): IndustryRequirement[] =>
  admission.requirements.filter(requirement => levels[requirement.facility] < requirement.level);
