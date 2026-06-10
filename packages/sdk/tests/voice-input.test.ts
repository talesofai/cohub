import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVoiceInputAudioConstraints,
  floatToPcm16,
  measureAudioLevel,
  normalizeVoiceInputVadOptions,
  resampleTo16k,
  VoiceInputAudioChunker,
  VoiceInputVad,
} from "../src/voice-input-audio.js";
import { CohubClient } from "../src/client.js";
import { VoiceInputClient } from "../src/voice-input.js";

type SentVoiceMessage = {
  type: string;
  requestId?: string;
  payload?: {
    asr?: {
      endWindowSizeMs?: number;
      hotwords?: string[];
      contextText?: string;
    };
    client?: {
      sessionId?: string | null;
      audioPipeline?: string;
      vadEnabled?: boolean;
    };
    audio?: string;
    token?: string;
  };
};

let lastSocket: MockWebSocket | null = null;
let lastProcessor: MockScriptProcessorNode | null = null;
let requestedAudioConstraints: unknown = null;
let autoEmitAsrStarted = true;
let authFailuresRemaining = 0;
let getUserMediaDelayMs = 0;
let stoppedMediaTracks = 0;

class MockWebSocket {
  readonly readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: SentVoiceMessage[] = [];

  constructor(readonly url: string) {
    lastSocket = this;
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  send(data: string) {
    const message = JSON.parse(data) as SentVoiceMessage;
    this.sent.push(message);
    if (message.type === "auth") {
      if (authFailuresRemaining > 0) {
        authFailuresRemaining -= 1;
        this.emit({
          type: "asr.error",
          payload: { code: "UNAUTHORIZED", message: "unauthorized" },
        });
        return;
      }
      this.emit({
        type: "system.auth.ok",
        payload: { user: { uuid: "user-1" } },
      });
    }
    if (message.type === "asr.start" && autoEmitAsrStarted) {
      this.emit({ type: "asr.started" });
    }
  }

  close() {}

  emitClose(code = 1006, reason = "network closed") {
    queueMicrotask(() => {
      this.onclose?.({ code, reason } as CloseEvent);
    });
  }

  emit(message: Record<string, unknown>) {
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify(message),
      } as MessageEvent);
    });
  }
}

class MockScriptProcessorNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  connect() {}

  disconnect() {}

  emit(samples: Float32Array) {
    this.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples,
      },
    } as AudioProcessingEvent);
  }
}

class MockAudioContext {
  readonly sampleRate = 16000;
  readonly destination = {};

  async resume() {}

  async close() {}

  createMediaStreamSource() {
    return {
      connect() {},
      disconnect() {},
    };
  }

  createScriptProcessor() {
    lastProcessor = new MockScriptProcessorNode();
    return lastProcessor;
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect() {},
      disconnect() {},
    };
  }
}

const installVoiceInputMocks = () => {
  lastSocket = null;
  lastProcessor = null;
  requestedAudioConstraints = null;
  autoEmitAsrStarted = true;
  authFailuresRemaining = 0;
  getUserMediaDelayMs = 0;
  stoppedMediaTracks = 0;

  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const originalAudioContext = Object.getOwnPropertyDescriptor(
    globalThis,
    "AudioContext",
  );

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (constraints: { audio?: unknown }) => {
          requestedAudioConstraints = constraints.audio;
          if (getUserMediaDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, getUserMediaDelayMs),
            );
          }
          return {
            getTracks: () => [
              {
                stop() {
                  stoppedMediaTracks += 1;
                },
              },
            ],
          };
        },
      },
    },
  });

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: MockAudioContext,
  });

  return () => {
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalAudioContext)
      Object.defineProperty(globalThis, "AudioContext", originalAudioContext);
    else Reflect.deleteProperty(globalThis, "AudioContext");
  };
};

const waitForSentMessage = async (type: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (lastSocket?.sent.some((message) => message.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`expected websocket message ${type}`);
};

test("voice audio constraints prefer browser speech cleanup", () => {
  assert.deepEqual(createVoiceInputAudioConstraints(), {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 16000 },
    sampleSize: { ideal: 16 },
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
  });
  assert.deepEqual(
    createVoiceInputAudioConstraints({ noiseSuppression: false }),
    {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 16000 },
      sampleSize: { ideal: 16 },
      echoCancellation: { ideal: true },
      noiseSuppression: false,
      autoGainControl: { ideal: true },
    },
  );
});

