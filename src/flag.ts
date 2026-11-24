import { tr } from './i18n.ts';
import { hex } from './format.ts';
import type { Texture } from 'pixi.js';
export type FlagField = keyof typeof FLAG_FIELDS;
export type FlagEmblem = keyof typeof FLAG_EMBLEMS;
export interface CountryFlag { country: string; field?: never; colours?: never; emblem?: never }
export interface CustomFlag { country?: never; field: FlagField; colours: [number, number, number]; emblem: FlagEmblem }
export type FlagChoice = CountryFlag | CustomFlag;
export type FactionFlag = FlagChoice;
export const isCountryFlag = (flag: FlagChoice): flag is CountryFlag => typeof flag.country === 'string';
export interface FlagIdentity { readonly id: string; readonly flag: FlagChoice }
export interface FlagFaction extends FlagIdentity { readonly known: readonly FlagIdentity[] }
interface FlagPaint { color: number; width?: number }
interface FlagPen { fill(paint: FlagPaint): unknown; stroke(paint: FlagPaint): unknown }
interface FlagTransform {
  save(): FlagTransform; transform(a: number, b: number, c: number, d: number, tx: number, ty: number): FlagTransform;
  texture(texture: Texture, tint: number, x: number, y: number, width: number, height: number): FlagTransform;
  restore(): FlagTransform;
}
export interface FlagGraphics extends FlagTransform {
  readonly context?: FlagTransform;
  poly(points: number[]): FlagPen;
  circle(x: number, y: number, radius: number): FlagPen;
}
export type FlagShape = { colour: number; points: number[]; circle?: never; hollow?: never } | { colour: number; circle: [number, number, number]; hollow?: number; points?: never };
const hasField = (value: unknown): value is FlagField => typeof value === 'string' && Object.hasOwn(FLAG_FIELDS, value);
const hasEmblem = (value: unknown): value is FlagEmblem => typeof value === 'string' && Object.hasOwn(FLAG_EMBLEMS, value);


// The flag of a faction and the name of its nation. A flag is made — a field parted one of a dozen ways, in up to
// three colours of a fixed palette, with an emblem over it or none — or it is that of a country, of today or of
// another time, named by its code. It is a choice among what the game has, never a picture a player sends, so that whatever is flown is a
// flag and nothing else, and a faction is told of another's in a few bytes.
// A faction that has chosen none flies one the field drew for it when it was founded (room.ts).

// The palette, by place: a flag names its colours by where they stand here.
export const FLAG_COLOURS = Object.freeze([
  { name: tr('Branco'), value: 0xf2efe6 }, { name: tr('Creme'), value: 0xe6d3a3 }, { name: tr('Amarelo'), value: 0xf2c230 }, { name: tr('Laranja'), value: 0xe07b2a },
  { name: tr('Vermelho'), value: 0xc8312b }, { name: tr('Carmesim'), value: 0x8c1f2f }, { name: tr('Roxo'), value: 0x6b3fa0 }, { name: 'Azul-marinho', value: 0x1f2f6b },
  { name: tr('Azul'), value: 0x2f6fc4 }, { name: 'Azul-celeste', value: 0x7fc0e8 }, { name: tr('Verde-água'), value: 0x2a9d8f }, { name: tr('Verde'), value: 0x3f9b46 },
  { name: 'Verde-escuro', value: 0x1f5b34 }, { name: tr('Marrom'), value: 0x7a4a26 }, { name: tr('Cinza'), value: 0x8a8f8c }, { name: tr('Preto'), value: 0x1b1d1c }]);
export const FLAG_FIELDS = Object.freeze({ plain: tr('Lisa'), horizontal2: tr('Duas faixas'), horizontal3: tr('Três faixas'), vertical2: tr('Duas colunas'), vertical3: tr('Três colunas'),
  diagonal: 'Diagonal', quarters: tr('Quartos'), cross: tr('Cruz'), saltire: tr('Cruz em X'), canton: tr('Cantão'), chevron: tr('Cunha'), border: tr('Borda') });
