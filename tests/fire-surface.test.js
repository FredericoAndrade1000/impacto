import test from 'node:test';
import assert from 'node:assert/strict';
import { fireSurface, firePoint, fireProfilePixels, componentFirePoint } from '../src/fire-surface.ts';

const polygon = (left, right, roof) => [{ x: left, y: 0 }, { x: right, y: 0 }, { x: right, y: roof }, { x: left, y: roof }];
const scene = (panels, pose) => ({ frame: { source: { bodyPanels: panels } }, actor: () => pose });

test('engulfed fire sites follow the real stepped roof, cache its geometry and retain interpolated motion', () => {
  const panels = [{ actorId: 'v', localPolygon: polygon(-4, 4, 1), pose: { x: 0, y: 0 } },
    { actorId: 'v', localPolygon: polygon(-4, -1, 3) }], pose = { x: 256000, y: 2, angle: 0 },
    surface = fireSurface(scene(panels, pose), 'v');
  assert.equal(surface.points.length, 8);
  assert(surface.points.every(p => p.y === (p.x < -1 ? 3 : 1)));
  assert.equal(fireSurface(scene(panels, { ...pose, x: pose.x + 10 }), 'v').points, surface.points);
  const roots = surface.points.map((_, i) => firePoint(surface, { x: pose.x, y: 3 }, 1, (i + .5) / 8));
  assert(roots.at(-1).x - roots[0].x > 6.9);
  assert(roots.every(p => p.carrier === 'v' && p.y >= 3));
  const turned = fireSurface(scene(panels, { ...pose, angle: Math.PI / 2 }), 'v');
  const point = firePoint(turned, pose, 1, .1);
  assert(point.x >= pose.x - 3 && point.x <= pose.x);
  assert(Math.abs(point.y - (pose.y + (point.x < pose.x - 1 ? -1 : 4))) < 1e-8);
});

test('a small fire stays at its source and a roof gap cannot become a floating fire site', () => {
  const panels = [{ actorId: 'v', localPolygon: polygon(-4, -2, 2), pose: { x: 0, y: 0 } },
    { actorId: 'v', localPolygon: polygon(2, 4, 1) }], surface = fireSurface(scene(panels, null), 'v'), origin = { x: -3, y: 1 };
  const small = firePoint(surface, origin, 0, .5);
  assert(Math.abs(small.x - origin.x) < 1 && small.y === 2, 'weak smoke vents at the nearest visible hull surface');
  assert(surface.points.every(p => p.x <= -2 || p.x >= 2));
  assert.equal(fireSurface(scene(panels, null), 'unseen'), null, 'no hidden interior geometry is required');
});

test('an interior fire does not claim exterior tyres as part of the burning compartment', () => {
  const first = { actorId: 'v', localPolygon: polygon(-3, 0, 3), pose: { x: 10, y: 1 } }, body = { x: 10, y: 1, angle: 0 },
    frame = { source: { bodyPanels: [first], modules: [{ actorId: 'v', kind: 'wheel', attached: true, x: 15, y: 1, height: 1, width: 1 }] }, actors: new Map([['v', { vehicle: body }]]) },
    surface = fireSurface({ frame, actor: () => body }, 'v');
  assert(surface.points.length <= 8);
  const rear = firePoint(surface, { x: 8, y: 2 }, 1, .999);
  assert(rear.x < 10 && rear.y === 4, 'only the enclosed cab supplies this shared fire surface');
  assert(firePoint(surface, { x: 8, y: 2 }, 0, .999).x < 11, 'a weak engine ignition stays near the cab');
});

test('changing another panel invalidates the fire surface while the first panel stays the same', () => {
  const first = { actorId: 'v', localPolygon: polygon(-4, 4, 1), pose: { x: 0, y: 0 } },
    cab = { actorId: 'v', localPolygon: polygon(-4, -1, 3) },
    initial = fireSurface(scene([first, cab], null), 'v'),
    lowered = fireSurface(scene([first, { ...cab, localPolygon: polygon(-4, -1, 2) }], null), 'v'),
    removed = fireSurface(scene([first], null), 'v');
  assert(initial.points.some(p => p.y === 3));
  assert(lowered.points.some(p => p.y === 2) && lowered.points.every(p => p.y <= 2));
  assert(removed.points.every(p => p.y === 1), 'no flames stay suspended where the cab used to be');
});

