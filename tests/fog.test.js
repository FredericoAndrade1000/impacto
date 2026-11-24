import test from 'node:test';
import assert from 'node:assert/strict';
import { Fog, chapters, witness, witnessed, happenings, aloft, GHOST_SECONDS, BLIP_SECONDS, SOUND_SECONDS, SIGHT_GRACE, TOLD_SLACK } from '../server/fog.ts';
import { BASE_MARGIN, FELT_REACH } from '../src/battle-rules.ts';
import { GroundSight } from '../src/ground-sight.ts';
import { WRECK_SECONDS } from '../src/economy.ts';
import { listShots } from '../src/shots.ts';
import { rehearsal, SharedRoom, Side } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { VIEW } from '../src/network-protocol.ts';
import { Publication } from '../server/publication.ts';
import { Renderer } from '../src/render.ts';
import { sampleScene } from '../src/scene-frame.ts';

// A field of constructions with one plate, one module and one panel each.
const construction = (id, team, x) => ({
  actor: { id, team, x, vehicle: { x, y: 1 } },
  plates: [{ id: id + ':hull', actorId: id }], modules: [{ id: id + ':gun', actorId: id }],
  bodyPanels: [{ id: id + ':panel', actorId: id }],
});
const state = (time, ...built) => ({ time, shots: 'rounds', actors: built.map(b => b.actor), plates: built.flatMap(b => b.plates),
  modules: built.flatMap(b => b.modules), bodyPanels: built.flatMap(b => b.bodyPanels) });
const ids = told => told.actors.map(a => a.id);
const seen = (actorId, x = 50) => ({ actorId, channel: 'visual', visible: true, x, y: 2, error: .5, by: 'a1' });
// A sight of a faction that witnesses all from `lo` to `hi`, however high, as it does at a base, and whose constructions are `own`.
const over = (lo, hi, own = [], more = {}) => ({ ...witness({ actors: [] }, null, { base: { x: (lo + hi) / 2, radius: (hi - lo) / 2 - BASE_MARGIN } }),
  own: new Set(own), ...more });

test('a state is taken apart by construction and put together again as it was', () => {
  const a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50), whole = state(0, a, b), parts = chapters(whole);
  assert.deepEqual([...parts.keys()], ['a1', 'b1']);
  assert.deepEqual(parts.get('b1'), b);
  assert.equal(parts.get('a1').plates[0], whole.plates[0], 'the items are those of the state, not copies');
});

test('a fixed construction seen on high ground retains its exterior height through fog, ghosts and renderer culling while radar alone reveals no chapter', () => {
  const fog = new Fog(), own = { id: 'a1', team: 'red', x: 0, vehicle: { x: 0, y: 700, angle: 0 } },
    bunker = { id: 'b1', team: 'blue', preset: 'bunker', x: 20, y: 700, vehicle: null },
    high = { ...state(0), shared: true, faction: { id: 'red' }, actors: [own, bunker],
      bodyPanels: [{ id: 'b1:panel', actorId: 'b1', poly: [{ x: 17, y: 700 }, { x: 23, y: 700 }, { x: 23, y: 702 }, { x: 17, y: 702 }] }] };
  fog.read({ sight: { red: [{ ...seen('b1', 20), y: 701 }] } }, 0);
  const visual = fog.tell(high, chapters(high), 'red'), empty = { ...high, time: 1, actors: [own], bodyPanels: [] };
  fog.read({ sight: {} }, 1);
  const ghost = fog.tell(empty, chapters(empty), 'red');
  for (const told of [visual, ghost]) {
    const actorLayers = new Map(told.actors.map(actor => [actor.id, { container: { visible: true } }])),
      renderer = { mode: 'test', camera: { x: 20, y: 700, zoom: 10, width: 800, height: 600 },
        scene: sampleScene(told), actorLayers, unseen: new Set(), dotted: new Set(), closed: new Set(), opened: null, layGuns() {}, drawDots() {} };
    Renderer.prototype.cullActors.call(renderer, told);
    assert.equal(actorLayers.get('b1').container.visible, true, 'an authorized exterior on high ground is inside the viewport');
    assert.equal(told.actors.find(actor => actor.id === 'b1').y, 700);
  }
  assert(ghost.actors.find(actor => actor.id === 'b1').ghost, 'the last-seen height survives without a current chapter');
  const radar = new Fog(); radar.read({ sight: { red: [{ ...seen('b1', 20), channel: 'radar', y: 701 }] } }, 0);
  const marked = radar.tell(high, chapters(high), 'red');
  assert.deepEqual(ids(marked), ['a1'], 'a non-optical reading does not gain the fixed construction or its height');
  assert.deepEqual(marked.bodyPanels, [], 'radar supplies no hull chapter either');
  assert.deepEqual(marked.contacts.map(contact => contact.kind), ['radar']);
});

test('the constructions of a real field are taken apart with every part', t => {
  const room = rehearsal([-100, 60]); t.after(() => room.world.dispose());
  for (const [name, model, x] of [['Alice', 'heavy', -90], ['Bob', 'scout', 60]])
    room.publish(room.join(name).playerId, createStructuredTemplate(model), { x, facing: 1 });
  const whole = room.world.snapshot(), parts = chapters(whole);
  for (const actor of room.world.actors) {
    const chapter = parts.get(actor.id);
    assert.equal(chapter.bodyPanels.length, actor.bodyPanels.length);
    assert(chapter.plates.length && chapter.modules.length);
  }
  for (const name of ['plates', 'modules', 'bodyPanels'])
    assert.deepEqual([...parts.values()].flatMap(c => c[name]), whole[name], name + ' keep the order of the state');
});

test('a faction is told its own constructions, and another\'s only while its sensors see it', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50), field = time => { const s = state(time, a, b); return [s, chapters(s)]; };
  let told = fog.tell(...field(0), 'red');
  assert.deepEqual(ids(told), ['a1']); assert.deepEqual(told.plates, a.plates);
  assert.deepEqual(told.contacts, []); assert.equal(told.shots, 'rounds', 'what is not a construction is told as it is');
  assert.equal(fog.knows('red', a.actor, 0), 'own'); assert.equal(fog.knows('red', b.actor, 0), null);
  fog.read({ sight: { red: [seen('b1')] } }, .1);
  told = fog.tell(...field(.1), 'red');
  assert.deepEqual(ids(told), ['a1', 'b1']); assert.deepEqual(told.actors[1], { ...b.actor, [VIEW]: 'outside' }, 'seen, it is told as it shows from outside');
  assert.equal(told.actors[0], a.actor, 'its own is the very construction of the state');
  assert.deepEqual(told.modules, [...a.modules, ...b.modules.map(m => ({ ...m, [VIEW]: 'outside' }))]);
  assert.equal(told.modules[0], a.modules[0], 'its own pieces are the very pieces of the state');
  assert.equal(fog.knows('red', b.actor, .1), 'seen');
  assert.deepEqual(ids(fog.tell(...field(.1), 'blue')), ['b1'], 'what one faction sees says nothing to another');
  // A sight stands between readings, and for a moment after the last one.
  assert.deepEqual(ids(fog.tell(...field(.1 + SIGHT_GRACE), 'red')), ['a1', 'b1']);
  // A contact the reading did not take is a memory of the core: it is no sight.
  fog.read({ sight: { red: [{ ...seen('b1'), visible: false }] } }, 1);
  assert.equal(fog.knows('red', b.actor, 1), 'ghost');
});

