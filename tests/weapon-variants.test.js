import test from 'node:test';
import assert from 'node:assert/strict';

import { initNativeDynamics } from '../src/native-dynamics.ts';
import { WEAPON_PRESETS, weaponOf, weaponOptions, weaponFigures, weaponVariant, weaponBase, cartridgeId, isWeaponId, isCartridgeId, fixedWeapon, weaponSettings, MAX_RATE, weaponCompartment, weaponMountSize, coreOf } from '../src/weapons.ts';
import { weaponName } from '../src/weapon-names.ts';
import { pieceSettings, selectionSettings, steppedSetting, typedSetting, madeOver, gunFigures, pieceFigures, applySettings, coreChoices, weight } from '../src/piece-settings.ts';
import { formatCredits } from '../src/construction-cost.ts';
import { boxOffer } from '../src/workshop-ux.ts';
import { partName } from '../src/part-view.ts';
import { count, number } from '../src/format.ts';
import { weaponCost } from '../src/construction-cost.ts';
import { Editor } from '../src/editor.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponLayout } from '../src/weapon-paint.ts';
import { ammunitionFeed } from '../src/workshop-checklist.ts';
import { ammunitionSupply } from '../src/component-volume.ts';
await initNativeDynamics();

test('the workshop makes a gun over by the core and names it by its base and what changed, in one order', () => {
  const options = weaponOptions('m2hb');
  assert(options.calibres.includes(145) && options.calibres.includes(200), 'bored on, it becomes an autocannon');
  assert.deepEqual([options.charge.min, options.charge.step, options.charge.base], [50, 5, 100]);
  assert.equal(options.barrels, 7);
  assert.equal(options.family, 'machinegun');
  assert.equal(options.rounds, 100, 'a belt of a hundred rounds');
  assert.equal(weaponOptions('rh120').barrels, 1, 'a gun that fires a round at a time turns one barrel');
  assert.equal(weaponOptions('at4'), null, 'a launcher has no barrel of steel to make over');
  // What is asked as the gun has it is no change; the rest is named in one order.
  const id = weaponVariant('m2hb', { barrels: 3, length: 91, charge: 100, calibre: 127 });
  assert.equal(id, 'm2hb|L91|N3');
  assert.equal(weaponVariant('m2hb', { length: 114 }), 'm2hb');
  const gun = weaponOf(id);
  assert.equal(gun.rate, 1800); assert.equal(gun.steel.barrels, 3); assert.equal(gun.variantOf, 'm2hb');
  assert(gun.installedMassKg > WEAPON_PRESETS.m2hb.installedMassKg && gun.costCredits > WEAPON_PRESETS.m2hb.costCredits);
  assert.equal(weaponCost(id), gun.costCredits);
  assert.equal(weaponBase(id), 'm2hb');
  // A longer barrel or more of them fires the rounds of the gun it was made of; another charge, rounds of its own.
  assert.equal(cartridgeId(id), 'm2hb');
  assert.equal(cartridgeId(weaponVariant('m2hb', { charge: 110, barrels: 3 })), 'm2hb|C110');
  assert(isWeaponId(id) && isCartridgeId('m2hb|C110') && !isCartridgeId(id));
  for (const bad of ['m2hb|N1', 'm2hb|L10', 'm2hb|N3|L91', 'rh120|N2', 'nada|L91']) assert(!isWeaponId(bad), bad);
  assert.equal(weaponName(id), 'Metralhadora · 12,7 mm (M2) · 3 canos · cano de 0,91 m');
  // The fastest it may fire stays within the rate the game allows.
  assert(weaponOf('minimi|N7').rate <= MAX_RATE);
  assert.equal(fixedWeapon({ platform: 'vehicle' }, [{ kind: 'weapon', id: 'gun', weaponPreset: id }]).rate, 1800);
  // The rounds it may be fed are stated as a preset states them, for the pilots that reckon its reach by them.
  assert.deepEqual(gun.ammo, ['ap']); assert.equal(weaponSettings('machinegun', { preset: id }).ammo, 'ap');
});

