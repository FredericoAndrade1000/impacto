import { SOUND_PROFILES } from '../../src/sound-art.ts';

// Every recording the game plays, at a made-up address that is read as itself: the test's context decodes it.
export const everySound = () => ({
  files: new Map(Object.keys(SOUND_PROFILES).map(name => [name, `${name}.mp3`])),
  load: async url => url,
});

// A Web Audio context that plays nothing and keeps everything: each node it made (`nodes`, by `kind`), what each was
// connected to, started at (`starts`, and the `offset` into its recording) and stopped at, how often it was
// disconnected, and the automation of every parameter (`calls`). `advance` moves its clock and ends the sources
// stopped by then; `hold` gives the parameters cancelAndHoldAtTime. A decoded recording is its address; a made one
// keeps what is written into each of its channels.
export function fakeAudioContext({ hold = false } = {}) {
  const ctx = { currentTime: 0, sampleRate: 8000, state: 'running', nodes: [], buffers: [] };
  const parameter = () => {
    const p = { value: 0, calls: [],
      setValueAtTime(value, time) { this.calls.push(['set', value, time]); this.value = value; },
      exponentialRampToValueAtTime(value, time) { this.calls.push(['ramp', value, time]); this.value = value; },
      setTargetAtTime(value, time, constant) { this.calls.push(['target', value, time, constant]); this.value = value; },
      cancelScheduledValues(time) { this.calls.push(['cancel', time]); } };
    if (hold) p.cancelAndHoldAtTime = function (time) { this.calls.push(['hold', time]); };
    return p;
  };
  const node = kind => {
    const n = { kind, connections: [], starts: [], stops: [], disconnects: 0, ended: false,
      connect(other) { this.connections.push(other); }, disconnect() { this.disconnects++; },
      start(time = ctx.currentTime, offset) { this.starts.push(time); if (offset !== undefined) this.offset = offset; },
      stop(time = ctx.currentTime) { this.stops.push(time); if (!this.ended) this.stopAt = time; } };
    for (const name of ['gain', 'pan', 'frequency', 'playbackRate', 'threshold', 'knee', 'ratio', 'attack', 'release']) n[name] = parameter();
    if (kind === 'buffer') n.playbackRate.value = 1;
    ctx.nodes.push(n); return n;
  };
  ctx.destination = node('destination');
  for (const [method, kind] of Object.entries({ createGain: 'gain', createStereoPanner: 'panner', createBiquadFilter: 'filter',
    createBufferSource: 'buffer', createMediaElementSource: 'media', createOscillator: 'oscillator', createDynamicsCompressor: 'compressor', createConvolver: 'convolver' })) ctx[method] = () => node(kind);
  ctx.createBuffer = (count, length, sampleRate) => {
    const channels = Array.from({ length: count }, () => new Float32Array(length));
    return { numberOfChannels: count, length, sampleRate, getChannelData: channel => channels[channel] };
  };
  ctx.decodeAudioData = async url => { const buffer = { url }; ctx.buffers.push(buffer); return buffer; };
  ctx.advance = time => {
    ctx.currentTime = time;
    for (const n of ctx.nodes) if (!n.ended && n.starts.length && n.stopAt <= time) { n.ended = true; n.onended?.(); }
  };
  return ctx;
}
