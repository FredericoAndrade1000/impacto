import { readFileSync } from 'node:fs';
import { createConstruction } from '../src/construction-templates.ts';
import { WEAPON_PRESETS, allowedAmmo, weaponSettings, isWeaponPresetId } from '../src/weapons.ts';
import { MATERIALS } from '../src/materials.ts';
import { VEHICLE_BLAST_ORIGINS } from '../src/scenarios.ts';
import { FIRE_TARGETS } from './probes-impact.ts';
import { damageConstruction } from './damage-fixtures.ts';
import { EDGE_POINTS } from './probes-mobility.ts';
import { profileScene } from './probes-scenes.ts';
import type { WeaponPresetId } from '../src/weapons.ts';

export interface ReviewCase {
  id: string; probe: string; params: Record<string, unknown>; checks: string; scenario?: {preset?: WeaponPresetId};
}
export interface ReviewOptions {
  mode?: string; count?: number; frames?: number; scene?: string; workers?: number; limit?: number;
  case?: string; output?: string; label?: string; help?: boolean; list?: boolean;
}


export const REVIEW_SUITES = Object.freeze(['fire', 'front-mounts', 'stability', 'vehicle-blasts', 'artillery', 'secondary', 'arsenal',
  'terrain', 'environment', 'track-edge', 'light-wheel', 'blast-launch', 'mortar-roof', 'lab', 'damaged-blasts', 'durability',
  'flows', 'explosives', 'performance', 'explosion-performance', 'destruction', 'benchmark', 'topology']);
export const readJSON = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

