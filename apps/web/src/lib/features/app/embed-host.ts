import {
	type AppNavigationOpenMessage,
	buildAppNavigationOpenResponse,
	parseAppNavigationOpenMessage,
} from "@cohub/protocol/app-navigation";
import type {
	AppDetailResponse,
	AppRuntimeInvocationContext,
	AppRuntimeShellContext,
} from "@neta-art/cohub";
import { buildAppIframeUrl } from "$lib/app-url";
import type { AppBridgeHost, AppBridgeHostConfig } from "./bridge-host.svelte";
import {
	EMBED_LIMIT,
	EMBED_PATH,
	EMBED_TIMEOUT,
	envelope,
	isRuntimeRequest,
	parseEmbed,
	textField,
} from "./embed-protocol";
import { type AppSurfaceHost, createAppSurfaceHost } from "./surface-host";

type NavigationResult = {
	handled: boolean;
	reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
	call?:
		| { ok: true; result?: unknown }
		| { ok: false; code: string; message: string };
};
export type EmbedEntry = {
	id: string;
	detail: AppDetailResponse;
	launch?: { search?: string; hash?: string };
	invocation: AppRuntimeInvocationContext;
	bridge: AppBridgeHost | null;
};
type InternalEntry = EmbedEntry & {
	port: MessagePort | null;
	child: Window | null;
	timer: ReturnType<typeof setTimeout>;
	epoch: number;
	surface: AppSurfaceHost | null;
	pending: Set<string>;
	navigationResults: Map<string, NavigationResult>;
	loaded: boolean;
};
export type EmbedHostConfig = {
	root: Window;
	getContainer: () => Window | null;
	getContainerOrigin: () => string | null;
	parentAppId: string;
	getShell: () => AppRuntimeShellContext | undefined;
	resolveApp: (
		ref: string,
		launch?: { search?: string; hash?: string },
	) => Promise<{
		detail: AppDetailResponse;
		launch?: { search?: string; hash?: string };
	}>;
	canOpen: (appId: string, spaceId: string) => Promise<boolean>;
	createBridge: (config: AppBridgeHostConfig) => AppBridgeHost;
	getCheckoutState: AppBridgeHostConfig["getCheckoutState"];
	onNavigation?: (
		message: AppNavigationOpenMessage,
	) => Promise<NavigationResult>;
	onCloseSelf?: () => void;
	onEntries: (entries: EmbedEntry[]) => void;
	channel?: () => MessageChannel;
	id?: () => string;
};

