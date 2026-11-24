import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Effects } from '../src/effects.ts';
import { Terrain } from '../src/terrain.ts';
import { GROUND_SURFACES } from '../src/ground-impact.ts';

function effects(t, terrain) {
  const parent = new Container(), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
    spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY }, fx = new Effects(parent, atlas);
  fx.terrain = terrain;
  t.after(() => { fx.clear(); parent.destroy({ children: true }); }); return fx;
}
const dust = fx => fx.particles.filter(p => p.groundDust);
const blast = (terrain, x = 12) => ({ type: 'explosion', actorId: 'tank', time: 0, x,
  y: terrain.height(x) + .1, power: 600, radius: 4.5 });

test('blast dust uses the surface color, appears behind the fast wave and retires within two seconds', t => {
  const terrain = new Terrain('sand'), fx = effects(t, terrain), event = Object.freeze(blast(terrain)), before = structuredClone(event);
  fx.consume([event]); const emitted = dust(fx), starts = emitted.map(p => p.x);
  assert.equal(emitted.length, 12); assert.deepEqual(event, before);
  assert(emitted.every(p => p.tint === GROUND_SURFACES.sand.dust && fx.atlas.smoke.includes(p.sprite.texture)));
  assert(emitted.every(p => p.sprite.alpha === 0 && p.life < 2 && p.opacity <= .3 && p.aspectX > p.aspectY * 5));
  fx.update(.05); fx.sample(1);
  assert(emitted.every((p, i) => p.sprite.alpha === 0 && p.x === starts[i]), 'dust does not jump ahead of the initial wave');
  fx.update(.25); fx.sample(1);
  assert(emitted.every(p => p.sprite.alpha > 0 && p.sprite.alpha < .3));
  assert(emitted.some((p, i) => p.x < starts[i]) && emitted.some((p, i) => p.x > starts[i]), 'dust spreads to both sides');
  assert(emitted.every(p => p.sprite.scaleY * 128 < .4), 'the cloud stays low instead of becoming another smoke column');
  fx.update(2); assert(emitted.every(p=>!fx.particles.includes(p)), 'the initial pressure skirt retires within two seconds');
  fx.update(5);assert.equal(dust(fx).length,0,'landing dust also retires');
});

test('fine explosion dust stays dense and airborne after the solid debris becomes invisible',t=>{
  const terrain=new Terrain('hills'),fx=effects(t,terrain),event=blast(terrain,37),before=JSON.stringify(terrain.snapshot());
  fx.consume([event]);const airborne=fx.particles.filter(p=>p.art==='denseSmoke'),sprites=new Map(airborne.map(p=>[p,p.sprite])),
    initial=fx.particles.length;
  assert(airborne.length>0);
  for(let i=0;i<240;i++){
    fx.update(1/60);fx.sample(.5);assert(fx.particles.length<=initial,'a lingering cloud adds no secondary particles');
    for(const p of airborne){
      assert.equal(p.sprite,sprites.get(p));assert(p.vy>=0,'suspended fine dust does not follow a falling clod');
    }
    if(i===60)assert(!fx.particles.some(p=>p.kind==='dust'),'solid fragments disappear early inside the plume');
  }
  assert(airborne.every(p=>fx.particles.includes(p)&&p.y>event.y+1&&p.sprite.alpha>.3),'the dense column remains after four seconds');
  fx.update(3);assert.equal(fx.particles.length,0,'the presentation cloud still has a finite lifetime');
  assert.equal(JSON.stringify(terrain.snapshot()),before);
});

test('dust follows the real downhill, valley and ridge surfaces instead of freezing at the explosion altitude', t => {
  for (const [id, x] of [['hills', 37], ['wet-valley', -121], ['rural-ridges', 12]]) {
    const terrain = new Terrain(id), before = JSON.stringify(terrain.snapshot()), fx = effects(t, terrain);
    fx.consume([blast(terrain, x)]); const starts = new Map(dust(fx).map(p => [p, p.x]));
    for (let i = 0; i < 75; i++) {
      fx.update(1 / 60); fx.sample(.5);
      for (const p of dust(fx)) {
        const clearance = p.y - terrain.height(p.x), shownClearance = p.sprite.y - terrain.height(p.sprite.x);
        assert(clearance >= .039 && clearance <= .066, id + ' actual dust stays on the surface');
        assert(shownClearance >= .039 && shownClearance <= .066, id + ' interpolated dust stays above the exact surface');
        assert(p.sprite.scaleY * 128 < .5 && p.sprite.scaleX > p.sprite.scaleY * 5);
      }
    }
    assert(dust(fx).some(p => Math.abs(p.x - starts.get(p)) > 2), id + ' visibly spreads along the terrain');
    assert.equal(JSON.stringify(terrain.snapshot()), before, 'presentation cannot change the mechanical contour');
  }
});

test('stationary dust reuses only its local segment and invalidates it when the terrain changes', t => {
  const terrain = new Terrain('hills'), fx = effects(t, terrain);
  let queries = 0; const segment = terrain.segment.bind(terrain);
  terrain.segment = x => { queries++; return segment(x); };
  fx.consume([blast(terrain, 37)]);
  for (const p of [...fx.particles]) if (!p.groundDust) fx.retire(p);
  fx.particles = dust(fx); for (const p of fx.particles) p.vx = 0;
  const initialQueries = queries;
  for (let i = 0; i < 100; i++) { fx.update(1 / 600); fx.sample(.5); }
  assert.equal(queries, initialQueries, 'no terrain query is repeated for dust inside its cached segment');
  const shifted = new Terrain('hills'); shifted.points = shifted.points.map(p => ({ x: p.x, y: p.y + .5 })); fx.terrain = shifted;
  fx.update(1 / 60); fx.sample(1);
  assert(dust(fx).every(p => p.y > shifted.height(p.x) && p.y < shifted.height(p.x) + .07));
  assert(dust(fx).every(p => p.dustSurface.terrain === shifted));
});

test('interpolation cannot cut dust through a narrow terrain peak between two displayed positions', t => {
  const points = [{ x: -1, y: 0 }, { x: 0, y: 2 }, { x: .02, y: 4 }, { x: .04, y: 2 }, { x: 1, y: 0 }],
    terrain = { points, segment(x) {
      const index = Math.max(0, Math.min(points.length - 2, points.findIndex(p => p.x > x) - 1));
      return [points[index], points[index + 1]];
    }, height(x) { const [a, b] = this.segment(x); return a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x); } },
    fx = effects(t, terrain), p = fx.add('smoke', { groundDust: true, x: -.01, y: terrain.height(-.01) + .04,
      vx: 1, vy: 0, life: 2, drag: 0, dustDelay: 0, dustLift: .04, size: .3, grow: .2, aspectX: 3, aspectY: .3, opacity: .2 });
  fx.update(.08); fx.sample(.375);
  assert(Math.abs(p.sprite.x - .02) < 1e-10); assert(p.sprite.y > 4);
  assert(p.sprite.y < 4.07, 'sampled height comes from the peak, not a straight chord through it');
});
