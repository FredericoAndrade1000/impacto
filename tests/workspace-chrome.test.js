import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WorkspaceChrome } from '../src/workspace-chrome.ts';
import { DomView } from '../src/dom-view.ts';
import { workspaceDOM } from './helpers/dom.js';

function fixture(t) {
  const { create: make } = workspaceDOM(t);
  const app = make('main', 'app'), bar = make('header', 'workspace-bar', app), nav = make('nav', 'workspace-nav', bar);
  for (const id of ['go-field', 'go-workshop']) make('span', id + '-label', make('button', id, nav));
  make('div', 'project-tools', bar); make('div', 'field-tools', bar);
  const trial = make('div', 'workspace-trial', bar); make('div', 'trial-name', trial); make('button', 'reset', trial);
  const backdrop = make('div', 'workspace-backdrop', app); backdrop.hidden = true; backdrop.setAttribute('aria-hidden', 'true');
  const sidebar = make('aside', '', app, 'sidebar'); sidebar.hidden = true;
  const header = make('header', '', sidebar), heading = make('h2', 'workspace-surface-heading', header); heading.tabIndex = -1;
  make('button', 'workspace-surface-close', header);
  const content = make('div', 'workspace-surface-content', sidebar), panel = make('section', 'project-panel', content),
    input = make('input', 'name', panel), select = make('select', 'material', panel);
  const viewport = make('div', 'viewport', app), canvas = make('canvas', 'canvas', viewport), modal = make('dialog', 'native-dialog');
  make('div', 'project-inspector', viewport); make('div', 'field-dock', viewport);
  let stopped = 0;
  const ui = new DomView(), chrome = new WorkspaceChrome(ui, { stopControls: () => stopped++ });
  const opener = make('button', 'open-panel', chrome.projectTools);
  opener.focus();
  const open = (panel = 'project', space = 'project') => chrome.render({ space, panel, title: panel || space });
  return { app, sidebar, panel, input, select, viewport, canvas, modal, chrome, opener, open, make, stopped: () => stopped };
}

test('outside gestures stay on the backdrop until click, then close through the controller and restore focus', t => {
  const f = fixture(t), seen = []; let closes = 0;
  assert.equal(f.chrome.nav, document.querySelector('#workspace-nav'));
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    f.app.addEventListener(type, () => seen.push('app:' + type));
    f.canvas.addEventListener(type, () => seen.push('canvas:' + type));
  }
  f.chrome.onClose = () => { closes++; f.open(null); };
  assert(f.chrome.backdrop.hidden);
  f.open();
  assert.equal(f.chrome.backdrop.parentElement, f.app); assert.equal(f.chrome.backdrop.getAttribute('aria-hidden'), 'true');
  assert.equal(f.viewport.inert, true); assert.equal(document.activeElement, f.chrome.heading);
  f.chrome.backdrop.dispatch('pointerdown', { pointerType: 'touch' });
  f.chrome.backdrop.dispatch('pointerup', { pointerType: 'touch' });
  assert.equal(closes, 0); assert.equal(f.viewport.inert, true, 'the first gesture has not exposed the canvas early');
  const click = f.chrome.backdrop.dispatch('click', { pointerType: 'touch' });
  assert(click.defaultPrevented); assert.deepEqual(seen, []); assert.equal(closes, 1);
  assert(f.sidebar.hidden); assert(f.chrome.backdrop.hidden); assert.equal(f.viewport.inert, false); assert.equal(document.activeElement, f.opener);
  f.chrome.backdrop.dispatch('click'); assert.equal(closes, 1, 'a hidden layer has no pending close action');
});

test('controls, context navigation and native dialogs are outside the dismissal handler', t => {
  const f = fixture(t); let closes = 0, switched = 0;
  f.chrome.onClose = () => closes++;
  f.open();
  f.input.value = 'nome em edição'; f.input.dispatch('click'); f.select.dispatch('click'); f.modal.dispatch('click');
  f.chrome.field.onclick = () => { switched++; f.open(null, 'field'); };
  f.chrome.field.dispatch('click');
  assert.equal(switched, 1); assert.equal(closes, 0); assert.equal(f.input.value, 'nome em edição');
  assert(f.chrome.backdrop.hidden); assert.equal(f.chrome.bar.contains(f.chrome.field), true);
});

test('surface changes reset only the shared scroll and do not steal focused edits on refresh', t => {
  const f = fixture(t); f.open(); f.input.focus(); f.chrome.content.scrollTop = 38;
  f.open(); assert.equal(f.chrome.content.scrollTop, 38); assert.equal(document.activeElement, f.input); assert.equal(f.stopped(), 1);
  f.open('publish'); assert.equal(f.chrome.content.scrollTop, 0); assert.equal(document.activeElement, f.chrome.heading);
  f.open(null); f.chrome.content.scrollTop = 77; f.open('project'); assert.equal(f.chrome.content.scrollTop, 0); assert.equal(f.stopped(), 2);
});

test('Escape and focus trapping preserve select/composition behavior and skip hidden controls', t => {
  const f = fixture(t), hidden = f.make('button', 'hidden', f.panel); hidden.hidden = true;
  let closes = 0; f.chrome.onClose = () => { closes++; f.open(null); }; f.open();
  f.select.dispatch('keydown', { key: 'Escape' });
  f.input.dispatch('keydown', { key: 'Escape', isComposing: true });
  f.input.dispatch('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(closes, 0);
  f.chrome.close.focus(); f.chrome.close.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(document.activeElement, f.select);
  f.select.dispatch('keydown', { key: 'Tab' }); assert.equal(document.activeElement, f.chrome.close);
  f.input.dispatch('keydown', { key: 'Escape' }); assert.equal(closes, 1); assert.equal(document.activeElement, f.opener);
});

test('closed disclosures retain their summary in the keyboard cycle and skip non-visible descendants', t => {
  const f = fixture(t), details = f.make('details', 'known', f.panel), summary = f.make('summary', 'known-summary', details), invite = f.make('button', 'invite', details);
  invite.checkVisibility = () => details.open;
  f.open(); f.chrome.heading.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(document.activeElement, summary);
  summary.dispatch('keydown', { key: 'Tab' }); assert.equal(document.activeElement, f.chrome.close);
  details.open = true; f.chrome.heading.focus(); f.chrome.heading.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(document.activeElement, invite);
  invite.dispatch('keydown', { key: 'Tab' }); assert.equal(document.activeElement, f.chrome.close);
});

test('the test of driving is the Campo de provas wherever the player reads its name', async t => {
  const f = fixture(t), html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  // Over the field, in the row at the top, and as the name of that row.
  for (const [trial, name] of [['terrain', 'Campo de provas'], ['armour', 'Ensaio de blindagem']]) {
    f.chrome.render({ space: 'trial', trial });
    assert.deepEqual([f.chrome.trialName.textContent, f.chrome.bar.getAttribute('aria-label')], [name, name]);
  }
  // Its button in the workshop and the help; nothing the player reads keeps the old name.
  const button = html.match(/<button id="trial-terrain"[^>]*>.*?<\/button>/)[0];
  assert.match(button, /aria-label="Campo de provas"/); assert.match(button, /<span>Campo de provas<\/span>/);
  assert.match(html, /O <b>Campo de provas<\/b> deixa você conduzir/);
  assert.doesNotMatch(html, /Testar no terreno|Ensaio no terreno|<span>Terreno<\/span>/);
});