test('a gun shows its barrel, calibre, barrels, rate, charge, projectile and belt as steppers, each range from the core', () => {
  const part = { kind: 'weapon', id: 'gun', weaponPreset: 'm2hb', pose: { x: 0, y: 0, angle: 0 } },
    settings = Object.fromEntries(pieceSettings(null, part).map(setting => [setting.key, setting])), options = weaponOptions('m2hb');
  assert.deepEqual(Object.keys(settings).sort(), ['angle', 'barrelLength', 'barrels', 'calibre', 'charge', 'magazine', 'projectile', 'rate']);
  assert.equal(settings.barrelLength.value, 1.14); assert.equal(settings.calibre.value, 12.7);
  assert.equal(settings.charge.value, 100); assert.equal(settings.barrels.value, 1);
  assert.deepEqual([settings.projectile.value, settings.projectile.min, settings.projectile.max], [100, options.projectile.min, options.projectile.max]);
  assert.deepEqual([settings.rate.value, settings.rate.min, settings.rate.max, settings.rate.label], [100, options.rate.min, options.rate.max, 'Cadência']);
  // A machine gun is fed by a belt of so many rounds, stepping through those it may be given.
  assert.deepEqual([settings.magazine.label, settings.magazine.unit, settings.magazine.value], ['Cinta', 'tiros', 100]);
  assert.deepEqual(settings.magazine.stops, options.feeds);
  assert.equal(steppedSetting(settings.magazine, 1), options.feeds[options.feeds.indexOf(100) + 1]);
  assert.equal(typedSetting(settings.magazine, '120'), 125, 'a typed belt rests on the nearest it may be');
  // A calibre steps through those in common use, and is typed to the tenth of a millimetre between the first and the last.
  assert.equal(steppedSetting(settings.calibre, 1), 14.5);
  assert.equal(steppedSetting(settings.calibre, -1), 9);
  assert.equal(steppedSetting({ ...settings.calibre, value: 14.5 }, 1), 20);
  assert.equal(steppedSetting({ ...settings.calibre, value: 13 }, 1), 14.5);
  assert.equal(typedSetting(settings.calibre, '13'), 13);
  assert.equal(typedSetting(settings.calibre, '13,04'), 13);
  assert.equal(typedSetting(settings.calibre, '2'), options.calibres[0] / 10);
  assert.equal(madeOver('m2hb', 'calibre', 13), 'm2hb|D130', 'any tenth of a millimetre, the barrel as many calibres long');
  assert.equal(madeOver('m2hb', 'barrels', 3), 'm2hb|N3');
  assert.equal(madeOver('m2hb|N3', 'calibre', 14.5), 'm2hb|D145|N3', 'bored, of the shape of its reference');
  assert.match(madeOver('m2hb|L91|N3', 'calibre', 14.5), /^m2hb\|L10\d\|D145\|N3$/, 'a barrel it was given kept as many calibres long');
  assert.equal(madeOver('m2hb|N3', 'barrels', 1), 'm2hb');
  assert.equal(madeOver('m2hb', 'projectile', 150), 'm2hb|P150');
  assert.equal(madeOver('m2hb|P150', 'rate', 50), 'm2hb|P150|R50');
  assert.equal(madeOver('m2hb', 'magazine', 400), 'm2hb|M400');
  assert.equal(madeOver('m2hb|M400', 'magazine', 100), 'm2hb');
  // Each says why a press at either end changes nothing.
  assert.deepEqual(settings.projectile.ends, ['Esse é o projétil mais leve desta arma.', 'Esse é o projétil mais pesado desta arma.']);
  assert.deepEqual(settings.magazine.ends, ['Essa é a menor cinta desta arma.', 'Essa é a maior cinta desta arma.']);
  // A cannon has no barrels to turn nor a rate to set, and a magazine for its autoloader; a launcher nothing to make over.
  const cannon = Object.fromEntries(pieceSettings(null, { ...part, weaponPreset: 'rh120' }).map(setting => [setting.key, setting]));
  assert(cannon.barrelLength && cannon.projectile && !cannon.barrels && !cannon.rate);
  assert.deepEqual([cannon.magazine.label, cannon.magazine.value], ['Pente', 1]);
  assert.equal(madeOver('rh120', 'magazine', 12), 'rh120|M12');
  assert.deepEqual(pieceSettings(null, { ...part, weaponPreset: 'at4' }).map(setting => setting.key), ['angle']);
  // The gun settings are of one gun: with another piece chosen they are not shown.
  const shared = selectionSettings([{ piece: { id: 'gun' }, part }, { piece: { id: 'other' }, part: { ...part, id: 'other' } }]).map(setting => setting.key);
  assert.deepEqual(shared, ['angle']);
});

