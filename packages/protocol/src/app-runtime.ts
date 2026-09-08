export const APP_RUNTIME_PROTOCOL = "cohub.app.runtime";
export const APP_RUNTIME_VERSION = 1;

type RuntimeEnvelope = {
	protocol: typeof APP_RUNTIME_PROTOCOL;
	version: typeof APP_RUNTIME_VERSION;
};

export type AppRuntimeReadyMessage = RuntimeEnvelope & {
	type: "ready";
};

/** The App asks its host to close the surface it runs in. */
export type AppRuntimeCloseRequestMessage = RuntimeEnvelope & {
	type: "close.request";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

export const parseAppRuntimeReady = (
	value: unknown,
): AppRuntimeReadyMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "ready"
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "ready",
	};
};

export const buildAppRuntimeReady = (): AppRuntimeReadyMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "ready",
});

export const parseAppRuntimeCloseRequest = (
	value: unknown,
): AppRuntimeCloseRequestMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "close.request"
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "close.request",
	};
};

export const buildAppRuntimeCloseRequest = (): AppRuntimeCloseRequestMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "close.request",
});
