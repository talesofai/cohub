import { isUuid } from "@cohub/protocol/identifiers";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import { isAllowedAppOrigin } from "./app-origin-allowlist";

/** Web-only navigation hints. This channel never carries identity or grants. */
export const DESKTOP_CONTEXT_PROTOCOL = "cohub.desktop.context";
export const DESKTOP_CLOSE_PROTOCOL = "cohub.desktop.close";

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isDesktopCloseRequest(value: unknown) {
	return (
		record(value) &&
		value.protocol === DESKTOP_CLOSE_PROTOCOL &&
		value.version === 1 &&
		value.type === "request"
	);
}

export function parseDesktopContext(
	value: unknown,
): AppRuntimeShellContext | null {
	if (
		!record(value) ||
		value.protocol !== DESKTOP_CONTEXT_PROTOCOL ||
		value.version !== 1 ||
		value.type !== "snapshot" ||
		!record(value.shell)
	)
		return null;
	const { space, session, turn } = value.shell;
	if (
		space !== null &&
		(!record(space) || typeof space.id !== "string" || !isUuid(space.id))
	)
		return null;
	if (
		session !== null &&
		(!record(session) || typeof session.id !== "string" || !isUuid(session.id))
	)
		return null;
	if (
		turn !== null &&
		(!record(turn) || typeof turn.id !== "string" || !isUuid(turn.id))
	)
		return null;
	if ((!space && (session || turn)) || (!session && turn)) return null;
	if (
		space &&
		space.name != null &&
		(typeof space.name !== "string" || space.name.length > 256)
	)
		return null;
	return {
		surface: "workspace",
		space: space
			? {
					id: space.id as string,
					name: typeof space.name === "string" ? space.name : null,
				}
			: null,
		session: session ? { id: session.id as string } : null,
		turn: turn ? { id: turn.id as string } : null,
	};
}

/** Called only by an explicitly embedded public App page. */
export function subscribeDesktopContext(
	onContext: (shell: AppRuntimeShellContext) => void,
) {
	if (window.parent === window) return () => {};
	let origin: string;
	try {
		origin = new URL(window.location.ancestorOrigins?.[0] || document.referrer)
			.origin;
	} catch {
		return () => {};
	}
	if (!isAllowedAppOrigin(origin)) return () => {};
	let previous = "";
	let retry: ReturnType<typeof setInterval> | undefined;
	const request = () =>
		window.parent.postMessage(
			{ protocol: DESKTOP_CONTEXT_PROTOCOL, version: 1, type: "request" },
			origin,
		);
	const receive = (event: MessageEvent) => {
		if (event.source !== window.parent || event.origin !== origin) return;
		const shell = parseDesktopContext(event.data);
		if (!shell) return;
		clearInterval(retry);
		const next = JSON.stringify(shell);
		if (next === previous) return;
		previous = next;
		onContext(shell);
	};
	window.addEventListener("message", receive);
	request();
	retry = setInterval(request, 1_000);
	const deadline = setTimeout(() => clearInterval(retry), 8_000);
	return () => {
		clearInterval(retry);
		clearTimeout(deadline);
		window.removeEventListener("message", receive);
	};
}
