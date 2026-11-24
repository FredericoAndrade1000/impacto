import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Dependency = { name: string; version: string; license: string };
const root = new URL('../', import.meta.url);
const npm = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8')) as {
  packages: Record<string, Omit<Dependency, 'name'> & { name?: string }>;
};
const cargoArgs = ['metadata', '--locked', '--all-features', '--format-version', '1', '--manifest-path', 'native/dynamics/Cargo.toml'];
const cargo = JSON.parse(execFileSync('cargo', cargoArgs, { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as {
  packages: (Dependency & { source: string | null })[];
};
const npmDeps = Object.entries(npm.packages).filter(([path]) => path).map(([path, info]) => ({ ...info, name: info.name ?? path.split('node_modules/').at(-1)! }));
const cargoDeps = cargo.packages.filter(pkg => pkg.source);

function inventory(title: string, items: Dependency[]): string {
  const rows = [...new Map(items.map(pkg => [pkg.name + '@' + pkg.version, pkg])).values()];
  for (const { name, version, license } of rows) if (!license) throw new Error(`Licença ausente para ${name}@${version}`);
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
  return [`## ${title}`, '', '| Pacote | Versão | Licença declarada |', '| --- | --- | --- |',
    ...rows.map(({ name, version, license }) => `| \`${name}\` | ${version} | \`${license}\` |`)].join('\n');
}

const text = [
  '# Componentes de terceiros',
  'Inventário gerado por `npm run licenses` a partir do lockfile npm e dos manifestos Cargo das versões travadas. Inclui ferramentas e dependências opcionais dos dois lockfiles.',
  'Cada componente conserva sua própria licença e os avisos do pacote original. Ao distribuir binários Web, Wasm, Native ou imagens OCI, acompanhe-os dos avisos aplicáveis, incluindo os textos e atribuições fornecidos pelos componentes. Distribuições de arquivos cobertos pela MPL-2.0 devem indicar onde obter o código-fonte coberto. Ferramentas externas de build e imagens base têm licenças próprias.',
  'Consulte [LICENSE-ASSETS.md](LICENSE-ASSETS.md) para os recursos gráficos e sonoros.',
  inventory(`npm (${npmDeps.length} entradas no lockfile)`, npmDeps),
  inventory(`Cargo (${cargoDeps.length} crates externas)`, cargoDeps),
].join('\n\n') + '\n';
writeFileSync(new URL('THIRD_PARTY_NOTICES.md', root), text);
