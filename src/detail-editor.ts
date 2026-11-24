import type { Editor } from './editor.ts';
import type { Renderer } from './render.ts';
import type { UiView } from './ui-model.ts';
import type { Point, Pose } from './math.ts';
import type { AuthoredDetail, CompiledConstruction } from './construction-contract.ts';
import type { DetailKind, DetailHost, DetailHosts } from './vehicle-details.ts';
import type { DetailDrag } from './detail-gestures.ts';

export interface DetailEditorOptions {
  host: HTMLElement; canvas: HTMLCanvasElement; button: HTMLButtonElement; view: UiView; renderer: Renderer;
  editor: () => Editor; closePanels: () => void; changed: () => void; toast: (message: string, warning?: boolean) => void;
}
interface PanDetailDrag { kind: 'pan'; pointerId: number; moved: boolean; clientX: number; clientY: number; startX: number; startY: number; point: Point; detail: null; host: null; pose: null }
interface MoveDetailDrag extends DetailDrag { kind: 'move'; pointerId: number; moved: boolean; clientX: number; clientY: number; startX: number; startY: number }
interface HandleDetailDrag { kind: 'corner' | 'turn'; corner: number | null; pointerId: number; detail: AuthoredDetail; host: DetailHost; pose: Pose & { mirrored: boolean }; start: Point; from: Point | null; moved: boolean }
interface AddingDetail { kind: DetailKind; pointerId: number; x: number; y: number; touch: boolean; id: string; dragged: boolean; button: HTMLButtonElement }
export interface DetailEditor extends DetailEditorOptions {
  enabled: boolean; selected: string | null; drag: PanDetailDrag | MoveDetailDrag | HandleDetailDrag | null;
  adding: AddingDetail | null; hover: string | null; guides: Point[][]; pending: boolean; arrows: Set<string>;
  carried: { detail: AuthoredDetail; index: number } | null; panel: HTMLElement; get: <T extends HTMLElement = HTMLElement>(selector: string) => T;
  more: HTMLButtonElement; menuList: HTMLElement; bar: HTMLDivElement; text: HTMLInputElement;
  grips: HTMLButtonElement[]; turnGrip: HTMLButtonElement; hostSource?: CompiledConstruction; hostExterior?: boolean | undefined;
  hostCache?: DetailHosts; pause?: ReturnType<typeof setTimeout>; full?: boolean; paint?: string; dropped?: boolean;
}

import { tr } from './i18n.ts';
import { makeId } from './blueprints.ts';
import { rectangle } from './math.ts';
import { paintDetailCanvas } from './hull-art.ts';
import { projectRefusalMessage } from './project-refusal.ts';
import { confirm } from './confirm-dialog.ts';
import { icon } from './dom-view.ts';
import { reach, LIFT } from './touch.ts';
import { cancels, removes } from './workshop-keys.ts';
import { DETAIL_LIMIT, VEHICLE_DETAILS, detailAt, detailPose, detailCorners, detailHostAt, editableDetailHosts, hostForDetail,
  automaticFinish } from './vehicle-details.ts';
import { DETAIL_GROUPS, placedDetail, resizedPose, turnedAngle, movedDetail, detailUnder, hiddenDetail, strayDetails, additionSpot,
  mirroredDetail, copiedDetail } from './detail-gestures.ts';

// The handles of a detail stand at least GRIP_CLEAR pixels from its middle, so that those of a reflector a few pixels
// across are apart; the handle of the turn TURN_LIFT pixels above its top. A finger has twice those (touch.ts reach).
const GRIP_CLEAR = 12, TURN_LIFT = 24;
// How far, in pixels, a press goes before it is a drag: a click that trembles moves nothing.
const STILL = 3, DRAG_FROM = 8;
// Milliseconds after the last tap of an arrow that its moves become one change of the history.
const SETTLE_MS = 700;
const ARROWS: Readonly<Record<string, readonly [number, number]>> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] };
const detailKind = (value: string | undefined): DetailKind => { if (value && Object.hasOwn(VEHICLE_DETAILS, value)) return Object.keys(VEHICLE_DETAILS).find((key): key is DetailKind => key === value)!; throw new Error('Detalhe desconhecido.'); };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// What Ctrl+C took, for Ctrl+V, from one project to another.
let clipboard: AuthoredDetail | null = null;

