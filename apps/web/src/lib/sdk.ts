import { type CohubClientOptions, createCohubClient } from "@neta-art/cohub";
import { PUBLIC_API_ORIGIN, PUBLIC_GATEWAY_ORIGIN } from "$env/static/public";
import {
	clearAuthToken,
	getAuthSessionSnapshot,
	getAuthToken as resolveAccessToken,
	setAuthToken,
} from "$lib/auth";
import { getCurrentRedirectPath, redirectToSignIn } from "$lib/auth-redirect";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";

type UnauthorizedContext = Parameters<
	NonNullable<CohubClientOptions["onUnauthorized"]>
>[0];

const handleUnauthorized = async (context: UnauthorizedContext) => {
	if (typeof window === "undefined") return;
	const rejectedSnapshot = getAuthSessionSnapshot();
	const rejectedGeneration =
		typeof context.authSessionVersion === "number"
			? context.authSessionVersion
			: rejectedSnapshot.generation;
	if (rejectedSnapshot.generation !== rejectedGeneration) return;
	if (!context.matchesRejectedToken(rejectedSnapshot.token)) return;
	// Refresh already failed in transport — drop local Logto residue so the
	// next sign-in is a clean round-trip instead of a silent SSO bounce.
	await redirectToSignIn(getCurrentRedirectPath(), {
		clearSession: true,
		expectedGeneration: rejectedGeneration,
		rejectedToken: rejectedSnapshot.token,
	});
};

function shouldInspectBillingResponse(
	input: RequestInfo | URL,
	response: Response,
) {
	if (response.status === 402) return true;
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.pathname
				: input.url;
	return (
		response.status < 300 &&
		/\/api\/(spaces\/[^/]+\/prompt|sessions\/[^/]+\/messages|generations)(?:[?#/]|$)/.test(
			url,
		)
	);
}

const createBillingAwareFetch =
	(fetcher: typeof fetch): typeof fetch =>
	async (input, init) => {
		const response = await fetcher(input, init);
		if (!shouldInspectBillingResponse(input, response)) return response;
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) return response;
		const body = await response
			.clone()
			.json()
			.catch(() => null);
		if (body) billingConversion.handleResponseBody(body);
		return response;
	};

const createWebSdk = (options: Partial<CohubClientOptions> = {}) => {
	const baseFetch = options.fetch ?? fetch;
	return createCohubClient({
		baseUrl: options.baseUrl ?? PUBLIC_API_ORIGIN ?? "",
		getAccessToken: options.getAccessToken ?? resolveAccessToken,
		getAuthSessionVersion:
			options.getAuthSessionVersion ??
			(() => getAuthSessionSnapshot().generation),
		onUnauthorized: options.onUnauthorized ?? handleUnauthorized,
		setStoredAuthToken: options.setStoredAuthToken ?? setAuthToken,
		clearStoredAuthToken: options.clearStoredAuthToken ?? clearAuthToken,
		...options,
		requestSource: options.requestSource ?? { via: "web" },
		fetch: createBillingAwareFetch(baseFetch),
		websocket: {
			url: PUBLIC_GATEWAY_ORIGIN ?? undefined,
			getAccessToken: resolveAccessToken,
			...options.websocket,
		},
		voice: {
			url: PUBLIC_GATEWAY_ORIGIN ?? undefined,
			getAccessToken: resolveAccessToken,
			...options.voice,
		},
	});
};

export const sdk = createWebSdk();
export const createWebClient = createWebSdk;
