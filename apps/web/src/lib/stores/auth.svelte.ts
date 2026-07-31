import type { IdTokenClaims } from "@logto/browser";
import { HttpError, type UserProfile } from "@neta-art/cohub";
import {
	clearBrokenAuthSession,
	getAuthToken,
	getCurrentIdTokenClaims,
	hasRecoverableAuthSession,
	setSessionHint,
} from "$lib/auth";
import { sdk } from "$lib/sdk";
import {
	clearCachedMeProfile,
	getCachedMeProfile,
	setCachedMeProfile,
} from "$lib/stores/me-profile-cache";

type RestoredAuthSession = {
	isAuthenticated: boolean;
	claims: IdTokenClaims | null;
	userUuid: string | null;
	legacyUserUuid: string | null;
	profile: UserProfile | null;
	email: string | null;
};

const unauthenticatedSession = (): RestoredAuthSession => ({
	isAuthenticated: false,
	claims: null,
	userUuid: null,
	legacyUserUuid: null,
	profile: null,
	email: null,
});

const restoreAuthSession = async (
	onProfileUpdate?: (session: RestoredAuthSession) => void,
	options?: { refreshInBackground?: boolean },
): Promise<RestoredAuthSession> => {
	if (!(await hasRecoverableAuthSession())) {
		return unauthenticatedSession();
	}

	const token = await getAuthToken();
	if (!token) {
		await clearBrokenAuthSession();
		return unauthenticatedSession();
	}

	const claims = await getCurrentIdTokenClaims();
	const subject = typeof claims?.sub === "string" ? claims.sub : null;
	let userUuid: string | null = null;
	let legacyUserUuid: string | null = null;
	let profile: UserProfile | null = null;
	let email: string | null = null;

	// Session restore must not trigger global sign-in redirects — callers
	// decide whether to prompt login. skipUnauthorizedHandler keeps transport
	// from racing with clearBrokenAuthSession via onUnauthorized.
	const meOptions = { skipUnauthorizedHandler: true as const };

	const cached = getCachedMeProfile(subject);
	if (cached) {
		userUuid = cached.uuid ?? null;
		legacyUserUuid = cached.legacyUserUuid ?? null;
		profile = cached.profile ?? null;
		email = cached.email ?? null;
		const cachedSession = {
			isAuthenticated: true,
			claims,
			userUuid,
			legacyUserUuid,
			profile,
			email,
		};
		onProfileUpdate?.(cachedSession);
		if (options?.refreshInBackground) {
			void sdk.user
				.getMe(meOptions)
				.then((me) => {
					setCachedMeProfile(subject, me);
					onProfileUpdate?.({
						isAuthenticated: true,
						claims,
						userUuid: me.uuid ?? null,
						legacyUserUuid: me.legacyUserUuid ?? null,
						profile: me.profile ?? null,
						email: me.email ?? null,
					});
				})
				.catch((error) => {
					if (error instanceof HttpError && error.status === 401) {
						clearCachedMeProfile(subject);
						console.warn(
							"[auth] Background current user profile refresh was unauthorized; keeping the recoverable auth session.",
						);
						return;
					}
					console.warn("[auth] Failed to refresh current user profile:", error);
				});
			return cachedSession;
		}
	}

	try {
		const me = await sdk.user.getMe(meOptions);
		userUuid = me.uuid ?? null;
		legacyUserUuid = me.legacyUserUuid ?? null;
		profile = me.profile ?? null;
		email = me.email ?? null;
		setCachedMeProfile(subject, me);
	} catch (error) {
		if (error instanceof HttpError && error.status === 401) {
			clearCachedMeProfile(subject);
			await clearBrokenAuthSession();
			return unauthenticatedSession();
		}
		console.warn("[auth] Failed to load current user profile:", error);
	}

	return {
		isAuthenticated: true,
		claims,
		userUuid,
		legacyUserUuid,
		profile,
		email,
	};
};

class AuthStore {
	claims = $state<IdTokenClaims | null>(null);
	isAuthenticated = $state(false);
	loaded = $state(false);
	loading = $state(false);

	// userUuid from backend API (/api/me), used for ownership checks
	// against space.userUuid, session ownership, etc.
	_userUuid = $state<string | null>(null);
	_legacyUserUuid = $state<string | null>(null);
	profile = $state<UserProfile | null>(null);
	email = $state<string | null>(null);

	// Shared promise for in-flight ensureLoaded calls so concurrent callers all wait
	private _loadPromise: Promise<void> | null = null;

	get userUuid(): string | null {
		return this._userUuid;
	}

	get identityKeys(): string[] {
		return [
			...new Set(
				[this._userUuid, this._legacyUserUuid].filter(
					(value): value is string => Boolean(value),
				),
			),
		];
	}

	matchesUserId(userId: string | null | undefined): boolean {
		const normalized = userId?.trim();
		return Boolean(normalized && this.identityKeys.includes(normalized));
	}

	async ensureLoaded(force = false) {
		if (this.loaded && !force) return;
		if (this.loading && this._loadPromise) return this._loadPromise;

		this.loading = true;
		this._loadPromise = (async () => {
			try {
				const applySession = (restored: RestoredAuthSession) => {
					this.isAuthenticated = restored.isAuthenticated;
					this.claims = restored.claims;
					this._userUuid = restored.userUuid;
					this._legacyUserUuid = restored.legacyUserUuid;
					this.profile = restored.profile;
					this.email = restored.email;
					this.loaded = true;
					setSessionHint(restored.isAuthenticated);
				};
				const restored = await restoreAuthSession(applySession, {
					refreshInBackground: !force,
				});
				applySession(restored);
			} finally {
				this.loading = false;
				this._loadPromise = null;
			}
		})();

		return this._loadPromise;
	}

	async updateProfile(input: {
		displayName?: string;
		avatarUrl?: string | null;
		username?: string | null;
	}) {
		const { profile } = await sdk.user.updateProfile(input);
		this.profile = profile;
		if (this._userUuid) {
			setCachedMeProfile(this.claims?.sub, {
				uuid: this._userUuid,
				...(this._legacyUserUuid
					? { legacyUserUuid: this._legacyUserUuid }
					: {}),
				profile,
				email: this.email,
			});
		}
		return profile;
	}

	reset() {
		clearCachedMeProfile(this.claims?.sub);
		setSessionHint(false);
		this.claims = null;
		this.isAuthenticated = false;
		this.loaded = false;
		this.loading = false;
		this._userUuid = null;
		this._legacyUserUuid = null;
		this.profile = null;
		this.email = null;
		this._loadPromise = null;
	}
}

export const authStore = new AuthStore();
