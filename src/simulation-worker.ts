import type { World } from './physics.ts';
import { isConstructionSource } from './construction-codec.ts';
import { TERRAIN_PROFILES } from './terrain.ts';
import type { TerrainId } from './terrain.ts';
import type { WorkerFrame } from './simulation-contract.ts';
import type { ProjectileInput } from './scene-contract.ts';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const terrainId = (v: unknown): v is TerrainId => typeof v === 'string' && Object.hasOwn(TERRAIN_PROFILES, v);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const activeWorld = (): World => { if (!world) throw new Error('O cenário ainda está carregando.'); return world; };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const handles = (v: unknown): v is Iterable<string | number> => (Array.isArray(v) || v instanceof Set) && [...v].every((id: unknown) => typeof id === 'string' || finite(id));
function projectileInput(v: unknown): v is ProjectileInput {
  if (!record(v) || !finite(v.x) || !finite(v.y) || !finite(v.vx) || !finite(v.vy)) return false;
  if (!['number', 'numericId', 'age', 'radius', 'actor', 'power', 'mass', 'caliberMm', 'life'].every(key => v[key] === undefined || finite(v[key]))) return false;
  if (!['id', 'ammo', 'weapon', 'material'].every(key => v[key] === undefined || typeof v[key] === 'string')) return false;
  if (!['actorId', 'preset'].every(key => v[key] === undefined || v[key] === null || typeof v[key] === 'string')) return false;
  if (!['poweredTrail', 'fragment', 'spall'].every(key => v[key] === undefined || typeof v[key] === 'boolean')) return false;
  if (!['emitterOwners', 'visitedOwners'].every(key => v[key] === undefined || Array.isArray(v[key]) && v[key].every(finite))) return false;
  return (v.flight === undefined || v.flight !== null && typeof v.flight === 'object') &&
    (v.emitterIds === undefined || handles(v.emitterIds)) && (v.visited === undefined || handles(v.visited));
}
import { FIXED_DT } from './physics.ts';
import { PhysicsMetrics } from './performance.ts';
import { applyWorldInput, easedThrottle, releaseWorldInputs } from './episode-input.ts';
import { pageWorld, placeTrialTargets, wreckTrial } from './trial-targets.ts';
import { SlowMotion } from './slow-motion.ts';
import { privateTestAction } from './test-tools.ts';

let world: World | null = null, paused = true, visible = true, generation = 0, targets = false;
let accumulator = 0, lastTime = performance.now(), lastFrame = 0, inFlight = false, frameSerial = 0;
let metrics = new PhysicsMetrics(lastTime), snapshotMs = 0;
let changed = false;
// The slow motion of a test of armour (slow-motion.ts); none in the other tests.
let slow: SlowMotion | null = null;
// What the player asks of the pedals, and where the throttle is on its way there (episode-input.ts `easedThrottle`).
let drive: { wanted: number; throttle: number; brake: unknown; rise: unknown } | null = null;
function control(data: Record<string, unknown>) {
  const world = activeWorld();
  if (data.weapon !== undefined && !record(data.weapon)) throw new Error('Armamento inválido.');
  const input = { ...(record(data.weapon) ? data.weapon : {}), type: data.type, phase: 'before', aim: data.aim, queue: data.queue, cancel: data.cancel };
  if (data.type === 'drive') {
    if (typeof data.throttle !== 'number' || !Number.isFinite(data.throttle)) throw new Error('Acelerador inválido; ação de pilotagem inválida.');
    const throttle = paused ? 0 : drive?.throttle ?? 0;
    drive = paused ? null : { wanted: Math.max(-1, Math.min(1, data.throttle)), throttle, brake: data.brake, rise: data.rise ?? 0 };
    Object.assign(input, { throttle, brake: paused ? 0 : data.brake, rise: paused ? 0 : data.rise ?? 0 });
  }
  if (data.type === 'trigger') Object.assign(input, { active: data.active && !paused && visible, shot: data.active && !world.actor('local')?.trigger });
  if (data.force !== undefined && typeof data.force !== 'boolean') throw new Error('Força de controle inválida.');
  const accepted = applyWorldInput(world, 'local', input, { force: data.force ?? false });
  if (!record(accepted) || typeof accepted.accepted !== 'boolean') throw new Error('Resposta de controle inválida.');
  return accepted.accepted;
}
function resetClock({ frames = false } = {}) {
  accumulator = 0; lastTime = performance.now();
  if (frames) inFlight = false;
  metrics.reset(lastTime, world?.time || 0); changed = true;
}
function load(next: World | null, data: { generation: number }, isPaused: boolean) {
  world?.dispose(); world = next; generation = data.generation; paused = isPaused; drive = null;
  resetClock({ frames: true });
}

