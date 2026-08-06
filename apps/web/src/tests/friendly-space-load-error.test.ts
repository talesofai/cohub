import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFriendlySpaceLoadError } from "../lib/friendly-space-load-error.ts";

function httpError(status: number) {
	return Object.assign(new Error("SDK error"), { name: "HttpError", status });
}

test("maps friendly Space resolution access errors", () => {
	assert.deepEqual(mapFriendlySpaceLoadError(httpError(404)), {
		status: 404,
		message: "Space not found",
	});
	assert.deepEqual(mapFriendlySpaceLoadError(httpError(401)), {
		status: 401,
		message: "Sign in to access this Space",
	});
	assert.deepEqual(mapFriendlySpaceLoadError(httpError(403)), {
		status: 403,
		message: "You do not have access to this Space",
	});
});

test("hides upstream and unexpected friendly Space resolution errors", () => {
	const expected = { status: 500, message: "Failed to load Space" };
	assert.deepEqual(mapFriendlySpaceLoadError(httpError(503)), expected);
	assert.deepEqual(
		mapFriendlySpaceLoadError(new TypeError("network")),
		expected,
	);
});
