import { tr } from './i18n.ts';
import { stockFigures } from './faction-ui.ts';
import { compactNumber } from './format.ts';
import type { FieldPanelView } from './field-panel.ts';
import type { FactionView } from './faction-ui.ts';

export interface SelectionActivity { trouble?: boolean; alert?: boolean; doing?: string }
export interface FieldNavigationOptions {
  shared?: boolean; panel?: Partial<Pick<FieldPanelView, 'squad' | 'situation' | 'release' | 'control' | 'weapon' | 'services' | 'armed'>>;
  faction?: Pick<FactionView, 'stock'> | null | undefined; touch?: boolean; driven?: boolean; flies?: boolean; testTools?: boolean;
}

export const FIELD_TASKS = Object.freeze([
  { id: 'faction' },
  { id: 'infra' },
  { id: 'test' },
] as const);
export const compactStock = (value: number | null | undefined): string => compactNumber(Math.max(0, value || 0));

// What several constructions picked together are up to, in a line: how many need attention, wait for orders or are at work.
export function selectionText(selected: readonly SelectionActivity[]): string {
  let attention = 0, idle = 0;
  for (const unit of selected) {
    if (unit.trouble || unit.alert || unit.doing === 'halted') attention++;
    else if (!unit.doing) idle++;
  }
  const active = selected.length - attention - idle;
  return [attention && tr`${attention} ${attention === 1 ? 'precisa' : 'precisam'} de atenção`,
    idle && tr`${idle} aguardando ordens`, active && tr`${active} em atividade`].filter(Boolean).join(' · ');
}

// Presentation only: the panel already resolved ownership, abilities and services. A test of the design is not on
// the field (`shared` false): its dock has no heading, as its name is in the row at the top. `touch`, that the player
// drives with the buttons over the field, which need no words; `driven`, that the design in hand is driven at all,
// which it is not under a test of armour: there it is struck along lines the player draws; `flies`, that it flies, with
// W and S as well (ui-model.ts `driveIntent`).
export function fieldNavigation({ shared = false, panel = {}, faction = null, touch = false, driven = true, flies = false, testTools = false }: FieldNavigationOptions = {}) {
  const units = panel.squad?.units || [], selected = units.filter(unit => unit.selected && !unit.defeated),
    manual = units.find(unit => unit.manual && !unit.defeated), one = manual || (selected.length === 1 ? selected[0] : null),
    mobile = one?.mobile !== false;
  return {
    tasks: FIELD_TASKS.filter(task => task.id === 'test' ? testTools : shared),
    mode: !shared ? '' : panel.situation === 'offline' ? tr('SEM CONEXÃO') : manual ? mobile ? tr('CONDUZINDO') : tr('OPERANDO') : tr('COMANDANDO'),
    title: !shared ? '' : one?.name || (selected.length ? tr`${selected.length} construções selecionadas` : tr('Sua frota')),
    selectedCount: selected.length, one, release: Boolean(panel.release), control: Boolean(panel.control),
    mobile, controlLabel: mobile ? tr('Conduzir') : tr('Operar'),
    controlsHint: mobile ? touch ? '' : !driven ? tr('Arraste para atirar') : flies ? tr('W/S sobem e descem · A/D vão para os lados · F dispara') : tr('A/D conduzem · S freia · F dispara') :
      panel.weapon ? tr('Mire no campo e use Fogo para disparar. No PC, F também dispara. Comandar libera o controle.') : tr('Esta construção é fixa. Use Comandar para liberar o controle.'),
    vehicleEmpty: shared && !one,
    stocks: faction ? stockFigures(faction.stock) : [],
    armed: panel.armed || '',
    dock: !shared || Boolean(one || selected.length || panel.armed),
    details: !shared || Boolean(one),
    detailsLabel: !shared ? tr('Ajustar teste') : manual && panel.weapon ? tr('Armamento') : tr('Condição'),
    services: Boolean(one && panel.services?.some(work => !work.disabled)),
    // The dock tells the resolved condition/activity. A passive service refusal belongs on the condition page;
    // real trouble stays ahead of the short refill/safety receipt, which remains visible while all is well.
    status: (one?.trouble || one?.alert || one?.doing === 'halted' ? one?.status : '') ||
      one?.feedback?.text || one?.status ||
      (selected.length > 1 ? [panel.squad?.note, selectionText(selected)].filter(Boolean).join(' · ') : '') || '',
  };
}
