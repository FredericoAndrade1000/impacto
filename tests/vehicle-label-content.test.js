import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LabelIcons, VehicleLabel, vehicleLabel, vehicleRole, groupedVehicleLabel, vehicleLabelLayout, separateVehicleLabels } from '../src/vehicle-labels.ts';
import { labelGroups } from '../src/faction-ui.ts';
import { configureLanguage } from '../src/i18n.ts';
import { isFieldView } from '../src/scene-drawing-codec.ts';

const state = { localPlayerId: 'me', faction: { id: 'ours' }, time: 20 },
  actor = (more = {}) => ({ id: 'one', ownerId: 'me', team: 'ours', vehicle: { x: 0, y: 0, angle: 0 }, name: 'Caminhão de minério com um nome comprido', playerName: 'Frederico', ...more }),
  parts = (...kinds) => kinds.map(kind => ({ type: 'module', data: typeof kind === 'string' ? { kind } : kind })),
  measure = text => text.length * 6;

test('label roles use only the published pieces, distinguishing cargo and known equipment', () => {
  for (const [pieces, icon] of [[[], 'i-wheel'], [['engine', 'fuel'], 'i-wheel'], [['sensor'], 'k-scout'], [['hopper'], 'i-haul'],
    [['cistern'], 'r-petroleo'], [['hopper', 'cistern'], 'k-hauler'], [['supply', 'hopper'], 'k-supply'], [['builder', 'supply'], 'i-build'],
    [['excavator'], 'k-extractor'], [['drill'], 'k-extractor'], [[{ kind: 'weapon', weaponPreset: 'rh120' }], 'k-armor'],
    [['excavator', 'hopper'], 'k-miner'], [['drill', 'cistern'], 'k-miner'],
    [[{ kind: 'weapon', weaponPreset: 'm119' }], 'k-artillery']]) {
    assert.equal(vehicleRole(actor(), parts(...pieces)), icon);
  }
  const concealed = actor({ ownerId: 'enemy', team: 'theirs', name: 'Artilharia de petróleo', role: 'artillery' });
  assert.equal(vehicleRole(concealed, []), 'i-wheel', 'a name or unverified role does not reveal hidden equipment');
  assert.equal(vehicleRole(concealed, parts({ kind: 'hopper', attached: false })), 'i-wheel');
  assert.equal(vehicleRole(actor({ defeated: true }), parts('hopper')), 'i-wreck');
  for (const pieces of [[], parts('sensor'), parts({ kind: 'weapon', weaponPreset: 'm119' })])
    assert.equal(vehicleRole(actor({ vehicle: null }), pieces), 'i-structure', 'a fixed construction never claims wheels or tracks');
  assert.equal(vehicleRole(actor({ vehicle: null, defeated: true }), []), 'i-wreck');
  assert.equal(vehicleRole(actor({ ghost: { since: 8 } }), []), 'i-wheel', 'a mobile memory retains its published carrier');
  assert.equal(vehicleRole(actor({ vehicle: { enabled: false } }), []), 'i-wheel', 'lost mobility does not make a vehicle a fixed construction');
  assert.equal(vehicleRole(actor({ vehicle: null, ghost: { since: 8 } }), []), 'i-structure');
});

