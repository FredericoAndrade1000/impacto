import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { FLAG_COLOURS, FLAG_FIELDS, FLAG_EMBLEMS, FLAG_WIDTH, FLAG_HEIGHT, NATION_NAME, COUNTRIES, HISTORIC, countryFlag, flagTall, validFlag, nationName, defaultFlag, knownFlags, flagShapes,
  flagMarkup, drawFlag } from '../src/flag.ts';

test('a flag is a field, three colours of the palette and an emblem, and nothing else is one', () => {
  const flag = { field: 'cross', colours: [4, 0, 2], emblem: 'star' };
  assert.deepEqual(validFlag({ ...flag, picture: 'x', colours: [...flag.colours] }), flag, 'what is kept of it is its choices alone');
  assert.notEqual(validFlag(flag).colours, flag.colours);
  for (const wrong of [null, {}, { ...flag, field: 'swastika' }, { ...flag, emblem: 'skull' }, { ...flag, colours: [4, 0] }, { ...flag, colours: [4, 0, 16] },
    { ...flag, colours: [4, 0, -1] }, { ...flag, colours: [4, 0, 1.5] }, { ...flag, colours: '402' }, { ...flag, field: 'toString' }, { ...flag, emblem: 'constructor' }])
    assert.throws(() => validFlag(wrong), { message: 'Bandeira inválida.' });
  assert.equal(FLAG_COLOURS.length, 16); assert.equal(new Set(FLAG_COLOURS.map(colour => colour.value)).size, 16);
  assert.equal(Object.keys(FLAG_FIELDS).length, 12); assert.equal(Object.keys(FLAG_EMBLEMS).length, 5);
});

test('the name of a nation is kept trimmed and readable, within its length, and an empty one is none', () => {
  assert.equal(nationName('  República   de\tFarofa \n'), 'República de Farofa');
  assert.equal(nationName('Zona' + String.fromCodePoint(0x200b, 7) + ' Leste'), 'Zona Leste', 'nothing that is not to be read');
  assert.deepEqual([nationName(''), nationName('   '), nationName(null), nationName(undefined)], [null, null, null, null]);
  assert.equal(nationName('Ão'), 'Ão'); assert.equal(nationName('x'.repeat(NATION_NAME.max)).length, NATION_NAME.max);
  for (const wrong of ['x', 'x'.repeat(NATION_NAME.max + 1)]) assert.throws(() => nationName(wrong), { message: 'O nome da facção precisa ter de 2 a 24 caracteres.' });
  for (const wrong of [7, {}, ['Farofa']]) assert.throws(() => nationName(wrong), { message: 'Nome de facção inválido.' });
});

test('a flag worked out of a seed is always that one, of three colours that tell apart: what a faction that made none flies is drawn so', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `faction-${i}-${i * 7919}`), flags = ids.map(defaultFlag);
  for (const [i, flag] of flags.entries()) {
    assert.deepEqual(validFlag(flag), flag); assert.deepEqual(defaultFlag(ids[i]), flag);
    assert.equal(new Set(flag.colours).size, 3);
  }
  assert(new Set(flags.map(flag => JSON.stringify(flag))).size > 190, 'two factions seldom fly the same');
  assert.equal(new Set(flags.map(flag => flag.field)).size, 12); assert.equal(new Set(flags.map(flag => flag.emblem)).size, 5);
  const chosen = { field: 'plain', colours: [0, 1, 2], emblem: 'none' };
  // What a faction is told of the flags on the field: its own and those of the factions it has met.
  assert.deepEqual([...knownFlags({ id: 'a', flag: chosen, known: [{ id: 'b', flag: defaultFlag('b') }] })], [['a', chosen], ['b', defaultFlag('b')]]);
  assert.deepEqual([...knownFlags(null)], []);
});

test('every flag is drawn within its three by two, its ground first and its emblem last', () => {
  for (const field of Object.keys(FLAG_FIELDS)) for (const emblem of Object.keys(FLAG_EMBLEMS)) {
    const flag = { field, colours: [4, 0, 8], emblem }, shapes = flagShapes(flag), paint = place => FLAG_COLOURS[flag.colours[place]].value;
    assert.deepEqual(shapes[0], { colour: paint(0), points: [0, 0, FLAG_WIDTH, 0, FLAG_WIDTH, FLAG_HEIGHT, 0, FLAG_HEIGHT] }, field);
    for (const shape of shapes) {
      const xs = shape.points ? shape.points.filter((_, i) => i % 2 === 0) : [shape.circle[0] - shape.circle[2], shape.circle[0] + shape.circle[2]],
        ys = shape.points ? shape.points.filter((_, i) => i % 2) : [shape.circle[1] - shape.circle[2], shape.circle[1] + shape.circle[2]];
      assert(Math.min(...xs) >= -1e-9 && Math.max(...xs) <= FLAG_WIDTH + 1e-9 && Math.min(...ys) >= -1e-9 && Math.max(...ys) <= FLAG_HEIGHT + 1e-9, `${field} ${emblem}`);
    }
    assert.equal(shapes.length > 1 && shapes.at(-1).colour === paint(2), emblem !== 'none' || ['horizontal3', 'vertical3'].includes(field), `${field} ${emblem}`);
    const svg = flagMarkup(flag); assert.match(svg, /^<svg class="banner" viewBox="0 0 3 2" aria-hidden="true"><polygon points="0 0 3 0 3 2 0 2" fill="#c8312b"\/>/);
    assert.equal(svg.split('<polygon').length + svg.split('<circle').length - 2, shapes.length);
  }
});