// Every original matrix is named here. Seeds, controls and interventions are
// ordinary episode data; there is no hidden runner-specific decision loop.
export function reviewCases(suite: string, o: ReviewOptions = {}): ReviewCase[] {
  if (!REVIEW_SUITES.includes(suite)) throw new Error('Suite desconhecida: ' + suite);
  const modes: Record<string, readonly string[]> = { fire: ['all', 'quick', 'single', 'heavy', 'moving'], 'front-mounts': ['all', 'single', 'long'],
    stability: ['all', 'salvo'], 'track-edge': ['all', 'quick', 'trace', 'trace-floor'], 'blast-launch': ['all', 'diagnostic'] };
  if (o.mode && !modes[suite]?.includes(o.mode)) throw new Error('Modo indisponível para ' + suite + ': ' + o.mode);
  const rows: ReviewCase[] = [], add = (probe: string, params: Record<string, unknown> = {}, checks = 'physical', scenario?: ReviewCase['scenario']) => {
    if (probe === 'profileScenario' && !params.scene && !params.pvp && !params.benchmark) {
      if (typeof params.id !== 'string') throw new TypeError('Profile case needs its scene id.');
      params.scene = profileScene(params.id);
    }
    rows.push({ id: suite + '/' + String(rows.length + 1).padStart(4, '0'), probe, params, checks, ...(scenario ? { scenario } : {}) });
  }, mode = o.mode || 'all', count = o.count ?? 12;
  switch (suite) {
    case 'fire': {
      add('runFireCase', { control: true, seconds: 6 });
      if (['all', 'quick', 'single'].includes(mode)) for (const preset of ['fnmag', 'm2hb'] as const) {
        for (const target of Object.keys(FIRE_TARGETS)) {
          if (mode === 'quick' && !['roof', 'front', 'track', 'mount'].includes(target)) continue;
          add('runFireCase', { preset, target });
          if (mode !== 'single') add('runFireCase', { preset, target, burst: true, seconds: mode === 'quick' ? 2 : 4, spread: .15, follow: true });
        }
        if (mode === 'all') add('runFireCase', { preset, target: 'upper-front', burst: true, seconds: 12, spread: .35, follow: true, settle: 60 });
      }
      if (['all', 'heavy'].includes(mode)) {
        for (const target of ['roof', 'front', 'track', 'mount']) for (const preset of ['m242', 'rh120'] as const)
          add('runFireCase', { preset, weapon: WEAPON_PRESETS[preset].family, target, seconds: 3 });
        for (const preset of ['m242', 'rh120', 'at4'] as const) add('runFireCase', { preset, weapon: WEAPON_PRESETS[preset].family, ammo: 'he', target: 'roof', seconds: 4 });
        add('runFireCase', { preset: 'rh120', weapon: 'cannon', target: 'engine-roof', seconds: 3, measureEngineFloor: true });
      }
      if (['all', 'moving'].includes(mode)) {
        add('runFireCase', { control: true, throttle: 1, settle: 60, seconds: 3, follow: true });
        for (const preset of ['fnmag', 'm2hb'] as const) for (const target of ['upper-front', 'track'])
          add('runFireCase', { preset, target, burst: true, seconds: 3, throttle: 1, settle: 60, spread: .15, follow: true });
        add('runFireCase', { preset: 'm242', weapon: 'autocannon', target: 'roof', seconds: 3, throttle: 1, settle: 60, follow: true });
      }
      break;
    }
    case 'front-mounts': {
      const models: [WeaponPresetId, number?][] = mode === 'long' ? [['rh202', 36], ['m242', 36], ['rh120', 120]] : (['fnmag', 'm2hb', 'rh202', 'm242', 'mk35', 'rh120'] as const).map(p => [p]);
      for (const [preset, duration] of models) for (const burst of mode === 'single' ? [false] : mode === 'long' ? [true] : [false, true])
        add('reviewFrontMounts', { preset, weapon: WEAPON_PRESETS[preset].family, burst, seconds: duration || (burst ? 6 : 3) });
      break;
    }
    case 'stability':
      if (mode === 'salvo') {
        for (const thickness of [null, 20]) for (const target of ['front', 'roof']) add('salvoCase', { thickness, target });
        for (const preset of ['rh120', 'hydra70']) add('salvoCase', { preset, ammo: preset === 'hydra70' ? 'he' : 'ap', count: 20, interval: 15 });
      } else {
        for (const [preset, target, seconds] of [['m242', 'front', 6], ['mk35', 'roof', 6], ['rh120', 'front', 10], ['fnmag', 'roof', 6]] as const)
          add('repeatedFire', { preset, weapon: WEAPON_PRESETS[preset].family, target, seconds });
        for (const location of ['front', 'roof', 'track', 'internal', 'distant']) add('blastCase', { location });
      }
      break;
    case 'vehicle-blasts':
      add('assessVehicleBlast', { control: true }, 'vehicle-blast');
      for (const preset of ['mk19', 'hydra70', 'm252', 'm119'] as const) for (const location of Object.keys(VEHICLE_BLAST_ORIGINS))
        add('assessVehicleBlast', { location, power: WEAPON_PRESETS[preset].power, radius: WEAPON_PRESETS[preset].blastRadius }, 'vehicle-blast', { preset });
      for (const location of Object.keys(VEHICLE_BLAST_ORIGINS)) add('assessVehicleBlast', { location, power: 600, radius: 4.5 }, 'vehicle-blast');
      add('assessVehicleBlast', { location: 'internal', power: 600, radius: 4.5, vent: true }, 'vehicle-blast');
      add('assessVehicleBlast', { location: 'track', repeated: 3, seconds: 6 }, 'vehicle-blast');
      add('assessVehicleBlast', { control: true, throttle: .65 }, 'vehicle-blast');
      add('assessVehicleBlast', { location: 'track', throttle: .65 }, 'vehicle-blast');
      add('assessVehicleBlast', { control: true, throttle: .65, terrain: 'hills', seconds: 8 }, 'vehicle-blast');
      for (const location of ['track', 'internal']) add('assessVehicleBlast', { location, power: 600, radius: 4.5, throttle: .65, terrain: 'hills', seconds: 8 }, 'vehicle-blast');
      add('assessVehicleBlast', { location: 'track', throttle: .65, terrain: 'rough', seconds: 8 }, 'vehicle-blast');
      for (const seed of [42, 2026]) for (const location of ['track', 'internal']) add('assessVehicleBlast', { location, seed }, 'vehicle-blast');
      for (const preset of ['mk19', 'hydra70', 'm252', 'm119'] as const) for (const target of ['front', 'roof', 'track'])
        add('runFireCase', { preset, weapon: WEAPON_PRESETS[preset].family, ammo: 'he', target, settle: 30, seconds: 4 });
      break;
    case 'artillery':
      for (const [preset, trajectory] of [['m252', 'high'], ['m119', 'low'], ['m119', 'high']]) {
        for (const distance of [30, 120, 250]) for (const target of ['roof', 'front', 'track']) add('assessArtilleryVehicle', { preset, trajectory, distance, target });
        for (const target of ['airburst', 'near-miss', 'far-miss']) add('assessArtilleryVehicle', { preset, trajectory, distance: 60, target });
      }
      for (const preset of ['m252', 'm119'] as const) {
        add('assessArtilleryVehicle', { preset, distance: 60, target: 'roof', salvos: 3, aftermath: 6 });
        add('assessArtilleryVehicle', { preset, distance: 120, target: 'roof', terrain: 'hills' });
        for (const seed of [42, 2026]) add('assessArtilleryVehicle', { preset, distance: 120, target: 'roof', seed, spread: WEAPON_PRESETS[preset].spread });
      }
      add('assessArtilleryVehicle', { control: true, preset: 'm119', trajectory: 'high', distance: 250, target: 'roof' });
      break;
    case 'secondary':
      for (const preset of ['fnmag', 'm2hb', 'rh202', 'm242', 'rh120']) for (const material of ['steel', 'aluminum', 'ceramic', 'concrete'])
        for (const shield of [0, preset === 'rh120' ? 80 : ['rh202', 'm242'].includes(preset) ? 20 : 5])
        add('reviewSecondary', { preset, material, thickness: preset === 'fnmag' ? 5 : preset === 'm2hb' ? 10 : 50, shield }, 'secondary');
      for (const kind of ['engine', 'fuel', 'ammo', 'weapon', 'wheel', 'track']) for (const shield of [0, 20])
        add('reviewSecondary', { preset: 'm242', kind, shield }, 'secondary');
      for (const gap of [.1, 2, 5]) add('reviewSecondary', { gap }, 'secondary');
      for (const seed of [17, 89, 1234]) add('reviewSecondary', { seed }, 'secondary');
      for (const shield of [0, 5]) { add('reviewSecondary', { blast: true, thickness: 80, shield }, 'secondary'); add('reviewSecondary', { casing: true, shield }, 'secondary'); }
      break;
    case 'arsenal':
      for (const preset of Object.keys(WEAPON_PRESETS).filter(isWeaponPresetId)) for (const ammo of allowedAmmo(preset)) for (const material of Object.keys(MATERIALS))
        for (const thickness of [5, 80, 200]) for (const incidence of [0, 80]) add('armorTrial', { preset, ammo, material, thickness, incidence }, 'armor');
      for (const preset of ['minimi', 'fnmag', 'm2hb', 'rh202', 'm242', 'mk44', 'mk35', 'rh120']) for (const material of ['steel', 'concrete'])
        add('armorTrial', { preset, material, thickness: 80, count: 8 }, 'armor');
      break;
    case 'terrain':
    case 'environment': {
      const environment = suite === 'environment', probe = environment ? 'environmentDrive' : 'reviewDrive', surfaces = environment ? ['flat', 'mud', 'sand', 'mixed'] : ['flat', 'hills', 'rough'];
      for (const template of ['heavy', 'scout']) {
        for (const terrain of surfaces) for (const direction of [1, -1]) add(probe, { template, terrain, direction, seconds: terrain === 'mixed' ? 18 : 12 }, 'drive');
        for (const action of environment ? ['brake', 'engine', 'gear', 'blast'] : ['brake', 'release', 'engine', 'gear', 'blast'])
          add(probe, { template, ...(environment ? { terrain: 'mud' } : {}), action, seconds: 9 }, 'drive');
      }
      break;
    }
    case 'track-edge':
      if (mode === 'trace' || mode === 'trace-floor') add('runTrackEdge', { trace: true, ...(mode === 'trace-floor' ? { point: 'chassis-overlap', settle: 60, seconds: 4 } : {}) });
      else {
        add('runTrackEdge', { control: true, seconds: 2 });
        for (const point of mode === 'all' ? Object.keys(EDGE_POINTS) : ['image-marker', 'lower-curve', 'lower-tip'])
          for (const [preset, ammo] of [['fnmag', 'ap'], ['m2hb', 'ap'], ['m242', 'ap'], ['m242', 'he'], ['rh120', 'ap'], ['rh120', 'he'], ['at4', 'he']])
            for (const settle of mode === 'all' ? [0, 60] : [0]) {
              add('runTrackEdge', { point, preset, ammo, settle, ...(point === 'chassis-overlap' ? { seconds: 4 } : {}) });
              if (mode === 'all' && ['image-marker', 'lower-curve', 'lower-tip'].includes(point)) add('runTrackEdge', { point, preset, ammo, settle, burst: true });
            }
        if (mode === 'all') for (const preset of ['fnmag', 'm2hb', 'm242', 'rh120']) for (const settle of [0, 60])
          add('runTrackEdge', { preset, settle, point: 'chassis-overlap', prepareHole: true, burst: preset !== 'rh120' });
      }
      break;
    case 'light-wheel':
      for (let seed = 1; seed <= count; seed++) for (const target of ['wheel-upper', 'wheel-lower', 'engine', 'front-slope'])
        add('probeLightWheel', { seed, target, throttle: seed % 3 === 0 ? -1 : seed % 3 === 1 ? 1 : 0, shots: 1, seconds: 5 }, 'wheel');
      for (const target of ['engine', 'front-slope']) add('probeLightWheel', { seed: 4, target, preset: 'rh202', shots: 150, seconds: 12 }, 'wheel');
      break;
    case 'blast-launch':
      if (mode === 'diagnostic') add('probeBlastLaunch', { model: 'ifv', seed: 9, location: 'fuel', terrain: 'hills', diagnostic: true, seconds: 1 }, 'launch');
      else for (const model of ['scout', 'heavy', 'ifv', 'chassis']) for (let seed = 1; seed <= count; seed++)
        add('probeBlastLaunch', { model, seed, location: ['front-wheel', 'rear-wheel', 'engine', 'fuel', 'roof'][(seed - 1) % 5],
          terrain: seed % 3 === 0 ? 'hills' : 'flat', repeats: seed % 4 === 0 ? 3 : 1, throttle: seed % 7 === 0 ? .65 : 0 }, 'launch');
      break;
    case 'mortar-roof':
      for (const model of ['four-wheel', 'scout', 'ifv']) for (let seed = 1; seed <= count; seed++) add('probeMortarRoof', {
        model, seed, distance: seed % 3 === 0 ? 30 : 0, terrain: seed % 4 === 0 ? 'hills' : 'flat', salvos: seed % 2 === 0 ? 3 : 1,
        offset: [-.08, 0, .08][seed % 3], spread: seed % 5 === 0 ? .2 : 0 });
      break;
    case 'lab':
      for (const id of ['blast-standoff', 'blast-contact', 'blast-distance', 'blast-closed', 'blast-open', 'blast-vehicle']) add('probeReferenceBlast', { id });
      for (const thickness of [100, 125]) for (const offset of [-.2, -.08, -.04, -.02, 0, .02, .04, .08, .2]) add('probeJoint', { thickness, gap:0, offset });
      for (const preset of ['fnmag', 'rh202']) add('probeConcentrated', { preset });
      break;
    case 'damaged-blasts':
      for (const model of ['heavy', 'scout']) for (const location of ['front', 'running-gear', 'internal']) add('probeDamagedBlast', { model, location });
      break;
    case 'durability':
      for (const preset of ['m242', 'mk44', 'mk35']) for (const ammo of ['ap', 'he']) add('probeDurability', { preset, ammo }, 'durability');
      break;
    case 'flows':
      for (const kind of ['engine', 'weapon', 'wheel', 'track']) add('probeExposed', { kind });
      for (const preset of ['fnmag', 'm2hb'] as const) {
        const b = damageConstruction({ material:'concrete', frontThickness:480 });
        add('profileScenario', { id: 'concrete', frames: 240, trigger: true, scene: { blueprint: b, aim: { x: 10.5, y: 1.7 }, weapon: weaponSettings('machinegun', { preset }) } });
      }
      break;
    case 'explosives':
      for (const preset of ['mk19', 'm252', 'm119', 'hydra70']) for (const distance of [30, 120, 250]) for (const detonation of ['impact', 'airburst'])
        for (const target of ['vehicle', 'bunker']) add('probeLongRange', { preset, distance, detonation, target }, 'long-range');
      for (const c of reviewCases('arsenal')) add(c.probe, c.params, c.checks);
      break;
    case 'performance':
      add('profileScenario', { id: 'vehicle-front', frames: 1200, every: 8 });
      add('profileScenario', { id: 'scout', scene: { blueprint: createConstruction('scout'), aim: { x: 9.86, y: 1.22 }, weapon: weaponSettings('autocannon', { preset: 'rh202', ammo: 'ap', spread: .012 }) }, frames: 1200, every: 6 });
      add('profileScenario', { id: 'concrete-burst', frames: 1200, every: 5 });
      add('profileScenario', { id: 'blast-vehicle', frames: 600, blast: true });
      break;
    case 'explosion-performance':
      for (const model of ['heavy', 'scout']) for (const location of ['front', 'track', 'internal', 'internal-repeat', 'moving-track']) add('probeExplosionPerformance', { model, location });
      break;
    case 'destruction': add('profileScenario', { id: o.scene || 'internal', frames: o.frames ?? 90 }); break;
    case 'benchmark':
      add('profileScenario', { benchmark: true, id: 'benchmark', frames: 180, warmup: 30, profile: false });
      add('profileScenario', { pvp: true, id: 'pvp', frames: 180, warmup: 30, profile: false });
      for (const id of ['penetration', 'concrete', 'internal', 'weapon', 'vehicle-roof', 'vehicle-front', 'track-edge', 'spall'])
        add('profileScenario', { id, frames: id === 'track-edge' ? 240 : 90, snapshotEvery: 1, profile: false });
      break;
    case 'topology': add('probeTopology', { id: o.scene || 'internal', frames: o.frames ?? 90 }); break;
  }
  return rows;
}
