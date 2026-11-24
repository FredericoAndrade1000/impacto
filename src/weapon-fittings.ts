import type { WeaponPresetId } from './weapons.ts';

export interface TubeFitting {
  kind: 'gas' | 'handle' | 'gasblock' | 'sight' | 'jacket' | 'collar' | 'ribbed' | 'support' | 'sleeve' | 'band' |
    'evacuator' | 'mrs' | 'basecap' | 'clamp' | 'grip' | 'lug';
  from: number; to: number; d: number;
  y?: number; reach?: number; rows?: number; pitch?: number;
}
export interface TubeMuzzle {
  kind: 'hider' | 'crown' | 'collar' | 'rings' | 'brake' | 'baffles' | 'velocity' | 'plain' | 'lip' | 'bad' | 'baffle' | 'endcap' | 'fairing';
  length: number; d: number;
}
export interface TubeFittingsSpec {
  radius: number; barrel: [number, number]; muzzle: TubeMuzzle; fittings: readonly TubeFitting[];
  sleeve?: boolean; pod?: boolean;
}

// What each gun carries along its barrel, as the real one does, for its picture only: none of it is a solid, a mass or a
// limit. Every fitting stands at its real distance from the trunnion and has its real diameter, in metres; the muzzle
// device is measured back from the muzzle. `radius` is the real half-width of the thickest section before the trunnion,
// what the tube's box stands for, and every diameter is drawn in proportion to that box: a gun whose box is thinner than
// the real one is drawn thinner throughout. A fitting that does not end before the muzzle device on the barrel the gun
// carries is left out, so a barrel shorter than the real one shows the fittings nearest its trunnion and its muzzle.
// [S] a published figure, [D] derived from published figures or a maker's drawing, [E] an estimate from photographs.
// The research behind these numbers and its sources: tamanhos.md, leves.md and pesadas.md (the arsenal at real size).
export const TUBE_FITTINGS: Readonly<Record<WeaponPresetId, TubeFittingsSpec>> = Object.freeze({
  // FN Minimi, vehicle model: a bare barrel with its gas block and front sight, the gas cylinder under it, the folding
  // carrying handle, and a short flash hider [E; barrel 0.465 m S, hider 0.055 m D].
  minimi: { radius: .0175, barrel: [.027, .022], muzzle: { kind: 'hider', length: .055, d: .03 },
    fittings: [{ kind: 'gas', from: 0, to: .23, d: .015, y: -.021 }, { kind: 'handle', from: .06, to: .15, d: .026, reach: .05 },
      { kind: 'gasblock', from: .22, to: .27, d: .036, y: -.008 }, { kind: 'sight', from: .3, to: .315, d: .026, reach: .045 }] },
  // FN MAG coaxial (M240C): the barrel bare, the gas cylinder under it into the regulator, the front sight just behind
  // the conical flash hider [E; barrel 0.551 m S, hider 0.08 m D].
  fnmag: { radius: .02, barrel: [.034, .028], muzzle: { kind: 'hider', length: .08, d: .034 },
    fittings: [{ kind: 'gas', from: 0, to: .28, d: .018, y: -.026 }, { kind: 'gasblock', from: .27, to: .325, d: .044, y: -.012 },
      { kind: 'sight', from: .37, to: .39, d: .03, reach: .05 }] },
  // Browning M2HB with its quick-change barrel: the perforated barrel support out of the trunnion block, the bearing at
  // its mouth, the carrying handle on the barrel, the muzzle plain [E from side photographs; barrel 1.143 m S].
  m2hb: { radius: .0225, barrel: [.046, .036], muzzle: { kind: 'crown', length: .035, d: .042 },
    fittings: [{ kind: 'jacket', from: 0, to: .2, d: .075, rows: 3 }, { kind: 'collar', from: .2, to: .228, d: .054 },
      { kind: 'handle', from: .28, to: .42, d: .046, reach: .075 }] },
  // Mk 19 Mod 3: a short heavy barrel screwed in by its ribbed root, a collar at its muzzle [E; barrel 0.413 m S].
  mk19: { radius: .03, barrel: [.06, .056], muzzle: { kind: 'collar', length: .045, d: .066 },
    fittings: [{ kind: 'ribbed', from: 0, to: .1, d: .066, pitch: .014 }] },
  // M242 Bushmaster: the barrel-support tube with its two holes, 1.281 m from the rear of the gun and so 0.687 m out of
  // its 0.594 m receiver [S Northrop Grumman drawing], the clamp at its mouth, then a long tapering barrel and a short
  // suppressor [E].
  m242: { radius: .05, barrel: [.068, .055], muzzle: { kind: 'rings', length: .1, d: .09 },
    fittings: [{ kind: 'support', from: 0, to: .687, d: .1 }, { kind: 'collar', from: .687, to: .725, d: .082 }] },
  // Mk44 Bushmaster II: the perforated support out to 1.680 m from the rear, 0.995 m out of its 0.685 m receiver [S NG
  // drawing], the clamp, the barrel and a slotted brake [E].
  mk44: { radius: .055, barrel: [.08, .068], muzzle: { kind: 'brake', length: .12, d: .1 },
    fittings: [{ kind: 'jacket', from: 0, to: .995, d: .11, rows: 3 }, { kind: 'collar', from: .995, to: 1.035, d: .09 }] },
  // M230LF: the ribbed recoil sleeve out of the receiver, a slim barrel, the stack of rings of its suppressor [E from the
  // NG drawing and photographs; barrel 1.524 m S].
  m230lf: { radius: .045, barrel: [.05, .044], muzzle: { kind: 'rings', length: .2, d: .075 },
    fittings: [{ kind: 'ribbed', from: 0, to: .25, d: .09, pitch: .022 }] },
  // Rheinmetall Rh202: the barrel nut, a plain barrel and the multi-baffle brake [E; barrel 2.002 m S].
  rh202: { radius: .03, barrel: [.055, .046], muzzle: { kind: 'baffles', length: .2, d: .07 },
    fittings: [{ kind: 'collar', from: 0, to: .07, d: .06 }] },
  // Rheinmetall MK35-E: the cradle sleeve, a long barrel tapering from 0.09 to 0.07 m, and at its muzzle the unit that
  // measures each round's speed and sets its fuze, with the brake in front [E by the KDG's; barrel 3.15 m S].
  mk35: { radius: .05, barrel: [.09, .072], muzzle: { kind: 'velocity', length: .25, d: .15 },
    fittings: [{ kind: 'sleeve', from: 0, to: .45, d: .1 }, { kind: 'band', from: .45, to: .48, d: .1 }] },
  // Rheinmetall 120 mm L44 as on the Leopard 2A4, measured on the side drawing of its twin the M256 (trunnion to muzzle
  // 4.25 m): the glass-fibre thermal sleeve from 0.234 m down to 0.19 m with a joint at 1.3 m, the concentric bore
  // evacuator from 1.75 to 2.51 m, 0.33 m across, another joint, the collar of the muzzle reference sensor with its
  // mirror box on top, and the bare muzzle 0.25 m long and 0.153 m across [D].
  rh120: { radius: .115, barrel: [.234, .19], sleeve: true, muzzle: { kind: 'plain', length: .25, d: .153 },
    fittings: [{ kind: 'band', from: 1.29, to: 1.38, d: .238 }, { kind: 'evacuator', from: 1.75, to: 2.51, d: .33 },
      { kind: 'band', from: 3.12, to: 3.18, d: .206 }, { kind: 'mrs', from: 3.93, to: 4, d: .21, reach: .16 }] },
  // M224A1: the cap at the base of the tube, the cooling rings over its lower third, the collar the mount holds it by,
  // a lip at the muzzle [E; tube 1.016 m S].
  m224: { radius: .037, barrel: [.074, .07], muzzle: { kind: 'lip', length: .03, d: .08 },
    fittings: [{ kind: 'basecap', from: 0, to: .06, d: .086 }, { kind: 'ribbed', from: .07, to: .33, d: .074, pitch: .018 },
      { kind: 'clamp', from: .56, to: .64, d: .09 }] },
  // M252A1: the base cap, the deep cooling fins over its breech end, the mount's collar and the blast attenuator on the
  // muzzle [E; tube 1.28 m S].
  m252: { radius: .05, barrel: [.094, .09], muzzle: { kind: 'bad', length: .09, d: .108 },
    fittings: [{ kind: 'basecap', from: 0, to: .07, d: .1 }, { kind: 'ribbed', from: .08, to: .42, d: .1, pitch: .02 },
      { kind: 'clamp', from: .76, to: .85, d: .11 }] },
  // M119A3: the tube heavier at its breech end, the threaded collar and the double-baffle brake [E; tube 3.20 m S].
  m119: { radius: .09, barrel: [.18, .13], muzzle: { kind: 'baffle', length: .25, d: .2 },
    fittings: [{ kind: 'band', from: .55, to: .6, d: .18 }, { kind: 'collar', from: 2.69, to: 2.75, d: .15 }] },
  // The 155 mm 39-calibre cannon as it stands on a self-propelled mount (the M284 of the M109A7, the tube class of the
  // M777's M776): the bore evacuator about the middle of the tube, the threaded collar and the great double-baffle brake
  // [E from side photographs; tube 6.05 m S, brake 113 kg S].
  m777: { radius: .12, barrel: [.24, .18], muzzle: { kind: 'baffle', length: .55, d: .4 },
    fittings: [{ kind: 'evacuator', from: 3.3, to: 3.95, d: .27 }, { kind: 'collar', from: 6.09, to: 6.25, d: .23 }] },
  // AT4: the glass-fibre tube with its sling swivel, the fold-up front sight and the bumper at its mouth [E; tube 1.02 m S].
  at4: { radius: .05, barrel: [.1, .1], muzzle: { kind: 'endcap', length: .07, d: .12 },
    fittings: [{ kind: 'band', from: .1, to: .13, d: .104 }, { kind: 'sight', from: .3, to: .33, d: .1, reach: .095 }] },
  // Carl Gustaf M4: the wound barrel slimmer towards its muzzle, the front grip under it [E; overall 0.95 m S].
  carlgustaf: { radius: .055, barrel: [.11, .094], muzzle: { kind: 'collar', length: .04, d: .1 },
    fittings: [{ kind: 'grip', from: .2, to: .25, d: .1, reach: .15 }] },
  // M261, nineteen tubes in a pod 1.682 m long and 0.403 m across turning about its middle [S]: its forward suspension lug
  // 0.178 m before the middle (lugs 14 in apart), the forward bulkhead band and the fairing at its mouth [E].
  hydra70: { radius: .2, barrel: [.403, .403], pod: true, muzzle: { kind: 'fairing', length: .06, d: .403 },
    fittings: [{ kind: 'lug', from: .15, to: .21, d: .403, reach: .235 }, { kind: 'band', from: .66, to: .7, d: .41 }] },
});

// The fittings drawn along a barrel `barrel` long, from the trunnion, and the muzzle device ending at its muzzle: those
// that end before the device begins, in the order of the table. `start` is where the tube leaves its mount
// (weapon-geometry.ts): a fitting that reaches back past it, into the mount, is drawn from there.
export function tubeFittings(presetId: WeaponPresetId, barrel: number, start = 0): { muzzle: TubeMuzzle & { from: number; to: number }; fittings: TubeFitting[] } {
  const table = TUBE_FITTINGS[presetId] || TUBE_FITTINGS.rh120, device = Math.min(table.muzzle.length, (barrel - start) / 3),
    muzzle = { ...table.muzzle, from: barrel - device, to: barrel };
  return { muzzle, fittings: table.fittings.filter(f => f.to > start && f.to <= muzzle.from + 1e-9).map(f => ({ ...f, from: Math.max(f.from, start) })) };
}
