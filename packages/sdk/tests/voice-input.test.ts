import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createVoiceInputAudioConstraints,
	floatToPcm16,
	resampleTo16k,
	VoiceInputAudioChunker,
} from "../src/voice-input-audio.js";
import {
	VoiceInputClient,
} from "../src/voice-input.js";

type SentVoiceMessage = {
	type: string;
	payload?: {
		audio?: string;
		token?: string;
	};
};

let lastSocket: MockWebSocket | null = null;
let lastProcessor: MockScriptProcessorNode | null = null;
let requestedAudioConstraints: unknown = null;

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
			this.emit({ type: "system.auth.ok", payload: { user: { uuid: "user-1" } } });
		}
		if (message.type === "asr.start") {
			this.emit({ type: "asr.started" });
		}
	}

	close() {}

	private emit(message: Record<string, unknown>) {
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

	const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");

	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			mediaDevices: {
				getUserMedia: async (constraints: { audio?: unknown }) => {
					requestedAudioConstraints = constraints.audio;
					return {
						getTracks: () => [{ stop() {} }],
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
		if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
		else Reflect.deleteProperty(globalThis, "navigator");
		if (originalAudioContext) Object.defineProperty(globalThis, "AudioContext", originalAudioContext);
		else Reflect.deleteProperty(globalThis, "AudioContext");
	};
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
	assert.deepEqual(createVoiceInputAudioConstraints({ noiseSuppression: false }), {
		channelCount: { ideal: 1 },
		sampleRate: { ideal: 16000 },
		sampleSize: { ideal: 16 },
		echoCancellation: { ideal: true },
		noiseSuppression: false,
		autoGainControl: { ideal: true },
	});
});

test("resampleTo16k averages source samples when downsampling", () => {
	const samples = Float32Array.from([1, 1, -1, -1]);
	assert.deepEqual(Array.from(resampleTo16k(samples, 32000)), [1, -1]);
});

test("VoiceInputAudioChunker emits stable chunks and flushes tail samples", () => {
	const chunker = new VoiceInputAudioChunker(3);

	assert.deepEqual(
		chunker.push(Float32Array.from([1, 2])),
		[],
	);

	const first = chunker.push(Float32Array.from([3, 4, 5, 6, 7]));
	assert.equal(first.length, 2);
	assert.deepEqual(Array.from(first[0] ?? []), [1, 2, 3]);
	assert.deepEqual(Array.from(first[1] ?? []), [4, 5, 6]);

	assert.deepEqual(Array.from(chunker.flush() ?? []), [7]);
	assert.equal(chunker.flush(), null);
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
		assert.deepEqual(requestedAudioConstraints, createVoiceInputAudioConstraints());

		lastProcessor?.emit(Float32Array.from({ length: 3200 }, (_, index) => index / 3200));
		client.stop();
		client.close();

		const messages = lastSocket?.sent.map((message) => message.type);
		assert.deepEqual(messages, ["auth", "asr.start", "asr.audio", "asr.stop"]);
		const audioMessage = lastSocket?.sent.find((message) => message.type === "asr.audio");
		assert.equal(typeof audioMessage?.payload?.audio, "string");
		assert.ok((audioMessage?.payload?.audio.length ?? 0) > 0);
	} finally {
		restore();
	}
});
