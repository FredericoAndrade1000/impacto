import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FrameMeter, POOR_FPS, LONG_FRAME, HOLD, PARTS, cardName, detailLines } from '../src/frame-meter.ts';
import { Renderer } from '../src/render.ts';

// A page as the meter sees it: a clock it reads, and a loop that draws a frame when told to. A frame comes
// `interval` after the one before and spends what `work` says of each name, with what `counts` says was counted;
// what it spends is what the next one waits for. `told` is the last report the meter made.
function page() {
  const p = { clock: 0, stamp: 0, reads: 0, told: null, due: 0, at: 0 };
  p.meter = new FrameMeter(() => { p.reads++; return p.clock; });
  p.frame = (interval, work = {}, counts = {}) => {
    p.clock = p.stamp += interval; p.meter.begin(p.stamp);
    for (const [name, ms] of Object.entries(work)) { p.clock += ms; p.meter.mark(name, counts[name]); }
    const told = p.meter.end(p.stamp);
    if (told) p.told = told;
    return told;
  };
  p.frames = (count, interval, work, counts) => { for (let i = 0; i < count; i++) p.frame(interval, work, counts); return p.told; };
  // The world of the page for `span` ms, with frames drawn in time: a state every `every` ms that brings `brings` ms of its time.
  p.world = (span, { every, brings, ...source }) => {
    for (const until = p.stamp + span; p.stamp < until; p.frame(16))
      for (; p.due <= p.stamp + 16; p.due += every) { p.at += brings / 1000; p.meter.state(p.due, { time: p.at, ...source }); }
    return p.told;
  };
  return p;
}
const started = () => { const p = page(); p.meter.turn(true); return p; };

test('the meter tells twice a second of the frames of the last second and of the worst of them', () => {
  const p = started();
  let reports = 0;
  for (let i = 0; i < 100; i++) if (p.frame(20)) reports++;
  assert.equal(reports, 3, 'two seconds of frames, the first of them the start of the count');
  assert.deepEqual(p.told, { fps: 50, worst: 20, poor: false, causes: [], rate: '50 FPS · pior 20 ms' });
  // One frame of 40 ms among frames in time is the worst of its second, and no hitch.
  const q = started(); q.frames(70, 16); q.frame(40); q.frames(35, 16);
  assert(40 < LONG_FRAME); assert.equal(q.told.worst, 40); assert.equal(q.told.rate, Math.round(q.told.fps) + ' FPS · pior 40 ms');
  assert(q.told.fps > 55 && q.told.fps < 62.5); assert.deepEqual([q.told.poor, q.told.causes], [false, []]);
  assert.equal(q.frames(70, 16).worst, 16, 'a second later it is no longer told of');
  // A frame of seconds is told in seconds.
  q.frame(1400); assert.equal(q.frames(20, 16).rate.split(' · ')[1], 'pior 1,4 s');
});

test('slow frames are laid to what the page spent most on, in no more than two causes', () => {
  const counts = { constructions: 38, effects: 2900, shots: 0 }, p = started();
  p.frames(40, 34, { camera: 1, constructions: 14, shots: 2, effects: 9, gpu: 3 }, counts);
  assert.equal(p.told.rate, '29 FPS · pior 34 ms'); assert.equal(p.told.poor, true);
  assert.deepEqual(p.told.causes, ['desenho das construções 14 ms (38 na tela)', 'efeitos e partículas 9 ms (2.900 partículas)']);
  // A second cause that weighs little beside the first is not told, nor a count of nothing; a name the meter does not know is told as it is.
  assert.deepEqual(started().frames(40, 34, { constructions: 20, effects: 4 }, counts).causes, ['desenho das construções 20 ms (38 na tela)']);
  assert.deepEqual(started().frames(40, 34, { shots: 18, sweep: 9 }, counts).causes, ['projéteis 18 ms', 'sweep 9 ms']);
  // Work between frames counts as that of a frame does: a state of the field taken in before each of them.
  const field = started();
  for (let i = 0; i < 40; i++) { field.meter.add('network', 21); field.frame(34, { gpu: 2 }); }
  assert.deepEqual(field.told.causes, ['recebimento dos estados da rede 21 ms']);
});

