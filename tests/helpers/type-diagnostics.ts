import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Compile one virtual fixture against the project's actual configuration and imported sources.
export function typeDiagnostics(file: string, source: string): ts.Diagnostic[] {
  const configFile = fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
    configuration = ts.readConfigFile(configFile, ts.sys.readFile);
  if (configuration.error) return [configuration.error];
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, dirname(configFile), undefined, configFile),
    configErrors = parsed.errors.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (configErrors.length) return configErrors;
  const fixture = resolve(file), host = ts.createCompilerHost(parsed.options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => resolve(name) === fixture
    ? ts.createSourceFile(name, source, version, true) : original(name, version, onError, fresh);
  const program = ts.createProgram([fixture], parsed.options, host);
  return ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
}
