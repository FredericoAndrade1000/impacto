import { World } from '../../src/physics.ts';
import { createStructuredTemplate } from '../../src/structured-templates.ts';
import { decodeScriptedDecision } from '../../src/scripted-contract.ts';
import type { PilotContact, PilotControls, PilotDiagnostics, ScriptedDecision } from '../../src/scripted-contract.ts';

let base: ScriptedDecision | undefined;
function decision(): ScriptedDecision {
  if (!base) {
    const world = new World(createStructuredTemplate('scout'));
    try {
      base = decodeScriptedDecision(world.game().call({ op: 'scriptedDecision', actorId: 'local',
        arenaBounds: { minX: -1000, maxX: 1000 } }));
    } finally { world.dispose(); }
  }
  return base;
}

interface DecisionOverrides {
  targetId?: string | null;
  action?: Partial<PilotControls>;
  contact?: Partial<PilotContact> | null;
  diagnostics?: Partial<PilotDiagnostics>;
}

// Keep the real Native envelope, changing only what the scenario observes.
// No field, publication or simulation steps are needed to obtain this record.
export function pilotDecision(overrides: DecisionOverrides = {}): ScriptedDecision {
  const source = structuredClone(decision());
  return { ...source, ...overrides, action: { ...source.action, ...overrides.action },
    contact: { ...source.contact, ...overrides.contact }, diagnostics: { ...source.diagnostics, ...overrides.diagnostics } };
}
