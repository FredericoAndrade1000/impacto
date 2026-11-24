import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { createStructuredConstruction, planStructuredComponent } from '../src/structured-construction.ts';
import { withChassisThickness } from '../src/chassis-editing.ts';
import { componentReference } from '../src/component-size.ts';
import { CELL } from '../src/grid.ts';
import { fieldPanel, fieldNotices } from '../src/field-panel.ts';

function powerful() {
  let source = withChassisThickness(createStructuredConstruction({ length: 8, height: 3, thicknessMm: 8, chassis: 'wheeled' }), 20);
  // Interior pieces keep their authored positions; the external camera touches the actual roof face exactly.
  source.chassis = { ...source.chassis, axles: [-56, -19, 19, 56] };
  const floor = source.nodes[0].y, roof = source.plates.find(plate => plate.id === 'hull:roof'),
    roofY = source.nodes.find(node => node.id === roof.a).y;
  assert.equal(roofY, source.nodes.find(node => node.id === roof.b).y, 'this launch fixture has a level roof');
  const cameraY = roofY + (roof.thicknessMm / 2000 + componentReference({ kind: 'sensor', sensorMode: 'visual' }).height / 2) / CELL;
  // Its engine has eight times the room of one of 100 %, 1 440 kW: 2.83 times as long and tall, as deep as its kind.
  for (const part of [
    { id: 'engine', kind: 'engine', sizeScale: 2 ** 1.5, pose: { x: -19, y: floor + 20, angle: 0 } },
    { id: 'fuel', kind: 'fuel', sizeScale: .6, pose: { x: 25, y: floor + 6, angle: 0 } },
    { id: 'command', kind: 'command', pose: { x: 45, y: floor + 32, angle: 0 } },
    { id: 'camera', kind: 'sensor', sensorMode: 'visual', pose: { x: 4, y: cameraY, angle: 0 } },
  ]) source = planStructuredComponent(source, part).construction;
  return source;
}

// A vehicle published at a base a kilometre behind a place, off the asphalt of its apron, and stood there at rest on the
// ground: its name, and the time it stood there from.
function standing(room, player, source, at) {
  const world = room.world, base = room.factions.get(room.players.get(player.playerId).factionId).base.x,
    id = room.publish(player.playerId, source, { x: base, facing: 1 }).actor.id, vehicle = world.actor(id).vehicle;
  // This launch fixture holds its place until the explicit drive order; transport jobs have their own tests.
  if (room.record(world.actor(id)).auto) room.command(player.playerId, { type: 'auto', actorId: id, on: false });
  world.command('setVehicleState', { actorId: id, state: { x: at, y: vehicle.y - world.terrain.height(vehicle.x) + world.terrain.height(at), vx: 0, vy: 0 } });
  for (let step = 0; step < 90; step++) room.step();
  assert.equal(room.record(world.actor(id)).service, null, 'the launch starts without a turn or another service');
  assert.equal(room.supplyDispatch.manages(id), false, 'automatic transport does not move this launch fixture');
  return { id, start: world.time };
}

