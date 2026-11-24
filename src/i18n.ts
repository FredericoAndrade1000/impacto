import { ENGLISH } from './locales/en.ts';
import { SPANISH } from './locales/es.ts';
import { composeMessage } from './message-contract.ts';
import type { Message, MessageArguments, MessageKey, MessageSource, MessageValue, WireMessage } from './message-contract.ts';
export type { Message, MessageArguments, MessageKey, MessageValue, WireMessage } from './message-contract.ts';

const DICTIONARIES = { en: ENGLISH, es: SPANISH };
const LOCALES = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es-419' } as const;
export type Language = keyof typeof LOCALES;
export type LanguagePreference = Language | 'auto';
export interface LanguageStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface LanguageOptions { storage?: LanguageStorage | null; search?: string }
export const LANGUAGE_KEY = 'impacto.language';
export const LANGUAGE_CHOICES = Object.freeze(['auto', 'pt-BR', 'en', 'es'] as const satisfies readonly LanguagePreference[]);
export const isLanguagePreference = (value: unknown): value is LanguagePreference => LANGUAGE_CHOICES.some(choice => choice === value);
function browserStorage(): LanguageStorage | null {
  try {
    const storage: unknown = Reflect.get(globalThis, 'localStorage');
    if (!storage || typeof storage !== 'object') return null;
    const get: unknown = Reflect.get(storage, 'getItem'), set: unknown = Reflect.get(storage, 'setItem');
    if (typeof get !== 'function' || typeof set !== 'function') return null;
    return {
      getItem(key) { const value: unknown = Reflect.apply(get, storage, [key]); return typeof value === 'string' ? value : null; },
      setItem(key, value) { Reflect.apply(set, storage, [key, value]); },
    };
  } catch { return null; }
}

export function browserLanguage(languages: readonly string[] = []): Language {
  for (const language of languages) {
    if (/^pt(?:-|$)/i.test(language)) return 'pt-BR';
    if (/^en(?:-|$)/i.test(language)) return 'en';
    if (/^es(?:-|$)/i.test(language)) return 'es';
  }
  return 'en';
}
export function languagePreference({ storage = browserStorage(), search = '' }: LanguageOptions = {}): LanguagePreference {
  const asked = new URLSearchParams(search).get('lang');
  if (isLanguagePreference(asked)) return asked;
  try { const kept = storage?.getItem(LANGUAGE_KEY); if (isLanguagePreference(kept)) return kept; } catch {}
  return 'auto';
}
let preference: LanguagePreference = 'auto', selected: Language = 'pt-BR';
// Bootstrap configures before importing interfaces. Workers retain canonical Portuguese messages.
export function configureLanguage({ languages = [], ...options }: LanguageOptions & { languages?: readonly string[] } = {}): Language {
  preference = languagePreference(options);
  selected = preference === 'auto' ? browserLanguage(languages) : preference;
  return selected;
}
export const language = (): Language => selected;
export const preferredLanguage = (): LanguagePreference => preference;
export const locale = () => LOCALES[selected];

export function phrase<K extends MessageKey>(source: K, ...values: MessageArguments<K>): Message<K>;
export function phrase(source: TemplateStringsArray, ...values: MessageValue[]): WireMessage;
export function phrase(source: MessageSource, ...values: MessageValue[]): WireMessage { return composeMessage(source, values); }

// Raw strings belong to the boundary (HTML, catalogues and diagnostics), not to message authorship.
export function translate(message: WireMessage | string, target: Language = selected): string {
  const { key, values = [] } = typeof message === 'string' ? { key: message } : message;
  const dictionary: Readonly<Record<string, string>> | undefined = target === 'pt-BR' ? undefined : DICTIONARIES[target];
  const text = dictionary && Object.hasOwn(dictionary, key) ? dictionary[key]! : key;
  return text.replace(/\{(\d+)\}/g, (token: string, index: string) => {
    const position = Number(index);
    if (position >= values.length) return token;
    const value = values[position];
    return value && typeof value === 'object' ? translate(value, target) : String(value ?? '');
  });
}
export function phraseList(items: readonly MessageValue[], separator: string | WireMessage = ', '): WireMessage {
  if (typeof separator === 'string') return { key: items.map((_, index) => `{${index}}`).join(separator), values: items };
  return { key: items.map((_, index) => `{${index + 1}}`).join('{0}'), values: [separator, ...items] };
}
export function tr<K extends MessageKey>(source: K, ...values: MessageArguments<K>): string;
export function tr(source: TemplateStringsArray, ...values: MessageValue[]): string;
export function tr(source: null): null;
export function tr(source: undefined): undefined;
export function tr(source: MessageSource | null | undefined, ...values: MessageValue[]): string | null | undefined {
  return source == null ? source : translate(composeMessage(source, values));
}

export function languageURL(value: LanguagePreference, { url, storage = browserStorage() }: { url: string | URL; storage?: LanguageStorage | null }): string {
  if (!isLanguagePreference(value)) throw new Error('Idioma inválido.');
  const next = new URL(url);
  if (value === 'auto') next.searchParams.delete('lang'); else next.searchParams.set('lang', value);
  try { storage?.setItem(LANGUAGE_KEY, value); } catch {}
  return next.href;
}