export const FLAG_EMBLEMS = Object.freeze({ none: tr('Sem emblema'), star: tr('Estrela'), disc: tr('Disco'), diamond: tr('Losango'), ring: tr('Anel') });
// A flag that is made is three wide and two tall; its hoist is its left edge.
export const FLAG_WIDTH = 3, FLAG_HEIGHT = 2;
// The countries whose flags may be flown as they are (ISO 3166-1, by their two letters). Their drawings are those of
// public/flags (flag-icons, MIT), four wide and three tall.
export const COUNTRIES = Object.freeze('ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'.split(' '));
// Flags of countries that are no more, or that flew another flag in the wars of their time, by a code of the game's
// (their old two letters where they had them): their names, the years of the flag, and what else they are called.
// Their drawings are public-domain ones of Wikimedia Commons cut to four wide and three tall (public/flags/HISTORIC.txt).
// Flags that are now signs of hatred — the Nazi swastika, the Confederacy's, Rhodesia's and their like — are not among them.
export const HISTORIC = Object.freeze({
  su: { name: tr('União Soviética'), years: '1922–1991', also: 'URSS' },
  yu: { name: tr('Iugoslávia'), years: '1945–1992', also: tr('Iugoslávia socialista') },
  'yu-kingdom': { name: tr('Reino da Iugoslávia'), years: '1918–1941' },
  dd: { name: tr('Alemanha Oriental'), years: '1949–1990', also: 'RDA' },
  cs: { name: tr('Tchecoslováquia'), years: '1918–1992' },
  ottoman: { name: tr('Império Otomano'), years: '1844–1922', also: tr('Turquia otomana') },
  'austria-hungary': { name: tr('Áustria-Hungria'), years: '1867–1918', also: tr('Império Austro-Húngaro') },
  'german-empire': { name: tr('Império Alemão'), years: '1871–1918', also: tr('Alemanha imperial') },
  'italy-kingdom': { name: tr('Reino da Itália'), years: '1861–1946' },
  'spain-republic': { name: tr('República Espanhola'), years: '1931–1939', also: tr('Espanha republicana') },
  'portugal-kingdom': { name: tr('Reino de Portugal'), years: '1830–1910' },
  'brazil-empire': { name: tr('Império do Brasil'), years: '1822–1889' },
  'us-48': { name: tr('Estados Unidos'), years: '1912–1959', also: '48 estrelas' },
  'free-france': { name: tr('França Livre'), years: '1940–1944' },
  'south-vietnam': { name: tr('Vietnã do Sul'), years: '1955–1975' },
  zr: { name: 'Zaire', years: '1971–1997' },
  'iran-1964': { name: tr('Irã imperial'), years: '1964–1980', also: tr('Pérsia') },
  'romania-1965': { name: tr('Romênia socialista'), years: '1965–1989' },
  'albania-1946': { name: tr('Albânia socialista'), years: '1946–1992' },
  qing: { name: tr('Império Qing'), years: '1889–1912', also: tr('China imperial') },
});
const KNOWN_COUNTRIES = new Set([...COUNTRIES, ...Object.keys(HISTORIC)]);
export const countryFlag = (code: string): string => `/flags/${code}.svg`;
// How tall a flag is for each unit of its width.
export const flagTall = (flag: FlagChoice): number => flag.country ? 3 / 4 : FLAG_HEIGHT / FLAG_WIDTH;
export const NATION_NAME = Object.freeze({ min: 2, max: 24 });

