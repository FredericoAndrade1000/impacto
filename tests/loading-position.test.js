import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredConstruction, compileStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { collectionWork, canCollect, workArea, loadingContainers } from '../src/loading-area.ts';
import { cargoRoom } from '../src/component-volume.ts';
import { Side } from '../server/room.ts';
import { Squad } from '../src/squad.ts';

await initNativeDynamics();

// Poses are written in cells of 5 cm, each over the floor of the hull. Where a part stood on a plate off the grid, it
// takes the cell above, clear of the metal under it.
const mounted = (kind, sizeScale, x, y) => ({ id: kind === 'hopper' || kind === 'cistern' ? 'bin' : 'tool', kind, sizeScale,
  pose: { x, y, angle: 0 } });
// A box on its wheels, hung where its suspension reaches them, with an engine, a command post, a tank and `components`.
function custom(length, height, components) {
  const hull = createStructuredConstruction({ length, height, thicknessMm: 8, frontInset: 0, rearInset: 0 }), floor = hull.nodes[0].y;
  return validateStructuredConstruction({ ...hull,
    components: [
      { id: 'engine', kind: 'engine', sizeScale: .7, pose: { x: -22, y: 6, angle: 0 } },
      { id: 'command', kind: 'command', pose: { x: 5, y: 4, angle: 0 } },
      { id: 'fuel', kind: 'fuel', sizeScale: .5, pose: { x: 24, y: 5, angle: 0 } },
      ...components,
    ].map(part => ({ ...part, pose: { ...part.pose, y: floor + part.pose.y } })) });
}

// Native compiles the actual workshop shapes. This fixture only translates their
// world pose on level terrain; the real Side and Squad own the collection order.
// Native driving, pickup and unloading are exercised by the logistics flow tests.
function field(source, { left = 1000, stock = 100, material = 'ligas' } = {}) {
  const blueprint = compileStructuredConstruction(source);
  assert.equal(blueprint.mechanicalAdmission, true);
  const actor = { id: 'unit', blueprint, vehicle: { x: blueprint.frame.origin.x, vx: 0, config: { enabled: true } } },
    world = { time: 0, actor: id => id === actor.id ? actor : null, terrain: { height: () => 0, minX: -10000, maxX: 10000 },
      modules: blueprint.modules.map(part => ({ ...part, actorId: actor.id, health: 100, attached: true,
        ...(['wheel', 'track'].includes(part.kind) ? { groundContact: { x: part.x, y: 0 } } : {}) })),
      plates: blueprint.plates.map(part => ({ ...part, actorId: actor.id, definition: part })) },
    site = { id: 'site', x: 100, material, feature: material === 'petroleo' ? 'lowland' : 'outcrop' },
    faction = { id: 'faction', base: { x: -1000 } }, player = { id: 'player', factionId: faction.id }, known = { left, stock },
    room = { world, field: world, activities: null, supplyDispatch: { jobs: new Map() }, sites: new Map([[site.id, site]]), players: new Map([[player.id, player]]), records: new Map(),
      faction: () => faction, known: () => known, stilled: () => false }, side = new Side(room, player.id);
  Object.defineProperties(side, { roster: { value: [{ id: actor.id, team: 'local' }] }, defeats: { value: {} },
    depot: { value: () => ({ x: -1000, radius: 100 }) } });
  const squad = player.squad = new Squad(side), unit = squad.units.get(actor.id),
    moveTo = x => {
      const dx = x - actor.vehicle.x; actor.vehicle.x = x;
      world.modules = world.modules.map(part => ({ ...part, x: part.x + dx }));
      world.plates = world.plates.map(part => ({ ...part, x: part.x + dx, definition: { ...part.definition, x: part.definition.x + dx } }));
      world.time += .1; unit.move = null;
    };
  unit.haul = { depositId: site.id, material: site.material, phase: 'out' };
  return { actor, world, site, side, known, unit, moveTo, turn: () => squad.haul(actor.id, unit) };
}

test('a native-admitted short tool on a tall workshop hull cannot keep a parked outbound order forever', () => {
  const f = field(custom(4, 2, [mounted('excavator', .25, -30, 42)])), work = collectionWork(f.world, 'unit')[0];
  f.site.x = work.point;
  assert(work.layout.mount.y > work.layout.length);
  assert.equal(canCollect(work, f.site, f.world.terrain), false);
  assert.equal(f.side.deposit('site', 'unit').area.ready, false);
  assert.equal(f.turn(), ''); assert.equal(f.unit.move, null);
  f.world.time = 8.1;
  assert.equal(f.turn(), 'no-loader'); assert.equal(f.unit.haul, null);
});

