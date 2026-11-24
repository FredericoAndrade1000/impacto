import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileNetwork } from './mobile-network.ts';
import { networkCondition } from './mobile-profile.ts';
import { parseJSON, record, stringFlags } from './operational-input.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  args = stringFlags(process.argv.slice(2));
if (!args.target || Object.keys(args).some(name => !['target','port','profile'].includes(name)))
  throw new Error('Use --target=porta-do-servidor [--port=porta-do-proxy] [--profile=benchmarks/a15.json].');
const profile = parseJSON(readFileSync(resolve(root,args.profile || 'benchmarks/a15.json'), 'utf8'));
if (!record(profile)) throw new Error('Perfil de rede inválido.');
const network = networkCondition(profile.network), link = await mobileNetwork({ targetPort:Number(args.target),port:Number(args.port || 0),...network });
console.log(JSON.stringify({url:`http://127.0.0.1:${link.port}/`,targetPort:Number(args.target),network:profile.network,
  scope:'Local TCP network condition, including WebSockets; no CPU/GPU or hardware RAM bandwidth claim.'}));
let closing: Promise<never> | undefined;
const close = () => closing ||= link.close().then(() => { console.log(JSON.stringify(link.metrics)); process.exit(0); });
process.once('SIGINT',close);process.once('SIGTERM',close);
