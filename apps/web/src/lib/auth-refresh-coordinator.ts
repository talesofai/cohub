export type AuthSessionSnapshot = {
	generation: number;
	attempt: number;
	token: string | null;
	updatedAt: number;
	lastResolutionSucceeded: boolean;
};

export type AuthTokenRequestOptions = {
	forceRefresh?: boolean;
	rejectedToken?: string | null;
};

export type ClearBrokenSessionOptions = {
	expectedGeneration?: number;
	rejectedToken?: string | null;
};

type AuthSessionState = {
	read(): AuthSessionSnapshot;
	commitResolution(token: string | null, forceRefresh: boolean): void;
	clear(): void;
};

type AuthRefreshLock = {
	runExclusive<T>(task: () => Promise<T>): Promise<T>;
};

type AuthRefreshCoordinatorOptions = {
	state: AuthSessionState;
	lock: AuthRefreshLock;
	isReusable: (snapshot: AuthSessionSnapshot) => boolean;
	resolveToken: (forceRefresh: boolean) => Promise<string | null>;
	clearSession: () => Promise<void>;
};

function cleanToken(token: string | null | undefined): string | null {
	if (typeof token !== "string") return null;
	const cleaned = token.replace(/[\r\n\t\0]/g, "").trim();
	return cleaned || null;
}

/**
 * Coordinates Logto token resolution within one page and across same-origin
 * pages. Cross-page mutual exclusion is supplied by the browser Web Locks
 * adapter; the shared snapshot hands the winning token to waiters.
 */
export function createAuthRefreshCoordinator(
	options: AuthRefreshCoordinatorOptions,
) {
	let resolutionInFlight: {
		forceRefresh: boolean;
		promise: Promise<string | null>;
	} | null = null;
	let pendingMutations = 0;

	const sessionMatches = (
		current: AuthSessionSnapshot,
		request: ClearBrokenSessionOptions,
	) => {
		if (
			request.expectedGeneration !== undefined &&
			current.generation !== request.expectedGeneration
		) {
			return false;
		}
		if (
			request.rejectedToken !== undefined &&
			current.token !== cleanToken(request.rejectedToken)
		) {
			return false;
		}
		return true;
	};

	const trackMutation = <T>(operation: () => Promise<T>): Promise<T> => {
		pendingMutations += 1;
		return operation().finally(() => {
			pendingMutations -= 1;
		});
	};

	const resolveToken = async (
		request: AuthTokenRequestOptions = {},
	): Promise<string | null> => {
		const forceRefresh = Boolean(request.forceRefresh);
		const hasRejectedToken = request.rejectedToken !== undefined;
		const rejectedToken = cleanToken(request.rejectedToken);

		const inFlight = resolutionInFlight;
		if (inFlight && pendingMutations === 0) {
			const resolved = await inFlight.promise;
			// A forced request only needs another pass when an in-flight normal
			// lookup returned the exact token that the API already rejected.
			if (
				!forceRefresh ||
				inFlight.forceRefresh ||
				(hasRejectedToken && (resolved === null || resolved !== rejectedToken))
			) {
				return resolved;
			}
		}

		const requestedSnapshot = options.state.read();
		const task = options.lock.runExclusive(async () => {
			const current = options.state.read();
			const anotherAttemptCompleted =
				current.attempt !== requestedSnapshot.attempt;

			if (forceRefresh) {
				// A different token means another request or tab already recovered
				// from the rejected credential while this caller was waiting.
				if (
					hasRejectedToken &&
					current.token !== rejectedToken &&
					(current.token === null ||
						(current.lastResolutionSucceeded &&
							(anotherAttemptCompleted || options.isReusable(current))))
				) {
					return current.token;
				}

				// A completed attempt with no new token represents a shared failure.
				// Do not let every waiting tab repeat the same exchange immediately.
				if (anotherAttemptCompleted) {
					return current.lastResolutionSucceeded ? current.token : null;
				}
			} else {
				if (options.isReusable(current)) return current.token;
				if (anotherAttemptCompleted) {
					return current.lastResolutionSucceeded ? current.token : null;
				}
			}

			let resolvedToken: string | null = null;
			try {
				resolvedToken = cleanToken(await options.resolveToken(forceRefresh));
				return resolvedToken;
			} finally {
				// Record every completed attempt so lock waiters can share either its
				// token or failure without invalidating the session generation.
				options.state.commitResolution(resolvedToken, forceRefresh);
			}
		});

		const entry = { forceRefresh, promise: task };
		resolutionInFlight = entry;
		try {
			return await task;
		} finally {
			if (resolutionInFlight === entry) resolutionInFlight = null;
		}
	};

	const clearBrokenSession = async (
		request: ClearBrokenSessionOptions = {},
	): Promise<boolean> =>
		trackMutation(() =>
			options.lock.runExclusive(async () => {
				const current = options.state.read();
				if (!sessionMatches(current, request)) return false;

				try {
					await options.clearSession();
				} finally {
					options.state.clear();
				}
				return true;
			}),
		);

	const runExclusiveMutation = <T>(task: () => Promise<T>): Promise<T> =>
		trackMutation(() => options.lock.runExclusive(task));

	const runGuardedMutation = (
		request: ClearBrokenSessionOptions,
		task: () => Promise<void>,
	): Promise<boolean> =>
		trackMutation(() =>
			options.lock.runExclusive(async () => {
				if (!sessionMatches(options.state.read(), request)) return false;
				await task();
				return true;
			}),
		);

	return {
		resolveToken,
		clearBrokenSession,
		runExclusiveMutation,
		runGuardedMutation,
	};
}
