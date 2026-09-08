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

/** Whether an App's content is served from the given origin. */
export function isServedFrom(
	content: { url: string } | null | undefined,
	origin: string,
) {
	if (!content) return false;
	try {
		return new URL(content.url).origin === origin;
	} catch {
		return false;
	}
}

/**
 * Connects a public App page to the App embedding it. Hints received here are
 * navigation context only; identity, grants, and tokens stay in the local
 * runtime bridge and never cross this channel.
 *
 * Either side may come up first: this page asks to be attached, and the
 * embedder also announces itself on attach and on every frame load.
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

	return {
		requestClose() {
			if (state) post(buildAppEmbedCloseRequest(state.embedId));
		},
		dispose() {
			window.removeEventListener("message", receive);
		},
	};
}