/** Owns bindings, not layouts. Only an official immediate grandchild may attach. */
export function createEmbedHost(config: EmbedHostConfig) {
	const entries = new Map<string, InternalEntry>();
	const requests = new Map<string, Promise<void>>();
	const seenRequests = new Set<string>();
	const placements = new Map<
		string,
		{
			resolve: (id: string | null) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let generation = 0;
	let disposed = false;
	const publish = () => config.onEntries([...entries.values()]);
	function sendContainer(type: string, data: Record<string, unknown>) {
		const target = config.getContainer(),
			origin = config.getContainerOrigin();
		if (target && origin && !disposed)
			target.postMessage(envelope(type, data), origin);
	}
	function release(id: string) {
		const entry = entries.get(id);
		if (!entry) return;
		entries.delete(id);
		entry.epoch++;
		clearTimeout(entry.timer);
		entry.surface?.dispose();
		entry.bridge?.cancelAuth();
		entry.port?.close();
		entry.pending.clear();
		publish();
		sendContainer("closed", { instanceId: id });
	}
	function reset() {
		generation++;
		for (const id of [...entries.keys()]) release(id);
		requests.clear();
		seenRequests.clear();
		for (const pending of placements.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		placements.clear();
	}
	async function waitForLoaded(
		entry: InternalEntry,
		deadline: number,
		isLive: () => boolean,
	) {
		while (
			isLive() &&
			entries.get(entry.id) === entry &&
			!entry.loaded &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 25));
		return isLive() && entries.get(entry.id) === entry && entry.loaded;
	}
	async function navigate(
		message: AppNavigationOpenMessage,
		isLive: () => boolean,
	): Promise<NavigationResult> {
		// The unchanged App SDK times out after 8s. Stop queuing work before then.
		const deadline = Date.now() + 7_000;
		if (message.target.kind !== "app")
			return (
				(await config.onNavigation?.(message)) ?? {
					handled: false,
					reason: "unsupported",
				}
			);
		const epoch = generation;
		const { detail, launch } = await config.resolveApp(
			message.target.ref,
			message.target.launch,
		);
		if (!isLive()) return { handled: false, reason: "inaccessible" };
		const spaceId = config.getShell()?.space?.id;
		if (
			!spaceId ||
			detail.app.status !== "published" ||
			detail.content?.kind !== "web" ||
			!(await config.canOpen(detail.app.id, spaceId)) ||
			detail.app.id === config.parentAppId
		)
			return !isLive()
				? { handled: false, reason: "inaccessible" }
				: ((await config.onNavigation?.(message)) ?? {
						handled: false,
						reason: "unsupported",
					});
		if (!isLive() || epoch !== generation)
			return { handled: false, reason: "inaccessible" };
		let target = [...entries.values()].find(
			(e) => e.detail.app.id === detail.app.id,
		);
		if (!target) {
			if (placements.size >= EMBED_LIMIT)
				return { handled: false, reason: "unsupported" };
			const requestId = crypto.randomUUID();
			const id = await new Promise<string | null>((resolve) => {
				const timer = setTimeout(
					() => {
						placements.delete(requestId);
						resolve(null);
					},
					Math.max(0, deadline - Date.now()),
				);
				placements.set(requestId, { resolve, timer });
				sendContainer("place", { requestId, ref: detail.app.id, launch });
			});
			target = id ? entries.get(id) : undefined;
			if (
				!target ||
				!isLive() ||
				target.detail.app.id !== detail.app.id ||
				epoch !== generation
			)
				return { handled: false, reason: "timeout" };
		} else if (
			launch &&
			buildAppIframeUrl(detail.content.url, {
				search: launch.search ?? "",
				hash: launch.hash ?? "",
			}) !==
				buildAppIframeUrl(detail.content.url, {
					search: target.launch?.search ?? "",
					hash: target.launch?.hash ?? "",
				})
		) {
			if (!(await waitForLoaded(target, deadline, isLive)))
				return { handled: false, reason: "timeout" };
			target.launch = launch;
			target.loaded = false;
			activateRuntime(target);
			target.port?.postMessage(envelope("launch", { launch }));
		}
		sendContainer("activate", { instanceId: target.id });
		if (!message.call) return { handled: true };
		if (
			!(await waitForLoaded(target, deadline, isLive)) ||
			!target.surface ||
			Date.now() >= deadline
		)
			return { handled: false, reason: "timeout" };
		const result = await target.surface.call({
			method: message.call.method,
			input: message.call.input,
			commandId: message.requestId,
			readyTimeoutMs: Math.max(1, deadline - Date.now()),
			requestTimeoutMs: Math.max(1, deadline - Date.now()),
		});
		return { handled: true, call: result };
	}
	function activateRuntime(entry: InternalEntry) {
		entry.epoch++;
		entry.surface?.dispose();
		entry.bridge?.cancelAuth();
		entry.pending.clear();
		entry.navigationResults.clear();
		const epoch = entry.epoch;
		const isLive = () =>
			!disposed && entries.get(entry.id) === entry && entry.epoch === epoch;
		const post = (data: Record<string, unknown>) => {
			if (isLive()) entry.port?.postMessage(envelope("deliver", { data }));
		};
		const source = {
			postMessage: (data: Record<string, unknown>) => post(data),
		} as unknown as Window;
		const bridge = config.createBridge({
			app: { ...entry.detail.app, spaceName: entry.detail.space?.name ?? null },
			authorizationContext: { surface: "app" },
			getInvocation: () => entry.invocation,
			getShell: config.getShell,
			notify: post,
			reply: (requestId, payload) => {
				entry.pending.delete(requestId);
				post({ requestId, ...payload });
			},
			getCheckoutState: config.getCheckoutState,
		});
		entry.bridge = bridge;
		entry.surface = createAppSurfaceHost({
			getFrame: () => ({ contentWindow: source }) as HTMLIFrameElement,
			getFrameOrigin: () => config.root.location.origin,
			syncContext: (invocation) => {
				if (invocation) entry.invocation = invocation;
				return bridge.notifyContextChanged();
			},
		});
		const surface = entry.surface;
		const port = entry.port;
		if (!port) return;
		port.onmessage = async (event) => {
			if (!isLive()) return;
			const message = parseEmbed(event.data);
			if (!message) return;
			if (message.type === "detach") {
				release(entry.id);
				return;
			}
			if (message.type === "reload") {
				activateRuntime(entry);
				return;
			}
			if (message.type === "ready") {
				await bridge.notifyContextChanged().catch(() => undefined);
				return;
			}
			if (message.type === "loaded" || message.type === "focused") {
				if (message.type === "loaded") entry.loaded = true;
				sendContainer(message.type, { instanceId: entry.id });
				return;
			}
			if (
				message.type !== "runtime" ||
				!message.data ||
				typeof message.data !== "object"
			)
				return;
			const data = message.data as Record<string, unknown>;
			if (
				surface.handleMessage({
					data,
					source,
					origin: config.root.location.origin,
				} as MessageEvent)
			)
				return;
			const navigation = parseAppNavigationOpenMessage(data);
			if (navigation) {
				const previous = entry.navigationResults.get(navigation.requestId);
				if (previous) {
					post(
						buildAppNavigationOpenResponse({
							requestId: navigation.requestId,
							...previous,
						}),
					);
					return;
				}
				if (entry.pending.has(navigation.requestId) || entry.pending.size >= 32)
					return;
				entry.pending.add(navigation.requestId);
				const result = await navigate(navigation, isLive).catch(() => ({
					handled: false as const,
					reason: "inaccessible" as const,
				}));
				if (!isLive()) return;
				entry.pending.delete(navigation.requestId);
				entry.navigationResults.set(navigation.requestId, result);
				if (entry.navigationResults.size > 128) {
					const oldest = entry.navigationResults.keys().next().value;
					if (oldest) entry.navigationResults.delete(oldest);
				}
				post(
					buildAppNavigationOpenResponse({
						requestId: navigation.requestId,
						...(result ?? { handled: false, reason: "unsupported" }),
					}),
				);
				return;
			}
			if (
				!isRuntimeRequest(data) ||
				entry.pending.has(data.requestId as string) ||
				entry.pending.size >= 32
			)
				return;
			entry.pending.add(data.requestId as string);
			await bridge.handleMessage({ data } as MessageEvent).catch(() => {
				entry.pending.delete(data.requestId as string);
				post({
					type: "cohub.app.error",
					requestId: data.requestId,
					message: "App request failed.",
				});
			});
		};
		publish();
	}

	async function prepare(message: Record<string, unknown>, requestId: string) {
		const requestGeneration = generation;
		try {
			const shell = config.getShell();
			if (
				!shell?.space ||
				!textField(message.ref, 2048) ||
				entries.size >= EMBED_LIMIT
			)
				throw new Error("unsupported");
			const launch =
				message.launch && typeof message.launch === "object"
					? (message.launch as { search?: string; hash?: string })
					: undefined;
			if (
				launch &&
				[launch.search, launch.hash].some(
					(value) =>
						value !== undefined &&
						(typeof value !== "string" || value.length > 2048),
				)
			)
				throw new Error("invalid_target");
			const resolved = await config.resolveApp(message.ref, launch);
			const { detail } = resolved;
			if (
				detail.app.id === config.parentAppId ||
				detail.app.status !== "published" ||
				detail.content?.kind !== "web"
			)
				throw new Error("unsupported");
			if (!(await config.canOpen(detail.app.id, shell.space.id)))
				throw new Error("inaccessible");
			if (
				disposed ||
				generation !== requestGeneration ||
				config.getShell()?.space?.id !== shell.space.id
			)
				return;
			if (
				[...entries.values()].some((e) => e.detail.app.id === detail.app.id) ||
				entries.size >= EMBED_LIMIT
			)
				throw new Error("already_open");
			const id = config.id?.() ?? crypto.randomUUID();
			const entry: InternalEntry = {
				id,
				detail,
				launch: resolved.launch,
				invocation: { surface: "app", source: "user", spaceId: shell.space.id },
				bridge: null,
				port: null,
				child: null,
				epoch: 0,
				surface: null,
				pending: new Set(),
				navigationResults: new Map(),
				loaded: false,
				timer: setTimeout(() => release(id), EMBED_TIMEOUT),
			};
			entries.set(id, entry);
			publish();
			const url = new URL(EMBED_PATH, config.root.location.origin);
			url.hash = id;
			sendContainer("prepared", {
				requestId,
				instanceId: id,
				appId: detail.app.id,
				url: url.href,
			});
		} catch (cause) {
			if (!disposed && generation === requestGeneration)
				sendContainer("error", {
					requestId,
					code:
						cause instanceof Error &&
						[
							"unsupported",
							"invalid_target",
							"inaccessible",
							"already_open",
						].includes(cause.message)
							? cause.message
							: "inaccessible",
				});
		}
	}
	function handleMessage(event: MessageEvent) {
		if (disposed) return false;
		const message = parseEmbed(event.data);
		if (!message) return false;
		if (message.type === "attach") {
			const entry = entries.get(message.instanceId ?? "");
			if (
				!entry ||
				entry.child ||
				event.origin !== config.root.location.origin ||
				!event.source
			)
				return true;
			const source = event.source as Window;
			try {
				if (source.parent !== config.getContainer() || source === config.root)
					return true;
				// Same-origin official wrapper only; a different Cohub page cannot
				// claim a binding merely by copying its fragment.
				if (
					source.location.pathname !== EMBED_PATH ||
					source.location.hash !== `#${entry.id}`
				)
					return true;
			} catch {
				return true;
			}
			const channel = config.channel?.() ?? new MessageChannel();
			entry.child = source;
			entry.port = channel.port1;
			clearTimeout(entry.timer);
			activateRuntime(entry);
			try {
				source.postMessage(
					envelope("attached", {
						instanceId: entry.id,
						detail: entry.detail,
						launch: entry.launch,
					}),
					event.origin,
					[channel.port2],
				);
			} catch {
				channel.port2.close();
				release(entry.id);
				return true;
			}
			channel.port1.start();
			return true;
		}
		if (
			event.source !== config.getContainer() ||
			!config.getContainerOrigin() ||
			event.origin !== config.getContainerOrigin()
		)
			return true;
		if (message.type === "hello") {
			sendContainer("capabilities", {
				requestId: message.requestId,
				embed: Boolean(config.getShell()?.space),
				closeSelf: Boolean(config.onCloseSelf),
				maxChildren: EMBED_LIMIT,
			});
			return true;
		}
		if (message.type === "placed" && message.requestId) {
			const pending = placements.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				placements.delete(message.requestId);
				pending.resolve(message.instanceId ?? null);
			}
			return true;
		}
		if (message.type === "release" && message.instanceId) {
			release(message.instanceId);
			return true;
		}
		if (message.type === "close-self") {
			if (config.onCloseSelf) {
				reset();
				config.onCloseSelf();
			}
			return true;
		}
		if (
			message.type === "prepare" &&
			message.requestId &&
			!seenRequests.has(message.requestId) &&
			requests.size < 8
		) {
			const requestId = message.requestId;
			seenRequests.add(requestId);
			if (seenRequests.size > 128) {
				const oldest = seenRequests.values().next().value;
				if (oldest) seenRequests.delete(oldest);
			}
			const pending = prepare(message, requestId);
			requests.set(requestId, pending);
			void pending.finally(() => {
				if (requests.get(requestId) === pending) requests.delete(requestId);
			});
		}
		return true;
	}
	return {
		handleMessage,
		reset,
		release,
		entries: () => [...entries.values()],
		notifyContextChanged: () =>
			Promise.all(
				[...entries.values()].map((e) =>
					e.bridge?.notifyContextChanged().catch(() => undefined),
				),
			),
		dispose: () => {
			reset();
			disposed = true;
		},
	};
}
