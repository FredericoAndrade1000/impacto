import { Container, Graphics, Texture } from 'pixi.js';
import { Effects } from '../../src/effects.ts';
import { GroundTrails } from '../../src/terrain-art.ts';
import { Random } from '../../src/math.ts';

// Controlled contacts exercise the real particle pool without a physics or GPU
// fixture. All motion, surface and slip inputs are explicit.
export function dustScene({ speed = 0, slip = 0, wheels = 3, kind = 'wheel', surface = 'soil', quality = 'high', seed = 9247 } = {}) {
  const parent = new Container(), graphics = new Graphics(),
    atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
      dust: Texture.EMPTY, spark: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY },
    fx = new Effects(parent, atlas), trails = new GroundTrails(graphics, fx),
    terrain = { height: x => -.2 + .04 * Math.sin(x * .15), groundAt: () => surface },
    vehicle = { vx: speed, slip }, modules = Array.from({ length: wheels }, (_, i) => ({
      id: 'gear-' + i, actorId: 'truck', kind, attached: true, health: 100, groundContact: { x: i * 1.5 } })),
    state = { actors: [{ id: 'truck', vehicle }], modules };
  fx.terrain = terrain; fx.random = new Random(seed); fx.setQuality(quality); trails.record(state, terrain, 0);
  return { fx, trails, terrain, vehicle, modules, state,
    at(time) { for (const [i, module] of modules.entries()) if (module.groundContact) module.groundContact.x = i * 1.5 + speed * time;
      trails.record(state, terrain, time); },
    dispose() { trails.clear(); graphics.destroy(); fx.clear(); parent.destroy({ children: true }); } };
}

export function dustDrive({ seconds = 3, fps = 60, advance = false, ...options } = {}) {
  const scene = dustScene(options), emitted = [], sprites = new Set(), add = scene.fx.add.bind(scene.fx);
  let maxAlive = 0;
  scene.fx.add = (kind, input) => {
    const particle = add(kind, input);
    if (particle) {
      emitted.push({ kind, vx: particle.vx, vy: particle.vy, opacity: particle.opacity, size: particle.size,
        grow: particle.grow, life: particle.life, tint: particle.tint }); sprites.add(particle.sprite);
    }
    return particle;
  };
  try {
    for (let i = 1; i <= seconds * fps; i++) {
      scene.at(i / fps); maxAlive = Math.max(maxAlive, scene.fx.particles.length);
      if (advance) { scene.fx.update(1 / fps); scene.fx.sample(1); }
    }
    return { emitted, count: emitted.length, maxAlive, sprites: sprites.size, limit: scene.fx.limit,
      kinds: Object.fromEntries(['smoke', 'dust'].map(kind => [kind, emitted.filter(p => p.kind === kind).length])) };
  } finally { scene.dispose(); }
}
