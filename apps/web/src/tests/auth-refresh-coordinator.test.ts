import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AuthSessionSnapshot,
	createAuthRefreshCoordinator,
} from "../lib/auth-refresh-coordinator.ts";

class SerialLock {
	private tail: Promise<void> = Promise.resolve();

	async runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release = () => {};
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await task();
		} finally {
			release();
		}
	}
}

function createSharedState(initialToken: string | null) {
	let snapshot: AuthSessionSnapshot = {
		generation: 0,
		attempt: 0,
		token: initialToken,
		updatedAt: 1,
		lastResolutionSucceeded: true,
	};
	return {
		read: () => ({ ...snapshot }),
		commitResolution: (token: string | null) => {
			snapshot = {
				generation: token ? snapshot.generation + 1 : snapshot.generation,
				attempt: snapshot.attempt + 1,
				token: token ?? snapshot.token,
				updatedAt: token ? snapshot.updatedAt + 1 : snapshot.updatedAt,
				lastResolutionSucceeded: token !== null,
			};
		},
		clear: () => {
			snapshot = {
				generation: snapshot.generation + 1,
				attempt: snapshot.attempt + 1,
				token: null,
				updatedAt: snapshot.updatedAt + 1,
				lastResolutionSucceeded: true,
			};
		},
	};
}

function createTab(options: {
	state: ReturnType<typeof createSharedState>;
	lock: SerialLock;
	counters: { resolve: number; clear: number };
}) {
	return createAuthRefreshCoordinator({
		state: options.state,
		lock: options.lock,
		isReusable: (snapshot) =>
			snapshot.token === "fresh" && snapshot.lastResolutionSucceeded,
		resolveToken: async () => {
			options.counters.resolve += 1;
			return "fresh";
		},
		clearSession: async () => {
			options.counters.clear += 1;
		},
	});
}

test("two tabs share one forced token exchange", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const firstTab = createTab({ state, lock, counters });
	const secondTab = createTab({ state, lock, counters });

	const tokens = await Promise.all([
		firstTab.resolveToken({ forceRefresh: true, rejectedToken: "stale" }),
		secondTab.resolveToken({ forceRefresh: true, rejectedToken: "stale" }),
	]);

	assert.deepEqual(tokens, ["fresh", "fresh"]);
	assert.equal(counters.resolve, 1);
	assert.equal(state.read().token, "fresh");
});

test("a forced waiter without a rejected token reuses a new winner", async () => {
	const state = createSharedState(null);
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const tab = createTab({ state, lock, counters });

	const tokens = await Promise.all([
		tab.resolveToken({ forceRefresh: true }),
		tab.resolveToken({ forceRefresh: true }),
	]);

	assert.deepEqual(tokens, ["fresh", "fresh"]);
	assert.equal(counters.resolve, 1);
	assert.equal(counters.clear, 0);
});

test("a forced request does not reuse an in-flight normal lookup", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	const calls: boolean[] = [];
	let markNormalStarted = () => {};
	let releaseNormal = () => {};
	const normalStarted = new Promise<void>((resolve) => {
		markNormalStarted = resolve;
	});
	const normalCanFinish = new Promise<void>((resolve) => {
		releaseNormal = resolve;
	});
	const coordinator = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable: () => false,
		resolveToken: async (forceRefresh) => {
			calls.push(forceRefresh);
			if (!forceRefresh) {
				markNormalStarted();
				await normalCanFinish;
				return "stale";
			}
			return "fresh";
		},
		clearSession: async () => {},
	});

	const normal = coordinator.resolveToken();
	await normalStarted;
	const forced = coordinator.resolveToken({ forceRefresh: true });
	releaseNormal();

	assert.equal(await normal, "stale");
	assert.equal(await forced, "fresh");
	assert.deepEqual(calls, [false, true]);
});

test("an unauthenticated rejection reuses a session established before recovery", async () => {
	const state = createSharedState("fresh");
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const tab = createTab({ state, lock, counters });

	const token = await tab.resolveToken({
		forceRefresh: true,
		rejectedToken: null,
	});

	assert.equal(token, "fresh");
	assert.equal(counters.resolve, 0);
	assert.equal(counters.clear, 0);
});

test("an unauthenticated rejection ignores a non-reusable stale snapshot", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	let resolveCalls = 0;
	const coordinator = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable: () => false,
		resolveToken: async () => {
			resolveCalls += 1;
			return null;
		},
		clearSession: async () => {},
	});

	assert.equal(
		await coordinator.resolveToken({
			forceRefresh: true,
			rejectedToken: null,
		}),
		null,
	);
	assert.equal(resolveCalls, 1);
});

test("two tabs share one normal refresh after the cached token expires", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const firstTab = createTab({ state, lock, counters });
	const secondTab = createTab({ state, lock, counters });

	const tokens = await Promise.all([
		firstTab.resolveToken(),
		secondTab.resolveToken(),
	]);

	assert.deepEqual(tokens, ["fresh", "fresh"]);
	assert.equal(counters.resolve, 1);
	assert.equal(counters.clear, 0);
});

