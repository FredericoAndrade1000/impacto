import type { CommanderObservation } from '../../server/commander-contract.ts';
import type { SupplyBill } from '../../src/economy-contract.ts';

export interface StockTrend { readonly seconds: number; readonly perMinute: Readonly<SupplyBill> }
export const NO_TREND: StockTrend = Object.freeze({ seconds: 0, perMinute: Object.freeze({ ferro: 0, ligas: 0, silica: 0, combustivel: 0 }) });

// Private experiment memory, sampled before each decision. These are net stock
// changes (including purchases and services), not gross production or income.
// Never attach this history to the room, save, protocol or ordinary commander.
export class EconomicHistory {
  private samples: { time: number; stock: SupplyBill }[] = [];

  observe(o: Pick<CommanderObservation, 'time' | 'stock'>): StockTrend {
    const last = this.samples.at(-1);
    if (last && o.time < last.time) throw new Error('Economic history requires chronological observations.');
    if (!last || o.time > last.time) {
      this.samples.push({ time: o.time, stock: { ...o.stock } });
      while (this.samples.length > 1 && this.samples[0]!.time < o.time - 60) this.samples.shift();
    }
    const first = this.samples[0]!, latest = this.samples.at(-1)!, seconds = latest.time - first.time;
    if (seconds < 15) return NO_TREND;
    const rate = (id: keyof SupplyBill) => (latest.stock[id] - first.stock[id]) * 60 / seconds;
    return { seconds, perMinute: { ferro: rate('ferro'), ligas: rate('ligas'), silica: rate('silica'), combustivel: rate('combustivel') } };
  }
}