test('a gun made over is named by what it became and the gun it was made of, then only what that does not say', () => {
  assert.equal(weaponName('m2hb'), 'Metralhadora M2 · 12,7 mm');
  const bored = madeOver('m2hb', 'calibre', 20);
  assert.equal(weaponOf(bored).family, 'autocannon');
  assert.equal(weaponName(bored), 'Canhão automático · 20 mm (M2)', 'its barrel follows its calibre: it is not said');
  assert.equal(weaponName(madeOver(bored, 'barrels', 3)), 'Canhão automático · 20 mm (M2) · 3 canos');
  assert.equal(weaponName('m2hb|M400'), 'Metralhadora · 12,7 mm (M2) · cinta de 400');
  assert.equal(weaponName('m777|M12'), 'Obuseiro · 155 mm (M777) · pente de 12');
  assert.equal(weaponName('m2hb|C110'), 'Metralhadora · 12,7 mm (M2) · carga de 110 %');
  assert.equal(weaponName('m2hb|P150|R50'), 'Metralhadora · 12,7 mm (M2) · projétil de 150 % · cadência de 50 %');
  // The bar, the lists and the boxes name it so (part-view.ts `partName`).
  assert.equal(partName({ id: 'gun', kind: 'weapon', weaponPreset: bored }), 'Canhão automático · 20 mm (M2)');
});

test('the bar tells what a gun is and does in four lines, by the figures of the core', () => {
  const editor = new Editor(createConstruction('scout')), piece = editor.blueprint.modules.find(m => m.kind === 'weapon'),
    lines = id => gunFigures(piece, id);
  assert.equal(piece.weaponPreset, 'm2hb');
  const [what, fire, feed] = lines('m2hb'), m2 = weaponFigures('m2hb');
  assert.equal(what, `Metralhadora · alcance ${number(m2.rangeM / 1000)} km · perfura ${count(m2.pierceMm.at500)} mm a 500 m e ${count(m2.pierceMm.at1000)} mm a 1 km`);
  assert.equal(fire, `550 tiros/min · recuo ${count(m2.recoilNs)} N·s · esquenta em ${count(m2.roundsToHot)} tiros seguidos`);
  assert.equal(feed, 'cinta de 100 · troca em 15 s · ' + pieceFigures(piece));
  // A howitzer bursts and is loaded by hand; given a magazine, its autoloader is filled again a round at a time.
  const [howitzer, , byHand] = lines('m777');
  assert.match(howitzer, /^Obuseiro · alcance [\d,]+ km · explosão de 7,2 m · estilhaços até 12 m$/);
  assert.match(byHand, /^carregada à mão · /);
  assert.match(lines('m777|M12')[2], /^pente de 12 · repõe 1 a cada 12 s · /);
  // A grenade launcher does not heat up in a burst; a tank gun is pushed back in kilonewton-seconds.
  assert.match(lines('mk19')[1], /· não esquenta em rajada$/);
  assert.match(lines('rh120')[1], /^6 tiros\/min · recuo 35,8 kN·s · /);
  assert.match(lines('mk44')[2], /^cinta de 156 · troca em 5 min · /);
  // A gun made over tells what it became; a launcher, not made over, only its weight and price.
  assert.match(lines(madeOver('m2hb', 'calibre', 20))[0], /^Canhão automático · /);
  assert.deepEqual(lines('at4'), [pieceFigures(piece)]);
});

