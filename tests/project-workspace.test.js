import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkshopScreen } from '../src/workshop-screen.ts';
import { DomView } from '../src/dom-view.ts';

import { installPaletteKeys, shown } from '../src/workshop-ux.ts';
import { workspaceDOM } from './helpers/dom.js';

// Fixed controls already occupy their authored positions. The screen exercises
// real surface/selection/placement transitions and variable collections.
function fixture(t) {
  const { body: root, create } = workspaceDOM(t), controls = new Map();
  const add = (id, parent = root, tag = 'div') => { const element = create(tag, id, parent); controls.set(id, element); return element; };
  const sidebar = add('sidebar'); sidebar.className = 'sidebar'; sidebar.dataset.mode = 'edit';
  const content = add('workspace-surface-content', sidebar), tools = add('project-tools'), inspector = add('project-inspector');
  for (const id of ['garage', 'project-add', 'project-test', 'project-publish']) add(id, tools, 'button');
  add('project-inspector-title', inspector, 'h2'); add('project-inspector-close', inspector, 'button');
  const panel = (id, task) => { const element = add(id, content, 'section'); element.dataset.workshopPanel = task; return element; };
  const project = panel('project-panel', 'project');
  const tests = add('workshop-tests', panel('project-test-panel', 'test')); add('trial-armour', tests, 'button'); add('trial-terrain', tests, 'button');
  add('workshop-capacity', project);
  add('workshop-figures', project); add('workshop-checklist', project);
  const publish = panel('publish-panel', 'publish');
  for (const id of ['ferro','ligas','silica','combustivel']) add('available-' + id, add('cost-' + id, publish), 'small').className = 'cost-available';
  const actions = add('project-publish-actions', sidebar);
  for (const id of ['publish-new','publish-replace','publish-refused','replace-reason']) add(id,actions,id.includes('reason') || id.includes('refused') ? 'output' : 'button');
  panel('workshop-publish-empty', 'publish');
  const build = panel('edit-controls', 'build'), palette = add('palette', build); palette.className = 'component-palette';
  add('part-categories', build);
  add('workshop-assist',build);
  for (const kind of ['engine','fuel','ammo','command','sensor','excavator','drill','builder','hopper','cistern','supply']) {
    const button = add('add-' + kind, palette, 'button'); button.dataset.component = kind;
  }
  add('catalog-edit', build, 'button');
  const placementHost = add('project-placement', inspector), placement = add('workshop-placement', placementHost); add('workshop-placement-cancel', placement, 'button');
  add('new-module-settings', placementHost); add('construction-feedback', placementHost);
  const adjust = add('workshop-adjust', inspector); add('workshop-selection-host', adjust); add('workshop-selection-empty', adjust);
  add('linked-weapons');
  for (const id of ['ferro','ligas','silica','combustivel']) add('stock-' + id);
  for (const id of ['current-weapon-preview','new-weapon-preview']) add(id).dataset.preset = 'fnmag';
  const ui = new DomView(), screen = new WorkshopScreen(ui), selections = [], view = {
    mode:'edit', buildTool:'select', placement:{kind:'engine',weaponPreset:'fnmag'},
    editor:{select:ids => selections.push(ids)},
  };
  const model = {edit:true, panel:{publish:null}, selection:[], points:[], blueprint:{}, figures:[], ammoButtons:[], weaponButtons:[], weapon:{preset:'fnmag'},
    bindings:{...Object.fromEntries(['ferro','ligas','silica','combustivel'].map(id => ['stock-' + id,{text:'100'}]))}};
  return {screen,ui,view,model,controls,sidebar,content,tools,inspector,selections};
}

test('the single workbench starts closed and retains authored project/test/selection controls without moving or cloning them', t => {
  const f = fixture(t), get = id => f.controls.get(id);
  assert.equal(f.screen.surface, null); assert.equal(f.inspector.hidden, true);
  assert.equal(f.tools.children.length, 4);
  assert.equal(f.tools.querySelector('#garage'), get('garage'));
  assert.equal(get('garage').getAttribute('aria-expanded'), null, 'the garage opens a dialog, not a surface of the workbench');
  assert.equal(document.querySelector('#project-test-panel').querySelector('#workshop-tests'), get('workshop-tests'));
  assert.equal(f.inspector.querySelector('#workshop-adjust'), get('workshop-adjust'));
  assert.equal(f.inspector.querySelector('#workshop-placement-cancel'), get('workshop-placement-cancel'));
  assert.equal(f.inspector.querySelector('#new-module-settings'), get('new-module-settings'));
  assert.equal(f.sidebar.querySelector('#project-publish-actions').querySelector('#publish-new'),get('publish-new'));
  assert.equal(f.screen.publishActions.hidden,true);
  assert(f.screen.panels.every(panel => panel.hidden));
});

