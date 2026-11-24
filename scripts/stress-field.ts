// Serves the game with the stress field instead of its own: npm run stress [-- port [factions]].
// Twenty factions of twelve heavy vehicles fight five battles with their 20 mm (server/stress-field.ts);
// a page that comes in is seated in one of them and looks on. A number of factions may be given for a
// smaller field: 4 is one battle.
import { createServer } from 'vite';

const port = Number(process.argv[2]) || 8151;
process.env.IMPACTO_STRESS = String(Number(process.argv[3]) || 20);
const server = await createServer({ server: { port, strictPort: true } });
await server.listen();
server.printUrls();
