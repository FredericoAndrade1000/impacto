import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { bill, BASE_RADIUS, LOAD_REACH, CAPTURE_SECONDS, SHELTER_AWAY } from '../src/economy.ts';
import { AIRDROP, stepActivities } from '../server/world-activities.ts';
import { onField } from './helpers/field.js';

// The shared field with its bases far from one another, in the order their factions come — Ana's at -213, Bia's at
// 9000, Caio's at 30 000 — and the base of the next to be founded, or of a faction that establishes another, at -30 000 or
// past where they are. `put` stands a construction somewhere and lets the field look.
const BASES = [-213, 9000, 30000, -30000];
function field(t, names, options) {
  const f = onField(t, rehearsal(BASES, undefined, options)), room = f.room,
    players = names.map(name => { const player = room.players.get(room.join(name).playerId); return { id: player.id, get faction() { return player.factionId; } }; });
  return { ...f, players,
    faction: side => room.factions.get(side.faction),
    fielded: side => f.publish(side, 'scout'),
    told: side => room.factionView(side.id).bases };
}

test('a faction knows the base of another once it sees its place, and goes on knowing it where it last saw it', t => {
  const f = field(t, ['Ana', 'Bia']), [ana, bia] = f.players, scout = f.fielded(ana), home = f.faction(bia).base;
  f.run(1);
  // Ana's scout sees about her own base: of Bia's she knows nothing, nor is told anything.
  assert(!f.room.sees(ana.faction, home.x)); assert.deepEqual(f.told(ana), []); assert.equal(f.faction(ana).bases.size, 0);
  // Bia has been away long enough, with no fighting: her base is sheltered, and nobody takes it.
  const shelter = () => { f.room.disconnect(bia.id); f.faction(bia).away = f.world.time - SHELTER_AWAY; f.run(.1); assert.notEqual(f.faction(bia).shelter, null); };
  shelter();
  // Ana's scout comes by it: the place of its mast is in sight, and the base is known, whose it is, how it stands, and
  // that it is sheltered. Bia comes back, and it is sheltered no longer.
  f.put(scout, home.x - 60);
  assert(f.room.sees(ana.faction, home.x)); assert.equal(f.faction(bia).capture, null);
  const { name, nation, flag } = f.room.factionView(bia.id);
  assert.deepEqual(f.told(ana), [{ id: bia.faction, name, nation, flag, x: 9000, facing: home.facing, radius: BASE_RADIUS, seen: true, at: null, sheltered: true }]);
  assert.deepEqual(f.told(bia), [], 'knowing is one-sided: Bia saw nothing of Ana');
  f.room.join('Bia', f.room.players.get(bia.id).token);
  assert.equal(f.told(ana)[0].sheltered, false);
  // Gone from there, Ana knows it as she last saw it, and when that was; whether it is sheltered she is not told.
  const left = f.world.time;
  f.put(scout, 4000);
  assert(!f.room.sees(ana.faction, home.x));
  shelter();
  const [kept] = f.told(ana);
  assert.deepEqual([kept.x, kept.seen, kept.sheltered], [9000, false, false]); assert(Math.abs(kept.at - left) < .2, `last seen at ${kept.at}, left at ${left}`);
  f.room.join('Bia', f.room.players.get(bia.id).token);
  // It goes by the name and under the flag its members give their nation, as any faction the game names.
  const banner = { field: 'canton', colours: [4, 0, 8], emblem: 'ring' };
  f.send(bia, 'identity', { nation: 'Antártida', flag: banner });
  assert.deepEqual([f.told(ana)[0].nation, f.told(ana)[0].flag], ['Antártida', banner]);
  // A faction that is gone has no base for anybody to know.
  f.room.disband(f.faction(bia));
  assert.deepEqual(f.told(ana), []);
});

