import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildFileIngressMainRoute,
	encodePreviewParam,
	isValidPortKey,
	isValidWorkKey,
	parsePreviewParam,
	readPreviewFromSearch,
	withCurrentPreview,
	withPreviewParam,
	withSidebarMainPreview,
} from "../lib/features/space/modules/workspace-preview-route.ts";

test("parsePreviewParam accepts file/board/port", () => {
	assert.deepEqual(parsePreviewParam("file:docs/a.md"), {
		kind: "file",
		key: "docs/a.md",
	});
	assert.deepEqual(parsePreviewParam("port:5173"), {
		kind: "port",
		key: "5173",
	});
	assert.equal(parsePreviewParam("unknown:x"), null);
	assert.equal(parsePreviewParam("file:"), null);
});

test("parsePreviewParam accepts work previews keyed by work id", () => {
	const workId = "123e4567-e89b-42d3-a456-426614174000";
	assert.deepEqual(parsePreviewParam(`work:${workId}`), {
		kind: "work",
		key: workId,
	});
	// The stable key is always an id, so slugs and URLs must not deep-link.
	assert.equal(parsePreviewParam("work:alice/studio/launch"), null);
	assert.equal(parsePreviewParam("work:not-an-id"), null);
	assert.equal(isValidWorkKey(workId), true);
	assert.equal(isValidWorkKey("launch"), false);
});

test("parsePreviewParam rejects host-injection port keys", () => {
	assert.equal(parsePreviewParam("port:80@evil.example"), null);
	assert.equal(parsePreviewParam("port:abc"), null);
	assert.equal(parsePreviewParam("port:0"), null);
	assert.equal(parsePreviewParam("port:99999"), null);
	assert.equal(isValidPortKey("5173"), true);
	assert.equal(isValidPortKey("80@evil"), false);
});

test("withPreviewParam sets and clears preview without dropping other params", () => {
	const withPreview = withPreviewParam("/spaces/s1/sessions/abc", "turn=3", {
		kind: "file",
		key: "a.md",
	});
	assert.equal(
		withPreview,
		`/spaces/s1/sessions/abc?turn=3&preview=${encodeURIComponent("file:a.md")}`,
	);
	assert.equal(
		withPreviewParam(
			"/spaces/s1/sessions/abc",
			"turn=3&preview=file%3Aa.md",
			null,
		),
		"/spaces/s1/sessions/abc?turn=3",
	);
});

test("readPreviewFromSearch reads query", () => {
	assert.deepEqual(readPreviewFromSearch("?preview=file:readme.md"), {
		kind: "file",
		key: "readme.md",
	});
	assert.deepEqual(
		readPreviewFromSearch(new URLSearchParams("preview=board:board.board")),
		{ kind: "board", key: "board.board" },
	);
});

test("legacy file ingress lands on new chat + file preview", () => {
	assert.equal(
		buildFileIngressMainRoute("space-1", "docs/a.md"),
		`/spaces/space-1/sessions/new?preview=${encodeURIComponent("file:docs/a.md")}`,
	);
	assert.equal(encodePreviewParam({ kind: "file", key: "x" }), "file:x");
});

test("closing last preview only drops preview param", () => {
	const main = "/spaces/s/sessions/sess-1";
	const open = withPreviewParam(main, "turn=2", {
		kind: "file",
		key: "a.md",
	});
	const closed = withPreviewParam(
		main,
		new URL(open, "https://x").search,
		null,
	);
	assert.equal(closed, `${main}?turn=2`);
});

test("withCurrentPreview preserves active preview across main route changes", () => {
	const next = withCurrentPreview(
		"/spaces/s1/sessions/new",
		"preview=file%3Adocs%2Fa.md&turn=2",
	);
	assert.equal(
		next,
		`/spaces/s1/sessions/new?preview=${encodeURIComponent("file:docs/a.md")}`,
	);
	assert.equal(
		withCurrentPreview("/spaces/s1/sessions/abc", ""),
		"/spaces/s1/sessions/abc",
	);
});

test("new chat -> session keeps preview (send must not collapse Files)", () => {
	// Repro: open file preview on /sessions/new, send first message, router.toSession
	// must preserve ?preview= so layout does not drop the preview pane.
	const afterSend = withCurrentPreview(
		"/spaces/s1/sessions/sess-created",
		`preview=${encodeURIComponent("file:docs/a.md")}`,
	);
	assert.equal(
		afterSend,
		`/spaces/s1/sessions/sess-created?preview=${encodeURIComponent("file:docs/a.md")}`,
	);
});

test("sidebar main navigation drops preview on mobile, keeps it on desktop", () => {
	const pathname = "/spaces/s1/sessions/sess-2";
	const search = `preview=${encodeURIComponent("board:boards/main.board")}`;
	assert.equal(
		withSidebarMainPreview(pathname, { isMobile: true, currentSearch: search }),
		pathname,
	);
	assert.equal(
		withSidebarMainPreview(pathname, {
			isMobile: false,
			currentSearch: search,
		}),
		`${pathname}?preview=${encodeURIComponent("board:boards/main.board")}`,
	);
});

test("turn navigation can keep preview alongside turn param", () => {
	const withTurn = withPreviewParam(
		"/spaces/s1/sessions/sess-1",
		new URLSearchParams({ turn: "3" }),
		{ kind: "file", key: "docs/a.md" },
	);
	assert.equal(
		withTurn,
		`/spaces/s1/sessions/sess-1?turn=3&preview=${encodeURIComponent("file:docs/a.md")}`,
	);
});
