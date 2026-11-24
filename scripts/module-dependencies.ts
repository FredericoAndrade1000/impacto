import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { moduleReferences, runtimeModule } from './source-modules.ts';

// Relative executable imports/re-exports. Runtime-selected hosts, workers and asset URLs
// remain explicit entry points; this graph is not proof that an unreferenced file is unused.
export function moduleDependencies(root: string, files: readonly string[]): { imports: Record<string, string[]>; cycles: [string, ...string[]][] } {
  const known = new Set(files.filter(file => runtimeModule(file) && !file.startsWith('src/native/'))), graph = new Map<string, string[]>();
  for (const file of [...known].sort()) {
    const source = readFileSync(join(root, file), 'utf8'), imports = moduleReferences(file, source)
      .map(ref => posix.normalize(posix.join(posix.dirname(file), ref))).filter(ref => known.has(ref));
    graph.set(file, [...new Set(imports)].sort());
  }
  let next = 0;
  const visited = new Map<string, { index: number; low: number }>(), stack: string[] = [], active = new Set<string>(), cycles: [string, ...string[]][] = [];
  function visit(file: string): { index: number; low: number } {
    const node = { index: next, low: next++ }, imports = graph.get(file);
    if (!imports) throw new Error(`Module absent from dependency graph: ${file}`);
    visited.set(file, node); stack.push(file); active.add(file);
    for (const other of imports) {
      const seen = visited.get(other);
      if (!seen) node.low = Math.min(node.low, visit(other).low);
      else if (active.has(other)) node.low = Math.min(node.low, seen.index);
    }
    if (node.low !== node.index) return node;
    const group: [string, ...string[]] = [file];
    while (true) {
      const other = stack.pop();
      if (other === undefined) throw new Error(`Incomplete dependency graph stack at ${file}`);
      active.delete(other);
      if (other === file) break;
      group.push(other);
    }
    if (group.length > 1 || imports.includes(file)) cycles.push(group.sort());
    return node;
  }
  for (const file of graph.keys()) if (!visited.has(file)) visit(file);
  return { imports: Object.fromEntries(graph), cycles: cycles.sort((a, b) => a[0].localeCompare(b[0])) };
}
