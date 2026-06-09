export const TARGET_SAMPLE_RATE = 16_000;
export const CHUNK_MS = 200;
export const CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000;

const DEFAULT_AUDIO_CONSTRAINTS = {
  channelCount: { ideal: 1 },
  sampleRate: { ideal: TARGET_SAMPLE_RATE },
  sampleSize: { ideal: 16 },
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
} satisfies MediaTrackConstraints;

export const createVoiceInputAudioConstraints = (constraints?: MediaTrackConstraints): MediaTrackConstraints => ({
  ...DEFAULT_AUDIO_CONSTRAINTS,
  ...constraints,
});

export const floatToPcm16 = (samples: Float32Array) => {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
};

export const resampleTo16k = (input: Float32Array, inputSampleRate: number) => {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);

  if (ratio > 1) {
    for (let i = 0; i < length; i += 1) {
      const start = i * ratio;
      const end = start + ratio;
      let total = 0;
      let weightSum = 0;

      for (let sourceIndex = Math.floor(start); sourceIndex < Math.min(Math.ceil(end), input.length); sourceIndex += 1) {
        const sampleStart = Math.max(sourceIndex, start);
        const sampleEnd = Math.min(sourceIndex + 1, end);
        const weight = sampleEnd - sampleStart;
        total += (input[sourceIndex] ?? 0) * weight;
        weightSum += weight;
      }

      output[i] = weightSum > 0 ? total / weightSum : 0;
    }
    return output;
  }

  for (let i = 0; i < length; i += 1) {
    const index = i * ratio;
    const left = Math.floor(index);
    const right = Math.min(left + 1, input.length - 1);
    const weight = index - left;
    output[i] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight;
  }
  return output;
};

export class VoiceInputAudioChunker {
  private pending = new Float32Array(0);

  constructor(private readonly chunkSamples = CHUNK_SAMPLES) {}

  push(input: Float32Array) {
    if (input.length === 0) return [];

    const combined = new Float32Array(this.pending.length + input.length);
    combined.set(this.pending);
    combined.set(input, this.pending.length);

    const chunks: Float32Array[] = [];
    let offset = 0;
    while (combined.length - offset >= this.chunkSamples) {
      chunks.push(combined.slice(offset, offset + this.chunkSamples));
      offset += this.chunkSamples;
    }
    this.pending = combined.slice(offset);
    return chunks;
  }

  flush() {
    if (this.pending.length === 0) return null;
    const pending = this.pending;
    this.pending = new Float32Array(0);
    return pending;
  }

  reset() {
    this.pending = new Float32Array(0);
  }
}
