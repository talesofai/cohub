import {
	type BoardItem,
	boardImageKeySource,
	featuredTaskArtifact,
	imageAssetKey,
	taskArtifactPreviewUrl,
} from "@neta-art/cohub/board";
import { Assets, Texture } from "pixi.js";
import {
	DEFAULT_LRU_BUDGET,
	type LruBudget,
	type LruEntry,
	selectLruEvictions,
} from "$lib/board/board-asset-lru";
import {
	loadVideoThumbnailTexture,
	videoTextureNaturalSize,
} from "$lib/board/board-video-thumbnail";

type BoardAssetMedia = "image" | "video";
type BoardAssetSource = {
	kind: "file" | "url";
	media: BoardAssetMedia;
	value: string;
};

/** Stable preview key shared by cards that reference the same file version. */
export function boardAssetKey(item: BoardItem): string | null {
	if (item.type === "task") {
		const artifact = featuredTaskArtifact(item.snapshot.artifacts);
		if (artifact?.type === "video" && !artifact.previewUrl) {
			return `video-url:${encodeURIComponent(artifact.url)}`;
		}
		const previewUrl = taskArtifactPreviewUrl(artifact);
		return previewUrl ? `url:${previewUrl}` : null;
	}
	if (item.type === "image" && item.snapshot?.mtimeMs !== undefined) {
		const path = encodeURIComponent(item.ref.path);
		return `image:${path}:${Math.trunc(item.snapshot.mtimeMs)}`;
	}
	if (item.type === "video") {
		const path = encodeURIComponent(item.ref.path);
		const version =
			item.snapshot?.mtimeMs === undefined
				? "unknown"
				: Math.trunc(item.snapshot.mtimeMs);
		return `video:${path}:${version}`;
	}
	return imageAssetKey(item);
}

function keySource(key: string): BoardAssetSource | null {
	let baseKey = key;
	if (key.startsWith("local:")) {
		const separator = key.indexOf(":", 6);
		if (separator < 0) return null;
		baseKey = key.slice(separator + 1);
	}
	if (baseKey.startsWith("video-url:")) {
		try {
			return {
				kind: "url",
				media: "video",
				value: decodeURIComponent(baseKey.slice(10)),
			};
		} catch {
			return null;
		}
	}
	if (baseKey.startsWith("image:")) {
		const separator = baseKey.lastIndexOf(":");
		if (separator <= 6) return null;
		try {
			return {
				kind: "file",
				media: "image",
				value: decodeURIComponent(baseKey.slice(6, separator)),
			};
		} catch {
			return null;
		}
	}
	if (baseKey.startsWith("video:")) {
		const separator = baseKey.lastIndexOf(":");
		if (separator <= 6) return null;
		try {
			return {
				kind: "file",
				media: "video",
				value: decodeURIComponent(baseKey.slice(6, separator)),
			};
		} catch {
			return null;
		}
	}
	const image = boardImageKeySource(baseKey);
	return image ? { ...image, media: "image" } : null;
}

type Entry = {
	url: string | null;
	texture: Texture | null;
	refs: number;
	loading: boolean;
	error: boolean;
	attempts: number;
	retryAt: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	/** Last time this preview was wanted (acquired or requested); drives LRU. */
	lastUsedAt: number;
};

export type BoardAssetManager = {
	assetKey: (item: BoardItem) => string | null;
	invalidatePath: (path: string) => void;
	requestItem: (item: BoardItem) => void;
	getTexture: (key: string) => Texture | null;
	getNaturalSize: (key: string) => { width: number; height: number } | null;
	hasError: (key: string) => boolean;
	acquire: (key: string) => void;
	release: (key: string) => void;
	/**
	 * Load every preview for `items`, then run `use` while the references are still
	 * held, releasing them only once it settles.
	 *
	 * Scoped as a callback rather than returning the map: releasing a reference can
	 * evict immediately when the cooling pool is over budget, so a returned map
	 * could hand the caller an already-destroyed texture. Holding the refs across
	 * the callback makes that impossible to get wrong.
	 *
	 * Export needs this: the editor only loads what is near the viewport, so
	 * without it an exported board would show placeholders for everything
	 * off-screen.
	 */
	withTextures: <T>(
		items: BoardItem[],
		use: (textures: Map<string, Texture>) => T | Promise<T>,
		options?: { timeoutMs?: number },
	) => Promise<T>;
	subscribe: (listener: () => void) => () => void;
	destroy: () => void;
};

