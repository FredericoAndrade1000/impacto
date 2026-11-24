import { REPLAY_VERSION } from '../src/replay-contract.ts';
import type { ReplayArchive, ReplayChapter, ReplayChunk, ReplayMarker } from '../src/replay-contract.ts';

// Playback time is continuous across runs. Packet world time remains original:
// restoring an older checkpoint may legitimately rewind the field clock.
export function replaySeries(id: string, name: string, parts: readonly ReplayArchive[]): ReplayArchive {
  if (!parts.length) throw new Error('Empty replay series.');
  const chapters: ReplayChapter[] = [], chunks: ReplayChunk[] = [], markers: ReplayMarker[] = [], seenPlaces = new Set<string>();
  let end = 0, prints = 0;
  for (const part of parts) {
    if (part.version !== REPLAY_VERSION || part.fps !== parts[0]!.fps || !part.chunks.length || part.end < part.start)
      throw new Error('Incompatible replay chapter.');
    const chapter = chapters.length, offset = end - part.start, from = end, firstChunk = chunks.length;
    end += part.end - part.start; prints += part.prints;
    chapters.push({ name: part.name, from, to: end, worldFrom: part.start, worldTo: part.end });
    chunks.push(...part.chunks.map(chunk => ({ ...chunk, index: firstChunk + chunk.index, chapter,
      from: chunk.from + offset, to: chunk.to + offset, source: { archiveId: part.id, index: chunk.index } })));
    markers.push({ time: from, kind: 'chapter', label: String(chapter + 1) });
    for (const marker of part.markers) {
      if (marker.kind === 'base' || marker.kind === 'structure') {
        const key = `${marker.kind}:${marker.actorId ?? marker.factionId}:${marker.label}`;
        if (seenPlaces.has(key)) continue;
        seenPlaces.add(key);
      }
      markers.push({ ...marker, time: marker.time + offset });
    }
    if (part.status !== 'verified') break;
  }
  const last = parts[chapters.length - 1]!;
  return { version: REPLAY_VERSION, id, name, start: 0, end, fps: parts[0]!.fps, status: last.status, prints,
    stoppedAt: end, detail: last.detail, chunks, chapters, markers: markers.sort((a, b) => a.time - b.time) };
}
