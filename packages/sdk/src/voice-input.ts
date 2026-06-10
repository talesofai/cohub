import type { CohubEnvironment } from "./environment.js";
import { resolveVoiceInputWebsocketUrl } from "./environment.js";
import {
  createVoiceInputAudioConstraints,
  floatToPcm16,
  resampleTo16k,
  TARGET_SAMPLE_RATE,
  VoiceInputAudioChunker,
  type VoiceActivityEvent,
  VoiceInputVad,
  type VoiceInputVadOptions,
} from "./voice-input-audio.js";

export type VoiceInputEvent = {
  type: string;
  requestId?: string | null;
  payload?: Record<string, unknown>;
};

export type VoiceInputStopReason =
  | "manual"
  | "hotkey_release"
  | "vad_endpoint"
  | "cancel"
  | "client_close"
  | "error";

export type VoiceInputTranscriptEvent = {
  text: string;
  fullText?: string;
  originalText?: string;
  alternatives: string[];
  rewritten: boolean;
  requestId?: string | null;
};

export type VoiceInputTelemetrySummary = {
  sessionId: string;
  requestId: string;
  stopReason: VoiceInputStopReason | "done";
  audioPipeline: "audio-worklet" | "script-processor" | "unknown";
  vadEnabled: boolean;
  timing: {
    durationMs: number;
    startToReadyMs?: number;
    firstAudioToPartialMs?: number;
    firstAudioToFinalMs?: number;
    stopToDoneMs?: number;
  };
  traffic: {
    audioBytes: number;
    audioChunks: number;
    partialMessages: number;
    finalMessages: number;
    insertedChars: number;
  };
  vad: {
    endpointCount: number;
    speechMs: number;
    silenceMs: number;
    peak: number;
    maxRms: number;
  };
  error?: {
    code?: string | null;
    message: string;
  };
};

export type VoiceInputCallbacks = {
  onPartial?: (text: string, event: VoiceInputTranscriptEvent) => void;
  onFinal?: (text: string, event: VoiceInputTranscriptEvent) => void;
  onVoiceActivity?: (event: VoiceActivityEvent) => void;
  onEndpoint?: () => void;
  onError?: (message: string) => void;
  onDone?: () => void;
  onTelemetry?: (summary: VoiceInputTelemetrySummary) => void;
};

export type VoiceInputPostProcessingOptions = {
  enabled?: boolean;
  normalizeWhitespace?: boolean;
  cleanupFillers?: boolean;
  rewritePunctuation?: boolean;
  applyContextTerms?: boolean;
};

export type VoiceInputAsrOptions = {
  language?: string;
  endWindowSizeMs?: number;
  forceToSpeechTimeMs?: number;
  enableNonstream?: boolean;
  enablePunctuation?: boolean;
  enableItn?: boolean;
  enableDdc?: boolean;
  hotwords?: string[];
  contextText?: string;
  contextMessages?: string[];
  boostingTableName?: string;
  boostingTableId?: string;
  correctTableName?: string;
  correctTableId?: string;
  postProcessing?: VoiceInputPostProcessingOptions;
};

export type VoiceInputClientOptions = {
  env?: CohubEnvironment;
  url?: string;
  getAccessToken?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<string | null> | string | null;
  WebSocketImpl?: WebSocketConstructor;
  audioConstraints?: MediaTrackConstraints;
  vad?: VoiceInputVadOptions;
  asr?: VoiceInputAsrOptions;
  preferAudioWorklet?: boolean;
  connectionTimeoutMs?: number;
  idleConnectionTimeoutMs?: number;
  callbacks?: VoiceInputCallbacks;
};

export type VoiceInputCreateOptions = Omit<
  VoiceInputClientOptions,
  "callbacks"
>;

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
  if (!WebSocketImpl)
    throw new Error("WebSocket is not available in this environment");
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
    return new AudioContextImpl({
      sampleRate: TARGET_SAMPLE_RATE,
      latencyHint: "interactive",
    });
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
  return globalThis.URL.createObjectURL(
    new Blob([VOICE_INPUT_WORKLET_SOURCE], { type: "application/javascript" }),
  );
};

const toFloat32Array = (input: unknown) => {
  if (input instanceof Float32Array) return input;
  if (input instanceof ArrayBuffer) return new Float32Array(input);
  return null;
};

