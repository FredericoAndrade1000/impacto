import { clamp } from './math.ts';

const HEALTH_TONES: readonly (readonly [number, number])[] = [[0, 0x686c68], [0.25, 0xb67a65], [0.65, 0xd2bb80], [1, 0xffffff]];

export function componentTint(module: { health?: number | undefined; maxHealth?: number | undefined }): number {
  const ratio = clamp(Number(module.health) / Math.max(1, Number(module.maxHealth)), 0, 1);
  if (ratio === 1) return 0xffffff;
  for (let i = 1; i < HEALTH_TONES.length; i++) {
    const previous = HEALTH_TONES[i - 1], current = HEALTH_TONES[i];
    if (previous && current && ratio <= current[0]) {
      const [lo, a] = previous, [hi, b] = current, t = (ratio - lo) / (hi - lo);
      return [16, 8, 0].reduce((color, shift) => color | Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t) << shift, 0);
    }
  }
  return 0xffffff;
}