// This mode edits appearance only. The ordinary Editor owns history, native admission, saving and publication. The
// player works on the drawing: a detail is taken by pressing it, moved by dragging it, sized and turned by its handles
// and changed by the bar of actions over it; the panel is the catalogue, and the rare actions are under Mais ações.
export class DetailEditor {
  constructor({ host, canvas, button, view, renderer, editor, closePanels, changed, toast }: DetailEditorOptions) {
    Object.assign(this, { host, canvas, button, view, renderer, editor, closePanels, changed, toast });
    this.enabled = false; this.selected = null; this.drag = null; this.adding = null; this.hover = null; this.guides = [];
    this.pending = false; this.arrows = new Set(); this.carried = null;
    this.panel = document.createElement('section'); this.panel.id = 'vehicle-details'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', tr('Detalhes visuais'));
    this.panel.innerHTML = `<header><h2>${tr("Detalhes")}</h2><output aria-label="${tr("Detalhes no projeto")}"></output>
      <button type="button" class="icon-button" data-more aria-haspopup="menu" aria-expanded="false" aria-label="${tr("Mais ações")}" title="${tr("Mais ações")}">${icon('i-more')}</button>
      <button type="button" class="icon-button" data-close aria-label="${tr("Concluir detalhes")}" title="${tr("Concluir detalhes · Esc")}">${icon('i-close')}</button></header>
      <div class="detail-menu" role="menu" hidden>
        <button type="button" role="menuitemcheckbox" data-automatic title="${tr("Desligar mantém os detalhes. Religar gera de novo os automáticos.")}">${icon('i-wand')}<span>${tr("Detalhes automáticos")}</span><i class="detail-switch"></i></button>
        <button type="button" role="menuitem" data-stray>${icon('i-trash')}<span></span></button>
        <button type="button" role="menuitem" class="danger" data-clear>${icon('i-trash')}<span>${tr("Limpar todos")}</span></button>
      </div>
      <div class="detail-catalogue" role="group" aria-label="${tr("Adicionar detalhe")}"></div>`;
    this.get = <T extends HTMLElement = HTMLElement>(selector: string) => this.panel.querySelector<T>(selector)!;
    this.more = this.get<HTMLButtonElement>('[data-more]'); this.menuList = this.get('.detail-menu');
    this.get('[data-close]').onclick = () => this.close();
    this.more.onclick = () => this.menu(Boolean(this.menuList.hidden));
    this.get('[data-automatic]').onclick = () => { this.menu(false); this.setAutomatic(this.editor().source.appearance?.automaticDetails === false); };
    this.get('[data-stray]').onclick = () => { this.menu(false); this.removeStrays(); };
    this.get('[data-clear]').onclick = () => {
      this.menu(false);
      const count = this.details.length;
      confirm(tr('Limpar todos os detalhes?'), tr`${count === 1 ? tr('O detalhe sai') : tr`Os ${count} detalhes saem`} do projeto e os automáticos deixam de ser gerados. Desfazer traz de volta.`, tr('Limpar'))
        .then(yes => { if (yes && this.enabled) this.clearAll(); });
    };
    document.addEventListener('pointerdown', event => {
      // A press anywhere else — undo, save — finds the detail the arrows moved back in the project.
      if (this.carried && !this.drag && !this.adding) this.settle();
      if (!this.menuList.hidden && event.target instanceof Node && !this.menuList.contains(event.target) && !this.more.contains(event.target)) this.menu(false);
    }, true);
    this.catalogue();

    // The bar of the detail picked: its name, its number when it is one, and what is done to it.
    this.bar = document.createElement('div'); this.bar.className = 'selection-bar detail-bar'; this.bar.hidden = true;
    this.bar.setAttribute('role', 'toolbar'); this.bar.setAttribute('aria-label', tr('Detalhe selecionado'));
    this.bar.innerHTML = `<b class="detail-name"></b><label class="detail-text"><span class="sr-only">${tr("Número")}</span><input type="text"
        inputmode="numeric" maxlength="3" pattern="[0-9]{1,3}" autocomplete="off" required title="${tr("Número · de um a três algarismos")}"></label>
      <button type="button" data-act="mirror" aria-label="${tr("Espelhar")}" title="${tr("Espelhar")}">${icon('i-mirror')}</button>
      <button type="button" data-act="duplicate" aria-label="${tr("Duplicar")}" title="${tr("Duplicar · Ctrl+D")}">${icon('i-copy')}</button>
      <button type="button" data-act="remove" class="danger" aria-label="${tr("Remover")}" title="${tr("Remover · Delete")}">${icon('i-trash')}</button>`;
    this.text = this.bar.querySelector('input')!;
    this.bar.querySelector<HTMLButtonElement>('[data-act=mirror]')!.onclick = () => this.mirror();
    this.bar.querySelector<HTMLButtonElement>('[data-act=duplicate]')!.onclick = () => this.duplicate();
    this.bar.querySelector<HTMLButtonElement>('[data-act=remove]')!.onclick = () => this.remove();
    this.text.addEventListener('input', () => this.typed());
    this.text.addEventListener('change', () => { if (this.text.checkValidity()) this.settle(); else this.revertText(); });
    // The handles: the four corners size it, the one above turns it, round as the one that turns a piece of the workshop.
    this.grips = [0, 1, 2, 3].map(corner => this.grip('corner', corner, tr('Tamanho · arraste; com Shift, livre')));
    this.turnGrip = this.grip('turn', null, tr('Girar · arraste, de 15 em 15°; com Shift, livre'), 'turn-handle');
    this.turnGrip.innerHTML = icon('i-rotate');
    host.append(this.panel, ...this.grips, this.turnGrip, this.bar);

    button.onclick = () => this.enabled ? this.close() : this.open();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'] as const)
      canvas.addEventListener(type, event => this.pointer(event), true);
    canvas.addEventListener('pointerleave', () => { if (this.enabled && this.hover) { this.hover = null; this.syncSelection(); } });
    // A double click is the workshop's (it divides plates and removes points); here it only opens a number to type.
    canvas.addEventListener('dblclick', event => {
      if (!this.enabled) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (this.picked?.kind === 'number') { this.text.focus(); this.text.select(); }
    }, true);
    window.addEventListener('keydown', event => this.key(event), true);
    // Taps of the arrows close together are one change; a pause ends it.
    window.addEventListener('keyup', event => {
      if (this.arrows.delete(event.key.toLowerCase()) && !this.arrows.size) this.pause = setTimeout(() => this.settle(), SETTLE_MS);
    }, true);
    window.addEventListener('blur', () => { this.arrows.clear(); this.settle(); });
  }
  // The details of the project as the player has them: those of its appearance, with the one in hand among them.
  get details(): AuthoredDetail[] {
    const stored = this.stored, carried = this.carried;
    if (!carried) return stored;
    const details = stored.filter(detail => detail.id !== carried.detail.id);
    details.splice(Math.min(carried.index, details.length), 0, carried.detail);
    return details;
  }
  get stored(): AuthoredDetail[] { return this.editor().source.appearance?.details || []; }
  get hosts(): DetailHosts {
    const blueprint = this.editor().blueprint;
    if (this.hostSource !== blueprint || this.hostExterior !== this.view.exterior) {
      this.hostSource = blueprint; this.hostExterior = this.view.exterior; this.hostCache = editableDetailHosts(blueprint, this.view.exterior);
    }
    return this.hostCache!;
  }
  get picked() { return this.details.find(detail => detail.id === this.selected); }
  get camera() { return this.renderer.board.camera; }
  // `pixels` of the screen in metres of the drawing, twice as many for a finger.
  reach(pixels: number) { return reach(pixels) / this.camera.zoom; }
  attempt<T>(action: () => T): T | null { try { return action(); } catch (error) { this.toast(projectRefusalMessage(error, this.editor().source), true); this.render(); return null; } }
  grip(role: 'corner' | 'turn', corner: number | null, title: string, className = 'detail-grip') {
    const grip = document.createElement('button'); grip.type = 'button'; grip.className = className; grip.dataset.role = role;
    grip.hidden = true; grip.title = title; grip.setAttribute('aria-label', title); grip.tabIndex = -1;
    grip.addEventListener('pointerdown', event => this.grab(event, role, corner));
    grip.addEventListener('pointermove', event => this.stretch(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) grip.addEventListener(type, event => this.let(event));
    return grip;
  }
  open() {
    if (this.view.mode !== 'edit') return;
    this.attempt(() => {
      this.editor().commit(); this.closePanels();
      if (this.editor().source.appearance?.automaticDetails === undefined) {
        this.editor().previewAppearance(automaticFinish(this.editor().blueprint)); this.editor().commit();
      } else if (!Array.isArray(this.editor().source.appearance?.details)) this.save([]);
      this.enabled = true; this.view.exterior = true; this.selected = null; this.hover = null;
      this.renderer.hoverId = null; this.renderer.edgeHover = null;
      this.render(); this.camera.fit(this.editor().blueprint, true); this.changed();
    });
  }
  close() {
    if (!this.enabled && !this.drag && !this.adding) return;
    if (this.drag && this.drag.kind !== 'pan' && this.drag.moved) this.land(false);
    else if (!this.adding?.dragged) this.settle();
    this.drag = null; this.adding = null; this.carried = null; this.enabled = false; this.hover = null; this.guides = []; this.view.detailEdit = null;
    this.menu(false); this.panel.hidden = true; this.bar.hidden = true;
    for (const grip of [...this.grips, this.turnGrip]) grip.hidden = true;
    this.host.removeAttribute('data-detail-editing');
    this.button.setAttribute('aria-pressed', 'false'); this.canvas.style.cursor = ''; this.changed();
  }
  menu(open: boolean) { this.menuList.hidden = !open; this.more.setAttribute('aria-expanded', String(open)); }
  save(details: AuthoredDetail[], commit = true) {
    const editor = this.editor();
    editor.previewAppearance({ ...editor.source.appearance!, details });
    if (commit) editor.commit();
  }
  replace(next: AuthoredDetail, commit = true) { this.save(this.stored.map(detail => detail.id === next.id ? next : detail), commit); }
  // A detail in hand — moved, sized, turned, nudged by the arrows, brought from the catalogue — is out of the art of its
  // surface, painted once without it, and drawn over it as a picture of its own (render.ts), so that the art is not
  // painted anew at each step of the hand. It goes back in when the hand lets go (land), as one change of the history.
  lift(detail: AuthoredDetail) {
    if (this.carried?.detail.id === detail.id) return;
    const stored = this.stored, index = stored.findIndex(each => each.id === detail.id);
    this.attempt(() => this.editor().commit());
    this.carried = { detail, index: index < 0 ? stored.length : index };
    if (index >= 0) this.attempt(() => this.save(stored.filter(each => each.id !== detail.id), false));
  }
  hold(detail: AuthoredDetail) { this.carried!.detail = detail; this.syncSelection(); }
  // The detail in hand goes back in where it was let go (`keep`), or where it was taken.
  land(keep = true) {
    if (!this.carried) return;
    const details = this.details; this.carried = null;
    this.attempt(() => keep ? this.save(details) : this.editor().cancel());
  }
  // What was changed a step at a time — a number typed, a detail moved by the arrows — is one change of the history,
  // kept when the player goes on to anything else.
  settle() {
    clearTimeout(this.pause);
    if (this.text && this.text.ownerDocument.activeElement === this.text) this.text.blur();
    if (this.carried && !this.drag && !this.adding) this.land();
    if (!this.pending) return;
    this.pending = false; this.attempt(() => this.editor().commit());
  }
  begin() { if (!this.pending) { this.attempt(() => this.editor().commit()); this.pending = true; } }
  setAutomatic(enabled: boolean) {
    this.settle();
    this.attempt(() => {
      const editor = this.editor(), appearance = enabled ? automaticFinish(editor.blueprint, true)
        : editor.source.appearance?.automaticDetails === undefined ? automaticFinish(editor.blueprint) : editor.source.appearance;
      editor.previewAppearance({ ...appearance, automaticDetails: enabled }); editor.commit();
      this.render(); this.changed();
    });
  }
  clearAll() {
    this.settle();
    this.attempt(() => {
      const editor = this.editor(); editor.previewAppearance({ ...editor.source.appearance!, details: [], automaticDetails: false }); editor.commit();
      this.selected = null; this.render(); this.changed();
    });
  }
  removeStrays() {
    this.settle();
    this.attempt(() => { const hosts = this.hosts; this.save(this.details.filter(detail => hostForDetail(hosts, detail))); this.render(); this.changed(); });
  }
  // The catalogue, by groups of pictures in the paint of the project: a press puts the detail in the middle of the view,
  // a drag puts it where it is let go.
  catalogue() {
    const list = this.get('.detail-catalogue');
    for (const group of DETAIL_GROUPS) {
      const section = document.createElement('section'), heading = document.createElement('h3'), kinds = document.createElement('div');
      heading.textContent = tr(group.name); kinds.className = 'detail-kinds';
      for (const kind of group.kinds) {
        const button = document.createElement('button'), name = tr(VEHICLE_DETAILS[kind].name);
        button.type = 'button'; button.dataset.kind = kind; button.dataset.name = name;
        button.setAttribute('aria-label', tr`Adicionar ${name.toLowerCase()}`);
        const picture = document.createElement('canvas'); picture.width = 112; picture.height = 72; picture.setAttribute('aria-hidden', 'true');
        button.append(picture); kinds.append(button);
      }
      section.append(heading, kinds); list.append(section);
    }
    list.addEventListener('pointerdown', event => this.take(event));
    list.addEventListener('pointermove', event => this.carry(event));
    for (const type of ['pointerup', 'pointercancel'] as const) list.addEventListener(type, event => this.drop(event));
    list.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-kind]') : null;
      if (!button || button.disabled) return;
      if (this.dropped) { this.dropped = false; return; }
      this.add(detailKind(button.dataset.kind));
    });
  }
  paintCatalogue(paint: string) {
    if (this.paint === paint) return; this.paint = paint;
    const tone = Number.parseInt(paint.slice(1), 16);
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
      const canvas = button.querySelector('canvas')!, picture = paintDetailCanvas({ kind: detailKind(button.dataset.kind) }, tone),
        scale = Math.min((canvas.width - 8) / picture.width, (canvas.height - 8) / picture.height), w = picture.width * scale, h = picture.height * scale,
        context = canvas.getContext('2d')!;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(picture, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    }
  }
  // The middle of the part of the view no panel covers.
  middle() {
    const camera = this.camera, cover = camera.cover?.() || { top: 0, bottom: 0, left: 0, right: 0 };
    return camera.toWorld((cover.left + camera.width - cover.right) / 2, (cover.top + camera.height - cover.bottom) / 2);
  }
  add(kind: DetailKind) {
    if (this.details.length >= DETAIL_LIMIT) { this.toast(tr`Limite de ${DETAIL_LIMIT} detalhes no projeto.`, true); return; }
    this.settle();
    this.attempt(() => {
      const spot = additionSpot(this.hosts, this.middle());
      if (!spot) { this.toast(tr('O projeto ainda não tem onde pôr detalhes.'), true); return; }
      // Another added there before steps aside, while the surface goes on under it.
      let point = spot.point;
      for (let step = 0; step < 6 && this.details.some(d => {
        const host = hostForDetail(this.hosts, d), pose = host && detailPose(host, d);
        return pose && Math.hypot(pose.x - point.x, pose.y - point.y) < .05;
      }); step++) {
        const next = { x: point.x + .15, y: point.y - .1 };
        if (detailHostAt([spot.host], next)) point = next; else break;
      }
      const detail = detailAt(spot.host, point, kind, makeId('detail'));
      this.save([...this.details, detail]); this.selected = detail.id; this.render(); this.changed();
    });
  }
  // A picture of the catalogue pressed, then dragged out to the drawing. A finger dragging along the column scrolls it.
  take(event: PointerEvent) {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-kind]') : null;
    if (!button || button.disabled || event.button !== 0) return;
    this.settle();
    this.adding = { kind: detailKind(button.dataset.kind), pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      touch: event.pointerType === 'touch', id: makeId('detail'), dragged: false, button };
    try { button.setPointerCapture(event.pointerId); } catch {}
  }
  carry(event: PointerEvent) {
    const adding = this.adding;
    if (!adding || adding.pointerId !== event.pointerId) return;
    if (!adding.dragged) {
      const dx = event.clientX - adding.x, dy = event.clientY - adding.y;
      if (Math.hypot(dx, dy) < DRAG_FROM) return;
      if (adding.touch && Math.abs(dx) < Math.abs(dy) * 1.2) { this.adding = null; return; }
      adding.dragged = true; this.panel.dataset.adding = ''; this.attempt(() => this.editor().commit());
    }
    event.preventDefault();
    this.attempt(() => {
      const box = this.canvas.getBoundingClientRect(), panel = this.panel.getBoundingClientRect(),
        x = event.clientX, y = event.clientY - (adding.touch ? LIFT : 0),
        over = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom && !(x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom),
        point = this.camera.toWorld(x - box.left, y - box.top), host = over && detailHostAt(this.hosts, point);
      if (host) {
        const detail = detailAt(host, point, adding.kind, adding.id);
        this.selected = adding.id; this.lift(detail); this.hold(detail);
      } else if (this.carried) { this.carried = null; this.selected = null; this.syncSelection(); }
    });
  }
  drop(event: PointerEvent) {
    const adding = this.adding;
    if (!adding || adding.pointerId !== event.pointerId) return;
    this.adding = null; delete this.panel.dataset.adding;
    if (!adding.dragged) return;
    this.dropped = true; setTimeout(() => { this.dropped = false; });
    if (this.carried?.detail.id === adding.id && event.type === 'pointerup') this.land();
    else { this.carried = null; if (this.selected === adding.id) this.selected = null; }
    this.render(); this.changed();
  }
  // Whether a finger put down at `point` of the drawing takes hold of a detail (touch.ts): one that does not moves the
  // camera.
  grabs(point: Point) { return Boolean(this.enabled && detailUnder(this.hosts, this.details, point, this.reach(8))); }
  render() {
    if (!this.enabled) return;
    if (this.view.mode !== 'edit') { this.close(); return; }
    this.panel.hidden = false; this.host.setAttribute('data-detail-editing', 'true'); this.button.setAttribute('aria-pressed', 'true');
    if (!this.picked) this.selected = null;
    const appearance = this.editor().source.appearance, count = this.details.length, full = count >= DETAIL_LIMIT,
      strays = strayDetails(this.hosts, this.details).length, output = this.get('output');
    output.textContent = `${count}/${DETAIL_LIMIT}`; output.toggleAttribute('data-full', full);
    output.title = full ? tr`Limite de ${DETAIL_LIMIT} detalhes atingido` : tr`${count} de ${DETAIL_LIMIT} detalhes`;
    this.get('[data-automatic]').setAttribute('aria-checked', String(appearance?.automaticDetails !== false));
    this.get('[data-stray]').hidden = !strays;
    this.get('[data-stray] span').textContent = strays === 1 ? tr('Remover 1 detalhe sem lugar') : tr`Remover ${strays} detalhes sem lugar`;
    this.get<HTMLButtonElement>('[data-clear]').disabled = !count;
    if (this.full !== full) {
      this.full = full;
      for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
        button.disabled = full;
        button.title = full ? tr`${button.dataset.name ?? ''} · limite de ${DETAIL_LIMIT} detalhes` : tr`${button.dataset.name ?? ''} · clique para pôr no meio da vista ou arraste até o veículo`;
      }
    }
    this.paintCatalogue(appearance?.paint || '#68765a');
    this.syncSelection();
    const detail = this.picked;
    if (!detail) return;
    this.bar.querySelector<HTMLElement>('.detail-name')!.textContent = tr(VEHICLE_DETAILS[detail.kind].name);
    this.bar.querySelector<HTMLElement>('.detail-text')!.hidden = detail.kind !== 'number';
    this.bar.querySelector<HTMLButtonElement>('[data-act=mirror]')!.hidden = detail.kind === 'number';
    this.bar.querySelector<HTMLButtonElement>('[data-act=duplicate]')!.disabled = full;
    if (document.activeElement !== this.text) this.text.value = detail.text || '01';
  }
  // What the drawing shows of the details being edited (render.ts): the detail picked on its surface, the one under the
  // mouse, the outlines of those that do not show, and the lines a moved one settles on.
  syncSelection() {
    if (!this.enabled) { this.view.detailEdit = null; return; }
    const hosts = this.hosts, outline = (detail: AuthoredDetail | undefined) => { const host = detail && hostForDetail(hosts, detail); return host ? detailCorners(host, detail) : null; },
      picked = this.picked, host = picked && hostForDetail(hosts, picked),
      carried = this.carried?.detail, under = carried && hostForDetail(hosts, carried);
    this.view.detailEdit = { corners: outline(picked), host: host?.polygon,
      // The detail in hand, faint where nothing of it would show as it would be let go.
      carried: under ? { detail: carried, pose: detailPose(under, carried), hidden: hiddenDetail(under, carried),
        paint: Number.parseInt((this.editor().source.appearance?.paint || '#68765a').slice(1), 16) } : null,
      hover: this.hover && this.hover !== this.selected ? outline(this.details.find(d => d.id === this.hover)) : null,
      ghosts: this.details.flatMap(detail => {
        if (detail.id === this.selected) return [];
        const at = hostForDetail(hosts, detail);
        return at && hiddenDetail(at, detail) ? [detailCorners(at, detail)] : [];
      }), guides: this.guides };
  }
  // The handles and the bar stand by the detail picked, each frame, where the camera puts it.
  follow() {
    if (!this.enabled) return;
    const detail = this.picked, host = detail && hostForDetail(this.hosts, detail),
      moving = this.drag && this.drag.kind !== 'pan' && this.drag.moved || this.adding?.dragged;
    for (const grip of [...this.grips, this.turnGrip]) grip.hidden = !host || Boolean(this.adding?.dragged) || this.drag?.kind === 'move' && this.drag.moved;
    this.bar.hidden = !host || Boolean(moving);
    if (!host || !detail) return;
    const camera = this.camera, pose = detailPose(host, detail), clear = this.reach(GRIP_CLEAR),
      w = Math.max(detail.width, 2 * clear), h = Math.max(detail.height, 2 * clear),
      corners = rectangle(pose.x, pose.y, w, h, pose.angle).map(p => camera.toScreen(p.x, p.y)),
      lift = h / 2 + this.reach(TURN_LIFT), turn = camera.toScreen(pose.x - Math.sin(pose.angle) * lift, pose.y + Math.cos(pose.angle) * lift),
      centre = camera.toScreen(pose.x, pose.y), place = (element: HTMLElement, x: number, y: number) => {
        const left = x.toFixed(1) + 'px', top = y.toFixed(1) + 'px';
        if (element.style.left !== left) element.style.left = left;
        if (element.style.top !== top) element.style.top = top;
      };
    corners.forEach((corner, i) => {
      place(this.grips[i]!, corner.x, corner.y);
      const cursor = (corner.x - centre.x) * (corner.y - centre.y) > 0 ? 'nwse-resize' : 'nesw-resize';
      if (this.grips[i]!.style.cursor !== cursor) this.grips[i]!.style.cursor = cursor;
    });
    place(this.turnGrip, turn.x, turn.y);
    if (this.bar.hidden) return;
    const cover = camera.cover?.() || { top: 0, bottom: 0, left: 0, right: 0 }, ys = [...corners, turn].map(p => p.y),
      width = this.bar.offsetWidth, height = this.bar.offsetHeight, gap = reach(10),
      low = cover.left + 8 + width / 2, high = camera.width - cover.right - 8 - width / 2,
      above = Math.min(...ys) - gap, below = Math.max(...ys) + gap + height;
    place(this.bar, clamp(centre.x, low, Math.max(low, high)),
      above - height >= cover.top + 4 || below > camera.height - cover.bottom ? Math.max(above, cover.top + 4 + height) : below);
  }
  hovering(event: PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    const hit = detailUnder(this.hosts, this.details, this.at(event), this.reach(6)), id = hit?.id ?? null;
    this.canvas.style.cursor = hit ? 'move' : '';
    if (id !== this.hover) { this.hover = id; this.syncSelection(); }
  }
  at(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return this.camera.toWorld(event.clientX - rect.left, event.clientY - rect.top);
  }
  pointer(event: PointerEvent) {
    if (!this.enabled || this.view.mode !== 'edit') return;
    const drag = this.drag;
    if (event.type === 'pointermove' && !drag) {
      // A drag of the workshop's own (the middle button moves the camera) goes on; the hover of plates is not shown.
      if (event.buttons) return;
      event.stopImmediatePropagation(); this.hovering(event); return;
    }
    if (event.type === 'pointerdown' && (event.button !== 0 || event.altKey)) return;
    if (event.type !== 'pointerdown' && (!drag || drag.pointerId !== event.pointerId || !['move', 'pan'].includes(drag.kind))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    this.attempt(() => {
      if (event.type === 'pointerdown') {
        this.settle();
        const point = this.at(event), picked = detailUnder(this.hosts, this.details, point, this.reach(8));
        this.selected = picked?.id || null; this.hover = null;
        const host = picked && hostForDetail(this.hosts, picked), pose = host && detailPose(host, picked);
        const initial = { pointerId: event.pointerId, point, clientX: event.clientX, clientY: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
        this.drag = picked && host && pose ? { ...initial, kind: 'move', detail: picked, host, pose } : { ...initial, kind: 'pan', detail: null, host: null, pose: null };
        try { this.canvas.setPointerCapture(event.pointerId); } catch {}
        this.canvas.style.cursor = picked ? 'move' : '';
        this.render();
      } else if (event.type === 'pointermove' && drag && (drag.kind === 'pan' || drag.kind === 'move')) {
        if (drag.kind === 'pan') {
          this.renderer.camera.pan(event.clientX - drag.clientX, event.clientY - drag.clientY);
          drag.clientX = event.clientX; drag.clientY = event.clientY; return;
        }
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < STILL) return;
        drag.moved = true;
        const { detail, guides } = movedDetail(this.hosts, this.details, drag, this.at(event), { reach: this.reach(6), free: event.shiftKey });
        this.guides = guides; this.lift(drag.detail); this.hold(detail);
      } else {
        this.drag = null; this.guides = [];
        if (drag?.kind === 'move' && drag.moved) this.land(event.type === 'pointerup');
        if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        this.render();
      }
    });
  }
  // A handle pressed: a corner sizes the detail from the opposite one, the handle above turns it about its middle.
  grab(event: PointerEvent, role: 'corner' | 'turn', corner: number | null) {
    const detail = this.picked, host = detail && hostForDetail(this.hosts, detail);
    if (event.button !== 0 || !host || !detail) return;
    event.preventDefault(); event.stopPropagation();
    this.settle(); this.attempt(() => this.editor().commit());
    this.drag = { kind: role, corner, pointerId: event.pointerId, detail, host, pose: detailPose(host, detail),
      start: this.at(event), from: corner === null ? null : detailCorners(host, detail)[corner]!, moved: false };
    try { if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  }
  stretch(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId || (drag.kind !== 'corner' && drag.kind !== 'turn')) return;
    this.attempt(() => {
      const at = this.at(event), pose = drag.kind === 'corner'
        ? resizedPose(drag.pose, drag.detail, drag.corner!, { x: drag.from!.x + at.x - drag.start.x, y: drag.from!.y + at.y - drag.start.y }, drag.detail.kind, event.shiftKey)
        : { ...drag.pose, angle: turnedAngle(drag.pose, at, event.shiftKey) };
      drag.moved = true; this.lift(drag.detail); this.hold(placedDetail(drag.detail, drag.host, pose));
    });
  }
  let(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId || (drag.kind !== 'corner' && drag.kind !== 'turn')) return;
    this.drag = null;
    if (drag.moved) this.land(event.type === 'pointerup');
    this.render(); this.changed();
  }
  typed() {
    const detail = this.picked;
    if (!detail || !this.text.checkValidity()) return;
    this.begin(); this.attempt(() => this.replace({ ...detail, text: this.text.value }, false));
  }
  revertText() {
    if (this.pending) { this.pending = false; this.attempt(() => this.editor().cancel()); }
    this.text.value = this.picked?.text || '01'; this.render();
  }
  mirror() { const detail = this.picked; if (!detail) return; this.settle(); this.attempt(() => this.replace(mirroredDetail(detail))); this.render(); }
  remove() {
    const id = this.selected;
    if (!id) return;
    this.settle();
    this.attempt(() => { this.save(this.details.filter(detail => detail.id !== id)); this.selected = null; this.render(); this.changed(); });
  }
  duplicate() {
    if (!this.picked || this.details.length >= DETAIL_LIMIT) return;
    this.settle();
    this.attempt(() => {
      const detail = copiedDetail(this.picked!, makeId('detail'));
      this.save([...this.details, detail]); this.selected = detail.id; this.render(); this.changed();
    });
  }
  copy() { if (this.picked) clipboard = structuredClone(this.picked); }
  paste() {
    if (!clipboard) return;
    if (this.details.length >= DETAIL_LIMIT) { this.toast(tr`Limite de ${DETAIL_LIMIT} detalhes no projeto.`, true); return; }
    this.settle();
    this.attempt(() => {
      const id = makeId('detail'), copy = copiedDetail(clipboard!, id), host = hostForDetail(this.hosts, copy);
      let detail = copy;
      // A copy whose surface this project does not have goes in the middle of the view, as it was.
      if (!host || hiddenDetail(host, copy)) {
        const spot = additionSpot(this.hosts, this.middle());
        if (!spot) return;
        detail = { ...detailAt(spot.host, spot.point, copy.kind, id), width: copy.width, height: copy.height,
          ...(copy.text ? { text: copy.text } : {}), ...(copy.mirrored ? { mirrored: true } : {}) };
      }
      this.save([...this.details, detail]); clipboard = structuredClone(detail); this.selected = id; this.render(); this.changed();
    });
  }
  // The arrows move the detail picked a centimetre, ten with Shift, as the screen shows it.
  nudge(key: string, far: boolean) {
    const detail = this.picked, host = detail && hostForDetail(this.hosts, detail);
    if (!host || !detail) return;
    const [dx, dy] = ARROWS[key]!, step = far ? .1 : .01, pose = detailPose(host, detail), turn = this.camera.turn ?? 1;
    clearTimeout(this.pause); this.lift(detail);
    this.hold(placedDetail(detail, host, { ...pose, x: pose.x + dx * step * turn, y: pose.y + dy * step }));
  }
  // Esc and C let go of what is under way, then of the detail picked, then of the mode.
  cancel() {
    if (this.drag) {
      const drag = this.drag; this.drag = null; this.guides = [];
      if (drag.kind !== 'pan' && drag.moved) this.land(false);
    } else if (this.adding) {
      const adding = this.adding; this.adding = null; delete this.panel.dataset.adding;
      if (adding.dragged) { this.dropped = true; this.carried = null; if (this.selected === adding.id) this.selected = null; }
    } else if (!this.menuList.hidden) this.menu(false);
    else if (this.selected) { this.settle(); this.selected = null; }
    else { this.close(); return; }
    this.render(); this.changed();
  }
  key(event: KeyboardEvent) {
    if (!this.enabled || this.view.mode !== 'edit' || [...document.querySelectorAll('dialog')].some(dialog => dialog.open)) return;
    const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (event.target === this.text) {
      if (event.key === 'Escape') { stop(); this.revertText(); this.text.blur(); }
      else if (event.key === 'Enter') { stop(); this.text.blur(); }
      return;
    }
    if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const key = event.key.toLowerCase(), ctrl = event.ctrlKey || event.metaKey;
    // Any key but the arrows and those held with them — undo, save — finds the detail they moved back in the project.
    if (this.carried && !this.drag && !this.adding && !ARROWS[key] && !['shift', 'control', 'alt', 'meta'].includes(key)) this.settle();
    if (cancels(event)) { stop(); this.cancel(); return; }
    if (ctrl && key === 'v' && clipboard) { stop(); this.paste(); return; }
    if (!this.picked) return;
    if (removes(event)) { stop(); this.remove(); }
    else if (ctrl && key === 'd') { stop(); this.duplicate(); }
    else if (ctrl && key === 'c') { stop(); this.copy(); }
    else if (ARROWS[key] && !ctrl && !event.altKey) { stop(); this.arrows.add(key); this.nudge(key, event.shiftKey); }
  }
}
