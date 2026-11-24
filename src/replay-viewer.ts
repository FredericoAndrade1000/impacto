import { isLanguagePreference, languageURL, locale, preferredLanguage, tr, translate } from './i18n.ts';
import { Renderer } from './render.ts';
import type { RenderFieldView } from './render.ts';
import { SceneFrameReader } from './network-protocol.ts';
import { decodeDrawingEvents, decodeRenderFieldView } from './scene-drawing-codec.ts';
import { REPLAY_VERSION, replayPackets, replayTelemetry } from './replay-contract.ts';
import type { ReplayArchive, ReplayEntry, ReplayJob, ReplayMarker } from './replay-contract.ts';
import { ReplayPlayer, replayFrameTime } from './replay-player.ts';
import type { ReplayFrame } from './replay-player.ts';
import { replayActivityText, replayDecisionText } from './replay-labels.ts';

const element = <T extends HTMLElement>(id: string): T => { const node = document.getElementById(id); if (!node) throw new Error(id); return node as T; },
  recordings = element<HTMLSelectElement>('recordings'), factions = element<HTMLSelectElement>('factions'), units = element<HTMLSelectElement>('units'),
  timeline = element<HTMLInputElement>('timeline'), play = element<HTMLButtonElement>('play'), open = element<HTMLButtonElement>('open'),
  cancel = element<HTMLButtonElement>('cancel'), followButton = element<HTMLButtonElement>('follow'), focusButton = element<HTMLButtonElement>('focus'),
  chapters = element<HTMLSelectElement>('chapters'), structures = element<HTMLInputElement>('structures'),
  viewport = element('viewport'), map = element('map'), renderer = new Renderer<RenderFieldView>(viewport, { mode: 'test', testTool: 'inspect', weapon: { platform: 'vehicle' } });
let entries: ReplayEntry[] = [], player: ReplayPlayer<RenderFieldView> | null = null, playing = false, speed = 1,
  busy = false, following: string | null = null, selected = '', wanted: number | null = null, revision = 0, opening = false,
  markerKey = '', mapLeft = 0, mapRight = 1, pendingFocus: ReplayMarker | null = null, drawingFailed = false;
