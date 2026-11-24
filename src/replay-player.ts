import type { ReplayArchive, ReplayTelemetry } from './replay-contract.ts';
import type { SceneEventBase } from './scene-contract.ts';

export interface ReplayFrame<State extends { time: number }> {
  state: State; events: readonly SceneEventBase[]; telemetry: ReplayTelemetry;
  time?: number; chapter?: number;
}
export const replayFrameTime = (frame: ReplayFrame<{ time: number }>): number => frame.time ?? frame.state.time;
export interface ReplaySink<State extends { time: number }> {
  reset(): void;
  receive(frame: ReplayFrame<State>, previousTime: number): void;
}

// A bounded window of independently decodable chunks. Playback has one timeline;
// the renderer receives original world time, independently of playback speed.
export class ReplayPlayer<State extends { time: number }> {
  readonly archive: ReplayArchive;
  readonly load: (index: number) => Promise<readonly ReplayFrame<State>[]>;
  readonly sink: ReplaySink<State>;
  private cache = new Map<number, Promise<readonly ReplayFrame<State>[]>>();
  private generation = 0;
  private fed = -Infinity;
  private fedWorld: number | null = null;
  private chapter: number | undefined;
  time: number;
  frame: ReplayFrame<State> | null = null;
  constructor(archive: ReplayArchive, load: ReplayPlayer<State>['load'], sink: ReplaySink<State>) {
    this.archive = archive; this.load = load; this.sink = sink; this.time = archive.start;
    if (!archive.chunks.length) throw new Error('Empty visual replay.');
  }
  get cachedChunks(): number { return this.cache.size; }
  get chapterIndex(): number | undefined { return this.chapter; }
  get worldTime(): number {
    const chapter = this.chapter === undefined ? undefined : this.archive.chapters?.[this.chapter];
    return chapter ? chapter.worldFrom + this.time - chapter.from : this.time;
  }
  cancel(): void { this.generation++; }
  private chunk(index: number): Promise<readonly ReplayFrame<State>[]> {
    let loaded = this.cache.get(index);
    if (!loaded) {
      loaded = this.load(index).catch(error => { this.cache.delete(index); throw error; });
    }
    this.cache.delete(index); this.cache.set(index, loaded);
    while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!);
    return loaded;
  }
  private index(time: number, chapter: number | undefined): number {
    const belongs = (index: number) => chapter === undefined || this.archive.chunks[index]!.chapter === chapter;
    const index = this.archive.chunks.findIndex((chunk, i) => belongs(i) && chunk.to >= time - 1e-8);
    return index < 0 ? this.archive.chunks.findLastIndex((_, i) => belongs(i)) : index;
  }
  async show(asked: number, reset = false): Promise<boolean> {
    if (!Number.isFinite(asked)) throw new Error('Invalid replay time.');
    const generation = ++this.generation, time = Math.max(this.archive.start, Math.min(this.archive.end, asked));
    const chapter = this.archive.chapters ? Math.max(0, this.archive.chapters.findLastIndex(chapter => chapter.from <= time + 1e-8)) : undefined;
    reset ||= !this.frame || time < this.time || time - this.time > 2 || chapter !== this.chapter;
    const start = chapter === undefined ? this.archive.start : this.archive.chapters![chapter]!.from,
      from = reset ? Math.max(start, time - 1 - 1 / this.archive.fps) : Math.min(this.fed, time),
      frames: ReplayFrame<State>[] = [];
    for (let i = this.index(from, chapter); i <= this.index(time, chapter); i++) frames.push(...await this.chunk(i));
    if (generation !== this.generation) return false;
    if (reset) { this.sink.reset(); this.fed = -Infinity; this.fedWorld = null; this.frame = null; }
    this.chapter = chapter;
    for (const frame of frames) {
      if (this.fed >= time - 1e-8) break;
      const shown = replayFrameTime(frame);
      if (shown < from - 1e-8 || shown <= this.fed + 1e-8) continue;
      this.sink.receive(frame, this.fedWorld ?? frame.state.time);
      this.fed = shown; this.fedWorld = frame.state.time;
      // Telemetry belongs to the last completed observation, not to the future
      // endpoint used to interpolate motion across the current interval.
      if (shown >= time - 1e-8) break;
    }
    this.frame = frames.findLast(frame => replayFrameTime(frame) <= time + 1e-8) ?? this.frame ?? frames[0] ?? null;
    this.time = time; return true;
  }
}
