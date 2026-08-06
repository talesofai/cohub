import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isSessionsListPath,
	isSpaceSessionDetailPath,
	isUserNewSessionPath,
	matchMobileSessionNavTransition,
} from "../lib/navigation-transition.ts";

test("isSessionsListPath matches /sessions only", () => {
	assert.equal(isSessionsListPath("/sessions"), true);
	assert.equal(isSessionsListPath("/sessions/"), true);
	assert.equal(isSessionsListPath("/sessions/abc"), false);
	assert.equal(isSessionsListPath("/sessions/new"), false);
	assert.equal(isSessionsListPath("/spaces/x/sessions/y"), false);
});

test("isUserNewSessionPath matches draft route", () => {
	assert.equal(isUserNewSessionPath("/sessions/new"), true);
	assert.equal(isUserNewSessionPath("/sessions/new/"), true);
	assert.equal(isUserNewSessionPath("/sessions"), false);
	assert.equal(isUserNewSessionPath("/sessions/abc"), false);
});

test("isSpaceSessionDetailPath ignores new landing", () => {
	assert.equal(isSpaceSessionDetailPath("/spaces/s1/sessions/abc"), true);
	assert.equal(isSpaceSessionDetailPath("/alice/lab/sessions/abc"), true);
	assert.equal(isSpaceSessionDetailPath("/spaces/s1/sessions/new"), false);
	assert.equal(isSpaceSessionDetailPath("/alice/lab/sessions/new"), false);
	assert.equal(isSpaceSessionDetailPath("/sessions/abc"), false);
});

test("matchMobileSessionNavTransition forward and back", () => {
	assert.equal(
		matchMobileSessionNavTransition("/sessions", "/spaces/s1/sessions/abc"),
		"session-forward",
	);
	assert.equal(
		matchMobileSessionNavTransition("/spaces/s1/sessions/abc", "/sessions"),
		"session-back",
	);
	assert.equal(
		matchMobileSessionNavTransition("/sessions", "/sessions/new"),
		"session-forward",
	);
	assert.equal(
		matchMobileSessionNavTransition("/sessions/new", "/sessions"),
		"session-back",
	);
	assert.equal(
		matchMobileSessionNavTransition("/sessions", "/spaces/s1/sessions/new"),
		null,
	);
	assert.equal(
		matchMobileSessionNavTransition("/sessions/abc", "/spaces/s1/sessions/abc"),
		null,
	);
	assert.equal(
		matchMobileSessionNavTransition("/home", "/spaces/s1/sessions/abc"),
		null,
	);
});
