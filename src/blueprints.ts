let nextId = 1;
export const makeId = (prefix: string) => prefix + '-' + (globalThis.crypto?.randomUUID?.() ||
  Date.now().toString(36) + '-' + nextId++);
