import type { CohubEnvironment } from "./environment.js";
import { resolveVoiceInputWebsocketUrl } from "./environment.js";
import {
  createVoiceInputAudioConstraints,
  floatToPcm16,
  resampleTo16k,
  TARGET_SAMPLE_RATE,
  VoiceInputAudioChunker,
} from "./voice-input-audio.js";

export type VoiceInputEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

export type VoiceInputCallbacks = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
};

export type VoiceInputClientOptions = {
  env?: CohubEnvironment;
  url?: string;
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string | null> | string | null;
  WebSocketImpl?: WebSocketConstructor;
  audioConstraints?: MediaTrackConstraints;
  preferAudioWorklet?: boolean;
  connectionTimeoutMs?: number;
  idleConnectionTimeoutMs?: number;
  callbacks?: VoiceInputCallbacks;
};

export type VoiceInputCreateOptions = Omit<VoiceInputClientOptions, "callbacks">;

export type WebSocketLike = {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketConstructor = new (url: string) => WebSocketLike;

const AUDIO_WORKLET_FRAME_CHUNK = 1024;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 2048;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_CONNECTION_TIMEOUT_MS = 30 * 60_000;
const WEBSOCKET_OPEN = 1;
const VOICE_INPUT_WORKLET_NAME = "cohub-voice-input";

const VOICE_INPUT_WORKLET_SOURCE = `
class CohubVoiceInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.pendingLength = 0;
    this.chunkSamples = ${AUDIO_WORKLET_FRAME_CHUNK};
  }

  process(inputs) {
    var input = inputs[0];
    var channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    this.pending.push(new Float32Array(channel));
    this.pendingLength += channel.length;

    while (this.pendingLength >= this.chunkSamples) {
      var output = new Float32Array(this.chunkSamples);
      var offset = 0;

      while (offset < this.chunkSamples && this.pending.length > 0) {
        var first = this.pending[0];
        var take = Math.min(first.length, this.chunkSamples - offset);
        output.set(first.subarray(0, take), offset);
        offset += take;

        if (take === first.length) {
          this.pending.shift();
        } else {
          this.pending[0] = first.subarray(take);
        }
      }

      this.pendingLength -= this.chunkSamples;
      this.port.postMessage(output, [output.buffer]);
    }

    return true;
  }
}

registerProcessor("${VOICE_INPUT_WORKLET_NAME}", CohubVoiceInputProcessor);
`;

const getDefaultWebSocket = (): WebSocketConstructor => {
  const WebSocketImpl = globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error("WebSocket is not available in this environment");
  return WebSocketImpl;
};

const getDefaultAudioContext = () => {
  const context = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  return context.AudioContext ?? context.webkitAudioContext;
};

const createAudioContext = (AudioContextImpl: typeof AudioContext) => {
  try {
    return new AudioContextImpl({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: "interactive" });
  } catch {
    try {
      return new AudioContextImpl({ latencyHint: "interactive" });
    } catch {
      return new AudioContextImpl();
    }
  }
};

const createVoiceInputWorkletUrl = () => {
  if (!globalThis.URL?.createObjectURL || !globalThis.Blob) return null;
  return globalThis.URL.createObjectURL(new Blob([VOICE_INPUT_WORKLET_SOURCE], { type: "application/javascript" }));
};

const toFloat32Array = (input: unknown) => {
  if (input instanceof Float32Array) return input;
  if (input instanceof ArrayBuffer) return new Float32Array(input);
  return null;
};

const encodeBase64 = (bytes: Uint8Array) => {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary);
  }
  const maybeBuffer = (globalThis as typeof globalThis & {
    Buffer?: { from(input: Uint8Array): { toString(encoding: "base64"): string } };
  }).Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes).toString("base64");
  throw new Error("Base64 encoding is not available in this environment");
};

const getErrorCode = (event: VoiceInputEvent) => {
  const code = event.payload?.code;
  return typeof code === "string" ? code : null;
};

const getErrorMessage = (event: VoiceInputEvent) => {
  const message = event.payload?.message;
  return typeof message === "string" ? message : "Voice input failed";
};

