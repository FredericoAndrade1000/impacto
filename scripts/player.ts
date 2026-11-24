import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { record } from '../src/wire-shape.ts';
import { readPlayerRequest } from './player/contract.ts';
import { callPlayer, servePlayer } from './player/transport.ts';
import { PlayerSession } from './player/session.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

const { positionals, values: args } = parseArgs({ allowPositionals: true, options: {
  session: { type: 'string' }, server: { type: 'string' }, name: { type: 'string' }, 'key-file': { type: 'string' },
  speed: { type: 'string' }, file: { type: 'string' }, id: { type: 'string' }, actor: { type: 'string' }, model: { type: 'string' },
  after: { type: 'string' }, kinds: { type: 'string' }, 'wall-seconds': { type: 'string' }, 'sim-seconds': { type: 'string' },
  goal: { type: 'string' }, notes: { type: 'string' }, factor: { type: 'string' }, reason: { type: 'string' },
  blueprint: { type: 'boolean' }, help: { type: 'boolean' },
} });
const usage = `Persistent normal-player bridge
  npm run player -- start --session <directory> --server <origin> [--name <name>] [--key-file <private JSON>] [--speed 8]
  npm run player -- observe --session <directory>
  npm run player -- inspect --session <directory> --actor <id> [--blueprint]
  npm run player -- quote --session <directory> --model <template-id>
  npm run player -- wait --session <directory> --after <cursor> [--kinds contact,stalled,command] [--sim-seconds 30] [--wall-seconds 45]
  npm run player -- plan --session <directory> --goal <goal> [--notes <notes>]
  npm run player -- send --session <directory> --file <request.json or -> [--id <stable-request-id>]
  npm run player -- speed --session <directory> --factor <8|4|2|1> --reason <reason>
  npm run player -- stop --session <directory>
The daemon keeps the game connection between tool calls. Stop is a real player disconnect.
`;
async function main() {
  if (args.help || !positionals.length) { process.stdout.write(usage); return; }
  const op = positionals[0];
  if (!args.session || positionals.length !== 1) throw new Error('Choose one operation and --session <directory>.');
  const directory = resolve(args.session);
  if (op === 'start') {
    if (!args.server) throw new Error('start requires --server <origin>.');
    const origin = new URL(args.server);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Use a public HTTP(S) game origin without credentials.');
    const speed = Number(args.speed ?? 8);
    if (speed !== 1 && speed !== 2 && speed !== 4 && speed !== 8) throw new Error('Invalid initial speed.');
    if (existsSync(join(directory, 'field.json')) || existsSync(join(directory, 'test-server.json')))
      throw new Error('Use a player session directory separate from field saves.');
    mkdirSync(directory, { recursive: true });
    let key = '';
    if (args['key-file']) {
      const value: unknown = JSON.parse(readFileSync(resolve(args['key-file']), 'utf8'));
      if (!record(value) || typeof value.key !== 'string' || !value.key) throw new Error('Key file must contain a nonempty key.');
      key = value.key;
    } else if (existsSync(join(directory, 'seat.json'))) {
      const value: unknown = JSON.parse(readFileSync(join(directory, 'seat.json'), 'utf8'));
      if (!record(value) || value.origin !== origin.origin || typeof value.key !== 'string') throw new Error('Saved seat belongs to another origin or is invalid.');
      key = value.key;
    }
    await initNativeDynamics();
    const session = new PlayerSession({ origin: new URL(origin.origin), directory, key, name: args.name ?? (key ? null : 'Jogador de ferramentas'), speed });
    let bridge: Awaited<ReturnType<typeof servePlayer>> | null = null;
    try { bridge = await servePlayer(session); await session.connect(); }
    catch (error) { session.close(); await bridge?.close(); throw error; }
    process.stdout.write(JSON.stringify({ started: true, directory, server: origin.origin, playerId: session.client.playerId, factor: session.client.testSpeed }) + '\n');
    const close = () => { void bridge?.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    return;
  }
  let value: unknown;
  switch (op) {
    case 'observe': case 'stop': value = { op }; break;
    case 'inspect': value = { op, actorId: args.actor, ...(args.blueprint ? { blueprint: true } : {}) }; break;
    case 'quote': value = { op, design: { model: args.model } }; break;
    case 'wait': value = { op, after: args.after, ...(args.kinds ? { kinds: args.kinds.split(',') } : {}),
      ...(args['wall-seconds'] ? { wallSeconds: Number(args['wall-seconds']) } : {}),
      ...(args['sim-seconds'] ? { simSeconds: Number(args['sim-seconds']) } : {}) }; break;
    case 'plan': value = { op, goal: args.goal, ...(args.notes ? { notes: args.notes } : {}) }; break;
    case 'speed': value = { op, factor: Number(args.factor), reason: args.reason }; break;
    case 'send':
      if (!args.file) throw new Error('send requires --file request.json or --file - for stdin.');
      value = JSON.parse(readFileSync(args.file === '-' ? 0 : resolve(args.file), 'utf8')); break;
    default: throw new Error('Unknown player operation. Use --help.');
  }
  const answer = await callPlayer(directory, readPlayerRequest(value), args.id);
  process.stdout.write(JSON.stringify(answer) + '\n'); if (!answer.ok) process.exitCode = 1;
}
try { await main(); } catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
