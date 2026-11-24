// The one atmosphere of the world, as the core has it (game_flight.rs `air_density`): everything that flies through the
// air reads it — the rounds a screen follows (shot-forecast.ts), and the hulls and the jets of the thrusters a pilot
// reckons with (squad.ts). A height is over the sea level of the world, its zero, y = 0: the lowest of a landscape stands
// 20 m over it (terrain.ts `WORLD_FLOOR`) and its highest ground a kilometre or so. The fixture of the atmosphere
// (tests/fixtures/atmosphere-parity.json) holds both to the same numbers.
export const AIR_DENSITY = 1.225; // kg/m³ at sea level: that of the standard atmosphere
export const SCALE_HEIGHT = 8500; // metres over which the air thins to 1/e of its density: 0.56 of it at 5 km, 0.31 at 10 km
export const RATED_ALTITUDE = 1000; // metres over sea level a jet gives all its thrust up to: about the highest ground
export const JET_LAPSE = .7;      // the power of the density the thrust of a jet falls as over that: the lapse of a turbojet
const DEEPEST = 64;               // scale heights under sea level the air goes on growing denser, at the most: no number overflows

// The density of the air `altitude` metres over sea level, in kg/m³. Under sea level, where no ground of the world lies
// but where a forecast may follow a round, it grows denser on as it would (`DEEPEST`).
export function airDensity(altitude: number): number {
  return AIR_DENSITY * Math.exp(Math.min(-altitude / SCALE_HEIGHT, DEEPEST));
}
// The share of the density the air has at `from` that it has at `to`, a short climb or fall away from it, as a round
// climbs or falls within a step: `airDensity(to) / airDensity(from)` by the series of its exponential, without another one.
export function thinning(from: number, to: number): number {
  const x = (to - from) / SCALE_HEIGHT;
  return 1 - x * (1 - x * (.5 - x * (1 / 6 - x / 24)));
}
// The share of the thrust a jet gives at sea level that it gives `altitude` metres over it: all of it up to
// `RATED_ALTITUDE`, and over that as the air thins from how dense it is there (`JET_LAPSE`).
export function thrustShare(altitude: number): number {
  return Math.min(1, (airDensity(altitude) / airDensity(RATED_ALTITUDE)) ** JET_LAPSE);
}
// The highest a jet gives `share` of the thrust it gives at sea level, in metres over sea level: `RATED_ALTITUDE` for all
// of it, higher for less, every height for none of it, and none at all (-Infinity) for more than all of it.
export function thrustAltitude(share: number): number {
  return share > 1 ? -Infinity : share > 0 ? RATED_ALTITUDE - SCALE_HEIGHT * Math.log(share) / JET_LAPSE : Infinity;
}
