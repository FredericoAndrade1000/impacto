import { onDesign, strikeDirection, strikeAlong, levelStrike, strikeVerdict, strikeDetail } from './armour-strike.ts';
import { pickPiece } from './editor.ts';
import { regionContains } from './scene-frame.ts';
import { reach as touchReach } from './touch.ts';
import type { Point, Pose } from './math.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { WeaponSettings } from './weapons.ts';
import type { CanvasPoint, CanvasStrikeGesture, CanvasControlInput } from './canvas-controls.ts';
import type { ArmourStrike, PredictedStrikeImpact, StrikeJudgement, StrikeTest } from './armour-strike.ts';

export type JudgedArmourStrike = ArmourStrike & StrikeJudgement & { detail: string };
export type StrikeView = (JudgedArmourStrike & { fired?: number; pointer?: Point }) |
  { from: Point; back: true; fired?: never } |
  { from: Point; direction: Point; toward: Point; pointer: Point; verdict: 'miss'; fired?: never };
export interface ArmourTrialRenderer {
  tool: string; state: DrawingScene | null; presentedState?: DrawingScene | null | undefined;
  ground: StrikeTest['ground']; weapon: WeaponSettings; camera: { zoom: number }; strike: StrikeView | null;
  predictionScene(state: DrawingScene): StrikeTest['index'];
  sceneFor(state: DrawingScene): { actor(id: string): Pose | null | undefined };
}
export interface ArmourTrialCommand {
  (op: 'resistance', data: { id: string; point: Point; end: Point; depth: number; cosine: number }): Promise<unknown>;
  (op: 'strike', data: { round: ArmourStrike['round']; flight: number }): Promise<unknown>;
  (op: 'quicken'): Promise<unknown>;
}
export interface ArmourTrialOptions {
  view: { trial?: string | null }; renderer: ArmourTrialRenderer; input: Pick<CanvasControlInput, 'gesture'>;
  session: { ready: boolean; testDistance: number; slowed: boolean }; command: ArmourTrialCommand;
  toast(message: string, error?: boolean): void; reach?: (pixels: number) => number; performance?: Pick<Performance, 'now'>;
}