function sendFrame() {
  if (!world || inFlight) return;
  const start = performance.now(), state = world.snapshot(), events = world.drainEvents();
  inFlight = true; changed = false; lastFrame = performance.now(); snapshotMs = lastFrame - start;
  const pace = slow?.pace ?? 1, measured = metrics.read(lastFrame, world.time, pace, paused, accumulator, snapshotMs);
  if (!world.dynamics) throw new Error('Núcleo do cenário ausente.');
  const profile = { ...measured, dynamicsBackend: world.dynamics.backend };
  // `pace`, how fast the world goes against the player's time, for the page to show its steps as slowly as they come;
  // `flight`, when a round struck at the design was put in the air, when it strikes and the pace of its flight;
  // `slowed`, that it is slowed and not yet easing back.
  const frame: WorkerFrame = { type: 'frame', generation, serial: ++frameSerial, state, events, paused, pace, flight: slow?.struck ?? null, slowed: slow?.slowed ?? false,
    physicsMs: profile.physicsMs, profile };
  self.postMessage(frame);
}
function advance() {
  const world = activeWorld();
  const start = performance.now();
  if (drive && drive.throttle !== drive.wanted) {
    drive.throttle = easedThrottle(drive.throttle, drive.wanted, FIXED_DT);
    applyWorldInput(world, 'local', { type: 'drive', phase: 'before', throttle: drive.throttle, brake: drive.brake, rise: drive.rise });
  }
  world.step();
  wreckTrial(world);
  metrics.record(performance.now(), performance.now() - start); changed = true;
}
function stopControls() { drive = null; if (world) releaseWorldInputs(world); }

self.onmessage = ({ data: raw }: MessageEvent<unknown>) => {
  if (!record(raw) || typeof raw.type !== 'string') throw new Error('Comando de simulação inválido.');
  const data = raw;
  if (data.type === 'ack') { if (data.serial === frameSerial) inFlight = false; return; }
  const reply = (payload: object) => self.postMessage({ type: 'reply', request: data.request, generation, ...payload });
  try {
    switch (data.type) {
      case 'clear': if (typeof data.generation !== 'number') throw new Error('Geração de ensaio inválida.'); load(null, { generation: data.generation }, true); slow = null; break;
      case 'load': {
        if (typeof data.generation !== 'number' || !isConstructionSource(data.blueprint) || data.terrain !== undefined && !terrainId(data.terrain) || data.paused !== undefined && typeof data.paused !== 'boolean') throw new Error('Cenário de ensaio inválido.');
        targets = Boolean(data.targets);
        load(pageWorld(data.blueprint, { ...(data.terrain === undefined ? {} : { terrain: data.terrain }), targets }), { generation: data.generation }, data.paused ?? true);
        slow = data.slow ? new SlowMotion() : null;
        break;
      }
      case 'test': {
        if (!world || !targets) throw new Error('Ferramentas de testes disponíveis apenas no campo de provas.');
        const result = privateTestAction(world, data, typeof data.request === 'number' ? data.request : NaN);
        if (data.act !== 'list') { drive = null; resetClock(); }
        reply(result); if (changed) sendFrame(); return;
      }
      case 'fire':
        if (!world) throw new Error('O cenário ainda está carregando.');
        reply({ accepted: control(data) }); changed = true; sendFrame(); return;
      // A round of the test of armour, put in the air on the line the player drew, to strike what the line meets
      // (armour-strike.ts), `flight` seconds of the world later; and what a piece of the design costs a round to get
      // through there, as the core has it.
      case 'strike': {
        if (!world) throw new Error('O cenário ainda está carregando.');
        if (!projectileInput(data.round)) throw new Error('Projétil de ensaio inválido.');
        const game = world.game();
        game.call({ op: 'projectile', projectile: game.projectile(data.round) });
        // Its flight is seen at a pace of its own (slow-motion.ts) from its first step, taken at once: the page shows a
        // step once it has the state that ends it.
        if (slow) { slow.strike(world.time, typeof data.flight === 'number' ? data.flight : 0); accumulator = 0; if (!paused && visible) advance(); }
        reply({ accepted: true }); changed = true; sendFrame(); return;
      }
      // The player asks for the pace of the world back.
      case 'quicken': slow?.end(); break;
      case 'resistance': {
        if (!world) throw new Error('O cenário ainda está carregando.');
        if (typeof data.id !== 'string') throw new Error('Peça não encontrada.');
        const owner = world.game().handle(data.id);
        if (owner === null) throw new Error('Peça não encontrada.');
        const material = world.command('material', { owner, point: data.point, end: data.end, depth: data.depth, directionScale: data.cosine });
        if (!record(material) || typeof material.resistance !== 'number') throw new Error('Resistência do material inválida.');
        reply({ resistance: material.resistance });
        return;
      }
      case 'trigger': case 'aim': case 'drive':
        if (world) { control(data); changed = true; } break;
      case 'pause': paused = Boolean(data.value); stopControls(); resetClock(); break;
      case 'visible': visible = Boolean(data.value); stopControls(); resetClock(); break;
      case 'reset': if (world) { world.reset(); drive = null; slow?.clear(); if (targets) placeTrialTargets(world); resetClock({ frames: true }); } break;
      default: throw new Error('Comando de simulação desconhecido.');
    }
    reply({ ok: true }); if (changed) sendFrame();
  } catch (error) { reply({ error: errorMessage(error) }); }
};

setInterval(() => {
  const now = performance.now(), elapsed = Math.min(0.15, (now - lastTime) / 1000); lastTime = now;
  if (!world || !visible) return;
  if (!paused) {
    accumulator += slow ? slow.advance(elapsed) : elapsed; let steps = 0; const start = performance.now();
    while (accumulator + 1e-10 >= FIXED_DT && steps < 4 && performance.now() - start < 10) { advance(); steps++; accumulator -= FIXED_DT; }
  }
  if (changed && now - lastFrame >= 12) sendFrame();
}, 8);
self.postMessage({ type: 'ready' });