test('of a construction of another faction a faction is told what shows from outside, and nothing else of it leaves the field', () => {
  // A hull four metres long and two tall, at rest and then tilted: an engine, a tank and two cargo containers in it,
  // a gun through its armour, extraction mechanisms that work outside, an open hopper, a camera on its roof, a wheel
  // under it, and an engine that came loose. The face of the hull keeps the pose it was
  // made at, far from where the vehicle has taken it since.
  const hull = (x, angle = 0) => ({ x, y: 1, angle }), at = (pose, u, v) => ({ x: pose.x + Math.cos(pose.angle) * u - Math.sin(pose.angle) * v, y: pose.y + Math.sin(pose.angle) * u + Math.cos(pose.angle) * v }),
    tank = (id, team, pose) => {
      const piece = (name, kind, u, v, more = {}) => ({ id: id + ':' + name, actorId: id, kind, ...at(pose, u, v), ...more });
      return { actor: { id, team, x: pose.x, name: 'Carro', eyes: [{ x: pose.x, y: 2.2, left: 1000, right: 1000 }], aim: { x: 90, y: 3 }, weapon: 'gun', cooldown: 1.5, stats: { shots: 7 }, contactContours: [[0, 0, 1, 0]],
          vehicle: { ...pose, vx: 3, vy: 0, omega: 0, throttle: 1, engine: true, slip: 0, traction: 1, fuelLitres: 40, fuelRate: .01, rangeKm: 120, fuelStarved: false, massTonnes: 12, maxSpeed: 14, powerKw: 300,
            powerPerTonne: 25, groundPressureKPa: 80, softGroundLoad: 0 } },
        plates: [{ id: id + ':roof', actorId: id }],
        modules: [piece('engine', 'engine', -1, 0), piece('fuel', 'fuel', .5, -.4, { fuelLitres: 40 }), piece('gun', 'weapon', 1.5, .2), piece('camera', 'sensor', 0, 1.2), piece('wheel', 'wheel', -1, -1.3),
          piece('loose', 'engine', 0, 0, { attached: false }), piece('hopper', 'hopper', -.2, .3, { cargo: { ferro: 42 }, capacityM3: 2 }),
          piece('cistern', 'cistern', .2, -.3, { cargo: { petroleo: 99 }, capacityM3: 1 }),
          piece('excavator', 'excavator', -.6, .3, { mirrored: true }), piece('drill', 'drill', .3, .3),
          piece('open-hopper', 'hopper', 2.5, .3, { cargo: { silica: 60 }, capacityM3: 1.5 })],
        bodyPanels: [{ id: id + ':panel', actorId: id, pose: hull(-900), localPolygon: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }] }] };
    };
  for (const angle of [0, .9]) {
    const fog = new Fog(), a = tank('a1', 'red', hull(0)), b = tank('b1', 'blue', hull(50, angle)), whole = state(0, a, b), parts = chapters(whole);
    fog.read({ sight: { red: [seen('b1')], green: [seen('b1')] } }, 0);
    const told = fog.tell(whole, parts, 'red'), names = list => list.filter(item => item.actorId === 'b1').map(item => item.id.split(':')[1]);
    // Her own she is told whole, the very objects of the state.
    assert.equal(told.actors[0], a.actor); assert.deepEqual(told.modules.filter(m => m.actorId === 'a1'), a.modules);
    // His: the gun, the camera on the roof, the wheel, what lies loose, the extraction mechanisms whose arms work
    // in the open, and the hopper outside. The containers inside no longer have arms and remain private, as do
    // the engine and the fuel.
    assert.deepEqual(names(told.modules), ['gun', 'camera', 'wheel', 'loose', 'excavator', 'drill', 'open-hopper'], 'tilted by ' + angle);
    const open = told.modules.find(m => m.id === 'b1:open-hopper');
    assert.deepEqual([open.cargo, open.capacityM3], [{ silica: 60 }, 1.5], 'the visible container keeps the load that is drawn');
    assert.deepEqual(told.modules.find(m => m.id === 'b1:gun'), { ...b.modules[2], barrelTemperature: 0, [VIEW]: 'outside' }, 'what shows of a piece is all a page draws it by: of a gun, its barrel only as the air over it shimmers');
    assert.equal(told.modules.find(m => m.id === 'b1:excavator').mirrored, true, 'visible mechanisms keep their reflected orientation');
    assert.deepEqual([told.plates[1], told.bodyPanels[1]], [b.plates[0], b.bodyPanels[0]]);
    // Of the construction, what is seen and heard of it: where it is and how it moves, not its eyes, its aim, its fuel, its power or its pedals.
    const foe = told.actors[1];
    assert.deepEqual(foe, { id: 'b1', team: 'blue', x: 50, name: 'Carro', [VIEW]: 'outside', vehicle: { ...hull(50, angle), vx: 3, vy: 0, omega: 0, engine: true, slip: 0, traction: 1 } });
    assert.deepEqual([Object.keys(b.actor).length, Object.keys(b.actor.vehicle).length], [11, 20], 'and the construction of the state is as it was');
    // Every faction that sees it is told the same objects, and the state itself still has all of it.
    const other = fog.tell(whole, parts, 'green');
    assert.equal(other.actors[0], foe); assert.deepEqual(whole.modules.length, 22); assert.equal(fog.tell(whole, parts, 'blue').actors[0], b.actor);
    assert.equal(other.modules.find(m => m.id === 'b1:gun'), told.modules.find(m => m.id === 'b1:gun'), 'and the same piece, whoever is told it');
    // Lost from sight, the ghost is what was told: it has no more in it.
    const later = state(5, a, tank('b1', 'blue', hull(400))), ghost = fog.tell(later, chapters(later), 'red');
    assert.deepEqual(names(ghost.modules), ['gun', 'camera', 'wheel', 'loose', 'excavator', 'drill', 'open-hopper']);
    assert.deepEqual(ghost.actors[1], { ...foe, ghost: { since: 0 }, vehicle: { ...foe.vehicle, vx: 0, vy: 0, omega: 0, engine: false } });
    assert.equal(fog.ghost('red', 'b1', 5), foe);
  }
  // What has no vehicle stands where it was made: its faces say where.
  const fog = new Fog(), post = tank('b1', 'blue', hull(50)); post.actor.vehicle = null; post.bodyPanels[0].pose = hull(50);
  const whole = state(0, tank('a1', 'red', hull(0)), post); fog.read({ sight: { red: [seen('b1')] } }, 0);
  const told = fog.tell(whole, chapters(whole), 'red');
  assert.deepEqual(told.modules.filter(m => m.actorId === 'b1').map(m => m.id), ['b1:gun', 'b1:camera', 'b1:wheel', 'b1:loose', 'b1:excavator', 'b1:drill', 'b1:open-hopper']);
  assert.equal(told.actors[1].vehicle, null);
});

test('a construction lost from sight stays as a ghost, as it was and where it was', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50);
  fog.read({ sight: { red: [seen('b1', 51)] } }, 0);
  const first = state(0, a, b); fog.tell(first, chapters(first), 'red');
  // It drives away unseen: the faction keeps what it last saw.
  const moved = construction('b1', 'blue', 400), later = state(5, a, moved), told = fog.tell(later, chapters(later), 'red');
  assert.deepEqual(ids(told), ['a1', 'b1']);
  assert.deepEqual(told.actors[1], { ...b.actor, [VIEW]: 'outside', ghost: { since: 0 }, vehicle: { ...b.actor.vehicle, vx: 0, vy: 0, omega: 0, engine: false } },
    'it is the construction last told, said to be a ghost and to stand still and silent');
  assert.equal(told.plates[1], b.plates[0], 'the parts are those last told');
  assert.deepEqual(told.contacts, []); assert.equal(fog.knows('red', moved.actor, 5), 'ghost');
  assert.deepEqual(fog.ghosts(5), [{ team: 'red', actorId: 'b1', x: 51, y: 2 }]);
  const again = state(6, a, moved), next = fog.tell(again, chapters(again), 'red');
  assert.equal(next.actors[1], told.actors[1], 'a ghost is the same object frame after frame: nothing of it is told again');
  // It is gone from the field, unseen: the ghost stands all the same, for its time.
  const empty = state(GHOST_SECONDS, a); assert.deepEqual(ids(fog.tell(empty, chapters(empty), 'red')), ['a1', 'b1']);
  const late = state(GHOST_SECONDS + .1, a); assert.deepEqual(ids(fog.tell(late, chapters(late), 'red')), ['a1']);
  fog.read({ sight: {} }, GHOST_SECONDS + .1); assert.equal(fog.books.get('red').size, 0, 'what nothing is held of is forgotten');
});

