import { createStructuredTemplate } from '../../src/structured-templates.ts';
import { compileStructuredConstruction } from '../../src/structured-construction.ts';
import { constructionSite } from '../../server/field-construction.ts';
import { footingVolume } from '../../src/fixed-footing.ts';

const designOf = design => typeof design === 'string' ? createStructuredTemplate(design) : design;

// What a test does on a shared field (server/room.ts), whatever room it made: steps it, publishes constructions of a
// player's and stands them elsewhere, opens works of structures and raises them, and sends what a page sends. A player is
// named as the room's `join` answers (`playerId`) or by its seat (`id`). The world goes with the test.
export function onField(t, room) {
  const world = room.world, ground = world.terrain;
  t.after(() => world.dispose());
  // A player may publish however soon after the last time: the wait between two is no part of what a test looks at.
  const seat = player => player.playerId ?? player.id, ready = player => { room.players.get(seat(player)).builtAt = -Infinity; return seat(player); },
    run = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) room.step(); };
  // The first place, `from` metres off the player's base or further, to either side, where a structure may stand for its
  // faction (field-construction.ts) with no footing to pay for (fixed-footing.ts): ordinary level ground the faction has seen.
  const site = (player, design, { from = 160, facing = 1, ignore = null } = {}) => {
    const faction = room.faction(room.players.get(seat(player))), source = designOf(design), blueprint = compileStructuredConstruction(source);
    for (let d = from; d < from + 800; d += 4) for (const side of [1, -1]) {
      const x = faction.base.x + side * d;
      try { constructionSite(room, faction, source, x, facing, ignore); } catch { continue; }
      if (!footingVolume(blueprint, ground, { x, facing })) return x;
    }
    throw new Error('The fixture needs clear level ground off the base.');
  };
  // A works of a structure opened by a player where it says (`x`), or at the first place it may stand: its name.
  const open = (player, design, { x = null, facing = 1, ...how } = {}) =>
    room.command(ready(player), { type: 'spawn', blueprint: designOf(design), x: x ?? site(player, design, { facing }), facing, ...how }).work.id;
  return { room, world, ground, run, site, open,
    // Steps the field until `done`, for `seconds` at most: whether it came about.
    until: (done, seconds) => { for (let i = 0; i < seconds * 60 && !done(); i++) room.step(); return done(); },
    // A vehicle of a template, or a design, published by a player `how` it says.
    publish: (player, design, how) => room.publish(ready(player), designOf(design), how).actor.id,
    // A structure raised for a player at once, where `open` opens its works: all its material brought to it from the stocks
    // of the faction, and put up as a builder puts it up (`Works.complete`). Its name.
    raise: (player, design, how) => {
      const id = open(player, design, how), work = room.works.pending.get(id), stock = room.faction(room.players.get(seat(player))).stock;
      for (const material of Object.keys(work.cost)) stock[material] -= work.cost[material];
      work.delivered = { ...work.cost }; work.progress = 1; room.works.complete(work);
      if (!world.actor(id)) throw new Error(room.works.blocked.get(id) || 'The structure was not raised.');
      return id;
    },
    send: (player, type, data = {}) => room.command(ready(player), { type, ...data }),
    order: (player, order, data = {}) => room.command(seat(player), { type: 'squad', order, ...data }),
    // Stands a construction somewhere else, at rest on its ground, and lets the field look.
    put: (id, x) => { const v = world.actor(id).vehicle;
      world.command('setVehicleState', { actorId: id, state: { x, y: v.y - ground.height(v.x) + ground.height(x), vx: 0, vy: 0 } }); run(1.5); },
    parts: (id, ...kinds) => world.modules.filter(m => m.actorId === id && kinds.includes(m.kind)),
    set: (module, state) => world.game().call({ op: 'setPartState', owner: world.game().handle(module), state }) };
}