test('one long frame among frames in time is laid to what was done before it, and stays on the screen for a moment', () => {
  const p = started(); p.frames(40, 16, { gpu: 2 });
  assert.equal(p.meter.run('panels', () => { p.clock += 70; return 'painted'; }), 'painted');
  p.frame(80, { gpu: 2 }); p.frames(35, 16, { gpu: 2 });
  assert(p.told.fps > POOR_FPS); assert.equal(p.told.worst, 80); assert.equal(p.told.poor, true);
  assert.deepEqual(p.told.causes, ['painéis da interface 70 ms'], 'of the late frame alone: the frames in time spent nothing on the panels');
  // The second of the hitch is over: nothing is wrong, and the cause is still there to be read.
  p.frames(70, 16, { gpu: 2 });
  assert.deepEqual([p.told.poor, p.told.worst, p.told.causes], [false, 16, ['painéis da interface 70 ms']]);
  p.frames(Math.ceil(HOLD / 16), 16, { gpu: 2 });
  assert.deepEqual([p.told.poor, p.told.causes], [false, []]);
});

test('frames long in coming with little spent on them are not laid to the page', () => {
  const p = started();
  // A mark outside a frame is of no frame: the time since the last frame ended is not work of the page.
  for (let i = 0; i < 40; i++) { p.frame(34, { constructions: 3, gpu: 1 }); p.clock += 20; p.meter.mark('gpu'); }
  assert.equal(p.told.poor, true);
  assert.deepEqual(p.told.causes, ['fora da página: GPU ou navegador (a página usou 4 de 34 ms)']);
  // A long task the browser tells of, that no mark covers, was work on the thread of the page all the same.
  p.meter.busy(120);
  assert.deepEqual(p.frames(20, 34, { constructions: 3, gpu: 1 }).causes, ['página ocupada 120 ms fora das fases medidas (layout, coleta de lixo ou outro código)']);
  // A long task that is the work of a frame, marked, is no other cause: here one frame of panels among frames the page only waited for.
  const q = started(); q.frames(20, 34, { gpu: 4 });
  q.meter.run('panels', () => { q.clock += 70; }); q.meter.busy(72); q.frame(80, { gpu: 4 }); q.frames(20, 34, { gpu: 4 });
  assert.match(q.told.causes.join(), /^fora da página: GPU ou navegador \(a página usou \d de 3\d ms\)$/);
});

test('with the frames in time, a world that goes on slowly or stands still is laid to whoever simulates it', () => {
  // The lab: a state for every step of the worker.
  assert.deepEqual(started().world(1500, { every: 16, brings: 16 }), { fps: 62.5, worst: 16, poor: false, causes: [], rate: '63 FPS · pior 16 ms' });
  const lab = started().world(1500, { every: 20, brings: 12 });
  assert.deepEqual([lab.poor, lab.causes], [true, ['simulação lenta: o mundo anda a 60% do tempo real']]);
  // A healthy server does not distinguish network delay from callbacks waiting on the client thread.
  assert.deepEqual(started().world(1500, { every: 50, brings: 30, field: true, told: .6, ping: 12 }).causes, ['servidor lento: o mundo anda a 60% do tempo real, 20 estados/s']);
  assert.deepEqual(started().world(1500, { every: 50, brings: 30, field: true, told: 1, ping: 12 }).causes, ['atualizações atrasadas: o mundo chega a 60% do tempo real, 20 estados/s']);
  assert.deepEqual(started().world(1500, { every: 50, brings: 50, field: true, told: 1, ping: 12 }).causes, []);
  // A world in time whose states stop for a while: its picture stood still from the end of the last one.
  for (const [source, cause] of [[{ field: true, told: 1, ping: 85 }, 'servidor ou rede: até 250 ms sem estado novo, ping 85 ms'],
    [{}, 'simulação irregular: até 250 ms sem estado novo']]) {
    const p = started(), flow = { every: 50, brings: 50, ...source }; p.world(1500, flow);
    p.due += 250; p.at += .25;
    assert.deepEqual(p.world(800, flow).causes, [cause]);
  }
  // The state that is due now and has not come is told as it is waited for.
  const waiting = started(); waiting.world(1500, { every: 50, brings: 50, field: true });
  assert.match(waiting.frames(40, 16).causes[0], /^servidor ou rede: até \d+ ms sem estado novo$/);
  assert.match(waiting.frames(200, 16).causes[0], /^servidor ou rede: até 3,\d s sem estado novo$/);
});

