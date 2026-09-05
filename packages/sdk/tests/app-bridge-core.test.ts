import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	createAppBridgeCore,
	type AppBridgeCoreConfig,
	type AppBridgeCoreApp,
	type AppBridgeDialogState,
} from "../src/app-bridge-core.js";

// --- Test helpers -----------------------------------------------------------

const originalLocalStorage = globalThis.localStorage;
const originalSessionStorage = globalThis.sessionStorage;

function makeApp(overrides: Partial<AppBridgeCoreApp> = {}): AppBridgeCoreApp {
	return {
		id: "work_123",
		spaceId: "space_1",
		slug: "my-work",
		userUuid: "owner-uuid",
		appScopes: ["space.view", "session.view"],
		...overrides,
	};
}

type Reply = { requestId: string; payload: Record<string, unknown> };

function makeConfig(
	overrides: Partial<AppBridgeCoreConfig> & {
		app?: AppBridgeCoreApp;
		replies?: Reply[];
		states?: AppBridgeDialogState[];
		tokens?: (string | null)[];
		viewerUuid?: string | null;
	} = {},
): AppBridgeCoreConfig & { replies: Reply[]; states: AppBridgeDialogState[] } {
	const app = overrides.app ?? makeApp();
	const replies: Reply[] = overrides.replies ?? [];
	const states: AppBridgeDialogState[] = overrides.states ?? [];
	const tokens: (string | null)[] = overrides.tokens ?? ["user-token-abc"];
	const viewerUuid = overrides.viewerUuid === undefined ? "viewer-uuid" : overrides.viewerUuid;

	const base: AppBridgeCoreConfig = {
		app,
		apiOrigin: "https://api.test",
		reply: (requestId, payload) => replies.push({ requestId, payload }),
		getCheckoutState: () => ({ status: null, orderId: null }),
		getAccessToken: async () =>
			tokens.length > 0 ? (tokens.shift() ?? null) : "user-token-abc",
		getViewerUuid: async () => viewerUuid,
		requestSignIn: async () => {},
		onStateChange: (s) => states.push(s),
		...overrides,
	};
	return { ...base, replies, states };
}

function messageEvent(data: Record<string, unknown>): MessageEvent {
	return { data } as MessageEvent;
}

/** Full Storage mock — `length` and `key()` matter for prefix scans. */
function storageMock(store: Record<string, string>): Storage {
	return {
		get length() {
			return Object.keys(store).length;
		},
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
		key: (index: number) => Object.keys(store)[index] ?? null,
		clear: () => {
			for (const key of Object.keys(store)) delete store[key];
		},
	} as Storage;
}

afterEach(() => {
	globalThis.localStorage = originalLocalStorage;
	globalThis.sessionStorage = originalSessionStorage;
});

// --- Tests ------------------------------------------------------------------

test("context message replies with app, viewer, and invocation metadata", async () => {
	const config = makeConfig({
		invocation: {
			surface: "app",
			source: "ui_command",
			spaceId: "source-space",
			sessionId: "source-session",
			turnId: "source-turn",
			toolCallId: "source-tool-call",
		},
		shell: {
			surface: "workspace",
			space: { id: "current-space", name: "Current Space" },
			session: { id: "current-session" },
			turn: { id: "current-turn" },
		},
	});
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({ type: "cohub.app.context", requestId: "r1" }),
	);

	assert.equal(config.replies.length, 1);
	const reply = config.replies[0];
	assert.equal(reply.requestId, "r1");
	assert.equal(reply.payload.type, "cohub.app.context.result");
	const context = reply.payload.context as Record<string, unknown>;
	const app = context.app as Record<string, unknown>;
	assert.equal(app.id, "work_123");
	assert.equal(app.slug, "my-work");
	assert.deepEqual(app.homeSpace, { id: "space_1", name: null });
	assert.deepEqual(context.space, { id: "space_1" });
	assert.deepEqual(context.viewer, { userUuid: "viewer-uuid" });
	assert.deepEqual(context.invocation, {
		surface: "app",
		source: "ui_command",
		spaceId: "source-space",
		sessionId: "source-session",
		turnId: "source-turn",
		toolCallId: "source-tool-call",
	});
	assert.deepEqual(context.shell, {
		surface: "workspace",
		space: { id: "current-space", name: "Current Space" },
		session: { id: "current-session" },
		turn: { id: "current-turn" },
	});
});

