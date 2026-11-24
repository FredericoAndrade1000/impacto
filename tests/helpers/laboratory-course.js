// Test-only contact/drawing fixtures. These are deliberately artificial, never a playable terrain profile.
import { Terrain } from '../../src/terrain.ts';
const START = 12, MIN = START - 2750, MAX = START + 300, STEP = .25;
const CASES = [
  { label: 'Descida íngreme', at: 660, surface: 'soil', height: -8, run: 10, top: 10, fall: 80 },
  { label: 'Vala 2 m', at: 950, surface: 'soil', height: -1.5, run: .25, top: 1.5, fall: .25 },
  { label: 'Degrau 0,3 m', at: 1100, surface: 'concrete', height: .3, run: .25, top: 10, fall: 2.1 },
  { label: 'Degrau 0,5 m', at: 1400, surface: 'concrete', height: .5, run: .25, top: 10, fall: 3.5 },
  { label: 'Degrau 0,75 m', at: 1700, surface: 'concrete', height: .75, run: .25, top: 10, fall: 5.25 },
  { label: 'Lama', at: 2300, surface: 'mud', height: 20, run: 66, top: 6, fall: 100 },
  { label: 'Vala 3,5 m', at: 2550, surface: 'soil', height: -1.5, run: .25, top: 3, fall: .25 },
  { label: 'Degrau 1 m', at: 2650, surface: 'concrete', height: 1, run: .25, top: 10, fall: 7 },
];
const end = obstacle => obstacle.at + obstacle.run + obstacle.top + obstacle.fall;
function rise(obstacle, along) {
  const { height, run, top, fall } = obstacle;
  return along < run ? height * along / run : along < run + top ? height : height * (run + top + fall - along) / fall;
}

export function laboratoryCourse() {
  const points = [{ x: MIN - 256, y: 0 }], sectors = [], count = (MAX - MIN) / STEP;
  const surface = along => CASES.find(obstacle => along >= obstacle.at && along < end(obstacle))?.surface ??
    (along >= -24 && along < 40 ? 'concrete' : 'soil');
  for (let i = 0; i <= count; i++) {
    const x = MIN + i * STEP, along = START - x;
    let y = 0;
    for (const obstacle of CASES)
      if (along >= obstacle.at && along <= end(obstacle)) y += rise(obstacle, along - obstacle.at);
    points.push({ x, y: Math.fround(y) });
  }
  points.push({ x: MAX + 256, y: 0 });
  for (let i = 0; i < count; i++) {
    const x = MIN + i * STEP, to = x + STEP, kind = surface(START - (x + to) / 2), last = sectors.at(-1);
    if (last?.surface === kind) last.end = to;
    else sectors.push({ start: x, end: to, surface: kind });
  }
  sectors[0].start = MIN - 256; sectors.at(-1).end = MAX + 256;
  const terrain = Terrain.fromSnapshot({ id: 'flat', material: 'soil', seed: 0, length: MAX - MIN, center: (MIN + MAX) / 2,
    minX: MIN, maxX: MAX, spacing: STEP, points, sectors });
  // Labels only locate existing physical regressions. There is no production sign renderer or terrain ID.
  terrain.signs = CASES.map(obstacle => ({ x: START - (obstacle.at - 6), text: obstacle.label }));
  return terrain;
}
