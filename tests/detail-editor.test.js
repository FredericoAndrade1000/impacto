import test from 'node:test';
import assert from 'node:assert/strict';
import { DetailEditor } from '../src/detail-editor.ts';
import { DETAIL_GROUPS } from '../src/detail-gestures.ts';
import { VEHICLE_DETAILS } from '../src/vehicle-details.ts';
import { configureLanguage, language, tr } from '../src/i18n.ts';
import { MarkupElement, workspaceDOM } from './helpers/dom.js';

class Element extends MarkupElement {
  toggleAttribute(name, active) {
    if (active ?? !this.attributes.has(name)) this.setAttribute(name, ''); else this.attributes.delete(name);
  }
}

test('detail controls retain complete localized attributes and catalogue labels after rendering', async t => {
  for (const locale of ['pt-BR', 'en']) await t.test(locale, t => {
    const previousLanguage = language(), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    configureLanguage({ languages: [locale], storage: null });
    t.after(() => {
      configureLanguage({ languages: [previousLanguage], storage: null });
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    });
    const { create } = workspaceDOM(t, Element), host = create('div', 'viewport'), canvas = create('canvas', 'board', host),
      button = create('button', 'details', host);
    document.addEventListener = () => {};
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {} } });
    const source = { appearance: { paint: '#68765a', details: [{ id: 'lamp', kind: 'headlight', surface: 'body', host: 'wall',
      space: 'project', x: 0, y: 0, angle: 0, width: .3, height: .17 }] } },
      blueprint = { plates: [], modules: [], rooms: [], frame: { origin: { x: 12, y: 0 } } },
      ui = new DetailEditor({ host, canvas, button, view: { mode: 'edit', exterior: true }, renderer: {},
        editor: () => ({ source, blueprint }), closePanels() {}, changed() {}, toast() {} });
    ui.enabled = true; ui.selected = 'lamp'; ui.paint = source.appearance.paint;
    ui.render();

    for (const [selector, label, title = label] of [
      ['[data-more]', 'Mais ações'], ['[data-close]', 'Concluir detalhes', 'Concluir detalhes · Esc'],
      ['[data-act=mirror]', 'Espelhar'], ['[data-act=duplicate]', 'Duplicar', 'Duplicar · Ctrl+D'],
      ['[data-act=remove]', 'Remover', 'Remover · Delete'],
    ]) {
      const control = host.querySelector(selector);
      assert.equal(control.getAttribute('aria-label'), tr(label), selector + ' accessible name');
      assert.equal(control.getAttribute('title'), tr(title), selector + ' tooltip');
    }
    assert.equal(ui.get('[data-automatic]').getAttribute('title'), tr('Desligar mantém os detalhes. Religar gera de novo os automáticos.'));
    assert.equal(ui.get('.detail-catalogue').getAttribute('aria-label'), tr('Adicionar detalhe'));
    assert.equal(ui.text.getAttribute('title'), tr('Número · de um a três algarismos'));
    assert.equal(ui.get('output').title, locale === 'en' ? '1 of 32 details' : '1 de 32 detalhes');
    assert.equal(ui.bar.querySelector('.detail-name').textContent, locale === 'en' ? 'Headlight' : 'Farol');
    assert.deepEqual(ui.get('.detail-catalogue').querySelectorAll('h3').map(heading => heading.textContent), DETAIL_GROUPS.map(group => tr(group.name)));
    const choices = ui.panel.querySelectorAll('[data-kind]');
    assert.equal(choices.length, Object.keys(VEHICLE_DETAILS).length);
    for (const choice of choices) {
      const name = tr(VEHICLE_DETAILS[choice.dataset.kind].name);
      assert.equal(choice.getAttribute('aria-label'), `${locale === 'en' ? 'Add' : 'Adicionar'} ${name.toLowerCase()}`);
      assert.equal(choice.title, tr`${name} · clique para pôr no meio da vista ou arraste até o veículo`);
      assert.equal(choice.disabled, false);
    }
  });
});
