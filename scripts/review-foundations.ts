import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { RAW_IDS } from '../src/economy.ts';

// Real initial foundations. Seeds vary base draws on one current terrain;
// geography alone does not qualify a route, driving or recovery after defeat.
export function foundationAccess() {
  const samples = [];
  for (const drawSeed of [7, 1234, 987654]) {
    let draw = drawSeed;
    const room = new SharedRoom({ starter: false, random: () => (draw = draw * 16807 % 2147483647) / 2147483647 });
    try {
      for (let joined = 1; joined <= 20; joined++) {
        const player = room.join(`Posição ${joined}`); assert(player.faction);
        const faction = room.factions.get(player.faction.id); assert(faction?.base);
        const base = faction.base;
        samples.push({ drawSeed, joined, baseX: base.x,
          resources: RAW_IDS.map(material => {
            const site = room.endow(base, material);
            return { material, nearest: site ? { metres: Math.round(Math.abs(site.x - base.x)),
              known: Boolean(room.known(faction, site)), reserve: site.reserve } : null };
          }) });
      }
    } finally { room.world.dispose(); }
  }
  return { scope: '60 initial foundations on one current map; three base-draw sequences, no driving, recovery, depletion or combat.', samples };
}