test('an observed wreck is remembered for the field wreck lifetime since its last sight, without nonvisual renewal or an unseen departure', () => {
  const fog = new Fog(), at = 17, a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50), c = construction('c1', 'blue', 80);
  b.actor.defeated = true; b.actor.field = { wreck: { until: at + 1 } };
  fog.read({ sight: { red: [seen('b1'), seen('c1', 80)] } }, at);
  const first = state(at, a, b, c); fog.tell(first, chapters(first), 'red');
  const present = new Set(['a1']), afterLive = at + GHOST_SECONDS + .01;
  // Both left the field unseen: the live ghost expires normally, while the observed wreck remains.
  fog.read({ sight: {} }, afterLive, present);
  const empty = state(afterLive, a), memory = fog.tell(empty, chapters(empty), 'red');
  assert.deepEqual(ids(memory), ['a1', 'b1']); assert.equal(fog.books.get('red').has('c1'), false);
  const remembered = memory.actors[1]; assert.equal(remembered.defeated, true); assert(remembered.ghost);
  assert.equal(fog.left('red', 'b1'), false, 'an unseen removal is not known to the faction');
  const nearEnd = at + WRECK_SECONDS - .01;
  fog.read({ sight: { red: ['radar', 'sound'].map(channel => ({ ...seen('b1', 500), channel })) } }, nearEnd, present);
  assert.equal(fog.books.get('red').get('b1').seenAt, at, 'only visual evidence renews the window');
  const last = state(at + WRECK_SECONDS, a); fog.read({ sight: {} }, last.time, present);
  const held = fog.tell(last, chapters(last), 'red');
  assert.equal(held.actors[1], remembered, 'the same frozen exterior stands through the last valid instant');
  assert.deepEqual(held.contacts, []); assert.equal(fog.knows('red', b.actor, last.time), 'ghost');
  const expired = state(at + WRECK_SECONDS + .01, a); fog.read({ sight: {} }, expired.time, present);
  assert.deepEqual(ids(fog.tell(expired, chapters(expired), 'red')), ['a1']);
  assert.equal(fog.books.get('red').has('b1'), false, 'expired material is pruned as well as hidden');
  assert.equal(fog.left('red', 'b1'), false, 'expiry is forgetting, not evidence that the wreck left');
});

test('ghosts share immutable published parts while the live field moves and its suspension changes', () => {
  const fog = new Fog(), publication = new Publication(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50);
  b.plates[0].definition = { x: 50, y: 1, angle: 0, length: 2, thicknessMm: 10 };
  Object.assign(b.modules[0], { kind: 'wheel', suspension: { displacement: .1 } });
  const first = publication.state(state(0, a, b)), parts = chapters(first), plate = first.plates[1], wheel = first.modules[1];
  Object.freeze(plate); Object.freeze(plate.definition); Object.freeze(wheel.suspension);
  fog.read({ sight: { red: [seen('b1')], green: [seen('b1')] } }, 0);
  for (const team of ['red', 'green']) {
    const told = fog.tell(first, parts, team);
    assert.equal(told.plates.find(part => part.actorId === 'b1'), plate);
    assert.equal(told.modules.find(part => part.actorId === 'b1').suspension, wheel.suspension);
  }
  b.plates[0].definition.x = b.actor.vehicle.x = 500;
  b.modules[0].suspension.displacement = .2;
  const next = publication.state(state(2, a, b)), chaptersNow = chapters(next);
  fog.read({ sight: {} }, 2);
  for (const team of ['red', 'green']) {
    const ghost = fog.tell(next, chaptersNow, team);
    assert(ghost.actors.find(actor => actor.id === 'b1').ghost);
    assert.equal(ghost.plates.find(part => part.actorId === 'b1').definition.x, 50);
    assert.equal(ghost.modules.find(part => part.actorId === 'b1').suspension.displacement, .1);
  }
  const own = fog.tell(next, chaptersNow, 'blue');
  assert.equal(own.plates[0].definition.x, 500);
  assert.equal(own.modules[0].suspension.displacement, .2);
});

test('a ghost goes when its place is seen empty, and when the construction is seen again', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50), field = time => { const s = state(time, a, b); return [s, chapters(s)]; };
  fog.read({ sight: { red: [seen('b1')] } }, 0); fog.tell(...field(0), 'red');
  assert.equal(fog.tell(...field(2), 'red').actors[1].ghost.since, 0);
  fog.read({ sight: { red: [seen('b1')] } }, 3);
  assert.deepEqual(fog.tell(...field(3), 'red').actors[1], { ...b.actor, [VIEW]: 'outside' }, 'seen again, it is itself');
  assert.deepEqual(fog.ghosts(3), []);
  assert.equal(fog.tell(...field(5), 'red').actors[1].ghost.since, 3);
  fog.read({ sight: {}, cleared: [{ team: 'red', actorId: 'b1' }] }, 6);
  assert.deepEqual(ids(fog.tell(...field(6), 'red')), ['a1']); assert.equal(fog.knows('red', b.actor, 6), null);
});

test('what a faction went on seeing with nobody to tell it leaves no ghost: a ghost is what was told', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50);
  fog.read({ sight: { red: [seen('b1')] } }, 0);
  const first = state(0, a, b); fog.tell(first, chapters(first), 'red');
  // Its pages are away while its sensors go on seeing the construction, which drives off; then it is lost.
  for (let time = .1; time < 5; time += .1) fog.read({ sight: { red: [seen('b1', 50 + time * 20)] } }, time);
  assert.equal(fog.knows('red', b.actor, 5), 'seen');
  fog.read({ sight: {} }, 6);
  assert.equal(fog.knows('red', b.actor, 6), null); assert.deepEqual(fog.ghosts(6), []);
  const later = state(6, a, b); assert.deepEqual(ids(fog.tell(later, chapters(later), 'red')), ['a1'], 'what was last told of it is not how it was last seen');
  // Told within a second of the last sight, it is a ghost as before.
  fog.read({ sight: { red: [seen('b1')] } }, 7); const seenAgain = state(7, a, b); fog.tell(seenAgain, chapters(seenAgain), 'red');
  fog.read({ sight: { red: [seen('b1')] } }, 7 + TOLD_SLACK);
  assert.equal(fog.knows('red', b.actor, 9), 'ghost');
});

test('a construction seen to leave the field leaves no ghost', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50);
  fog.read({ sight: { red: [seen('b1')] } }, 0);
  const first = state(0, a, b); fog.tell(first, chapters(first), 'red');
  assert.equal(fog.left('red', 'b1'), false);
  const gone = state(.1, a); assert.deepEqual(ids(fog.tell(gone, chapters(gone), 'red')), ['a1']);
  const later = state(2, a); assert.deepEqual(ids(fog.tell(later, chapters(later), 'red')), ['a1']);
  assert.equal(fog.left('red', 'b1'), true, 'and its faction knows it is gone'); assert.equal(fog.left('blue', 'b1'), false);
});

