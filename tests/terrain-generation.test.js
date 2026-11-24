import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, TERRAIN_PROFILES, BATTLE_TERRAIN_IDS, BIOME_IDS, RoughGround } from '../src/terrain.ts';
import { Container, Mesh, Texture } from 'pixi.js';
import { TerrainScene, DETAIL_ZOOM, FLORA_ZOOM, OVERVIEW_ZOOM, OVERVIEW_EXIT_ZOOM, WIDE_EXIT_ZOOM } from '../src/terrain-scene.ts';
import { biomeFade } from '../src/terrain-art.ts';
import { BED_TOPS, buildStrata, strataTones } from '../src/strata-art.ts';
import { plantFlora } from '../src/flora-art.ts';
import { groundGrains, groundInstructions } from './helpers/ground-art.js';

for (const id of BATTLE_TERRAIN_IDS) test(`${id}: multi-kilometre maps have a bounded, reproducible contact contour`, () => {
  for (const length of [1000, 4096, 4097, 8192, 8193, 16000]) for (const seed of [0, 1, 6173, 0xffffffff]) {
    const terrain = new Terrain(id, { length, seed, center: 12 });
    assert(terrain.points.length <= 4099);
    assert.equal(terrain.maxX - terrain.minX, length);
    assert.deepEqual(Terrain.fromSnapshot(terrain.descriptor()).points, terrain.points);
    assert.deepEqual(new Terrain(id, { length, seed, center: -217.5 }).points.map(p => p.y), terrain.points.map(p => p.y));
    for (const x of [terrain.minX + .1, 17.3, terrain.maxX - .1, terrain.maxX]) {
      const surface = terrain.surface(x), hit = terrain.raycast({ x, y: surface.y + 5 }, { x, y: surface.y - 1 });
      assert(Math.abs(surface.y - terrain.height(x)) < 1e-10);
      assert(hit && Math.abs(hit.y - surface.y) < 1e-10);
    }
    for (let i = 1; i < terrain.sectors.length; i++) assert.equal(terrain.sectors[i - 1].end, terrain.sectors[i].start);
  }
});

for (const id of ['highlands', 'plateau']) test(`${id}: large relief stays below 30 degrees with smooth, continuous approaches`, () => {
  for (let seed = 0; seed < 80; seed++) {
    const terrain = new Terrain(id, { seed, length: seed % 2 ? 16000 : 1600 });
    let steepest = 0, previous = 0;
    for (let i = 1; i < terrain.points.length - 2; i++) {
      const a = terrain.points[i], b = terrain.points[i + 1], slope = (b.y - a.y) / (b.x - a.x);
      assert(Math.abs(slope) < Math.tan(Math.PI / 6), `impassable grade for seed ${seed}: ${slope}`);
      assert(Math.abs(slope - previous) < .04 * (b.x - a.x), `abrupt corner for seed ${seed}`);
      steepest = Math.max(steepest, Math.abs(slope)); previous = slope;
    }
    assert(steepest > .3, 'relief must include actual hills, not only taller background art');
    assert(Math.max(...terrain.points.map(p => p.y)) - terrain.minHeight > 20);
    if (id === 'plateau') {
      const mesa = terrain.features.find(f => f.kind === 'plateau');
      assert(mesa && mesa.crest >= 70);
      for (let x = mesa.peak - mesa.crest / 2 + 4; x < mesa.peak + mesa.crest / 2 - 4; x += 4)
        assert(Math.abs(terrain.surface(x).slope) < .065, 'the plateau must have a broad usable summit');
    }
  }
});

for (const id of ['highlands', 'plateau']) test(`${id}: valleys keep distinct elevations and consecutive climbs across a region`, () => {
  for (const seed of [0, 1, 6173, 0xffffffff]) {
    const terrain = new Terrain(id, { seed, length: 16000 }),
      valleys = terrain.features.filter(f => f.kind === 'drywash').map(f => terrain.height(f.peak));
    assert(Math.max(...valleys) - Math.min(...valleys) > 100, 'distant valleys must not return to the same floor');
    let climb = 0, descent = 0, longest = 0;
    for (let i = 1; i < valleys.length; i++) {
      const change = valleys[i] - valleys[i - 1];
      climb = change > .5 ? climb + 1 : 0; descent = change < -.5 ? descent + 1 : 0;
      longest = Math.max(longest, climb, descent);
    }
    assert(longest >= 4, 'geography must permit several successive ascents or descents');
    const small = new Terrain(id, { seed, length: 1600 }), extended = new Terrain(id, { seed, length: 8000 });
    for (let x = -128; x <= 128; x += 16)
      assert.equal(small.height(x), extended.height(x), 'extending a map must preserve its central geography');
  }
});

