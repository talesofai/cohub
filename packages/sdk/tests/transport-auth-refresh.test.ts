import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HttpError,
	HttpTransport,
	matchesUnauthorizedErrorToken,
} from "../src/transport.js";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const authorization = (init?: RequestInit) =>
  new Headers(init?.headers).get("Authorization");

test("concurrent 401 responses share one token refresh", async () => {
  const concurrency = 8;
  let currentToken = "stale";
  let forceRefreshCalls = 0;
  let staleRequests = 0;
  let releaseStaleRequests = () => {};
  const allStaleRequestsArrived = new Promise<void>((resolve) => {
    releaseStaleRequests = resolve;
  });
  const retryHeaders: Array<string | null> = [];
  let unauthorizedCalls = 0;

  const transport = new HttpTransport({
    baseUrl: "https://api.example.com",
    getAccessToken: async (options) => {
      if (options?.forceRefresh) {
        forceRefreshCalls += 1;
        currentToken = "fresh";
      }
      return currentToken;
    },
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
    fetch: async (_input, init) => {
      const auth = authorization(init);
      if (auth === "Bearer stale") {
        staleRequests += 1;
        if (staleRequests === concurrency) releaseStaleRequests();
        await allStaleRequestsArrived;
        return jsonResponse(401, { message: "expired" });
      }
      retryHeaders.push(auth);
      return jsonResponse(200, { ok: true });
    },
  });

  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      transport.request<{ ok: boolean }>(`/request/${index}`),
    ),
  );

  assert.equal(forceRefreshCalls, 1);
  assert.equal(unauthorizedCalls, 0);
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(retryHeaders, Array(concurrency).fill("Bearer fresh"));
});

test("a late 401 for an old token reuses the completed refresh", async () => {
  let currentToken = "stale";
  let forceRefreshCalls = 0;
  let releaseLateRequest = () => {};
  let markLateRequestStarted = () => {};
  const lateRequestCanReturn = new Promise<void>((resolve) => {
    releaseLateRequest = resolve;
  });
  const lateRequestStarted = new Promise<void>((resolve) => {
    markLateRequestStarted = resolve;
  });
  let unauthorizedCalls = 0;

  const transport = new HttpTransport({
    baseUrl: "https://api.example.com",
    getAccessToken: async (options) => {
      if (options?.forceRefresh) {
        forceRefreshCalls += 1;
        currentToken = "fresh";
      }
      return currentToken;
    },
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
    fetch: async (input, init) => {
      const url = String(input);
      const auth = authorization(init);
      if (auth === "Bearer stale" && url.endsWith("/late")) {
        markLateRequestStarted();
        await lateRequestCanReturn;
        return jsonResponse(401, { message: "expired" });
      }
      if (auth === "Bearer stale") {
        return jsonResponse(401, { message: "expired" });
      }
      return jsonResponse(200, { ok: true });
    },
  });

  const late = transport.request<{ ok: boolean }>("/late");
  await lateRequestStarted;
  const first = await transport.request<{ ok: boolean }>("/first");
  releaseLateRequest();
  const second = await late;

  assert.deepEqual([first.ok, second.ok], [true, true]);
  assert.equal(forceRefreshCalls, 1);
  assert.equal(unauthorizedCalls, 0);
});

test("a late unauthenticated 401 reuses a newly established session", async () => {
  let currentToken: string | null = null;
  let forceRefreshCalls = 0;
  let releaseInitialRequest = () => {};
  let markInitialRequestStarted = () => {};
  const initialRequestCanReturn = new Promise<void>((resolve) => {
    releaseInitialRequest = resolve;
  });
  const initialRequestStarted = new Promise<void>((resolve) => {
    markInitialRequestStarted = resolve;
  });
  const requestHeaders: Array<string | null> = [];

  const transport = new HttpTransport({
    baseUrl: "https://api.example.com",
    getAccessToken: async (options) => {
      if (options?.forceRefresh) {
        forceRefreshCalls += 1;
        currentToken = "unnecessary-refresh";
      }
      return currentToken;
    },
    fetch: async (_input, init) => {
      const auth = authorization(init);
      requestHeaders.push(auth);
      if (!auth) {
        markInitialRequestStarted();
        await initialRequestCanReturn;
        return jsonResponse(401, { message: "sign in required" });
      }
      return jsonResponse(200, { ok: true });
    },
  });

  const request = transport.request<{ ok: boolean }>("/late-login");
  await initialRequestStarted;
  currentToken = "new-login";
  releaseInitialRequest();

  assert.equal((await request).ok, true);
  assert.equal(forceRefreshCalls, 0);
  assert.deepEqual(requestHeaders, [null, "Bearer new-login"]);
});