test('a construction seen to leave between two readings is known to be gone, and one lost from sight first is not', () => {
  const fog = new Fog();
  // Nobody of either faction is told the field: the readings alone say what each saw go.
  fog.read({ sight: { red: [seen('b1'), seen('b2', 80)] } }, 0, new Set(['a1', 'b1', 'b2']));
  fog.read({ sight: { red: [seen('b2', 80)] } }, 1, new Set(['a1', 'b1', 'b2']));
  // b2 goes while red sees it; b1, lost a second ago, goes unseen.
  fog.read({ sight: { red: [] } }, 1.1, new Set(['a1']));
  assert.deepEqual([fog.left('red', 'b2'), fog.left('red', 'b1')], [true, false]);
  assert.equal(fog.knows('red', { id: 'b2', team: 'blue' }, 1.1), null, 'what it saw go it does not see');
  // A wreck the faction took off itself it knows to be gone; a faction that is forgotten knows nothing of it.
  fog.gone('red', 'b1'); assert.equal(fog.left('red', 'b1'), true);
  fog.forget('red'); assert.equal(fog.left('red', 'b2'), false);
});

test('what a radar holds is a mark, and what is heard is the side it came from', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 900), c = construction('c1', 'blue', -700),
    field = time => { const s = state(time, a, b, c); return [s, chapters(s)]; };
  fog.read({ sight: { red: [{ actorId: 'b1', channel: 'radar', visible: true, x: 905, y: 3, error: 11, by: 'a1' },
    { actorId: 'c1', channel: 'sound', visible: true, x: -500, y: 0, error: 200, by: 'a1' }] } }, 1);
  let told = fog.tell(...field(1), 'red');
  assert.deepEqual(ids(told), ['a1'], 'neither is shown as a construction');
  assert.deepEqual(told.contacts, [{ id: 'b1', kind: 'radar', x: 905, y: 3, error: 11, at: 1 }, { kind: 'sound', by: 'a1', side: -1, at: 1 }]);
  assert.equal(fog.knows('red', b.actor, 1), 'radar'); assert.equal(fog.knows('red', c.actor, 1), null, 'a sound is no target');
  told = fog.tell(...field(1 + SOUND_SECONDS + .1), 'red');
  assert.deepEqual(told.contacts.map(k => k.kind), ['radar'], 'a sound fades first');
  assert.deepEqual(fog.tell(...field(1 + BLIP_SECONDS + .1), 'red').contacts, []);
  assert.equal(fog.knows('red', b.actor, 1 + BLIP_SECONDS + .1), null);
});

test('a radar that holds what was lost from sight puts its mark in the place of the ghost', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50), field = time => { const s = state(time, a, b); return [s, chapters(s)]; };
  fog.read({ sight: { red: [seen('b1')] } }, 0); fog.tell(...field(0), 'red');
  assert.equal(fog.tell(...field(2), 'red').actors.length, 2);
  fog.read({ sight: { red: [{ actorId: 'b1', channel: 'radar', visible: true, x: 300, y: 2, error: 4, by: 'a1' }] } }, 3);
  const told = fog.tell(...field(3), 'red');
  assert.deepEqual(ids(told), ['a1']); assert.deepEqual(told.contacts, [{ id: 'b1', kind: 'radar', x: 300, y: 2, error: 4, at: 3 }]);
});

test('a faction witnesses what is in the reach of its eyes, at its base and right by its constructions', () => {
  const tank = (id, team, x, more = {}) => ({ id, team, x, vehicle: { x, y: 1 }, ...more });
  // One with an eye to each side, one with none, a wreck, which sees nothing, and one of another faction.
  const field = { actors: [tank('a1', 'red', 0, { eyes: [{ x: 1, y: 2, left: 1000, right: 0 }, { x: 2, y: 2, left: 0, right: 650 }] }), tank('a2', 'red', 5000),
    tank('a3', 'red', 9000, { defeated: true, eyes: [{ x: 9000, y: 2, left: 500, right: 500 }] }), tank('b1', 'blue', 3000, { eyes: [{ x: 3000, y: 2, left: 800, right: 800 }] })] };
  assert.deepEqual([BASE_MARGIN, FELT_REACH], [50, 16]);
  const red = witness(field, 'red', { base: { x: -3000, radius: 100 } }), blue = witness(field, 'blue'), sees = (sight, places) => places.map(([x, y]) => witnessed(sight, x, y));
  // What it reaches over, merged: what lies past all of it is passed over at once.
  assert.deepEqual(red.zones.map(zone => [zone.lo, zone.hi]), [[-3150, -2850], [-999, 652], [4984, 5016], [8984, 9016]]);
  assert.deepEqual([red.own, blue.own], [new Set(['a1', 'a2', 'a3']), new Set(['b1'])]);
  // Its base, however high, out to past its ends.
  assert.deepEqual(sees(red, [[-3000, 5000], [-2851, 1], [-3151, 1]]), [true, true, false]);
  // An eye, in the circle of its reach: as far up as along, and no farther up than its reach is, however near along.
  assert.deepEqual(sees(red, [[-999, 2], [-500, 800], [-500, 900], [0, 999], [0, 1003], [652, 2], [300, 550], [300, 700], [653, 2]]),
    [true, true, false, true, false, true, true, false, false]);
  // Right by a construction, its wreck too, as far up as along; a wreck has no eyes.
  assert.deepEqual(sees(red, [[5016, 1], [5000, 17], [5000, 18], [5017, 1], [9010, 1], [9100, 2]]), [true, true, false, false, true, false]);
  assert.deepEqual(sees(blue, [[2200, 2], [3000, 790], [3000, 900], [3500, 600], [3500, 750]]), [true, true, false, true, false]);
  const green = witness(field, 'green');
  assert.deepEqual([green.zones, green.own], [[], new Set()], 'with nothing on the field and no base, nothing');
  assert.deepEqual(sees(green, [[0, 1], [3000, 2]]), [false, false]);
});

test('an eye witnesses the air over a crest that hides the ground behind it, and not what stands in its shadow', () => {
  // Flat ground at 0 with a ridge 40 m high at 300 m; an eye at the foot of it, 2 m up, that reaches 1500 m.
  const ground = { minX: -4000, maxX: 4000, height: x => Math.max(0, 40 - Math.abs(x - 300) / 2) }, eyes = new GroundSight(ground),
    eye = { x: 0, y: 2, left: 1500, right: 1500 }, standing = [{ id: 'a1', eyes: [eye] }];
  eyes.seen(standing);
  const sight = witness({ actors: [{ id: 'a1', team: 'red', x: 0, vehicle: { x: 0, y: 1 }, eyes: [eye] }] }, 'red', { sweeps: eyes }),
    sees = places => places.map(([x, y]) => witnessed(sight, x, y));
  // Before the crest, the ground and the air over it; past it, not the ground in its shadow nor what stands low there, but what
  // flies over the line from the eye over the crest. The line over the crest at 600 m is 2 + 38 × 2 = 78 m up.
  assert.deepEqual(sees([[200, 1], [200, 600], [600, 1], [600, 60], [600, 90], [1200, 150], [1200, 170]]), [true, true, false, false, true, false, true]);
  // Out past the circle of its reach, nothing, however high: an aircraft 1 km over a place 1200 m off is 1.56 km off.
  assert.deepEqual(sees([[1200, 1000], [1600, 300]]), [false, false]);
  // An eye of the faction with no sweep of its own sees all of its circle: a wall of ground does not stand in the way of what it is told.
  const blind = witness({ actors: [{ id: 'a1', team: 'red', x: 0, vehicle: { x: 0, y: 1 }, eyes: [eye] }] }, 'red');
  assert.deepEqual([[600, 1], [1600, 300]].map(([x, y]) => witnessed(blind, x, y)), [true, false]);
});

