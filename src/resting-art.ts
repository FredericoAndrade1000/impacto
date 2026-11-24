// Art that follows a shape — the skin of a hull, the mechanism of a gun on its mount — is painted anew when the
// shape changes: a canvas of its own, drawn and sent to the GPU. A shape under the hand changes at every step of the
// pointer, and a corner of a hull dragged across a row of guns would paint all of them at each step, on a thread of
// the browser the page does not see and which the frames then wait for.
//
// Each place keeps its last picture for a short interval. An editing drag can hold that picture until it lets go;
// otherwise a changing shape is painted at bounded intervals. Cached pictures always show at once.

// Minimum milliseconds between new pictures for a place that keeps changing.
export const ART_INTERVAL = 80;

export class RestingArt<Place = string, Key = string> {
  places = new Map<Place, { key: Key; changed: number }>();
  // The art `place` shows at `now`, by its key: `wanted`, or what the place has while that waits. `painted` says
  // whether a key has its art already, which costs nothing to show.
  shown(place: Place, wanted: Key, painted: (key: Key) => boolean, now: number, hold = false): Key {
    const held = this.places.get(place);
    if (!held || !painted(held.key)) { this.places.set(place, { key: wanted, changed: now }); return wanted; }
    if (held.key === wanted) return wanted;
    if (painted(wanted) || !hold && now - held.changed >= ART_INTERVAL) { held.key = wanted; held.changed = now; return wanted; }
    return held.key;
  }
  // The places whose art is gone show nothing to go on with: they are forgotten.
  forget(painted: (key: Key) => boolean): void { for (const [place, held] of this.places) if (!painted(held.key)) this.places.delete(place); }
}