test('long terrain art is painted where the camera is and preserves every physical seam', () => {
  const terrain = new Terrain('plateau', { length: 16000 }), roots = [new Container(), new Container()],
    scene = new TerrainScene(...roots), before = terrain.snapshot(), painted = () => scene.chunks.filter(c => c.earth);
  try {
    scene.rebuild(terrain);
    assert(scene.chunks.every(chunk => chunk.right - chunk.left <= 160)); assert.equal(painted().length, 0);
    for (const [i, chunk] of scene.chunks.entries()) if (i) assert.equal(chunk.left, scene.chunks[i - 1].right);
    assert.equal(scene.chunks[0].left, terrain.points[0].x); assert.equal(scene.chunks.at(-1).right, terrain.points.at(-1).x);
    scene.update({ x: -7000, width: 1200, zoom: 30 });
    const first = painted(), { earth, strata, fine, props } = first[0];
    assert(first.length >= 1 && first.length <= 2);
    assert(strata instanceof Mesh && fine && props, 'a near view has the earth under the ground and the detail on it');
    assert.equal(strata.geometry.batchMode, 'no-batch', 'the camera moves a stretch of earth: it rewrites none of its corners');
    for (let i = 0; i < 1000; i++) {
      scene.update({ x: -7000 + i * 14, width: 1200, zoom: 30 });
      assert(scene.chunks.filter(c => c.earth?.visible).length <= 2);
      assert(painted().reduce((metres, chunk) => metres + chunk.right - chunk.left, 0) < 13000, 'retained nearby ground stays within its former twelve-kilometre reach');
    }
    for (const [name, layer] of Object.entries(scene.layers))
      assert(layer.children.length <= painted().length * (name === 'surface' ? 2 : 1), 'each retained chunk has at most one soil drawing and one stone group');
    assert(roots[1].children.length <= painted().length);
    // So near, the ground is drawn with its bumps: its top starts at the end of the chunk as high as they have it there,
    // which the next chunk reckons alike.
    for (const chunk of painted()) {
      const positions = chunk.earth.geometry.attributes.aPosition.buffer.data,
        top = Math.fround(new RoughGround(terrain, chunk.left, chunk.right).height(chunk.left));
      assert(positions.some((x, i) => i % 2 === 0 && x === 0 && positions[i + 1] === top));
    }
    assert(earth.destroyed && strata.destroyed && fine.destroyed && props.destroyed, 'ground left far behind is forgotten');
    const near = painted().at(-1), kept = near.earth;
    scene.update({ x: near.left - 600, width: 1200, zoom: 30 }); scene.update({ x: near.left + 10, width: 1200, zoom: 30 });
    assert.equal(near.earth, kept, 'ground close by is not painted twice');
    assert.equal(scene.builds, 1); assert.deepEqual(terrain.snapshot(), before);
    const old = painted().flatMap(c => [c.earth, c.strata, c.fine]), tones = scene.tones; scene.rebuild(new Terrain('highlands', { length: 8000 }));
    assert(old.every(g => !g || g.destroyed)); assert.equal(scene.builds, 2); assert.equal(scene.painted, 0);
    assert(tones.destroyed && !scene.tones.destroyed, 'each map has its own tones of earth, and frees the last');
    assert(Object.values(scene.layers).every(layer => layer.children.length === 0));
    // A test track is one piece, painted at once.
    scene.rebuild(new Terrain('mixed')); assert.equal(scene.chunks.length, 1); assert(scene.chunks[0].earth && scene.chunks[0].strata);
  } finally { scene.clear(); for (const root of roots) root.destroy(); }
});