test("legacy work context replies with the projected work context", async () => {
	const config = makeConfig();
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({ type: "cohub.work.context", requestId: "legacy-context" }),
	);

	assert.equal(config.replies[0].payload.type, "cohub.work.context.result");
	const context = config.replies[0].payload.context as Record<string, unknown>;
	assert.deepEqual(context.work, {
		id: "work_123",
		slug: "my-work",
		url: "",
	});
	assert.equal("app" in context, false);
	assert.deepEqual(context.space, { id: "space_1" });
	assert.deepEqual(context.permissions, {
		scopes: ["space.view", "session.view"],
		workScopes: ["space.view", "session.view"],
		appScopes: ["space.view", "session.view"],
		viewerScopes: [],
	});
});

test("legacy work token reuses the current app session path", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.resolve(new Response(JSON.stringify({ token: "legacy-token" }), { status: 200 }))) as typeof fetch;

	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);
		await core.handleMessage(
			messageEvent({ type: "cohub.work.token", requestId: "legacy-token" }),
		);
		assert.equal(config.replies[0].payload.type, "cohub.work.token.result");
		assert.equal(config.replies[0].payload.token, "legacy-token");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("legacy work authorize and purchase replies preserve their protocol", async () => {
	const config = makeConfig({ viewerUuid: "viewer-uuid" });
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.work.authorize",
			requestId: "legacy-auth",
			scopes: ["session.prompt.readonly"],
		}),
	);
	core.cancelAuth();
	assert.equal(config.replies[0].payload.type, "cohub.work.authorize.result");
	assert.equal(config.replies[0].payload.token, null);

	await core.handleMessage(
		messageEvent({
			type: "cohub.work.purchase",
			requestId: "legacy-purchase",
			productKey: "pro-monthly",
		}),
	);
	assert.equal(config.replies[1].payload.type, "cohub.work.error");
});

test("context requests read the latest invocation and notify full snapshots", async () => {
	const notifications: Record<string, unknown>[] = [];
	let invocation = { surface: "app" as const, source: "route" as const, sessionId: "first" };
	const config = makeConfig({
		getInvocation: () => invocation,
		notify: (payload) => notifications.push(payload),
	});
	const core = createAppBridgeCore(config);

	await core.handleMessage(messageEvent({ type: "cohub.app.context", requestId: "r1" }));
	assert.equal(
		((config.replies[0].payload.context as Record<string, unknown>).invocation as Record<string, unknown>)
			.sessionId,
		"first",
	);

	invocation = { ...invocation, sessionId: "second" };
	await core.notifyContextChanged();
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "cohub.app.context.changed");
	assert.equal(
		(((notifications[0].context as Record<string, unknown>).invocation as Record<string, unknown>)
			.sessionId),
		"second",
	);
});

test("context message returns a null viewer when unauthenticated", async () => {
	const config = makeConfig({ viewerUuid: null });
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({ type: "cohub.app.context", requestId: "anonymous" }),
	);

	const context = config.replies[0].payload.context as Record<string, unknown>;
	assert.equal(context.viewer, null);
	assert.equal("invocation" in context, false);
});

test("token message mints a session token via API", async () => {
	const fetchCalls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((url: string) => {
		fetchCalls.push(url);
		return Promise.resolve(
			new Response(JSON.stringify({ token: "session-token-xyz" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	}) as typeof fetch;

	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({ type: "cohub.app.token", requestId: "r2" }),
		);

		assert.deepEqual(fetchCalls, ["https://api.test/api/apps/work_123/session"]);
		assert.equal(config.replies.length, 1);
		assert.equal(config.replies[0].payload.type, "cohub.app.token.result");
		assert.equal(config.replies[0].payload.token, "session-token-xyz");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("token message reuses cached session token without re-fetching", async () => {
	let fetchCount = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		fetchCount++;
		return Promise.resolve(
			new Response(JSON.stringify({ token: "session-token-xyz" }), {
				status: 200,
			}),
		);
	}) as typeof fetch;

	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({ type: "cohub.app.token", requestId: "r1" }),
		);
		await core.handleMessage(
			messageEvent({ type: "cohub.app.token", requestId: "r2" }),
		);

		assert.equal(fetchCount, 1);
		assert.equal(config.replies[0].payload.token, "session-token-xyz");
		assert.equal(config.replies[1].payload.token, "session-token-xyz");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("forceRefresh re-fetches the session token", async () => {
	let fetchCount = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		fetchCount++;
		return Promise.resolve(
			new Response(JSON.stringify({ token: `token-${fetchCount}` }), {
				status: 200,
			}),
		);
	}) as typeof fetch;

	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({ type: "cohub.app.token", requestId: "r1" }),
		);
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.token",
				requestId: "r2",
				forceRefresh: true,
			}),
		);

		assert.equal(fetchCount, 2);
		assert.equal(config.replies[0].payload.token, "token-1");
		assert.equal(config.replies[1].payload.token, "token-2");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("scopes from the iframe are whitelisted, deduplicated, and bounded", async () => {
	const config = makeConfig({ viewerUuid: "some-other-viewer" });
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.app.authorize",
			requestId: "r1",
			scopes: [
				"file.view",
				"file.view", // duplicate
				"not.a.permission", // unknown name
				"x".repeat(10_000), // hostile payload
				42, // wrong type
				"session.view",
			],
			reason: `${"r".repeat(5_000)}`,
		}),
	);

	const state = core.getState();
	assert.equal(state.authOpen, true);
	// Only known permissions survive, deduplicated, in first-seen order.
	assert.deepEqual(state.pendingAuth?.scopes, ["file.view", "session.view"]);
	// The reason is truncated to a dialog-friendly length.
	assert.equal(state.pendingAuth?.reason?.length, 280);
});