let unitKey: string | null = null, factionKey: string | null = null;
const status = (text: string) => { element('status').textContent = text; };
const errorText = (error: unknown): string => translate(error instanceof Error ? error.message : String(error));
const timeText = (seconds: number) => {
  const n = Math.max(0, Math.floor(seconds + 1e-6)); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
};
const number = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 0 });
async function api<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch('/api/replay/' + path, { method });
  if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? String(response.status)); }
  return response.json() as Promise<T>;
}
function option(value: string, text: string, disabled = false): HTMLOptionElement { const node = new Option(text, value); node.disabled = disabled; return node; }
const orderText = (order: string) => ({ attack: tr('Atacando'), haul: tr('Transportando'), home: tr('Voltando à base'), move: tr('Em deslocamento'), idle: tr('Sem deslocamento') }[order] ?? order);
function setPlaying(on: boolean): void {
  playing = on && Boolean(player); play.textContent = playing ? tr('Pausar') : tr('Reproduzir'); play.setAttribute('aria-pressed', String(playing));
}
function seek(time: number): void {
  if (!player) return;
  wanted = Math.max(player.archive.start, Math.min(player.archive.end, time)); revision++; player.cancel();
}
async function catalog(): Promise<void> {
  const before = recordings.value;
  entries = await api<ReplayEntry[]>('catalog');
  recordings.replaceChildren(...entries.map(entry => option(entry.id,
    `${entry.kind === 'complete' ? `${entry.name} · ${tr('Replay completo · {0} capítulos', entry.chapters)}` : entry.at ? new Date(entry.at).toLocaleString(locale()) : entry.name} · ${timeText(entry.end - entry.start)}${entry.compatible ? '' : ' · ' + (entry.reason === 'core' ? tr('Outro núcleo') : entry.reason === 'long' ? tr('Trecho muito longo') : tr('Outra versão'))}`, !entry.compatible)));
  if (player?.archive.id === before) recordings.add(preparedOption(player.archive));
  const initial = entries.find(entry => entry.compatible && entry.end > entry.start);
  recordings.value = player?.archive.id === before || entries.some(entry => entry.id === before && entry.compatible) ? before : initial?.id ?? '';
  open.disabled = !recordings.value || opening;
  if (!entries.length) status(tr('Nenhuma gravação encontrada nas pastas configuradas.'));
}
function preparedOption(archive: ReplayArchive): HTMLOptionElement {
  return option(archive.id, (archive.chapters ? `${archive.name === 'complete' ? '' : archive.name + ' · '}${tr('Replay completo · {0} capítulos', archive.chapters.length)}` : archive.name) + ' · ' + timeText(archive.end - archive.start));
}
async function loadChunk(archive: ReplayArchive, index: number): Promise<readonly ReplayFrame<RenderFieldView>[]> {
  const response = await fetch(`/api/replay/chunk/${archive.id}/${index}`);
  if (!response.ok) throw new Error(tr('Não foi possível carregar este trecho.'));
  const reader = new SceneFrameReader(decodeRenderFieldView), frames: ReplayFrame<RenderFieldView>[] = [];
  const expected = archive.chunks[index], chapter = expected?.chapter === undefined ? undefined : archive.chapters?.[expected.chapter];
  for (const packet of replayPackets(await response.arrayBuffer())) {
    const frame = reader.decode(packet);
    if (!frame || frames.at(-1) && frame.state.time <= frames.at(-1)!.state.time) throw new Error(tr('Sequência de quadros inválida.'));
    frames.push({ state: frame.state, events: decodeDrawingEvents(frame.events), telemetry: replayTelemetry(frame.telemetry),
      ...(chapter ? { time: frame.state.time + chapter.from - chapter.worldFrom, chapter: expected!.chapter } : {}) });
  }
  if (!expected || frames.length !== expected.frames || Math.abs(replayFrameTime(frames[0]!) - expected.from) > 1e-6 || Math.abs(replayFrameTime(frames.at(-1)!) - expected.to) > 1e-6)
    throw new Error(tr('Intervalo do trecho inválido.'));
  return frames;
}
async function showArchive(archive: ReplayArchive): Promise<void> {
  if (archive.version !== REPLAY_VERSION || !archive.chunks.length) throw new Error(tr('A gravação não contém quadros visuais confirmados.'));
  player?.cancel(); setPlaying(false); selected = ''; following = null; unitKey = factionKey = null; markerKey = '';
  drawingFailed = false;
  const next = new ReplayPlayer(archive, index => loadChunk(archive, index), {
    reset: () => renderer.clearScene(), receive: (frame, previousTime) => renderer.receive(frame.state, frame.events, { now: previousTime * 1000, pace: 1 }),
  });
  player = next; revision++; wanted = null;
  await next.show(archive.start, true);
  renderer.camera.minZoom = 1; renderer.camera.zoom = 48;
  const first = next.frame?.state.actors.find(actor => !actor.defeated);
  if (first) { selected = first.id; center(first.x, first.y ?? first.vehicle?.y); }
  else center(0);
  element('empty').hidden = true;
  for (const id of ['play', 'back', 'next', 'timeline', 'factions', 'units']) element<HTMLButtonElement>(id).disabled = false;
  timeline.min = String(archive.start); timeline.max = String(archive.end); timeline.value = String(archive.start);
  chapters.hidden = !archive.chapters;
  chapters.replaceChildren(...(archive.chapters ?? []).map((chapter, i) => option(String(i), tr('Capítulo {0} · {1}', i + 1, timeText(chapter.from)))));
  for (const kept of [...recordings.options]) if (kept.value === archive.id) kept.remove();
  recordings.add(preparedOption(archive)); recordings.value = archive.id;
  element('verification').textContent = archive.status === 'verified' ? tr('Replay verificado') : tr('Reprodução parcial');
  element('detail').textContent = archive.detail ? translate(archive.detail) : tr('Visão de observador sem neblina de guerra.');
  update(); status(tr('Pronto · {0} verificações', archive.prints));
}
async function watchJob(job: ReplayJob): Promise<void> {
  opening = true; open.disabled = true; cancel.hidden = false; setPlaying(false);
  try {
    while (job.status === 'preparing') {
      status(tr('Preparando replay · {0} / {1}', timeText(job.time), timeText(job.end)));
      await new Promise(resolve => setTimeout(resolve, 350)); job = await api<ReplayJob>('status');
    }
    if (job.status === 'error') throw new Error(job.error);
    if (job.status === 'ready') { recordings.value = job.id; await showArchive(job.archive); }
    else status(tr('Preparação cancelada.'));
  } catch (error) { status(errorText(error)); }
  finally { opening = false; open.disabled = !recordings.value; cancel.hidden = true; }
}
async function prepare(): Promise<void> {
  if (!recordings.value || opening) return;
  opening = true; open.disabled = true;
  try {
    if (/^[a-f0-9]{24}$/.test(recordings.value)) { await showArchive(await api<ReplayArchive>('archive/' + recordings.value)); opening = false; open.disabled = false; }
    else await watchJob(await api<ReplayJob>('prepare?id=' + encodeURIComponent(recordings.value), 'POST'));
  }
  catch (error) { opening = false; open.disabled = !recordings.value; status(errorText(error)); }
}
function center(x: number, y?: number): void {
  renderer.camera.x = x; renderer.camera.y = (y ?? renderer.ground?.height(x) ?? 0) + 1;
}
function focus(id: string, follow = false): void {
  const actor = player?.frame?.state.actors.find(actor => actor.id === id);
  if (!actor) return;
  selected = id; units.value = id; following = follow ? id : null;
  if (renderer.camera.zoom < 8) renderer.camera.zoom = 48;
  center(actor.vehicle?.x ?? actor.x, actor.vehicle?.y ?? actor.y); updateSelection();
}
function updateSelection(): void {
  const unit = player?.frame?.telemetry.units.find(unit => unit.id === selected);
  focusButton.disabled = followButton.disabled = !unit;
  followButton.setAttribute('aria-pressed', String(Boolean(unit && following === unit.id)));
  const info = element('unit-info'); info.replaceChildren();
  if (!unit) { info.textContent = tr('Selecione um veículo para ver sua atividade.'); return; }
  const paragraph = (text: string, className = '') => { const p = document.createElement('p'); p.textContent = text; p.className = className; info.append(p); };
  paragraph(orderText(unit.order), 'unit-order');
  paragraph(`${tr('Integridade')} ${number(unit.health * 100)}% · ${tr('Combustível')} ${number(unit.fuel)} L`, 'unit-stats');
  if (unit.activity || unit.reason) paragraph(replayActivityText(unit.activity || unit.reason));
  if (unit.activity && unit.reason && unit.activity !== unit.reason) paragraph(replayActivityText(unit.reason));
  const actor = player?.frame?.state.actors.find(actor => actor.id === selected);
  if (actor) paragraph(`x ${number(actor.x)} m${unit.goal === null ? '' : ' · ' + tr('Destino') + ' ' + number(unit.goal) + ' m'}`);
}
function updateFactions(): void {
  const telemetry = player?.frame?.telemetry; if (!telemetry) return;
  const key = telemetry.factions.map(f => f.id + f.name).join('|');
  if (key !== factionKey) {
    const previous = factions.value; factions.replaceChildren(option('', tr('Todas as facções')), ...telemetry.factions.map(f => option(f.id, f.name)));
    factions.value = telemetry.factions.some(f => f.id === previous) ? previous : ''; factionKey = key;
  }
  const faction = telemetry.factions.find(f => f.id === factions.value), info = element('faction-info'); info.replaceChildren();
  if (!faction) info.textContent = tr('{0} facções · observação de todo o campo', telemetry.factions.length);
  const duelFaction = faction ?? telemetry.factions.find(f => f.duel?.phase === 'won') ?? telemetry.factions.find(f => f.duel),
    outcome = element('duel-result');
  outcome.hidden = !duelFaction?.duel;
  if (duelFaction?.duel) {
    const phase = duelFaction.duel.phase;
    outcome.textContent = phase === 'playing' ? tr('Duelo · capture a base principal') :
      replayDecisionText('duel-' + phase) + (!faction && phase === 'won' ? ' · ' + duelFaction.name : '');
  }
  if (!faction) return;
  const stock = document.createElement('div'); stock.className = 'stock';
  for (const [name, value] of [[tr('Ferro'), faction.stock.ferro], [tr('Ligas'), faction.stock.ligas], [tr('Sílica'), faction.stock.silica], [tr('Combustível'), faction.stock.combustivel]] as const) {
    const cell = document.createElement('span'), amount = document.createElement('b'); cell.textContent = name + ' '; amount.textContent = number(value); cell.append(amount); stock.append(cell);
  }
  info.append(stock);
  if (faction.reason) { const reason = document.createElement('p'); reason.className = 'ai-reason'; reason.textContent = replayDecisionText(faction.reason); info.append(reason); }
}
function updateUnits(): void {
  const frame = player?.frame; if (!frame) return;
  const filtered = frame.telemetry.units.filter(unit => (!factions.value || unit.factionId === factions.value) &&
    (!structures.checked || frame.state.actors.some(actor => actor.id === unit.id && actor.preset === 'bunker'))), key = filtered.map(unit => unit.id + unit.name).join('|');
  if (key !== unitKey) {
    units.replaceChildren(...filtered.map(unit => { const actor = frame.state.actors.find(actor => actor.id === unit.id);
      return option(unit.id, `${actor?.preset === 'bunker' ? '▣' : '●'} ${translate(unit.name)}`); }));
    if (!filtered.some(unit => unit.id === selected)) selected = filtered[0]?.id ?? '';
    units.value = selected; unitKey = key;
  }
  element('unit-count').textContent = String(filtered.length); updateSelection();
}
function markerFaction(marker: ReplayMarker): string | null | undefined {
  return marker.factionId ?? player?.frame?.telemetry.units.find(unit => unit.id === marker.actorId)?.factionId;
}
function markerLabel(marker: ReplayMarker): string {
  const faction = player?.frame?.telemetry.factions.find(f => f.id === markerFaction(marker)),
    label = marker.kind === 'shot' ? tr('Disparo') : marker.kind === 'loss' ? tr('Perda · {0}', translate(marker.label)) :
      marker.kind === 'structure' ? tr('Estrutura · {0}', translate(marker.label)) : marker.kind === 'base' ? tr('Base · {0}', marker.label) :
      marker.kind === 'chapter' ? tr('Capítulo {0}', marker.label) : replayDecisionText(marker.label);
  return faction && !factions.value ? `${faction.name} · ${label}` : label;
}
function updateMarkers(): void {
  if (!player) return;
  const all = player.archive.markers.filter(marker => (!factions.value || markerFaction(marker) === factions.value) &&
    (!structures.checked || marker.kind === 'structure' || marker.kind === 'base')), at = all.findIndex(marker => marker.time > player!.time),
    cursor = at < 0 ? all.length : at, visible = all.slice(Math.max(0, cursor - 5), cursor + 15), key = `${factions.value}|${structures.checked}|${unitKey}|${cursor}`;
  element('marker-count').textContent = String(all.length);
  if (key === markerKey) return; markerKey = key;
  element('events').replaceChildren(...visible.map(marker => {
    const button = document.createElement('button'), time = document.createElement('time'), text = document.createElement('span');
    button.className = 'event' + (marker.time > player!.time ? ' future' : ''); time.textContent = timeText(marker.time); text.textContent = markerLabel(marker);
    button.append(time, text); button.onclick = () => { seek(marker.time + 1 / player!.archive.fps); pendingFocus = marker; }; return button;
  }));
  if (!visible.length) element('events').textContent = tr('Nenhum evento registrado neste trecho.');
}
function updateMap(): void {
  const frame = player?.frame; if (!frame) return;
  const positions = [...frame.state.actors.map(actor => actor.x), ...frame.telemetry.factions.flatMap(f => f.base === null ? [] : [f.base])];
  mapLeft = positions.length ? Math.min(...positions) - 500 : -500; mapRight = positions.length ? Math.max(...positions) + 500 : 500;
  element('map-span').textContent = `${((mapRight - mapLeft) / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })} km`;
  const markers: HTMLElement[] = [], mark = (x: number, name: string, color: string, className: string, click: () => void) => {
    const node = document.createElement('button'); node.className = 'map-mark ' + className; node.style.left = `${(x - mapLeft) / (mapRight - mapLeft) * 100}%`;
    node.style.setProperty('--color', /^#[a-f0-9]{3,8}$/i.test(color) ? color : '#b4c889'); node.title = name; node.setAttribute('aria-label', name); node.onclick = click; markers.push(node);
  };
  for (const faction of frame.telemetry.factions) if (faction.base !== null) mark(faction.base, faction.name, faction.color, 'base', () => { following = null; renderer.camera.zoom = 4; center(faction.base!); factions.value = faction.id; unitKey = ''; update(); });
  for (const actor of frame.state.actors) mark(actor.x, translate(actor.name ?? actor.id), actor.color ?? '', (actor.preset === 'bunker' ? 'structure ' : '') + (actor.id === selected ? 'selected' : ''), () => focus(actor.id));
  element('map-marks').replaceChildren(...markers);
}
function updateMapWindow(): void {
  const span = mapRight - mapLeft, half = renderer.camera.width / renderer.camera.zoom / 2,
    left = Math.max(0, (renderer.camera.x - half - mapLeft) / span), right = Math.min(1, (renderer.camera.x + half - mapLeft) / span);
  const window = element('map-window'); window.style.left = `${left * 100}%`; window.style.width = `${Math.max(0, right - left) * 100}%`;
}
function update(): void {
  if (!player) return;
  timeline.value = String(player.time); element('clock').textContent = `${timeText(player.time)} / ${timeText(player.archive.end)}`;
  if (player.chapterIndex !== undefined) {
    chapters.value = String(player.chapterIndex);
    element('detail').textContent = tr('Capítulo {0}/{1} · relógio do campo {2}', player.chapterIndex + 1, player.archive.chapters!.length, timeText(player.worldTime));
  }
  updateFactions(); updateUnits(); updateMarkers(); updateMap();
}
open.onclick = () => { void prepare(); }; recordings.onchange = () => { open.disabled = !recordings.value || opening; };
cancel.onclick = () => { void api('cancel', 'POST').catch(error => status(errorText(error))); };
element('refresh').onclick = () => { void catalog().catch(error => status(errorText(error))); };
play.onclick = () => { if (player && player.time >= player.archive.end) seek(player.archive.start); setPlaying(!playing); };
element('back').onclick = () => { if (player) { setPlaying(false); seek(player.time - 1); } };
element('next').onclick = () => { if (player) { setPlaying(false); seek(player.time + 1); } };
timeline.oninput = () => { setPlaying(false); seek(Number(timeline.value)); };
timeline.onkeydown = event => {
  if (!player || !['ArrowLeft', 'ArrowRight'].includes(event.code)) return;
  event.preventDefault(); setPlaying(false); seek(player.time + (event.code === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1));
};
element<HTMLSelectElement>('speed').onchange = event => { speed = parseFloat((event.target as HTMLSelectElement).value); };
factions.onchange = () => { unitKey = ''; following = null; update(); };
structures.onchange = () => { unitKey = null; markerKey = ''; following = null; update(); };
chapters.onchange = () => { if (player) { setPlaying(false); seek(player.archive.chapters![Number(chapters.value)]!.from); } };
units.onchange = () => { selected = units.value; following = null; updateSelection(); };
focusButton.onclick = () => focus(selected); followButton.onclick = () => { if (following) { following = null; updateSelection(); } else focus(selected, true); };
const language = element<HTMLSelectElement>('language'); language.value = preferredLanguage();
language.onchange = () => {
  if (isLanguagePreference(language.value)) location.href = languageURL(language.value, { url: location.href });
};
map.addEventListener('click', event => { if ((event.target as Element).closest('button')) return; const rect = map.getBoundingClientRect(); following = null; center(mapLeft + (event.clientX - rect.left) / rect.width * (mapRight - mapLeft)); updateSelection(); });
let drag: { x: number; y: number; moved: boolean } | null = null;
viewport.addEventListener('pointerdown', event => { if (!player || event.button !== 0) return; drag = { x: event.clientX, y: event.clientY, moved: false }; viewport.setPointerCapture(event.pointerId); });
viewport.addEventListener('pointermove', event => {
  if (!drag) return; const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  drag.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
  if (drag.moved) { following = null; renderer.camera.pan(dx, dy); } drag.x = event.clientX; drag.y = event.clientY;
});
viewport.addEventListener('pointerup', event => {
  if (drag && !drag.moved && renderer.scene) {
    const rect = viewport.getBoundingClientRect(), at = renderer.camera.toWorld(event.clientX - rect.left, event.clientY - rect.top),
      actor = [...renderer.scene.frame.actors.values()].sort((a, b) => Math.hypot(a.x - at.x, (a.y ?? a.vehicle?.y ?? 0) - at.y) - Math.hypot(b.x - at.x, (b.y ?? b.vehicle?.y ?? 0) - at.y))[0];
    if (actor && Math.abs(actor.x - at.x) < 12) { selected = actor.id; units.value = selected; updateSelection(); }
  }
  drag = null; updateSelection();
});
viewport.addEventListener('pointercancel', () => { drag = null; });
viewport.addEventListener('wheel', event => { event.preventDefault(); const rect = viewport.getBoundingClientRect(); renderer.camera.zoomAt(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
window.addEventListener('keydown', event => {
  if ((event.target as Element).closest('input,select,button') || !player) return;
  if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); setPlaying(false); seek(player.time + (event.code === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1)); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });

let before = performance.now(), updated = 0;
function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = Math.min(.1, Math.max(0, (now - before) / 1000)); before = now;
  if (!player || !renderer.ready || drawingFailed) return;
  if (!busy && (wanted !== null || playing) && !opening) {
    const current = player, reset = wanted !== null, at = wanted ?? Math.min(current.archive.end, current.time + dt * speed), requestRevision = revision, chapter = current.chapterIndex;
    wanted = null; busy = true;
    void current.show(at, reset).then(shown => {
      if (shown && current === player && requestRevision === revision) {
        if (current.time >= current.archive.end) setPlaying(false);
        if (reset || chapter !== current.chapterIndex) {
          renderer.camera.follow(null);
          if (pendingFocus?.actorId) focus(pendingFocus.actorId);
          else if (pendingFocus?.x !== undefined) { following = null; if (pendingFocus.kind === 'base') renderer.camera.zoom = 4; center(pendingFocus.x, pendingFocus.y); }
          else if (following) focus(following, true);
          pendingFocus = null; update();
        }
      }
    }).catch(error => { status(errorText(error)); setPlaying(false); }).finally(() => { busy = false; });
  }
  try { renderer.draw({ now: player.worldTime * 1000, follow: following }); }
  catch (error) { drawingFailed = true; setPlaying(false); status(errorText(error)); console.error(error); return; }
  updateMapWindow();
  if (now - updated >= 250) { update(); updated = now; }
}
try {
  status(tr('Carregando gravações...'));
  await Promise.all([renderer.init(), catalog()]);
  requestAnimationFrame(tick);
  const requested = new URLSearchParams(location.search).get('replay');
  if (requested && /^[a-f0-9]{24}$/.test(requested)) await showArchive(await api<ReplayArchive>('archive/' + requested));
  else { const state = await api<ReplayJob>('status'); if (state.status === 'ready' || state.status === 'preparing') await watchJob(state);
  else if (entries.length) status(tr('Escolha uma gravação para começar.'));
  }
} catch (error) { status(errorText(error)); element('empty').textContent = errorText(error); }
