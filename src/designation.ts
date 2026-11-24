import { tr } from './i18n.ts';
import { WEAPON_PRESETS, weaponOf } from './weapons.ts';
import type { WeaponFamilyId, WeaponPreset } from './weapons.ts';
import type { ModuleKind } from './materials.ts';
import type { SensorMode } from './combat-sensors.ts';
import type { CompiledConstruction } from './construction-contract.ts';

// What a construction is called on the field. A design keeps the name its author gave it, which
// says nothing of what it is to whoever meets it: on the field a construction is named for its
// kind and the calibre of its largest gun. The kind follows the family of that gun
// and what the construction rides on; one with no gun that drives is named for what it carries in,
// a constructor for its building tool, a supply truck for its supply piece, an ore truck for its hopper or a tanker for its cistern;
// with none, for its tool — an excavator on tracks, a backhoe on wheels, a drill rig — or for what it watches with — a radar
// or a listening vehicle; the camera every vehicle has names none —, is an aircraft for its thrusters, and a transport
// with nothing of these; one that neither drives nor flies is a chassis, and what is no vehicle is a casemate, an oil
// well for its drill, a mining post for its excavator or a bare structure.
const KINDS: Record<WeaponFamilyId, string> = {
  cannon: tr('Tanque'), autocannon: tr('Blindado'), machinegun: tr('Viatura'), grenade: tr('Viatura'),
  rocket: tr('Lançador'), mortar: tr('Porta-morteiro'), howitzer: tr('Obuseiro'),
};

export function designation(blueprint: Pick<CompiledConstruction, 'modules' | 'preset'>): string {
  const has = (kind: ModuleKind): boolean => blueprint.modules.some(m => m.kind === kind), senses = (mode: SensorMode): boolean => blueprint.modules.some(m => m.kind === 'sensor' && m.sensorMode === mode),
    main = blueprint.modules.filter(m => m.kind === 'weapon').map(m => weaponOf(m.weaponPreset) || WEAPON_PRESETS.rh120)
      .reduce<WeaponPreset | null>((largest, gun) => largest && largest.caliberMm >= gun.caliberMm ? largest : gun, null),
    calibre = main ? ' ' + String(main.caliberMm).replace('.', ',') + ' mm' : '';
  if (blueprint.preset !== 'vehicle') return main ? tr('Casamata') + calibre : has('drill') ? tr('Poço de petróleo') : has('excavator') ? tr('Posto de mineração') : tr('Estrutura');
  // A cannon on wheels hunts tanks; it is not one.
  if (main) return (main.family === 'cannon' && !has('track') ? tr('Caça-tanques') : KINDS[main.family]) + calibre;
  if (!(has('engine') && (has('track') || has('wheel'))) && !has('thruster')) return tr('Chassi');
  if (has('builder')) return tr('Veículo construtor');
  if (has('paver')) return tr('Pavimentadora');
  if (has('blade')) return tr('Motoniveladora');
  if (has('supply')) return tr('Caminhão de suprimentos');
  if (has('hopper')) return tr('Caminhão de minério');
  if (has('cistern')) return tr('Caminhão-cisterna');
  if (has('excavator')) return has('track') ? tr('Escavadeira') : tr('Retroescavadeira');
  if (has('drill')) return tr('Perfuratriz');
  if (senses('radar')) return tr('Viatura de radar');
  if (senses('sound')) return tr('Viatura de escuta');
  if (has('thruster')) return tr('Aeronave');
  return tr('Transporte');
}
