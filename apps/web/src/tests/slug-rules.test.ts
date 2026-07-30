import assert from "node:assert/strict";
import { test } from "node:test";
import {
	normalizePublicSlugInput,
	validateSpaceSlugInput,
	validateUsernameInput,
	validateWorkSlugInput,
} from "$lib/slug-rules";

test("username validation blocks platform paths", () => {
	assert.deepEqual(validateUsernameInput("Docs", { required: true }), {
		value: null,
		error: "This username is reserved.",
	});
	assert.deepEqual(validateUsernameInput("alice-2", { required: true }), {
		value: "alice-2",
		error: null,
	});
});

test("Space slug validation blocks platform and Work route paths", () => {
	assert.deepEqual(validateSpaceSlugInput("settings", { required: true }), {
		value: null,
		error: "This Space slug is reserved.",
	});
	assert.deepEqual(validateSpaceSlugInput("w", { required: true }), {
		value: null,
		error: "This Space slug is reserved.",
	});
	assert.deepEqual(validateSpaceSlugInput("home", { required: true }), {
		value: "home",
		error: null,
	});
});

test("unchanged historical Space slugs remain editable", () => {
	assert.deepEqual(
		validateSpaceSlugInput(" Settings ", {
			currentValue: "settings",
		}),
		{
			value: "settings",
			error: null,
		},
	);
	assert.deepEqual(
		validateSpaceSlugInput("docs", {
			currentValue: "settings",
		}),
		{
			value: null,
			error: "This Space slug is reserved.",
		},
	);
});

test("Work slug validation remains format-only", () => {
	assert.deepEqual(validateWorkSlugInput("docs", { required: true }), {
		value: "docs",
		error: null,
	});
	assert.deepEqual(validateWorkSlugInput("w", { required: true }), {
		value: "w",
		error: null,
	});
	assert.equal(normalizePublicSlugInput("Demo Work"), "demo-work");
});