test('the world is a row of the five biomes that a longer map only adds to', () => {
  for (const seed of [0, 1, 6173, 930222, 0xffffffff]) {
    const world = new Terrain('world', { seed, length: 64000, center: 12 });
    assert.equal(world.points.length, 16003);
    assert.deepEqual([...new Set(world.biomes.map(b => b.id))].sort(), [...BIOME_IDS].sort());
    assert(world.biomes[0].start <= world.minX && world.biomes.at(-1).end >= world.maxX);
    for (const [i, region] of world.biomes.entries()) {
      if (i) { assert.equal(region.start, world.biomes[i - 1].end); assert.notEqual(region.id, world.biomes[i - 1].id); }
      assert(region.end - region.start >= 2000, 'a region is kilometres long');
      const middle = (Math.max(region.start, world.minX) + Math.min(region.end, world.maxX)) / 2;
      assert.equal(world.regionAt(middle), region); assert.equal(world.biomeAt(middle), region.id);
    }
    // The ground is one continuous, drivable outline across every border, standing clear of zero.
    assert.equal(world.minHeight, Math.fround(world.minHeight)); assert(Math.abs(world.minHeight - 20) < 1e-3);
    for (let i = 1; i < world.points.length - 2; i++) {
      const a = world.points[i], b = world.points[i + 1];
      assert(Math.abs((b.y - a.y) / (b.x - a.x)) < Math.tan(Math.PI / 6), `impassable grade for seed ${seed} at ${a.x}`);
    }
    // Every landform lies well inside a region of its own kind.
    const kinds = { plateau: 'plateau', scarp: 'plateau', lowland: 'wet-valley' };
    for (const f of world.features) {
      const region = world.regionAt(f.peak);
      assert(f.start >= region.start + 159 && f.end <= region.end - 159);
      if (kinds[f.kind]) assert.equal(region.id, kinds[f.kind]);
    }
    // A shorter map of the same seed is the middle of the longer one, at another altitude:
    // only the landforms its own edges cut are missing from it.
    const small = new Terrain('world', { seed, length: 16000, center: 12 }), shift = small.height(12) - world.height(12);
    for (let x = -7400; x <= 7400; x += 185) assert(Math.abs(small.height(x) - world.height(x) - shift) < 1e-3);
    for (const region of small.biomes) assert.equal(world.biomeAt((Math.max(region.start, small.minX) + Math.min(region.end, small.maxX)) / 2), region.id);
    // A frame names the world; whoever draws it grows the same ground.
    assert.deepEqual(world.reference(), { seed, length: 64000, center: 12 });
    assert.deepEqual(new Terrain('world', world.reference()).points, world.points);
  }
  assert.deepEqual(new Terrain('mixed').reference(), new Terrain('mixed').snapshot());
  const plain = new Terrain('highlands', { length: 4000 });
  assert.equal(plain.biomeAt(100), 'highlands');
});

