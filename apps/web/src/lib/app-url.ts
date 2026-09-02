export type AppLaunchState = {
	search: string;
	hash: string;
};

export type CohubAppUrl = AppLaunchState & {
	username: string;
	spaceSlug: string;
	appSlug: string;
};

function isReservedAppParam(name: string) {
	return name.toLowerCase().startsWith("cohub_");
}

export function buildAppIframeUrl(
	contentUrl: string,
	launchState: AppLaunchState | null | undefined,
) {
	if (!launchState) return contentUrl;

	const launchParams = Array.from(
		new URLSearchParams(launchState.search).entries(),
	).filter(([name]) => !isReservedAppParam(name));
	if (launchParams.length === 0 && !launchState.hash) return contentUrl;

	let url: URL;
	try {
		url = new URL(contentUrl);
	} catch {
		return contentUrl;
	}

	for (const name of new Set(launchParams.map(([name]) => name))) {
		url.searchParams.delete(name);
	}
	for (const [name, value] of launchParams) {
		url.searchParams.append(name, value);
	}
	if (launchState.hash) url.hash = launchState.hash;
	return url.href;
}

const PORT_FRAME_DOMAINS = ["cohub.live", "cohub.run"] as const;

function isAllowedPortFrameOrigin(origin: URL) {
	return PORT_FRAME_DOMAINS.some(
		(domain) =>
			origin.hostname === domain || origin.hostname.endsWith(`.${domain}`),
	);
}

/** Resolve one canonical iframe URL and its validated origin for host setup. */
export function resolveAppFrame(input: {
	contentUrl: string;
	launchState?: AppLaunchState | null;
	baseHref: string;
	targetType: string;
}) {
	const urlValue = buildAppIframeUrl(input.contentUrl, input.launchState);
	if (!urlValue) return null;

	try {
		const base = new URL(input.baseHref);
		const url = new URL(urlValue, base);
		if (url.origin !== base.origin && url.protocol !== "https:") return null;
		if (input.targetType === "port" && !isAllowedPortFrameOrigin(url)) {
			return null;
		}
		return { url: url.href, origin: url.origin };
	} catch {
		return null;
	}
}

export function getAppFramePreconnectOrigin(input: {
	contentUrl: string | null | undefined;
	baseHref: string;
	targetType: string;
}) {
	if (!input.contentUrl) return null;
	try {
		const base = new URL(input.baseHref);
		const frame = resolveAppFrame({
			contentUrl: input.contentUrl,
			baseHref: base.href,
			targetType: input.targetType,
		});
		if (!frame || frame.origin === base.origin) return null;
		return frame.origin;
	} catch {
		return null;
	}
}

function isSameCohubOrigin(url: URL, base: URL) {
	return url.origin === base.origin;
}

export function parseCohubAppUrl(
	value: string,
	baseHref: string,
): CohubAppUrl | null {
	let url: URL;
	let base: URL;
	try {
		base = new URL(baseHref);
		url = new URL(value, base);
	} catch {
		return null;
	}
	if (!isSameCohubOrigin(url, base)) return null;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length !== 4 || segments[2] !== "w") return null;
	const [username, spaceSlug, , appSlug] = segments;
	if (!username || !spaceSlug || !appSlug) return null;
	try {
		return {
			username: decodeURIComponent(username),
			spaceSlug: decodeURIComponent(spaceSlug),
			appSlug: decodeURIComponent(appSlug),
			search: url.search,
			hash: url.hash,
		};
	} catch {
		return null;
	}
}