test('a world that stands, begins again or is another has no pace to keep', () => {
  // Paused: the last state says the world stands, and none follows.
  const paused = started(); paused.world(1500, { every: 16, brings: 16 });
  paused.meter.state(paused.stamp, { time: paused.at, speed: 0 });
  assert.deepEqual(paused.frames(130, 16).causes, []);
  // Slow motion: a step of the world is shown over a hundred times its length, and the states in between, of an aim that moved, bring no time.
  const slow = started();
  for (let step = 1; step <= 4; step++) for (let i = 0; i < 100; i++) { slow.meter.state(slow.stamp, { time: step * .016, speed: .01 }); slow.frame(16); }
  assert.deepEqual([slow.told.poor, slow.told.causes], [false, []]);
  // Another world is loaded, its time back at nothing: the scene was cleared, and nothing was due while it loaded.
  const loaded = started(); loaded.world(1500, { every: 16, brings: 16 });
  loaded.meter.renew(); loaded.frames(60, 16);
  loaded.due = loaded.stamp; loaded.at = 0;
  assert.deepEqual(loaded.world(1500, { every: 16, brings: 16 }).causes, []);
  // Slow frames are told of alone: the states are taken in on the thread that is late.
  const both = started();
  for (let i = 0; i < 60; i++) { both.meter.state(both.stamp, { time: i * .01 }); both.frame(34, { constructions: 25 }, { constructions: 4 }); }
  assert.deepEqual(both.told.causes, ['desenho das construções 25 ms (4 na tela)']);
});

test('a stretch with nothing drawn is no frame, and what was done in it is no frame\'s work', () => {
  const p = started(); p.frames(70, 16);
  // The tab was away for five seconds, and the panels were painted before it drew again.
  p.meter.rest(); p.meter.add('panels', 900);
  assert.equal(p.frame(5000), null);
  assert.deepEqual(p.frames(70, 16), { fps: 62.5, worst: 16, poor: false, causes: [], rate: '63 FPS · pior 16 ms' });
});

test('off, the meter times nothing and tells nothing', () => {
  const p = page();
  assert.equal(p.meter.on, false);
  p.meter.add('network', 5); p.meter.busy(80); p.meter.state(0, { time: 1 }); p.meter.rest(); p.meter.renew();
  assert.equal(p.meter.run('panels', () => 'painted'), 'painted', 'the work is done all the same');
  assert.equal(p.frames(100, 40, { constructions: 30 }, { constructions: 9 }), null);
  assert.equal(p.reads, 0, 'the clock is not read');
  // Turned on and off again, it has forgotten what it found.
  p.meter.turn(true); p.frames(40, 40, { constructions: 30 }); assert.equal(p.told.poor, true);
  p.meter.turn(false); p.told = null;
  assert.equal(p.frames(100, 40, { constructions: 30 }), null);
  p.meter.turn(true); assert.deepEqual(p.frames(70, 16).causes, []);
});

