// Rust test fixture; production template requests carry their catalogue from JavaScript.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { constructionCatalogue } from '../src/construction-admission.ts';
import { CONSTRUCTION_TEMPLATES, FIXTURE_TEMPLATES } from '../src/construction-template-catalogue.ts';
const catalogue={...constructionCatalogue(), templates:[...CONSTRUCTION_TEMPLATES,...FIXTURE_TEMPLATES].map(({id,name})=>({id,name}))};
const file=new URL('../native/construction-catalogue.json',import.meta.url), text=JSON.stringify(catalogue)+'\n';
const args=process.argv.slice(2);
if (args.some(arg=>arg!=='--check')) throw new Error('Use node scripts/export-construction-catalogue.ts [--check].');
if (!existsSync(file) || readFileSync(file,'utf8').replace(/\r\n/g,'\n') !== text) {
  if (args.includes('--check')) {
    console.error('Rust catalogue fixture is outdated. Run node scripts/export-construction-catalogue.ts before cargo test.');
    process.exitCode=1;
  } else {
    writeFileSync(file,text);
    console.log('Exported native/construction-catalogue.json');
  }
}
