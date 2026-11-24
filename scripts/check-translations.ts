import ts from 'typescript';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGLISH } from '../src/locales/en.ts';
import { SPANISH } from '../src/locales/es.ts';
import { SourcePhrases } from './source-phrases.ts';

export interface TranslationIssue { file: string; line: number; text: string }
export interface TranslationReport { issues: TranslationIssue[]; calls: number; cataloguePhrases: number; htmlPhrases: number }
interface Catalogue { file: string; name: string; paths: readonly (readonly string[])[] }
// This describes authored labels, not call sites or permitted unknown strings.
// Every value in each field must be translated, including unused choices.
const fields = (...names: string[]) => names.map(name => ['*', name]);
export const TRANSLATION_CATALOGUES: readonly Catalogue[] = [
  { file: 'materials.ts', name: 'MATERIALS', paths: fields('name', 'short') },
  { file: 'materials.ts', name: 'METALS', paths: fields('name', 'short', 'tag') },
  { file: 'materials.ts', name: 'MODULES', paths: fields('name', 'description') },
  ...['MATERIAL_NOTES', 'MATERIAL_TAGS'].map(name => ({ file: 'materials.ts', name, paths: [['*']] })),
  ...['WEAPONS', 'WEAPON_PRESETS'].map(name => ({ file: 'weapons.ts', name, paths: fields('name', 'label') })),
  { file: 'weapons.ts', name: 'AMMO', paths: fields('name', 'short', 'detail') },
  { file: 'weapons.ts', name: 'WEAPON_FAMILIES', paths: [['*', '1']] },
  ...['MORTAR_CHARGES', 'HOWITZER_CHARGES', 'MACS_CHARGES', 'FIXED_CHARGE'].map(name => ({ file: 'weapons.ts', name, paths: fields('name') })),
  { file: 'combat-sensors.ts', name: 'SENSOR_MODES', paths: fields('name') },
  { file: 'weapon-mounts.ts', name: 'WEAPON_MOUNTS', paths: fields('name') },
  ...['STOCKS', 'RAW'].map(name => ({ file: 'economy.ts', name, paths: [['*']] })),
  { file: 'squad.ts', name: 'STANCES', paths: fields('name', 'help') },
  ...['FUEL_REFUSED', 'FUEL_REFUSED_ALL'].map(name => ({ file: 'squad.ts', name, paths: [['*']] })),
  { file: 'industry.ts', name: 'INDUSTRY_UPGRADES', paths: fields('name', 'description') },
  { file: 'industry.ts', name: 'FACILITIES', paths: [['*']] },
  { file: 'chassis.ts', name: 'KIND_LABELS', paths: fields('name', 'label') },
  ...['CONSTRUCTION_TEMPLATES', 'FIXTURE_TEMPLATES'].map(name => ({ file: 'construction-template-catalogue.ts', name, paths: fields('name') })),
  { file: 'territory.ts', name: 'POST_NAME', paths: [[]] },
  { file: 'field-panel.ts', name: 'HOMING', paths: [['*']] },
  { file: 'detail-gestures.ts', name: 'DETAIL_GROUPS', paths: fields('name') },
  { file: 'vehicle-details.ts', name: 'VEHICLE_DETAILS', paths: fields('name') },
];
const sourceFiles = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? entry.name === 'native' ? [] : sourceFiles(join(folder, entry.name)) : /\.(?:js|ts)$/.test(entry.name) ? [join(folder, entry.name)] : []);
const slots = (text: string): number[] => [...text.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1])).sort((a, b) => a - b);
type Dictionaries = Readonly<Record<'en' | 'es', Readonly<Record<string, string>>>>;
const languages = { en: 'English', es: 'Spanish' } as const;