// A flag as it is kept and told: the country it is of; or its field, the three colours it may use — the ground, the
// second and the third, which is the emblem's too — and its emblem. Anything else is refused.
export function validFlag(value: unknown): FlagChoice {
  if (!value || typeof value !== 'object') throw new Error(tr('Bandeira inválida.'));
  if (Object.hasOwn(value, 'country')) {
    const country: unknown = Reflect.get(value, 'country');
    if (typeof country !== 'string' || !KNOWN_COUNTRIES.has(country)) throw new Error(tr('Bandeira inválida.'));
    return { country };
  }
  const colours: unknown = 'colours' in value ? value.colours : undefined;
  if (!('field' in value) || !hasField(value.field) || !('emblem' in value) || !hasEmblem(value.emblem) || !Array.isArray(colours) || colours.length !== 3 ||
      !colours.every((colour: unknown) => typeof colour === 'number' && Number.isInteger(colour) && colour >= 0 && colour < FLAG_COLOURS.length)) throw new Error(tr('Bandeira inválida.'));
  const [a, b, c]: unknown[] = colours;
  if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number') throw new Error(tr('Bandeira inválida.'));
  return { field: value.field, colours: [a, b, c], emblem: value.emblem };
}
// The name a faction gives its nation, as it is kept: trimmed, with single spaces and nothing that is not to be read.
// An empty one is none (null): the faction goes by its leader's name again.
export function nationName(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(tr('Nome de facção inválido.'));
  const name = value.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ +/g, ' ').trim();
  if (!name) return null;
  if ([...name].length < NATION_NAME.min || [...name].length > NATION_NAME.max) throw new Error(tr`O nome da facção precisa ter de ${NATION_NAME.min} a ${NATION_NAME.max} caracteres.`);
  return name;
}
// A flag that is made, worked out of `seed`: always the same for the same seed, and of three colours that tell apart.
// The flag a faction flies before it makes its own is one of these, of a seed drawn by chance; the maker starts from one.
export function defaultFlag(seed: string | number): CustomFlag {
  let hash = 2166136261;
  for (const letter of String(seed)) {
    const point = letter.codePointAt(0);
    if (point === undefined) throw new Error('Empty flag seed letter');
    hash = Math.imul(hash ^ point, 16777619) >>> 0;
  }
  const draw = (count: number): number => { hash = Math.imul(hash ^ hash >>> 15, 2246822519) >>> 0; hash = Math.imul(hash ^ hash >>> 13, 3266489917) >>> 0; return ((hash ^ hash >>> 16) >>> 0) % count; },
    fields = Object.keys(FLAG_FIELDS).filter(hasField), emblems = Object.keys(FLAG_EMBLEMS).filter(hasEmblem), colours: number[] = [];
  while (colours.length < 3) { const colour = draw(FLAG_COLOURS.length); if (!colours.includes(colour)) colours.push(colour); }
  const field = fields[draw(fields.length)], emblem = emblems[draw(emblems.length)], [a, b, c] = colours;
  if (field === undefined || emblem === undefined || a === undefined || b === undefined || c === undefined) throw new Error('Incomplete flag catalogue');
  return { field, colours: [a, b, c], emblem };
}
// The flag of every faction a faction is told of — its own, and those it has met —, by the faction.
export function knownFlags(faction: FlagFaction | null | undefined): Map<string, FlagChoice> {
  const flags = new Map<string, FlagChoice>();
  if (faction) { flags.set(faction.id, faction.flag); for (const other of faction.known) flags.set(other.id, other.flag); }
  return flags;
}