test("a request whose scopes are all unknown replies an error", async () => {
	const config = makeConfig();
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.app.authorize",
			requestId: "r1",
			scopes: ["definitely.fake", "also.fake"],
		}),
	);

	assert.equal(config.replies.length, 1);
	assert.equal(config.replies[0].payload.type, "cohub.app.error");
	assert.equal(config.replies[0].payload.message, "No scopes requested.");
	assert.equal(core.getState().authOpen, false);
});

test("owner with a revoked grant falls back to the consent dialog", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ message: "grant was revoked" }), {
			status: 403,
		})) as typeof fetch;
	try {
		const config = makeConfig({
			viewerUuid: "owner-uuid",
			authorizationContext: { surface: "background" },
		});
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["space.view"],
			}),
		);

		// The silent owner path failed; the dialog opens instead of an error.
		assert.equal(core.getState().authOpen, true);
		assert.equal(config.replies.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("authorize is no longer gated by the publisher's allowedViewerScopes", async () => {
	const config = makeConfig({ viewerUuid: "some-other-viewer" });
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.app.authorize",
			requestId: "r1",
			// Never publishable as an app scope — viewers may still consent
			// to it; the server gates on what the viewer can grant.
			scopes: ["file.edit"],
		}),
	);

	// No reply yet — the consent dialog opens for the viewer to decide.
	assert.equal(config.replies.length, 0);
	assert.equal(core.getState().authOpen, true);
	assert.deepEqual(core.getState().pendingAuth?.scopes, ["file.edit"]);
});

test("authorize with an empty scope list replies error", async () => {
	const config = makeConfig();
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.app.authorize",
			requestId: "r1",
			scopes: [],
		}),
	);

	assert.equal(config.replies.length, 1);
	assert.equal(config.replies[0].payload.type, "cohub.app.error");
	assert.equal(config.replies[0].payload.message, "No scopes requested.");
	assert.equal(core.getState().authOpen, false);
});

test("authorize opens consent dialog for non-owner without prior grant", async () => {
	const config = makeConfig({ viewerUuid: "some-other-viewer" });
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.app.authorize",
			requestId: "r1",
			scopes: ["session.prompt.readonly"],
			reason: "need to read prompts",
		}),
	);

	// No reply yet — waiting for user to confirm
	assert.equal(config.replies.length, 0);
	const state = core.getState();
	assert.equal(state.authOpen, true);
	assert.equal(state.pendingAuth?.requestId, "r1");
	assert.deepEqual(state.pendingAuth?.scopes, ["session.prompt.readonly"]);
	assert.equal(state.pendingAuth?.reason, "need to read prompts");
});

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200 });

