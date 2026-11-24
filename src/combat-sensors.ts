import type { MessageKey } from './message-contract.ts';

export interface SensorSpec {
  name: MessageKey; range: number; mass: number; cost: number;
  size?: { width: number; height: number; depthM: number };
}

// Workshop hardware and displayed reach. Native sensing owns polling, error
// and optical identification (game_sensors.rs).
export const SENSOR_MODES = Object.freeze({
  visual: { name: 'Câmera óptica', range: 4000, mass: 4, cost: 1500 },
  // Compact vehicle-mounted surveillance panel and pan unit, visually inspired by FLIR's Ranger R6SS.
  // These are game dimensions and performance, not a replica's specifications. Old unlabelled installations keep
  // their original physical envelope and mass through `radarModel: legacy` on native admission.
  radar: { name: 'Radar móvel', range: 8000, mass: 35, cost: 12000, size: Object.freeze({ width: .65, height: .546, depthM: .13 }) },
  sound: { name: 'Escuta acústica', range: 1200, mass: 3, cost: 250 },
} satisfies Record<string, SensorSpec>);
export type SensorMode = keyof typeof SENSOR_MODES;
export const LEGACY_RADAR = Object.freeze({ width: 1, height: .84, depthM: .2, mass: 90 });
export const RADAR_PEDESTAL_SHARE = .24;
export const COMMAND_CAMERA_RANGE = 650;