const encodeBase64 = (bytes: Uint8Array) => {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1)
      binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary);
  }
  const maybeBuffer = (
    globalThis as typeof globalThis & {
      Buffer?: {
        from(input: Uint8Array): { toString(encoding: "base64"): string };
      };
    }
  ).Buffer;
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

const createVoiceInputSessionId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const getStringPayload = (event: VoiceInputEvent, key: string) => {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : undefined;
};

const getStringArrayPayload = (event: VoiceInputEvent, key: string) => {
  const value = event.payload?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
};

const buildTranscriptEvent = (
  event: VoiceInputEvent,
): VoiceInputTranscriptEvent => {
  const text = getStringPayload(event, "text") ?? "";
  const originalText = getStringPayload(event, "originalText");
  return {
    text,
    fullText: getStringPayload(event, "fullText"),
    originalText,
    alternatives: getStringArrayPayload(event, "alternatives"),
    rewritten:
      event.payload?.rewritten === true ||
      Boolean(originalText && originalText !== text),
    requestId: event.requestId ?? null,
  };
};

type VoiceTelemetryState = {
  sessionId: string;
  startedAt: number;
  readyAt?: number;
  firstAudioAt?: number;
  firstPartialAt?: number;
  firstFinalAt?: number;
  stopAt?: number;
  doneAt?: number;
  audioBytes: number;
  audioChunks: number;
  partialMessages: number;
  finalMessages: number;
  insertedChars: number;
  endpointCount: number;
  speechMs: number;
  silenceMs: number;
  peak: number;
  maxRms: number;
  emitted: boolean;
  error?: {
    code?: string | null;
    message: string;
  };
};

export class VoiceInputClient {
  private readonly url: string;
  private readonly getAccessToken?: VoiceInputClientOptions["getAccessToken"];
  private readonly WebSocketImpl: WebSocketConstructor;
  private readonly audioConstraints?: MediaTrackConstraints;
  private readonly vadOptions?: VoiceInputVadOptions;
  private readonly asrOptions?: VoiceInputAsrOptions;
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
  private vad: VoiceInputVad | null = null;
  private pendingAudio: string[] = [];
  private started = false;
  private asrStartRequested = false;
  private asrStarted = false;
  private authenticated = false;
  private intentionalClose = false;
  private startPromise: Promise<void> | null = null;
  private socketOpenPromise: Promise<void> | null = null;
  private idleCloseTimer: ReturnType<typeof globalThis.setTimeout> | null =
    null;
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
  private sessionId: string | null = null;
  private telemetry: VoiceTelemetryState | null = null;
  private audioPipeline: VoiceInputTelemetrySummary["audioPipeline"] =
    "unknown";
  private stopReason: VoiceInputStopReason | null = null;
  private pendingStopReason: VoiceInputStopReason | null = null;
  private doneEmitted = false;