test('of the rounds in the air a faction is told those it witnesses and its own shells, by a legend of its own', () => {
  const kinds = [], kind = (actorId, more = {}) => kinds.push({ actorId, weapon: 'cannon', preset: null, ammo: 'ap', poweredTrail: false, name: null, ...more }) - 1;
  // A round of another faction is told by what a page draws it by: no gun's, of no name.
  const bare = ({ preset, ammo, poweredTrail }) => ({ preset, ammo, poweredTrail });
  // A block of rounds, each its number, its kind, where it is and how long it has flown, on the legend of the field as it goes on growing.
  const block = rounds => ({ data: Float64Array.from(rounds.flatMap(([number, of, x, age = 1]) => [number, of, x, 300, 100, 0, age, .06])), kinds, drag: Float64Array.from(rounds, ([number]) => number / 1000) });
  const foe = kind('b1'), shell = kind('a1'), other = kind('b2', { ammo: 'he', preset: 'm119', name: 'b2-salvo' }),
    twin = kind('b3', { weapon: 'howitzer', name: 'b3-shot' });
  const fog = new Fog(), sight = over(-100, 100, ['a1']), shown = told => listShots(told).map(shot => [shot.number, shot.actorId, shot.x]);
  // A shell of another far off; one of its own far off; a shell of another overhead.
  const told = fog.rounds(block([[1, foe, 4000], [2, shell, 5000], [5, other, 50]]), 'red', sight);
  assert.deepEqual(shown(told), [[2, 'a1', 5000], [5, undefined, 50]]);
  assert.deepEqual(told.kinds, [kinds[shell], bare(kinds[other])], 'no kind of a round it was not told, and of one of another no gun nor name');
  assert.deepEqual([...told.drag], [.002, .005]);
  // Its own shell is told as old as it is; the other's as old as it has been told: when it left its gun nothing says.
  assert.deepEqual(listShots(told).map(shot => shot.age), [1, 0]);
  // The far shell comes into its reach and another of its own flies there: its legend grows, the very list it had. A
  // shell of another gun of the same make is of the same kind to it.
  const next = fog.rounds(block([[1, foe, 90], [2, shell, 5100, 1.5], [5, other, 60, 1.5], [6, shell, -20], [8, twin, 95]]), 'red', sight);
  assert.equal(next.kinds, told.kinds); assert.deepEqual(next.kinds, [kinds[shell], bare(kinds[other]), bare(kinds[foe])]);
  assert.deepEqual(shown(next), [[1, undefined, 90], [2, 'a1', 5100], [5, undefined, 60], [6, 'a1', -20], [8, undefined, 95]]);
  assert.equal(listShots(next)[4].weapon, undefined); assert.equal(next.data[4 * 8 + 1], next.data[1], 'two guns of a make are one kind');
  assert.deepEqual(listShots(next).map(shot => shot.age), [0, 1.5, .5, 1, 0], 'the age of a round of another counts from when it was first told');
  // A round the radar of its base follows is told wherever it flies, as one of its own is: it is asked of the number of each.
  const held = fog.rounds(block([[1, foe, 4000], [5, other, 4100]]), 'red', sight, number => number === 1);
  assert.deepEqual(shown(held), [[1, undefined, 4000]]);
  // Another faction has its own, in the order of what it was told; one that witnesses nothing is told nothing.
  const blue = fog.rounds(block([[1, foe, 90], [2, shell, 5100]]), 'blue', { zones: [], own: new Set(['b1']) });
  assert.deepEqual([blue.kinds, [...blue.data.slice(0, 3)]], [[kinds[foe]], [1, 0, 90]]);
  assert.deepEqual(fog.rounds(block([[1, foe, 90]]), 'green', { zones: [], own: new Set() }), { data: new Float64Array(0), kinds: [], drag: new Float64Array(0) });
  // The legend of the field starts over: so does the faction's. A block that says no drags is told with none.
  const after = fog.rounds({ data: Float64Array.from([7, 0, 10, 300, 100, 0, 1, .06]), kinds: [kinds[other]] }, 'red', sight);
  assert.notEqual(after.kinds, told.kinds); assert.deepEqual(after, { data: Float64Array.from([7, 0, 10, 300, 100, 0, 0, .06]), kinds: [bare(kinds[other])] });
  // A faction that is forgotten starts its legend anew.
  fog.forget('blue'); assert.deepEqual(fog.rounds(block([[2, shell, 0]]), 'blue', over(-1, 1)).kinds, [bare(kinds[shell])]);
});

test('empty shots need no sight work, preserve their legend and still allow an event without a shot', t => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 30),
    kinds = [{ actorId: 'b1', weapon: 'cannon', preset: null, ammo: 'ap', poweredTrail: false, name: 'private-gun' }],
    block = (rounds = []) => ({ data: Float64Array.from(rounds.flat()), kinds, drag: Float64Array.from(rounds, () => .06) }),
    emptyEvents = [], room = {
      fog, field: { tows: [] }, factions: new Map([['red', { members: new Set() }]]),
      watch: { marks: () => [], follows: () => () => false },
      allied: () => false, postEyes: () => [], intelligenceSources: () => [{ id: 'red' }], batteryMarks: SharedRoom.prototype.batteryMarks,
      witness: (whole, team) => witness(whole, team),
    }, watched = t.mock.method(room, 'witness'),
    read = (time, shots, events = emptyEvents) => {
      const whole = { ...state(time, a, b), shots, players: [] };
      return SharedRoom.prototype.audience.call(room, whole, chapters(whole), events, 'red');
    };
  const before = read(0, block());
  assert.equal(watched.mock.callCount(), 0, 'an empty typed shot block does not ask for witness spans');
  assert.deepEqual(before.state.shots, { data: new Float64Array(0), kinds: [], drag: new Float64Array(0) });
  assert.equal(before.events, emptyEvents);

  const flying = read(.1, block([[7, 0, 0, 5, 100, 0, 1, .06]]));
  assert.equal(watched.mock.callCount(), 1, 'a real shot still requires the canonical witness');
  assert.deepEqual(flying.state.shots.kinds, [{ preset: null, ammo: 'ap', poweredTrail: false }]);
  assert.deepEqual(listShots(flying.state.shots).map(shot => [shot.number, shot.actorId, shot.age]), [[7, undefined, 0]]);
  assert.deepEqual([...flying.state.shots.drag], [.06]);

  const after = read(.2, block());
  assert.equal(watched.mock.callCount(), 1);
  assert.equal(after.state.shots.kinds, flying.state.shots.kinds, 'an empty frame retains the faction legend');
  assert.deepEqual(after.state.shots.data, new Float64Array(0));
  assert.deepEqual(after.state.shots.drag, new Float64Array(0));
  assert.equal(fog.legends.get('red').since.size, 0, 'rounds still retires the ages of shots that left');

  const events = [{ type: 'explosion', time: .3, x: 0, y: 1 }, { type: 'explosion', time: .3, x: 300, y: 1 }],
    heard = read(.3, block(), events);
  assert.equal(watched.mock.callCount(), 2, 'an event without a shot still prepares its sight');
  assert.deepEqual(heard.events, [events[0]], 'the witnessed event survives and the distant one remains hidden');
  assert.equal(heard.state.shots.kinds, flying.state.shots.kinds);

  const restarted = read(.4, { ...block(), kinds: [] });
  assert.equal(watched.mock.callCount(), 2);
  assert.notEqual(restarted.state.shots.kinds, flying.state.shots.kinds);
  assert.deepEqual(restarted.state.shots, { data: new Float64Array(0), kinds: [], drag: new Float64Array(0) });
  assert.throws(() => fog.rounds(block([[8, 0, 0, 300, 100, 0, 1, .06]]), 'red', null), TypeError,
    'nonempty data still requires a real sight');
});

