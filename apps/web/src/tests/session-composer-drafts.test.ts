import assert from "node:assert/strict";
import { test } from "node:test";
import {
	readSessionComposerDraft,
	writeSessionComposerDraft,
} from "../lib/stores/session-composer-drafts.ts";

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
		});
		assert.deepEqual(readSessionComposerDraft("draft"), {
			text: "Create an image prompt",
			systemInstructions: "Return only the final prompt",
		});

		writeSessionComposerDraft("instructions-only", {
			text: "",
			systemInstructions: "Keep this draft",
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