test('a gun with no box of its rounds aboard is offered one: a box no gun takes put to its rounds, or a new one', () => {
  const bunker = createConstruction('bunker'), [gun] = bunker.components.filter(part => part.kind === 'weapon'), [box] = bunker.components.filter(part => part.kind === 'ammo');
  // Its box of another calibre, which no gun takes, is the one offered, and put to its rounds it feeds it.
  const idle = new Editor({ ...bunker, components: bunker.components.map(part => part.kind === 'ammo' ? { ...part, ammoPreset: 'mk19' } : part) });
  const offer = boxOffer(idle.blueprint, gun.id);
  assert.deepEqual([offer.cartridge, offer.box.id], [gun.weaponPreset, box.id]);
  assert(offer.rounds > 0);
  applySettings(idle, 'ammoPreset', new Map([[offer.box.id, offer.cartridge]]));
  assert.equal(ammunitionFeed(idle.blueprint.modules).unfed.length, 0);
  assert.equal(boxOffer(idle.blueprint, gun.id), null, 'a gun that is fed is offered nothing');
  // A gun made over to rounds of its own, beside one that still takes the box, is offered a new box of them.
  const shared = new Editor(bunker), twin = shared.addModule('weapon', { x: 6, y: 2 }, { weaponPreset: gun.weaponPreset }), charged = madeOver(gun.weaponPreset, 'charge', 110);
  shared.select(gun.id); shared.editProperty('weaponPreset', charged, true);
  assert.equal(shared.source.components.find(part => part.id === box.id).ammoPreset, gun.weaponPreset, 'the box stays with the gun that still takes it');
  assert.deepEqual(boxOffer(shared.blueprint, gun.id), { cartridge: cartridgeId(charged), box: null, rounds: 0 });
  assert.equal(boxOffer(shared.blueprint, twin.id), null);
});

test('a gun made over in the editor takes the boxes that fed it to the rounds of its cartridge, and is drawn with its barrels', () => {
  const editor = new Editor(createConstruction('scout')), gun = editor.blueprint.modules.find(m => m.kind === 'weapon'),
    base = gun.weaponPreset, boxes = () => editor.source.components.filter(part => part.kind === 'ammo').map(part => part.ammoPreset);
  editor.select(gun.id);
  const longer = madeOver(base, 'barrelLength', weaponOptions(base).length.max / 100);
  editor.editProperty('weaponPreset', longer, true);
  assert.equal(editor.selected.weaponPreset, longer);
  assert(boxes().every(preset => preset === base), 'a longer barrel fires the rounds it fired');
  // The workshop, the field and the squad find its boxes by the rounds it fires, not by its name.
  const modules = editor.blueprint.modules;
  assert.equal(ammunitionFeed(modules).unfed.length, 0, 'a gun made over is fed by the boxes of its cartridge');
  assert(ammunitionSupply(modules, longer).length > 0);
  const charged = madeOver(longer, 'charge', 110);
  editor.editProperty('weaponPreset', charged, true);
  assert(boxes().includes(cartridgeId(charged)), 'a heavier charge is fed rounds of its own');
  assert.equal(weaponLayout('m2hb|L91|N3').barrels, 3);
  assert.equal(weaponLayout('m2hb').barrels, 1);
});

test('a gun made over in its turret has its mantlet sized anew for it, as on another mount', () => {
  // The guard post's machine gun, its barrel cut short: the mantlet sized for its old barrel would stand past the muzzle.
  const editor = new Editor(createConstruction('guard-post')), gun = editor.source.components.find(part => part.kind === 'weapon');
  assert.equal(typeof gun.mount.radiusM, 'number', 'the stock design states its mantlet');
  editor.select(gun.id);
  const short = madeOver(gun.weaponPreset, 'barrelLength', weaponOptions(gun.weaponPreset).length.min / 100);
  editor.editProperty('weaponPreset', short, true);
  assert.equal(editor.selected.weaponPreset, short);
});