test("selectSpace opens the picker with the viewer's spaces loaded by the host", async () => {
	const originalFetch = globalThis.fetch;
	const fetchedUrls: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		const target = String(url);
		fetchedUrls.push(target);
		if (target.endsWith("/api/spaces")) {
			return jsonResponse([
				{ id: "space-a", name: "Alpha" },
				{ id: "space-b", name: null },
			]);
		}
		return jsonResponse({ token: "picked-token" });
	}) as typeof fetch;
	try {
		const config = makeConfig({ viewerUuid: "some-other-viewer" });
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["file.view"],
				selectSpace: true,
				reason: "pick a space",
			}),
		);

		// The host — not the app — loads the space list.
		assert.deepEqual(fetchedUrls, ["https://api.test/api/spaces"]);
		const state = core.getState();
		assert.equal(state.authOpen, true);
		assert.equal(state.pendingAuth?.selectSpace, true);
		assert.deepEqual(state.pendingAuth?.spaces, [
			{ id: "space-a", name: "Alpha" },
			{ id: "space-b", name: null },
		]);

		// Confirming with the picked space authorizes against it and echoes it back.
		await core.confirmAuth("space-a");
		assert.equal(config.replies.length, 1);
		assert.equal(config.replies[0].payload.token, "picked-token");
		assert.deepEqual(config.replies[0].payload.space, { id: "space-a", name: "Alpha" });
		assert.deepEqual(fetchedUrls, [
			"https://api.test/api/spaces",
			"https://api.test/api/apps/work_123/authorize",
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("selectSpace refreshes an expired user token before loading spaces", async () => {
	const originalFetch = globalThis.fetch;
	const requests: string[] = [];
	const refreshRequests: boolean[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const token = String(new Headers(init?.headers).get("Authorization") ?? "").replace("Bearer ", "");
		requests.push(token);
		if (token === "stale-user-token") return new Response("unauthorized", { status: 401 });
		return jsonResponse([{ id: "space-a", name: "Alpha" }]);
	}) as typeof fetch;
	try {
		const config = makeConfig({
			getAccessToken: async (options) => {
				refreshRequests.push(Boolean(options?.forceRefresh));
				return refreshRequests.length === 1 ? "stale-user-token" : "fresh-user-token";
			},
		});
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["file.view"],
				selectSpace: true,
			}),
		);

		assert.deepEqual(requests, ["stale-user-token", "fresh-user-token"]);
		assert.deepEqual(refreshRequests, [false, true]);
		assert.deepEqual(core.getState().pendingAuth?.spaces, [{ id: "space-a", name: "Alpha" }]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("selectSpace without a pick keeps the dialog open with an error", async () => {
	const config = makeConfig({ viewerUuid: "some-other-viewer" });
	const core = createAppBridgeCore(config);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		jsonResponse([{ id: "space-a", name: "Alpha" }])) as typeof fetch;
	try {
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["file.view"],
				selectSpace: true,
			}),
		);
		await core.confirmAuth();
		assert.equal(core.getState().authOpen, true);
		assert.equal(core.getState().authError, "Pick a Space to continue.");
		assert.equal(config.replies.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("selectSpace re-authorizes silently against the last picked space", async () => {
	const originalFetch = globalThis.fetch;
	const store: Record<string, string> = {
		"cohub:work-grants:viewer-uuid:work_123:space-a:v1": JSON.stringify({
			version: 1,
			userUuid: "viewer-uuid",
			appId: "work_123",
			scopes: ["file.view"],
			updatedAt: Date.now(),
		}),
		"cohub:app-picked-space:work_123": "space-a",
	};
	globalThis.localStorage = storageMock(store);
	globalThis.fetch = (async () => jsonResponse({ token: "silent-token" })) as typeof fetch;
	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["file.view"],
				selectSpace: true,
			}),
		);

		// No dialog: the cached grant on the last picked space covers it.
		assert.equal(core.getState().authOpen, false);
		assert.equal(config.replies.length, 1);
		assert.equal(config.replies[0].payload.token, "silent-token");
		assert.deepEqual(config.replies[0].payload.space, { id: "space-a", name: null });
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalLocalStorage;
	}
});

