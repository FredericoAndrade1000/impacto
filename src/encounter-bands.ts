const LIMIT = 8, HOLD = 4, LIFE = 12;

export interface EncounterBand { id: string; x: number; approximate: boolean; alpha: number }

// These are places the faction was already told about, never a new source of enemy positions.
export class EncounterBands {
  private active = new Map<string, { at: number; band: EncounterBand }>();
  private sampled: EncounterBand[] = [];
  record(items: unknown, nowSeconds: number) {
    if (!Array.isArray(items) || !Number.isFinite(nowSeconds)) return;
    const reported: readonly unknown[] = items;
    for (const item of reported) {
      if (!item || typeof item !== 'object' || !('encounter' in item)) continue;
      const encounter = item.encounter;
      if (!encounter || typeof encounter !== 'object' || !('id' in encounter) || typeof encounter.id !== 'string' || !encounter.id.trim() ||
          !('x' in encounter) || typeof encounter.x !== 'number' || !Number.isFinite(encounter.x)) continue;
      const old = this.active.get(encounter.id);
      // Several workers may report the same encounter. Neither its place nor its lifetime is reset.
      if (old && nowSeconds - old.at < LIFE) continue;
      this.active.delete(encounter.id);
      this.active.set(encounter.id, { at: nowSeconds,
        band: { id: encounter.id, x: encounter.x, approximate: Boolean('approximate' in encounter && encounter.approximate), alpha: 1 } });
      const oldest = this.active.size > LIMIT ? this.active.keys().next().value : undefined;
      if (oldest !== undefined) this.active.delete(oldest);
    }
  }
  sample(nowSeconds: number) {
    const shown = this.sampled; shown.length = 0;
    if (!Number.isFinite(nowSeconds)) return shown;
    for (const [id, entry] of this.active) {
      const age = Math.max(0, nowSeconds - entry.at);
      if (age >= LIFE) { this.active.delete(id); continue; }
      entry.band.alpha = age <= HOLD ? 1 : (LIFE - age) / (LIFE - HOLD);
      shown.push(entry.band);
    }
    return shown;
  }
  clear() { this.active.clear(); this.sampled.length = 0; }
}
