export const DEFAULT_SOURCE_URL = 'https://github.com/FredericoAndrade1000/impacto';

export function sourceURL(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1024 || !/^https:\/\//i.test(value)) return;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return url.href;
  } catch { return; }
}
