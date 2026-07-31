import assert from "node:assert/strict";
import { test } from "node:test";
import {
	readSessionComposerDraft,
	writeSessionComposerDraft,
} from "../lib/stores/session-composer-drafts.ts";
import {
	createComposerSubmissionFingerprint,
	resolveComposerClientMessageId,
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
		});
		assert.deepEqual(readSessionComposerDraft("draft"), {
			text: "Create an image prompt",
			systemInstructions: "Return only the final prompt",
			retryClientMessageId: "request-1",
			retryRequestFingerprint: "fingerprint-1",
		});

		writeSessionComposerDraft("instructions-only", {
			text: "",
			systemInstructions: "Keep this draft",
			retryClientMessageId: null,
			retryRequestFingerprint: null,
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
