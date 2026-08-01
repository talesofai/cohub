import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildViewportContentBlock,
	type ViewportContext,
} from "@cohub/protocol";
import {
	readSessionComposerDraft,
	writeSessionComposerDraft,
} from "../lib/stores/session-composer-drafts.ts";
import {
	createComposerSubmissionFingerprint,
	resolveComposerClientMessageId,
	resolvePendingComposerSubmission,
} from "../lib/stores/session-composer-submission.ts";

class MemoryStorage implements Storage {
	readonly values = new Map<string, string>();

	get length() {
		return this.values.size;
	}

	clear() {
		this.values.clear();
	}

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string) {
		this.values.delete(key);
	}

	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
}

test("composer drafts preserve per-turn system instructions", () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const previousStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	const storage = new MemoryStorage();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});

	try {
		writeSessionComposerDraft("draft", {
			text: "Create an image prompt",
			systemInstructions: "Return only the final prompt",
			retryClientMessageId: "request-1",
			retryRequestFingerprint: "fingerprint-1",
			pendingSubmission: null,
		});
		assert.deepEqual(readSessionComposerDraft("draft"), {
			text: "Create an image prompt",
			systemInstructions: "Return only the final prompt",
			retryClientMessageId: "request-1",
			retryRequestFingerprint: "fingerprint-1",
			pendingSubmission: null,
		});

		writeSessionComposerDraft("instructions-only", {
			text: "",
			systemInstructions: "Keep this draft",
			retryClientMessageId: null,
			retryRequestFingerprint: null,
			pendingSubmission: null,
		});
		assert.equal(
			readSessionComposerDraft("instructions-only").systemInstructions,
			"Keep this draft",
		);

		storage.setItem(
			"legacy",
			JSON.stringify({ text: "Old draft", updatedAt: Date.now() }),
		);
		assert.deepEqual(readSessionComposerDraft("legacy"), {
			text: "Old draft",
			systemInstructions: "",
			retryClientMessageId: null,
			retryRequestFingerprint: null,
			pendingSubmission: null,
		});
	} finally {
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else delete (globalThis as { window?: Window }).window;
		if (previousStorage)
			Object.defineProperty(globalThis, "localStorage", previousStorage);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
	}
});

test("composer drafts preserve and validate a final retry payload", () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const previousStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	const storage = new MemoryStorage();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});

	try {
		const pendingSubmission = {
			spaceId: "space-1",
			sessionId: "session-1",
			content: [
				{ type: "text" as const, text: "Use /home/oai/share/file.txt" },
				{
					type: "image" as const,
					source: { type: "url" as const, url: "https://cdn.test/image.png" },
				},
			],
			text: "Use /home/oai/share/file.txt",
			model: "model-1",
			provider: "provider-1",
			thinkingLevel: "low",
			systemInstructions: "Keep it short",
			generationPolicy: null,
			clientMessageId: "request-1",
			requestFingerprint: "fingerprint-1",
		};
		writeSessionComposerDraft("retry", {
			text: "Draft with uploaded references",
			systemInstructions: "Keep it short",
			retryClientMessageId: "request-1",
			retryRequestFingerprint: "fingerprint-1",
			pendingSubmission,
		});
		const draft = readSessionComposerDraft("retry");
		assert.deepEqual(draft.pendingSubmission, pendingSubmission);
		assert.equal(
			resolvePendingComposerSubmission({
				draft,
				text: draft.text,
				systemInstructions: draft.systemInstructions,
				spaceId: "space-1",
				sessionId: "session-1",
				model: "model-1",
				provider: "provider-1",
				thinkingLevel: "low",
				generationPolicy: null,
				viewportContexts: [],
			}),
			draft.pendingSubmission,
		);
		assert.equal(
			resolvePendingComposerSubmission({
				draft,
				text: `${draft.text} edited`,
				systemInstructions: draft.systemInstructions,
				spaceId: "space-1",
				sessionId: "session-1",
				model: "model-1",
				provider: "provider-1",
				thinkingLevel: "low",
				generationPolicy: null,
				viewportContexts: [],
			}),
			null,
		);
	} finally {
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else delete (globalThis as { window?: Window }).window;
		if (previousStorage)
			Object.defineProperty(globalThis, "localStorage", previousStorage);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
	}
});

test("composer retry rejects a persisted payload when viewport context changes", () => {
	const fileViewport: ViewportContext = {
		kind: "file",
		path: "src/app.ts",
		visibleLines: { start: 10, end: 20 },
	};
	const viewportBlock = buildViewportContentBlock([fileViewport]);
	if (!viewportBlock) throw new Error("viewport block was not created");
	const pendingSubmission = {
		spaceId: "space-1",
		sessionId: "session-1",
		content: [{ type: "text" as const, text: "Review this" }, viewportBlock],
		text: "Review this",
		model: null,
		provider: null,
		thinkingLevel: null,
		systemInstructions: null,
		generationPolicy: null,
		clientMessageId: "request-1",
		requestFingerprint: "fingerprint-1",
	};
	const draft = {
		text: "Review this",
		systemInstructions: "",
		retryClientMessageId: "request-1",
		retryRequestFingerprint: "fingerprint-1",
		pendingSubmission,
	};
	const input = {
		draft,
		text: draft.text,
		systemInstructions: draft.systemInstructions,
		spaceId: "space-1",
		sessionId: "session-1",
		model: null,
		provider: null,
		thinkingLevel: null,
		generationPolicy: null,
	};

	assert.equal(
		resolvePendingComposerSubmission({
			...input,
			viewportContexts: [fileViewport],
		}),
		pendingSubmission,
	);
	assert.equal(
		resolvePendingComposerSubmission({ ...input, viewportContexts: [] }),
		null,
	);
	assert.equal(
		resolvePendingComposerSubmission({
			...input,
			viewportContexts: [
				{ ...fileViewport, visibleLines: { start: 21, end: 30 } },
			],
		}),
		null,
	);
});

test("composer submission identity is reused only for the exact semantic request", async () => {
	const request = {
		spaceId: "space-1",
		content: [{ type: "text", text: "same request" }],
		model: "model-1",
		parameters: { quality: "high", size: 1024 },
	};
	const fingerprint = await createComposerSubmissionFingerprint(request);
	assert.equal(
		await createComposerSubmissionFingerprint({
			parameters: { size: 1024, quality: "high" },
			model: "model-1",
			content: [{ text: "same request", type: "text" }],
			spaceId: "space-1",
		}),
		fingerprint,
	);
	assert.equal(
		resolveComposerClientMessageId({
			retryClientMessageId: "request-1",
			retryRequestFingerprint: fingerprint,
			requestFingerprint: fingerprint,
			randomUUID: () => "request-2",
		}),
		"request-1",
	);
	assert.equal(
		resolveComposerClientMessageId({
			retryClientMessageId: "request-1",
			retryRequestFingerprint: fingerprint,
			requestFingerprint: await createComposerSubmissionFingerprint({
				...request,
				model: "model-2",
			}),
			randomUUID: () => "request-2",
		}),
		"request-2",
	);
});
