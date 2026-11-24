import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { createStructuredTemplate, structuredTemplateSource } from '../src/structured-templates.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { World } from '../src/physics.ts';
import { standing } from './helpers/designs.js';

// The specific heat of steel, J/(kg·K), as the core takes it (game_barrel.rs `steel_heat`, EN 1993-1-2) up to 600 °C.
const steelHeat = t => { t = Math.max(20, t); return 425 + .773 * t - 1.69e-3 * t * t + 2.22e-6 * t ** 3; };
// The still air at a height, as warm as the standard atmosphere has it.
const air = y => 15 - .0065 * y;

test('a gun held firing heats its barrel by what each round leaves in its steel, a field kept keeps it as hot, and the air cools it', t => {
  // Made as a field that is kept is: an empty one, the construction brought into it.
  const preset = 'rh202', world = new World(createConstruction('empty')); t.after(() => world.dispose()); world.removeActor('local');
  world.addActor(standing(structuredTemplateSource('ifv', { preset })), { id: 'c1', x: 12 }); world.game();
  const gun = world.modules.find(m => m.kind === 'weapon'), { massKg, heatJ } = WEAPON_PRESETS[preset].steel,
    config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, preset, aimAngle: gun.barrelAngle }, 'c1'),
    aim = { x: gun.x + 30 * Math.cos(gun.barrelAngle), y: gun.y + 30 * Math.sin(gun.barrelAngle) };
  const cold = gun.barrelTemperature;
  assert(Math.abs(cold - air(gun.y)) < .1, `it comes in as warm as the air: ${cold} °C`);
  world.setTrigger(true, aim, config, 'c1');
  for (let i = 0; i < 60; i++) world.step();
  world.setTrigger(false, undefined, undefined, 'c1');
  // A second of fire: each round leaves its heat in the steel, and the air takes back a little of it meanwhile.
  const shots = world.stats.shots, hot = gun.barrelTemperature, rise = shots * heatJ / (massKg * steelHeat((cold + hot) / 2));
  assert(shots > 10, `${shots} rounds`);
  assert(hot - cold < rise * 1.01 && hot - cold > rise * .97, `${hot} °C after ${shots} rounds, ${rise} more than cold`);
  // Kept and resumed, the field has the barrel as hot, and both cool alike.
  const kept = JSON.parse(JSON.stringify(world.keep())), fresh = new World(createConstruction('empty'));
  t.after(() => fresh.dispose()); fresh.removeActor('local'); fresh.resume(structuredClone(kept)); fresh.game();
  const again = fresh.modules.find(m => m.id === gun.id);
  assert.equal(kept.modules.find(m => m.id === gun.id).barrelTemperature, hot);
  assert.equal(again.barrelTemperature, hot);
  for (let i = 0; i < 60; i++) { world.step(); fresh.step(); }
  assert(gun.barrelTemperature < hot && gun.barrelTemperature > hot - 1, `${gun.barrelTemperature} °C a second after ${hot}`);
  assert.equal(again.barrelTemperature, gun.barrelTemperature);
});

test('a tank gun heats by a couple of degrees a round, and a launcher not at all', t => {
  for (const [preset, template, heats] of [['rh120', 'heavy', true], ['carlgustaf', 'ifv', false]]) {
    const world = new World(createStructuredTemplate(template, { preset })); t.after(() => world.dispose()); world.game();
    const gun = world.modules.find(m => m.kind === 'weapon'), cold = gun.barrelTemperature,
      config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, preset, aimAngle: gun.barrelAngle }),
      aim = { x: gun.x + 30 * Math.cos(gun.barrelAngle), y: gun.y + 30 * Math.sin(gun.barrelAngle) };
    world.setTrigger(true, aim, config);
    for (let i = 0; i < 30; i++) world.step();
    const shots = world.stats.shots, rise = gun.barrelTemperature - cold;
    assert(shots > 0, preset);
    if (heats) assert(rise > 1.5 * shots && rise < 2.5 * shots, `${preset}: ${rise} °C after ${shots}`);
    else assert(Math.abs(rise) < .01 && !WEAPON_PRESETS[preset].steel, `${preset}: ${rise}`);
  }
});