test('the art of the world changes with the biome under it', () => {
  // Distinct shared samplers retain their material identity as meshes appear and hide.
  const world = new Terrain('world', { length: 64000 }), roots = [new Container(), new Container()], grains = groundGrains(),
    scene = new TerrainScene(...roots, { grains, flora: Texture.WHITE });
  try {
    scene.rebuild(world);
    for (const chunk of scene.chunks) {
      assert(chunk.right - chunk.left <= 160);
      assert.equal(world.biomeAt(chunk.left + 1e-6), chunk.biome); assert.equal(world.biomeAt(chunk.right - 1e-6), chunk.biome);
    }
    assert.deepEqual([...new Set(scene.chunks.map(c => c.biome))].sort(), [...BIOME_IDS].sort());
    // A wide view still prepares only its local stretch of the map: the widest the short stretches draw.
    const camera = { x: 12, width: 2000, zoom: WIDE_EXIT_ZOOM };
    scene.update(camera, 0);
    const seen = () => scene.chunks.filter(c => c.earth?.visible);
    // Vegetation is prepared across frames. Compare the complete view once its local budget has filled it.
    for (let frame = 1; frame <= seen().length && seen().some(c => !c.plants); frame++) scene.update(camera, frame * 16);
    assert(seen().every(c => c.plants), 'visible vegetation finishes preparing in a bounded number of frames');
    assert(seen()[0].left <= 12 - 2000 && seen().at(-1).right >= 12 + 2000, 'the entire view has ground');
    assert(seen().reduce((metres, chunk) => metres + chunk.right - chunk.left, 0) < 4400, 'nearby ground stays local to the view');
    // From there no stone or blade of grass is a pixel across: none is built, and the view is a few meshes for each chunk.
    assert(scene.chunks.every(c => !c.fine && !c.soil)); assert.equal(scene.layers.detail.children.length, 0); assert.equal(roots[1].children.length, 0);
    for (const chunk of seen()) {
      assert(chunk.strata.visible && !chunk.grain.visible); assert.equal(chunk.grain.children.length, 2);
      for (const [i, kind] of ['soil', 'rock'].entries()) {
        const mesh = chunk.grain.children[i];
        assert(mesh instanceof Mesh); assert.equal(mesh.geometry.batchMode, 'no-batch'); assert.equal(mesh.texture, grains[kind]);
      }
    }
    assert(seen().some(c => c.flora?.visible), 'a wood shows from afar');
    // A chunk that has ruins draws them besides, and they show as far off as its ground does.
    const ruined = seen().filter(c => c.ruins);
    assert(ruined.length && ruined.every(c => c.ruins.visible), 'ruins show from afar');
    // The original ground budget still holds. Foreground adds at most one wood
    // mesh per chunk, partitioning its existing plants instead of duplicating them.
    const front = seen().flatMap(c => c.frontFlora ? [c.frontFlora] : []);
    assert.deepEqual(new Set(scene.layers.frontFlora.children), new Set(front));
    assert.equal(scene.layers.frontCover.children.length, 0, 'distant detail is not prepared for the front row either');
    const ordinary = Object.values(scene.layers).filter(layer => layer !== scene.layers.frontFlora);
    const stoneGroups = scene.chunks.filter(chunk => chunk.stones).length;
    assert(ordinary.reduce((sum, layer) => sum + layer.children.length, 0) <= 4 * scene.painted + ruined.length + stoneGroups);
    for (const chunk of seen()) {
      const plants = plantFlora(world, chunk.left, chunk.right, chunk.biome, scene.chunks.indexOf(chunk)),
        xs = [chunk.flora, chunk.frontFlora].filter(Boolean).flatMap(mesh => {
          const { positions, indices } = mesh.geometry;
          assert.equal(positions.length / 8, indices.length / 6, 'one quad per plant');
          return Array.from({ length: indices.length / 6 }, (_, i) => chunk.left + (positions[i * 8] + positions[i * 8 + 2]) / 2);
        }).sort((a, b) => a - b), expected = plants.map(p => p.x).sort((a, b) => a - b);
      assert.equal(xs.length, expected.length, 'moving low shrubs forward adds no plants');
      for (const [i, x] of xs.entries()) assert(Math.abs(x - expected[i]) < 1e-4, 'every original plant appears once at its own world position');
    }
    // Further still a tree is under a pixel too.
    scene.update({ x: 12, width: 1600, zoom: FLORA_ZOOM * .9 }); assert(scene.allChunks.every(c => !c.flora?.visible && !c.frontFlora?.visible));
    // The camera closes in: the stretch under it gains its detail once, and keeps it hidden when the camera draws back.
    scene.update({ x: 12, width: 1600, zoom: DETAIL_ZOOM });
    const near = scene.chunks.filter(c => c.fine), fine = near.map(c => c.fine);
    assert(near.length >= 1 && near.every(c => c.earth.visible && c.fine.visible && c.props.visible && c.soil?.visible && c.grain.visible));
    scene.update({ x: 12, width: 1600, zoom: DETAIL_ZOOM * .99 });
    assert(near.every(c => !c.fine.visible && !c.props.visible && !c.soil.visible && c.earth.visible));
    scene.update({ x: 12, width: 1600, zoom: 80 }); assert.deepEqual(scene.chunks.filter(c => c.fine).map(c => c.fine), fine);
    assert(fine.some(g => g.visible) && fine.every(g => !g.destroyed));
    // What is forgotten takes its meshes with it, and leaves the sheets it read.
    const parts = near.flatMap(c => [c.strata, c.grain, c.soil, c.flora, c.frontFlora, c.frontCover].filter(Boolean)); scene.clear();
    assert(parts.length >= 3 && parts.every(part => part.destroyed)); assert.equal(Texture.WHITE.destroyed, false);
  } finally { scene.clear(); for (const root of roots) root.destroy(); for (const texture of Object.values(grains)) texture.destroy(true); }
});