export function checkTranslations(root: string, extraFiles: readonly string[] = [], dictionaries: Dictionaries = { en: ENGLISH, es: SPANISH }): TranslationReport {
  const locales = (['en', 'es'] as const).map(code => ({ code, language: languages[code], dictionary: dictionaries[code] }));
  const paths = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'server')), ...extraFiles],
    program = ts.createProgram(paths, { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }),
    checker = program.getTypeChecker(), phrases = new SourcePhrases(checker, program.getSourceFiles().filter(file => paths.some(path => resolve(path) === resolve(file.fileName)))), report: TranslationReport = { issues: [], calls: 0, cataloguePhrases: 0, htmlPhrases: 0 };
  const issue = (node: ts.Node, text: string) => report.issues.push({ file: relative(root, node.getSourceFile().fileName).replaceAll('\\', '/'), line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  const requireKey = (key: string, node: ts.Node, arity?: number): void => {
    for (const { language, dictionary } of locales) if (!Object.hasOwn(dictionary, key)) issue(node, `Missing ${language} phrase: ${JSON.stringify(key)}`);
    const indices = slots(key), count = indices.length ? Math.max(...indices) + 1 : 0;
    if (count > 20 || Array.from({ length: count }, (_, i) => i).some(index => !indices.includes(index))) issue(node, `Phrase has noncontiguous or excessive slots: ${JSON.stringify(key)}`);
    if (arity !== undefined && arity !== count) issue(node, `Expected ${count} values, received ${arity}: ${JSON.stringify(key)}`);
  };
  const keys = new Set(locales.flatMap(({ dictionary }) => Object.keys(dictionary)));
  for (const { code, language, dictionary } of locales) for (const key of keys) {
    const file = `src/locales/${code}.ts`, value = dictionary[key], catalogueIssue = (description: string) => report.issues.push({ file, line: 1, text: `${description}: ${JSON.stringify(key)}` });
    if (!Object.hasOwn(dictionary, key) || value === undefined) { catalogueIssue(`Missing ${language} phrase`); continue; }
    if (key.trim() && !value.trim()) catalogueIssue(`Empty ${language} phrase`);
    if (slots(key).join(',') !== slots(value).join(',')) catalogueIssue('Translation changes positional values');
    const indices = slots(key), count = indices.length ? Math.max(...indices) + 1 : 0;
    if (count > 20 || Array.from({ length: count }, (_, i) => i).some(index => !indices.includes(index))) catalogueIssue('Catalogue phrase has invalid slots');
  }
  const factory = (node: ts.Node) => phrases.factory(node);
  for (const file of program.getSourceFiles()) {
    if (!paths.some(path => resolve(path) === resolve(file.fileName))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && ['tr', 'phrase', 'userError'].includes(factory(node.tag) ?? '')) {
        report.calls++;
        const template = node.template, key = ts.isNoSubstitutionTemplateLiteral(template) ? template.text : template.head.text + template.templateSpans.map((span, i) => `{${i}}${span.literal.text}`).join('');
        requireKey(key, node, ts.isNoSubstitutionTemplateLiteral(template) ? 0 : template.templateSpans.length);
      }
      if (ts.isCallExpression(node) && ['tr', 'phrase', 'userError'].includes(factory(node.expression) ?? '')) {
        report.calls++;
        const source = node.arguments[0];
        if (!source) issue(node, 'Message requires a source phrase.');
        else {
          const existing = factory(node.expression) === 'userError' ? phrases.authored(source) : null,
            structured = existing && !existing.unknown && existing.keys.size > 0;
          if (!structured) {
            const found = phrases.resolve(source), nullable = factory(node.expression) === 'tr' && (source.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(source) && source.text === 'undefined');
            if (found.unknown || !found.keys.size && !nullable) issue(source, `Unresolved phrase source: ${source.getText().slice(0, 150)}. Use a literal or an immutable catalogue label.`);
            else for (const key of found.keys) requireKey(key, source, node.arguments.length - 1);
            if (node.arguments.slice(1).some(ts.isSpreadElement)) issue(node, 'Message values must be explicit; an unbounded spread cannot prove the phrase arity.');
          } else {
            for (const key of existing.keys) requireKey(key, source);
            if (node.arguments.length !== 1) issue(node, 'An existing structured message cannot receive additional values.');
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (const catalogue of TRANSLATION_CATALOGUES) {
    const file = program.getSourceFile(join(root, 'src', catalogue.file));
    if (!file) {
      report.issues.push({ file: `src/${catalogue.file}`, line: 1, text: `Catalogue source missing: ${catalogue.name}` });
      continue;
    }
    let identifier: ts.Identifier | undefined;
    const find = (node: ts.Node): void => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === catalogue.name) identifier = node.name; else ts.forEachChild(node, find); };
    find(file);
    if (!identifier) { issue(file, `Catalogue declaration missing: ${catalogue.name}`); continue; }
    for (const path of catalogue.paths) {
      const found = phrases.resolve(identifier, path);
      if (found.unknown || !found.keys.size) issue(identifier, `Catalogue is not finite: ${catalogue.name}.${path.join('.')}`);
      for (const key of found.keys) { requireKey(key, identifier); report.cataloguePhrases++; }
    }
  }
  for (const file of ['index.html', 'replay.html']) if (existsSync(join(root, file))) checkHTML(root, locales, report, file);
  return report;
}

function checkHTML(root: string, locales: readonly { language: string; dictionary: Readonly<Record<string, string>> }[], report: TranslationReport, file: string): void {
  const html = readFileSync(join(root, file), 'utf8'), stack: string[] = [], skip = new Set(['script', 'style', 'svg', 'code', 'textarea']);
  const decode = (text: string) => text.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (_, decimal: string, hex: string, named: string) => decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[named] ?? ''));
  const requireKey = (key: string, offset: number) => {
    // Punctuation, keyboard keys and the licence input's sample format have no
    // language. Prose and accessibility labels still require a catalogue entry.
    if (!key || !/\p{L}/u.test(key) || /^F\d{1,2}$/.test(key) || /^(?:X{4}-)+X{4}$/.test(key)) return;
    report.htmlPhrases++;
    for (const { language, dictionary } of locales) if (!Object.hasOwn(dictionary, key)) report.issues.push({ file, line: html.slice(0, offset).split('\n').length, text: `Missing ${language} HTML phrase: ${JSON.stringify(key)}` });
  };
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+/g)) {
    const text = token[0]; if (text.startsWith('<!--')) continue;
    if (!text.startsWith('<')) { if (!stack.some(tag => skip.has(tag))) requireKey(decode(text.trim().replace(/\s+/g, ' ')), token.index); continue; }
    const tag = /^<\/?([a-z][\w-]*)/i.exec(text)?.[1]?.toLowerCase(); if (!tag) continue;
    for (const attr of text.matchAll(/\b(?:title|aria-label|placeholder)\s*=\s*(["'])([\s\S]*?)\1/g)) requireKey(decode(attr[2] ?? ''), token.index);
    if (text.startsWith('</')) { const position = stack.lastIndexOf(tag); if (position >= 0) stack.splice(position); }
    else if (!/\/$/.test(text.slice(0, -1)) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) stack.push(tag);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkTranslations(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  for (const issue of report.issues) console.error(`${issue.file}:${issue.line}: ${issue.text}`);
  if (report.issues.length) process.exitCode = 1;
  else console.log(`English and Spanish checked: ${Object.keys(ENGLISH).length} phrases, ${report.calls} message authors, ${report.cataloguePhrases} catalogue labels, ${report.htmlPhrases} HTML phrases.`);
}