test("owner auto-authorization is silent and respects alwaysAsk", async () => {
	const originalFetch = globalThis.fetch;
	const bodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return jsonResponse({ token: "owner-token" });
	}) as typeof fetch;
	try {
		// Auto-auth goes through the silent path, so a revoked grant cannot be
		// revived without the owner re-confirming in a dialog.
		const config = makeConfig({
			viewerUuid: "owner-uuid",
			authorizationContext: { surface: "background" },
		});
		const core = createAppBridgeCore(config);
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["space.view"],
			}),
		);
		assert.equal(bodies[0]?.silent, true);
		assert.equal(config.replies[0].payload.token, "owner-token");

		// alwaysAsk forces the dialog even for the owner.
		const asked = makeConfig({
			viewerUuid: "owner-uuid",
			authorizationContext: { surface: "background" },
		});
		const askedCore = createAppBridgeCore(asked);
		await askedCore.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r2",
				scopes: ["space.view"],
				alwaysAsk: true,
			}),
		);
		assert.equal(askedCore.getState().authOpen, true);
		assert.equal(asked.replies.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("authorize replies always carry the target space", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => jsonResponse({ token: "tok" })) as typeof fetch;
	try {
		const config = makeConfig({
			viewerUuid: "owner-uuid",
			authorizationContext: { surface: "background" },
		});
		const core = createAppBridgeCore(config);

		// Owner auto-authorization on the home space.
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["space.view"],
			}),
		);
		assert.deepEqual(config.replies[0].payload.space, { id: "space_1", name: null });

		// Home space name comes from the app record when the host knows it.
		const named = makeConfig({
			app: makeApp({ spaceName: "Home Space" }),
			viewerUuid: "owner-uuid",
			authorizationContext: { surface: "background" },
		});
		const namedCore = createAppBridgeCore(named);
		await namedCore.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r2",
				scopes: ["space.view"],
			}),
		);
		assert.deepEqual(named.replies[0].payload.space, {
			id: "space_1",
			name: "Home Space",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("silent reuse sends silent: true; dialog confirm does not", async () => {
	const store: Record<string, string> = {
		"cohub:work-grants:viewer-uuid:work_123:v1": JSON.stringify({
			version: 1,
			userUuid: "viewer-uuid",
			appId: "work_123",
			scopes: ["file.view"],
			updatedAt: Date.now(),
		}),
	};
	globalThis.localStorage = storageMock(store);
	const originalFetch = globalThis.fetch;
	const bodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return jsonResponse({ token: "tok" });
	}) as typeof fetch;
	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);

		// Cached-grant reuse marks the call silent — the server may then only
		// renew, never revive a revoked grant.
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r-silent",
				scopes: ["file.view"],
			}),
		);
		assert.equal(bodies[0]?.silent, true);

		// A dialog confirmation is an explicit consent: no silent flag.
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r-dialog",
				scopes: ["file.view"],
				alwaysAsk: true,
			}),
		);
		await core.confirmAuth();
		assert.equal(bodies[1]?.silent, undefined);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalLocalStorage;
	}
});

test("transient silent authorization failures preserve cache and return a retryable error", async () => {
	const store: Record<string, string> = {
		"cohub:work-grants:viewer-uuid:work_123:v1": JSON.stringify({
			version: 1,
			userUuid: "viewer-uuid",
			appId: "work_123",
			scopes: ["file.view"],
			updatedAt: Date.now(),
		}),
	};
	globalThis.localStorage = storageMock(store);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ message: "temporarily unavailable" }), {
			status: 503,
		})) as typeof fetch;
	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);
		await core.handleMessage(messageEvent({
			type: "cohub.app.authorize",
			requestId: "r-transient",
			scopes: ["file.view"],
		}));

		assert.equal(core.getState().authOpen, false);
		assert.equal(config.replies[0]?.payload.type, "cohub.app.error");
		assert.equal(config.replies[0]?.payload.message, "temporarily unavailable");
		assert.ok(store["cohub:work-grants:viewer-uuid:work_123:v1"]);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalLocalStorage;
	}
});

test("definitive silent authorization failures clear cache and ask again", async () => {
	const store: Record<string, string> = {
		"cohub:work-grants:viewer-uuid:work_123:v1": JSON.stringify({
			version: 1,
			userUuid: "viewer-uuid",
			appId: "work_123",
			scopes: ["file.view"],
			updatedAt: Date.now(),
		}),
	};
	globalThis.localStorage = storageMock(store);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ message: "grant revoked" }), {
			status: 403,
		})) as typeof fetch;
	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);
		await core.handleMessage(messageEvent({
			type: "cohub.app.authorize",
			requestId: "r-revoked",
			scopes: ["file.view"],
		}));

		assert.equal(core.getState().authOpen, true);
		assert.equal(config.replies.length, 0);
		assert.equal(store["cohub:work-grants:viewer-uuid:work_123:v1"], undefined);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalLocalStorage;
	}
});

test("alwaysAsk skips silent reuse and opens the consent dialog", async () => {
	const store: Record<string, string> = {
		"cohub:work-grants:viewer-uuid:work_123:v1": JSON.stringify({
			version: 1,
			userUuid: "viewer-uuid",
			appId: "work_123",
			scopes: ["file.view"],
			updatedAt: Date.now(),
		}),
	};
	globalThis.localStorage = storageMock(store);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		jsonResponse({ token: "silent-token" })) as typeof fetch;
	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);

		// Silent first: the cached grant covers the request, no dialog.
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r-silent",
				scopes: ["file.view"],
			}),
		);
		assert.equal(core.getState().authOpen, false);

		// alwaysAsk re-opens the dialog even though the grant still covers it.
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r-ask",
				scopes: ["file.view"],
				alwaysAsk: true,
			}),
		);
		assert.equal(core.getState().authOpen, true);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalLocalStorage;
	}
});