test('tests and review are temporary surfaces; opening and closing them preserves the selected object', t => {
  const f = fixture(t), notices = [];
  f.screen.onVisibility((surface, inspecting) => notices.push([surface, inspecting]));
  f.model.selection = [{id:'engine',name:'Motor'}]; f.screen.render(f.model, f.view);
  assert.equal(f.screen.surface,null); assert.equal(f.inspector.hidden,false);
  f.screen.openTask('test'); assert.equal(f.inspector.hidden,true);
  assert.equal(document.querySelector('#project-test-panel').hidden,false);
  assert.equal(f.controls.get('project-test').getAttribute('aria-expanded'),'true');
  f.screen.openTask('file'); assert.equal(f.screen.surface,'test','there is no file surface');
  f.screen.close(); assert.equal(f.inspector.hidden,false); assert.deepEqual(f.selections,[]);
  f.screen.openTask('project'); assert.equal(f.controls.get('project-panel').hidden,false);
  f.screen.openTask('adjust'); assert.equal(f.controls.get('project-panel').hidden,true);
  assert.equal(f.screen.surface,null); assert.equal(f.inspector.hidden,false);
  const count = notices.length; f.screen.render(f.model, f.view);
  assert.equal(notices.length,count,'unchanged rendering does not repeatedly request a chrome update');
  assert.deepEqual(f.model.selection,[{id:'engine',name:'Motor'}]);
});

test('choosing a component closes Add and exposes the retained placement controls without cancelling the tool', t => {
  const f = fixture(t); f.screen.render(f.model,f.view); f.screen.openTask('build');
  assert.equal(f.controls.get('edit-controls').hidden,false);
  f.view.buildTool = 'module'; f.view.placement.kind = 'hopper'; f.screen.render(f.model,f.view);
  assert.equal(f.screen.surface,null); assert.equal(f.view.buildTool,'module');
  assert.equal(f.inspector.hidden,false); assert.equal(f.screen.placement.hidden,false);
  assert.equal(f.controls.get('workshop-adjust').hidden,true);
  let cancelled = 0; f.controls.get('workshop-placement-cancel').onclick = () => {cancelled++;};
  f.screen.closeInspector(); assert.equal(cancelled,1);
});

test('quotation changes and a test return keep one visible surface and reuse the inspector nodes', t => {
  const f = fixture(t), adjust = f.controls.get('workshop-adjust');
  f.screen.render(f.model,f.view); f.screen.openTask('publish');
  assert.equal(f.controls.get('workshop-publish-empty').hidden,false);
  assert.equal(f.controls.get('publish-panel').hidden,true);
  assert.equal(f.screen.publishActions.hidden,true);
  f.model.panel.publish = {availableStock:{ferro:1,ligas:2,silica:3,combustivel:4}};
  f.screen.render(f.model,f.view);
  assert.equal(f.controls.get('workshop-publish-empty').hidden,true);
  assert.equal(f.controls.get('publish-panel').hidden,false);
  assert.equal(f.screen.publishActions.hidden,false);
  f.view.mode = 'test'; f.model.edit = false; f.screen.render(f.model,f.view);
  assert.equal(f.inspector.hidden,true); assert.equal(f.screen.surface,null);
  f.view.mode = 'edit'; f.model.edit = true; f.model.selection = [{id:'gun',name:'MAG'}];
  f.screen.render(f.model,f.view);
  assert.equal(f.inspector.hidden,false); assert.equal(f.inspector.querySelector('#workshop-adjust'),adjust);
  assert.equal(f.screen.surface,null); assert.equal(f.screen.panels.filter(panel => !panel.hidden).length,0);
  f.screen.closeInspector(); assert.deepEqual(f.selections,[[]]);
});