test('a rolled or inverted vehicle vents flames on the upper hull in world space', () => {
  const panels = [{ actorId: 'v', localPolygon: polygon(-4, 4, 2), pose: { x: 0, y: 0 } }];
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const pose = { x: 256000, y: 10, angle }, c = Math.cos(angle), s = Math.sin(angle),
      top = Math.max(...panels[0].localPolygon.map(p => pose.y + s * p.x + c * p.y)),
      surface = fireSurface(scene(panels, pose), 'v');
    for (let i = 0; i < 8; i++) {
      const root = firePoint(surface, pose, 1, (i + .5) / 8);
      assert(Math.abs(root.y - top) < 1e-8, `angle ${angle}: flame root ${root.y} below upper surface ${top}`);
    }
  }
});

test('bounded flames follow actual burning pieces and leave the unlit space between them clear', () => {
  const panels = [{ actorId: 'v', localPolygon: polygon(-10, 10, 2), pose: { x: 0, y: 0 } }],
    view = scene(panels, { x: 0, y: 0, angle: 0 });
  view.frame.source.modules = [-8, 0, 8].map((x, i) => ({ id: `part-${i}`, actorId: 'v', kind: 'engine', x, y: 1,
    width: 1, burning: i !== 1, attached: true }));
  const surface = fireSurface(view, 'v'), roots = Array.from({ length: 100 }, (_, i) => firePoint(surface, { x: -8, y: 1 }, 1, (i + .5) / 100, 17));
  assert(roots.some(p => p.x < -7) && roots.some(p => p.x > 7));
  assert(roots.every(p => Math.abs(p.x) >= 7.6 && p.y === 2), 'no flame appears above the intact middle component');
});

test('an observer without interior parts can draw a local fire from the aggregate event alone', () => {
  const surface = fireSurface(scene([{ actorId: 'v', localPolygon: polygon(-10, 10, 2), pose: { x: 0, y: 0 } }], null), 'v');
  const roots = Array.from({ length: 30 }, (_, i) => firePoint(surface, { x: 3, y: 1 }, 1, (i + .5) / 30, .4));
  assert(roots.every(p => p.x >= 2.6 && p.x <= 3.4 && p.y === 2));
  assert(new Set(roots.map(p => p.x)).size > 20, 'roots are continuous rather than eight repeated torches');
});

test('the opened cutaway places flames at the burning component rather than above the roof', () => {
  const view = scene([{ actorId: 'v', localPolygon: polygon(-10, 10, 4) }], { x: 0, y: 0, angle: 0 });
  view.frame.source.modules = [{ id: 'lit', actorId: 'v', kind: 'fuel', x: 2, y: 1, width: 1, height: 1, burning: true },
    { id: 'safe', actorId: 'v', kind: 'fuel', x: 7, y: 1, width: 1, height: 1, burning: false }];
  const surface = fireSurface(view, 'v', true), root = firePoint(surface, { x: 2, y: 1 }, 1, .6, .5);
  assert.equal(root.carrier, 'lit'); assert(root.y < 2);
  assert(root.x >= 1.6 && root.x <= 2.4);
});

test('visible burning parts start on the face towards gravity while roots keep the interpolated component pose', () => {
  const part = { id: 'lit', actorId: 'v', kind: 'engine', x: 2, y: 3, width: 2, height: 1, burning: true },
    view = scene([{ actorId: 'v', localPolygon: polygon(-10, 10, 6) }], { x: 0, y: 0, angle: 0 });
  view.frame.source.modules = [part];
  for (const angle of [0, Math.PI / 2, Math.PI]) {
    const pose = { x: 12, y: 8, angle }; view.pose = () => pose;
    const surface = fireSurface(view, 'v', true), roots = Array.from({ length: 100 }, (_, i) => firePoint(surface, part, 1, (i + .5) / 100, 1)),
      local = roots.map(root => ({ x: Math.cos(angle) * (root.x - pose.x) + Math.sin(angle) * (root.y - pose.y),
        y: -Math.sin(angle) * (root.x - pose.x) + Math.cos(angle) * (root.y - pose.y) }));
    assert(roots.every(root => root.carrier === part.id));
    assert(roots.every(root=>root.y<pose.y),'the fuel bed is below the centre at each orientation');
    assert(Math.max(...roots.map(root=>root.x))-Math.min(...roots.map(root=>root.x))>.5,'the bed spreads across its downward face');
    assert(local.every(root => Math.abs(root.x) < part.width / 2 && Math.abs(root.y) < part.height / 2));
  }
});

