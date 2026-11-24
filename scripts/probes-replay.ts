import assert from 'node:assert/strict';
import type { SceneEvent } from '../src/scene-contract.ts';
import type { Point } from '../src/math.ts';
import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { TemplateId } from '../src/construction-template-catalogue.ts';
import type { TerrainId } from '../src/terrain.ts';
import type { SensorMode } from '../src/combat-sensors.ts';
import { requireVehicle } from './review-harness.ts';
import { World } from '../src/physics.ts';
import { referenceScenario } from '../src/scenarios.ts';
import { physicsState, advance, finiteWorld, permanentParts, partsPreserved } from './review-harness.ts';

export function probeTopology({ id = 'internal', frames = 90 } = {}) {
  const scene = referenceScenario(id), w = new World(scene.blueprint), initial = permanentParts(w), history: (ReturnType<typeof geometry> & {frame: number; time: number; colliders: number})[] = [], events: SceneEvent[] = [];
  let preserved = true, finite = true;
  const geometry = () => ({ materialMass: w.plates.reduce((s, p) => s + p.remainingArea * p.material.density * (p.massScale || 1), 0) +
      w.modules.reduce((s, m) => s + m.physicalMass, 0),
    plates: w.plates.map(p => ({ id: p.id, revision: p.revision, area: p.remainingArea, integrity: p.integrity,
      vertices: p.nodes.length, triangles: p.activeIndices.length / 3 })),
    components: w.modules.map(m => ({ id: m.id, kind: m.kind, health: m.health, mass: m.physicalMass })),
    bodies: physicsState(w).bodyStates });
  try {
    const initialGeometry = geometry(); w.fire(scene.aim, scene.weapon, true);
    advance(w, frames, { after(frame, world, recent) {
      preserved &&= partsPreserved(w, initial); finite &&= finiteWorld(w);
      events.push(...recent.filter(e => ['explosion', 'destroyed', 'penetration', 'module', 'secondary-impact'].includes(e.type)));
      history.push({ frame, time: w.time, ...geometry(), colliders: physicsState(w).colliders });
    } });
    return { scene: id, frames: history.length, initial, initialGeometry, final: history.at(-1), partsPreserved: preserved, finite,
      events, history, stats: { ...w.stats }, peakBodies: Math.max(0, ...history.map(s => s.bodies.length)) };
  } finally { w.dispose(); }
}
