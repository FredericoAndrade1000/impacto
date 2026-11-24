import type { CargoKind } from '../../src/economy-contract.ts';
import type { CommanderObservation } from '../../server/commander-contract.ts';
import { safeCommanderRoute } from '../../server/commander-routes.ts';

// Training bookkeeping only. These points never enter observations, stocks or
// commands. Initial known deposits and repeated sightings cannot earn credit.
export class DiscoveryProgress {
  private readonly sources: Set<string>;
  private readonly bases: Set<string>;
  private readonly materials = new Set<CargoKind>();
  private enemyBase = false;
  constructor(initial: CommanderObservation) {
    this.sources = new Set(initial.deposits.map(d => d.id));
    this.bases = new Set(initial.bases.filter(b => b.seen || b.at !== null).map(b => b.id));
  }
  observe(o: CommanderObservation): void {
    if (!o.base) return;
    for (const site of o.deposits) {
      if (this.sources.has(site.id) || !site.seen && site.at === null ||
        site.left < 1000 && site.stock < 250 || Math.abs(site.x - o.base.x) > 5000 ||
        !safeCommanderRoute(o, o.base.x, site.x)) continue;
      this.sources.add(site.id); this.materials.add(site.material);
    }
    for (const base of o.bases) {
      if (this.bases.has(base.id) || base.id === o.factionId || base.sheltered || !base.seen && base.at === null) continue;
      this.bases.add(base.id); this.enemyBase = true;
    }
  }
  get value(): number { return Math.min(1, (this.materials.size + Number(this.enemyBase)) / 5); }
  summary() { return { materials: [...this.materials].sort(), enemyBase: this.enemyBase, progress: this.value }; }
}