test('every vehicle is told by its icon: own labels omit the player and design name and foreign identity stays short', () => {
  const own = vehicleLabel(actor(), state, parts('hopper')), foreign = vehicleLabel(actor({ ownerId: 'enemy', team: 'theirs', playerName: 'Nome bastante comprido' }), state, parts('hopper'));
  assert.equal(own.caption, ''); assert.equal(own.chips[0].icon, 'i-haul'); assert.equal(own.alone, false);
  assert.equal(foreign.caption, 'Nome bast...'); assert.equal(foreign.caption.length, 12); assert.equal(foreign.chips[0].icon, 'i-haul');
  // One of the faction in another member's squad is the player's own while nobody holds it, and told by whoever holds it.
  const held = { ...state, squad: { units: [{ id: 'one', by: { id: 'bia', name: 'Beatriz Comprida' } }] } };
  assert.equal(vehicleLabel(actor({ ownerId: 'bia', playerName: 'Beatriz Comprida' }), state, []).caption, '');
  assert.equal(vehicleLabel(actor({ ownerId: 'bia', playerName: 'Outro nome' }), held, []).caption, 'Beatriz C...');
  // A player of another faction away is told so; the members of the faction go away and come back, and its vehicles are its own.
  assert.equal(vehicleLabel(actor({ ownerId: 'enemy', team: 'theirs', playerName: 'Adriana' }), { ...state, players: [{ id: 'enemy', connected: false }] }, []).status, 'ausente');
  assert.equal(vehicleLabel(actor({ playerName: 'Adriana' }), { ...state, players: [{ id: 'me', connected: false }] }, []).status, '');
});

test('the public roster identifies active and paused AI without an absent-human label or losing service status', t => {
  t.after(() => configureLanguage({ languages: ['pt-BR'] }));
  const foreign = actor({ ownerId: 'enemy', team: 'theirs', playerName: 'Controlador' }),
    frame = players => ({ time: 20, actors: [], modules: [], plates: [], players });
  assert(isFieldView(frame([{ id: 'enemy', connected: false }])));
  for (const ai of ['active', 'paused', 'offline', true, null, undefined]) {
    assert.equal(isFieldView(frame([{ id: 'enemy', connected: false, ai }])), ai === 'active' || ai === 'paused');
  }
  for (const [language, running, paused, absent] of [['pt-BR', 'IA', 'IA pausada', 'ausente'], ['en', 'AI', 'Paused AI', 'away']]) {
    configureLanguage({ languages: [language] });
    const show = (ai, patch = {}) => vehicleLabel({ ...foreign, ...patch }, { ...state, players: [{ id: 'enemy', connected: false, ...(ai ? { ai } : {}) }] }, []),
      active = show('active'), stopped = show('paused');
    assert.deepEqual([active.status, stopped.status, show().status], [running, paused, absent]);
    assert.notEqual(active.statusIcon, 'i-abandon'); assert.notEqual(stopped.statusIcon, 'i-abandon');
    assert.notEqual(active.key, stopped.key, 'grouped labels update when the controller is paused');
    const repair = show('active', { field: { service: { kind: 'repair', until: 24.1 } } });
    assert(repair.status.endsWith(' · ' + running)); assert.equal(repair.statusIcon, 'i-repair'); assert.equal(repair.alone, true);
    const memory = show('paused', { ghost: { since: 8 } });
    assert(memory.status.endsWith(' · ' + paused)); assert.equal(memory.statusIcon, 'i-clock');
    assert.equal(show('active', { defeated: true }).status, '', 'a wreck does not claim an active controller');
  }
});

test('service and last-seen clocks remain individual, legible and authoritative', () => {
  const repair = vehicleLabel(actor({ field: { service: { kind: 'repair', until: 24.1 } } }), state, parts('hopper')),
    ghost = vehicleLabel(actor({ ghost: { since: 7.2 }, field: { service: { kind: 'repair', until: 40 } } }), state, parts('cistern'));
  assert.equal(repair.status, 'em reparo · 5 s'); assert.equal(repair.statusIcon, 'i-repair'); assert.equal(repair.alone, true);
  assert.equal(ghost.status, 'visto há 12 s'); assert.equal(ghost.statusIcon, 'i-clock'); assert.equal(ghost.alone, true);
  assert.equal(vehicleLabel(actor({ field: { service: { kind: 'turn', until: 10 } } }), state, []).status, 'virando · 0 s');
});