test("resampleTo16k averages source samples when downsampling", () => {
  const samples = Float32Array.from([1, 1, -1, -1]);
  assert.deepEqual(Array.from(resampleTo16k(samples, 32000)), [1, -1]);
});

test("VoiceInputAudioChunker emits stable chunks and flushes tail samples", () => {
  const chunker = new VoiceInputAudioChunker(3);

  assert.deepEqual(chunker.push(Float32Array.from([1, 2])), []);

  const first = chunker.push(Float32Array.from([3, 4, 5, 6, 7]));
  assert.equal(first.length, 2);
  assert.deepEqual(Array.from(first[0] ?? []), [1, 2, 3]);
  assert.deepEqual(Array.from(first[1] ?? []), [4, 5, 6]);

  assert.deepEqual(Array.from(chunker.flush() ?? []), [7]);
  assert.equal(chunker.flush(), null);
});

test("measureAudioLevel returns rms and peak for samples", () => {
  const level = measureAudioLevel(Float32Array.from([0, 0.5, -0.5, 1]));
  assert.equal(level.peak, 1);
  assert.ok(Math.abs(level.rms - 0.6123724357) < 0.000001);
});

test("normalizeVoiceInputVadOptions clamps unsafe tuning values", () => {
  assert.deepEqual(
    normalizeVoiceInputVadOptions({
      preRollMs: -1,
      silenceDurationMs: 1,
      speechThreshold: 2,
    }),
    {
      enabled: true,
      autoStop: true,
      sampleRate: 16000,
      preRollMs: 0,
      minSpeechMs: 160,
      silenceDurationMs: 400,
      speechThreshold: 1,
      silenceThreshold: 0.005,
      peakThreshold: 0.07,
    },
  );
});

test("VoiceInputVad keeps preroll, emits speech, and endpoints after sustained silence", () => {
  const vad = new VoiceInputVad({
    preRollMs: 200,
    minSpeechMs: 0,
    silenceDurationMs: 400,
    speechThreshold: 0.01,
    silenceThreshold: 0.008,
    peakThreshold: 0.2,
  });
  const quiet = Float32Array.from({ length: 3200 }, () => 0.001);
  const speech = Float32Array.from({ length: 3200 }, () => 0.04);

  assert.equal(vad.process(quiet).chunks.length, 0);
  const active = vad.process(speech);
  assert.equal(active.event.state, "speech");
  assert.equal(active.chunks.length, 1);

  assert.equal(vad.process(quiet).endpoint, false);
  const endpoint = vad.process(quiet);
  assert.equal(endpoint.endpoint, true);
  assert.equal(endpoint.event.state, "endpoint");
});

test("floatToPcm16 clamps samples to signed 16-bit pcm", () => {
  const pcm = floatToPcm16(Float32Array.from([-2, -1, 0, 1, 2]));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => view.getInt16(index * 2, true)),
    [-32768, -32768, 0, 32767, 32767],
  );
});

test("VoiceInputClient sends captured audio over the ASR websocket", async () => {
  const restore = installVoiceInputMocks();
  try {
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
    });

    await client.start();
    assert.equal(lastSocket?.url, "ws://localhost/asr/ws");
    assert.deepEqual(
      requestedAudioConstraints,
      createVoiceInputAudioConstraints(),
    );

    lastProcessor?.emit(
      Float32Array.from({ length: 3200 }, (_, index) => index / 3200),
    );
    client.stop();
    client.close();

    const messages = lastSocket?.sent.map((message) => message.type);
    assert.deepEqual(messages, ["auth", "asr.start", "asr.audio", "asr.stop"]);
    const startMessage = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    );
    assert.equal(typeof startMessage?.requestId, "string");
    assert.equal(typeof startMessage?.payload?.client?.sessionId, "string");
    assert.equal(
      startMessage?.payload?.client?.audioPipeline,
      "script-processor",
    );
    const audioMessage = lastSocket?.sent.find(
      (message) => message.type === "asr.audio",
    );
    assert.equal(typeof audioMessage?.payload?.audio, "string");
    assert.ok((audioMessage?.payload?.audio.length ?? 0) > 0);
  } finally {
    restore();
  }
});

