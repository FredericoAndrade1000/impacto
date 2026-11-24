import type { ENGLISH } from './locales/en.ts';

export type MessageKey = keyof typeof ENGLISH;
export type MessageValue = string | number | boolean | null | WireMessage;
// The wire keeps the canonical Portuguese phrase, including messages from older builds.
export interface WireMessage {
  readonly key: string;
  readonly values: readonly MessageValue[];
}
export type Message<K extends MessageKey = MessageKey> = WireMessage & { readonly key: K };
export const MESSAGE_VALUE_LIMIT = 20;
type Slots<S extends string> = S extends `${string}{${infer Index extends number}}${infer Rest}` ? Index | Slots<Rest> : never;
export type MessageArguments<K extends MessageKey, Values extends MessageValue[] = []> =
  Values['length'] extends typeof MESSAGE_VALUE_LIMIT ? Values : Values['length'] extends Slots<K> ? MessageArguments<K, [...Values, MessageValue]> : Values;
export type MessageSource = MessageKey | TemplateStringsArray;

// Internal construction shared by the translated phrase and error factories.
// Literal call sites are checked by TypeScript; tagged templates by check-translations.
export function composeMessage(source: MessageSource, values: readonly MessageValue[]): WireMessage {
  const key = typeof source === 'string' ? source : source.reduce((key, part, index) => key + (index ? `{${index - 1}}` : '') + part, '');
  return { key, values };
}

export function isWireMessage(value: unknown, depth = 0): value is WireMessage {
  if (depth >= 4 || !value || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string' || value.key.length > 4096 ||
      !('values' in value) || !Array.isArray(value.values) || value.values.length > MESSAGE_VALUE_LIMIT) return false;
  return value.values.every((item: unknown) => item === null || typeof item === 'string' && item.length <= 4096 ||
    typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean' || isWireMessage(item, depth + 1));
}
