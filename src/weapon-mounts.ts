import { WEAPONS, WEAPON_PRESETS, weaponOf } from './weapons.ts';
import type { WeaponFamilyId, WeaponFamilySpec, WeaponPreset, WeaponId } from './weapons.ts';
import type { MessageKey } from './message-contract.ts';

export interface WeaponMountSpec {
  name: MessageKey; families: readonly WeaponFamilyId[]; ratedMass: number; min: number; max: number;
  maxSpeed: number; armourMm?: number; depthM?: number; cost: number; surface: 'side' | 'roof' | 'top'; exposed?: boolean;
}

// Construction capacities only. Rust derives the receiver, swept occupancy,
// armour passage and mantlet from this catalogue at admission; the receiver and
// the room its recoil takes behind it are the weapon's own (weapons.ts).
// Any enclosed mount serves on any face a weapon may stand on. `surface` is the kind of face it is the usual one
// for — the side of a body, front or rear, its roof, or the top of a plate — and only the workshop reads it, to offer
// a weapon dropped on a face the mount of its own that is made for that face.
// An `exposed` mount stands out in the open on the top of a plate, a room's or a deck's: a post bolted on the plate
// and on it the gun whole, receiver and barrel, with no room behind it, no port through the armour and no armour
// about it. The gun turns on the post over the face to below level on either side. Its own metal, which it is paid
// and weighed for, is the post: `depthM` deep across the body.
export const WEAPON_MOUNTS = Object.freeze({
  'light-trunnion': { name: 'Montagem leve', families: ['machinegun', 'grenade', 'rocket', 'mortar'], ratedMass: 300,
    min: -.65, max: .65, maxSpeed: Math.PI / 3, armourMm: 12, cost: 650, surface: 'side' },
  'medium-trunnion': { name: 'Montagem média', families: ['autocannon'], ratedMass: 650,
    min: -.60, max: .60, maxSpeed: Math.PI / 4, armourMm: 30, cost: 1800, surface: 'side' },
  'heavy-trunnion': { name: 'Montagem pesada', families: ['cannon', 'howitzer'], ratedMass: 5000,
    min: -.60, max: .60, maxSpeed: Math.PI / 6, armourMm: 65, cost: 4500, surface: 'side' },
  'elevated-trunnion': { name: 'Montagem de artilharia', families: ['howitzer'], ratedMass: 5000,
    min: -.60, max: .60, maxSpeed: Math.PI / 6, armourMm: 25, cost: 3500, surface: 'roof' },
  'roof-mortar': { name: 'Montagem de morteiro', families: ['mortar'], ratedMass: 120,
    min: -.60, max: .60, maxSpeed: Math.PI / 6, armourMm: 12, cost: 900, surface: 'roof' },
  pintle: { name: 'Suporte no teto', families: ['machinegun', 'grenade'], ratedMass: 100,
    min: -1.75, max: 1.75, maxSpeed: Math.PI / 2, depthM: .05, cost: 250, surface: 'top', exposed: true },
} satisfies Record<string, WeaponMountSpec>);
export type WeaponMountId = keyof typeof WEAPON_MOUNTS;
export const defaultWeaponMount = (preset: WeaponId) => ({ machinegun: 'light-trunnion', grenade: 'light-trunnion',
  rocket: 'light-trunnion', autocannon: 'medium-trunnion', cannon: 'heavy-trunnion',
  howitzer: 'elevated-trunnion', mortar: 'roof-mortar' } satisfies Record<WeaponFamilyId, WeaponMountId>)[(weaponOf(preset) ?? WEAPON_PRESETS.rh120).family];
// A mount takes any gun of a kind it is made for, and grows with one heavier than the weight it is rated for
// (`ratedMass`): as much costlier as the gun is heavier, and slower to lay by the square root of that. The core reckons
// the same (game_mounts.rs `rated`).
const installed = (preset: WeaponId, mount: Pick<WeaponMountSpec, 'ratedMass'>) => weaponOf(preset)?.installedMassKg ?? mount.ratedMass;
// A faster mounting does not make its artillery mechanism elevate faster.
export const weaponMountSpeed = (preset: WeaponId, mount: Pick<WeaponMountSpec, 'maxSpeed' | 'ratedMass'>) => {
  const model: WeaponPreset | undefined = weaponOf(preset), family: WeaponFamilySpec | undefined = model ? WEAPONS[model.family] : undefined;
  return Math.min(mount.maxSpeed, family?.servoMaxSpeed ?? mount.maxSpeed) * Math.min(1, Math.sqrt(mount.ratedMass / installed(preset, mount)));
};
export const weaponMountCost = (preset: WeaponId, mount: Pick<WeaponMountSpec, 'cost' | 'ratedMass'>) =>
  mount.cost * Math.max(1, installed(preset, mount) / mount.ratedMass);
export const compatibleWeaponMounts = (preset: WeaponId) => {
  const model: WeaponPreset | undefined = weaponOf(preset);
  // Object.entries preserves the own keys of this closed catalogue.
  return (Object.entries(WEAPON_MOUNTS) as [WeaponMountId, WeaponMountSpec][]).filter(([, mount]) =>
    model !== undefined && mount.families.includes(model.family));
};
