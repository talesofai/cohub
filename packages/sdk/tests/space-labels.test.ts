import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient } from "../src/http.js";

test("space labels patch sends incremental mutation", async () => {
	let request: { url: string; init?: RequestInit } | null = null;
	const client = createHttpClient({
		baseUrl: "https://api.example.test",
		fetch: async (url, init) => {
			request = { url: String(url), init };
			return new Response(JSON.stringify({ labels: [], assignments: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});

	await client.space("space-1").labels.patchResourceLabels("session", "session-1", {
		addLabelRefs: ["Todo"],
		removeLabelRefs: ["Doing"],
	});

	assert.equal(
		request?.url,
		"https://api.example.test/api/spaces/space-1/resources/session/labels?resourceRef=session-1",
	);
	assert.equal(request?.init?.method, "PATCH");
	assert.equal(
		request?.init?.body,
		JSON.stringify({ addLabelRefs: ["Todo"], removeLabelRefs: ["Doing"] }),
	);
});
