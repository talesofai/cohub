export const TARGET_SAMPLE_RATE = 16_000;
export const CHUNK_MS = 200;
export const CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000;

export type VoiceActivityState = "waiting" | "speech" | "silence" | "endpoint";

export type VoiceActivityEvent = {
  state: VoiceActivityState;
  level: number;
  peak: number;
  silenceMs: number;
  speechMs: number;
};

export type VoiceInputVadOptions = {
  enabled?: boolean;
  autoStop?: boolean;
  sampleRate?: number;
  preRollMs?: number;
  minSpeechMs?: number;
  silenceDurationMs?: number;
  speechThreshold?: number;
  silenceThreshold?: number;
  peakThreshold?: number;
};

export type NormalizedVoiceInputVadOptions = Required<VoiceInputVadOptions>;

const DEFAULT_AUDIO_CONSTRAINTS = {
  channelCount: { ideal: 1 },
  sampleRate: { ideal: TARGET_SAMPLE_RATE },
  sampleSize: { ideal: 16 },
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
} satisfies MediaTrackConstraints;

const DEFAULT_VAD_OPTIONS: NormalizedVoiceInputVadOptions = {
  enabled: true,
  autoStop: true,
  sampleRate: TARGET_SAMPLE_RATE,
  preRollMs: 400,
  minSpeechMs: 160,
  silenceDurationMs: 2400,
  speechThreshold: 0.008,
  silenceThreshold: 0.005,
  peakThreshold: 0.07,
};

export const createVoiceInputAudioConstraints = (constraints?: MediaTrackConstraints): MediaTrackConstraints => ({
  ...DEFAULT_AUDIO_CONSTRAINTS,
  ...constraints,
});

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const normalizeVoiceInputVadOptions = (options: VoiceInputVadOptions = {}): NormalizedVoiceInputVadOptions => ({
  enabled: options.enabled ?? DEFAULT_VAD_OPTIONS.enabled,
  autoStop: options.autoStop ?? DEFAULT_VAD_OPTIONS.autoStop,
  sampleRate: clamp(options.sampleRate ?? DEFAULT_VAD_OPTIONS.sampleRate, 8000, 96_000),
  preRollMs: clamp(options.preRollMs ?? DEFAULT_VAD_OPTIONS.preRollMs, 0, 2000),
  minSpeechMs: clamp(options.minSpeechMs ?? DEFAULT_VAD_OPTIONS.minSpeechMs, 0, 10_000),
  silenceDurationMs: clamp(options.silenceDurationMs ?? DEFAULT_VAD_OPTIONS.silenceDurationMs, 400, 15_000),
  speechThreshold: clamp(options.speechThreshold ?? DEFAULT_VAD_OPTIONS.speechThreshold, 0.001, 1),
  silenceThreshold: clamp(options.silenceThreshold ?? DEFAULT_VAD_OPTIONS.silenceThreshold, 0.001, 1),
  peakThreshold: clamp(options.peakThreshold ?? DEFAULT_VAD_OPTIONS.peakThreshold, 0.001, 1),
});

export const measureAudioLevel = (samples: Float32Array) => {
  if (samples.length === 0) return { rms: 0, peak: 0 };

  let total = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i] ?? 0);
    total += value * value;
    if (value > peak) peak = value;
  }
  return {
    rms: Math.sqrt(total / samples.length),
    peak,
  };
};

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

export class VoiceInputVad {
  private readonly options: NormalizedVoiceInputVadOptions;
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private state: VoiceActivityState = "waiting";
  private noiseFloor = 0.003;
  private endpointReached = false;

  constructor(options?: VoiceInputVadOptions) {
    this.options = normalizeVoiceInputVadOptions(options);
  }

  process(input: Float32Array) {
    const durationMs = (input.length / this.options.sampleRate) * 1000;
    const { rms, peak } = measureAudioLevel(input);
    const eventBase = {
      level: rms,
      peak,
      silenceMs: this.silenceMs,
      speechMs: this.speechMs,
    };

    if (!this.options.enabled) {
      this.speechMs += durationMs;
      return {
        chunks: input.length > 0 ? [input] : [],
        endpoint: false,
        event: { ...eventBase, state: "speech" as const, speechMs: this.speechMs },
      };
    }

    if (this.endpointReached || input.length === 0) {
      return {
        chunks: [],
        endpoint: this.endpointReached,
        event: { ...eventBase, state: this.state },
      };
    }

    const hasSpeech = this.state !== "waiting";
    const speechThreshold = Math.max(this.options.speechThreshold, this.noiseFloor * 3.2);
    const silenceThreshold = Math.max(this.options.silenceThreshold, this.noiseFloor * 1.8);
    const active = peak >= this.options.peakThreshold || rms >= (hasSpeech ? silenceThreshold : speechThreshold);

    if (this.state === "waiting") {
      this.pushPreRoll(input);
      this.updateNoiseFloor(rms);
      if (!active) {
        return {
          chunks: [],
          endpoint: false,
          event: { ...eventBase, state: "waiting" as const },
        };
      }

      this.state = "speech";
      this.speechMs += durationMs;
      this.silenceMs = 0;
      return {
        chunks: this.drainPreRoll(),
        endpoint: false,
        event: { level: rms, peak, silenceMs: this.silenceMs, speechMs: this.speechMs, state: this.state },
      };
    }

    const chunks = [input];
    if (active) {
      this.state = "speech";
      this.speechMs += durationMs;
      this.silenceMs = 0;
    } else {
      this.state = "silence";
      this.silenceMs += durationMs;
      this.updateNoiseFloor(rms);
    }

    const endpoint = this.options.autoStop
      && this.speechMs >= this.options.minSpeechMs
      && this.silenceMs >= this.options.silenceDurationMs;
    if (endpoint) {
      this.state = "endpoint";
      this.endpointReached = true;
    }

    return {
      chunks,
      endpoint,
      event: { level: rms, peak, silenceMs: this.silenceMs, speechMs: this.speechMs, state: this.state },
    };
  }

  reset() {
    this.preRoll = [];
    this.preRollSamples = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.state = "waiting";
    this.noiseFloor = 0.003;
    this.endpointReached = false;
  }

  private pushPreRoll(input: Float32Array) {
    if (this.options.preRollMs <= 0) {
      this.preRoll = [input];
      this.preRollSamples = input.length;
      return;
    }

    const maxSamples = Math.ceil((this.options.sampleRate * this.options.preRollMs) / 1000);
    this.preRoll.push(input);
    this.preRollSamples += input.length;
    while (this.preRollSamples > maxSamples && this.preRoll.length > 1) {
      const removed = this.preRoll.shift();
      this.preRollSamples -= removed?.length ?? 0;
    }
  }

  private drainPreRoll() {
    const chunks = this.preRoll;
    this.preRoll = [];
    this.preRollSamples = 0;
    return chunks;
  }

  private updateNoiseFloor(rms: number) {
    const sample = clamp(rms, 0.001, 0.05);
    this.noiseFloor = this.noiseFloor * 0.92 + sample * 0.08;
  }
}
