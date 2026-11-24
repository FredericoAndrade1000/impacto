import { tr } from './i18n.ts';
import { Container, Graphics, GraphicsContext, GraphicsPath, Text } from 'pixi.js';
import { standing, holderOf, ghostText, serviceText, cargoWorkText, toolText, aiStatusText } from './faction-ui.ts';
import { WEAPON_PRESETS, weaponOf } from './weapons.ts';
import type { TextStyleOptions, ColorSource } from 'pixi.js';
import type { DrawingActor, DrawingModule } from './scene-drawing-contract.ts';
import type { StandingState } from './faction-ui.ts';
import type { FactionView } from './field-contract.ts';
import type { FogFrame } from './fog-contract.ts';

type LabelActor = Pick<DrawingActor, 'id' | 'ownerId' | 'team' | 'defeated' | 'field' | 'ghost' | 'playerName'> & { vehicle?: unknown };
type LabelPart = { type: 'module'; data: Pick<DrawingModule, 'kind' | 'attached' | 'weaponPreset'> } | { type: 'plate' };
export interface VehicleLabelState extends StandingState {
  time: number; players?: readonly Readonly<NonNullable<FogFrame['players']>[number]>[] | undefined;
  faction?: Pick<FactionView, 'id'> & { readonly units?: readonly Pick<FactionView['units'][number], 'id' | 'tools'>[] | undefined } | null;
}
export interface VehicleLabelChip { icon: string; count: number; text: string }
export interface VehicleLabelModel { role: string; caption: string; status: string; statusIcon: string | null; chips: VehicleLabelChip[]; alone: boolean; key: string }
export interface VehicleLabelBox { x: number; y: number; width: number; top: number; bottom: number }
type MeasureText = (text: string) => number;


const FONT = { fontFamily: 'Segoe UI', fontSize: 11, lineHeight: 14, fontWeight: '600',
  align: 'center', stroke: { color: '#1b3024', width: 3 } } satisfies TextStyleOptions;
const ICON = 18, GAP = 8;
const shortName = (name: string | null | undefined) => { const letters = Array.from(name || tr('Jogador')); return letters.length > 12 ? letters.slice(0, 9).join('') + '...' : letters.join(''); };

// The published carrier distinguishes a vehicle from a fixed construction. Only published pieces say what a vehicle does.
export function vehicleRole(actor: Pick<LabelActor, 'defeated' | 'vehicle'>, parts: readonly LabelPart[]) {
  if (actor.defeated) return 'i-wreck';
  if (!actor.vehicle) return 'i-structure';
  const pieces = parts.filter((part): part is Extract<LabelPart, { type: 'module' }> => part.type === 'module' && part.data.attached !== false).map(part => part.data), kinds = new Set(pieces.map(p => p.kind));
  if (kinds.has('builder') || kinds.has('blade') || kinds.has('paver')) return 'i-build';
  if (kinds.has('supply')) return 'k-supply';
  if ((kinds.has('excavator') || kinds.has('drill')) && (kinds.has('hopper') || kinds.has('cistern'))) return 'k-miner';
  if (kinds.has('hopper') && kinds.has('cistern')) return 'k-hauler';
  if (kinds.has('hopper')) return 'i-haul';
  if (kinds.has('cistern')) return 'r-petroleo';
  if (kinds.has('excavator') || kinds.has('drill')) return 'k-extractor';
  const guns = pieces.filter(p => p.kind === 'weapon');
  if (guns.some(p => ['mortar', 'howitzer'].includes(weaponOf(p.weaponPreset)?.family ?? ''))) return 'k-artillery';
  if (guns.length) return 'k-armor';
  return kinds.has('sensor') ? 'k-scout' : 'i-wheel';
}

