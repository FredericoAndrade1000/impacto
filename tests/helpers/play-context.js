import { createPlayContext } from '../../src/play-context.ts';

// Replace browser surfaces and worker transport, while importing the actual
// transitions, cameras, editor and terrain used by the page.
export function playContext(options, effects) {
  const { renderer, view } = options;
  return createPlayContext({ ...options, input: options.input ?? { gesture: null },
    ui: {
      closeDetails: () => effects.detailsUX?.close(),
      closeScreens: () => { effects.screen?.close(); effects.fieldScreen?.close(); },
      cancelWeaponChoice: () => effects.workshopUX?.cancelWeaponChoice(),
      unwatch: () => effects.squadUX?.unwatch(), frameChoice: () => effects.squadUX?.frame(),
      placing: () => effects.publication?.active ? effects.publication : null,
      framePublication() {}, adjustPublication: () => false, cancelRoad() {}, showWorkshop() {}, advise() {},
      enterField: () => effects.entry?.(), notice: (...args) => effects.toast?.(...args), touching: () => false,
      refresh: () => effects.presented?.push({ mode: view.mode, weapon: view.weapon, tool: view.testTool, terrain: renderer.ground.id }),
    },
    simulation: {
      stopControls: () => effects.stopControls?.(), start: () => effects.startWorker?.(),
      command: (...args) => effects.command(...args), sendAim: () => effects.sendAim?.(),
      pause: () => effects.worker?.postMessage({ type: 'pause', value: true }),
    },
  });
}