test("context merges cached grants with this session's consents", async () => {
	const store: Record<string, string> = {
		"cohub:work-grants:viewer-uuid:work_123:v1": JSON.stringify({
			version: 1,
			userUuid: "viewer-uuid",
			appId: "work_123",
			scopes: ["file.view"],
			updatedAt: Date.now(),
		}),
		"cohub:work-grants:viewer-uuid:work_123:space-b:v1": JSON.stringify({
			version: 1,
			userUuid: "viewer-uuid",
			appId: "work_123",
			scopes: ["taskrun.view"],
			updatedAt: Date.now(),
		}),
	};
	globalThis.localStorage = storageMock(store);
	try {
		// The host pushes context through `notify`; capture what the app receives.
		const seen: Array<Record<string, unknown>> = [];
		const wired = createAppBridgeCore({
			...makeConfig(),
			notify: (payload) => seen.push(payload as Record<string, unknown>),
		});
		await wired.notifyContextChanged();
		const context = seen.at(-1)?.context as {
			permissions?: { viewerGrants?: Array<{ spaceId: string; scopes: string[] }> };
		};
		// The legacy home-space entry maps onto the app home space; the
		// per-space entry passes through as-is.
		assert.deepEqual(context?.permissions?.viewerGrants, [
			{ spaceId: "space_1", scopes: ["file.view"] },
			{ spaceId: "space-b", scopes: ["taskrun.view"] },
		]);
	} finally {
		globalThis.localStorage = originalLocalStorage;
	}
});

test("authorize for a specific space surfaces the space on the dialog", async () => {
	const originalFetch = globalThis.fetch;
	const fetchedUrls: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		fetchedUrls.push(String(url));
		return new Response(JSON.stringify({ name: "Target Space" }), {
			status: 200,
		});
	}) as typeof fetch;
	try {
		const config = makeConfig({ viewerUuid: "some-other-viewer" });
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["file.view"],
				spaceId: "space-2",
				reason: "read your files",
			}),
		);

		// The host resolves the target space name itself.
		assert.deepEqual(fetchedUrls, ["https://api.test/api/spaces/space-2"]);
		const state = core.getState();
		assert.equal(state.authOpen, true);
		assert.equal(state.pendingAuth?.spaceId, "space-2");
		assert.equal(state.pendingAuth?.spaceName, "Target Space");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("background owner is auto-authorized without dialog", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ token: "auth-token-xyz" }), {
				status: 200,
			}),
		)) as typeof fetch;

	try {
		const config = makeConfig({
			authorizationContext: { surface: "background" },
			viewerUuid: "owner-uuid", // same as app.userUuid
		});
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["session.prompt.readonly"],
			}),
		);

		assert.equal(config.replies.length, 1);
		assert.equal(config.replies[0].payload.type, "cohub.app.authorize.result");
		assert.equal(config.replies[0].payload.token, "auth-token-xyz");
		assert.equal(core.getState().authOpen, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("app-surface owner is auto-authorized without dialog", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ token: "preview-auth-token" }), {
				status: 200,
			}),
		)) as typeof fetch;

	try {
		const config = makeConfig({
			authorizationContext: { surface: "app" },
			viewerUuid: "owner-uuid",
		});
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["session.prompt.readonly"],
			}),
		);

		assert.equal(config.replies[0]?.payload.token, "preview-auth-token");
		assert.equal(core.getState().authOpen, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("owner auto-authorization is limited to workspace surfaces", async () => {
	const configs = [
		makeConfig({
			authorizationContext: { surface: "app" },
			viewerUuid: "another-viewer",
		}),
		makeConfig({
			authorizationContext: { surface: "page" },
			viewerUuid: "owner-uuid",
		}),
		makeConfig({
			authorizationContext: { surface: "broker" },
			viewerUuid: "owner-uuid",
		}),
	];

	for (const config of configs) {
		const core = createAppBridgeCore(config);
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["session.prompt.readonly"],
			}),
		);

		assert.equal(config.replies.length, 0);
		assert.equal(core.getState().authOpen, true);
	}
});