test('published loading has a real clock, while waiting and limited production have none', () => {
  const label = (cargoWork, time = 20) => vehicleLabel(actor({ field: { cargoWork } }), { ...state, time }, parts('hopper'));
  const loading = label({ kind: 'load', until: 24.1 });
  assert.equal(loading.status, 'carregando · 5 s'); assert.equal(loading.statusIcon, 'i-haul'); assert.equal(loading.alone, true);
  assert.equal(label({ kind: 'load', until: 24.1 }, 23.5).status, 'carregando · 1 s');
  const waiting = label({ kind: 'load', waiting: true, until: 24.1 }), limited = label({ kind: 'load', limited: true, until: 24.1 });
  assert.equal(waiting.status, 'aguardando material'); assert.equal(waiting.statusIcon, 'i-clock'); assert.equal(waiting.alone, false);
  assert.equal(limited.status, 'carregando · depende da extração'); assert.equal(limited.alone, false);
  assert.equal(label({ kind: 'load' }).status, 'carregando');
  assert.equal(label({ kind: 'unload', until: 24.1 }).status, '', 'an immediate unload does not acquire a made-up timer');
});

test('an own waiting extractor names its fuel blocker without borrowing foreign data or masking another waiting load', () => {
  const cargoWork = { kind: 'load', waiting: true, until: 30 }, waiting = actor({ field: { cargoWork } }),
    context = { ...state, faction: { ...state.faction, units: [{ id: waiting.id, tools: { limit: 'fuel' } }] } },
    pieces = parts('excavator', 'hopper'), show = (patch = {}, told = context) => vehicleLabel({ ...waiting, ...patch }, told, pieces),
    dry = show(), ordinary = vehicleLabel(actor({ id: 'other', field: { cargoWork } }), context, pieces);
  assert.deepEqual([dry.status, dry.statusIcon, dry.alone], ['ferramenta sem combustível', 'i-clock', false]);
  assert.equal(ordinary.status, 'aguardando material');
  assert.equal(show({ field: { cargoWork: { kind: 'load', limited: true } } }).status, 'carregando · depende da extração', 'a trailing fuel quote does not override current active loading');
  assert.equal(show({ ownerId: 'enemy', team: 'theirs' }).status, 'aguardando material', 'a matching private ID never grants foreign tool information');
  assert.equal(show({}, { ...context, faction: { units: context.faction.units } }).status, 'aguardando material', 'an unidentified faction grants no private status');
  assert.equal(show({ ghost: { since: 8 } }).status, 'visto há 12 s');
  assert.equal(show({ field: { cargoWork, service: { kind: 'repair', until: 24 } } }).status, 'em reparo · 4 s');
  assert.equal(show({ defeated: true }).status, '');
  const slow = { ...context, faction: { ...context.faction, units: [{ id: waiting.id, tools: { limit: 'power', pace: .5 } }] } };
  assert.equal(show({}, slow).status, 'aguardando material', 'partial power is not missing fuel');
  assert.equal(show({ field: { cargoWork: { kind: 'load', limited: true } } }, slow).status, 'carregando · depende da extração');
  const grouped = [dry, ordinary].map((model, i) => ({ id: String(i), x: 100, y: 100, width: 80, key: model.key, alone: model.alone }));
  assert.deepEqual(labelGroups(grouped).map(group => group.ids), [['0'], ['1']], 'a neighbouring waiting load cannot mask the fuel blocker');
});
test('a repair, a ghost or a wreck takes precedence over a stale loading record', () => {
  const cargoWork = { kind: 'load', until: 40 }, more = { field: { cargoWork, service: { kind: 'turn', until: 25 } } };
  assert.equal(vehicleLabel(actor(more), state, []).status, 'virando · 5 s');
  assert.equal(vehicleLabel(actor({ ...more, ghost: { since: 8 } }), state, []).status, 'visto há 12 s');
  assert.equal(vehicleLabel(actor({ ...more, defeated: true }), state, []).status, '');
  assert.equal(vehicleLabel(actor(), state, parts('hopper')).status, '', 'equipment alone never claims that material is being loaded');
  const foreign = vehicleLabel(actor({ ownerId: 'enemy', team: 'other' }), { ...state, faction: { id: 'ours', units: [{ id: 'one', cargoWork }] } }, []);
  assert.equal(foreign.status, '', 'only the actor field actually published to this audience supplies an overhead loading state');
});

