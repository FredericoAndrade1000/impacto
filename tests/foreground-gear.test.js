import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPiece, Editor } from '../src/editor.ts';
import { localToWorld } from '../src/math.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
await initNativeDynamics();

test('foreground wheel picking uses its circle over underlying visible armour', () => {
  const plate = { id:'armour',x:12,y:1,angle:0,length:3,thicknessMm:1000,material:'steel' },
    wheel = {id:'wheel',kind:'wheel',x:12,y:1,angle:0,width:1,height:1},
    engine = {id:'engine',kind:'engine',x:12,y:1,angle:0,width:1.1,height:.8}, before=structuredClone([plate,wheel,engine]);
  assert.equal(pickPiece([plate],[wheel,engine],wheel,0),wheel.id);
  assert.equal(pickPiece([plate],[wheel,engine],{x:12.45,y:1.45},0),plate.id);
  assert.deepEqual([plate,wheel,engine],before);
});
test('a rotated track picks rounded caps rather than every point in its bounding box', () => {
  const track={id:'track',kind:'track',x:12,y:1,angle:.45,width:2,height:.8},
    plate={id:'armour',x:12,y:1,angle:.45,length:3,thicknessMm:1000,material:'steel'};
  assert.equal(pickPiece([plate],[track],track,0),track.id);
  assert.equal(pickPiece([plate],[track],localToWorld(track,-.95,.35),0),plate.id);
});
test('the gear comes with the chassis: clicking it picks the chassis, and it has no anchor of its own to edit', () => {
  const editor=new Editor(createConstruction('scout')), wheel=editor.blueprint.modules.find(m=>m.kind==='wheel'),
    before=structuredClone(editor.source);
  // The wheel comes with the chassis, on its rail: the design writes no piece for it to move.
  assert.equal(wheel.mountId,'chassis:rail-0'); assert(!editor.source.components.some(part=>part.id===wheel.id));
  assert.equal(editor.pick(wheel),'chassis:frame-0'); editor.select(wheel.id);
  editor.editProperty('y',wheel.y+.2,true);
  assert.deepEqual(editor.source,before); assert.equal(editor.past.length,0);
});
test('the observed barrel remains selectable in front of overlapping running gear', () => {
  const editor=new Editor(createConstruction('scout')), gun=editor.blueprint.modules.find(m=>m.kind==='weapon'),
    point={x:gun.x+Math.cos(gun.barrelAngle)*.4,y:gun.y+Math.sin(gun.barrelAngle)*.4},
    wheel={id:'wheel',kind:'wheel',...point,angle:0,width:1,height:1};
  assert.equal(pickPiece([], [gun,wheel],point,.01),gun.id);
});

