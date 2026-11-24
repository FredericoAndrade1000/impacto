import { tr } from './i18n.ts';
import { node } from './dom-view.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { FieldView, FactionView } from './faction-ui.ts';
import type { FieldPanelView } from './field-panel.ts';
import type { Point } from './math.ts';

type TowPanel = Pick<FieldPanelView, 'situation' | 'squad'>;
export interface TowNetwork {
  connected: boolean; faction: Pick<FactionView, 'id'> | null; socket: WebSocket | null | undefined;
  command(type: 'tow', data: { act: 'detach'; actorId: string }): Promise<unknown>;
}
export interface TowUIOptions {
  network: TowNetwork; renderer: { state: FieldView | null }; refresh(): void; stopControls(): void;
  serviced(): string | null; toast(message: string, error?: boolean): void;
}
interface TowAnchor extends Point { speed: number }
interface PendingDetach { socket: WebSocket | null | undefined; actorId: string }
function errorText(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

// How far apart the two ends of a cable may be fixed, and how fast either end may still move, as the core takes them
// (game_towing.rs: TOW_LEAST_LENGTH, TOW_REACH and TOW_STILL). The field decides; the page only foretells it.
const LEAST = .25, REACH = 4, STILL = .5;
// Where a cable may be fixed on a vehicle, as the core picks it: near either end of each beam of its chassis frame.
const ENDS = [.02, .98];

// The cable a vehicle is on, by either of its ends.
export const towOf = (state: Pick<DrawingScene, 'tows'> | null | undefined, id: string | null | undefined) => state?.tows?.find(tow => tow.actorId === id || tow.targetId === id) || null;
// Whether a towed vehicle drives itself along with what tows it, as the core has one do (game_towing.rs `hitch`): its
// engine gives power, which it does not with no fuel or destroyed, and a wheel or track of it is whole. One that does not
// is pulled.
function drivesAlong(state: Pick<DrawingScene, 'actors'> | null | undefined, id: string): boolean {
  const vehicle = state?.actors?.find(actor => actor.id === id)?.vehicle;
  return Boolean(vehicle?.engine && vehicle.enabled !== false && Number(vehicle.gearCount) > 0);
}

// The points of a vehicle's chassis frame a cable may be fixed to, each with how fast it moves, as a frame tells them:
// worked out once for each frame.
const framed = new WeakMap<DrawingScene, Map<string | undefined, DrawingScene['plates'][number]['definition'][]>>();
function anchors(state: DrawingScene, id: string): TowAnchor[] {
  let all = framed.get(state);
  if (!all) {
    all = new Map(); framed.set(state, all);
    for (const plate of state.plates ?? []) if (plate.attached !== false && plate.definition?.chassis?.part === 'frame')
      all.set(plate.actorId, [...all.get(plate.actorId) ?? [], plate.definition]);
  }
  const body = state.actors.find(actor => actor.id === id)?.vehicle;
  if (!body) return [];
  return (all.get(id) ?? []).flatMap(d => ENDS.map(along => {
    const x = d.x + Math.cos(d.angle) * d.length * (along - .5), y = d.y + Math.sin(d.angle) * d.length * (along - .5),
      spin = body.omega || 0;
    return { x, y, speed: Math.hypot((body.vx || 0) - spin * (y - Number(body.y)), (body.vy || 0) + spin * (x - Number(body.x))) };
  }));
}

// Whether the vehicle `actorId` can take another, `targetId`, on its cable now: their nearest anchors within reach,
// and both standing still there. Null when the frame shows no frame of either to tell by, and for a vehicle that flies
// (ui-model.ts `flies`), which takes it up on a sling from under its centre of mass (sling.ts): the field is asked then.
export function towReady(state: DrawingScene, actorId: string, targetId: string): boolean | null {
  const vehicle = state.actors.find(actor => actor.id === actorId)?.vehicle;
  if (vehicle && Number(vehicle.thrustN) > 0) return null;
  const ours = anchors(state, actorId), theirs = anchors(state, targetId);
  if (!ours.length || !theirs.length) return null;
  let nearest: { length: number; a: TowAnchor; b: TowAnchor } | null = null;
  for (const a of ours) for (const b of theirs) {
    const length = Math.hypot(a.x - b.x, a.y - b.y);
    if (!nearest || length < nearest.length) nearest = { length, a, b };
  }
  return nearest && nearest.length >= LEAST && nearest.length <= REACH && nearest.a.speed <= STILL && nearest.b.speed <= STILL;
}

// The vehicle on the cable in a line of the panel of a construction: what it pulls, or what pulls it, and the button
// that lets go. The cable is asked for on the field, with the order Rebocar (squad-ux.ts).
export class TowUI {
  declare readonly network: TowNetwork;
  declare readonly renderer: TowUIOptions['renderer'];
  declare readonly refresh: TowUIOptions['refresh'];
  declare readonly stopControls: TowUIOptions['stopControls'];
  declare readonly serviced: TowUIOptions['serviced'];
  declare readonly toast: TowUIOptions['toast'];
  declare pending: PendingDetach | null;
  declare readonly host: HTMLDivElement;
  declare readonly line: HTMLSpanElement;
  declare readonly hint: HTMLElement;
  declare readonly release: HTMLButtonElement;
  constructor(before: Element, { network, renderer, refresh, stopControls, serviced, toast }: TowUIOptions) {
    this.network = network; this.renderer = renderer; this.refresh = refresh; this.stopControls = stopControls;
    this.serviced = serviced; this.toast = toast;
    this.pending = null;
    this.host = node('div', 'unit-tow'); this.host.id = 'unit-tow'; this.host.hidden = true;
    this.line = node('span', 'unit-tow-line'); this.hint = node('small', 'field-operation-status');
    this.release = node('button', '', tr('Soltar')); this.release.type = 'button';
    const words = node('div'); words.append(this.line, this.hint);
    this.host.append(words, this.release); before.before(this.host);
    this.release.onclick = () => this.detach();
  }

  // The vehicle in focus, while the player commands it or has it in hand on the shared field.
  source(panel: TowPanel) {
    const state = this.renderer.state, faction = this.network.faction, id = this.serviced();
    if (!this.network.connected || panel.situation !== 'command' && panel.situation !== 'direct' || !state?.shared || !faction || !id) return null;
    return state.actors.find(actor => actor.id === id && actor.team === faction.id && actor.vehicle && !actor.ghost) || null;
  }
  // What the column calls a vehicle: its name, and its key when the column has it.
  named(panel: TowPanel, id: string): string {
    const row = panel.squad?.units.find(unit => unit.id === id), name = row?.name || this.renderer.state?.actors.find(actor => actor.id === id)?.name || tr('veículo');
    return row?.number ? `${name} (${row.number})` : name;
  }

  render(panel: TowPanel): void {
    const source = this.source(panel), tow = source && towOf(this.renderer.state, source.id);
    this.host.hidden = !tow;
    if (!tow || !source) return;
    const pulls = tow.actorId === source.id,
      line = (tow.sling ? pulls ? tr('Carregando ') : tr('Carregado por ') : pulls ? 'Rebocando ' : tr('Rebocado por ')) + this.named(panel, pulls ? tow.targetId : tow.actorId),
      both = !tow.sling && drivesAlong(this.renderer.state, tow.targetId) ? tr('Os dois puxam e freiam juntos. ') : '',
      hint = tow.sling ? pulls ? tr('Mover leva a carga; Mover ao chão a deixa lá. Soltar no ar a derruba.') : tr('Solte o cabo para conduzir.')
        : both + (pulls ? tr('Conduza ou use Mover.') : tr('Solte o cabo para conduzir.'));
    if (this.line.textContent !== line) this.line.textContent = line;
    if (this.hint.textContent !== hint) this.hint.textContent = hint;
    this.release.disabled = Boolean(this.pending);
  }

  // Either end lets go: the field answers for the one in focus, which no other member holds.
  async detach() {
    const actorId = this.serviced(), socket = this.network.socket;
    if (this.pending || !this.network.connected || !actorId || !towOf(this.renderer.state, actorId)) return;
    const pending = this.pending = { socket, actorId }, current = () => this.network.socket === socket && this.serviced() === actorId;
    this.stopControls(); this.refresh();
    try {
      await this.network.command('tow', { act: 'detach', actorId });
      if (current()) this.toast(tr('Cabo solto.'));
    } catch (error) { if (current()) this.toast(errorText(error), true); }
    finally { if (this.pending === pending) { this.pending = null; this.refresh(); } }
  }
}
