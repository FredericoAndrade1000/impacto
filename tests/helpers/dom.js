import { ConstructionUI } from '../../src/construction-ui.ts';

// Only the modal DOM is supplied. Catalogue data, callbacks and close handlers stay real.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.value = ''; this.dataset = {}; this.attributes = {}; this.style = {};
    this.listeners = new Map(); this.classList = { toggle() {} }; this.disabled = false; this.returnValue = ''; this.open = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  focus() { document.activeElement = this; }
  click() { this.clicks = (this.clicks ?? 0) + 1; }
  select() { this.selected = true; }
  scrollIntoView() { this.scrolled = true; }
  showModal() { this.open = true; }
  close(value) { if (value !== undefined) this.returnValue = value; this.closed = true; this.open = false; this.emit('close'); }
  getContext() {
    return new Proxy({}, { get: (_, name) => name === 'measureText' ? text => ({ width: String(text).length * 7 }) :
      name === 'createLinearGradient' || name === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {} });
  }
}
export const descendants = node => [node, ...node.children.flatMap(descendants)];

export function constructionUI(t, options) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), nodes = new Map();
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    activeElement: null, createElement: tag => new Element(tag), querySelectorAll: () => [],
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  return { nodes, ui: new ConstructionUI(options) };
}

// Workspace tests share ownership, attributes, bubbling and focus. Layout and
// native select/dialog behavior still belong to the Chromium checks.
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
export class WorkspaceElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.hidden = false; this.inert = false; this.disabled = false; this.className = ''; this._text = '';
    this.style = { setProperty(name, value) { this[name] = value; } }; this.scrollTop = 0;
    this.classList = { toggle: (name, on) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean)), active = on ?? !classes.has(name);
      if (active) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' '); return active;
    } };
  }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  get parentElement() { return this.parentNode; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
  insertBefore(child, next) {
    child.remove();
    const at = next ? this.children.indexOf(next) : this.children.length;
    if (at < 0) throw new Error('insertBefore needs a child of this element');
    child.parentNode = this; this.children.splice(at, 0, child);
  }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this._text = ''; this.append(...children); }
  setAttribute(name, value) {
    value = String(value); this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = value;
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
    if (name === 'hidden' || name === 'inert') this[name] = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  get isConnected() { return document.body.contains(this); }
  matches(selector) {
    return selector.split(',').some(option => {
      const part = option.trim();
      if (part === '[hidden]' || part === '[inert]') return this[part.slice(1, -1)];
      if (part === '[tabindex]') return this._tabIndex !== undefined;
      if (!part || !/^(?:[a-z][\w-]*|\*)?(?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[\w-]+))?\])*$/i.test(part))
        throw new Error('Unsupported workspace selector: ' + selector);
      const tag = part.match(/^[a-z][\w-]*/i)?.[0], id = part.match(/#([\w-]+)/)?.[1],
        classes = [...part.matchAll(/\.([\w-]+)/g)].map(match => match[1]),
        attrs = [...part.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)];
      return (!tag || tag.toUpperCase() === this.tagName) && (!id || id === this.id) &&
        classes.every(name => this.className.split(/\s+/).includes(name)) && attrs.every(([, name, value]) => {
          const actual = name.startsWith('data-') ? this.dataset[dataKey(name)] : this.getAttribute(name);
          return value === undefined ? actual !== undefined && actual !== null : actual === value;
        });
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return all.filter(child => selector.split(',').some(option => {
      const parts = option.trim().split(/\s+/), last = parts.pop();
      return child.matches(last) && (!parts.length || child.parentNode?.closest(parts.join(' ')));
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, action) { this.listeners.set(type, [...this.listeners.get(type) || [], action]); }
  dispatch(type, properties = {}) {
    const event = { type, target: this, button: 0, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...properties };
    for (let target = this; target; target = target.parentNode) {
      target['on' + type]?.(event);
      for (const action of target.listeners.get(type) || []) action(event);
      if (event.stopped) break;
    }
    return event;
  }
  click() { return this.dispatch('click', { detail: 1 }); }
  get tabIndex() { return this._tabIndex ?? (/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(this.tagName) ? 0 : -1); }
  set tabIndex(value) { this._tabIndex = value; }
  checkVisibility() { return !this.closest('[hidden], [inert]'); }
  focus() { document.activeElement = this; }
}

// The small HTML subset emitted by UI controls, with real attribute names and values.
export class MarkupElement extends WorkspaceElement {
  set innerHTML(source) {
    this.replaceChildren(); const stack = [this];
    for (const token of source.match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1)._text += token.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); continue; }
      const match = token.match(/^<([\w-]+)(.*)\/?>$/s);
      if (!match) continue;
      const child = new this.constructor(match[1]);
      for (const attribute of match[2].matchAll(/([\w:-]+)(?:="([^"]*)"|'([^']*)'|=([^\s/>]+))?/g)) child.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      stack.at(-1).append(child);
      if (!token.endsWith('/>') && !['input', 'br', 'hr'].includes(match[1])) stack.push(child);
    }
  }
}

export function workspaceDOM(t, ElementType = WorkspaceElement) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), body = new ElementType('body'),
    createElement = tag => new ElementType(tag);
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    body, activeElement: body, createElement, createElementNS: (_, tag) => createElement(tag),
    querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  const create = (tag, id, parent = body, className = '') => {
    const element = createElement(tag); element.id = id; element.className = className; parent.append(element); return element;
  };
  return { body, create };
}