test('a gun fed by a belt or a magazine carries its ready rounds in a compartment the core sizes, and is drawn as long as it reaches', () => {
  // The M2's belt of 100 in a can beside its receiver; the M242's of 300 beside it too, one of 1,000 reaching behind it; a
  // gun loaded by hand carries none.
  const m2 = weaponCompartment('m2hb'), long = weaponVariant('m242', { magazine: 1000 }), chain = weaponCompartment(long);
  assert.equal(m2.kind, 'belt'); assert.equal(m2.rounds, 100); assert.equal(m2.lengthM, 0);
  assert(m2.besideM > .2 && m2.besideM < .31, String(m2.besideM));
  assert.equal(weaponMountSize('m2hb').width, WEAPON_PRESETS.m2hb.receiver.length);
  assert.equal(weaponMountSize('m242').width, WEAPON_PRESETS.m242.receiver.length);
  assert(chain.lengthM > .5 && Math.abs(weaponMountSize(long).width - weaponOf(long).receiver.length - chain.lengthM) < 1e-12);
  assert.equal(weaponCompartment('rh120'), null);
  assert.equal(weaponMountSize('rh120').width, WEAPON_PRESETS.rh120.receiver.length);
  // An autoloader's magazine of 22 stands behind the breech, as the Leclerc's in its bustle.
  const loaded = weaponVariant('rh120', { magazine: 22 }), bustle = weaponCompartment(loaded);
  assert.equal(bustle.kind, 'magazine'); assert.equal(bustle.besideM, 0);
  assert(bustle.lengthM > 1.4 && bustle.lengthM < 2.2, String(bustle.lengthM));
  assert(Math.abs(weaponMountSize(loaded).width - weaponOf(loaded).receiver.length - bustle.lengthM) < 1e-12);
});

test('blow-out panels go on a gun whose rounds lie in a compartment, weigh with it, and come off with a feed that has none', () => {
  const tank = weaponVariant('rh120', { magazine: 22 }), vented = weaponVariant('rh120', { magazine: 22, vent: 1 });
  assert.equal(vented, 'rh120|M22|V1');
  // Offered where there is a compartment: a belt's can or a magazine, not a gun loaded by hand.
  assert.equal(weaponOptions('rh120').panels, false);
  assert.equal(weaponOptions(tank).panels, true); assert.equal(weaponOptions('m2hb').panels, true);
  assert.equal(weaponCompartment(tank).vented, false); assert.equal(weaponCompartment(vented).vented, true);
  assert.equal(weaponOf(vented).made.vent, 1); assert.equal(weaponOf(vented).feed.vented, true);
  // Their roof and blast door weigh some 0.4 t on the Leclerc's bustle, and the gun costs by its weight.
  const panels = weaponCompartment(vented).panelsKg;
  assert(panels > 300 && panels < 550, String(panels));
  assert(Math.abs(weaponOf(vented).installedMassKg - weaponOf(tank).installedMassKg - panels) < 1e-6);
  assert(weaponFigures(vented).costCredits > weaponFigures(tank).costCredits);
  // The workshop's button puts them on and takes them off; the other settings keep them; a feed of one round drops them.
  assert.equal(madeOver(tank, 'vent', 1), vented); assert.equal(madeOver(vented, 'vent', 0), tank);
  assert.equal(madeOver(vented, 'magazine', 12), 'rh120|M12|V1');
  assert.equal(madeOver(vented, 'magazine', 1), 'rh120');
  assert.equal(madeOver('m2hb', 'vent', 1), 'm2hb|V1');
  assert.equal(madeOver('rh120', 'vent', 1), 'rh120', 'none on a gun loaded by hand');
  // Its rounds are those of the gun without them, and it is drawn as long.
  assert.equal(cartridgeId(vented), 'rh120');
  assert.deepEqual(weaponMountSize(vented), weaponMountSize(tank));
});

