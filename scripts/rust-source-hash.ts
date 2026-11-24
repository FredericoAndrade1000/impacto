import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function rustSourceHash(directory: string): string {
  const files = ['Cargo.toml', 'Cargo.lock', 'build.rs'];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.name.endsWith('.rs')) files.push(name);
    }
  };
  visit('src');
  const hash = createHash('sha256');
  // Git may check the same source out with CRLF on Windows and LF elsewhere.
  // That changes no Rust code and must not make a matching build look stale.
  for (const file of files.sort()) hash.update(file).update('\0')
    .update(readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  return hash.digest('hex');
}