test('in detail the meter tells every part of the frames by its mean and its worst, and what they sent to the video card', () => {
  const p = page(); p.meter.turn(true, true);
  // Each frame comes 25 ms after the one before and the page spends 22 of them, one of which on a name the meter does not know.
  p.meter.note('ground', 'visão geral · 3 trechos de 4 km');
  for (let i = 0; i < 80; i++) {
    p.meter.add('network', 2); p.meter.tally('draws', 300); p.meter.tally('textures', i === 5 ? 4 : 0);
    p.frame(25, { camera: 1, terrain: 6, sites: 3, constructions: 4, gpu: 5, sweep: 1 }, { constructions: 12 });
  }
  const { detail } = p.told;
  const told = Object.fromEntries(detail.parts.map(({ label, mean, worst }) => [label, [mean, worst]]));
  assert.deepEqual(detail.parts.map(part => part.label), [...PARTS.map(([part]) => part), 'Outros', 'Fora da página']);
  assert.deepEqual(told, { 'Física e rede': ['2,0', '2,0'], 'Apresentação': ['1,0', '1,0'], 'Terreno e subsolo': ['6,0', '6,0'],
    'Céu, árvores e pedras': ['0,0', '0,0'], 'Jazidas, bases e obras': ['3,0', '3,0'], 'Veículos': ['4,0', '4,0'], 'Efeitos e tiros': ['0,0', '0,0'],
    'Rótulos e interface': ['0,0', '0,0'], 'Envio à placa de vídeo': ['5,0', '5,0'], 'Outros': ['1,0', '1,0'], 'Fora da página': ['3,0', '3,0'] });
  assert.deepEqual(detail.tallies.map(({ label, mean, worst }) => [label, mean, worst]),
    [['desenhos enviados', '300', '300'], ['texturas enviadas', '0', '0'], ['geometrias enviadas', '0', '0']], 'the frame that sent four pictures is a second gone');
  assert.equal(detail.shown, 12); assert.deepEqual(detail.notes, { ground: 'visão geral · 3 trechos de 4 km' });
  // A frame that sent pictures is the worst of its second, and weighs little on the mean.
  for (let i = 0; i < 40; i++) { p.meter.tally('textures', i === 5 ? 6 : 0); p.frame(25); }
  assert.deepEqual(p.told.detail.tallies[1], { label: 'texturas enviadas', mean: '0', worst: '6' });
  // Without the detail nothing is counted, nothing is noted, and the report is the one of the meter alone.
  const plain = started();
  plain.meter.tally('draws', 9); plain.meter.note('ground', 'perto');
  assert.deepEqual([plain.meter.tallies, plain.meter.notes], [{}, {}]);
  assert.equal('detail' in plain.frames(70, 16), false);
  // Turned off, it is off in detail too; and on again it is the meter alone until it is asked for the detail.
  p.meter.turn(false); p.meter.turn(true); assert.equal(p.meter.detailed, false);
});