test("VoiceInputClient retries auth without ending the voice session", async () => {
  const restore = installVoiceInputMocks();
  try {
    authFailuresRemaining = 1;
    const forceRefreshRequests: boolean[] = [];
    let doneCount = 0;
    let errorMessage = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: (options) => {
        const forceRefresh = Boolean(options?.forceRefresh);
        forceRefreshRequests.push(forceRefresh);
        return forceRefresh ? "fresh-token" : "stale-token";
      },
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onDone: () => {
          doneCount += 1;
        },
        onError: (message) => {
          errorMessage = message;
        },
      },
    });

    await client.start();
    client.close();

    assert.deepEqual(forceRefreshRequests, [false, true]);
    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "auth", "asr.start"],
    );
    assert.equal(lastSocket?.sent[0]?.payload?.token, "stale-token");
    assert.equal(lastSocket?.sent[1]?.payload?.token, "fresh-token");
    assert.equal(doneCount, 0);
    assert.equal(errorMessage, "");
  } finally {
    restore();
  }
});

test("VoiceInputClient does not request microphone when auth fails", async () => {
  const restore = installVoiceInputMocks();
  try {
    authFailuresRemaining = 2;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
    });

    await assert.rejects(client.start(), /UNAUTHORIZED/);
    client.close();

    assert.equal(requestedAudioConstraints, null);
    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "auth"],
    );
  } finally {
    restore();
  }
});

test("VoiceInputClient stops late microphone streams after setup timeout", async () => {
  const restore = installVoiceInputMocks();
  try {
    getUserMediaDelayMs = 30;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      connectionTimeoutMs: 5,
    });

    await assert.rejects(client.start(), /Voice connection timed out/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    client.close();

    assert.equal(stoppedMediaTracks, 1);
    assert.equal(lastProcessor, null);
  } finally {
    restore();
  }
});

test("VoiceInputClient stops microphone stream when audio source setup fails", async () => {
  const restore = installVoiceInputMocks();
  try {
    class FailingAudioContext extends MockAudioContext {
      createMediaStreamSource() {
        throw new Error("source setup failed");
      }
    }
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: FailingAudioContext,
    });
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
    });

    await assert.rejects(client.start(), /source setup failed/);
    client.close();

    assert.equal(stoppedMediaTracks, 1);
  } finally {
    restore();
  }
});

test("VoiceInputClient sends ASR tuning and context in start payload", async () => {
  const restore = installVoiceInputMocks();
  try {
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      asr: {
        endWindowSizeMs: 600,
        hotwords: ["Cohub", "Neta"],
        contextText: "editing a Cohub session prompt",
      },
    });

    await client.start();
    client.close();

    const startMessage = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    );
    assert.deepEqual(startMessage?.payload?.asr, {
      endWindowSizeMs: 600,
      hotwords: ["Cohub", "Neta"],
      contextText: "editing a Cohub session prompt",
    });
  } finally {
    restore();
  }
});

test("CohubClient forwards voice defaults to created input clients", async () => {
  const restore = installVoiceInputMocks();
  try {
    const client = new CohubClient({
      websocket: {
        WebSocketImpl: MockWebSocket,
      },
      voice: {
        url: "ws://localhost",
        getAccessToken: () => "token-1",
        WebSocketImpl: MockWebSocket,
        preferAudioWorklet: false,
        audioConstraints: { noiseSuppression: false },
        vad: { enabled: false },
        asr: {
          endWindowSizeMs: 700,
          hotwords: ["Cohub"],
          contextText: "composer context",
        },
      },
    });

    const input = client.voice.createInputClient();
    await input.start();
    input.close();

    assert.deepEqual(
      requestedAudioConstraints,
      createVoiceInputAudioConstraints({ noiseSuppression: false }),
    );
    const startMessage = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    );
    assert.deepEqual(startMessage?.payload?.asr, {
      endWindowSizeMs: 700,
      hotwords: ["Cohub"],
      contextText: "composer context",
    });
    assert.equal(startMessage?.payload?.client?.vadEnabled, false);
    assert.equal(
      startMessage?.payload?.client?.audioPipeline,
      "script-processor",
    );
  } finally {
    restore();
  }
});

