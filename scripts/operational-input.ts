// Operational JSON stays unknown until the tool which owns its format validates it.
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const parseJSON = (text: string): unknown => JSON.parse(text);
export function cloneJSON(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Value cannot be serialized as JSON.');
  return parseJSON(text);
}
export const errorText = (error: unknown): string => error instanceof Error ? error.stack || error.message : String(error);
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const errorCode = (error: unknown): unknown => record(error) ? error.code : undefined;
export function expectRecord(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new TypeError('Expected an operational object.');
  return value;
}
export function expectArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Expected an operational array.');
  return value;
}
export function expectString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected operational text.');
  return value;
}
export function expectNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected a finite operational number.');
  return value;
}
// Archived checkouts own their APIs. Only callable members and object results are admitted here;
// their Room/World are never asserted to be the current game's classes.
export function invoke(target: unknown, member: string, ...args: unknown[]): unknown {
  const object = expectRecord(target), method = object[member];
  if (typeof method !== 'function') throw new TypeError(`Operational method missing: ${member}`);
  const result: unknown = Reflect.apply(method, object, args);
  return result;
}
export function construct(constructor: unknown, ...args: unknown[]): Record<string, unknown> {
  if (typeof constructor !== 'function') throw new TypeError('Operational constructor missing.');
  const result: unknown = Reflect.construct(constructor, args);
  return expectRecord(result);
}
export function stringFlags(args: readonly string[]): Record<string, string> {
  return Object.fromEntries(args.map(value => {
    const [name = '', ...rest] = value.replace(/^--/, '').split('=');
    return [name, rest.join('=')];
  }));
}
