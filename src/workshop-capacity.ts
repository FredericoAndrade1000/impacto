import type { CompiledConstruction } from './construction-contract.ts';

export interface ChassisCapacity { loadedKg: number; emptyKg: number; limitKg: number; marginKg: number; ratio: number; percent: number; frameLimitKg?: number; gearLimitKg?: number; over: boolean; value: string; margin: string; detail: string }
import { tr } from './i18n.ts';
import { node } from './dom-view.ts';
import { number } from './part-view.ts';

const readings = new WeakMap<CompiledConstruction, ChassisCapacity>();
const tonnes = (kg: number, digits = 1) => number(kg / 1000, digits) + ' t';
const marginWeight = (kg: number) => kg < 1000 ? number(kg, 0) + ' kg' : tonnes(kg);

// The compiler weighs the complete vehicle with all reserves and cargo full,
// and supplies the limits of its actual structure and running gear.
export function chassisCapacity(blueprint: CompiledConstruction | null | undefined): ChassisCapacity | null {
  if (!blueprint?.chassis) return null;
  if (readings.has(blueprint)) return readings.get(blueprint)!;
  const { loadedKg, emptyKg, limitKg, frameLimitKg, gearLimitKg } = blueprint.chassis;
  if (![loadedKg, emptyKg, limitKg].every(Number.isFinite) || limitKg <= 0) return null;
  const ratio = loadedKg / limitKg, marginKg = limitKg - loadedKg,
    limits = [...(Number.isFinite(frameLimitKg) ? [tr`estrutura ${tonnes(frameLimitKg)}`] : []),
      ...(Number.isFinite(gearLimitKg) ? [tr`rodagem ${tonnes(gearLimitKg)}`] : [])];
  const result = { loadedKg, emptyKg, limitKg, marginKg, ratio, percent: Math.round(ratio * 100),
    ...(Number.isFinite(frameLimitKg) ? { frameLimitKg } : {}), ...(Number.isFinite(gearLimitKg) ? { gearLimitKg } : {}),
    over: marginKg < -1e-6,
    value: `${number(loadedKg / 1000, 1)} / ${tonnes(limitKg)}`,
    margin: marginKg >= 0 ? tr`Sobram ${marginWeight(marginKg)}` : tr`${marginWeight(-marginKg)} acima do limite`,
    detail: tr`Vazio: ${tonnes(emptyKg)}` + (limits.length ? tr` · limites: ${limits.join(', ')}` : '') };
  readings.set(blueprint, result); return result;
}

export function capacityElement(capacity: ChassisCapacity) {
  const card = node('dl', 'capacity-card'), title = node('dt', '', tr('Peso cheio / limite do chassi')), value = node('dd'),
    meter = node('meter'), margin = node('p', 'capacity-margin', capacity.margin);
  title.title = tr('Com combustível, munição e carga cheios');
  card.dataset.state = capacity.over ? 'over' : 'ready';
  value.append(node('strong', '', capacity.value), node('span', '', capacity.percent + '%'));
  meter.min = 0; meter.max = capacity.limitKg; meter.value = capacity.loadedKg;
  meter.setAttribute('aria-label', tr('Peso com tudo cheio em relação ao limite do chassi'));
  meter.setAttribute('aria-valuetext', capacity.value); meter.textContent = capacity.percent + '%';
  margin.title = tr('Peso disponível para alterar o projeto; as reservas e a carga já estão incluídas.');
  card.append(title, value, meter, margin, node('small', 'capacity-detail', capacity.detail));
  return card;
}