test('artwork contacts stay on opaque material through reflection and rotation, with empty margins and holes',()=>{
  const width=32,height=32,pixels=new Uint8ClampedArray(width*height*4);
  for(let y=4;y<30;y++)for(let x=4;x<27;x++)if(!(x>9&&x<15&&y>11&&y<18))pixels[(y*width+x)*4+3]=255;
  for(let y=1;y<5;y++)for(let x=10;x<16;x++)pixels[(y*width+x)*4+3]=255;
  const profile=fireProfilePixels(pixels,width,height);assert(profile.every(run=>run.length));
  for(const mirrored of [false,true])for(const angle of [0,Math.PI/4,Math.PI/2,Math.PI,-Math.PI/3]){
    const part={id:'fuel',kind:'fuel',width:1.7,height:1.1,mirrored},pose={x:125000,y:4,angle},c=Math.cos(angle),s=Math.sin(angle);
    for(let i=0;i<=100;i++){
      const point=componentFirePoint(part,pose,i/100,profile),dx=point.x-pose.x,dy=point.y-pose.y,
        x=(c*dx+s*dy)/part.width*(mirrored?-1:1),y=(-s*dx+c*dy)/part.height,
        column=Math.floor((x+.5)*width),row=Math.floor((.5-y)*height);
      assert.equal(pixels[(row*width+column)*4+3],255);assert.equal(point.carrier,'fuel');
      assert(point.span>0,'the root carries the physical scale of its fuel, independent of tilt');
    }
  }
  assert.equal(fireProfilePixels(new Uint8ClampedArray(32*32*4),32,32),null);
});

test('a closed hull never queries interior artwork when projecting its fire onto the roof',()=>{
  const view=scene([{actorId:'v',localPolygon:polygon(-3,3,4)}],{x:0,y:0,angle:0});
  view.frame.source.modules=[{id:'fuel',actorId:'v',kind:'fuel',width:1,height:1,x:0,y:1,burning:true}];
  const surface=fireSurface(view,'v',false,()=>{throw Error('private artwork queried');});
  assert.equal(firePoint(surface,{x:0,y:1},1,.5,1).y,4);
});

test('open fires spend their contacts on burning parts beside the view, using the presented pose',()=>{
  const view=scene([{actorId:'v',localPolygon:polygon(-3,3,4)}],{x:0,y:0,angle:0});
  view.frame.source.modules=[{id:'near',actorId:'v',kind:'fuel',width:1,height:1,x:80,y:1,burning:true},
    {id:'far',actorId:'v',kind:'fuel',width:1,height:1,x:100,y:1,burning:true}];
  view.pose=id=>id==='near'?{x:0,y:1}:null;
  const surface=fireSurface(view,'v',true,null,{left:-3,right:3,bottom:0,top:5});
  assert.deepEqual(surface.burning.map(p=>p.id),['near']);
});

test('an open construction without hull panels still anchors fire on its visible fuel',()=>{
  const part={id:'fuel',actorId:'v',kind:'fuel',width:1,height:1,x:2,y:3,burning:true},
    view={frame:{source:{modules:[part]}},actor:()=>null,pose:()=>part};
  const surface=fireSurface(view,'v',true);assert(surface.opened);
  assert.equal(firePoint(surface,part,1,.5).carrier,'fuel');
  assert.equal(fireSurface(view,'v',false),null,'a closed observer does not infer a hull from private parts');
});