test('identical untimed work may group, but waiting, idle and each deadline remain semantically distinct', () => {
  const from = (id, cargoWork) => { const model = vehicleLabel(actor({ id, field: { cargoWork } }), state, parts('hopper'));
    return { id, x: 100, y: 100, width: 150, key: model.key, alone: model.alone }; },
    a = from('a', { kind: 'load', waiting: true }), b = from('b', { kind: 'load', waiting: true }), idle = from('idle'),
    timed = from('timed', { kind: 'load', until: 25 }), limited = from('limited', { kind: 'load', limited: true });
  assert.deepEqual(labelGroups([a, b, idle, timed, limited]).map(group => group.ids), [['a', 'b'], ['idle'], ['timed'], ['limited']]);
  const otherTimer = from('other-timer', { kind: 'load', until: 25 });
  assert.equal(labelGroups([timed, otherTimer]).length, 2, 'another truck cannot borrow the first deadline');
});

test('mixed groups have at most three chips and a clearly identified total instead of long names', () => {
  const items = [['hopper', 5], ['cistern', 4], ['supply', 3], ['drill', 2], ['sensor', 1], ['engine', 1]]
    .flatMap(([kind, count]) => Array.from({ length: count }, () => vehicleLabel(actor(), state, parts(kind)))),
    group = groupedVehicleLabel(items);
  assert.equal(group.chips.length, 3);
  assert.deepEqual(group.chips, [{ icon: 'i-haul', count: 5, text: '5' }, { icon: 'r-petroleo', count: 4, text: '4' }, { icon: 'i-fleet', count: 16, text: '16 total' }]);
  assert.equal(group.caption, ''); assert.equal(vehicleLabelLayout(group, measure).width < 180, true);
  const oil = groupedVehicleLabel(items.filter(item => item.role === 'r-petroleo'));
  assert.deepEqual(oil.chips, [{ icon: 'r-petroleo', count: 4, text: '4' }]);
});

test('spatial grouping never crosses a holder, team, mobility, ghost or wreck boundary, and the faction\'s own group whoever\'s squad they are in', () => {
  const held = { ...state, squad: { units: [{ id: 'held', by: { id: 'ally', name: 'Bia' } }] } },
    variants = [actor(), actor({ vehicle: null }), actor({ id: 'held', ownerId: 'ally' }), actor({ ownerId: 'enemy', team: 'other' }), actor({ ghost: { since: 10 } }), actor({ defeated: true })],
    items = variants.map((a, i) => { const info = vehicleLabel(a, held, []); return { id: String(i), x: 100, y: 100, width: 80, key: info.key, alone: info.alone }; });
  assert.equal(labelGroups(items).length, variants.length);
  assert.equal(vehicleLabel(actor({ ownerId: 'ally' }), held, []).key, vehicleLabel(actor(), held, []).key);
});

test('long label lines wrap at measured pixel width while the flag clears their explicit lines', () => {
  const words = 'Veículo experimental com blindagem pesada e transporte de minério com reserva de combustível',
    model = caption => ({ caption, status: '', statusIcon: null, chips: [] }), layout = vehicleLabelLayout(model(words), measure, 180);
  assert.equal(layout.caption.replaceAll('\n', ' '), words);
  assert(layout.caption.split('\n').length > 2);
  assert(layout.caption.split('\n').every(line => measure(line) <= 180));
  assert(layout.width <= 180); assert.equal(layout.lift, -layout.top + 2);
  const continuous = vehicleLabelLayout(model('A'.repeat(80)), measure, 180);
  assert.equal(continuous.caption.replaceAll('\n', '').length, 80);
  assert(continuous.caption.split('\n').every(line => measure(line) <= 180));
});