test('a faction is told its own shell in the sky over ground it does not witness, and not as it comes down there', () => {
  const kinds = [{ actorId: 'a1', weapon: 'howitzer', preset: 'm119', ammo: 'he', poweredTrail: false, name: null },
    { actorId: 'b1', weapon: 'howitzer', preset: 'm119', ammo: 'he', poweredTrail: false, name: null }];
  // Flat ground at 10 m. Red sees from -100 to 100 and has explored up to 2000; past that it never looked.
  const sight = over(-100, 100, ['a1'], { sky: { height: () => 10, explored: [[-500, 2000]] } }), fog = new Fog();
  assert.deepEqual([aloft(sight, 1000, 22.5), aloft(sight, 1000, 21.5), aloft(sight, 3000, 131), aloft(sight, 3000, 129), aloft({ zones: [] }, 0, -5)], [true, false, true, false, true]);
  const block = rounds => ({ data: Float64Array.from(rounds.flatMap(([number, of, x, y]) => [number, of, x, y, 100, -50, 3, .06])), kinds });
  const told = fog.rounds(block([[1, 0, 1000, 300], [2, 0, 1000, 15], [3, 0, 3000, 100], [4, 0, 50, 11], [5, 1, 1000, 300]]), 'red', sight);
  assert.deepEqual(listShots(told).map(shot => shot.number), [1, 4], 'high over known ground, or over its eyes; not low out of sight, nor one of another in the sky');
  // Of the flight of its shell it is told the points in the sky and those it witnesses, and that it ended only where it sees the end.
  const path = (points, more = {}) => ({ type: 'flight', id: 'shot-1', n: 1, actorId: 'a1', terminal: true, points: points.map(([x, y], time) => ({ time, x, y, vx: 100, vy: -50 })), ...more });
  const down = path([[1000, 300], [1100, 30], [1150, 12]]), near = path([[200, 300], [90, 40], [80, 10]]), rising = path([[0, 11], [100, 60]], { terminal: false });
  const [fell, landed, flying] = happenings([down, near, rising], sight);
  assert.deepEqual(fell, { ...down, points: down.points.slice(0, 2), terminal: false }, 'where it came down out of sight is not told');
  assert.equal(landed, near, 'where it fell in sight is'); assert.equal(flying, rising);
  // A path only under the sky, out of sight, is not told at all.
  assert.deepEqual(happenings([path([[1500, 15], [1510, 11]])], sight), []);
});

test('of what happened on the field a faction is told what it witnessed', () => {
  const sight = over(-100, 100, ['a1']), path = (actorId, xs, more = {}) => ({ type: 'flight', id: 'shot-1', n: 1, actorId, points: xs.map((x, time) => ({ time, x, y: 5 })), ...more });
  const events = [{ type: 'explosion', x: 0, y: 1 },
    // Where its own shell burst, out of its reach, it is not told: the shell is its own, not what it did.
    { type: 'explosion', x: 4000, y: 1, actorId: 'a1' }, { type: 'penetration', x: 100, y: 1, actorId: 'b1' }, { type: 'muzzle', x: 101, y: 1, actorId: 'b1' },
    { type: 'secondary-ray', x: 150, y: 1, endX: 90, endY: 1 }, { type: 'secondary-ray', x: 150, y: 1, endX: 120, endY: 1 },
    path('a1', [3000, 3100]), path('b1', [300, 200, 99]), path('b1', [300, 200]),
    { type: 'weapon-blocked', actorId: 'a1' }, { type: 'weapon-blocked', actorId: 'b1' }];
  // Of a path of a round of another it is told the stretch it witnessed, not where the round came from.
  const told = happenings(events, sight);
  assert.deepEqual(told, [events[0], events[2], events[4], events[6], { ...events[7], points: events[7].points.slice(2) }, events[9]]);
  assert.equal(told[3], events[6], 'what it is told whole is the very event');
  assert.deepEqual(happenings(events, { zones: [], own: new Set() }), []);
});

test('of a piece of another that shows a faction is told what a page draws it by, and nothing of what works it', () => {
  const piece = (id, kind, more = {}) => ({ id: 'b1:' + id, actorId: 'b1', kind, x: 50, y: 2, angle: 0, width: 1, height: .5, mountId: 'b1:hull', attached: true,
    health: 40, maxHealth: 60, burning: false, marks: [{ u: .1 }], markRevision: 2, owner: 7, physicalMass: 900, mechanicalDepth: .4, smokeClock: 1, ...more });
  const drawn = { id: 'b1:gun', kind: 'weapon', actorId: 'b1', x: 50, y: 2, angle: 0, width: 1, height: .5, mountId: 'b1:hull', attached: true, health: 40, maxHealth: 60, burning: false,
    marks: [{ u: .1 }], markRevision: 2, weaponPreset: 'rh120', weaponMount: { hostId: 'b1:hull' }, materialPolygons: [], barrelAngle: .3, barrelMarks: [], barrelDisabled: false, elevationDisabled: true, metal: 'titanio' };
  const gun = piece('gun', 'weapon', { ...drawn, reload: 1.2, loaded: 40, feedReload: 2.5, barrelTemperature: 120, barrelCooling: true, targetBarrelAngle: .5, aimOffset: .01, targetAimOffset: .02, servoVelocity: .4,
      receiverMm: 30, barrelMm: 20, barrelProfile: 'long', weaponAmmo: 'he', barrelDamage: .1 }),
    // With no face of a hull over them, the rack and the tank show: what they hold does not.
    rack = piece('rack', 'ammo', { rounds: 12, capacityRounds: 40, ammoType: 'he', roundMass: 20 }), tank = piece('tank', 'fuel', { fuelLitres: 300, capacityLitres: 400 }),
    hopper = piece('hopper', 'hopper', { cargo: { ferro: 3 }, capacityM3: 2 }), crate = piece('crate', 'supply', { cargo: { ferro: 1 }, capacityM3: 1 }),
    wheel = piece('wheel', 'wheel', { suspension: { displacement: .1 }, groundContact: { x: 50 }, wheelSpin: 2, wheelAngularSpeed: 9 });
  const vehicle = { x: 50, y: 1, angle: .1, vx: 2, vy: 0, omega: 0, travel: 4, engine: true, traction: 1, slip: 0, chassisId: 'b1:hull',
    throttle: .8, brake: 0, driveSpeed: 18, maxSpeed: 20, powerKw: 300, enabled: true, gearCount: 4, stuck: null, groundSlope: .1, lastImpulse: 3, fuelLitres: 90 };
  const b = { actor: { id: 'b1', ownerId: 'p2', team: 'blue', defeated: false, field: null, name: 'Carro', preset: 'heavy', x: 50, facing: 1, vehicle, cooldown: 1, lastWeapon: 'b1:gun' },
    plates: [], modules: [gun, rack, tank, hopper, crate, wheel], bodyPanels: [] };
  const fog = new Fog(), field = time => { const s = state(time, construction('a1', 'red', 0), b); return [s, chapters(s)]; };
  fog.read({ sight: { red: [seen('b1')] } }, 0);
  const told = fog.tell(...field(0), 'red'), of = id => told.modules.find(m => m.id === 'b1:' + id);
  assert.deepEqual(of('gun'), { ...drawn, barrelTemperature: 0, [VIEW]: 'outside' }, 'where its barrel lies, not where it is being laid, its reload, its heat below a shimmer or its servo');
  // A barrel hot enough for the air over it to shimmer shows how hot it is, as the shimmer and then the glow are drawn by.
  for (const [heat, why] of [[149, 0], [150, 'the air over a hot barrel is seen shimmering'], [700, 'a glowing barrel is seen glowing']]) {
    b.modules[0] = { ...gun, barrelTemperature: heat };
    assert.equal(fog.tell(...field(0), 'red').modules.find(m => m.id === 'b1:gun').barrelTemperature, why ? heat : 0, why || 'a barrel cooler shows nothing');
  }
  b.modules[0] = gun;
  for (const [id, gone] of [['rack', 'rounds'], ['rack', 'capacityRounds'], ['tank', 'fuelLitres'], ['crate', 'cargo'], ['wheel', 'wheelAngularSpeed'], ['gun', 'owner'], ['gun', 'physicalMass']])
    assert(!(gone in of(id)), id + ': ' + gone);
  assert.deepEqual([of('hopper').cargo, of('hopper').capacityM3], [{ ferro: 3 }, 2], 'what a hopper holds is out in the open');
  assert.deepEqual([of('wheel').suspension, of('wheel').groundContact, of('wheel').wheelSpin], [{ displacement: .1 }, { x: 50 }, 2]);
  assert.deepEqual(told.actors[1].vehicle, { x: 50, y: 1, angle: .1, vx: 2, vy: 0, omega: 0, engine: true, traction: 1, slip: 0, chassisId: 'b1:hull' },
    'not its pedals, whether it may drive, nor the running gear it has left');
  assert.deepEqual(Object.keys(told.actors[1]).sort(), ['defeated', 'facing', 'field', 'id', 'name', 'ownerId', 'preset', 'team', 'vehicle', 'x']);
  // Told again from a state that hands over the same piece, it is the very object told before: it says nothing on the wire.
  fog.read({ sight: { red: [seen('b1')] } }, .1);
  assert.equal(fog.tell(...field(.1), 'red').modules.find(m => m.id === 'b1:gun'), of('gun'));
});

