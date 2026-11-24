import test from 'node:test';
import assert from 'node:assert/strict';
import { Container } from 'pixi.js';
import { headlessPixi } from './helpers/headless-pixi.js';
import { groundSurfaces } from './helpers/ground-art.js';
import { miningWorld } from './helpers/mining-mobility.js';
import { paintAuthoredDetails } from '../src/hull-art.ts';
import { Renderer } from '../src/render.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { detailAt, editableDetailHosts } from '../src/vehicle-details.ts';

headlessPixi();

// Record the handedness at the actual image composition boundary. Rotation preserves its determinant;
// the last host/view reflection is applied outside the cached bitmap by the renderer.
function stampedHandedness(detail, letteringMirror) {
  const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d'), stack=[], drawn=[];
  let sign=1;
  Object.assign(canvas,{width:400,height:200});
  ctx.save=()=>stack.push(sign);ctx.restore=()=>{sign=stack.pop();};
  ctx.setTransform=(a,b,c,d)=>{sign=Math.sign(a*d-b*c);};
  ctx.scale=(x,y)=>{sign*=Math.sign(x*y);};
  ctx.drawImage=()=>drawn.push(sign);
  paintAuthoredDetails(canvas,{left:0,bottom:0,width:4,height:2,letteringMirror},
    [{x:2,y:1,angle:.27,width:.34,height:.2,text:'24',...detail}],0x68765a);
  return drawn[0];
}

test('number glyphs stay readable through authored and final surface reflection; directional art still reflects',()=>{
  for(const authored of [false,true]) for(const outer of [false,true]) {
    const host=outer ? -1 : 1;
    assert.equal(host*stampedHandedness({kind:'number',mirrored:authored},outer),1,'readable final digits');
    assert.equal(stampedHandedness({kind:'cab-door',mirrored:authored},outer),authored ? -1 : 1,'door handedness stays authored');
  }
});

function numberedCarrier() {
  const source=createConstruction('supply'), hosts=editableDetailHosts(compileBlueprint(source));
  for(const surface of ['chassis','part']) {
    const host=hosts.find(h=>h.surface===surface && (surface!=='part'||h.host==='supply'));
    source.appearance.details.push(detailAt(host,host.pose,'number',surface+'-number',{text:'24'}));
  }
  return source;
}

// The cargo of the carrier is reflected in its own frame; `authored` reflects it back.
const unreflected=source=>({...source,components:source.components.map(part=>part.id==='supply' ? {...part,pose:{...part.pose,mirrored:!part.pose.mirrored}} : part)});
for(const authored of [false,true]) for(const facing of [-1,1])
  test(`cached body, chassis and component numbers compensate the final view, cargo reflected=${!authored}, facing=${facing}`,t=>{
    const original=numberedCarrier(), source=authored ? unreflected(original) : original,
      world=miningWorld(source,{facing,direction:facing,grade:0,cargo:null});
    t.after(()=>world.dispose());
    const state=world.snapshot(), actor=state.actors[0], renderer=new Renderer({}, {mode:'test'}), requests=[];
    renderer.app={stage:new Container(),renderer:{render(){},resize(){},backBuffer:{useBackBuffer:false}}};
    renderer.buildScene(groundSurfaces());renderer.texturePainter={available:false};
    renderer.scene=sampleScene(state);renderer.syncActorLayers(state);renderer.closed.add(actor.id);
    const originalTexture=renderer.progressiveTexture.bind(renderer);
    renderer.progressiveTexture=(key,describe,options)=>originalTexture(key,()=>{
      const request=describe();requests.push(request);return request;
    },options);
    t.after(()=>{for(const entry of renderer.textures.values()) entry.texture.destroy(true);renderer.app.stage.destroy({children:true});});
    const cargo=state.modules.find(p=>p.kind==='supply');
    for(const turn of [1,-1]) {
      renderer.frameNow+=100; // The existing 80 ms art interval has elapsed before changing the view.
      Object.defineProperty(renderer.camera,'turn',{value:turn,configurable:true});requests.length=0;
      renderer.drawBodyPanels(state,1);renderer.drawChassisArt(state);renderer.moduleTexture(cargo);
      const body=requests.find(r=>r.type==='hull'&&r.layout.details.some(d=>d.kind==='number')),
        chassis=requests.find(r=>r.type==='chassis'), part=requests.find(r=>r.type==='module'&&r.options.details.some(d=>d.kind==='number')),
        layers=renderer.actorLayers.get(actor.id);
      assert(body&&chassis&&part,JSON.stringify({turn,body:!!body,chassis:!!chassis,part:!!part,requests:requests.map(r=>[r.type,r.options.details?.length,r.layout?.details?.length])}));
      assert.equal(body.options.letteringMirror,turn<0);
      assert.equal(chassis.options.letteringMirror,(layers.chassisArt.scale.y<0)!==(turn<0));
      assert.equal(part.options.letteringMirror,Boolean(cargo.mirrored)!==(turn<0));
      for(const request of [body,chassis,part]) {
        const details=request.type==='hull' ? request.layout.details : request.options.details,
          number=details.find(d=>d.kind==='number'), outer=request.options.letteringMirror;
        assert.equal(stampedHandedness(number,outer)*(outer ? -1 : 1),1,request.type+' final text');
      }
      requests.length=0;
      renderer.drawBodyPanels(state,1);renderer.drawChassisArt(state);renderer.moduleTexture(cargo);
      assert.equal(requests.length,0,'movement frames reuse the same painted images');
    }
    assert.deepEqual(source,authored ? unreflected(original) : original,'painting never rewrites saved detail flags');
  });