const MAX_RETRY_DELAY = 30_000;

/** Load an image in the page's CORS context when Pixi's worker path fails. */
function loadImageElementTexture(url: string): Promise<Texture> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.onload = () => {
			try {
				resolve(Texture.from(image));
			} catch (error) {
				reject(error);
			}
		};
		image.onerror = () =>
			reject(new Error(`Failed to load board image: ${url}`));
		image.src = url;
	});
}

/**
 * Keep Pixi's worker/ImageBitmap fast path, but recover through an anonymous
 * image element when that browser context rejects a cross-origin cover.
 */
async function loadImageTexture(url: string): Promise<Texture> {
	try {
		return await Assets.load<Texture>(url);
	} catch (workerError) {
		try {
			return await loadImageElementTexture(url);
		} catch (imageError) {
			throw new AggregateError(
				[workerError, imageError],
				`Failed to load board image: ${url}`,
			);
		}
	}
}

/** Approximate GPU footprint of a texture (RGBA8). Unknown sizes count as 0. */
function footprintOf(texture: Texture | null): number {
	if (!texture) return 0;
	const width = texture.width || 0;
	const height = texture.height || 0;
	return width * height * 4;
}

/**
 * Default space-file URL resolver. The SDK-backed resolver is imported lazily so
 * this module has no static dependency on the SDK / SvelteKit runtime — keeping
 * it importable in plain node tests (remote URLs never trigger this path).
 */
async function defaultResolveSpaceFileUrl(
	spaceId: string,
	path: string,
): Promise<string | null> {
	const { resolveSpaceFileImageUrl } = await import(
		"$lib/board/board-image-urls"
	);
	return resolveSpaceFileImageUrl(spaceId, path);
}

export type BoardAssetManagerOptions = {
	spaceId: string;
	concurrency?: number;
	videoConcurrency?: number;
	/** Disable client-side video-frame decoding on data-saving connections. */
	loadVideoPreviews?: boolean;
	/** Cooling-pool ceiling for unreferenced textures kept on the GPU. */
	lruBudget?: LruBudget;
	/** Injectable preview loader. Images use Pixi with an HTML image fallback; videos decode one frame. */
	loadTexture?: (
		url: string,
		media: BoardAssetMedia,
	) => Promise<Texture | null>;
	/**
	 * Frees a texture. Must resolve once the texture is truly gone, so a pending
	 * unload of a URL can be awaited before that URL is loaded again (otherwise a
	 * quick pan-back could re-acquire a texture that is still being unloaded and
	 * is about to be destroyed). Defaults to clearing Pixi's cache and disposing
	 * any fallback texture owned by the Board.
	 */
	unloadTexture?: (
		url: string,
		texture: Texture | null,
		media: BoardAssetMedia,
	) => Promise<void>;
	/**
	 * Resolves a displayable URL for a space-file media asset. Injected so the manager
	 * has no static dependency on the SDK (and thus SvelteKit runtime), keeping
	 * it unit-testable. Defaults to the CDN/base64 resolver.
	 */
	resolveSpaceFileUrl?: (
		spaceId: string,
		path: string,
	) => Promise<string | null>;
	/** Injectable clock for tests. */
	now?: () => number;
};

