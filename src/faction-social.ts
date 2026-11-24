import { tr } from './i18n.ts';
import type { SupplyBill } from './economy-contract.ts';
import { bill, STOCK_IDS } from './economy.ts';

// Shared bounds for the forms, the authoritative room and its recent conversation on the page.
export const SOCIAL_LIMITS = Object.freeze({ offers: 10, accords: 10, text: 500, history: 50, chatSteps: 120 });
export const ALLIANCE_TERMS = tr('Compartilhamos visão atual, contatos de radar e som com sua precisão e idade, e terreno descoberto, inclusive para mira e piloto automático. ')
  + tr('O piloto deixa de escolher aliados automaticamente. Encerrar interrompe novas informações; o terreno descoberto permanece. ')
  + tr('Estoques, projetos e controle continuam exclusivos. Tiros e explosões poupam aliados; o próprio atirador ainda pode sofrer dano.');

export function socialText(value: unknown): string {
  if (typeof value !== 'string' || value.length > SOCIAL_LIMITS.text) throw new Error(tr`Use até ${SOCIAL_LIMITS.text} caracteres.`);
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text) throw new Error(tr('Escreva o texto primeiro.'));
  return text;
}

// Trades carry whole amounts of the four refined stocks; omitted stocks mean zero.
export function tradeBill(value: unknown): SupplyBill {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(id => !STOCK_IDS.some(stock => stock === id)))
    throw new Error(tr('Recursos da oferta inválidos.'));
  const amounts: unknown[] = STOCK_IDS.map((id): unknown => Object.hasOwn(value, id) ? Reflect.get(value, id) : 0);
  if (amounts.some(amount => typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)) throw new Error(tr('Use quantidades inteiras de recursos, a partir de zero.'));
  const [ferro, ligas, silica, combustivel] = amounts;
  if (typeof ferro !== 'number' || typeof ligas !== 'number' || typeof silica !== 'number' || typeof combustivel !== 'number') throw new Error(tr('Recursos da oferta inválidos.'));
  return bill(ferro, ligas, silica, combustivel);
}
