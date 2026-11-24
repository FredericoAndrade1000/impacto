// The name of a gun as the page writes it. A gun of the catalogue goes by its own name. A gun made over goes by what it
// became, its kind and its calibre, with the gun it was made of beside them; then only what those do not already say, in
// the order it is named (weapons.ts `WeaponVariantId`): how many barrels it turns, how many rounds its feed holds, its
// charge and its projectile, how its rounds are made, its barrel where its calibre is still its reference's, and its rate.
// So are its rounds named, their cartridge (`cartridgeId`): a box of steel rods is not one of tungsten.
import { tr, translate } from './i18n.ts';
import { number } from './format.ts';
import { CORES, WEAPONS, WEAPON_PRESETS, coreOf, isWeaponPresetId, weaponFigures, weaponOf } from './weapons.ts';
import type { WeaponId, WeaponPresetId, WeaponFeed } from './weapons.ts';

// The model each gun of the catalogue a gun may be made of is known by: its maker's name for it.
const MODELS: Readonly<Partial<Record<WeaponPresetId, string>>> = { minimi: 'Minimi', fnmag: 'MAG', mk44: 'Bushmaster II', m2hb: 'M2',
  m242: 'Bushmaster', rh202: 'Rh202', m230lf: 'M230', mk35: 'MK35', rh120: 'Rheinmetall', mk19: 'Mk 19', m224: 'M224', m252: 'M252', m119: 'M119', m777: 'M777' };
const model = (base: WeaponPresetId) => MODELS[base] ?? tr(WEAPON_PRESETS[base].name);

// How a gun is fed, as the core states it among what the workshop shows of it (game_variant.rs `Feed::of`). A launcher
// has none.
export type GunFeed = WeaponFeed & { kind: NonNullable<WeaponFeed['kind']> };
export function weaponFeed(id: WeaponId): GunFeed | null {
  const feed = weaponFigures(id)?.feed;
  return feed?.kind ? { ...feed, kind: feed.kind } : null;
}
// How many rounds a feed holds, in words: a belt of so many, or a magazine.
export const feedName = (feed: Pick<GunFeed, 'kind' | 'rounds'>) => feed.kind === 'belt' ? tr('cinta de {0}', feed.rounds) :
  feed.kind === 'magazine' ? tr('pente de {0}', feed.rounds) : tr('carregada à mão');

export function weaponName(id: WeaponId): string {
  const gun = weaponOf(id), made = gun?.made, base = gun?.variantOf, named = id.split('|')[0];
  // A name the core refuses is written as the gun it names was made of.
  if (!gun) return isWeaponPresetId(named) ? tr(WEAPON_PRESETS[named].name) : id;
  if (!made || !base) return translate(gun.name);
  const parts = [tr('{0} · {1} mm ({2})', tr(WEAPONS[gun.family].name), number(gun.caliberMm, 2), model(base))], feed = weaponFeed(id);
  if (made.barrels) parts.push(tr('{0} canos', made.barrels));
  if (made.magazine && feed) parts.push(feedName(feed));
  if (made.charge) parts.push(tr('carga de {0} %', made.charge));
  if (made.projectile) parts.push(tr('projétil de {0} %', made.projectile));
  const core = made.core ? coreOf(id) : null;
  if (core) parts.push(tr('penetrador de {0}', tr(CORES[core].name).toLowerCase()));
  if (made.cone) parts.push(tr('cone de {0} %', made.cone));
  if (made.standoff) parts.push(tr('afastamento de {0} cones', number(made.standoff / 10, 1)));
  if (made.fill) parts.push(tr('explosivo de {0} %', made.fill));
  if (made.length && !made.calibre) parts.push(tr('cano de {0} m', number(made.length / 100, 2)));
  if (made.rate) parts.push(tr('cadência de {0} %', made.rate));
  return parts.join(' · ');
}