for (const mode of ['manual', 'move']) test(`a native powerful ${mode} launch makes progress despite slip without claiming immobilization`, t => {
  const from = -254112, room = rehearsal([from - 1000]), world = room.world; t.after(() => world.dispose());
  const player = room.join('Arrancada'), { id } = standing(room, player, powerful(), from),
    vehicle = world.actor(id).vehicle, mobility = {}, notices = {};
  const look = () => {
    const faction = room.factionView(player.playerId), state = { ...world.snapshot(), shared: true, faction,
      squad: room.squadView(player.playerId), players: room.roster(), localPlayerId: player.playerId };
    const p = fieldPanel({ shared: true, connected: true, state, faction, playerId: player.playerId, mobility, picked: [id] });
    assert(!p.watch.ills.some(ill => ill.key.startsWith('held:')), 'a launching vehicle is not declared unable to continue');
    assert.doesNotMatch(p.squad.units[0].status, /patinando|atolado|sem força/);
    assert(!fieldNotices(notices, p.watch, world.time).some(words => /patina|atolou|sem força/.test(words)));
  };
  look();
  if (mode === 'move') room.command(player.playerId, { type: 'squad', order: 'move', ids: [id], x: from + 300 });
  else {
    room.command(player.playerId, { type: 'squad', order: 'control', id });
    room.command(player.playerId, { type: 'drive', actorId: id, throttle: 1, brake: 0 });
  }
  let slipped = 0;
  for (let step = 0; step < 360; step++) {
    if (step % 30 === 0) room.command(player.playerId, mode === 'move' ? { type: 'ping' } : { type: 'drive', actorId: id, throttle: 1, brake: 0 });
    room.step(); if (Math.abs(vehicle.slip) > .5 && Math.abs(vehicle.vx) > 1.5) slipped++;
    if (step % 6 === 0) look();
  }
  // Flat out its wheels spin for seconds, throwing the ground out behind them (effects.ts `surfaceSpray`, over half a
  // metre a second); its pilot asks the ground for no more than it holds, and once it is off the mark (game_motion.rs
  // `SLIP_SPEED`, under which a gear that holds creeps and churns soft ground) they grip.
  assert(vehicle.drivetrain.powerKw > 1000); assert(vehicle.x > from + 40); assert(mode === 'move' ? slipped === 0 : slipped > 300, `${slipped}`);
  assert.equal(world.dynamics.recoveries, 0);
});

test('an underpowered native vehicle is warned of after observed standstill on a slope', t => {
  const from = -250526, room = rehearsal([from - 1000]), world = room.world; t.after(() => world.dispose());
  // Its engine a quarter of the size, a sixteenth of the room: 15 kW.
  const source = createStructuredTemplate('truck');
  source.components.find(part => part.kind === 'engine').sizeScale *= .25;
  const player = room.join('Motor pequeno'), { id, start } = standing(room, player, source, from),
    vehicle = world.actor(id).vehicle, mobility = {}, notices = {}, warnings = [];
  const look = () => {
    const faction = room.factionView(player.playerId), state = { ...world.snapshot(), shared: true, faction,
      squad: room.squadView(player.playerId), players: room.roster(), localPlayerId: player.playerId },
      p = fieldPanel({ shared: true, connected: true, state, faction, playerId: player.playerId, mobility, picked: [id] });
    for (const words of fieldNotices(notices, p.watch, world.time)) if (/sem força para a subida/.test(words)) warnings.push({ time: world.time - start, words });
    return p;
  };
  look(); room.command(player.playerId, { type: 'squad', order: 'control', id });
  room.command(player.playerId, { type: 'drive', actorId: id, throttle: 1, brake: 0 });
  let stuck = 0, settledSpeed = 0;
  for (let step = 0; step < 360; step++) {
    if (step % 30 === 0) room.command(player.playerId, { type: 'drive', actorId: id, throttle: 1, brake: 0 });
    room.step(); if (vehicle.stuck === 'slope') stuck++;
    if (step >= 120) settledSpeed = Math.max(settledSpeed, Math.abs(vehicle.vx));
    if (step % 6 === 0) look();
  }
  // The weak truck settles a few centimetres downhill, without making useful progress: its mean motion stays below one
  // centimetre per second, and its speed after two seconds below two. The smallest engine there is now gives 11.25 kW,
  // three times the 3.75 kW this truck had with a quarter of the engine when its size made it deeper as well: its wheels,
  // turned harder, let it creep back at 1.8 cm/s.
  assert(stuck > 300, `slope diagnosis on ${stuck} of 360 frames`); assert(Math.abs(vehicle.x - from) / (world.time - start) < .01); assert(settledSpeed < .02, `${settledSpeed} m/s`);
  assert.equal(world.actor(id).vehicle, vehicle, 'the observation keeps the same live construction');
  assert.equal(warnings.length, 1); assert(warnings[0].time >= 2 && warnings[0].time < 3);
  assert.match(look().squad.units[0].status, /sem força para a subida/); assert.equal(world.dynamics.recoveries, 0);
});