test('of what a construction of another did, and what was done to it, a faction is told what showed', () => {
  // Blue's b1 is in red's sight: a gun through its armour, an engine under its hull. Blue's b2 is near, unseen.
  const hull = { x: 50, y: 1, angle: 0 }, b1 = { actor: { id: 'b1', team: 'blue', x: 50, vehicle: { ...hull } },
    plates: [{ id: 'b1:roof', actorId: 'b1' }], bodyPanels: [{ id: 'b1:skin', actorId: 'b1', pose: hull, localPolygon: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }] }],
    modules: [{ id: 'b1:gun', actorId: 'b1', kind: 'weapon', x: 51.5, y: 1.2 }, { id: 'b1:engine', actorId: 'b1', kind: 'engine', x: 49, y: 1 }] };
  const b2 = { actor: { id: 'b2', team: 'blue', x: 60, vehicle: { x: 60, y: 1 } }, plates: [{ id: 'b2:roof', actorId: 'b2' }], bodyPanels: [],
    modules: [{ id: 'b2:gun', actorId: 'b2', kind: 'weapon', x: 60, y: 1.5 }, { id: 'b2:tank', actorId: 'b2', kind: 'fuel', x: 60, y: 1 }] };
  const a1 = { ...construction('a1', 'red', 0), plates: [{ id: 'a1:hull', actorId: 'a1' }] }, whole = state(0, a1, b1, b2), fog = new Fog();
  fog.read({ sight: { red: [seen('b1')] } }, 0); fog.tell(whole, chapters(whole), 'red');
  const sight = witness(whole, 'red', { base: { x: 0, radius: 150 } }), point = (time, x, y) => ({ time, x, y, vx: 300, vy: 300 });
  const events = [
    { type: 'muzzle', time: 0, x: 51.5, y: 1.4, angle: .1, weapon: 'cannon', preset: 'rh120', caliberMm: 120, power: 5, platform: 'vehicle', actorId: 'b1', id: 'b1:gun', componentId: 'b1:gun' },
    { type: 'muzzle', time: 0, x: 60.25, y: 1.5, angle: .8, weapon: 'howitzer', preset: 'm119', caliberMm: 105, actorId: 'b2', id: 'b2:gun', componentId: 'b2:gun' },
    { type: 'flight', id: 'shot-9', n: 9, actorId: 'b2', weapon: 'howitzer', ammo: 'he', points: [point(0, 60.25, 1.5), point(.016, 65.25, 6.5)] },
    { type: 'flight', id: 'b1-salvo', n: 4, actorId: 'b1', weapon: 'cannon', ammo: 'ap', points: [point(0, 51.5, 1.4), point(.016, 56.5, 1.5)] },
    { type: 'weapon-empty', x: 51.5, y: 1.4, actorId: 'b1', id: 'b1:gun', componentId: 'b1:gun' }, { type: 'weapon-empty', x: 0, y: 1, actorId: 'a1', id: 'a1:gun', componentId: 'a1:gun' },
    { type: 'weapon-blocked', x: 51, y: 1, angle: 0, reason: 'obstruction', actorId: 'b1', id: 'b1:gun', componentId: 'b1:gun' },
    { type: 'module', time: 0, x: 49, y: 1, power: 30, kind: 'engine', caliberMm: 25, actorId: 'b1', id: 'b1:engine', componentId: 'b1:engine' },
    { type: 'destroyed', x: 49, y: 1, kind: 'engine', actorId: 'b1', id: 'b1:engine', componentId: 'b1:engine' },
    { type: 'burn', x: 60, y: 1, strength: .6, actorId: 'b2', id: 'b2:tank', componentId: 'b2:tank' },
    { type: 'penetration', x: 50, y: 2, nx: 0, ny: 1, material: 'steel', power: 80, caliberMm: 25, actorId: 'b1', id: 'b1:roof', projectileId: 'shot-2' },
    { type: 'penetration', x: 60, y: 2, nx: 0, ny: 1, material: 'steel', power: 80, caliberMm: 120, actorId: 'b2', id: 'b2:roof', projectileId: 'shot-3' },
    { type: 'explosion', x: 1, y: 1, power: 300, radius: 2, actorId: 'b2', source: 'a1:hull', preset: 'm119', projectileId: 'shot-9' },
    { type: 'explosion', x: 49, y: 1, power: 300, radius: 2, actorId: 'a1', source: 'b1:engine', preset: 'rh120' },
    { type: 'secondary-ray', x: 49, y: 1, endX: 50, endY: 1.5, internal: true, actorId: 'b1', projectileId: 'ejecta-3' },
    { type: 'secondary-ray', x: 0, y: 1, endX: 1, endY: 1.5, internal: true, actorId: 'a1', projectileId: 'ejecta-4' }];
  const heard = fog.heard(events, sight, 'red', 0), { actorId: _, weapon: __, ...path } = events[2];
  assert.deepEqual(heard, [
    // The gun it sees fire it is told as it fired; of the round each gun sent, not whose it is, nor of what gun, nor
    // where a gun it does not see sent it from.
    events[0], { ...path, points: path.points.slice(1) }, { type: 'flight', id: 'shot-4', n: 4, ammo: 'ap', points: events[3].points },
    // Of a gun of its own, that it is spent; of the other's, nothing.
    events[5],
    // Of a piece under a hull it sees, that something happened there: not what the piece is.
    { type: 'module', time: 0, x: 49, y: 1, power: 30, actorId: 'b1' }, { type: 'destroyed', x: 49, y: 1, actorId: 'b1' },
    // Of a construction it does not see, not whose it is.
    { type: 'burn', x: 60, y: 1, strength: .6 },
    events[10], { type: 'penetration', x: 60, y: 2, nx: 0, ny: 1, material: 'steel', power: 80, caliberMm: 120, projectileId: 'shot-3' },
    // A burst of another's round on its own: where, how hard, on what of its own. Its own burst in the other's engine: not on what.
    { type: 'explosion', x: 1, y: 1, power: 300, radius: 2, source: 'a1:hull', projectileId: 'shot-9' },
    { type: 'explosion', x: 49, y: 1, power: 300, radius: 2, actorId: 'a1', preset: 'rh120' },
    // Of the splinters inside a hull, only those inside its own.
    events[15]]);
  assert.equal(heard[0], events[0]); assert.equal(heard[3], events[5], 'what is told as it is is the very event');
  const words = JSON.stringify(heard);
  assert(!words.includes('b2') && !words.includes('engine') && !words.includes('howitzer'), words);
  // To the faction of both, all that happened to them or that they did is its own, as it is.
  const blue = fog.heard(events, witness(whole, 'blue', { x: 50, radius: 150 }), 'blue', 0);
  for (const event of events) if (['b1', 'b2'].includes(event.actorId) && !event.source) assert(blue.includes(event), event.type);
});