export class VoiceInputClient {
  private readonly url: string;
  private readonly getAccessToken?: VoiceInputClientOptions["getAccessToken"];
  private readonly WebSocketImpl: WebSocketConstructor;
  private readonly audioConstraints?: MediaTrackConstraints;
  private readonly preferAudioWorklet: boolean;
  private readonly connectionTimeoutMs: number;
  private readonly idleConnectionTimeoutMs: number;
  private readonly callbacks: VoiceInputCallbacks;

  private socket: WebSocketLike | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private audioChunker = new VoiceInputAudioChunker();
  private pendingAudio: string[] = [];
  private started = false;
  private asrStarted = false;
  private authenticated = false;
  private intentionalClose = false;
  private startPromise: Promise<void> | null = null;
  private socketOpenPromise: Promise<void> | null = null;
  private idleCloseTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private authWaiter: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private asrStartWaiter: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(options: VoiceInputClientOptions = {}) {
    this.url = resolveVoiceInputWebsocketUrl({ env: options.env, url: options.url });
    this.getAccessToken = options.getAccessToken;
    this.WebSocketImpl = options.WebSocketImpl ?? getDefaultWebSocket();
    this.audioConstraints = options.audioConstraints;
    this.preferAudioWorklet = options.preferAudioWorklet ?? true;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.idleConnectionTimeoutMs = options.idleConnectionTimeoutMs ?? DEFAULT_IDLE_CONNECTION_TIMEOUT_MS;
    this.callbacks = options.callbacks ?? {};
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.started) return;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  stop() {
    const pendingSamples = this.audioChunker.flush();
    if (pendingSamples) this.sendAudio(pendingSamples);
    this.flushPendingAudio();
    if (this.asrStarted) this.send({ type: "asr.stop" });
    this.cleanupAudio();
    this.started = false;
    this.scheduleIdleClose();
  }

  cancel() {
    if (this.asrStarted) this.send({ type: "asr.cancel" });
    this.cleanupAudio();
    this.started = false;
    this.scheduleIdleClose();
  }

  close() {
    this.intentionalClose = true;
    this.clearIdleCloseTimer();
    this.cleanupAudio();
    this.closeSocket();
    this.started = false;
  }

  private async startInternal() {
    this.clearIdleCloseTimer();
    this.started = true;
    this.asrStarted = false;
    this.audioChunker.reset();
    this.pendingAudio = [];
    this.intentionalClose = false;

    try {
      await this.withConnectionTimeout(Promise.all([this.setupAudio(), this.ensureAuthenticatedSocket()]));
      await this.withConnectionTimeout(this.startAsrSession());
    } catch (error) {
      this.cleanupAudio();
      this.started = false;
      this.scheduleIdleClose();
      throw error;
    }
  }