const separated = (a, b) => a.x + a.width / 2 <= b.x - b.width / 2 || b.x + b.width / 2 <= a.x - a.width / 2 ||
  a.y + a.bottom <= b.y + b.top || b.y + b.bottom <= a.y + a.top;
const box = (id, key, more = {}) => ({ id, key, x: 333, y: 280, width: 70, top: -25, bottom: 8, ...more });

test('final groups of different owners separate their text and flags, the first in order kept at its original height', () => {
  const near = box('near', 'own', { width: 180 }), own = box('own', 'own', { x: 329.38, y: 279.69, width: 68 }),
    ally = box('ally', 'ally', { x: 335.77, y: 279.75, width: 96.88 }), items = [own, ally, near];
  assert.equal(separated(own, ally), false, 'the QA positions overlap before final placement');
  assert.equal(separateVehicleLabels(items), items); assert.equal(ally.y, 279.75);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) assert(separated(items[i], items[j]));
  assert.equal(own.x, 329.38); assert.equal(ally.x, 335.77);
  const free = [box('left', 'one', { x: 100 }), box('right', 'two', { x: 560, y: 210.25 })];
  separateVehicleLabels(free); assert.deepEqual(free.map(item => item.y), [280, 210.25], 'noncolliding heights stay exact');
  assert.deepEqual(separateVehicleLabels([]), []);
});

test('small suspension bobbing never swaps the owners between stacked rows', () => {
  let last;
  for (let frame = 0; frame < 100; frame++) {
    const dy = Math.sin(frame / 6) * .6, own = box('own', 'a-own', { y: 280 + dy }), ally = box('ally', 'b-ally', { y: 280 - dy });
    separateVehicleLabels(frame % 2 ? [ally, own] : [own, ally]);
    assert.equal(own.y, 280 + dy); assert(ally.y < own.y); assert(separated(own, ally));
    if (last) assert(Math.abs(ally.y - last) < .2, 'the displaced row follows continuously rather than flipping priority');
    last = ally.y;
  }
});

test('variable-height clocks and multiline titles do not collide after a chain of upward adjustments', () => {
  const items = [box('one', 'a', { y: 290, top: -39, bottom: 40 }), box('two', 'b', { y: 280 }),
    box('three', 'c', { y: 220, top: -25, bottom: 54 }), box('four', 'd', { y: 270, x: 345, width: 130 })];
  const original = new Map(items.map(item => [item.id, item.y])); separateVehicleLabels(items);
  for (const item of items) assert(item.y <= original.get(item.id), 'placement only lifts colliding groups');
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) assert(separated(items[i], items[j]));
});

test('fixed base captions reserve space even for a single vehicle, without moving the captions', () => {
  const base = { x: 333, y: 263, width: 100, top: 0, bottom: 16 }, before = structuredClone(base),
    focus = box('focus', 'own', { width: 180 }), ally = box('ally', 'ally');
  separateVehicleLabels([focus], [base]); assert(separated(focus, base)); assert(focus.y < 280);
  separateVehicleLabels([focus, ally], [base]);
  assert(separated(focus, ally) && separated(ally, base)); assert.deepEqual(base, before);
  const free = box('free', 'own', { x: 100 }); separateVehicleLabels([free], [base]); assert.equal(free.y, 280);
});