test('the flag of a country is flown as it is: one of the countries the game has a picture of, and no other', () => {
  // Every country of the lists — of today and of other times — has its picture beside the page, and every picture there
  // is of a country of the lists.
  const folder = new URL('../public/flags/', import.meta.url), files = readdirSync(folder), historic = Object.keys(HISTORIC);
  assert.equal(COUNTRIES.length, 249); assert.equal(historic.length, 20); assert(!historic.some(code => COUNTRIES.includes(code)));
  assert.deepEqual(files.filter(file => file.endsWith('.svg')).sort(), [...COUNTRIES, ...historic].map(code => code + '.svg').sort());
  assert(files.includes('LICENSE') && files.includes('HISTORIC.txt'), 'the pictures come with their licence and where they came from');
  const sources = readFileSync(new URL('HISTORIC.txt', folder), 'utf8');
  // Czechoslovakia flew the flag the Czech Republic flies.
  assert.equal(readFileSync(new URL('cs.svg', folder), 'utf8'), readFileSync(new URL('cz.svg', folder), 'utf8')); assert.match(sources, /cs\.svg é o cz\.svg do flag-icons/);
  for (const code of historic.filter(code => code !== 'cs')) assert.match(sources, new RegExp(`^${code}\\.svg — .* — https://commons\\.wikimedia\\.org/.* — Public domain$`, 'm'), code);
  for (const code of ['br', 'jp', 'us']) assert.match(readFileSync(new URL(code + '.svg', folder), 'utf8'), /viewBox="0 0 640 480"/, 'four wide for three tall');
  // Those of other times are drawn as they were and framed four wide for three tall, their drawing filling the frame.
  for (const code of historic.filter(code => code !== 'cs'))
    assert.match(readFileSync(new URL(code + '.svg', folder), 'utf8'), /<svg width="640" height="480" viewBox="[^"]+" preserveAspectRatio="x(Min|Mid)YMid slice"/, code);
  // Their names are names a nation may take, and they are known by their years.
  for (const { name, years } of Object.values(HISTORIC)) { assert.equal(nationName(name), name); assert.match(years, /^\d{4}–\d{4}$/); }
  assert.deepEqual(validFlag({ country: 'su' }), { country: 'su' }); assert.equal(flagMarkup({ country: 'yu' }), '<img class="banner country" src="/flags/yu.svg" alt="">');
  assert.deepEqual(validFlag({ country: 'br', field: 'cross', picture: 'x' }), { country: 'br' }, 'kept by its two letters alone');
  for (const wrong of [{ country: 'BR' }, { country: 'xx' }, { country: 'eu' }, { country: '../br' }, { country: 7 }, { country: null }, { country: ['br'] }, { country: 'toString' },
    { country: undefined, field: 'plain', colours: [0, 1, 2], emblem: 'none' }]) assert.throws(() => validFlag(wrong), { message: 'Bandeira inválida.' });
  assert.equal(countryFlag('br'), '/flags/br.svg'); assert.equal(flagMarkup({ country: 'br' }), '<img class="banner country" src="/flags/br.svg" alt="">');
  assert.deepEqual([flagTall({ country: 'br' }), flagTall({ field: 'plain', colours: [0, 1, 2], emblem: 'none' })], [3 / 4, 2 / 3]);
  // On the field it is its picture, the right way up where y is up, from its hoist to either side; nothing until the picture has come.
  const calls = [], g = Object.fromEntries(['save', 'restore', 'transform', 'texture', 'poly', 'circle', 'fill', 'stroke'].map(name => [name, (...args) => { calls.push([name, ...args]); return g; }])),
    picture = { name: 'picture' };
  drawFlag(g, { country: 'br' }, 100, 50, 6); assert.deepEqual(calls, []);
  drawFlag(g, { country: 'br' }, 100, 50, 6, picture);
  assert.deepEqual(calls.splice(0), [['save'], ['transform', 6, 0, 0, -4.5, 100, 50], ['texture', picture, 0xffffff, 0, 0, 1, 1], ['restore']]);
  drawFlag(g, { country: 'br' }, 100, 50, -6, picture); assert.deepEqual(calls.splice(0)[1], ['transform', -6, 0, 0, -4.5, 100, 50], 'mirrored about its mast, as a flag is seen from behind');
  // A drawing that keeps its places in a transform of its own is drawn through it.
  drawFlag({ context: g }, { country: 'br' }, 0, 0, 1, picture); assert.equal(calls.length, 4);
});

test('on the field a flag flies from its hoist to either side, two thirds as tall as it is wide', () => {
  const drawn = [], g = { poly(points) { drawn.push(points); return g; }, circle(x, y, r) { drawn.push([x - r, y - r, x + r, y + r]); return g; }, fill() { return g; }, stroke() { return g; } },
    flag = { field: 'canton', colours: [4, 0, 8], emblem: 'ring' }, extent = () => { const all = drawn.splice(0).flat();
      return [Math.min(...all.filter((_, i) => i % 2 === 0)), Math.max(...all.filter((_, i) => i % 2 === 0)), Math.min(...all.filter((_, i) => i % 2)), Math.max(...all.filter((_, i) => i % 2))]; };
  drawFlag(g, flag, 100, 50, 6); assert.deepEqual(extent(), [100, 106, 46, 50]);
  drawFlag(g, flag, 100, 50, -6); assert.deepEqual(extent(), [94, 100, 46, 50], 'to the left of its mast');
  // The canton is at the hoist, on whichever side the flag flies.
  drawFlag(g, flag, 100, 50, -6); assert.deepEqual(drawn[1], [100, 50, 97, 50, 97, 48, 100, 48]);
});