/**
 * Single owner of board previews: URL resolution, image loading, video-frame
 * decoding, reference counting, bounded concurrency, retry backoff, and an LRU
 * cooling pool for off-screen textures.
 *
 * Reference model: `refs` counts how many visible cards display a preview.
 * When the last reference is released the texture is not freed immediately —
 * it stays on the GPU in a cooling pool so a quick pan back is instant. The
 * pool is bounded (count + bytes); the least recently used entries are evicted
 * first when a budget is exceeded. This balances GPU retention against the
 * churn of re-fetching textures while panning.
 *
 * Lifecycle invariants:
 * - An entry is never deleted while its request is in flight; `release` only
 *   drops `refs` to zero and the settle step cools or reclaims it. This
 *   prevents a detached-entry race where a late load writes into an orphaned
 *   entry while a fresh entry for the same key stays blank.
 * - On settle we verify the entry is still the one in the map; an orphaned
 *   result is unloaded rather than leaked.
 * - On failure with live references a timer re-enqueues the load after the
 *   backoff elapses, so a failed preview recovers even on a static board.
 *
 * Ownership scope: Pixi owns fast-path images in its `Assets` cache; fallback
 * images and generated video previews are owned directly by this manager. All are
 * reference-counted per mounted board. If multiple stages ever share URLs, image
 * ownership must move to an app-level reference count.
 */