test("VoiceInputClient reports session telemetry and transcript alternatives", async () => {
  const restore = installVoiceInputMocks();
  try {
    let finalEvent: {
      text: string;
      alternatives: string[];
      originalText?: string;
    } | null = null;
    let summaryAudioChunks = 0;
    let summaryStopReason = "";
    let summaryCount = 0;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onFinal: (text, event) => {
          finalEvent = {
            text,
            alternatives: event.alternatives,
            originalText: event.originalText,
          };
        },
        onTelemetry: (summary) => {
          summaryAudioChunks = summary.traffic.audioChunks;
          summaryStopReason = summary.stopReason;
          summaryCount += 1;
        },
      },
    });

    await client.start();
    lastProcessor?.emit(Float32Array.from({ length: 3200 }, () => 0.08));
    lastSocket?.emit({
      type: "asr.final",
      requestId: lastSocket.sent.find((message) => message.type === "asr.start")
        ?.requestId,
      payload: {
        text: "Cohub works.",
        originalText: "cohub works",
        alternatives: ["Cohub work."],
        rewritten: true,
      },
    });
    client.stop("hotkey_release");
    lastSocket?.emit({ type: "asr.done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.deepEqual(finalEvent, {
      text: "Cohub works.",
      alternatives: ["Cohub work."],
      originalText: "cohub works",
    });
    assert.equal(summaryAudioChunks, 1);
    assert.equal(summaryStopReason, "hotkey_release");
    assert.equal(summaryCount, 1);
  } finally {
    restore();
  }
});

test("VoiceInputClient stops a pending ASR start on hotkey release", async () => {
  const restore = installVoiceInputMocks();
  try {
    autoEmitAsrStarted = false;
    let summaryStopReason = "";
    let doneCount = 0;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onDone: () => {
          doneCount += 1;
        },
        onTelemetry: (summary) => {
          summaryStopReason = summary.stopReason;
        },
      },
    });

    const startPromise = client.start();
    await waitForSentMessage("asr.start");
    const requestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;

    client.stop("hotkey_release");
    lastProcessor?.emit(Float32Array.from({ length: 3200 }, () => 0.08));

    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "asr.start"],
    );

    lastSocket?.emit({ type: "asr.started", requestId });
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "asr.start", "asr.stop"],
    );

    lastSocket?.emit({ type: "asr.done", requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(doneCount, 1);
    assert.equal(summaryStopReason, "hotkey_release");
    assert.equal(
      lastSocket?.sent.filter((message) => message.type === "asr.audio")
        .length,
      0,
    );
  } finally {
    restore();
  }
});

test("VoiceInputClient emits done when pending ASR start errors after stop", async () => {
  const restore = installVoiceInputMocks();
  try {
    autoEmitAsrStarted = false;
    let doneCount = 0;
    let errorMessage = "";
    let summaryStopReason = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onError: (message) => {
          errorMessage = message;
        },
        onDone: () => {
          doneCount += 1;
        },
        onTelemetry: (summary) => {
          summaryStopReason = summary.stopReason;
        },
      },
    });

    const startPromise = client.start();
    await waitForSentMessage("asr.start");
    const requestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;
    client.stop("hotkey_release");

    lastSocket?.emit({
      type: "asr.error",
      requestId,
      payload: {
        code: "PROVIDER_ERROR",
        message: "Voice input is unavailable. Try again later.",
      },
    });
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(errorMessage, "Voice input is unavailable. Try again later.");
    assert.equal(doneCount, 1);
    assert.equal(summaryStopReason, "error");
    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "asr.start"],
    );
  } finally {
    restore();
  }
});

test("VoiceInputClient rejects start when connection closes before ASR starts", async () => {
  const restore = installVoiceInputMocks();
  try {
    autoEmitAsrStarted = false;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
    });

    const startPromise = client.start();
    await waitForSentMessage("asr.start");
    lastSocket?.emitClose();

    await assert.rejects(startPromise, /Voice connection closed/);
    client.close();
  } finally {
    restore();
  }
});