function symbols(t) {
  const before = globalThis.document, read = new Map(), source = readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
    names = ['i-wheel', 'i-structure', 'i-wreck', 'i-haul', 'r-petroleo', 'k-hauler', 'k-supply', 'k-extractor', 'k-miner', 'i-fleet', 'k-artillery', 'k-armor', 'k-scout', 'i-clock', 'i-build', 'i-repair', 'i-turn', 'i-abandon'],
    lookup = new Map(names.map(id => {
      const body = source.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)</symbol>`))?.[1]; assert(body, 'missing existing symbol: ' + id);
      const children = [...body.matchAll(/<(path|circle|rect)\b([^>]*?)\/>/g)].map(([, tagName, raw]) => {
        const attributes = new Map([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
        return { tagName, getAttribute: name => attributes.get(name) ?? null };
      });
      assert(children.length); return [id, { children }];
    }));
  globalThis.document = { getElementById: id => { read.set(id, (read.get(id) || 0) + 1); return lookup.get(id); } };
  t.after(() => { globalThis.document = before; }); return { read, names };
}

test('existing icon geometry is read once and both dark and light strokes contain drawable paths', t => {
  const { read, names } = symbols(t), icons = new LabelIcons(); t.after(() => icons.clear());
  for (const id of names) {
    const context = icons.get(id); assert.equal(icons.get(id), context); assert.equal(read.get(id), 1);
    const dark = context.instructions.filter(i => i.data.style.color === 0x1b3024), light = context.instructions.filter(i => i.data.style.color === 0xffffff);
    assert(dark.length && light.length, id + ' needs a contrast edge and a light core');
    for (const instruction of [...dark, ...light]) assert(instruction.data.path.shapePath.shapePrimitives.length > 0, id + ' must not emit a move-only stroke');
  }
});

test('unchanged content retains Text/Graphics and measurements, while shared contexts outlive individual labels', t => {
  symbols(t); const icons = new LabelIcons(); let measurements = 0;
  const model = groupedVehicleLabel([vehicleLabel(actor(), state, parts('hopper')), vehicleLabel(actor(), state, parts('hopper'))]),
    a = new VehicleLabel(icons, text => { measurements++; return measure(text); }), b = new VehicleLabel(icons, measure);
  a.setContent(model, 260, 0xc7d0a4); b.setContent(model, 260, 0xc7d0a4);
  const context = a.chips[0].icon.context, children = [...a.children], before = measurements;
  for (let n = 0; n < 60; n++) a.setContent(structuredClone(model), 260, 0xc7d0a4);
  assert.equal(measurements, before); assert.deepEqual(a.children, children); assert.equal(a.text, '2');
  assert.equal(b.chips[0].icon.context, context); assert.equal(context.destroyed, false);
  a.destroy({ children: true }); assert.equal(context.destroyed, false);
  b.destroy({ children: true }); assert.equal(context.destroyed, false);
  icons.clear(); assert.equal(context.destroyed, true); assert.equal(icons.contexts.size, 0); icons.clear();
});

test('loading updates the existing label only when the displayed second or phase changes', t => {
  symbols(t); const icons = new LabelIcons(); let measurements = 0;
  const label = new VehicleLabel(icons, text => { measurements++; return measure(text); }),
    current = time => vehicleLabel(actor({ field: { cargoWork: { kind: 'load', until: 26 } } }), { ...state, time }, parts('hopper'));
  t.after(() => { label.destroy({ children: true }); icons.clear(); });
  label.setContent(current(20.01), 180, 0xc7d0a4);
  const children = [...label.children], layout = label.layout, before = measurements;
  for (let n = 2; n <= 99; n++) label.setContent(current(20 + n / 100), 180, 0xc7d0a4);
  assert.equal(measurements, before); assert.equal(label.layout, layout); assert.deepEqual(label.children, children);
  label.setContent(current(21.01), 180, 0xc7d0a4); assert.match(label.text, /carregando · 5 s/); assert.deepEqual(label.children, children);
  const waiting = vehicleLabel(actor({ field: { cargoWork: { kind: 'load', waiting: true } } }), state, parts('hopper'));
  label.setContent(waiting, 180, 0xc7d0a4); assert.match(label.text, /aguardando material/); assert.deepEqual(label.children, children);
  assert(label.layout.width <= 180, 'the existing measured layout remains bounded for a narrow viewport');
});
