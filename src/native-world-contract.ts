// The synchronous host API exported by NativeWorld (lib.rs) and NodeWorld (node.rs).
// Both hosts own the simulation; JSON replies are decoded by RustGame at their boundary.
export interface NativeWorldHandle {
  free(): void;
  load_game(request: string): void;
  current_frame(): string;
  game_step(dt: number): string;
  game_advance(dt: number): string;
  shot_block(): Float64Array;
  frame_block(): Float64Array;
  shot_drags(): Float64Array;
  game_command(request: string): string;
  export_state?(): Uint8Array;
  import_state?(state: Uint8Array): void;
  /** What `import_state(source.export_state())` makes of this world, without writing the state out. */
  copy_from?(source: NativeWorldHandle): void;
}
export type NativeWorldConstructor = new (ground: Float64Array, floor: number, gravity: number) => NativeWorldHandle;
const methods = ['free', 'load_game', 'current_frame', 'game_step', 'game_advance', 'shot_block', 'frame_block', 'shot_drags', 'game_command'] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
export function isNativeWorldConstructor(value: unknown): value is NativeWorldConstructor {
  if (typeof value !== 'function' || !('prototype' in value) || !object(value.prototype)) return false;
  const prototype = value.prototype;
  return methods.every(method => typeof prototype[method] === 'function') &&
    ['export_state', 'import_state', 'copy_from'].every(method => prototype[method] === undefined || typeof prototype[method] === 'function');
}
