import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import { parseAppNavigationOpenResponse } from "@cohub/protocol/app-navigation";
import { parseAppSurfaceReady } from "@cohub/protocol/app-surface";
import type { AppBridgeHost, AppBridgeHostConfig } from "./bridge-host.svelte";
import { EMBED_TIMEOUT, envelope, parseEmbed } from "./embed-protocol";

/** Only instantiated by the official wrapper after a verified root handshake. */
export function createEmbedClient(
	port: MessagePort,
	onLaunch?: (launch: { search?: string; hash?: string }) => void,
) {
	let bridgeConfig: AppBridgeHostConfig | null = null;
	let disposed = false;
	let loadedOnce = false;
	let controlledLoad = false;
	let earlySurfaceReady: Record<string, unknown> | null = null;
	const navigation = new Map<
		string,
		{
			resolve: (value: {
				handled: boolean;
				reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
				call?: import("@cohub/protocol/app-navigation").AppNavigationOpenResponse["call"];
			}) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const post = (type: string, data: Record<string, unknown> = {}) => {
		if (!disposed) port.postMessage(envelope(type, data));
	};
	port.onmessage = (event) => {
		if (disposed) return;
		const message = parseEmbed(event.data);
		if (
			message?.type === "launch" &&
			message.launch &&
			typeof message.launch === "object"
		) {
			controlledLoad = true;
			onLaunch?.(message.launch as { search?: string; hash?: string });
			return;
		}
		if (
			message?.type !== "deliver" ||
			!message.data ||
			typeof message.data !== "object"
		)
			return;
		const data = message.data as Record<string, unknown>;
		const result = parseAppNavigationOpenResponse(data);
		if (result) {
			const pending = navigation.get(result.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				navigation.delete(result.requestId);
				pending.resolve(result);
			}
			return;
		}
		if (typeof data.requestId === "string")
			bridgeConfig?.reply(data.requestId, data);
		else bridgeConfig?.notify?.(data);
	};
	port.start();
	return {
		createBridge(config: AppBridgeHostConfig): AppBridgeHost {
			bridgeConfig = config;
			return {
				authOpen: false,
				pendingAuth: null,
				authError: null,
				authSaving: false,
				handleMessage: async (event) => {
					// An unchanged legacy App may announce methods before iframe load.
					if (parseAppSurfaceReady(event.data)) earlySurfaceReady = event.data;
					post("runtime", { data: event.data });
				},
				notifyContextChanged: async () => {
					post("ready");
				},
				confirmAuth: async () => {},
				cancelAuth: () => {},
			};
		},
		loaded() {
			if (loadedOnce && !controlledLoad) {
				post("reload");
				if (earlySurfaceReady) post("runtime", { data: earlySurfaceReady });
			}
			earlySurfaceReady = null;
			loadedOnce = true;
			controlledLoad = false;
			post("loaded");
			post("ready");
		},
		focused() {
			post("focused");
		},
		open(message: AppNavigationOpenMessage) {
			return new Promise<{
				handled: boolean;
				reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
				call?: import("@cohub/protocol/app-navigation").AppNavigationOpenResponse["call"];
			}>((resolve) => {
				if (disposed || navigation.size >= 32) {
					resolve({ handled: false, reason: "unsupported" });
					return;
				}
				const timer = setTimeout(() => {
					navigation.delete(message.requestId);
					resolve({ handled: false, reason: "timeout" });
				}, EMBED_TIMEOUT);
				navigation.set(message.requestId, { resolve, timer });
				post("runtime", { data: message });
			});
		},
		dispose() {
			if (disposed) return;
			post("detach");
			disposed = true;
			bridgeConfig = null;
			port.close();
			for (const pending of navigation.values()) {
				clearTimeout(pending.timer);
				pending.resolve({ handled: false, reason: "unsupported" });
			}
			navigation.clear();
		},
	};
}
