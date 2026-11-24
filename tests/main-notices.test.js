import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotices } from '../src/notices.ts';
import { configureLanguage } from '../src/i18n.ts';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.hidden = false; this.open = false; this._text = ''; this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this._text = value.replace(/<[^>]*>/g, ''); this.replaceChildren(); }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') { const text = new Element('text'); text.textContent = child; child = text; }
      child.remove(); child.parentNode = this; this.children.push(child);
    }
  }
  prepend(child) { child.remove(); child.parentNode = this; this.children.unshift(child); }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  get lastElementChild() { return this.children.at(-1); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, action) { this.listeners.set(name, [...this.listeners.get(name) || [], action]); }
  emit(name, event = {}) { this['on' + name]?.(event); for (const action of this.listeners.get(name) || []) action(event); }
  querySelector(selector) { return this.children.find(child => '.' + child.className === selector); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  focus() {}
}

function fixture(t) {
  const original = globalThis.document, elements = new Map(), get = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element('div'));
    return elements.get(selector);
  }, document = { hidden: false, createElement: tag => new Element(tag) };
  globalThis.document = document; t.after(() => { globalThis.document = original; });
  const places = [], records = [], timers = new Map(), callbacks = new Map(); let now = 0, serial = 0;
  const context = { document, $: get, performance: { now: () => now },
      encounterBands: { record: (...args) => records.push(args) },
      attempt: action => action(), showPlace: x => places.push(x),
      setTimeout(action, duration) { const id = ++serial; timers.set(id, { action, at: now + duration }); callbacks.set(id, action); return id; },
      clearTimeout(id) { timers.delete(id); } };
  Object.assign(context, createNotices({ ...context, get, attempt: action => action(), showPlace: x => places.push(x) }));
  const element = get('#toast'); element.hidden = true;
  return { toast: context.toast, element, places, timers, callbacks, records, get,
    visibility(hidden, emit = true) { document.hidden = hidden; if (emit) context.timeToast(); },
    advance(ms, run = true) {
      now += ms;
      if (run) for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.action(); }
    } };
}

test('a notice created after bootstrap translates its destination and keeps the player message as plain text', t => {
  const f = fixture(t); configureLanguage({ languages: ['en'] }); t.after(() => configureLanguage({ languages: ['pt-BR'] }));
  const named = 'Ferro {0} <b>English</b>';
  f.toast(named, false, 15);
  assert.match(f.element.textContent, /^Ferro \{0\} <b>English<\/b> Show in field/);
  f.element.onclick(); assert.deepEqual(f.places, [15]);
});

test('routine faction information cannot replace the squad warning, its deadline or its destination', t => {
  const f = fixture(t);
  f.toast('Construtor sob ataque.', true, 0);
  const text = f.element.textContent, button = f.element.children.at(-1), click = f.element.onclick,
    [[id, timer]] = f.timers;
  f.advance(1000); f.toast('Uma facção convidou você.', false, 81);
  assert.equal(f.element.textContent, text); assert.equal(f.element.children.at(-1), button);
  assert.equal(f.element.onclick, click); assert.equal(f.element.getAttribute('role'), 'alert');
  assert.equal(f.timers.size, 1); assert.equal(f.timers.get(id), timer, 'new information neither restarts nor extends the urgent deadline');
  f.element.onclick(); assert.deepEqual(f.places, [0]);
});

test('the original warning expires even when routine information arrives near its deadline', t => {
  const f = fixture(t); f.toast('Perigo.', true);
  f.advance(4499); f.toast('Carga entregue.'); assert.equal(f.element.textContent, 'Perigo.');
  f.advance(1); assert.equal(f.element.hidden, true);
  f.toast('Suprimentos carregados.');
  assert.equal(f.element.hidden, false); assert.equal(f.element.textContent, 'Suprimentos carregados.');
  assert.equal(f.element.getAttribute('role'), 'status');
});

test('dismissing a warning releases the slot immediately and its stale timeout cannot hide a replacement', t => {
  const f = fixture(t); f.toast('Alerta grave.', true, 40);
  const old = [...f.callbacks.values()][0];
  f.element.onclick(); f.toast('Operação concluída.'); old();
  assert.equal(f.element.hidden, false); assert.equal(f.element.textContent, 'Operação concluída.');
  assert.equal(f.element.classes.has('toast-place'), false); assert.deepEqual(f.places, [40]);
});

