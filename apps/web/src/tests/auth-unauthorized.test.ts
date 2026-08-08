import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthSessionSnapshot } from "../lib/auth-refresh-coordinator.ts";
import { decideUnauthorizedRecovery } from "../lib/auth-unauthorized.ts";

const snapshot = (
	overrides: Partial<AuthSessionSnapshot> = {},
): AuthSessionSnapshot => ({
	generation: 4,
	attempt: 8,
	token: "cached-token",
	updatedAt: 1,
	lastResolutionSucceeded: true,
	...overrides,
});

const matcherFor =
	(rejectedToken: string | null) => (candidate: string | null | undefined) =>
		candidate === rejectedToken;

test("an empty rejected credential recovers the retained failed session", () => {
	assert.deepEqual(
		decideUnauthorizedRecovery({
			snapshot: snapshot({ lastResolutionSucceeded: false }),
			rejectedGeneration: 4,
			matchesRejectedToken: matcherFor(null),
		}),
		{
			action: "recover",
			reason: "failed_empty_resolution",
			expectedGeneration: 4,
			rejectedToken: "cached-token",
		},
	);
});

test("a late anonymous rejection cannot clear a newer healthy session", () => {
	assert.deepEqual(
		decideUnauthorizedRecovery({
			snapshot: snapshot({ generation: 5, token: "new-token" }),
			rejectedGeneration: 4,
			matchesRejectedToken: matcherFor(null),
		}),
		{ action: "ignore", reason: "stale_generation" },
	);
});

test("an anonymous rejection cannot clear a healthy session in the same generation", () => {
	assert.deepEqual(
		decideUnauthorizedRecovery({
			snapshot: snapshot(),
			rejectedGeneration: 4,
			matchesRejectedToken: matcherFor(null),
		}),
		{ action: "ignore", reason: "credential_mismatch" },
	);
});

test("an exactly matched rejected credential keeps the existing recovery path", () => {
	assert.deepEqual(
		decideUnauthorizedRecovery({
			snapshot: snapshot(),
			rejectedGeneration: 4,
			matchesRejectedToken: matcherFor("cached-token"),
		}),
		{
			action: "recover",
			reason: "matching_credential",
			expectedGeneration: 4,
			rejectedToken: "cached-token",
		},
	);
});