test("different rejected tokens do not share an in-flight refresh result", async () => {
  let currentToken = "a-stale";
  let releaseA = () => {};
  let markAStarted = () => {};
  let markBRejected = () => {};
  const aStarted = new Promise<void>((resolve) => {
    markAStarted = resolve;
  });
  const aCanFinish = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const bRejected = new Promise<void>((resolve) => {
    markBRejected = resolve;
  });
  const forceRefreshes: Array<string | null | undefined> = [];
  const retries = new Map<string, string | null>();

  const transport = new HttpTransport({
    baseUrl: "https://api.example.com",
    getAccessToken: async (options) => {
      if (!options?.forceRefresh) return currentToken;
      forceRefreshes.push(options.rejectedToken);
      if (options.rejectedToken === "a-stale") {
        markAStarted();
        await aCanFinish;
        return "a-fresh";
      }
      assert.equal(options.rejectedToken, "b-stale");
      return "b-fresh";
    },
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const auth = authorization(init);
      if (auth === "Bearer a-stale") return jsonResponse(401, null);
      if (auth === "Bearer b-stale") {
        markBRejected();
        return jsonResponse(401, null);
      }
      retries.set(path, auth);
      return jsonResponse(200, { ok: true });
    },
  });

  const requestA = transport.request("/a");
  await aStarted;
  currentToken = "b-stale";
  const requestB = transport.request("/b");
  await bRejected;
  await Promise.resolve();
  releaseA();
  await Promise.all([requestA, requestB]);

  assert.deepEqual(forceRefreshes, ["a-stale", "b-stale"]);
  assert.deepEqual(Object.fromEntries(retries), {
    "/a": "Bearer a-fresh",
    "/b": "Bearer b-fresh",
  });
});

test("an unauthenticated 401 keeps the request's original auth version", async () => {
  let sessionVersion = 1;
  let markRequestStarted = () => {};
  let releaseRequest = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const requestCanFinish = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let handledVersion: string | number | null | undefined;

  const transport = new HttpTransport({
    baseUrl: "https://api.example.com",
    getAccessToken: async () => null,
    getAuthSessionVersion: () => sessionVersion,
    onUnauthorized: (context) => {
      handledVersion = context.authSessionVersion;
    },
    fetch: async () => {
      markRequestStarted();
      await requestCanFinish;
      return jsonResponse(401, null);
    },
  });

  const request = transport.request("/late-unauthenticated");
  await requestStarted;
  sessionVersion = 2;
  releaseRequest();

  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof HttpError && error.authSessionVersion === 1,
  );
  assert.equal(handledVersion, 1);
});

test("a resolved bearer uses the auth version produced by token resolution", async () => {
  let sessionVersion = 0;
  let normalCalls = 0;
  let handledVersion: string | number | null | undefined;
  const transport = new HttpTransport({
    baseUrl: "https://api.example.com",
    getAuthSessionVersion: () => sessionVersion,
    getAccessToken: async (options) => {
      if (options?.forceRefresh) return null;
      normalCalls += 1;
      if (normalCalls === 1) sessionVersion = 1;
      return "resolved-token";
    },
    onUnauthorized: (context) => {
      handledVersion = context.authSessionVersion;
    },
    fetch: async () => jsonResponse(401, null),
  });

  await assert.rejects(
    transport.request("/resolved-token-rejected"),
    (error: unknown) =>
      error instanceof HttpError && error.authSessionVersion === 1,
  );
  assert.equal(handledVersion, 1);
});

test("final unauthorized callback identifies the rejected retry token", async () => {
	let currentToken = "stale";
	let sessionVersion = 0;
	const rejectedTokenMatches: boolean[] = [];
	let rejectedSessionVersion: string | number | null | undefined;
	const transport = new HttpTransport({
		baseUrl: "https://api.example.com",
		getAccessToken: async (options) => {
			if (options?.forceRefresh) {
				currentToken = "fresh";
				sessionVersion = 1;
			}
			return currentToken;
		},
		getAuthSessionVersion: () => sessionVersion,
		onUnauthorized: ({ authSessionVersion, matchesRejectedToken }) => {
			rejectedSessionVersion = authSessionVersion;
			rejectedTokenMatches.push(
				matchesRejectedToken("fresh"),
				matchesRejectedToken("stale"),
			);
    },
    fetch: async () => jsonResponse(401, { message: "unauthorized" }),
  });

	await assert.rejects(
		() => transport.request("/still-unauthorized"),
		(error: unknown) =>
			error instanceof HttpError &&
			error.status === 401 &&
			error.unauthorizedHandled &&
			error.authSessionVersion === 1 &&
			!Object.hasOwn(error, "rejectedToken") &&
			matchesUnauthorizedErrorToken(error, "fresh") === true &&
			matchesUnauthorizedErrorToken(error, "stale") === false,
	);
	assert.deepEqual(rejectedTokenMatches, [true, false]);
	assert.equal(rejectedSessionVersion, 1);
});

test("a skipped unauthorized callback leaves the error unhandled", async () => {
	let unauthorizedCalls = 0;
	const transport = new HttpTransport({
		baseUrl: "https://api.example.com",
		getAccessToken: async () => null,
		onUnauthorized: () => {
			unauthorizedCalls += 1;
		},
		fetch: async () => jsonResponse(401, { message: "unauthorized" }),
	});

	await assert.rejects(
		() =>
			transport.request("/bootstrap", {
				skipUnauthorizedHandler: true,
			}),
		(error: unknown) =>
			error instanceof HttpError &&
			error.status === 401 &&
			!error.unauthorizedHandled &&
			matchesUnauthorizedErrorToken(error, null) === true,
	);
	assert.equal(unauthorizedCalls, 0);
});