// A vehicle is told by the icon of what it does, with whose it is when it is not the player's: never by its name. One of the
// faction another member holds is told by that member's name; one of another faction, by its player's, and as away while
// that one is.
export function vehicleLabel(actor: LabelActor, state: VehicleLabelState, parts: readonly LabelPart[]): VehicleLabelModel {
  const side = standing(actor, state), holder = side === 'ally' ? holderOf(actor, state) : null,
    owner = side === 'enemy' ? state.players?.find(p => p.id === actor.ownerId) : null,
    ai = owner?.ai, away = Boolean(owner && !owner.connected && !ai), presence = aiStatusText(ai) || (away ? tr('ausente') : ''),
    repair = !actor.ghost && actor.field?.service, work = !actor.ghost && !repair && side !== 'wreck' ? actor.field?.cargoWork : null,
    waitingTools = work?.kind === 'load' && work.waiting === true && state.faction?.id != null && actor.team === state.faction.id ?
      state.faction.units?.find(unit => unit.id === actor.id)?.tools : null,
    fuelWait = waitingTools?.limit === 'fuel',
    loading = fuelWait ? toolText(waitingTools) : cargoWorkText(work, state.time), timed = Boolean(loading) && !work!.waiting && !work!.limited && Number.isFinite(work!.until), role = vehicleRole(actor, parts),
    identity = side === 'wreck' ? tr('Destroços') : side === 'own' ? '' : shortName(holder ? holder.name : actor.playerName),
    status = side === 'wreck' ? '' : actor.ghost ? ghostText(actor, state.time).slice(3) : repair ? serviceText(repair, state.time) : loading || presence,
    statusIcon = actor.ghost ? 'i-clock' : repair ? ({ build: 'i-build', dismantle: 'i-build', repair: 'i-repair', turn: 'i-turn' }[repair.kind] || 'i-clock') : loading ? work!.waiting ? 'i-clock' : 'i-haul' : away ? 'i-abandon' : null;
  return { role, caption: identity,
    status: presence && (actor.ghost || repair || loading) ? status + ' · ' + presence : status, statusIcon,
    chips: [{ icon: role, count: 1, text: '' }], alone: Boolean(actor.ghost || repair || timed),
    // Untimed identical work may share a compact mark; a real deadline stays
    // individual, and a waiting truck never lends its status to an idle one.
    key: JSON.stringify([side === 'own' ? '' : holder ? holder.id : actor.ownerId ?? actor.id, actor.team, side, Boolean(actor.vehicle), Boolean(actor.ghost), Boolean(away), ai, loading ? fuelWait ? 'waiting-fuel' : work!.waiting ? 'waiting' : work!.limited ? 'limited' : 'loading' : '']) };
}

export function groupedVehicleLabel(items: readonly VehicleLabelModel[]): VehicleLabelModel {
  if (items.length === 1) return items[0]!;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.role, (counts.get(item.role) || 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    chips = sorted.slice(0, sorted.length > 3 ? 2 : 3).map(([icon, count]) => ({ icon, count, text: String(count) }));
  if (sorted.length > 3) chips.push({ icon: 'i-fleet', count: items.length, text: items.length + ' total' });
  return { ...items[0]!, chips };
}

// Wrap once when words change, using the same measured font and explicit line height as their Text objects.
const wrapped = (text: string, measure: MeasureText, width: number) => {
  const lines = []; let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && measure(line + ' ' + word) > width) { lines.push(line); line = ''; }
    for (const letter of Array.from((line ? ' ' : '') + word)) {
      if (line && measure(line + letter) > width) { lines.push(line); line = ''; }
      line += letter;
    }
  }
  if (line) lines.push(line);
  return lines;
};

export function vehicleLabelLayout(model: VehicleLabelModel, measure: MeasureText, width = 260) {
  const caption = wrapped(model.caption, measure, width), status = wrapped(model.status, measure, width - (model.statusIcon ? ICON + 4 : 0)),
    captionWidth = Math.max(0, ...caption.map(measure)), statusWidth = Math.max(0, ...status.map(measure)),
    chips = model.chips.map(chip => ICON + (chip.text ? 4 + measure(chip.text) : 0)),
    rowWidth = captionWidth + chips.reduce((sum, n) => sum + n, 0) + GAP * Math.max(0, chips.length + Number(Boolean(captionWidth)) - 1);
  return { caption: caption.join('\n'), status: status.join('\n'), captionWidth, statusWidth, chips, rowWidth,
    width: Math.max(rowWidth, statusWidth + (model.statusIcon && status.length ? ICON + 4 : 0)),
    lift: ICON / 2 + 2 + Math.max(0, caption.length - 1) * FONT.lineHeight, captionY: -Math.max(0, caption.length - 1) * FONT.lineHeight / 2,
    top: -ICON / 2 - Math.max(0, caption.length - 1) * FONT.lineHeight, bottom: status.length ? 26 + (status.length - 1) * FONT.lineHeight : ICON / 2 };
}

// Place final groups in stable priority order. Only overlapping boxes rise; none is moved sideways or shown twice.
export function separateVehicleLabels<Item extends VehicleLabelBox & { key: string; id: string }>(items: Item[], obstacles: readonly VehicleLabelBox[] = [], gap = 4) {
  if (!items.length || items.length < 2 && !obstacles.length) return items;
  const placed = [...obstacles];
  for (const item of [...items].sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id))) {
    for (const prior of [...placed].sort((a, b) => b.y + b.bottom - a.y - a.bottom)) {
      if (item.x + item.width / 2 + gap <= prior.x - prior.width / 2 || item.x - item.width / 2 - gap >= prior.x + prior.width / 2) continue;
      if (item.y + item.bottom + gap > prior.y + prior.top && item.y + item.top - gap < prior.y + prior.bottom)
        item.y = prior.y + prior.top - gap - item.bottom;
    }
    placed.push(item);
  }
  return items;
}

