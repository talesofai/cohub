import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSpaceCheckpointRoute,
	buildSpaceCommerceSettingsRoute,
	buildSpaceLandingRoute,
	buildSpaceSessionRoute,
	buildSpaceSettingsRoute,
	buildUserNewSessionRoute,
	canonicalizeSpaceRoute,
} from "../lib/space-routes.ts";

test("space landing opens a new session in that workspace", () => {
	assert.equal(
		buildSpaceLandingRoute("space-home"),
		"/spaces/space-home/sessions/new",
	);
});

test("friendly Space routes preserve resource subpaths", () => {
	const space = {
		id: "space-1",
		ownerUsername: "alice",
		slug: "product-lab",
	};
	assert.equal(
		buildSpaceLandingRoute(space),
		"/alice/product-lab/sessions/new",
	);
	assert.equal(
		buildSpaceSessionRoute(space, "session-1"),
		"/alice/product-lab/sessions/session-1",
	);
	assert.equal(
		buildSpaceCheckpointRoute(space, "checkpoint-1"),
		"/alice/product-lab/checkpoints/checkpoint-1",
	);
	assert.equal(buildSpaceSettingsRoute(space), "/alice/product-lab/settings");
	assert.equal(
		buildSpaceCommerceSettingsRoute(space),
		"/alice/product-lab/settings/commerce",
	);
});

test("friendly Space routes fall back to immutable ids", () => {
	assert.equal(
		buildSpaceSessionRoute({ id: "space-1", slug: "lab" }, "session-1"),
		"/spaces/space-1/sessions/session-1",
	);
});

test("canonicalizes ID routes without dropping URL state", () => {
	assert.equal(
		canonicalizeSpaceRoute(
			{
				pathname: "/spaces/space-1/sessions/session-1",
				search: "?turn=3&preview=file%3Areadme.md",
				hash: "#latest",
			},
			{
				id: "space-1",
				ownerUsername: "alice",
				slug: "product-lab",
			},
			"space-1",
		),
		"/alice/product-lab/sessions/session-1?turn=3&preview=file%3Areadme.md#latest",
	);
});

test("updates an outdated friendly Space prefix", () => {
	assert.equal(
		canonicalizeSpaceRoute(
			{
				pathname: "/alice/old-lab/tasks/task-1",
				search: "?preview=port%3A3000",
				hash: "",
			},
			{
				id: "space-1",
				ownerUsername: "alice",
				slug: "new-lab",
			},
			"space-1",
		),
		"/alice/new-lab/tasks/task-1?preview=port%3A3000",
	);
});

test("does not canonicalize unrelated or incomplete Space routes", () => {
	assert.equal(
		canonicalizeSpaceRoute(
			{ pathname: "/sessions", search: "", hash: "" },
			{ id: "space-1", ownerUsername: "alice", slug: "lab" },
			null,
		),
		null,
	);
	assert.equal(
		canonicalizeSpaceRoute(
			{ pathname: "/spaces/space-1", search: "", hash: "" },
			{ id: "space-1", ownerUsername: null, slug: "lab" },
			"space-1",
		),
		null,
	);
	assert.equal(
		canonicalizeSpaceRoute(
			{ pathname: "/spaces/space-2/settings", search: "", hash: "" },
			{ id: "space-1", ownerUsername: "alice", slug: "lab" },
			"space-1",
		),
		null,
	);
	assert.equal(
		canonicalizeSpaceRoute(
			{ pathname: "/bob/other-lab/tasks/task-1", search: "", hash: "" },
			{ id: "space-1", ownerUsername: "alice", slug: "lab" },
			"space-2",
		),
		null,
	);
});

test("user session routes preserve the selected space", () => {
	assert.equal(
		buildUserNewSessionRoute("space-1"),
		"/sessions/new?space=space-1",
	);
	assert.equal(buildUserNewSessionRoute("a b"), "/sessions/new?space=a+b");
});
