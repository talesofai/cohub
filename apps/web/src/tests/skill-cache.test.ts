import assert from "node:assert/strict";
import { test } from "node:test";
import { readCachedSkills, writeCachedSkills } from "../lib/skill-cache.ts";

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

test("skill cache preserves mod source metadata and rejects incomplete entries", () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const storage = new MemoryStorage();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});

	try {
		writeCachedSkills("space-1", [
			{
				name: "example",
				description: "Example skill",
				scope: "mod",
				source: {
					type: "mod",
					modSpaceId: "mod-space-id",
					mountSlug: "example-mod",
				},
			},
		]);
		assert.deepEqual(readCachedSkills("space-1"), [
			{
				name: "example",
				description: "Example skill",
				scope: "mod",
				source: {
					type: "mod",
					modSpaceId: "mod-space-id",
					mountSlug: "example-mod",
				},
			},
		]);

		storage.setItem(
			"cohub:space-skills:space-2:v2",
			JSON.stringify({
				version: 2,
				skills: [
					{
						name: "incomplete",
						description: "Missing source",
						scope: "mod",
					},
				],
			}),
		);
		assert.equal(readCachedSkills("space-2"), null);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
	}
});