test('points of the frame chosen alone open the settings, named by what they are', t => {
  const f = fixture(t), title = () => f.controls.get('project-inspector-title').textContent;
  f.model.points = ['stretch:2']; f.screen.render(f.model,f.view);
  assert.equal(f.inspector.hidden,false); assert.equal(title(),'Trecho do chassi');
  f.model.points = ['node:a','node:b']; f.screen.render(f.model,f.view);
  assert.equal(title(),'2 pontos selecionados');
  f.model.selection = [{id:'plate-1',name:'Chapa'}]; f.screen.render(f.model,f.view);
  assert.equal(title(),'3 itens selecionados');
  f.model.selection = []; f.model.points = []; f.screen.render(f.model,f.view);
  assert.equal(f.inspector.hidden,true,'nothing chosen closes the settings');
});

test('number keys take the parts of the category shown in Adicionar, or last shown there, and nothing else is heard through a panel', async t => {
  let listener, chassis = 0, travel = 0;
  const f = fixture(t), palette = f.controls.get('palette'), clicked = [];
  palette.append(f.controls.get('catalog-edit'));
  for (const tile of palette.children) tile.addEventListener('click', () => clicked.push(tile.dataset.component || 'weapon'));
  const body = {matches:() => false}, viewport = {inert:false},
    context = {viewport, sidebar:f.sidebar, canvas:{}, editing:() => true, palette,
      document:{body, querySelectorAll:() => [], addEventListener:(_,handler) => {listener = handler;}},
      chooseChassis:() => {chassis++;}, press:() => {travel++;}};
  installPaletteKeys(context);
  const keys = (...values) => { clicked.length = 0; for (const value of values) listener({key:value,target:body,preventDefault() {}}); return [...clicked]; };
  f.sidebar.hidden = true;
  assert.deepEqual(keys('1','2','3','4','5'), ['engine','fuel','command','sensor'], 'Essenciais first, numbered with no gaps');
  f.screen.showCategory('combat');
  assert.deepEqual(keys('1','2','3'), ['ammo','weapon'], 'the Arsenal counts among the combat parts');
  f.screen.showCategory('cargo');
  assert.deepEqual(keys('1','6','7'), ['excavator','supply']);
  f.screen.openTask('project'); f.sidebar.hidden = false; viewport.inert = true;
  assert.deepEqual([keys('1','r','Enter'), chassis, travel], [[],0,0], 'Revisão open hears none of them');
  f.screen.openTask('build');
  assert.deepEqual([keys('2','r','Enter'), chassis, travel], [['drill'],0,0], 'Adicionar open hears its numbers only');
  f.screen.close(); f.sidebar.hidden = true; viewport.inert = false;
  assert.deepEqual([keys('1','r','Enter'), chassis, travel], [['excavator'],1,1], 'closed, the numbers keep the category last open');
});

test('percentages, structural gauge and free geometric fields display useful precision without editing the project value', async () => {
  const fitted = Object.freeze({ key: 'sizeScale', value: 86.127488 });
  assert.equal(shown(fitted), '86');
  assert.equal(fitted.value, 86.127488, 'display rounding never normalizes the admitted size');
  for (const key of ['gearScale', 'axleCount', 'armorMm', 'thicknessMm'])
    assert.equal(shown({ key, value: 17.6 }), '18', key);
  assert.equal(shown({ key: 'frameThicknessMm', value: 12.8 }), '12.8');
  assert.equal(shown({ key: 'frameThicknessMm', value: 9.600000000000001 }), '9.6');
  assert.equal(shown({ key: 'frameThicknessMm', value: 12 }), '12');
  assert.equal(shown({ key: 'standoff', value: 1.5 }), '1.5', 'a shaped charge bursts half a cone diameter at a time');
  const angle = Object.freeze({ key: 'angle', value: 11.309932 }), length = Object.freeze({ key: 'length', value: .617831 });
  assert.equal(shown(angle), '11.31'); assert.equal(angle.value, 11.309932);
  assert.equal(shown(length), '0.618'); assert.equal(length.value, .617831);
  assert.equal(shown({ key: 'sizeScale', value: null }), '');
});