test('zooming out over kilometres builds no invisible vegetation and restores it lazily when approaching', () => {
  const world = new Terrain('world', { length: 64000 }), roots = [new Container(), new Container()], grains = groundGrains(),
    scene = new TerrainScene(...roots, { grains, flora: Texture.WHITE });
  // Far, though not so far that the stretches of four kilometres stand in for those of one.
  const far = (OVERVIEW_ZOOM + OVERVIEW_EXIT_ZOOM) / 2, shown = () => scene.allChunks.filter(chunk => chunk.earth?.visible);
  try {
    scene.rebuild(world); scene.update({ x: 12, width: 1600, zoom: far });
    const distant = shown();
    assert(distant.length > 8 && distant.every(chunk => chunk.wide), 'the view spans kilometres of the stretches of one');
    assert(scene.allChunks.every(chunk => !chunk.plants && !chunk.flora && !chunk.grain?.visible));
    for (const zoom of [.4, 1]) {
      scene.update({ x: 12, width: 1600, zoom });
      const wooded = shown().filter(chunk => chunk.flora?.visible), meshes = wooded.map(chunk => chunk.flora);
      assert(wooded.length > 0);
      scene.update({ x: 12, width: 1600, zoom: far }); assert(wooded.every(chunk => !chunk.flora.visible));
      scene.update({ x: 12, width: 1600, zoom }); assert(wooded.every((chunk, i) => chunk.flora === meshes[i] && chunk.flora.visible));
    }
    assert.equal(Texture.WHITE.destroyed, false);
  } finally { scene.clear(); for (const root of roots) root.destroy(); for (const texture of Object.values(grains)) texture.destroy(true); }
});

test('preparing a new chunk reads its local contour without scanning the whole world', () => {
  const world = new Terrain('world',{seed:6173,length:512000}), roots=[new Container(),new Container()], scene=new TerrainScene(...roots);
  try {
    scene.rebuild(world);
    const points=world.points, sectors=world.sectors, chunk=scene.chunks.find(chunk=>chunk.left<=12 && chunk.right>12),
      expected=points.filter(point=>point.x>chunk.left && point.x<chunk.right), expectedSectors=sectors.filter(sector=>sector.end>chunk.left && sector.start<chunk.right);
    let reads=0;
    world.points=new Proxy(points,{get(target,key){if(typeof key==='string' && /^\d+$/.test(key))reads++;return Reflect.get(target,key);}});
    const local=scene.local(chunk);
    assert.deepEqual(local.points.slice(1,-1),expected); assert.deepEqual(local.sectors,expectedSectors);
    assert(reads<expected.length+200,`${reads} point reads for ${expected.length} local points in a ${points.length}-point world`);
    assert.equal(local.points[0].x,chunk.left);assert.equal(local.points.at(-1).x,chunk.right);
    world.points=points;
  } finally {scene.clear();roots.forEach(root=>root.destroy());}
});

test('approaching new ground prepares only small visible detail tiles and releases their geometry', () => {
  const world=new Terrain('world',{seed:6173,length:64000}), roots=[new Container(),new Container()], grains=groundGrains(),
    scene=new TerrainScene(...roots,{grains,flora:Texture.WHITE});
  try {
    scene.rebuild(world);
    const chunk=scene.chunks.find(chunk=>world.materialAt(chunk.left+(chunk.right-chunk.left)/8)==='soil'), x=chunk.left+(chunk.right-chunk.left)/8;
    // A close view prepares the visible tile while the rest of its base stays coarse.
    for (let frame=0;frame<3;frame++) scene.update({x,width:1000,zoom:80},frame*100);
    const made=chunk.details.filter(part=>part.fine);
    assert(made.length>0 && made.length<chunk.details.length,'a close view must leave invisible detail unprepared');
    assert(chunk.details.every(part=>part.right-part.left<=64));
    const pictures=made.map(part=>part.fine), soil=made.map(part=>part.soil).filter(Boolean), meshes=soil.flatMap(part=>part.children),
      geometries=meshes.map(part=>part.geometry), buffers=geometries.flatMap(geometry=>geometry.buffers);
    assert(soil.length>0 && soil.every(part=>part instanceof Container && part.children.every(child=>child instanceof Mesh)));
    scene.update({x:x+1,width:1000,zoom:80}); assert.deepEqual(chunk.details.filter(part=>part.fine).map(part=>part.fine),pictures);
    scene.forget(chunk);
    assert(pictures.every(part=>part.destroyed));assert(soil.every(part=>part.destroyed));assert(meshes.every(part=>part.destroyed));assert(geometries.every(geometry=>geometry.buffers===null));
    assert(buffers.length>0 && buffers.every(buffer=>buffer.destroyed),'tile-owned GPU buffers must be released immediately');
    assert.equal(Texture.WHITE.destroyed,false);
  } finally {scene.clear();roots.forEach(root=>root.destroy());for(const texture of Object.values(grains))texture.destroy(true);}
});

