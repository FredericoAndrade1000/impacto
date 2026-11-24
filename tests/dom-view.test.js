import test from 'node:test';
import assert from 'node:assert/strict';
import { DomView } from '../src/dom-view.ts';

class Element {
  constructor(tag = 'input') { this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this._value = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
}
// A select as the browser has it: it holds only a value one of its options has, and takes the first when they are replaced.
class Select extends Element {
  constructor() { super('select'); }
  get value() { return this._value; }
  set value(value) { this._value = this.children.some(c => c.value === String(value)) ? String(value) : ''; }
  replaceChildren(...children) { super.replaceChildren(...children); this._value = children[0]?.value || ''; }
  get label() { return this.children.find(c => c.value === this.value)?.textContent; }
}
function dom(t) {
  const before = globalThis.document, elements = new Map();
  globalThis.document = { activeElement: null, querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, selector === '#select' ? new Select() : new Element());
    return elements.get(selector);
  }, createElement: tag => tag === 'select' ? new Select() : new Element(tag) };
  t.after(() => { globalThis.document = before; });
  return globalThis.document;
}

test('native selects retain a focused selection when options are inserted', t => {
  const document = dom(t), view = new DomView(), select = view.get('#select');
  view.set('#select', { options: [['old', 'Old']], value: 'old' }); document.activeElement = select;
  view.set('#select', { options: [['new', 'New'], ['old', 'Old']], value: 'old' });
  assert.equal(select.value, 'old'); assert.equal(select.label, 'Old');
  const input = view.get('#text'); input.value = 'pending'; document.activeElement = input;
  view.set('#text', { value: 'saved' }); assert.equal(input.value, 'pending');
});

test('unchanged bindings avoid DOM writes while external changes and browser coercion remain visible', t => {
  const document = dom(t), view = new DomView(), element = view.get('#control'), attributes = new Map(), properties = {};
  let writes = 0;
  element.getAttribute = name => attributes.get(name) ?? null;
  element.setAttribute = (name, value) => { writes++; attributes.set(name, String(value)); };
  element.dataset = new Proxy({}, { set(target, key, value) { writes++; target[key] = String(value); return true; } });
  for (const key of ['hidden', 'disabled', 'checked']) Object.defineProperty(element, key, {
    get: () => properties[key] ?? false, set: value => { writes++; properties[key] = value; },
  });
  const binding = { attr: { 'aria-pressed': false, title: null }, data: { active: true, empty: undefined },
    hidden: true, disabled: true, checked: true };
  view.set('#control', binding);
  assert.equal(element.getAttribute('aria-pressed'), 'false', 'false remains an attribute value, not removal');
  assert.equal(element.getAttribute('title'), 'null');
  assert.deepEqual({ ...element.dataset }, { active: 'true', empty: 'undefined' });
  writes = 0; view.set('#control', binding); assert.equal(writes, 0, 'an unchanged screen does not mutate its attributes');

  element.setAttribute('aria-pressed', true); element.dataset.active = false; element.hidden = false;
  writes = 0; view.set('#control', binding); assert.equal(writes, 3, 'live DOM changes are corrected without a stale cache');
  assert.equal(element.getAttribute('aria-pressed'), 'false'); assert.equal(element.dataset.active, 'true'); assert.equal(element.hidden, true);
  view.set('#control', { attr: { 'aria-pressed': true }, data: { active: false }, hidden: false, disabled: false, checked: false });
  assert.equal(element.getAttribute('aria-pressed'), 'true'); assert.equal(element.dataset.active, 'false');
  assert.deepEqual([element.hidden, element.disabled, element.checked], [false, false, false]);
  view.set('#control', { hidden: 'until-found' }); assert.equal(element.hidden, 'until-found', 'non-boolean property values keep their own semantics');

  document.activeElement = null; view.set('#control', { value: 42 }); assert.equal(element.value, '42');
  document.activeElement = element; view.set('#control', { value: 17 }); assert.equal(element.value, '42', 'focused text is preserved');
});