test("a later tab reuses a shared refresh winner instead of its stale local token", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	let winnerCalls = 0;
	let staleCalls = 0;
	const isReusable = (snapshot: AuthSessionSnapshot) =>
		snapshot.token === "fresh" && snapshot.lastResolutionSucceeded;
	const winnerTab = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable,
		resolveToken: async () => {
			winnerCalls += 1;
			return "fresh";
		},
		clearSession: async () => {},
	});
	const staleTab = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable,
		resolveToken: async () => {
			staleCalls += 1;
			return "stale";
		},
		clearSession: async () => {},
	});

	assert.equal(
		await winnerTab.resolveToken({
			forceRefresh: true,
			rejectedToken: "stale",
		}),
		"fresh",
	);
	assert.equal(await staleTab.resolveToken(), "fresh");
	assert.equal(winnerCalls, 1);
	assert.equal(staleCalls, 0);
	assert.equal(state.read().token, "fresh");
});

test("a reader in another tab waits for an in-progress session replacement", async () => {
	const state = createSharedState("current");
	const lock = new SerialLock();
	let markMutationStarted = () => {};
	let releaseMutation = () => {};
	const mutationStarted = new Promise<void>((resolve) => {
		markMutationStarted = resolve;
	});
	const mutationCanFinish = new Promise<void>((resolve) => {
		releaseMutation = resolve;
	});
	const callbackTab = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable: (snapshot) => Boolean(snapshot.token),
		resolveToken: async () => {
			throw new Error("callback tab should not resolve a token");
		},
		clearSession: async () => {},
	});
	const readerTab = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable: (snapshot) => Boolean(snapshot.token),
		resolveToken: async () => {
			throw new Error("callback winner should be reused");
		},
		clearSession: async () => {},
	});

	const mutation = callbackTab.runExclusiveMutation(async () => {
		markMutationStarted();
		await mutationCanFinish;
		state.commitResolution("replacement");
	});
	await mutationStarted;
	let readerSettled = false;
	const reader = readerTab.resolveToken().then((token) => {
		readerSettled = true;
		return token;
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(readerSettled, false);

	releaseMutation();
	await mutation;
	assert.equal(await reader, "replacement");
});

test("a token reader queued after a session mutation observes the mutation", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	let markRefreshStarted = () => {};
	let releaseRefresh = () => {};
	const refreshStarted = new Promise<void>((resolve) => {
		markRefreshStarted = resolve;
	});
	const refreshCanFinish = new Promise<void>((resolve) => {
		releaseRefresh = resolve;
	});
	const coordinator = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable: (snapshot) => snapshot.token !== "stale",
		resolveToken: async () => {
			markRefreshStarted();
			await refreshCanFinish;
			return "refresh-winner";
		},
		clearSession: async () => {},
	});

	const refresh = coordinator.resolveToken({
		forceRefresh: true,
		rejectedToken: "stale",
	});
	await refreshStarted;
	const mutation = coordinator.runExclusiveMutation(async () => {
		state.commitResolution("callback-winner");
	});
	const reader = coordinator.resolveToken();
	releaseRefresh();

	assert.equal(await refresh, "refresh-winner");
	await mutation;
	assert.equal(await reader, "callback-winner");
});

test("a guarded sign-in queued after a callback cannot clear its winner", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const coordinator = createTab({ state, lock, counters });
	const rejected = state.read();
	let releaseBlocker = () => {};
	let markBlockerStarted = () => {};
	const blockerCanFinish = new Promise<void>((resolve) => {
		releaseBlocker = resolve;
	});
	const blockerStarted = new Promise<void>((resolve) => {
		markBlockerStarted = resolve;
	});

	const blocker = coordinator.runExclusiveMutation(async () => {
		markBlockerStarted();
		await blockerCanFinish;
	});
	await blockerStarted;
	const callback = coordinator.runExclusiveMutation(async () => {
		state.commitResolution("fresh");
	});
	let signInStarted = false;
	const signIn = coordinator.runGuardedMutation(
		{
			expectedGeneration: rejected.generation,
			rejectedToken: rejected.token,
		},
		async () => {
			signInStarted = true;
			state.clear();
		},
	);
	releaseBlocker();

	await blocker;
	await callback;
	assert.equal(await signIn, false);
	assert.equal(signInStarted, false);
	assert.equal(state.read().token, "fresh");
});

test("a callback replacement blocks stale cleanup when token resolution fails", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const coordinator = createTab({ state, lock, counters });
	const rejected = state.read();

	await assert.rejects(
		coordinator.runExclusiveMutation(async () => {
			// Mirrors callback completion invalidating the previous request
			// generation before resource-token resolution.
			state.clear();
			throw new Error("resource token unavailable");
		}),
		/resource token unavailable/,
	);

	assert.equal(
		await coordinator.clearBrokenSession({
			expectedGeneration: rejected.generation,
			rejectedToken: rejected.token,
		}),
		false,
	);
	assert.equal(counters.clear, 0);
	assert.equal(state.read().token, null);
});