test('across a border of the world the ground of one biome fades into the next in steps too small to see', () => {
  const world = new Terrain('world', { length: 64000 }), roots = [new Container(), new Container()], scene = new TerrainScene(...roots),
    before = world.snapshot(), ground = id => TERRAIN_PROFILES[id].surface,
    step = (a, b) => Math.max(...[16, 8, 0].map(shift => Math.abs((a >> shift & 255) - (b >> shift & 255)))),
    // Each surface ends in its contact shade. Natural buried boundaries have
    // intermediate colour steps; concrete keeps its three physical bands.
    fills = chunk => groundInstructions(scene, chunk).filter(i => i.action === 'fill')
      .map(i => ({ points: i.data.path.instructions.find(p => p.action === 'poly')?.data[0], color: i.data.style.color })).filter(f => f.points),
    stretches = chunk => chunk.earth && scene.terrain.sectors.filter(s => s.end > chunk.left && s.start < chunk.right).length,
    bedSizes = new WeakMap(),
    // The earth under it is the beds from the deepest up: the columns of one
    // bed, each where it stands, its top and foot, and the column of tones it reads.
    bed = (chunk, k) => {
      const { positions, uvs } = chunk.strata.geometry, strips = [];
      if (!bedSizes.has(chunk.strata)) {
        const native = buildStrata(scene.plan, chunk.left, chunk.right, scene.floor, chunk.step);
        const end = native.bedVertices * 2;
        assert.deepEqual(positions, native.positions.subarray(0, end), 'the deep mesh retains every bed corner');
        if (native.clasts) {
          const stones = chunk.stones.children[0].geometry;
          assert.deepEqual(stones.positions, native.positions.subarray(end), 'the separate soil-front mesh retains every clast corner');
          assert.deepEqual(stones.uvs, native.tones.subarray(end));
          assert.deepEqual(stones.indices, native.indices.subarray(native.bedIndices).map(index => index - native.bedVertices));
        }
        assert.equal(end, positions.length);
        bedSizes.set(chunk.strata, native.bedVertices);
      }
      for (let i = 0; i < bedSizes.get(chunk.strata) * 2; i += 4) {
        if (positions[i] === 0) strips.push([]);
        strips.at(-1).push({ x: chunk.strata.position.x + positions[i], top: positions[i + 1], foot: positions[i + 3], u: uvs[i] });
      }
      assert.equal(strips.length, BED_TOPS.length);
      return strips[BED_TOPS.length - 1 - k];
    };
  try {
    scene.rebuild(world);
    const width = scene.plan.width, tones = strataTones(scene.plan),
      tone = (column, k) => { const i = ((k * 128 + 64) * width + column) * 4; return tones[i] << 16 | tones[i + 1] << 8 | tones[i + 2]; };
    assert.equal(width, world.biomes.length); assert.equal(scene.tones.source.pixelWidth, width);
    let faded = 0, plain = 0;
    for (const [i, region] of world.biomes.entries()) {
      const border = region.start, sides = [scene.chunks.find(c => c.right === border), scene.chunks.find(c => c.left === border)];
      if (!i || !sides[0] || !sides[1]) continue;
      const other = world.biomes[i - 1], surface = [];
      for (const chunk of sides) {
        scene.paint(chunk);
        const painted = fills(chunk);
        assert.equal(painted[0].points[0], chunk.left); assert.equal(painted[0].points[1], world.height(chunk.left));
        let first = 0;
        for (let k = 0; k < painted.length; k++) if (painted[k].color === 0x263f34) {
          const layers = painted.slice(first, k), shade = painted[k].points;
          assert(layers.length >= 3 && layers.length <= 11, 'one deep, body and crust with bounded intermediate colour steps');
          surface.push({ from: layers[0].points[0], to: shade[shade.length / 2 - 2],
            tones: [layers[0], layers[Math.floor(layers.length / 2)], layers.at(-1)].map(f => f.color) });
          first = k + 1;
        }
        assert.equal(surface.at(-1).to, chunk.right);
        for (let k = 0; k < BED_TOPS.length; k++) {
          const columns = bed(chunk, k), lap = columns.at(-1).x - chunk.right;
          assert.equal(columns[0].x, chunk.left); assert(Math.abs(columns.at(-2).x - chunk.right) < 1e-3);
          assert(lap > .04 && lap < .06, 'each stretch of earth reaches a little under the next: no seam for the sky to show through');
        }
      }
      // The earth of the two sides is one: at the border every bed of one ends where the other starts, half of each biome.
      for (let k = 0; k < BED_TOPS.length; k++) {
        const end = bed(sides[0], k).at(-2), start = bed(sides[1], k)[0];
        assert(Math.abs(end.top - start.top) < 1e-3 && Math.abs(end.foot - start.foot) < 1e-3, `bed ${k} steps at the border`);
        assert(Math.abs(end.u - start.u) < 1e-6); assert(Math.abs(end.u * width - i) < 1e-4);
      }
      // Along the ground its tones pass from the column of one region to the next, a hundredth of the way at a time,
      // and away from the border each side reads its own.
      const top = [...bed(sides[0], 1).slice(0, -1), ...bed(sides[1], 1).slice(0, -1)];
      assert(Math.abs(top[0].u * width - (i - .5)) < 1e-4 && Math.abs(top.at(-1).u * width - (i + .5)) < 1e-4);
      for (const [k, column] of top.entries()) if (k) {
        const moved = (column.u - top[k - 1].u) * width;
        assert(moved >= -1e-6 && moved < .014, `earth step at ${column.x - border}`);
        if (Math.abs(column.x - border) > 124) assert(Math.abs(moved) < 1e-6, 'the fade keeps to its stretch');
      }
      for (let k = 0; k < 5; k++) assert(step(tone(i - 1, k), tone(i, k)) * .014 < 2);
      // Soil meets soil: the surface has nothing to fade, and nothing of it is cut.
      if (ground(region.id) === ground(other.id)) { assert.equal(surface.length, stretches(sides[0]) + stretches(sides[1])); plain++; continue; }
      faded++;
      assert(surface.length > 50 && Math.max(...[0, 1, 2, 3, 4].map(k => step(tone(i - 1, k), tone(i, k)))) > 10, 'each side keeps its own earth away from the border');
      // Over the faded stretch the two grounds that meet at the border are one run of tones, the crust included,
      // wherever the material itself changes; a patch of another ground keeps its edge.
      const meeting = [-1, 1].map(side => world.materialAt(border + side * (world.spacing + .01))),
        run = surface.filter(s => s.to > border - 120 && s.from < border + 120 && meeting.includes(world.materialAt((s.from + s.to) / 2)));
      assert(run.some(s => s.to === border) && run.some(s => s.from === border), 'both sides reach the border');
      for (const [k, s] of run.entries()) if (k && s.from === run[k - 1].to)
        for (const [layer, shade] of s.tones.entries()) assert(step(shade, run[k - 1].tones[layer]) <= 2, `surface step at ${s.from - border}`);
      assert(step(run[0].tones[2], run.at(-1).tones[2]) > 4, 'the two ends of the run are the two grounds');
    }
    assert(faded >= 4 && plain >= 1);
    assert.deepEqual(world.snapshot(), before, 'the fade is paint: the surface a vehicle drives on still changes at a line');
    // Each biome shows through the other by as much on either side: none 120 m away, a half at the border.
    const border = world.biomes[3].start, share = x => biomeFade(world.biomes, x);
    assert.deepEqual(share(border - 121), { here: world.biomes[2], other: null, share: 0 }); assert.equal(share(border + 121).other, null);
    assert.equal(share(border - 1e-7).other, world.biomes[3]); assert.equal(share(border).other, world.biomes[2]);
    assert(Math.abs(share(border - 1e-7).share - .5) < 1e-6 && Math.abs(share(border).share - .5) < 1e-9);
    for (let d = 1; d < 120; d += 7) {
      assert(Math.abs(share(border - d).share - share(border + d).share) < 1e-12);
      assert(share(border - d).share < share(border - d + 1).share && share(border - d).share > 0);
    }
    // A landscape of one biome has no neighbour to fade into: its ground is painted whole, and its earth reads one column.
    const alone = new Terrain('plateau', { length: 2000 }); scene.rebuild(alone);
    for (const chunk of scene.chunks) {
      scene.paint(chunk);
      assert.equal(fills(chunk).filter(f => f.color === 0x263f34).length, stretches(chunk));
      for (let k = 0; k < BED_TOPS.length; k++) for (const column of bed(chunk, k)) assert.equal(column.u, .25);
    }
  } finally { scene.clear(); for (const root of roots) root.destroy(); }
});