  constructor(options: VoiceInputClientOptions = {}) {
    this.url = resolveVoiceInputWebsocketUrl({
      env: options.env,
      url: options.url,
    });
    this.getAccessToken = options.getAccessToken;
    this.WebSocketImpl = options.WebSocketImpl ?? getDefaultWebSocket();
    this.audioConstraints = options.audioConstraints;
    this.vadOptions = options.vad;
    this.asrOptions = options.asr;
    this.preferAudioWorklet = options.preferAudioWorklet ?? true;
    this.connectionTimeoutMs =
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.idleConnectionTimeoutMs =
      options.idleConnectionTimeoutMs ?? DEFAULT_IDLE_CONNECTION_TIMEOUT_MS;
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

  stop(reason: VoiceInputStopReason = "manual") {
    this.stopReason = reason;
    if (this.telemetry && !this.telemetry.stopAt)
      this.telemetry.stopAt = Date.now();
    const pendingSamples = this.audioChunker.flush();
    if (pendingSamples) this.sendAudio(pendingSamples);
    const shouldStopAsr = this.asrStartRequested || this.asrStarted;
    if (this.asrStarted) {
      this.flushPendingAudio();
      this.send({
        type: "asr.stop",
        requestId: this.sessionId ?? undefined,
        payload: { reason, clientSessionId: this.sessionId },
      });
    } else if (this.asrStartRequested) {
      this.pendingStopReason = reason;
    }
    if (!this.asrStartRequested) this.resolveAsrStartWaiter();
    this.cleanupAudio({
      clearPendingAudio: !this.asrStartRequested,
      resetAsrState: !this.asrStartRequested,
    });
    this.started = false;
    this.scheduleIdleClose();
    if (!shouldStopAsr) {
      this.emitTelemetry(reason);
      this.emitDone();
    }
  }

  cancel(reason: VoiceInputStopReason = "cancel") {
    this.stopReason = reason;
    if (this.telemetry && !this.telemetry.stopAt)
      this.telemetry.stopAt = Date.now();
    const shouldCancelAsr = this.asrStartRequested || this.asrStarted;
    if (shouldCancelAsr)
      this.send({
        type: "asr.cancel",
        requestId: this.sessionId ?? undefined,
        payload: { reason, clientSessionId: this.sessionId },
      });
    this.cleanupAudio();
    this.started = false;
    this.scheduleIdleClose();
    this.emitTelemetry(reason);
    if (!shouldCancelAsr) this.emitDone();
  }

  close() {
    this.emitTelemetry(this.stopReason ?? "client_close");
    this.intentionalClose = true;
    this.clearIdleCloseTimer();
    this.cleanupAudio();
    this.closeSocket();
    this.started = false;
  }

  private async startInternal() {
    this.clearIdleCloseTimer();
    this.started = true;
    this.asrStartRequested = false;
    this.asrStarted = false;
    this.sessionId = createVoiceInputSessionId();
    this.telemetry = {
      sessionId: this.sessionId,
      startedAt: Date.now(),
      audioBytes: 0,
      audioChunks: 0,
      partialMessages: 0,
      finalMessages: 0,
      insertedChars: 0,
      endpointCount: 0,
      speechMs: 0,
      silenceMs: 0,
      peak: 0,
      maxRms: 0,
      emitted: false,
    };
    this.audioPipeline = "unknown";
    this.stopReason = null;
    this.audioChunker.reset();
    this.vad = new VoiceInputVad(this.vadOptions);
    this.pendingAudio = [];
    this.intentionalClose = false;
    this.pendingStopReason = null;
    this.doneEmitted = false;

    try {
      await this.withConnectionTimeout(this.ensureAuthenticatedSocket());
      if (!this.started) {
        this.cleanupAudio();
        return;
      }
      await this.withConnectionTimeout(this.setupAudio());
      if (!this.started) {
        this.cleanupAudio();
        return;
      }
      await this.withConnectionTimeout(this.startAsrSession());
      if (!this.started) this.cleanupAudio();
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
    if (this.socket?.readyState === WEBSOCKET_OPEN && this.authenticated)
      return;

    await this.ensureSocketOpen();
    if (this.authenticated) return;

    try {
      await this.authenticate(false);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "UNAUTHORIZED")
        throw error;
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
          if (this.telemetry)
            this.telemetry.error = { message: "Voice connection closed" };
          this.cleanupAudio();
          this.started = false;
          this.callbacks.onError?.("Voice connection closed. Try again.");
          this.emitTelemetry("error");
          this.emitDone();
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
    this.asrStartRequested = true;
    this.send({
      type: "asr.start",
      requestId: this.sessionId ?? undefined,
      payload: {
        ...(this.asrOptions ? { asr: this.asrOptions } : {}),
        client: {
          sessionId: this.sessionId,
          audioPipeline: this.audioPipeline,
          vadEnabled: this.vadOptions?.enabled ?? true,
        },
      },
    });
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
    this.emitDone();
  }

  private async setupAudio() {
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices)
      throw new Error("Microphone input is not available in this environment");
    const AudioContextImpl = getDefaultAudioContext();
    if (!AudioContextImpl)
      throw new Error("AudioContext is not available in this environment");

    this.stream = await mediaDevices.getUserMedia({
      audio: createVoiceInputAudioConstraints(this.audioConstraints),
    });
    this.audioContext = createAudioContext(AudioContextImpl);
    await this.audioContext.resume().catch(() => undefined);
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    if (await this.setupAudioWorklet()) return;
    this.setupScriptProcessor();
  }

  private async setupAudioWorklet() {
    if (
      !this.preferAudioWorklet ||
      !this.audioContext?.audioWorklet ||
      !this.source
    )
      return false;

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
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        VOICE_INPUT_WORKLET_NAME,
        {
          channelCount: 1,
          channelCountMode: "explicit",
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        },
      );
      this.workletNode.port.onmessage = (event) => {
        const samples = toFloat32Array(event.data);
        if (samples) this.handleAudioSamples(samples);
      };
      this.sink = this.audioContext.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.workletNode);
      this.workletNode.connect(this.sink);
      this.sink.connect(this.audioContext.destination);
      this.audioPipeline = "audio-worklet";
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
    if (!this.audioContext || !this.source)
      throw new Error("Audio input is not ready");
    this.processor = this.audioContext.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      1,
      1,
    );
    this.processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      this.handleAudioSamples(samples);
    };
    this.sink = this.audioContext.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.audioContext.destination);
    this.audioPipeline = "script-processor";
  }

  private handleAudioSamples(samples: Float32Array) {
    if (!this.started) return;
    const resampled = resampleTo16k(
      samples,
      this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE,
    );
    for (const chunk of this.audioChunker.push(resampled)) {
      const vadResult = this.vad?.process(chunk);
      if (!vadResult) {
        this.sendAudio(chunk);
        continue;
      }

      this.recordVoiceActivity(vadResult.event);
      this.callbacks.onVoiceActivity?.(vadResult.event);
      for (const audioChunk of vadResult.chunks) this.sendAudio(audioChunk);
      if (vadResult.endpoint) {
        if (this.telemetry) this.telemetry.endpointCount += 1;
        this.callbacks.onEndpoint?.();
        this.stop("vad_endpoint");
        return;
      }
    }
  }

  private sendAudio(samples: Float32Array) {
    const pcm = floatToPcm16(samples);
    this.recordAudio(pcm.byteLength);
    const audio = encodeBase64(pcm);
    if (!this.asrStarted) {
      this.pendingAudio.push(audio);
      return;
    }
    this.send({
      type: "asr.audio",
      requestId: this.sessionId ?? undefined,
      payload: { audio },
    });
  }

  private flushPendingAudio() {
    if (!this.asrStarted) return;
    for (const audio of this.pendingAudio.splice(0)) {
      this.send({
        type: "asr.audio",
        requestId: this.sessionId ?? undefined,
        payload: { audio },
      });
    }
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WEBSOCKET_OPEN)
      this.socket.send(JSON.stringify(message));
  }

  private handleMessage(event: MessageEvent) {
    const data = JSON.parse(String(event.data)) as VoiceInputEvent;

    if (data.type === "system.auth.ok") {
      this.authenticated = true;
      this.resolveAuthWaiter();
      return data;
    }

    if (this.isStaleAsrEvent(data)) return data;

    const transcript = buildTranscriptEvent(data);
    const text = transcript.text;

    if (data.type === "asr.started") {
      this.asrStartRequested = false;
      this.asrStarted = true;
      if (this.telemetry) this.telemetry.readyAt = Date.now();
      this.flushPendingAudio();
      const pendingStopReason = this.pendingStopReason;
      if (pendingStopReason) {
        this.pendingStopReason = null;
        this.send({
          type: "asr.stop",
          requestId: this.sessionId ?? undefined,
          payload: { reason: pendingStopReason, clientSessionId: this.sessionId },
        });
      }
      this.resolveAsrStartWaiter();
      return data;
    }

    if (data.type === "asr.error") {
      const message = getErrorMessage(data);
      const code = getErrorCode(data);
      if (code === "UNAUTHORIZED" && this.authWaiter) {
        this.authenticated = false;
        this.rejectAuthWaiter(new Error("UNAUTHORIZED"));
        return data;
      }
      const hadStartWaiter = Boolean(this.asrStartWaiter);
      if (this.telemetry) this.telemetry.error = { code, message };
      if (code === "UNAUTHORIZED") {
        this.authenticated = false;
        this.rejectAuthWaiter(new Error("UNAUTHORIZED"));
      }
      this.rejectAsrStartWaiter(new Error(message));
      this.callbacks.onError?.(message);
      this.emitTelemetry("error");
      if (!hadStartWaiter && (this.started || this.asrStarted)) {
        this.cleanupAudio();
        this.started = false;
        this.pendingStopReason = null;
        this.scheduleIdleClose();
        this.emitDone();
      }
      return data;
    }

    if (data.type === "asr.partial") {
      this.recordPartial();
      this.callbacks.onPartial?.(text, transcript);
    }
    if (data.type === "asr.final") {
      this.recordFinal(text);
      this.callbacks.onFinal?.(text, transcript);
    }
    if (data.type === "asr.done" || data.type === "asr.cancelled") {
      this.resolveAsrStartWaiter();
      this.asrStartRequested = false;
      this.asrStarted = false;
      this.started = false;
      if (this.telemetry) this.telemetry.doneAt = Date.now();
      this.scheduleIdleClose();
      this.emitTelemetry(this.stopReason ?? "done");
      this.emitDone();
    }
    return data;
  }

  private isStaleAsrEvent(event: VoiceInputEvent) {
    if (!event.type.startsWith("asr.")) return false;
    if (!event.requestId) return false;
    return event.requestId !== this.sessionId;
  }

  private emitDone() {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    this.callbacks.onDone?.();
  }

  private cleanupAudio(
    options: { clearPendingAudio?: boolean; resetAsrState?: boolean } = {},
  ) {
    const clearPendingAudio = options.clearPendingAudio ?? true;
    const resetAsrState = options.resetAsrState ?? true;
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
    this.vad?.reset();
    this.vad = null;
    if (clearPendingAudio) this.pendingAudio = [];
    if (resetAsrState) {
      this.asrStartRequested = false;
      this.asrStarted = false;
    }
  }

  private recordAudio(byteLength: number) {
    if (!this.telemetry) return;
    const now = Date.now();
    if (!this.telemetry.firstAudioAt) this.telemetry.firstAudioAt = now;
    this.telemetry.audioChunks += 1;
    this.telemetry.audioBytes += byteLength;
  }

  private recordVoiceActivity(event: VoiceActivityEvent) {
    if (!this.telemetry) return;
    this.telemetry.speechMs = Math.max(this.telemetry.speechMs, event.speechMs);
    this.telemetry.silenceMs = Math.max(
      this.telemetry.silenceMs,
      event.silenceMs,
    );
    this.telemetry.peak = Math.max(this.telemetry.peak, event.peak);
    this.telemetry.maxRms = Math.max(this.telemetry.maxRms, event.level);
  }

  private recordPartial() {
    if (!this.telemetry) return;
    const now = Date.now();
    if (!this.telemetry.firstPartialAt) this.telemetry.firstPartialAt = now;
    this.telemetry.partialMessages += 1;
  }

  private recordFinal(text: string) {
    if (!this.telemetry) return;
    const now = Date.now();
    if (!this.telemetry.firstFinalAt) this.telemetry.firstFinalAt = now;
    this.telemetry.finalMessages += 1;
    this.telemetry.insertedChars += text.length;
  }

  private emitTelemetry(
    stopReason: VoiceInputTelemetrySummary["stopReason"],
    error?: VoiceTelemetryState["error"],
  ) {
    const telemetry = this.telemetry;
    if (!telemetry || telemetry.emitted) return;
    const doneAt = telemetry.doneAt ?? Date.now();
    telemetry.doneAt = doneAt;
    telemetry.emitted = true;
    if (error) telemetry.error = error;
    const firstAudioAt = telemetry.firstAudioAt;
    this.callbacks.onTelemetry?.({
      sessionId: telemetry.sessionId,
      requestId: telemetry.sessionId,
      stopReason,
      audioPipeline: this.audioPipeline,
      vadEnabled: this.vadOptions?.enabled ?? true,
      timing: {
        durationMs: doneAt - telemetry.startedAt,
        ...(telemetry.readyAt
          ? { startToReadyMs: telemetry.readyAt - telemetry.startedAt }
          : {}),
        ...(firstAudioAt && telemetry.firstPartialAt
          ? { firstAudioToPartialMs: telemetry.firstPartialAt - firstAudioAt }
          : {}),
        ...(firstAudioAt && telemetry.firstFinalAt
          ? { firstAudioToFinalMs: telemetry.firstFinalAt - firstAudioAt }
          : {}),
        ...(telemetry.stopAt
          ? { stopToDoneMs: doneAt - telemetry.stopAt }
          : {}),
      },
      traffic: {
        audioBytes: telemetry.audioBytes,
        audioChunks: telemetry.audioChunks,
        partialMessages: telemetry.partialMessages,
        finalMessages: telemetry.finalMessages,
        insertedChars: telemetry.insertedChars,
      },
      vad: {
        endpointCount: telemetry.endpointCount,
        speechMs: telemetry.speechMs,
        silenceMs: telemetry.silenceMs,
        peak: telemetry.peak,
        maxRms: telemetry.maxRms,
      },
      ...(telemetry.error ? { error: telemetry.error } : {}),
    });
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

  createInputClient(
    callbacks: VoiceInputCallbacks = {},
    options: VoiceInputCreateOptions = {},
  ) {
    return new VoiceInputClient({
      ...this.defaults,
      ...options,
      callbacks,
    });
  }
}

export const createVoiceInputClient = (options?: VoiceInputClientOptions) =>
  new VoiceInputClient(options);