test("VoiceInputClient flushes captured audio before a pending hotkey stop", async () => {
  const restore = installVoiceInputMocks();
  try {
    autoEmitAsrStarted = false;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
    });

    const startPromise = client.start();
    await waitForSentMessage("asr.start");
    const requestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;

    lastProcessor?.emit(Float32Array.from({ length: 3200 }, () => 0.08));
    client.stop("hotkey_release");

    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "asr.start"],
    );

    lastSocket?.emit({ type: "asr.started", requestId });
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "asr.start", "asr.audio", "asr.stop"],
    );

    lastSocket?.emit({ type: "asr.done", requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();
  } finally {
    restore();
  }
});

test("VoiceInputClient treats active ASR errors as terminal", async () => {
  const restore = installVoiceInputMocks();
  try {
    let doneCount = 0;
    let errorMessage = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onError: (message) => {
          errorMessage = message;
        },
        onDone: () => {
          doneCount += 1;
        },
      },
    });

    await client.start();
    lastSocket?.emit({
      type: "asr.error",
      payload: {
        code: "PROVIDER_ERROR",
        message: "Voice input is unavailable. Try again later.",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    lastProcessor?.emit(Float32Array.from({ length: 3200 }, () => 0.08));
    lastSocket?.emit({ type: "asr.done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(errorMessage, "Voice input is unavailable. Try again later.");
    assert.equal(doneCount, 1);
    assert.equal(
      lastSocket?.sent.filter((message) => message.type === "asr.audio")
        .length,
      0,
    );
  } finally {
    restore();
  }
});

test("VoiceInputClient emits done when connection closes during pending stop", async () => {
  const restore = installVoiceInputMocks();
  try {
    let doneCount = 0;
    let errorMessage = "";
    let summaryStopReason = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onError: (message) => {
          errorMessage = message;
        },
        onDone: () => {
          doneCount += 1;
        },
        onTelemetry: (summary) => {
          summaryStopReason = summary.stopReason;
        },
      },
    });

    await client.start();
    client.stop("hotkey_release");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(doneCount, 0);

    lastSocket?.emitClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(errorMessage, "Voice connection closed. Try again.");
    assert.equal(doneCount, 1);
    assert.equal(summaryStopReason, "error");
  } finally {
    restore();
  }
});

test("VoiceInputClient emits done when ASR errors during pending stop", async () => {
  const restore = installVoiceInputMocks();
  try {
    let doneCount = 0;
    let errorMessage = "";
    let summaryStopReason = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onError: (message) => {
          errorMessage = message;
        },
        onDone: () => {
          doneCount += 1;
        },
        onTelemetry: (summary) => {
          summaryStopReason = summary.stopReason;
        },
      },
    });

    await client.start();
    const requestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;
    client.stop("hotkey_release");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(doneCount, 0);

    lastSocket?.emit({
      type: "asr.error",
      requestId,
      payload: {
        code: "PROVIDER_ERROR",
        message: "Voice input is unavailable. Try again later.",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(errorMessage, "Voice input is unavailable. Try again later.");
    assert.equal(doneCount, 1);
    assert.equal(summaryStopReason, "error");
  } finally {
    restore();
  }
});

test("VoiceInputClient emits done when cancelled before ASR starts", async () => {
  const restore = installVoiceInputMocks();
  try {
    let doneCount = 0;
    let summaryStopReason = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onDone: () => {
          doneCount += 1;
        },
        onTelemetry: (summary) => {
          summaryStopReason = summary.stopReason;
        },
      },
    });

    const startPromise = client.start();
    client.cancel();
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(doneCount, 1);
    assert.equal(summaryStopReason, "cancel");
    assert.equal(
      lastSocket?.sent.some((message) => message.type === "asr.cancel"),
      false,
    );
  } finally {
    restore();
  }
});

