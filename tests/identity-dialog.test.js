import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityUI } from '../src/identity-ui.ts';
import { defaultFlag } from '../src/flag.ts';

// The dialog as the page has it: each element by its id, made the first time it is asked for. Layout belongs to the browser.
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map(); this.style = {}; this.hidden = false; this.value = ''; this.textContent = ''; this.open = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function page(t) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document'), elements = new Map(),
    get = id => elements.get(id) ?? elements.set(id, new Element()).get(id);
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { getElementById: get, createElement: tag => new Element(tag) } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  return get;
}

test('the dialog of the faction says why the field refused the player\'s name and stays open; a name left as it was is not sent', async t => {
  const get = page(t), TAKEN = 'Esse nome já é de outro jogador.', asked = [], faction = { id: 'f1', name: 'Ana', nation: null, flag: defaultFlag('f1') };
  let name = 'Ana', refuse = true;
  const ui = new IdentityUI({ getFaction: () => faction, getName: () => name, stopControls() {},
    onRename: async written => { asked.push(['rename', written]); if (refuse) throw new Error(TAKEN); name = written.trim(); },
    onSave: async (data, renamed) => { asked.push(['identity', data.nation, renamed]); } });
  ui.open();
  assert.deepEqual([get('identity-player').value, get('identity-dialog').open], ['Ana', true]);
  // A name the field refuses: the reason is said there, the dialog stays open and the faction is left as it was.
  get('identity-player').value = 'Bia';
  await get('identity-save').onclick();
  assert.deepEqual(asked, [['rename', 'Bia']]);
  assert.deepEqual([get('identity-error').hidden, get('identity-error').textContent, get('identity-dialog').open], [false, TAKEN, true]);
  // Writing again takes the reason away; another name the field takes, and then the faction is saved and the dialog closes.
  get('identity-player').oninput();
  assert.equal(get('identity-error').hidden, true);
  refuse = false; get('identity-player').value = ' Carla ';
  await get('identity-save').onclick();
  assert.deepEqual(asked.slice(1), [['rename', ' Carla '], ['identity', '', true]]);
  assert.equal(get('identity-dialog').open, false);
  // Opened again, it has the name the player goes by now, which is not sent again unless it is changed.
  ui.open();
  assert.equal(get('identity-player').value, 'Carla');
  await get('identity-save').onclick();
  assert.deepEqual(asked.slice(3), [['identity', '', false]]);
});
