export function surfaceEdges(indices: ArrayLike<number>): [number, number][] {
  const edges = new Map<string, [number, number]>();
  for (let i = 0; i < indices.length; i += 3)
    for (let j = 0; j < 3; j++) {
      const a = indices[i + j]!,
        b = indices[i + ((j + 1) % 3)]!,
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edges.has(key)) edges.delete(key);
      else edges.set(key, [a, b]);
    }
  return [...edges.values()];
}
