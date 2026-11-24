import { stripTypeScriptTypes } from 'node:module';

// The Node and Vite entry points use explicit extensions. Declarations describe
// modules but are not executable dependencies of the field or the page.
export const scriptFile = (file: string): boolean => /\.[cm]?[jt]s$/i.test(file);
export const runtimeModule = (file: string): boolean => scriptFile(file) && !/\.d\.[cm]?ts$/i.test(file);
const TYPESCRIPT = /\.[cm]?ts$/i;
const IMPORTS = /(?:from\s*|import\s*\(\s*|import\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const URLS = /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g;

// Use the same type erasure as Node before following imports: `import type`
// disappears, while `import { type T }` retains its module's side effects.
// The existing relative-import scanner serves both the graph and fingerprints;
// only the fingerprint also follows assets and worker URLs.
export function moduleReferences(file: string, source: string, { urls = false }: { urls?: boolean } = {}): string[] {
  const executable = TYPESCRIPT.test(file) ? stripTypeScriptTypes(source) : source, references: string[] = [];
  for (const pattern of urls ? [IMPORTS, URLS] : [IMPORTS]) for (const match of executable.matchAll(pattern)) {
    const ref = match[1];
    if (ref?.startsWith('.')) references.push(ref);
  }
  return references;
}
