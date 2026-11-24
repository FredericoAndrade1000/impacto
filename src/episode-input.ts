// The core owns admission of the command's fields. This port only describes the
// input operation the wrapper sends, preserving the reply of the actual host.
export type WorldInputRequest = {
  op: 'input'; actorId: string; input: object; force: boolean; frame?: false;
};
export interface InputWorld<Reply = unknown> { game(): { call(request: WorldInputRequest): Reply } }
export interface InputOptions { platform?: string | null | undefined; force?: boolean | undefined; quiet?: boolean | undefined }

// An input of local controls, of the network or of a vehicle's own pilot, as the core admits it: the core refuses one
// that is malformed whole, before it changes anything. A quiet input leaves the scene as it was read: the caller steps
// the world next and reads it then.
export function applyWorldInput<Reply>(world: InputWorld<Reply>, actorId: string, input: object | null | undefined,
  { platform, force = false, quiet = false }: InputOptions = {}): Reply {
  return world.game().call({ op: 'input', actorId, input: { ...input, ...(platform ? { platform } : {}) }, force,
    ...(quiet ? { frame: false } : {}) });
}

// A key, or a pedal on the screen, asks for all of the throttle or none of it. The player's foot goes down on it as a
// driver's does, as BeamNG eases a key: all the way in `THROTTLE_IN` seconds, and up again quicker, in `THROTTLE_OUT`.
// Asked for the other way, it comes up first. The brake is as asked.
export const THROTTLE_IN = .5, THROTTLE_OUT = .2;
// Where the throttle is `seconds` after `throttle`, the player asking for `wanted`.
export function easedThrottle(throttle: number, wanted: number, seconds: number): number {
  const toward = throttle * wanted < 0 ? 0 : wanted, gap = toward - throttle,
    reach = seconds / (Math.abs(toward) < Math.abs(throttle) ? THROTTLE_OUT : THROTTLE_IN);
  return Math.abs(gap) <= reach ? toward : throttle + Math.sign(gap) * reach;
}

export function releaseWorldInputs(world: InputWorld, ids: readonly string[] = ['local'], brake = 0, cancel = true, quiet = false): void {
  for (const id of ids) {
    applyWorldInput(world, id, { type: 'release', phase: 'before', brake, cancel }, { quiet });
  }
}