test("a callback replacement blocks stale unauthenticated cleanup", async () => {
	const state = createSharedState(null);
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const coordinator = createTab({ state, lock, counters });
	const rejected = state.read();

	await assert.rejects(
		coordinator.runExclusiveMutation(async () => {
			state.clear();
			throw new Error("resource token unavailable");
		}),
		/resource token unavailable/,
	);

	assert.equal(
		await coordinator.clearBrokenSession({
			expectedGeneration: rejected.generation,
			rejectedToken: rejected.token,
		}),
		false,
	);
	assert.equal(counters.clear, 0);
	assert.equal(state.read().token, null);
});

test("a cached-token reader waits for a queued session replacement", async () => {
	const state = createSharedState("current");
	const lock = new SerialLock();
	let releaseBlocker = () => {};
	let markBlockerStarted = () => {};
	const blockerCanFinish = new Promise<void>((resolve) => {
		releaseBlocker = resolve;
	});
	const blockerStarted = new Promise<void>((resolve) => {
		markBlockerStarted = resolve;
	});
	const coordinator = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable: (snapshot) => Boolean(snapshot.token),
		resolveToken: async () => {
			throw new Error("queued mutation winner should be reused");
		},
		clearSession: async () => {},
	});

	const blocker = coordinator.runExclusiveMutation(async () => {
		markBlockerStarted();
		await blockerCanFinish;
	});
	await blockerStarted;
	const replacement = coordinator.runExclusiveMutation(async () => {
		state.commitResolution("replacement");
	});
	const reader = coordinator.resolveToken();
	releaseBlocker();

	await blocker;
	await replacement;
	assert.equal(await reader, "replacement");
});

test("waiting tabs do not repeat the same failed refresh", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	let exchanges = 0;
	const createFailingTab = () =>
		createAuthRefreshCoordinator({
			state,
			lock,
			isReusable: () => false,
			resolveToken: async () => {
				exchanges += 1;
				throw new Error("refresh unavailable");
			},
			clearSession: async () => {},
		});
	const firstTab = createFailingTab();
	const secondTab = createFailingTab();

	const results = await Promise.allSettled([
		firstTab.resolveToken({ forceRefresh: true, rejectedToken: "stale" }),
		secondTab.resolveToken({ forceRefresh: true, rejectedToken: "stale" }),
	]);

	assert.equal(results[0]?.status, "rejected");
	assert.deepEqual(results[1], { status: "fulfilled", value: null });
	assert.equal(exchanges, 1);
	assert.equal(state.read().token, "stale");

	const failedAttempt = state.read();
	assert.equal(
		await firstTab.clearBrokenSession({
			expectedGeneration: failedAttempt.generation,
			rejectedToken: "stale",
		}),
		true,
	);
	assert.equal(state.read().token, null);
});

test("a later failed attempt does not invalidate the rejected-session guard", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	let exchanges = 0;
	let clears = 0;
	const coordinator = createAuthRefreshCoordinator({
		state,
		lock,
		isReusable: () => false,
		resolveToken: async () => {
			exchanges += 1;
			throw new Error("refresh unavailable");
		},
		clearSession: async () => {
			clears += 1;
		},
	});

	await assert.rejects(
		coordinator.resolveToken({ forceRefresh: true, rejectedToken: "stale" }),
	);
	const rejectedSession = state.read();
	await assert.rejects(
		coordinator.resolveToken({ forceRefresh: true, rejectedToken: "stale" }),
	);

	assert.equal(
		await coordinator.clearBrokenSession({
			expectedGeneration: rejectedSession.generation,
			rejectedToken: rejectedSession.token,
		}),
		true,
	);
	assert.equal(exchanges, 2);
	assert.equal(clears, 1);
});

test("late cleanup cannot clear a newer session", async () => {
	const state = createSharedState("stale");
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const tab = createTab({ state, lock, counters });
	const rejectedSnapshot = state.read();

	state.commitResolution("fresh");
	assert.equal(
		await tab.clearBrokenSession({
			expectedGeneration: rejectedSnapshot.generation,
			rejectedToken: "stale",
		}),
		false,
	);
	assert.equal(counters.clear, 0);
	assert.equal(state.read().token, "fresh");

	const current = state.read();
	assert.equal(
		await tab.clearBrokenSession({
			expectedGeneration: current.generation,
			rejectedToken: "fresh",
		}),
		true,
	);
	assert.equal(counters.clear, 1);
	assert.equal(state.read().token, null);
});

test("late unauthenticated cleanup cannot clear a newly established session", async () => {
	const state = createSharedState(null);
	const lock = new SerialLock();
	const counters = { resolve: 0, clear: 0 };
	const tab = createTab({ state, lock, counters });

	state.commitResolution("fresh");
	assert.equal(await tab.clearBrokenSession({ rejectedToken: null }), false);
	assert.equal(counters.clear, 0);
	assert.equal(state.read().token, "fresh");

	assert.equal(
		await tab.clearBrokenSession({ rejectedToken: undefined }),
		true,
	);
	assert.equal(counters.clear, 1);
	assert.equal(state.read().token, null);
});