test("VoiceInputClient emits done when pending ASR start errors after cancel", async () => {
  const restore = installVoiceInputMocks();
  try {
    autoEmitAsrStarted = false;
    let doneCount = 0;
    let errorMessage = "";
    let summaryStopReason = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onError: (message) => {
          errorMessage = message;
        },
        onDone: () => {
          doneCount += 1;
        },
        onTelemetry: (summary) => {
          summaryStopReason = summary.stopReason;
        },
      },
    });

    const startPromise = client.start();
    await waitForSentMessage("asr.start");
    const requestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;
    client.cancel();

    lastSocket?.emit({
      type: "asr.error",
      requestId,
      payload: {
        code: "PROVIDER_ERROR",
        message: "Voice input is unavailable. Try again later.",
      },
    });
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(errorMessage, "Voice input is unavailable. Try again later.");
    assert.equal(doneCount, 1);
    assert.equal(summaryStopReason, "cancel");
    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "asr.start", "asr.cancel"],
    );
  } finally {
    restore();
  }
});

test("VoiceInputClient emits done when active ASR is cancelled", async () => {
  const restore = installVoiceInputMocks();
  try {
    let doneCount = 0;
    let summaryStopReason = "";
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onDone: () => {
          doneCount += 1;
        },
        onTelemetry: (summary) => {
          summaryStopReason = summary.stopReason;
        },
      },
    });

    await client.start();
    const requestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;
    client.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(doneCount, 0);
    assert.equal(summaryStopReason, "cancel");
    assert.equal(
      lastSocket?.sent.some((message) => message.type === "asr.cancel"),
      true,
    );

    lastSocket?.emit({ type: "asr.cancelled", requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(doneCount, 1);
  } finally {
    restore();
  }
});

test("VoiceInputClient resolves pending ASR start when cancelled before ready", async () => {
  const restore = installVoiceInputMocks();
  try {
    autoEmitAsrStarted = false;
    let doneCount = 0;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onDone: () => {
          doneCount += 1;
        },
      },
    });

    const startPromise = client.start();
    await waitForSentMessage("asr.start");
    const requestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;
    client.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(doneCount, 0);
    assert.equal(
      lastSocket?.sent.some((message) => message.type === "asr.cancel"),
      true,
    );

    lastSocket?.emit({ type: "asr.cancelled", requestId });
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.equal(doneCount, 1);
  } finally {
    restore();
  }
});

test("VoiceInputClient cancels ASR when start times out", async () => {
  const restore = installVoiceInputMocks();
  try {
    autoEmitAsrStarted = false;
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      connectionTimeoutMs: 20,
    });

    await assert.rejects(client.start(), /Voice connection timed out/);

    assert.deepEqual(
      lastSocket?.sent.map((message) => message.type),
      ["auth", "asr.start", "asr.cancel"],
    );
    assert.equal(lastSocket?.sent[2]?.requestId, lastSocket?.sent[1]?.requestId);
  } finally {
    restore();
  }
});

test("VoiceInputClient ignores stale ASR events from previous requests", async () => {
  const restore = installVoiceInputMocks();
  try {
    let doneCount = 0;
    const finals: string[] = [];
    const client = new VoiceInputClient({
      url: "ws://localhost",
      getAccessToken: () => "token-1",
      WebSocketImpl: MockWebSocket,
      preferAudioWorklet: false,
      callbacks: {
        onFinal: (text) => {
          finals.push(text);
        },
        onDone: () => {
          doneCount += 1;
        },
      },
    });

    await client.start();
    const firstRequestId = lastSocket?.sent.find(
      (message) => message.type === "asr.start",
    )?.requestId;
    client.stop("manual");

    await client.start();
    const startMessages =
      lastSocket?.sent.filter((message) => message.type === "asr.start") ?? [];
    const secondRequestId = startMessages[1]?.requestId;
    assert.notEqual(firstRequestId, secondRequestId);

    lastSocket?.emit({
      type: "asr.final",
      requestId: firstRequestId,
      payload: { text: "old text" },
    });
    lastSocket?.emit({ type: "asr.done", requestId: firstRequestId });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(finals, []);
    assert.equal(doneCount, 0);

    lastSocket?.emit({
      type: "asr.final",
      requestId: secondRequestId,
      payload: { text: "new text" },
    });
    lastSocket?.emit({ type: "asr.done", requestId: secondRequestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();

    assert.deepEqual(finals, ["new text"]);
    assert.equal(doneCount, 1);
  } finally {
    restore();
  }
});
