// Freeze an owned JSON record once; already frozen projections can be shared safely.
export function freezeRecord<const T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeRecord(item);
    Object.freeze(value);
  }
  return value;
}
