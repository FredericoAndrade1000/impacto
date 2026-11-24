import { splitPlate, drawRoom } from '../../src/frame-editing.ts';
import { CELL, cellOf, metresOf } from '../../src/grid.ts';

const RECOVERABLE = ['STRUCTURED_CONSTRUCTION', 'CONSTRUCTION_OVERLAP', 'CHASSIS_OVERLOAD', 'FRAME_EDIT'];

// A room stood on a level roof of the design in `editor`, as a pull of the player draws one, for the tests that
// need a design with a turret: its feet divide that plate. The widest roof is tried first, in the middle and then
// towards each end, and a shorter room after that, until one clears what is mounted there.
export function addRoom(editor, { length = 1.8, height = .9 } = {}) {
  const roofs = editor.plateSpans().filter(span => span.normal?.y > .9 && Math.abs(span.a.y - span.b.y) < 1e-7 && span.length >= .7).sort((a, b) => b.length - a.length),
    origin = editor.blueprint.frame.origin, margin = .2;
  let refusal = new Error('O compartimento precisa de um teto horizontal livre com ao menos 70 cm.'), first = true;
  for (const wanted of [...new Set([length, 1.2, .8].filter(size => size <= length))]) for (const roof of roofs) {
    const half = Math.min(wanted, roof.length - 2 * margin) / 2, way = Math.sign(roof.b.x - roof.a.x), at = editor.local(editor.source, roof.a);
    for (const middle of [...new Set([roof.length / 2, margin + half, roof.length - margin - half].map(value => Math.round(value / CELL) * CELL))]) {
      try {
        const foot = side => ({ x: at.x + way * cellOf(middle + side * half), y: at.y }),
          rear = splitPlate(editor.source, roof.id, foot(-1)), front = splitPlate(rear.source, rear.plateId, foot(1)),
          world = id => { const node = front.source.nodes.find(node => node.id === id); return { x: metresOf(node.x) + origin.x, y: metresOf(node.y) + origin.y }; },
          drawn = drawRoom(front.source, editor.blueprint, { ...roof, id: rear.plateId, aId: rear.nodeId, bId: front.nodeId,
            a: world(rear.nodeId), b: world(front.nodeId), length: Math.abs(world(front.nodeId).x - world(rear.nodeId).x) }, { x: 0, y: 0 }, { x: 0, y: height });
        if (!drawn.source) throw Object.assign(new Error(drawn.refusal || 'Não há espaço para um compartimento sobre o teto.'), { code: 'FRAME_EDIT' });
        const next = editor.admitted(drawn.source);
        editor.change(() => { editor.blueprint = next; }); editor.select(drawn.plates[1]); return drawn;
      } catch (error) { if (!RECOVERABLE.includes(error.code)) throw error; if (first) refusal = error; first = false; }
    }
  }
  throw refusal;
}
