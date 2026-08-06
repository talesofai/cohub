import assert from "node:assert/strict";
import { test } from "node:test";
import {
	resolveWorkspaceRouteContext,
	resolveWorkspaceSpaceId,
} from "../lib/workspace-route.ts";

test("resolves canonical /spaces/:id routes", () => {
	const ctx = resolveWorkspaceRouteContext({
		pathname: "/spaces/spc_1/sessions/ses_2",
	});
	assert.equal(ctx.spaceId, "spc_1");
	assert.equal(ctx.sessionId, "ses_2");
	assert.deepEqual(ctx.labelResource, { type: "session", ref: "ses_2" });
});

test("prefers page.data.spaceId over path (pretty URL entry)", () => {
	const ctx = resolveWorkspaceRouteContext({
		pathname: "/alice/lab",
		searchParams: new URLSearchParams("session=ses_9"),
		pageData: { spaceId: "spc_pretty", sessionId: null },
	});
	assert.equal(ctx.spaceId, "spc_pretty");
	assert.equal(ctx.sessionId, "ses_9");
	assert.deepEqual(ctx.labelResource, { type: "session", ref: "ses_9" });
});

test("parses resources from friendly Space paths", () => {
	const session = resolveWorkspaceRouteContext({
		pathname: "/alice/lab/sessions/ses_9",
		pageData: { spaceId: "spc_pretty" },
	});
	assert.equal(session.spaceId, "spc_pretty");
	assert.equal(session.sessionId, "ses_9");
	assert.deepEqual(session.labelResource, { type: "session", ref: "ses_9" });

	const checkpoint = resolveWorkspaceRouteContext({
		pathname: "/alice/lab/checkpoints/cp_1",
		pageData: { spaceId: "spc_pretty" },
	});
	assert.equal(checkpoint.checkpointId, "cp_1");
	assert.deepEqual(checkpoint.labelResource, {
		type: "checkpoint",
		ref: "cp_1",
	});

	const file = resolveWorkspaceRouteContext({
		pathname: "/alice/lab/files/docs/a%20b.md",
		pageData: { spaceId: "spc_pretty" },
	});
	assert.equal(file.filePath, "docs/a b.md");
});

test("page.data.sessionId wins over query and path", () => {
	const ctx = resolveWorkspaceRouteContext({
		pathname: "/spaces/spc_1/sessions/ses_path",
		searchParams: new URLSearchParams("session=ses_query"),
		pageData: { spaceId: "spc_1", sessionId: "ses_data" },
	});
	assert.equal(ctx.sessionId, "ses_data");
});

test("ignores draft-only signals: no spaceId without page.data / /spaces path", () => {
	// /sessions/new?space= must not become workspace spaceId
	assert.equal(
		resolveWorkspaceSpaceId({
			pathname: "/sessions/new",
			searchParams: new URLSearchParams("space=spc_draft"),
			pageData: { spaceId: null },
		}),
		null,
	);
});

test("params.id fallback when data missing", () => {
	assert.equal(
		resolveWorkspaceSpaceId({
			pathname: "/spaces/spc_x/settings",
			params: { id: "spc_x" },
		}),
		"spc_x",
	);
});

test("spaces/new is not a workspace space", () => {
	assert.equal(resolveWorkspaceSpaceId({ pathname: "/spaces/new" }), null);
});

test("parses checkpoint / work / task / file resources", () => {
	assert.equal(
		resolveWorkspaceRouteContext({
			pathname: "/spaces/spc_1/checkpoints/cp_1",
		}).checkpointId,
		"cp_1",
	);
	assert.equal(
		resolveWorkspaceRouteContext({
			pathname: "/spaces/spc_1/checkpoints/new",
		}).checkpointId,
		null,
	);
	assert.equal(
		resolveWorkspaceRouteContext({
			pathname: "/spaces/spc_1/works/w_1",
		}).workId,
		"w_1",
	);
	assert.equal(
		resolveWorkspaceRouteContext({
			pathname: "/spaces/spc_1/tasks/t_1",
		}).taskId,
		"t_1",
	);
	assert.deepEqual(
		resolveWorkspaceRouteContext({
			pathname: "/spaces/spc_1/files/docs/a%20b.md",
		}).labelResource,
		{ type: "file", ref: "docs/a b.md" },
	);
});
