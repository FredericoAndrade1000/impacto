export type Guard<Value> = (value: unknown) => value is Value;
export type Checked<Check> = Check extends Guard<infer Value> ? Value : never;
export interface Optional<Value> { readonly test: Guard<Value> }
type Checks = Readonly<Record<string, Guard<unknown> | Optional<unknown>>>;
type ObjectValue<Schema extends Checks> = {
  [Key in keyof Schema as Schema[Key] extends Guard<unknown> ? Key : never]: Checked<Schema[Key]>
} & {
  [Key in keyof Schema as Schema[Key] extends Optional<unknown> ? Key : never]?: Schema[Key] extends Optional<infer Value> ? Value : never
};
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const numeric: Guard<number> = (value): value is number => typeof value === 'number' && Number.isFinite(value);
export const textual: Guard<string> = (value): value is string => typeof value === 'string';
export const logical: Guard<boolean> = (value): value is boolean => typeof value === 'boolean';
export const undefinedValue: Guard<undefined> = (value): value is undefined => value === undefined;
export const unknownValue: Guard<unknown> = (_value): _value is unknown => true;
export const absent: Guard<never> = (_value): _value is never => false;
export const literal = <const Value extends string | number | boolean | null>(value: Value): Guard<Value> =>
  (input): input is Value => input === value;
export const optional = <Value>(test: Guard<Value>): Optional<Value> => ({ test });
export const array = <Value>(test: Guard<Value>): Guard<Value[]> => (value): value is Value[] => {
  if (!Array.isArray(value)) return false; const items: readonly unknown[] = value; return items.every(test);
};
export const union = <const Members extends readonly Guard<unknown>[]>(...members: Members): Guard<Checked<Members[number]>> =>
  (value): value is Checked<Members[number]> => members.some(member => member(value));
export const tuple = <const Members extends readonly Guard<unknown>[]>(...members: Members): Guard<{ -readonly [Key in keyof Members]: Checked<Members[Key]> }> =>
  (value): value is { -readonly [Key in keyof Members]: Checked<Members[Key]> } => Array.isArray(value) && value.length === members.length && members.every((check, index) => check(value[index]));
export const object = <const Schema extends Checks>(schema: Schema): Guard<ObjectValue<Schema>> => (value): value is ObjectValue<Schema> => {
  if (!record(value)) return false;
  for (const key in schema) {
    const check = schema[key];
    if (typeof check === 'function') { if (!check(value[key])) return false; }
    else if (check && Object.hasOwn(value, key) && !check.test(value[key])) return false;
  }
  return true;
};
export const dictionaryOf = <Value>(test: Guard<Value>): Guard<Record<string, Value>> =>
  (value): value is Record<string, Value> => record(value) && Object.values(value).every(test);
export const prefixed = <const Prefix extends string>(prefix: Prefix): Guard<`${Prefix}${string}`> =>
  (value): value is `${Prefix}${string}` => typeof value === 'string' && value.startsWith(prefix);