test('a base taken is known where it was by one who did not see it taken until its place is seen empty, and the base established after only once it is seen', t => {
  const f = field(t, ['Ana', 'Bia', 'Caio']), [ana, bia, caio] = f.players, scout = f.fielded(ana), old = f.faction(bia).base.x;
  f.put(scout, old - 60);
  f.put(scout, 4000);
  // Caio takes Bia's base and goes on his way, and she establishes another at -30 000. Ana sees none of it.
  const raider = f.fielded(caio); f.put(raider, old + 60);
  Object.assign(f.faction(bia).capture, { progress: CAPTURE_SECONDS - .5, at: f.world.time });
  assert(f.until(() => f.faction(bia).fell, 3), 'the base is taken');
  f.put(raider, 20000);
  assert.equal(f.send(bia, 'recover').base.x, -30000);
  f.run(1);
  assert.deepEqual(f.told(ana).map(({ x, seen }) => [x, seen]), [[old, false]], 'nothing is told of where it went');
  // Ana sees the place again: nothing stands there, and she forgets it.
  f.put(scout, old - 60);
  assert(f.room.sees(ana.faction, old)); assert.deepEqual(f.told(ana), []);
  // The new base is hers to find.
  f.put(scout, -30000 + 60);
  assert.deepEqual(f.told(ana).map(({ id, x, seen }) => [id, x, seen]), [[bia.faction, -30000, true]]);
});

test('the faction that takes a base forgets it at once, and another that knew it goes on knowing it until it sees the place', t => {
  const f = field(t, ['Ana', 'Bia', 'Caio']), [ana, bia, caio] = f.players, home = f.faction(bia).base;
  // Caio's scout passes through Bia's base and goes on its way: the capture of it that it began goes back to nothing.
  // Ana's stands armed in it, and takes it.
  const passing = f.fielded(caio); f.put(passing, home.x + 60);
  assert(f.room.sees(caio.faction, home.x)); assert.equal(f.faction(bia).capture?.by, caio.faction);
  f.put(passing, 20000);
  assert(f.until(() => !f.faction(bia).capture, 5));
  const raider = f.fielded(ana); f.put(raider, home.x - 30);
  assert.deepEqual([f.told(ana).map(base => [base.x, base.seen]), f.told(caio).map(base => [base.x, base.seen])], [[[home.x, true]], [[home.x, false]]]);
  assert.equal(f.faction(bia).capture?.by, ana.faction);
  Object.assign(f.faction(bia).capture, { progress: CAPTURE_SECONDS - .5, at: f.world.time });
  while (!f.faction(bia).fell) f.room.step();
  assert.equal(f.faction(bia).base, null);
  assert.deepEqual(f.told(ana), [], 'from the step it fell in');
  assert.deepEqual(f.told(caio).map(base => [base.x, base.seen]), [[home.x, false]], 'Caio saw nothing of it');
  f.run(1);
  assert.deepEqual(f.told(ana), [], 'and the place is empty to Ana as she stands there');
});

test('what a faction knows of the bases of others is kept with the field', t => {
  const f = field(t, ['Ana', 'Bia', 'Caio']), [ana, bia, caio] = f.players, scout = f.fielded(ana);
  f.put(scout, f.faction(bia).base.x - 60); f.put(scout, 29900);
  const kept = JSON.parse(JSON.stringify(f.room.keep())), again = rehearsal(BASES, undefined, { kept }); t.after(() => again.world.dispose());
  assert.deepEqual([...again.factions.get(ana.faction).bases], [...f.faction(ana).bases]);
  assert.deepEqual([...again.factions.get(ana.faction).bases.keys()], [bia.faction, caio.faction]);
  again.join('Ana', again.players.get(ana.id).token); again.look();
  assert.deepEqual(again.factionView(ana.id).bases, f.told(ana));
  assert.deepEqual(f.told(ana).map(({ x, seen }) => [x, seen]), [[9000, false], [30000, true]]);
  // A field kept before bases were known knows none.
  const older = structuredClone(kept);
  for (const other of older.factions) delete other.bases;
  const old = rehearsal(BASES, undefined, { kept: older }); t.after(() => old.world.dispose());
  assert.equal(old.factions.get(ana.faction).bases.size, 0);
});

test('on a field without fog every faction knows every other base, in sight', t => {
  const f = field(t, ['Ana', 'Bia', 'Caio'], { fog: false }), [ana, bia, caio] = f.players;
  assert.equal(f.faction(ana).bases, null);
  assert.deepEqual(f.told(ana).map(({ id, x, seen, at }) => [id, x, seen, at]), [[bia.faction, 9000, true, null], [caio.faction, 30000, true, null]]);
});