test('another grave warning replaces the old one with its own place, independent of stale timers', t => {
  const f = fixture(t); f.toast('Primeiro contato.', true, 11);
  const old = [...f.callbacks.values()][0]; f.advance(500);
  f.toast('Obra interrompida.', true, 22); old();
  assert.equal(f.element.hidden, false); assert.match(f.element.textContent, /^Obra interrompida\./);
  f.element.onclick(); assert.deepEqual(f.places, [22]);
});

test('a delayed timeout on a visible page does not preserve an already expired warning', t => {
  const f = fixture(t); f.toast('Perigo.', true); f.advance(4501, false);
  f.toast('Conexão restabelecida.');
  assert.equal(f.element.textContent, 'Conexão restabelecida.'); assert.equal(f.element.getAttribute('role'), 'status');
});

test('hiding the tab preserves a warning and its place until a full reading interval after return', t => {
  const f = fixture(t); f.toast('Perigo.', true, 0);
  const old = [...f.callbacks.values()][0], text = f.element.textContent;
  f.advance(5000); f.visibility(true); assert.equal(f.timers.size, 0);
  f.advance(600000); f.toast('Carga entregue.');
  assert.equal(f.element.textContent, text); assert.equal(f.element.getAttribute('role'), 'alert');
  assert.equal(f.element.hidden, false); assert.equal(f.timers.size, 0);
  f.visibility(false); assert.equal(f.timers.size, 1);
  old(); assert.equal(f.element.hidden, false, 'a stale pre-hide timer cannot remove the restored notice');
  f.advance(5999); assert.equal(f.element.hidden, false);
  f.element.onclick(); assert.deepEqual(f.places, [0]); assert.equal(f.element.hidden, true);
  assert.equal(f.timers.size, 0);
});

test('a notice received while hidden starts its timeout only after return and the latest grave notice owns the slot', t => {
  const f = fixture(t); f.visibility(true); f.toast('Reparo concluído.');
  assert.equal(f.timers.size, 0); f.advance(600000); assert.equal(f.element.hidden, false);
  f.toast('Primeiro alerta.', true, 11); f.toast('Obra interrompida.', true, 22); f.toast('Conexão restabelecida.');
  assert.match(f.element.textContent, /^Obra interrompida\./); assert.equal(f.timers.size, 0);
  f.visibility(false); assert.equal(f.timers.size, 1);
  f.advance(5999); assert.equal(f.element.hidden, false); f.advance(1); assert.equal(f.element.hidden, true);
  assert.equal(f.timers.size, 0);
});

test('a timer dispatched before visibilitychange observes a hidden document and waits for the return', t => {
  const f = fixture(t); f.toast('Perigo.', true); f.visibility(true, false); f.advance(4500);
  assert.equal(f.element.hidden, false); assert.equal(f.timers.size, 0);
  f.advance(600000); f.visibility(false); f.advance(4499); assert.equal(f.element.hidden, false);
  f.advance(1); assert.equal(f.element.hidden, true);
});

// The page's actual placing of a notice, with the boxes of what covers the foot of the field made up.
function placing(window, field, cover, menu = null) {
  const style = new Map(), box = rect => ({ getBoundingClientRect: () => rect }),
    elements = { '#toast': { hidden: false, style: { getPropertyValue: name => style.get(name) ?? '', setProperty: (name, value) => style.set(name, value) } },
      '#viewport': box({ bottom: field }),
      '#field-dock': { querySelector: () => menu && { offsetParent: {}, ...box({ top: menu }) } } },
    context = createNotices({ get: selector => elements[selector], height: () => window, renderer: { camera: { cover: () => ({ bottom: cover }) } } });
  context.placeToast();
  return { clear: style.get('--toast-clear'), hide() { elements['#toast'].hidden = true; style.clear(); context.placeToast(); return style.size; } };
}

test('a notice stands a hand over what covers the foot of the field, and over the more orders open over it', () => {
  assert.equal(placing(720, 720, 130).clear, '138px', 'over the orders of what is picked');
  assert.equal(placing(720, 700, 100).clear, '128px', 'from the foot of the window, below which the field ends');
  assert.equal(placing(720, 720, 130, 300).clear, '428px', 'over the more orders, open over the dock');
  assert.equal(placing(720, 720, 0).clear, '8px', 'and with nothing at the foot, a hand over it: the style keeps it higher');
  assert.equal(placing(720, 720, 130).hide(), 0, 'a notice put away is not placed');
});
