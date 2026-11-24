import type { ModuleKind } from './materials.ts';
import type { ChecklistItem } from './workshop-checklist.ts';

export interface SummaryFigure { label: string; value: string; title?: string; over?: boolean }
export type PartCategory = 'base' | 'combat' | 'cargo';
import { tr } from './i18n.ts';
// Presentation groups never decide whether equipment may be installed.
export const PART_CATEGORIES: readonly { id: PartCategory; label: string; kinds: readonly ModuleKind[] }[] = Object.freeze([
  { id: 'base', label: tr('Essenciais'), kinds: ['engine', 'fuel', 'command', 'sensor', 'thruster'] },
  { id: 'combat', label: tr('Combate'), kinds: ['weapon', 'ammo'] },
  { id: 'cargo', label: tr('Logística'), kinds: ['excavator', 'drill', 'builder', 'blade', 'paver', 'hopper', 'cistern', 'supply'] },
]);
export const categoryOf = (kind: string): PartCategory => PART_CATEGORIES.find(category => category.kinds.some(own => own === kind))?.id || 'base';
// The figures told over the project; Revisão tells the others.
export const SUMMARY_FIGURES = Object.freeze([tr('PESO'), tr('POTÊNCIA'), tr('AUTONOMIA')]);
// What the range of a vehicle is reckoned on.
export const RANGE_NOTE = tr('À velocidade máxima, em piso firme e plano. Subidas e arrancadas consomem mais.');
// What an aircraft's range is, as long as its tank keeps it hovering (game_hover.rs `hover`).
export const HOVER_NOTE = tr('Pairando com tudo cheio. Andar e subir gastam mais.');
// So long, in minutes and seconds.
export const flightTime = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds)), minutes = Math.floor(whole / 60);
  return minutes ? `${minutes} min ${String(whole % 60).padStart(2, '0')} s` : `${whole} s`;
};

// A row may say itself what its suggestion does (workshop-checklist.ts, of a box no gun takes).
export function workshopContext(review: readonly ChecklistItem[], figures: readonly SummaryFigure[]) {
  const attention = review.filter(item => item.state === 'attention'), suggestion = attention[0] || null,
    adjust = suggestion?.target === 'adjust', actions: Record<string, string> = {
      chassis: tr('Ajustar chassi'), command: tr('Instalar comando'), vision: adjust ? tr('Liberar visão') : tr('Instalar câmera'), engine: tr('Instalar motor'),
      'running-gear': tr('Instalar rodagem'), fuel: tr('Instalar tanque'),
      armament: adjust ? tr('Aumentar caixa') : tr('Instalar munição'), flight: tr('Ver propulsor'),
    }, action = suggestion?.action || actions[suggestion?.id ?? ''] || '';
  return {
    suggestion, action, remaining: Math.max(0, attention.length - 1),
    // Over the project: what it weighs, its power and how far it goes.
    summary: figures.filter(figure => SUMMARY_FIGURES.includes(figure.label)),
  };
}