test('F2 airdrop: public availability uses own and canonically known bases without revealing a hidden foreign base', t => {
  const make = (other, fog = true, event = {}) => {
    const f = onField(t, rehearsal([-213, other, 30000, -30000], undefined, { fog })), { room } = f,
      players = ['Ana', 'Bia', 'Caio'].map(name => room.join(name)), [ana, bia, caio] = players,
      drop = { id: 'airdrop:1', x: 9000 + BASE_RADIUS + LOAD_REACH, stock: 4000,
        arrivesAt: room.world.time, expiresAt: room.world.time + AIRDROP.collect, ...event };
    if (drop.supplies) { delete drop.stock; delete drop.refined; }
    room.activities = { nextId: 2, nextAt: AIRDROP.interval, drop };
    const faction = player => room.faction(room.players.get(player.playerId)),
      side = room.players.get(ana.playerId).squad.side,
      view = () => room.factionView(ana.playerId).activity;
    return { ...f, players, ana, bia, caio, drop, faction, side, view };
  };
  const near = make(9000), far = make(12000), { ana, bia, caio, room, drop, faction, side, view } = near;
  assert.equal(room.reconnoitred(faction(ana)).size, 0);
  assert.equal(far.room.reconnoitred(far.faction(far.ana)).size, 0);
  assert.deepEqual(view(), far.view(), 'changing only the unknown foreign base does not change public event data');
  assert.deepEqual(side.deposit(drop.id), far.side.deposit(far.drop.id));
  assert.deepEqual(Object.keys(view()).sort(), ['active', 'arrivesAt', 'expiresAt', 'feature', 'guarded', 'id', 'left', 'material', 'phase', 'reserve', 'seen', 'stock', 'type', 'x'].sort());
  assert.equal(view().active, true); assert.equal(side.deposit(drop.id).stilled, false);
  assert.equal(room.dug(drop), false); assert.equal(far.room.dug(far.drop), true, 'the real physical base veto remains independent of the public DTO');
  const collectors = [];
  for (const f of [near, far]) {
    const id = f.publish(f.ana, 'truck');
    collectors.push(id);
    assert.deepEqual(f.order(f.ana, 'haul', { ids: [id], depositId: f.drop.id }), {});
    assert.equal(f.room.players.get(f.ana.playerId).squad.units.get(id).haul.depositId, f.drop.id);
    f.order(f.ana, 'stop', { ids: [id] });
  }
  const scout = near.publish(ana, 'scout'), base = faction(bia).base.x;
  near.put(scout, base - 60);
  assert(room.reconnoitred(faction(ana)).has(faction(bia).id), 'a real sensor look learned the other base');
  assert.equal(view().active, false); assert.equal(side.deposit(drop.id).stilled, true);
  assert.throws(() => near.order(ana, 'haul', { ids: [collectors[0]], depositId: drop.id }), /perto demais de uma base/);
  drop.x = base + BASE_RADIUS + LOAD_REACH + .01;
  assert.equal(view().active, true); assert.equal(side.deposit(drop.id).stilled, false, 'just beyond the canonical base margin remains available');
  drop.x = base + BASE_RADIUS + LOAD_REACH;
  near.put(scout, 4000);
  assert.equal(room.reconnoitred(faction(ana)).get(faction(bia).id).x, base);
  const raider = near.publish(caio, 'scout'); near.put(raider, base + 60);
  assert(faction(bia).capture, 'the real third-party scout contests the base');
  Object.assign(faction(bia).capture, { progress: CAPTURE_SECONDS - .5, at: near.world.time });
  assert(near.until(() => faction(bia).fell, 3)); near.put(raider, 20000);
  assert.equal(faction(bia).base, null);
  assert.equal(room.dug(drop), true);
  assert.equal(view().active, false); assert.equal(side.deposit(drop.id).stilled, true, 'the unseen loss is still represented by the existing base memory');
  near.put(scout, base - 60);
  assert.equal(room.reconnoitred(faction(ana)).has(faction(bia).id), false, 'seeing the empty place clears the canonical memory');
  assert.equal(view().active, true); assert.equal(side.deposit(drop.id).stilled, false);
  drop.x = faction(ana).base.x + BASE_RADIUS + LOAD_REACH;
  assert.equal(view().active, false); assert.equal(side.deposit(drop.id).stilled, true, 'own base uses the same exact margin');
  const noFog = make(9000, false);
  assert.equal(noFog.faction(noFog.ana).bases, null);
  assert.equal(noFog.view().active, false); assert.equal(noFog.side.deposit(noFog.drop.id).stilled, true, 'without fog the canonical reader already knows every base');
  // New refined drops have private discovery, independent of whether the faction knows a foreign base.
  const discovery = make(12000, true, { x: 60000, supplies: { ...AIRDROP.supplies }, known: [],
    arrivesAt: AIRDROP.notice, expiresAt: AIRDROP.notice + AIRDROP.collect }), q = discovery.room,
    mine = discovery.faction(discovery.ana), other = discovery.faction(discovery.bia), border = discovery.faction(discovery.caio);
  stepActivities(q);
  assert.deepEqual(discovery.drop.known, [border.id], 'a base at exactly 30 km discovers the announcement');
  assert.equal(discovery.view(), null, 'the distant faction has no DTO, even while another knows the event');
  assert.equal(q.factionView(discovery.bia.playerId).activity, null);
  assert.equal(q.factionView(discovery.caio.playerId).activity.refined, true);
  const candidate = discovery.publish(discovery.ana, 'truck');
  // Query a collection descriptor without stepping the guardian: this case is about disclosure, not combat.
  discovery.drop.arrivesAt = q.world.time;
  assert.equal(discovery.side.deposit(discovery.drop.id), null);
  assert.equal(discovery.side.veinAt(discovery.drop.x), null);
  assert.throws(() => discovery.order(discovery.ana, 'haul', { ids: [candidate], depositId: discovery.drop.id }), /Jazida desconhecida/,
    'guessing the event ID does not grant a route or transport order');
  assert.equal(q.players.get(discovery.ana.playerId).squad.units.get(candidate)?.haul ?? null, null);
  discovery.drop.arrivesAt = AIRDROP.notice;
  const forward = discovery.publish(discovery.ana, 'scout'), forwardRecord = q.records.get(forward);
  forwardRecord.service = { kind: 'build', until: q.world.time + 10000 };
  discovery.put(forward, discovery.drop.x - 100);
  assert(!discovery.drop.known.includes(mine.id), 'an incomplete forward construction does not discover');
  forwardRecord.service = { kind: 'repair', until: q.world.time + 10000 };
  stepActivities(q);
  assert(discovery.drop.known.includes(mine.id), 'a completed operational forward construction still discovers while under repair');
  const dto = discovery.view();
  assert.equal(dto.refined, true); assert.deepEqual(dto.supplies, AIRDROP.supplies);
  assert.deepEqual(Object.keys(dto).sort(), [...Object.keys(view()).filter(k => !['material','reserve','left','stock'].includes(k)), 'refined', 'supplies'].sort(), 'no known IDs, discoverer, base or source metadata enters the DTO');
  discovery.drop.arrivesAt = q.world.time;
  assert.equal(discovery.side.deposit(discovery.drop.id).refined, true);
  assert.equal(discovery.side.veinAt(discovery.drop.x).id, discovery.drop.id);
  discovery.drop.arrivesAt = AIRDROP.notice;
  forwardRecord.service = null;
  discovery.put(forward, mine.base.x);
  assert(discovery.drop.known.includes(mine.id), 'moving away retains private event knowledge until this drop ends');
  const fallen = discovery.publish(discovery.bia, 'scout');
  discovery.set(discovery.parts(fallen, 'command')[0], { health: 0 });
  discovery.put(fallen, discovery.drop.x - 100);
  assert(q.records.get(fallen).wreck, 'the commandless construction follows the real wreck path');
  assert(!discovery.drop.known.includes(other.id), 'a wreck or construction out of action never discovers');
  discovery.drop.arrivesAt = q.world.time;
  discovery.drop.retireAt = q.world.time + AIRDROP.warning; discovery.drop.supplies = bill();
  const withdrawing = discovery.view();
  assert.equal(withdrawing.phase, 'withdrawal'); assert.equal(withdrawing.active, false);
  assert.equal(q.factionView(discovery.bia.playerId).activity, null, 'withdrawal does not disclose the event to an unaware faction');
  const post = discovery.raise(discovery.bia, 'bunker'), postX = q.position(q.world.actor(post)), offset = postX - other.base.x;
  q.activities.drop = { id: 'airdrop:2', x: other.base.x + Math.sign(offset) * (AIRDROP.noticeReach + Math.abs(offset) / 2),
    supplies: { ...AIRDROP.supplies }, known: [], arrivesAt: q.world.time + AIRDROP.notice,
    expiresAt: q.world.time + AIRDROP.notice + AIRDROP.collect };
  assert(Math.abs(q.activities.drop.x - other.base.x) > AIRDROP.noticeReach, 'the base itself is outside discovery reach');
  stepActivities(q);
  assert(q.activities.drop.known.includes(other.id), 'a real completed fixed outpost also discovers, without a mobile-only restriction');
  assert.deepEqual([...room.faults, ...far.room.faults, ...noFog.room.faults, ...q.faults], []);
});