export const STRIKE_PX = 6;
export function createArmourTrial({ view, renderer, input, session, command, toast, reach = touchReach, performance = globalThis.performance }: ArmourTrialOptions) {
  // The test of armour is struck along a line the player draws (armour-strike.ts): pressed where the round comes from —
  // anywhere, the sky as well — and dragged toward where it goes, letting go fires it on along that line to the first
  // thing it meets, the design or the ground; a shell set to burst in the air bursts where the line was let go, if it
  // meets nothing before. While the line is drawn, what the round would strike first and what it would do there is
  // drawn over the field (`renderer.strike`). A line into the sky with nothing to burst there fires nothing, nor does
  // one let go back where it was pressed, nor Esc. A click on the design, not dragged, strikes it level at the place
  // clicked; one beside it does nothing.
  // How far a press is dragged, in pixels, before it is a line; and how far outside the design, on the screen, the level
  // line of a click is drawn from, for its round to be seen coming.
  const LEVEL_LEAD_PX = 240;
  // Whether a press takes hold of a line to strike the design with: anywhere, under a test of armour.
  const strikes = () => view.trial === 'armour' && renderer.tool === 'fire' && session.ready && Boolean(renderer.presentedState || renderer.state);
  // The test as a strike reads it (`strikeAlong`): the state shown, its collision index, its ground, where the hull of
  // the design stands, the gun of the test and its distance.
  function strikeTest(): StrikeTest {
    const state = (renderer.presentedState || renderer.state)!;
    return { state, index: renderer.predictionScene(state), ground: renderer.ground, hull: renderer.sceneFor(state).actor('local'),
      weapon: renderer.weapon, distance: session.testDistance };
  }
  // What the pieces of the design cost a round to get through, as the core says (`resistance`, simulation-worker.ts), by
  // the place struck: asked once, and the strike is told again when the answer comes.
  const pieceCosts = new Map<string, number | undefined>();
  function pieceCost(impact: PredictedStrikeImpact): number | undefined {
    const exitX = impact.exitX, exitY = impact.exitY;
    if (exitX === undefined || exitY === undefined) return undefined;
    const cosine = Math.cos(impact.angleDegrees * Math.PI / 180),
      key = [impact.owner.id, ...[impact.x, impact.y, exitX, exitY, cosine].map(n => n.toFixed(3))].join(':');
    if (!pieceCosts.has(key)) {
      pieceCosts.set(key, undefined);
      command('resistance', { id: impact.owner.id, point: { x: impact.x, y: impact.y }, end: { x: exitX, y: exitY }, depth: impact.depth, cosine })
        .then((reply: unknown) => {
          const resistance = reply !== null && typeof reply === 'object' && 'resistance' in reply && typeof reply.resistance === 'number' ? reply.resistance : undefined;
          pieceCosts.set(key, resistance);
          if (input.gesture?.type === 'strike' && input.gesture.at) aimStrike(input.gesture);
          else if (renderer.strike?.fired && renderer.strike.impact) renderer.strike = judge(renderer.strike);
        }, () => {});
    }
    return pieceCosts.get(key);
  }
  // A strike with what it does where it first strikes (`verdict`) and what it strikes there (`detail`).
  function judge(strike: ArmourStrike): JudgedArmourStrike {
    const impact = strike.impact;
    return { ...strike, detail: strikeDetail(impact, strike), ...strikeVerdict(impact, strike, impact?.owner.type === 'module' ? pieceCost(impact) : undefined) };
  }
  // The strike a line drawn from `gesture.from` aims toward the pointer (`at`: where it is in the world, and on the
  // screen), told by the pointer, where a shell set to burst in the air is fuzed for. Back on the place pressed, letting
  // go calls it off.
  function aimStrike(gesture: CanvasStrikeGesture, at: CanvasPoint | undefined = gesture.at): void {
    if (!at) return;
    gesture.at = at;
    if (Math.hypot(at.sx - gesture.sx, at.sy - gesture.sy) < reach(STRIKE_PX)) { renderer.strike = { from: gesture.from, back: true }; return; }
    const direction = strikeDirection(gesture.from, at);
    if (!direction) return;
    const strike = strikeAlong(strikeTest(), gesture.from, direction, at);
    const pointer = { x: at.x, y: at.y };
    renderer.strike = strike ? { ...judge(strike), pointer } : { from: gesture.from, direction, toward: pointer, pointer, verdict: 'miss' };
  }
  // A click on the design strikes it level at the place clicked (`levelStrike`), from the side its part there is seen
  // from; one beside the design does nothing.
  function clickStrike(point: Point): void {
    const test = strikeTest(), state = test.state;
    if (!onDesign(state, test.hull, point, reach(STRIKE_PX) / renderer.camera.zoom)) return;
    const part = pickPiece(state.plates, state.modules, point, 0, piece => { if ('definition' in piece) return regionContains(piece, point); }),
      strike = levelStrike(test, point, part, LEVEL_LEAD_PX / renderer.camera.zoom);
    if (strike) launchStrike(judge(strike));
  }
  // The round aimed goes, to strike what it meets `flight` seconds of the world later: the arrow stays a moment, faint
  // under the round, fading.
  function launchStrike(strike: JudgedArmourStrike): void {
    renderer.strike = { ...strike, fired: performance.now() };
    command('strike', { round: strike.round, flight: strike.impact?.time ?? strike.solution.time }).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), true));
  }
  // While a round strikes the design slowly, a click, a touch or Esc gives the world its pace back, and does nothing more.
  function quicken() {
    if (!session.slowed) return false;
    session.slowed = false; command('quicken').catch(() => {});
    return true;
  }

  return { strikes, aimStrike, clickStrike, launchStrike, quicken, clearCosts: () => pieceCosts.clear() };
}
