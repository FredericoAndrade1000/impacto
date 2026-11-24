import { DESIGN_VERSION } from '../src/persistence.ts';
import { weaponSettings } from '../src/weapons.ts';

const WALL_X = [-6, -4, -2, 0, 2, 4, 6];

// Independent rooms share the floor and roof. Each internal wall is actual
// finite material; the spaces between them are empty, not hidden concrete.
export function barrierSource({ material = 'concrete', thickness = 1000, count = 5,
  ammo = true, command = false, partitions } = {}) {
  const nodes = WALL_X.flatMap((x, i) => [{ id: `b${i}`, x, y: -1.15 }, { id: `t${i}`, x, y: 1.85 }]),
    plate = (id, a, b, mm, metal) => ({ id, a, b, material: metal, thicknessMm: mm }),
    plates = [];
  for (let i = 0; i < WALL_X.length - 1; i++) {
    plates.push(plate(`floor${i}`, `b${i}`, `b${i + 1}`, 5, 'steel'));
    plates.push(plate(`roof${i}`, `t${i + 1}`, `t${i}`, 5, 'steel'));
  }
  plates.push(plate('front', 't0', 'b0', 50, 'concrete'));
  plates.push(plate('rear', 'b6', 't6', 5, 'steel'));
  for (const [i, wall] of (partitions || Array.from({ length: count }, () => ({ material, thickness }))).entries())
    plates.push(plate(`block${i + 1}`, `b${i + 1}`, `t${i + 1}`, wall.thickness, wall.material));
  const components = [];
  if (ammo) components.push({ id: 'ammo', kind: 'ammo', ammoPreset: 'rh120',
    pose: { x: 5.3, y: -.2825, angle: 0 } });
  // The positive off-axis spall ray of block1 crosses this command box.
  // The primary bore at y=1.15 passes below it.
  if (command) components.push({ id: 'command', kind: 'command',
    pose: { x: -.25, y: .7175, angle: 0 } });
  return { version: DESIGN_VERSION, preset: 'bunker', name: 'Barreiras balísticas em série', seed: 6173,
    terrain: 'flat', launcher: { x: 0, y: 1.15 }, nodes, plates, components };
}

export const rh120 = () => weaponSettings('cannon', { preset: 'rh120', ammo: 'apfsds', spread: 0 });

export function firingLine(world) {
  const config = rh120(), launcher = world.launcher(config), aim = { x: 19, y: launcher.y },
    muzzle = { x: launcher.x + config.barrel, y: launcher.y };
  return { config, aim, muzzle, layers: world.index.raycastLayers(muzzle, aim, { projectile: true }) };
}

export function fireRh120(world, { force = true, steps = 18 } = {}) {
  const line = firingLine(world), fired = world.fire(line.aim, line.config, force), events = world.drainEvents();
  for (let i = 0; i < steps; i++) {
    world.step();
    events.push(...world.drainEvents());
  }
  return { ...line, fired, events };
}
