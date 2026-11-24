import { rehearsal } from '../../server/room.ts';
import { Publication } from '../../server/publication.ts';
import { World } from '../../src/physics.ts';
import { createStructuredTemplate } from '../../src/structured-templates.ts';
import { bill } from '../../src/economy.ts';

const wire = value => JSON.parse(JSON.stringify(value));
// Capture real protocol messages on first use. The room is disposed before any
// test receives its own copy; importing the helpers does not create a field.
function captureField() {
  const room = rehearsal([0, 2000], undefined, { fog: false });
  try {
    const joined = room.join('Ana'), manufactured = room.publish(joined.playerId, createStructuredTemplate('scout'));
    room.command(joined.playerId, { type: 'squad', order: 'control', id: null });
    const welcome = room.join('Ana', joined.token),
      faction = room.factionView(joined.playerId), squad = room.squadView(joined.playerId);
    return { welcome: wire({ type: 'welcome', ...welcome }), faction: wire(faction), squad: wire(squad),
      unit: wire(faction.units[0]), manufactured: wire(manufactured) };
  } finally { room.field.dispose(); }
}
let field;
const fieldData = () => field ??= captureField();
let postReceipt;
function postData() {
  if (!postReceipt) {
    const room = rehearsal([0, 2000], undefined, { fog: false });
    try {
      const joined = room.join('Ana');
      postReceipt = wire(room.command(joined.playerId, { type: 'post', x: 2000 }));
    } finally { room.field.dispose(); }
  }
  return postReceipt;
}
const drawings = new Map();
function drawingData(template) {
  if (!drawings.has(template)) {
    const world = new World(createStructuredTemplate(template));
    try {
      const scene = new Publication().state(world.snapshot());
      drawings.set(template, { actor: scene.actors[0], wheel: scene.modules.find(part => part.kind === 'wheel') });
    } finally { world.dispose(); }
  }
  return drawings.get(template);
}
const supply = value => ({ ...bill(), ...value });

export function fieldUnit(overrides = {}) {
  const base = structuredClone(fieldData().unit), result = { ...base, ...overrides };
  for (const key of ['value', 'built', 'repair', 'rearm']) if (overrides[key]) result[key] = supply(overrides[key]);
  if (overrides.cargo) result.cargo = { ...base.cargo, ...overrides.cargo };
  return result;
}
export function factionView(overrides = {}) {
  const base = structuredClone(fieldData().faction);
  return { ...base, ...overrides,
    ...(overrides.stock && { stock: { ...base.stock, ...overrides.stock } }),
    ...(overrides.base && { base: { ...base.base, ...overrides.base } }),
    ...(overrides.units && { units: overrides.units.map(fieldUnit) }) };
}
export function squadView(overrides = {}) {
  const base = structuredClone(fieldData().squad);
  return { ...base, ...overrides,
    ...(overrides.units && { units: overrides.units.map(unit => ({ ...structuredClone(base.units[0]), ...unit })) }) };
}
export function welcomeMessage(overrides = {}) {
  const base = structuredClone(fieldData().welcome);
  return { ...base, ...overrides, faction: factionView(overrides.faction ?? {}),
    chat: { ...base.chat, ref: overrides.faction?.ref ?? base.faction.ref } };
}
export function drawingActor(overrides) {
  const base = structuredClone(drawingData('vehicle' in overrides ? 'scout' : 'bunker').actor),
    result = { ...base, ...overrides };
  if (overrides.vehicle) result.vehicle = { ...base.vehicle, ...overrides.vehicle };
  return result;
}
export const drawingWheel = overrides => ({ ...structuredClone(drawingData('scout').wheel), ...overrides });
export function manufactureReceipt(overrides = {}) {
  const base = structuredClone(overrides.work ? postData() : fieldData().manufactured), result = { ...base, ...overrides };
  if (overrides.work) result.work = { ...base.work, ...overrides.work };
  if (overrides.actor) result.actor = { ...base.actor, ...overrides.actor };
  return result;
}