test('the detail names the video card without what only a driver reads, and the screen in its points and in its pixels', () => {
  assert.equal(cardName('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 4060 Direct3D11');
  assert.equal(cardName('ANGLE (AMD, AMD Radeon RX 6500 XT (0x0000743F) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'AMD Radeon RX 6500 XT Direct3D11');
  assert.equal(cardName('Mali-G57 MC2'), 'Mali-G57 MC2'); assert.equal(cardName(''), 'não informada pelo navegador');
  const detail = { shown: 1240, notes: { ground: 'visão geral · 3 trechos de 4 km', vehicles: '1.200 como ponto' } };
  assert.deepEqual(detailLines(detail, { gpu: 'Mali-G57 MC2', screen: [844, 390], pixels: [1688, 780] }), [
    'Veículos e estruturas na tela: 1.240 · 1.200 como ponto', 'Terreno: visão geral · 3 trechos de 4 km',
    'Placa de vídeo: Mali-G57 MC2', 'Tela: 844×390 · 1688×780 pixels']);
  assert.deepEqual(detailLines({ shown: 0, notes: {} }, { gpu: '', screen: [1920, 1080], pixels: [1920, 1080] }),
    ['Veículos e estruturas na tela: 0', 'Placa de vídeo: não informada pelo navegador', 'Tela: 1920×1080 · 1920×1080 pixels']);
});

test('in detail the calls that draw and that send pictures and corners to the video card are counted, and off the context is as it was', () => {
  const made = [], card = { drawElements(...args) { made.push(['drawElements', ...args]); return 'drawn'; }, texImage2D() { made.push(['texImage2D']); },
      bufferSubData() { made.push(['bufferSubData']); }, drawArrays() {} },
    gl = Object.create(card), renderer = Object.create(Renderer.prototype), meter = new FrameMeter(() => 0);
  renderer.app = { renderer: { gl } }; renderer.meter = meter; meter.turn(true, true);
  renderer.countCalls(true); renderer.countCalls(true);
  assert.equal(gl.drawElements(4, 6, 5125, 0), 'drawn'); gl.drawElements(4, 3, 5125, 0); gl.texImage2D(); gl.bufferSubData();
  assert.deepEqual(meter.tallies, { draws: 2, textures: 1, buffers: 1 }, 'counted once, though asked twice');
  assert.deepEqual(made[0], ['drawElements', 4, 6, 5125, 0]);
  renderer.countCalls(false);
  assert.deepEqual(Object.keys(gl), [], 'nothing of the counting is left on the context');
  gl.drawElements(4, 6, 5125, 0); assert.equal(meter.tallies.draws, 2);
  // A renderer not made yet has nothing to count.
  assert.doesNotThrow(() => Object.create(Renderer.prototype).countCalls(true));
});

// The rules of a style sheet, each with the media it holds under: enough of CSS for the sheets of the page.
function rules(css) {
  const found = [], media = []; let start = 0;
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '}') { media.pop(); start = i + 1; }
    else if (css[i] === '{') {
      const head = css.slice(start, i).trim();
      if (head.startsWith('@media')) { media.push(head.slice(6).trim()); start = i + 1; continue; }
      const end = css.indexOf('}', i);
      found.push({ media: media.at(-1) ?? null, selector: head, body: css.slice(i + 1, end) }); i = end; start = i + 1;
    }
  }
  return found;
}
// Whether a screen `width` × `height` is what a media query asks for.
const holds = (query, { width, height }) => query.split(',').some(part => part.split(' and ').every(term => {
  const [, feature, value] = term.trim().match(/^\(([a-z-]+):\s*([a-z0-9]+)\)$/) || [];
  return feature === 'max-width' ? width <= parseFloat(value) : feature === 'max-height' ? height <= parseFloat(value)
    : feature === 'orientation' ? (height > width ? 'portrait' : 'landscape') === value : false;
}));

test('on a phone the meter gives way to an open panel and, lying down, to the first objectives; upright it has no place; on a computer it stays', async () => {
  const sheet = rules(await readFile(new URL('../src/workspace.css', import.meta.url), 'utf8')),
    hiding = sheet.filter(rule => /\.frame-meter$/.test(rule.selector) && /display:\s*none/.test(rule.body));
  assert(hiding.every(rule => rule.media), 'no rule hides it on every screen');
  // Shown on a screen, with a panel open or the first objectives open, in the field or in the workshop.
  const shown = (screen, { panel = false, objectives = false } = {}) => !hiding.some(rule => holds(rule.media, screen) &&
    (panel || !rule.selector.includes('[data-workspace-panel=""]')) && (objectives || !rule.selector.includes('#first-objectives')));
  for (const screen of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 1024, height: 640 }]) {
    assert(shown(screen) && shown(screen, { panel: true }) && shown(screen, { objectives: true }), `${screen.width}×${screen.height}`);
  }
  for (const screen of [{ width: 844, height: 390 }, { width: 740, height: 360 }, { width: 932, height: 430 }]) {
    assert(shown(screen), `${screen.width}×${screen.height}`);
    assert(!shown(screen, { panel: true }) && !shown(screen, { objectives: true }), `${screen.width}×${screen.height}`);
  }
  // A narrow window on a computer keeps it beside the first objectives, which stand lower there; not over a panel, which covers it.
  assert(shown({ width: 820, height: 900 }, { objectives: true }) && !shown({ width: 820, height: 900 }, { panel: true }));
  for (const screen of [{ width: 375, height: 812 }, { width: 390, height: 844 }]) assert(!shown(screen), `${screen.width}×${screen.height}`);
});