test("confirmAuth uses the server's canonical grant Space for replies and cache", async () => {
	let authorizeBody: string | null = null;
	const store: Record<string, string> = {};
	globalThis.localStorage = storageMock(store);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((url: string, init: RequestInit) => {
		if (url.endsWith("/authorize")) {
			authorizeBody = init.body as string;
		}
		return Promise.resolve(
			new Response(JSON.stringify({
				token: "auth-token-xyz",
				grant: {
					spaceId: "space_1",
					scopes: ["session.prompt.readonly"],
				},
			}), { status: 200 }),
		);
	}) as typeof fetch;

	try {
		const config = makeConfig({ viewerUuid: "viewer-uuid" });
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({
				type: "cohub.app.authorize",
				requestId: "r1",
				scopes: ["session.prompt.readonly"],
			}),
		);

		assert.equal(core.getState().authOpen, true);

		await core.confirmAuth();

		assert.equal(core.getState().authOpen, false);
		assert.equal(core.getState().authSaving, false);
		assert.equal(config.replies.length, 1);
		assert.equal(config.replies[0].payload.type, "cohub.app.authorize.result");
		assert.equal(config.replies[0].payload.token, "auth-token-xyz");
		assert.deepEqual(config.replies[0].payload.space, { id: "space_1", name: null });
		assert.deepEqual(JSON.parse(authorizeBody ?? "{}"), { scopes: ["session.prompt.readonly"] });
		assert.equal("cohub:work-grants:viewer-uuid:work_123:v1" in store, false);
		const cached = JSON.parse(
			store["cohub:work-grants:viewer-uuid:work_123:space_1:v1"] ?? "null",
		) as Record<string, unknown>;
		assert.equal(cached.version, 1);
		assert.equal(cached.userUuid, "viewer-uuid");
		assert.equal(cached.appId, "work_123");
		assert.deepEqual(cached.scopes, ["session.prompt.readonly"]);
		assert.equal(typeof cached.updatedAt, "number");
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalLocalStorage;
	}
});

test("cancelAuth replies with null token and closes dialog", async () => {
	const config = makeConfig({ viewerUuid: "viewer-uuid" });
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.app.authorize",
			requestId: "r1",
			scopes: ["session.prompt.readonly"],
		}),
	);

	assert.equal(core.getState().authOpen, true);

	core.cancelAuth();

	assert.equal(core.getState().authOpen, false);
	assert.equal(core.getState().pendingAuth, null);
	assert.equal(config.replies.length, 1);
	assert.equal(config.replies[0].payload.type, "cohub.app.authorize.result");
	assert.equal(config.replies[0].payload.token, null);
});

