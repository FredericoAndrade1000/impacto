import { translate } from './i18n.ts';
import { composeMessage, isWireMessage } from './message-contract.ts';
import type { MessageArguments, MessageKey, MessageSource, MessageValue, WireMessage } from './message-contract.ts';

export type UserError<K extends string = string> = Error & { userMessage: WireMessage & { readonly key: K } };
export function userError<K extends MessageKey>(source: K, ...values: MessageArguments<K>): UserError<K>;
export function userError(source: TemplateStringsArray, ...values: MessageValue[]): UserError;
export function userError(source: WireMessage): UserError;
export function userError(source: MessageSource | WireMessage, ...values: MessageValue[]): UserError {
  const userMessage = isWireMessage(source) ? source : composeMessage(source, values);
  return Object.assign(new Error(translate(userMessage, 'pt-BR')), { userMessage });
}
export const messageText = (message: unknown): string => isWireMessage(message) ? translate(message) : '';
export function errorText(reply: unknown): string {
  if (reply && typeof reply === 'object') {
    const message = 'userMessage' in reply ? messageText(reply.userMessage) : '';
    if (message) return message;
    if ('error' in reply && typeof reply.error === 'string') return translate(reply.error);
    if (reply instanceof Error && reply.message) return translate(reply.message);
  }
  return translate('Algo deu errado no campo. Tente de novo.');
}