// These local symbols use only paths, circles and rectangles. Pixi reads their paths; no copied icon geometry or SVG renderer is needed.
export class LabelIcons {
  declare contexts: Map<string, GraphicsContext>;
  constructor() { this.contexts = new Map(); }
  get(id: string): GraphicsContext {
    if (this.contexts.has(id)) return this.contexts.get(id)!;
    const art = new GraphicsContext(), symbol = globalThis.document?.getElementById?.(id), shapes: { draw(): GraphicsContext; filled: boolean }[] = []; art.translate(-12, -12);
    for (const shape of symbol?.children || []) {
      const at = (name: string) => Number(shape.getAttribute(name) || 0), type = shape.tagName.toLowerCase(),
        path = type === 'path' ? new GraphicsPath(shape.getAttribute('d')!) : null,
        draw = type === 'path' ? () => art.path(path!) : type === 'circle' ? () => art.circle(at('cx'), at('cy'), at('r')) :
          type === 'rect' ? () => art.roundRect(at('x'), at('y'), at('width'), at('height'), at('rx')) : null;
      if (!draw) continue;
      shapes.push({ draw, filled: shape.getAttribute('stroke') === 'none' });
    }
    // Outline the whole symbol first so adjoining shapes cannot erase one another's light strokes.
    for (const { draw } of shapes) draw().stroke({ color: 0x1b3024, width: 4, cap: 'round', join: 'round' });
    for (const { draw, filled } of shapes)
      if (filled) draw().fill(0xffffff);
      else draw().stroke({ color: 0xffffff, width: 2, cap: 'round', join: 'round' });
    this.contexts.set(id, art); return art;
  }
  clear() { for (const art of this.contexts.values()) art.destroy(); this.contexts.clear(); }
}

export class VehicleLabel extends Container {
  declare icons: LabelIcons; declare measure: MeasureText; declare chips: { icon: Graphics; count: Text }[]; declare caption: Text; declare status: Text; declare statusIcon?: Graphics;
  declare key?: string; declare content?: VehicleLabelModel; declare layout?: ReturnType<typeof vehicleLabelLayout>;
  constructor(icons: LabelIcons, measure: MeasureText) {
    super(); this.icons = icons; this.measure = measure; this.chips = [];
    this.caption = this.addChild(new Text({ text: '', style: FONT })); this.caption.anchor.set(.5);
    this.status = this.addChild(new Text({ text: '', style: FONT })); this.status.anchor.set(.5, 0);
  }
  setContent(model: VehicleLabelModel, width: number, color: ColorSource | undefined) {
    const key = JSON.stringify([model.caption, model.status, model.statusIcon, model.chips, width, color]);
    if (this.key === key) return;
    this.key = key; this.content = model;
    const layout = this.layout = vehicleLabelLayout(model, this.measure, width);
    this.caption.text = layout.caption; this.caption.visible = Boolean(layout.caption); this.caption.style.fill = color!;
    this.caption.position.set(-layout.rowWidth / 2 + layout.captionWidth / 2, layout.captionY);
    let x = -layout.rowWidth / 2 + layout.captionWidth + (layout.captionWidth && model.chips.length ? GAP : 0);
    for (let i = 0; i < Math.max(this.chips.length, model.chips.length); i++) {
      let chip = this.chips[i]; const shown = model.chips[i];
      if (!chip) {
        chip = { icon: this.addChild(new Graphics(this.icons.get(shown!.icon))), count: this.addChild(new Text({ text: '', style: FONT })) };
        chip.icon.scale.set(ICON / 24); chip.count.anchor.set(0, .5); this.chips.push(chip);
      }
      chip.icon.visible = Boolean(shown); chip.count.visible = Boolean(shown?.text);
      if (!shown) continue;
      chip.icon.context = this.icons.get(shown.icon); chip.icon.tint = color!; chip.icon.position.set(x + ICON / 2, 0);
      chip.count.text = shown.text; chip.count.style.fill = color!; chip.count.position.set(x + ICON + 4, 0);
      x += layout.chips[i]! + GAP;
    }
    this.status.text = layout.status; this.status.visible = Boolean(layout.status); this.status.style.fill = color!;
    this.status.position.set(model.statusIcon ? 10 : 0, 10);
    if (model.statusIcon && layout.status) {
      if (!this.statusIcon) { this.statusIcon = this.addChild(new Graphics(this.icons.get(model.statusIcon))); this.statusIcon.scale.set(ICON / 24); }
      this.statusIcon.context = this.icons.get(model.statusIcon); this.statusIcon.visible = true;
      this.statusIcon.tint = color!; this.statusIcon.position.set(-(layout.statusWidth + 4) / 2, 17);
    } else if (this.statusIcon) this.statusIcon.visible = false;
  }
  get text() { return [this.caption.text, ...this.chips.filter(chip => chip.count.visible).map(chip => chip.count.text), this.status.text].filter(Boolean).join('\n'); }
}
