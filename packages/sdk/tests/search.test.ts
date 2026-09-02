import assert from "node:assert/strict";
import test from "node:test";
import { SearchApi } from "../src/apis/search.js";
import type { HttpTransport } from "../src/transport.js";

test("SearchApi.overview serializes bounded local recent space hints", async () => {
	const requests: string[] = [];
	const transport = {
		request(path: string) {
			requests.push(path);
			return Promise.resolve({
				generatedAt: "2026-08-27T00:00:00.000Z",
				degraded: false,
				spaces: [],
				recentSessions: [],
			});
		},
	} as unknown as HttpTransport;

	await new SearchApi(transport).overview({
		spaceLimit: 50,
		sessionLimit: 20,
		recentSpaceIds: ["space-a", "space-b"],
	});

	const url = new URL(requests[0] ?? "", "https://api.example.com");
	assert.equal(url.pathname, "/api/palette/overview");
	assert.equal(url.searchParams.get("spaceLimit"), "50");
	assert.equal(url.searchParams.get("sessionLimit"), "20");
	assert.deepEqual(url.searchParams.getAll("recentSpaceId"), [
		"space-a",
		"space-b",
	]);
});