const W = FLAG_WIDTH, H = FLAG_HEIGHT, box = (x: number, y: number, w: number, h: number): number[] => [x, y, x + w, y, x + w, y + h, x, y + h];
// The parts a field is made of over its ground, each a colour of the flag (by place) and a polygon.
const FIELDS: Record<FlagField, () => [0 | 1 | 2, number[]][]> = {
  plain: () => [],
  horizontal2: () => [[1, box(0, H / 2, W, H / 2)]],
  horizontal3: () => [[1, box(0, H / 3, W, H / 3)], [2, box(0, 2 * H / 3, W, H / 3)]],
  vertical2: () => [[1, box(W / 2, 0, W / 2, H)]],
  vertical3: () => [[1, box(W / 3, 0, W / 3, H)], [2, box(2 * W / 3, 0, W / 3, H)]],
  diagonal: () => [[1, [W, 0, W, H, 0, H]]],
  quarters: () => [[1, box(W / 2, 0, W / 2, H / 2)], [1, box(0, H / 2, W / 2, H / 2)]],
  cross: () => [[1, box(0, H / 2 - .2, W, .4)], [1, box(W / 2 - .2, 0, .4, H)]],
  saltire: () => [[1, [0, 0, .42, 0, W, H - .28, W, H, W - .42, H, 0, .28]], [1, [W, 0, W, .28, .42, H, 0, H, 0, H - .28, W - .42, 0]]],
  canton: () => [[1, box(0, 0, W / 2, H / 2)]],
  chevron: () => [[1, [0, 0, W * .42, H / 2, 0, H]]],
  border: () => [[1, box(0, 0, W, .26)], [1, box(0, H - .26, W, .26)], [1, box(0, 0, .26, H)], [1, box(W - .26, 0, .26, H)]],
};
const star = (cx: number, cy: number, r: number): number[] => Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, d = i % 2 ? r * .4 : r; return [cx + Math.cos(a) * d, cy + Math.sin(a) * d]; }).flat();
// What a flag that is made is drawn of, from the back to the front, in its own measure (three by two, the hoist on the left, y down):
// polygons (`points`), and for a disc or a ring a `circle` — its middle and its radius —, a ring `hollow` by the
// width of its line. `colour` is the colour itself.
export function flagShapes(flag: CustomFlag): FlagShape[] {
  const colour = (place: 0 | 1 | 2): number => { const entry = FLAG_COLOURS[flag.colours[place]]; if (!entry) throw new Error('Invalid flag colour'); return entry.value; }, shapes: FlagShape[] = [{ colour: colour(0), points: box(0, 0, W, H) }];
  for (const [place, points] of FIELDS[flag.field]()) shapes.push({ colour: colour(place), points });
  const cx = W / 2, cy = H / 2, ink = colour(2);
  if (flag.emblem === 'star') shapes.push({ colour: ink, points: star(cx, cy + .04, .56) });
  else if (flag.emblem === 'diamond') shapes.push({ colour: ink, points: [cx, cy - .56, cx + .48, cy, cx, cy + .56, cx - .48, cy] });
  else if (flag.emblem === 'disc') shapes.push({ colour: ink, circle: [cx, cy, .44] });
  else if (flag.emblem === 'ring') shapes.push({ colour: ink, circle: [cx, cy, .4], hollow: .16 });
  return shapes;
}
// A flag as a drawing for the page's panels: the picture of a country's, or the shapes of one that is made.
export function flagMarkup(flag: FlagChoice): string {
  if (isCountryFlag(flag)) return `<img class="banner country" src="${countryFlag(flag.country)}" alt="">`;
  const parts = flagShapes(flag).map(shape => shape.points ? `<polygon points="${shape.points.map(n => +n.toFixed(3)).join(' ')}" fill="${hex(shape.colour)}"/>` :
    shape.hollow ? `<circle cx="${shape.circle[0]}" cy="${shape.circle[1]}" r="${shape.circle[2]}" fill="none" stroke="${hex(shape.colour)}" stroke-width="${shape.hollow}"/>` :
      `<circle cx="${shape.circle[0]}" cy="${shape.circle[1]}" r="${shape.circle[2]}" fill="${hex(shape.colour)}"/>`);
  return `<svg class="banner" viewBox="0 0 ${W} ${H}" aria-hidden="true">${parts.join('')}</svg>`;
}
// A flag on the field: its upper hoist corner at a place, `width` wide — to the left of it when the width is
// negative, as a flag flies from a mast to either side — and as tall as its kind is, y up. That of a country is its
// picture (`texture`), laid by a transform of the drawing's own so that it stands the right way up where y is up;
// until the picture has come there is nothing of it.
export function drawFlag(g: FlagGraphics, flag: FlagChoice, x: number, y: number, width: number, texture: Texture | null = null): void {
  if (isCountryFlag(flag)) {
    const context = g.context ?? g;
    if (texture) context.save().transform(width, 0, 0, -Math.abs(width) * flagTall(flag), x, y).texture(texture, 0xffffff, 0, 0, 1, 1).restore();
    return;
  }
  const scale = width / W, tall = Math.abs(scale), px = (n: number): number => x + n * scale, py = (n: number): number => y - n * tall;
  for (const shape of flagShapes(flag)) {
    if (shape.points) g.poly(shape.points.map((n, i) => i % 2 ? py(n) : px(n))).fill({ color: shape.colour });
    else if (shape.hollow) g.circle(px(shape.circle[0]), py(shape.circle[1]), shape.circle[2] * tall).stroke({ color: shape.colour, width: shape.hollow * tall });
    else g.circle(px(shape.circle[0]), py(shape.circle[1]), shape.circle[2] * tall).fill({ color: shape.colour });
  }
}