export function createBoardAssetManager(
	options: BoardAssetManagerOptions,
): BoardAssetManager {
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const videoConcurrency = Math.max(
		1,
		Math.min(options.videoConcurrency ?? 2, concurrency),
	);
	const budget = options.lruBudget ?? DEFAULT_LRU_BUDGET;
	const now = options.now ?? (() => Date.now());
	const loadTexture =
		options.loadTexture ??
		((url, media) =>
			media === "video"
				? loadVideoThumbnailTexture(url)
				: loadImageTexture(url));
	// In-flight unloads keyed by URL. A load of the same URL awaits any pending
	// unload first, closing the race where a re-requested texture is created while
	// the previous texture for the same URL is still being destroyed.
	const pendingUnloads = new Map<string, Promise<void>>();
	const unloadTexture =
		options.unloadTexture ??
		(async (url, texture, media) => {
			if (media === "video" || !url) {
				texture?.destroy(true);
				return;
			}
			await Assets.unload(url).catch(() => {});
			if (!texture?.destroyed) texture?.destroy(true);
		});
	/** Release a texture and serialize a reload against its asynchronous unload. */
	function releaseTexture(key: string, url: string, texture: Texture | null) {
		const media = keySource(key)?.media ?? "image";
		const pendingKey = `${media}:${url}`;
		const promise = unloadTexture(url, texture, media)
			.catch(() => {})
			.then(() => {
				if (url && pendingUnloads.get(pendingKey) === promise)
					pendingUnloads.delete(pendingKey);
			});
		if (url) pendingUnloads.set(pendingKey, promise);
	}
	const resolveSpaceFileUrl =
		options.resolveSpaceFileUrl ?? defaultResolveSpaceFileUrl;

	const entries = new Map<string, Entry>();
	const pathVersions = new Map<string, number>();
	const resolvers = new Map<string, () => Promise<string | null>>();
	const inflight = new Set<string>();
	const queue: Array<{ key: string; getUrl: () => Promise<string | null> }> =
		[];
	const listeners = new Set<() => void>();
	let active = 0;
	let activeVideos = 0;
	let disposed = false;

	function notify() {
		for (const listener of listeners) listener();
	}

	function managedAssetKey(item: BoardItem): string | null {
		const key = boardAssetKey(item);
		if (!key) return null;
		const source = keySource(key);
		if (source?.media === "video" && options.loadVideoPreviews === false)
			return null;
		if (source?.kind !== "file") return key;
		const version = pathVersions.get(source.value) ?? 0;
		return version > 0 ? `local:${version}:${key}` : key;
	}

	function clearRetry(entry: Entry) {
		if (entry.retryTimer) {
			clearTimeout(entry.retryTimer);
			entry.retryTimer = null;
		}
	}

	function ensureEntry(key: string): Entry {
		let entry = entries.get(key);
		if (!entry) {
			entry = {
				url: null,
				texture: null,
				refs: 0,
				loading: false,
				error: false,
				attempts: 0,
				retryAt: 0,
				retryTimer: null,
				lastUsedAt: now(),
			};
			entries.set(key, entry);
		}
		return entry;
	}

	/** Re-enqueue a failed entry once its backoff has elapsed. */
	function scheduleRetry(key: string, entry: Entry) {
		clearRetry(entry);
		const delay = Math.max(0, entry.retryAt - now());
		entry.retryTimer = setTimeout(() => {
			entry.retryTimer = null;
			if (disposed || entries.get(key) !== entry) return;
			if (entry.refs <= 0 || entry.texture || entry.loading) return;
			const getUrl = resolvers.get(key);
			if (!getUrl) return;
			entry.error = false;
			if (!queue.some((task) => task.key === key)) {
				queue.push({ key, getUrl });
				pump();
			}
		}, delay);
	}

	function evict(key: string, entry: Entry) {
		clearRetry(entry);
		resolvers.delete(key);
		if (entry.url || entry.texture)
			releaseTexture(key, entry.url ?? "", entry.texture);
		entries.delete(key);
	}

	/**
	 * Drop unreferenced, loaded textures that exceed the cooling budget. Entries
	 * still in flight are untouched (the settle step cools them once they land).
	 */
	function trim() {
		const cooling: LruEntry[] = [];
		for (const [key, entry] of entries) {
			if (entry.refs <= 0 && entry.texture && !entry.loading)
				cooling.push({
					key,
					lastUsedAt: entry.lastUsedAt,
					bytes: footprintOf(entry.texture),
				});
		}
		const evictions = selectLruEvictions(cooling, budget);
		for (const key of evictions) {
			const entry = entries.get(key);
			if (entry) evict(key, entry);
		}
	}

	function settle(
		key: string,
		entry: Entry,
		texture: Texture | null,
		error?: unknown,
	) {
		entry.loading = false;
		inflight.delete(key);
		active -= 1;
		if (keySource(key)?.media === "video") activeVideos -= 1;
		// Orphaned: the entry was replaced while loading. Discard the result.
		if (entries.get(key) !== entry) {
			if (texture) releaseTexture(key, entry.url ?? "", texture);
			if (!disposed) pump();
			return;
		}
		if (texture) {
			entry.error = false;
			entry.attempts = 0;
			entry.texture = texture;
			entry.lastUsedAt = now();
			// No live reference: keep it in the cooling pool (bounded by trim)
			// rather than freeing immediately, so a quick pan back is instant.
			if (entry.refs <= 0) trim();
			else notify();
		} else {
			entry.error = true;
			entry.attempts += 1;
			entry.retryAt =
				now() + Math.min(1000 * 2 ** entry.attempts, MAX_RETRY_DELAY);
			console.warn(`[board] failed to load preview for ${key}`, error);
			if (entry.refs <= 0) evict(key, entry);
			else {
				scheduleRetry(key, entry);
				notify();
			}
		}
		if (!disposed) pump();
	}

	function pump() {
		while (!disposed && active < concurrency && queue.length > 0) {
			const taskIndex = queue.findIndex(({ key }) => {
				const source = keySource(key);
				return source?.media !== "video" || activeVideos < videoConcurrency;
			});
			if (taskIndex < 0) return;
			const [task] = queue.splice(taskIndex, 1);
			if (!task) continue;
			const entry = entries.get(task.key);
			const source = keySource(task.key);
			if (!entry || !source || entry.texture || entry.loading) continue;
			entry.loading = true;
			inflight.add(task.key);
			active += 1;
			if (source.media === "video") activeVideos += 1;
			task
				.getUrl()
				.then(async (url) => {
					if (!url || disposed) return null;
					entry.url = url;
					// Wait for any in-flight unload of this URL so we never load a
					// texture the shared cache is about to destroy.
					const pendingKey = `${source.media}:${url}`;
					const pending = pendingUnloads.get(pendingKey);
					if (pending) await pending;
					if (disposed) return null;
					return loadTexture(url, source.media);
				})
				.then(
					(texture) => settle(task.key, entry, texture ?? null),
					(error) => settle(task.key, entry, null, error),
				);
		}
	}

	const manager: BoardAssetManager = {
		assetKey: managedAssetKey,
		invalidatePath(path) {
			if (disposed) return;
			const cached = [...entries.keys()].some((key) => {
				const source = keySource(key);
				return source?.kind === "file" && source.value === path;
			});
			if (!cached) return;
			pathVersions.set(path, (pathVersions.get(path) ?? 0) + 1);
			notify();
		},
		requestItem(item) {
			if (disposed) return;
			const key = managedAssetKey(item);
			if (!key) return;
			const source = keySource(key);
			if (!source) return;
			const entry = ensureEntry(key);
			entry.lastUsedAt = now();
			if (entry.texture || entry.loading) return;
			// Honour backoff after a failure.
			if (entry.error && now() < entry.retryAt) return;
			entry.error = false;
			clearRetry(entry);
			if (queue.some((queued) => queued.key === key)) return;
			// A remote cover is already a displayable URL; a space file has to be
			// resolved to one first.
			const getUrl =
				source.kind === "url"
					? () => Promise.resolve(source.value)
					: () => resolveSpaceFileUrl(options.spaceId, source.value);
			resolvers.set(key, getUrl);
			queue.push({ key, getUrl });
			pump();
		},
		getTexture(key) {
			const entry = entries.get(key);
			if (!entry?.texture) return null;
			entry.lastUsedAt = now();
			return entry.texture;
		},
		getNaturalSize(key) {
			const texture = manager.getTexture(key);
			if (!texture) return null;
			return (
				videoTextureNaturalSize(texture) ?? {
					width: texture.width,
					height: texture.height,
				}
			);
		},
		hasError(key) {
			return entries.get(key)?.error ?? false;
		},
		acquire(key) {
			const entry = ensureEntry(key);
			entry.refs += 1;
			entry.lastUsedAt = now();
		},
		release(key) {
			const entry = entries.get(key);
			if (!entry) return;
			entry.refs -= 1;
			if (entry.refs > 0) return;
			entry.lastUsedAt = now();
			// Nothing references this preview any more: stop any pending retry.
			clearRetry(entry);
			// Keep an in-flight entry alive until it settles; the settle step
			// cools or reclaims it. This avoids the detached-entry race.
			if (entry.loading) return;
			// A failed entry with no texture and no references is reclaimed now;
			// a loaded one stays in the cooling pool until the budget says evict.
			if (!entry.texture) evict(key, entry);
			else trim();
		},
		async withTextures(items, use, loadOptions) {
			const keys = new Set<string>();
			if (!disposed) {
				for (const item of items) {
					const key = managedAssetKey(item);
					if (key) keys.add(key);
				}
			}
			const textures = new Map<string, Texture>();
			if (keys.size === 0) return use(textures);

			for (const key of keys) manager.acquire(key);
			try {
				for (const item of items) manager.requestItem(item);
				const settled = () =>
					[...keys].every((key) => {
						const entry = entries.get(key);
						return Boolean(entry?.texture) || Boolean(entry?.error);
					});
				if (!settled()) {
					// A cap keeps a wedged preview from hanging the export; whatever has
					// arrived by then is used and the rest draw as placeholders.
					const timeoutMs = loadOptions?.timeoutMs ?? 15_000;
					await new Promise<void>((resolve) => {
						const timer = setTimeout(finish, timeoutMs);
						const unsubscribe = manager.subscribe(() => {
							if (settled()) finish();
						});
						function finish() {
							clearTimeout(timer);
							unsubscribe();
							resolve();
						}
					});
				}
				for (const key of keys) {
					const texture = entries.get(key)?.texture;
					if (texture) textures.set(key, texture);
				}
				return await use(textures);
			} finally {
				for (const key of keys) manager.release(key);
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		destroy() {
			disposed = true;
			queue.length = 0;
			listeners.clear();
			pathVersions.clear();
			resolvers.clear();
			for (const [key, entry] of entries) evict(key, entry);
			entries.clear();
		},
	};

	return manager;
}