test('a short trapped extractor does not erase a valid hopper or cistern pickup order', () => {
  for (const [tool, container, material] of [['excavator', 'hopper', 'ligas'], ['drill', 'cistern', 'petroleo']]) {
    const f = field(custom(8, .6, [mounted(tool, .25, 0, tool === 'excavator' ? 14 : 16), mounted(container, 1, -48, 22)]), { material }),
      bin = f.world.modules.find(part => part.id === 'bin');
    f.site.x = bin.x;
    const area = workArea(f.world, 'unit', f.site, 30);
    assert.deepEqual([area.ready, area.digs, area.loads], [true, false, true], 'the trapped tool has no place to dig');
    assert.deepEqual(loadingContainers(f.world, 'unit', f.site, 30).map(part => part.id), ['bin']);
    assert.deepEqual(f.side.deposit('site', 'unit').area, area);
    assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'load'); assert.equal(f.unit.move, null);
    f.world.time = 100;
    assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'load', 'waiting for a pile is a real transport task');
  }
});

test('a combined vehicle approaches where its arm digs and its hopper loads even beside a ready leftover pile instead of starting tiny return trips', () => {
  const f = field(custom(8, .6, [mounted('excavator', 1, -67, 19), mounted('hopper', 1, 48, 22)])),
    bin = f.world.modules.find(part => part.id === 'bin'), work = () => collectionWork(f.world, 'unit')[0];
  f.site.x = bin.x + 6;
  const area = workArea(f.world, 'unit', f.site, 30);
  assert.deepEqual(loadingContainers(f.world, 'unit', f.site, 30).map(part => part.id), ['bin'], 'the hopper alone could take a leftover pile in here');
  assert.equal(canCollect(work(), f.site, f.world.terrain), false);
  assert.deepEqual([area.ready, area.digs, area.loads], [false, true, true]);
  assert.deepEqual(f.side.deposit('site', 'unit').area, area);
  f.known.stock = 0;
  assert.deepEqual(f.side.deposit('site', 'unit').area, area, 'the reserve still needs its own tool to approach');
  assert.equal(f.turn(), ''); assert(f.unit.move, 'the combined vehicle drives to where both work');
  f.moveTo(f.unit.move.x);
  assert.equal(f.side.deposit('site', 'unit').area.ready, true);
  assert.equal(canCollect(work(), f.site, f.world.terrain), true, 'its arm digs there');
  assert.deepEqual(loadingContainers(f.world, 'unit', f.site, 30).map(part => part.id), ['bin'], 'and its hopper loads there');
  f.turn(); assert.equal(f.unit.haul.phase, 'load');
});

test('a physically unreachable arm retains real ready container pickup, including waiting for external production', () => {
  const f = field(custom(8, 2.2, [mounted('excavator', .5, -56, 48),
    { id: 'bin', kind: 'hopper', pose: { x: 56, y: 10, angle: 0 } }])),
    bin = f.world.modules.find(part => part.id === 'bin');
  f.site.x = bin.x;
  const area = workArea(f.world, 'unit', f.site, 30);
  assert.equal(canCollect(collectionWork(f.world, 'unit')[0], f.site, f.world.terrain), false);
  assert.deepEqual([area.ready, area.digs, area.loads], [true, false, true]);
  assert.deepEqual(f.side.deposit('site', 'unit').area, area);
  f.known.stock = 0; f.turn(); assert.equal(f.unit.haul.phase, 'load');
  f.world.time = 100; assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'load');
});

test('a native-admitted full combined vehicle delivers first and resumes the same extraction order only after unloading', () => {
  const f = field(custom(8, .6, [mounted('excavator', 1, -67, 19), mounted('hopper', 1, 48, 22)])),
    bin = f.world.modules.find(part => part.id === 'bin');
  bin.cargo = { ligas: cargoRoom(bin) * 1500 };
  assert(f.side.deposit('site', 'unit').area, 'the arm has a valid approach even while the hopper is full');
  f.turn(); assert.equal(f.unit.haul.phase, 'home'); assert.equal(f.unit.move.x, -925);
  f.moveTo(f.unit.move.x); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.world.modules.find(part => part.id === 'bin').cargo = {}; f.world.time += .1;
  f.turn(); assert.equal(f.unit.haul.phase, 'out'); assert(f.unit.move.x > 80);
});

test('a transporter without a tool approaches the real container offset and keeps waiting for production', () => {
  const f = field(custom(8, .6, [mounted('hopper', 1, 48, 22)]), { stock: 0 });
  f.turn(); assert(f.unit.move);
  f.moveTo(f.unit.move.x);
  assert.equal(f.side.deposit('site', 'unit').area.ready, true);
  f.turn(); assert.equal(f.unit.haul.phase, 'load');
  f.world.time += 100; assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'load');
});