  private async withConnectionTimeout<T>(promise: Promise<T>) {
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = globalThis.setTimeout(
            () => reject(new Error("Voice connection timed out")),
            this.connectionTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) globalThis.clearTimeout(timeout);
    }
  }

  private async ensureAuthenticatedSocket() {
    if (this.socket?.readyState === WEBSOCKET_OPEN && this.authenticated) return;

    await this.ensureSocketOpen();
    if (this.authenticated) return;

    try {
      await this.authenticate(false);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "UNAUTHORIZED") throw error;
      await this.authenticate(true);
    }
  }

  private async ensureSocketOpen() {
    if (this.socket?.readyState === WEBSOCKET_OPEN) return;
    if (this.socketOpenPromise) return this.socketOpenPromise;

    this.authenticated = false;
    this.intentionalClose = false;
    this.socket = new this.WebSocketImpl(this.url);

    this.socketOpenPromise = new Promise<void>((resolve, reject) => {
      const socket = this.socket;
      if (!socket) return reject(new Error("Voice service unavailable"));

      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Voice service unavailable"));
      socket.onclose = (event) => {
        this.authenticated = false;
        this.socketOpenPromise = null;
        this.rejectAuthWaiter(new Error("Voice connection closed"));
        this.rejectAsrStartWaiter(new Error("Voice connection closed"));
        if (this.socket === socket) this.socket = null;
        if (!this.intentionalClose && this.started) {
          this.cleanupAudio();
          this.started = false;
          this.callbacks.onError?.("Voice connection closed. Try again.");
          this.callbacks.onDone?.();
        }
        if (socket.readyState !== WEBSOCKET_OPEN) {
          reject(new Error(event.reason || "Voice connection closed"));
        }
      };
      socket.onmessage = (event) => {
        try {
          this.handleMessage(event);
        } catch {
          this.closeWithError("Voice service sent invalid data. Try again.");
        }
      };
    }).finally(() => {
      this.socketOpenPromise = null;
    });

    return this.socketOpenPromise;
  }

  private async authenticate(forceRefresh: boolean) {
    const token = await this.getAccessToken?.({ forceRefresh });
    if (!token) throw new Error("Sign in to use voice input");

    const waiter = this.createAuthWaiter();
    this.send({ type: "auth", payload: { token } });
    await waiter.promise;
  }

  private async startAsrSession() {
    const waiter = this.createAsrStartWaiter();
    this.send({ type: "asr.start" });
    await waiter.promise;
  }

  private createAuthWaiter() {
    this.rejectAuthWaiter(new Error("superseded auth waiter"));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.authWaiter = { promise, resolve, reject };
    return this.authWaiter;
  }

  private resolveAuthWaiter() {
    if (!this.authWaiter) return;
    this.authWaiter.resolve();
    this.authWaiter = null;
  }

  private rejectAuthWaiter(error: Error) {
    if (!this.authWaiter) return;
    this.authWaiter.reject(error);
    this.authWaiter = null;
  }

  private createAsrStartWaiter() {
    this.rejectAsrStartWaiter(new Error("superseded asr start waiter"));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.asrStartWaiter = { promise, resolve, reject };
    return this.asrStartWaiter;
  }

  private resolveAsrStartWaiter() {
    if (!this.asrStartWaiter) return;
    this.asrStartWaiter.resolve();
    this.asrStartWaiter = null;
  }

  private rejectAsrStartWaiter(error: Error) {
    if (!this.asrStartWaiter) return;
    this.asrStartWaiter.reject(error);
    this.asrStartWaiter = null;
  }

  private closeWithError(message: string) {
    this.callbacks.onError?.(message);
    this.close();
    this.callbacks.onDone?.();
  }

  private async setupAudio() {
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices) throw new Error("Microphone input is not available in this environment");
    const AudioContextImpl = getDefaultAudioContext();
    if (!AudioContextImpl) throw new Error("AudioContext is not available in this environment");

    this.stream = await mediaDevices.getUserMedia({ audio: createVoiceInputAudioConstraints(this.audioConstraints) });
    this.audioContext = createAudioContext(AudioContextImpl);
    await this.audioContext.resume().catch(() => undefined);
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    if (await this.setupAudioWorklet()) return;
    this.setupScriptProcessor();
  }

  private async setupAudioWorklet() {
    if (!this.preferAudioWorklet || !this.audioContext?.audioWorklet || !this.source) return false;

    const workletUrl = createVoiceInputWorkletUrl();
    if (!workletUrl) return false;

    try {
      await this.audioContext.audioWorklet.addModule(workletUrl);
    } catch {
      return false;
    } finally {
      globalThis.URL.revokeObjectURL(workletUrl);
    }

    try {
      this.workletNode = new AudioWorkletNode(this.audioContext, VOICE_INPUT_WORKLET_NAME, {
        channelCount: 1,
        channelCountMode: "explicit",
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.workletNode.port.onmessage = (event) => {
        const samples = toFloat32Array(event.data);
        if (samples) this.handleAudioSamples(samples);
      };
      this.sink = this.audioContext.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.workletNode);
      this.workletNode.connect(this.sink);
      this.sink.connect(this.audioContext.destination);
      return true;
    } catch {
      this.workletNode?.disconnect();
      this.workletNode?.port.close();
      this.sink?.disconnect();
      this.workletNode = null;
      this.sink = null;
      return false;
    }
  }

  private setupScriptProcessor() {
    if (!this.audioContext || !this.source) throw new Error("Audio input is not ready");
    this.processor = this.audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      this.handleAudioSamples(samples);
    };
    this.sink = this.audioContext.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.audioContext.destination);
  }

  private handleAudioSamples(samples: Float32Array) {
    if (!this.started) return;
    const resampled = resampleTo16k(samples, this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE);
    for (const chunk of this.audioChunker.push(resampled)) this.sendAudio(chunk);
  }

  private sendAudio(samples: Float32Array) {
    const audio = encodeBase64(floatToPcm16(samples));
    if (!this.asrStarted) {
      this.pendingAudio.push(audio);
      return;
    }
    this.send({ type: "asr.audio", payload: { audio } });
  }

  private flushPendingAudio() {
    if (!this.asrStarted) return;
    for (const audio of this.pendingAudio.splice(0)) {
      this.send({ type: "asr.audio", payload: { audio } });
    }
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WEBSOCKET_OPEN) this.socket.send(JSON.stringify(message));
  }

  private handleMessage(event: MessageEvent) {
    const data = JSON.parse(String(event.data)) as VoiceInputEvent;
    const text = typeof data.payload?.text === "string" ? data.payload.text : "";

    if (data.type === "system.auth.ok") {
      this.authenticated = true;
      this.resolveAuthWaiter();
      return data;
    }

    if (data.type === "asr.started") {
      this.asrStarted = true;
      this.flushPendingAudio();
      this.resolveAsrStartWaiter();
      return data;
    }

    if (data.type === "asr.error") {
      const message = getErrorMessage(data);
      const code = getErrorCode(data);
      if (code === "UNAUTHORIZED") {
        this.authenticated = false;
        this.rejectAuthWaiter(new Error("UNAUTHORIZED"));
      }
      this.rejectAsrStartWaiter(new Error(message));
      this.callbacks.onError?.(message);
      return data;
    }

    if (data.type === "asr.partial") this.callbacks.onPartial?.(text);
    if (data.type === "asr.final") this.callbacks.onFinal?.(text);
    if (data.type === "asr.done") {
      this.asrStarted = false;
      this.started = false;
      this.scheduleIdleClose();
      this.callbacks.onDone?.();
    }
    return data;
  }

  private cleanupAudio() {
    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    this.processor?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.sink?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    void this.audioContext?.close().catch(() => undefined);
    this.workletNode = null;
    this.processor = null;
    this.sink = null;
    this.source = null;
    this.stream = null;
    this.audioContext = null;
    this.audioChunker.reset();
    this.pendingAudio = [];
    this.asrStarted = false;
  }

  private scheduleIdleClose() {
    this.clearIdleCloseTimer();
    if (!this.socket || this.idleConnectionTimeoutMs <= 0) return;
    this.idleCloseTimer = globalThis.setTimeout(() => {
      this.intentionalClose = true;
      this.closeSocket();
    }, this.idleConnectionTimeoutMs);
  }

  private clearIdleCloseTimer() {
    if (!this.idleCloseTimer) return;
    globalThis.clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = null;
  }

  private closeSocket() {
    this.rejectAuthWaiter(new Error("Voice connection closed"));
    this.rejectAsrStartWaiter(new Error("Voice connection closed"));
    this.authenticated = false;
    this.socketOpenPromise = null;
    this.socket?.close();
    this.socket = null;
  }
}

export class VoiceApi {
  constructor(private readonly defaults: VoiceInputCreateOptions = {}) {}

  createInputClient(callbacks: VoiceInputCallbacks = {}, options: VoiceInputCreateOptions = {}) {
    return new VoiceInputClient({
      ...this.defaults,
      ...options,
      callbacks,
    });
  }
}

export const createVoiceInputClient = (options?: VoiceInputClientOptions) => new VoiceInputClient(options);