test('a shaped charge of another is told as one and joins its round, and the fragments inside another hull stay there', () => {
  const fog = new Fog(), whole = state(0, construction('a1', 'red', 0), construction('b1', 'blue', 50)), sight = witness(whole, 'red', { base: { x: 0, radius: 150 } });
  fog.read({ sight: { red: [seen('b1')] } }, 0); fog.tell(whole, chapters(whole), 'red');
  const point = (time, x) => ({ time, x, y: 1.5, vx: -2000, vy: 0 }), events = [
    { type: 'flight', id: 'shot-6', n: 6, actorId: 'b1', weapon: 'rocket', ammo: 'heat', radius: .07, terminal: true, points: [point(0, 45), point(.003, 1), point(.0035, .2)] },
    { type: 'penetration', x: 1, y: 1.5, nx: 1, ny: 0, material: 'steel', power: 525, caliberMm: 84, actorId: 'a1', id: 'a1:hull', projectileId: 'shot-6' },
    { type: 'secondary-ray', x: .9, y: 1.5, endX: -.6, endY: 1.5, internal: true, actorId: 'a1', projectileId: 'ejecta-7', powerBudget: 3.2 },
    { type: 'explosion', x: 1, y: 1.5, power: 79, radius: .7, shaped: true, actorId: 'b1', preset: 'at4', projectileId: 'shot-6' },
    { type: 'penetration', x: 49, y: 1.5, nx: -1, ny: 0, material: 'steel', power: 600, caliberMm: 120, actorId: 'b1', id: 'b1:hull', projectileId: 'shot-8' },
    { type: 'secondary-ray', x: 49.1, y: 1.5, endX: 51, endY: 1.5, internal: true, actorId: 'b1', projectileId: 'ejecta-9', powerBudget: 4 }];
  const heard = fog.heard(events, sight, 'red', 0), flight = heard.find(e => e.type === 'flight'), burst = heard.find(e => e.type === 'explosion');
  assert.equal(flight.id, 'shot-6'); assert.equal(flight.ammo, 'heat'); assert.equal(burst.projectileId, flight.id, 'the burst joins the path of its round');
  assert.equal(burst.shaped, true); assert(!('preset' in burst), 'but not by the gun that sent it');
  assert.deepEqual(heard.filter(e => e.type === 'secondary-ray'), [events[2]], 'only the fragments inside its own hull');
  assert.equal(heard.find(e => e.projectileId === 'shot-8').caliberMm, 120, 'its own round shows its calibre at the face it struck');
});

test('a faction that does not witness the muzzle of a gun is told no point of its round there', () => {
  const fog = new Fog(), whole = state(0, construction('a1', 'red', 0), construction('b1', 'blue', 50)), sight = witness(whole, 'red', { base: { x: 0, radius: 150 } });
  fog.tell(whole, chapters(whole), 'red');
  const muzzle = { type: 'muzzle', x: 50.5, y: 1.5, angle: .5, weapon: 'mortar', actorId: 'b1' },
    flight = { type: 'flight', id: 'shot-5', n: 5, actorId: 'b1', weapon: 'mortar', ammo: 'he', points: [{ time: 0, x: 50.5, y: 1.5, vx: 1, vy: 200 }] };
  assert.deepEqual(fog.heard([muzzle, flight], sight, 'red', 0), [], 'a path that was nothing but its muzzle is no path');
  fog.read({ sight: { red: [seen('b1')] } }, 0); fog.tell(whole, chapters(whole), 'red');
  assert.deepEqual(fog.heard([muzzle, flight], sight, 'red', 0), [muzzle, { type: 'flight', id: 'shot-5', n: 5, ammo: 'he', points: flight.points }], 'seen, the gun is told firing');
});

test('a squad of the shared field holds an enemy by what its faction is told of it, and names one only in sight or on radar', () => {
  // Red's player p1 against blue's: what the room knows is the fog's, and what is out of the fight is the field's.
  const fog = new Fog(), on = new Map(), out = {}, time = { now: 0 }, tank = (id, ownerId, team, x, more = {}) => on.set(id, { id, ownerId, team, x, blueprint: { modules: [] }, vehicle: { x, y: 1 }, ...more });
  const room = { fog, field: { get time() { return time.now; } }, world: { actor: id => on.get(id) ?? null }, outOfAction: () => out, faction: player => ({ id: player.factionId }),
    players: new Map([['p1', { id: 'p1', factionId: 'red' }], ['p3', { id: 'p3', factionId: 'red' }], ['p2', { id: 'p2', factionId: 'blue' }]]),
    knows: (factionId, actor) => fog.knows(factionId, actor, time.now) }, side = new Side(room, 'p1'), present = () => new Set(on.keys());
  tank('a1', 'p1', 'red', 0); tank('a2', 'p3', 'red', 10); for (const [id, x] of [['b1', 50], ['b2', 900], ['b3', 70], ['b4', 80]]) tank(id, 'p2', 'blue', x);
  fog.read({ sight: { red: [seen('b1'), { actorId: 'b2', channel: 'radar', visible: true, x: 905, y: 3, error: 11, by: 'a1' }, seen('b3', 70), seen('b4', 80)] } }, 0, present());
  const whole = { time: 0, actors: [...on.values()], plates: [], modules: [], bodyPanels: [] }; fog.tell(whole, chapters(whole), 'red');
  // Seen, it is a foe until it is seen out of the fight; on the radar it is one whatever it is. Its own and an ally's are none.
  out.b2 = true;
  assert.deepEqual(['b1', 'b2', 'a1', 'a2'].map(id => side.foe(id)), [true, true, false, false]);
  assert.deepEqual(['b1', 'b2', 'b3', 'a1'].map(id => side.sighted(id)), [true, true, true, false]);
  out.b1 = true; assert.equal(side.foe('b1'), false, 'seen out of the fight');
  // b4 is lost from sight while it stands, then goes; b3 goes while red sees it. b1, lost, stands a ghost of one out of the fight.
  time.now = .2; fog.read({ sight: { red: [seen('b3', 70)] } }, .2, present());
  time.now = .45; on.delete('b4'); on.delete('b3'); fog.read({ sight: { red: [] } }, .45, present());
  assert.deepEqual(['b3', 'b4'].map(id => side.foe(id)), [false, true], 'what it saw go is gone; what it lost track of is held');
  delete out.b1; assert.equal(room.knows('red', on.get('b1')), 'ghost');
  assert.equal(side.foe('b1'), true, 'a ghost of one in the fight is a foe'); assert.equal(side.sighted('b1'), false, 'and no target it may be shown');
});

test('a faction that is forgotten takes what it knew with it', () => {
  const fog = new Fog(), a = construction('a1', 'red', 0), b = construction('b1', 'blue', 50);
  fog.read({ sight: { red: [seen('b1')] } }, 0); fog.forget('red');
  const s = state(0, a, b); assert.deepEqual(ids(fog.tell(s, chapters(s), 'red')), ['a1']);
});