test('how the round a gun is fed is made: its penetrator, its cone and standoff, its explosive, each its own cartridge', () => {
  // The tank gun's rod of tungsten made of steel: lighter, faster, pierces less, costs less; a cartridge of its own.
  const steel = madeOver('rh120', 'core', 1);
  assert.equal(steel, 'rh120|T1');
  assert.equal(coreOf('rh120'), 'tungsten'); assert.equal(coreOf(steel), 'steel'); assert.equal(coreOf('m777'), null);
  assert.equal(cartridgeId(steel), 'rh120|T1', 'a box of steel rods is not one of tungsten');
  assert.equal(cartridgeId('rh120|T1|M22|V1'), 'rh120|T1');
  assert.equal(weaponName(steel), 'Canhão · 120 mm (Rheinmetall) · penetrador de aço');
  const rod = weaponFigures(steel).rounds.apfsds, tungsten = weaponFigures('rh120').rounds.apfsds;
  assert(rod.speed > tungsten.speed && rod.pierceMm.at1000 < tungsten.pierceMm.at1000 && rod.costCredits < tungsten.costCredits);
  // The choices tell what each would pierce at 1 km and cost.
  const choices = coreChoices('rh120');
  assert.deepEqual(choices.map(choice => [choice.id, choice.name]), [['steel', 'Aço'], ['tungsten', 'Tungstênio']]);
  assert.match(choices[0].detail, new RegExp(`perfura ${count(rod.pierceMm.at1000)} mm a 1 km · ${formatCredits(rod.costCredits)} por tiro$`));
  assert.deepEqual(coreChoices('m777'), []);
  // A shaped charge's cone and how many of its diameters off it bursts; a shell's explosive.
  assert.equal(madeOver('rh120', 'cone', 90), 'rh120|O90');
  assert.equal(madeOver('rh120', 'standoff', 4), 'rh120|S40');
  assert.equal(madeOver('rh120|S40', 'standoff', 1.5), 'rh120');
  assert.equal(madeOver('m777', 'fill', 30), 'm777|E30');
  assert.equal(weaponName('rh120|O90|S40|E25'), 'Canhão · 120 mm (Rheinmetall) · cone de 90 % · afastamento de 4 cones · explosivo de 25 %');
  // Each shows with the round it is for, as that round is fed.
  const part = { kind: 'weapon', id: 'gun', weaponPreset: 'rh120', pose: { x: 0, y: 0, angle: 0 } },
    keys = ammo => pieceSettings(null, { ...part, weaponAmmo: ammo }).map(setting => setting.key).filter(key => ['cone', 'standoff', 'fill'].includes(key));
  assert.deepEqual(keys('apfsds'), []);
  assert.deepEqual(keys('heat'), ['cone', 'standoff']);
  assert.deepEqual(keys('he'), ['fill']);
  const heat = Object.fromEntries(pieceSettings(null, { ...part, weaponAmmo: 'heat' }).map(setting => [setting.key, setting]));
  assert.deepEqual([heat.cone.value, heat.cone.min, heat.cone.max, heat.cone.unit], [80, 50, 90, '%']);
  assert.deepEqual([heat.standoff.label, heat.standoff.value, heat.standoff.min, heat.standoff.max, heat.standoff.step], ['Afastamento', 1.5, .5, 8, .5]);
  assert.equal(steppedSetting(heat.standoff, 1), 2);
  const shell = Object.fromEntries(pieceSettings(null, { ...part, weaponAmmo: 'he' }).map(setting => [setting.key, setting]));
  assert.deepEqual([shell.fill.label, shell.fill.value, shell.fill.min, shell.fill.max], ['Explosivo', 11, 5, 30]);
  // The bar tells the round it is fed: its fourth line, as made, how fast it leaves, what a round weighs and costs.
  const editor = new Editor(createConstruction('scout')), piece = editor.blueprint.modules.find(m => m.kind === 'weapon');
  const [what, , , made] = gunFigures(piece, steel, 'apfsds');
  assert.match(what, new RegExp(`perfura ${count(rod.pierceMm.at500)} mm a 500 m e ${count(rod.pierceMm.at1000)} mm a 1 km$`));
  assert.equal(made, `Flecha de aço · sai a ${count(rod.speed)} m/s · tiro de ${weight(rod.massKg)} e ${formatCredits(rod.costCredits)}`);
  const burst = weaponFigures('m777|E8').rounds.he;
  assert.match(gunFigures(piece, 'm777|E8', 'he')[0], new RegExp(`explosão de ${number(burst.blastM)} m · estilhaços até ${count(burst.fragmentsM)} m$`));
  assert.match(gunFigures(piece, 'rh120|O90', 'heat')[0], new RegExp(`perfura ${count(weaponFigures('rh120|O90').rounds.heat.pierceMm.any)} mm a qualquer distância$`));
});
