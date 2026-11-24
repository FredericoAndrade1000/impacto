import type { Graphics } from 'pixi.js';
export interface Sight { x: number; y: number; hidden: readonly (readonly [number, number])[]; left: number; right: number; range: number; mode: string }
type SightGround = number | ((x: number) => number);
import { tr } from './i18n.ts';
import { locale } from './i18n.ts';
import { TAU } from './math.ts';

// What an optic or a radar of a design sees, as the workshop shows it of the one selected. The core tells of
// each (`sights`, in the compiled design) what it is (`mode`), where it stands, how far it reaches, how far it
// reaches out level to the left — the front of what is written — and to the right, and the arcs its own armour
// hides from it: glass hides nothing from an optic, fibreglass nothing from a radar.
const SIGHT = 0x9fd8e0, LIT = 0xdaf7fb, SHUT = 0xf59c87, STEP = Math.PI / 60;
// The figure is a glow about the optic and not the whole of what it sees, which goes far past any view of the
// workshop: strongest by the optic and gone at the reach it is drawn to. It is laid in this many rings, each
// shorter than the one before, and a line of it thins out in this many stretches.
const RINGS = 24, GLOW = .5, STRETCHES = 8, FAINT = .28;
// About the optic itself a dial of this many pixels tells the turn: what is open in the tone of the sight, what its
// armour hides in the tone of what is shut.
const DIAL = 15;
// The ground under a line is looked for at this many places along it.
const MARCH = 24;

// The arcs left open to an optic: what of a whole turn its armour does not hide, each from an angle to a greater one.
export function openArcs(sight: Sight): [number, number][] {
  const hidden = sight.hidden;
  if (!hidden.length) return [[-Math.PI, Math.PI]];
  return hidden.map(([, to], i): [number, number] => [to, i + 1 < hidden.length ? hidden[i + 1]![0] : hidden[0]![0] + TAU]).filter(([from, to]) => to - from > 1e-6);
}

// How far along a line from the optic the ground lets it go, of the `reach` asked. The ground is one height, or
// the height it has at each place: then the line stops where it first goes under it.
function along(sight: Sight, angle: number, reach: number, ground: SightGround) {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (typeof ground !== 'function') return s < 0 ? Math.min(reach, Math.max(0, (ground - sight.y) / s)) : reach;
  const over = (far: number) => sight.y + s * far - ground(sight.x + c * far);
  for (let i = 1, clear = 0; i <= MARCH; i++) {
    const far = reach * i / MARCH;
    if (over(far) >= 0) { clear = far; continue; }
    let under = far;
    for (let k = 0; k < 10; k++) { const middle = (clear + under) / 2; if (over(middle) < 0) under = middle; else clear = middle; }
    return clear;
  }
  return reach;
}

// What is drawn of a sight: a fan for each open arc, as the points of its outline from the optic round, out to
// `reach` and no lower than the ground (`ground`, a height or the height at a place); and the lines it sees out
// level along, to each side it does, as far as the fans go.
export function sightFigure(sight: Sight, reach: number, ground: SightGround = -Infinity) {
  const at = (angle: number): [number, number] => { const far = along(sight, angle, reach, ground); return [sight.x + Math.cos(angle) * far, sight.y + Math.sin(angle) * far]; },
    floor = typeof ground === 'function' ? ground(sight.x) : ground,
    fans = sight.y > floor ? openArcs(sight).map(([from, to]) => {
      const steps = Math.max(1, Math.ceil((to - from) / STEP)), points = [sight.x, sight.y];
      for (let i = 0; i <= steps; i++) points.push(...at(from + (to - from) * i / steps));
      return { points, whole: to - from > TAU - 1e-6, edges: [from, to].map(at) };
    }) : [];
  return { fans, level: ([[sight.left, Math.PI], [sight.right, 0]] satisfies [number, number][]).filter(([far]) => far > 0).map(([, angle]) => at(angle)) };
}

// The figure of a sight on a drawing of the world, `pixel` being the width of a pixel there: the fans as a glow
// that is gone at their outline, which is drawn faint; the edges of each as faint lines and the level lines as
// bright ones, thinning out as the glow does; and the dial about the optic. An optic that sees nothing out has a
// ring around it instead.
export function drawSight(g: Graphics, sight: Sight, reach: number, ground: SightGround, pixel: number) {
  const { fans, level } = sightFigure(sight, reach, ground);
  if (!fans.length) { g.circle(sight.x, sight.y, 14 * pixel).stroke({ color: SHUT, width: pixel * 1.6, alpha: .85 }); return; }
  const part = (value: number, i: number, share: number) => { const from = i % 2 ? sight.y : sight.x; return from + (value - from) * share; },
    line = ([x, y]: [number, number], width: number, alpha: number) => {
      for (let i = 0; i < STRETCHES; i++)
        g.moveTo(part(x, 0, i / STRETCHES), part(y, 1, i / STRETCHES)).lineTo(part(x, 0, (i + 1) / STRETCHES), part(y, 1, (i + 1) / STRETCHES))
          .stroke({ color: SIGHT, width, alpha: alpha * (1 - (1 - FAINT) * i / STRETCHES) });
    },
    turn = (from: number, to: number, color: number, alpha: number) => {
      const steps = Math.max(1, Math.ceil((to - from) / STEP)), far = DIAL * pixel;
      for (let i = 0; i <= steps; i++) { const angle = from + (to - from) * i / steps, x = sight.x + Math.cos(angle) * far, y = sight.y + Math.sin(angle) * far; i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke({ color, width: pixel * 2.2, alpha });
    };
  for (const fan of fans) {
    for (let ring = RINGS; ring > 0; ring--) g.poly(fan.points.map((value, i) => part(value, i, ring / RINGS))).fill({ color: LIT, alpha: GLOW / RINGS });
    g.poly(fan.points.slice(2), false).stroke({ color: SIGHT, width: pixel, alpha: FAINT });
    if (!fan.whole) for (const edge of fan.edges) line(edge, pixel * 1.2, .55);
  }
  for (const end of level) line(end, pixel * 2, .95);
  for (const [from, to] of openArcs(sight)) turn(from, to, SIGHT, .95);
  for (const [from, to] of sight.hidden) turn(from, to, SHUT, .8);
}

// What the bar says of the optic or the radar selected: how far it sees out level — or reaches, a radar —, ahead and behind.
export function sightText(sight: Sight) {
  const far = (metres: number) => Math.round(metres).toLocaleString(locale()) + ' m', radar = sight.mode === 'radar', sees = radar ? tr('alcança') : tr('vê');
  return !sight.range ? (radar ? tr('radar bloqueado: blindagem em toda a volta') : tr('sem visão: blindagem em toda a volta')) :
    sight.left && sight.right ? tr`${sees} ${far(sight.left)} à frente e atrás` :
    sight.left ? tr`${sees} ${far(sight.left)} à frente, nada atrás` : sight.right ? tr`${sees} ${far(sight.right)} atrás, nada à frente` :
    radar ? tr('radar sem alcance ao nível do solo') : tr('sem visão ao nível do solo');
}