test("purchase message starts checkout without opening a dialog", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
		checkout: { checkoutUsable: false, orderId: "order-1", productKey: "pro-monthly" },
	}), { status: 200 }))) as typeof fetch;
	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);
		await core.handleMessage(messageEvent({
			type: "cohub.app.purchase",
			requestId: "r1",
			productKey: "pro-monthly",
			purchaseAttemptId: "attempt-1",
		}));

		assert.equal(config.replies.length, 1);
		assert.equal(config.replies[0].payload.type, "cohub.app.purchase.result");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("purchase requests are deduplicated and serialized", async () => {
	let resolveFetch: ((response: Response) => void) | undefined;
	let fetchCount = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		fetchCount += 1;
		return new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
	}) as typeof fetch;
	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);
		const first = core.handleMessage(messageEvent({
			type: "cohub.app.purchase",
			requestId: "r1",
			productKey: "pro-monthly",
			purchaseAttemptId: "attempt-1",
		}));
		await Promise.resolve();
		const duplicate = core.handleMessage(messageEvent({
			type: "cohub.app.purchase",
			requestId: "r2",
			productKey: "pro-monthly",
			purchaseAttemptId: "attempt-2",
		}));
		const competing = core.handleMessage(messageEvent({
			type: "cohub.app.purchase",
			requestId: "r3",
			productKey: "credits",
			purchaseAttemptId: "attempt-3",
		}));
		await Promise.resolve();
		assert.equal(fetchCount, 1);
		assert.equal(config.replies[0].payload.type, "cohub.app.error");
		resolveFetch?.(new Response(JSON.stringify({
			checkout: { checkoutUsable: false, orderId: "order-1", productKey: "pro-monthly" },
		}), { status: 200 }));
		await Promise.all([first, duplicate, competing]);
		assert.equal(fetchCount, 1);
		assert.equal(config.replies.filter(({ payload }) => payload.type === "cohub.app.purchase.result").length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("purchase retries with the same attempt id", async () => {
	const requestBodies: Array<Record<string, unknown>> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((_url: string, init: RequestInit) => {
		requestBodies.push(JSON.parse(String(init.body)));
		if (requestBodies.length === 1) {
			return Promise.resolve(
				new Response(JSON.stringify({ message: "Allocation failed" }), {
					status: 500,
				}),
			);
		}
		return Promise.resolve(
			new Response(
				JSON.stringify({
					checkout: {
						checkoutUsable: false,
						orderId: "order-1",
						productKey: "pro-monthly",
					},
				}),
				{ status: 200 },
			),
		);
	}) as typeof fetch;

	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);
		await core.handleMessage(
			messageEvent({
				type: "cohub.app.purchase",
				requestId: "r1",
				productKey: "pro-monthly",
				purchaseAttemptId: "attempt-1",
			}),
		);

		assert.equal(config.replies[0].payload.type, "cohub.app.error");

		// A new user click may retry with the same idempotency key.
		await core.handleMessage(messageEvent({
			type: "cohub.app.purchase",
			requestId: "r2",
			productKey: "pro-monthly",
			purchaseAttemptId: "attempt-1",
		}));
		assert.deepEqual(requestBodies, [
			{ productKey: "pro-monthly", purchaseAttemptId: "attempt-1" },
			{ productKey: "pro-monthly", purchaseAttemptId: "attempt-1" },
		]);
		assert.equal(config.replies[1].payload.type, "cohub.app.purchase.result");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("purchase carries host promotion attribution and reports the paywall", async () => {
	const requestBodies: Array<Record<string, unknown>> = [];
	const requested: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((_url: string, init: RequestInit) => {
		requestBodies.push(JSON.parse(String(init.body)));
		return Promise.resolve(new Response(JSON.stringify({
			checkout: {
				checkoutUsable: false,
				orderId: "order-1",
				productKey: "pro-monthly",
			},
		}), { status: 200 }));
	}) as typeof fetch;

	try {
		const config = makeConfig({
			getPromotionAttribution: () => ({
				promotionId: "promotion-1",
				fbp: "fbp-1",
			}),
			onPurchaseRequested: (purchase) => requested.push(purchase.purchaseAttemptId),
		});
		const core = createAppBridgeCore(config);
		await core.handleMessage(messageEvent({
			type: "cohub.app.purchase",
			requestId: "r1",
			productKey: "pro-monthly",
			purchaseAttemptId: "attempt-1",
		}));

		assert.deepEqual(requested, ["attempt-1"]);
		assert.deepEqual(requestBodies, [{
			productKey: "pro-monthly",
			purchaseAttemptId: "attempt-1",
			promotionAttribution: {
				promotionId: "promotion-1",
				fbp: "fbp-1",
			},
		}]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("purchase requests do not expose dialog state", () => {
	const state = createAppBridgeCore(makeConfig()).getState();
	assert.equal("purchaseOpen" in state, false);
	assert.equal("pendingPurchase" in state, false);
});

test("onStateChange is called when dialog state changes", async () => {
	const config = makeConfig({ viewerUuid: "viewer-uuid" });
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({
			type: "cohub.app.authorize",
			requestId: "r1",
			scopes: ["session.prompt.readonly"],
		}),
	);

	// At least one state change should have been recorded (dialog opened)
	const lastState = config.states[config.states.length - 1];
	assert.equal(lastState.authOpen, true);
	assert.equal(lastState.pendingAuth?.requestId, "r1");
});

test("checkout-state message reflects current checkout state", async () => {
	const config = makeConfig({
		getCheckoutState: () => ({ status: "success", orderId: "order_abc" }),
	});
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({ type: "cohub.app.checkout-state", requestId: "r1" }),
	);

	assert.equal(config.replies.length, 1);
	assert.equal(config.replies[0].payload.type, "cohub.app.checkout-state.result");
	assert.equal(config.replies[0].payload.status, "success");
	assert.equal(config.replies[0].payload.orderId, "order_abc");
});

test("missing user token triggers requestSignIn and replies null token", async () => {
	let signInCalled = false;
	const config = makeConfig({
		tokens: [null], // getAccessToken returns null
		requestSignIn: async () => {
			signInCalled = true;
		},
	});
	const core = createAppBridgeCore(config);

	await core.handleMessage(
		messageEvent({ type: "cohub.app.token", requestId: "r1" }),
	);

	assert.equal(signInCalled, true);
	assert.equal(config.replies.length, 1);
	assert.equal(config.replies[0].payload.token, null);
});

test("message without requestId is ignored", async () => {
	const config = makeConfig();
	const core = createAppBridgeCore(config);

	await core.handleMessage(messageEvent({ type: "cohub.app.context" }));

	assert.equal(config.replies.length, 0);
});

test("API error surfaces as cohub.app.error reply", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ message: "Work not found" }), {
				status: 404,
			}),
		)) as typeof fetch;

	try {
		const config = makeConfig();
		const core = createAppBridgeCore(config);

		await core.handleMessage(
			messageEvent({ type: "cohub.app.token", requestId: "r1" }),
		);

		assert.equal(config.replies.length, 1);
		assert.equal(config.replies[0].payload.type, "cohub.app.error");
		assert.equal(config.replies[0].payload.message, "Failed to create app session.");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
