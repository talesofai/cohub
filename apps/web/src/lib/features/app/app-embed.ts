import {
	type AppEmbedShell,
	buildAppEmbedAttachRequest,
	buildAppEmbedCloseRequest,
	parseAppEmbedAttach,
	parseAppEmbedShellChanged,
} from "@cohub/protocol/app-embed";

export type AppEmbedState = {
	embedId: string;
	embedder: { appId: string };
	shell: AppEmbedShell | null;
};

export type AppEmbedConnection = {
	/** Relays the embedded App's close intent to the embedder. */
	requestClose: () => void;
	dispose: () => void;
};

const ATTACH_RETRY_MS = 1_000;
const ATTACH_DEADLINE_MS = 8_000;

/**
 * The origin of the direct parent frame, when this page is embedded.
 * `ancestorOrigins[0]` is the nearest ancestor; `referrer` is the fallback for
 * browsers without it. Nested embeds therefore talk to their own embedder.
 */
export function resolveEmbedderOrigin(): string | null {
	if (typeof window === "undefined" || window.parent === window) return null;
	try {
		return new URL(window.location.ancestorOrigins?.[0] || document.referrer)
			.origin;
	} catch {
		return null;
	}
}

/**
 * Connects a public App page to the App embedding it. Hints received here are
 * navigation context only; identity, grants, and tokens stay in the local
 * runtime bridge and never cross this channel.
 */
export function connectAppEmbed(
	origin: string,
	onState: (state: AppEmbedState) => void,
): AppEmbedConnection {
	let state: AppEmbedState | null = null;
	const post = (message: Record<string, unknown>) =>
		window.parent.postMessage(message, origin);

	const receive = (event: MessageEvent) => {
		if (event.source !== window.parent || event.origin !== origin) return;
		const attach = parseAppEmbedAttach(event.data);
		if (attach) {
			clearInterval(retry);
			state = {
				embedId: attach.embedId,
				embedder: attach.embedder,
				shell: attach.shell,
			};
			onState(state);
			return;
		}
		const changed = parseAppEmbedShellChanged(event.data);
		if (changed && state && changed.embedId === state.embedId) {
			state = { ...state, shell: changed.shell };
			onState(state);
		}
	};

	window.addEventListener("message", receive);
	post(buildAppEmbedAttachRequest());
	const retry = setInterval(
		() => post(buildAppEmbedAttachRequest()),
		ATTACH_RETRY_MS,
	);
	const deadline = setTimeout(() => clearInterval(retry), ATTACH_DEADLINE_MS);

	return {
		requestClose() {
			if (state) post(buildAppEmbedCloseRequest(state.embedId));
		},
		dispose() {
			clearInterval(retry);
			clearTimeout(deadline);
			window.removeEventListener("message", receive);
		},
	};
}
