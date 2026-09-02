<script lang="ts">
import {
	mount as mountComponent,
	onDestroy,
	onMount,
	unmount as unmountComponent,
} from "svelte";
import { mediaLightbox } from "$lib/components/media-lightbox.svelte";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import {
	createWorkspaceAssetLoader,
	type ResolveWorkspaceAsset,
} from "$lib/workspace-assets";
import {
	normalizeWorkspaceFileLinkTarget,
	type WorkspaceFileLinkTarget,
} from "$lib/workspace-file-links";

type MarkdownVariant = "chat" | "document";

type Props = {
	stableHtml: string;
	tailHtml: string;
	variant?: MarkdownVariant;
	streamingLive?: boolean;
	baseFilePath?: string | null;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
};

const {
	stableHtml,
	tailHtml,
	variant = "chat",
	streamingLive = false,
	baseFilePath = null,
	onOpenFile,
	onOpenUrl,
	resolveWorkspaceAsset,
}: Props = $props();

let markdownEl = $state<HTMLElement | null>(null);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let themeObserver: MutationObserver | null = null;
let workspaceAssetRun = 0;

const mountedAudioPlayers: {
	mount: HTMLElement;
	instance: ReturnType<typeof mountComponent>;
}[] = [];

const COPY_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const CHECK_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

$effect(() => {
	const _stableHtml = stableHtml;
	const _streamingLive = streamingLive;
	if (!markdownEl) return;
	// Sweep even while streaming: {@html} can drop mounted players when the
	// stable region is cleared, and Svelte won't dispose those instances.
	sweepDisconnectedAudioPlayers();
	if (_streamingLive) return;
	enhanceCodeBlocks();
	renderMermaid();
	enhanceAudioPlayers();
});

$effect(() => {
	stableHtml;
	const root = markdownEl;
	const resolve = resolveWorkspaceAsset;
	if (!root || !resolve) return;

	const run = ++workspaceAssetRun;
	const controller = new AbortController();
	const elements = Array.from(
		root.querySelectorAll<HTMLElement>(
			"[data-workspace-asset-src], [data-workspace-asset-poster]",
		),
	);
	const targets = elements.flatMap((element) => {
		const parent = element.parentElement;
		const stateElement =
			element.tagName === "SOURCE" && parent instanceof HTMLMediaElement
				? parent
				: element;
		const entries: Array<{
			element: HTMLElement;
			stateElement: HTMLElement;
			attribute: "src" | "poster";
			path: string;
		}> = [];
		if (element.dataset.workspaceAssetSrc) {
			entries.push({
				element,
				stateElement,
				attribute: "src",
				path: element.dataset.workspaceAssetSrc,
			});
		}
		if (element.dataset.workspaceAssetPoster) {
			entries.push({
				element,
				stateElement,
				attribute: "poster",
				path: element.dataset.workspaceAssetPoster,
			});
		}
		return entries;
	});
	const loadAsset = createWorkspaceAssetLoader(resolve, controller.signal);
	const remaining = new Map<HTMLElement, number>();
	const failed = new Set<HTMLElement>();
	for (const { stateElement } of targets) {
		remaining.set(stateElement, (remaining.get(stateElement) ?? 0) + 1);
	}

	function settle(element: HTMLElement, error?: unknown) {
		if (controller.signal.aborted || run !== workspaceAssetRun) return;
		if (error) {
			failed.add(element);
			element.title =
				error instanceof Error ? error.message : "Asset failed to load";
		}
		const next = (remaining.get(element) ?? 1) - 1;
		remaining.set(element, next);
		if (next > 0) return;
		element.dataset.workspaceAssetState = failed.has(element)
			? "error"
			: "loaded";
		element.removeAttribute("aria-busy");
	}

	function observeLoad(
		target: EventTarget,
		event: string,
		stateElement: HTMLElement,
		errorMessage: string,
		onLoad?: () => void,
	) {
		const options = { once: true, signal: controller.signal };
		target.addEventListener(
			event,
			() => {
				onLoad?.();
				settle(stateElement);
			},
			options,
		);
		target.addEventListener(
			"error",
			() => settle(stateElement, new Error(errorMessage)),
			options,
		);
	}

	for (const { element, stateElement, attribute, path } of targets) {
		void loadAsset(path)
			.then(({ src }) => {
				if (controller.signal.aborted || run !== workspaceAssetRun) return;
				if (attribute === "poster") {
					const poster = new Image();
					observeLoad(
						poster,
						"load",
						stateElement,
						"Poster failed to load",
						() => element.setAttribute(attribute, src),
					);
					poster.src = src;
					return;
				}

				if (element instanceof HTMLImageElement) {
					observeLoad(element, "load", stateElement, "Image failed to load");
					element.src = src;
					return;
				}

				const media =
					element instanceof HTMLMediaElement
						? element
						: element.parentElement instanceof HTMLMediaElement
							? element.parentElement
							: null;
				if (!media) {
					element.setAttribute(attribute, src);
					settle(stateElement);
					return;
				}

				observeLoad(
					media,
					"loadedmetadata",
					stateElement,
					"Media failed to load",
					media instanceof HTMLAudioElement ? enhanceAudioPlayers : undefined,
				);
				media.preload = "metadata";
				element.setAttribute(attribute, src);
				if (element.tagName === "SOURCE") media.load();
			})
			.catch((error) => settle(stateElement, error));
	}

	return () => controller.abort();
});

function sweepDisconnectedAudioPlayers() {
	for (let i = mountedAudioPlayers.length - 1; i >= 0; i -= 1) {
		if (!mountedAudioPlayers[i].mount.isConnected) {
			unmountComponent(mountedAudioPlayers[i].instance);
			mountedAudioPlayers.splice(i, 1);
		}
	}
}

function enhanceAudioPlayers() {
	if (!markdownEl) return;

	sweepDisconnectedAudioPlayers();

	for (const figure of markdownEl.querySelectorAll<HTMLElement>(
		"figure.markdown-audio",
	)) {
		if (figure.dataset.audioEnhanced === "true") continue;
		const audio = figure.querySelector<HTMLAudioElement>("audio");
		if (!audio?.src) continue;

		figure.dataset.audioEnhanced = "true";
		const src = audio.currentSrc || audio.src;
		const caption =
			figure.querySelector("figcaption")?.textContent?.trim() || null;

		const target = document.createElement("div");
		target.className = "markdown-audio-mount";
		figure.insertBefore(target, audio);

		void import("$lib/components/AudioPlayer.svelte")
			.then(({ default: AudioPlayer }) => {
				if (!target.isConnected) return;
				const instance = mountComponent(AudioPlayer, {
					target,
					props: { src, title: caption },
				});
				mountedAudioPlayers.push({ mount: target, instance });
				// Release the native element only after the enhanced player is in
				// place — avoids a duplicate media instance while keeping the
				// native <audio> as the no-JS / streaming fallback.
				audio.remove();
				// The caption is now rendered inside the player; drop the duplicate.
				figure.querySelector("figcaption")?.remove();
			})
			.catch(() => {
				// Dynamic import failed: keep the native player usable and allow
				// retrying on the next render pass.
				if (target.isConnected) target.remove();
				audio.hidden = false;
				delete figure.dataset.audioEnhanced;
			});
	}
}

function markMermaidLoadError(error: unknown) {
	console.warn("[mermaid] renderer chunk failed to load", { error });
	if (!markdownEl) return;
	for (const element of markdownEl.querySelectorAll<HTMLElement>(
		".markdown-mermaid",
	)) {
		if (element.dataset.mermaidRendered === "true") continue;
		element.dataset.mermaidRendered = "true";
		element.classList.add("is-unavailable");
		element.replaceChildren();

		const message = document.createElement("div");
		message.className = "markdown-mermaid-error";
		message.textContent = "Diagram preview unavailable";
		element.appendChild(message);

		if (error instanceof Error && error.message) {
			element.title = error.message;
			const detail = document.createElement("div");
			detail.className = "markdown-mermaid-error-detail";
			detail.textContent = error.message;
			element.appendChild(detail);
		}
	}
}

function renderMermaid() {
	if (!markdownEl) return;
	void import("$lib/mermaid-renderer")
		.then(({ renderMermaidDiagrams }) =>
			markdownEl ? renderMermaidDiagrams(markdownEl) : undefined,
		)
		.catch((error) => markMermaidLoadError(error));
}

function resetMermaidDiagrams() {
	if (!markdownEl) return;
	for (const element of markdownEl.querySelectorAll<HTMLElement>(
		".markdown-mermaid",
	)) {
		element.dataset.mermaidRendered = "false";
		delete element.dataset.mermaidRenderToken;
		delete element.dataset.mermaidScale;
		element.classList.remove("is-unavailable");
		element.removeAttribute("title");
		element.innerHTML =
			'<div class="markdown-mermaid-loading">Rendering diagram…</div>';
	}
	renderMermaid();
}

function enhanceCodeBlocks() {
	if (!markdownEl) return;

	for (const pre of markdownEl.querySelectorAll("pre")) {
		if (pre.parentElement?.classList.contains("markdown-code-block")) continue;

		const wrapper = document.createElement("div");
		wrapper.className = "markdown-code-block";
		pre.parentNode?.insertBefore(wrapper, pre);
		wrapper.appendChild(pre);

		const button = document.createElement("button");
		button.type = "button";
		button.className = "markdown-code-copy";
		button.dataset.codeCopy = "";
		button.innerHTML = COPY_ICON;
		button.setAttribute("aria-label", "Copy code");
		button.title = "Copy code";
		wrapper.appendChild(button);
	}
}

async function copyText(text: string) {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textArea = document.createElement("textarea");
	textArea.value = text;
	textArea.style.position = "fixed";
	textArea.style.opacity = "0";
	document.body.appendChild(textArea);
	textArea.select();
	document.execCommand("copy");
	textArea.remove();
}

function markCopied(button: HTMLButtonElement) {
	button.innerHTML = CHECK_ICON;
	button.classList.add("copied");
	button.setAttribute("aria-label", "Code copied");
	button.title = "Code copied";
	if (copyResetTimer) clearTimeout(copyResetTimer);
	copyResetTimer = setTimeout(() => {
		button.innerHTML = COPY_ICON;
		button.classList.remove("copied");
		button.setAttribute("aria-label", "Copy code");
		button.title = "Copy code";
	}, 1400);
}

onMount(() => {
	const el = markdownEl;
	if (!el) return;

	function getAskOption(target: EventTarget | null) {
		return target instanceof HTMLElement
			? target.closest<HTMLButtonElement>("[data-cohub-ask-option]")
			: null;
	}

	function getAskOptionValue(option: HTMLButtonElement) {
		const encodedValue = option.dataset.cohubAskValue;
		return encodedValue ? decodeURIComponent(encodedValue) : "";
	}

	function setAskOptionPressed(option: HTMLButtonElement, pressed: boolean) {
		option.setAttribute("aria-pressed", pressed ? "true" : "false");
	}

	function buildMultiSelectSnippet(questionEl: HTMLElement) {
		return Array.from(
			questionEl.querySelectorAll<HTMLButtonElement>(
				'[data-cohub-ask-option][aria-pressed="true"]',
			),
		)
			.map(getAskOptionValue)
			.filter(Boolean)
			.join("\n");
	}

	function onPointerDown(e: Event) {
		if (!getAskOption(e.target)) return;
		// Pointer clicks should not steal composer focus on mobile.
		e.preventDefault();
	}

	function shouldPreserveNativeLinkClick(event: MouseEvent) {
		return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
	}

	function onClick(e: Event) {
		const target = e.target as HTMLElement;
		const askOption = getAskOption(e.target);
		if (askOption) {
			e.preventDefault();
			e.stopPropagation();
			const questionEl = askOption.closest<HTMLElement>(
				"[data-cohub-ask-question]",
			);
			const questionKey = askOption.dataset.cohubAskKey;
			const replacementKey = questionKey
				? `cohub-ask:${questionKey}`
				: undefined;
			const isMultiSelect = askOption.dataset.cohubAskMulti === "true";
			if (isMultiSelect && questionEl) {
				const nextPressed = askOption.getAttribute("aria-pressed") !== "true";
				setAskOptionPressed(askOption, nextPressed);
				insertComposerSnippet(buildMultiSelectSnippet(questionEl), {
					focus: false,
					replacementKey,
				});
				return;
			}

			questionEl
				?.querySelectorAll<HTMLButtonElement>("[data-cohub-ask-option]")
				.forEach((option) => {
					setAskOptionPressed(option, option === askOption);
				});
			const value = getAskOptionValue(askOption);
			if (!value) return;
			insertComposerSnippet(value, { focus: false, replacementKey });
			return;
		}

		const link = target.closest<HTMLAnchorElement>("a[href]");
		if (link && e instanceof MouseEvent) {
			const href = link.getAttribute("href") ?? "";
			const fileTarget = normalizeWorkspaceFileLinkTarget(href, {
				basePath: baseFilePath,
			});
			if (fileTarget && onOpenFile && !shouldPreserveNativeLinkClick(e)) {
				e.preventDefault();
				e.stopPropagation();
				void onOpenFile(fileTarget);
				return;
			}

			if (
				onOpenUrl &&
				!e.defaultPrevented &&
				!fileTarget &&
				!link.hasAttribute("download") &&
				(!link.target || link.dataset.cohubAutoTarget === "blank") &&
				!shouldPreserveNativeLinkClick(e)
			) {
				void onOpenUrl(href, e);
				return;
			}
		}

		const copyButton = target.closest<HTMLButtonElement>("[data-code-copy]");
		if (copyButton) {
			e.preventDefault();
			e.stopPropagation();
			const code = copyButton.parentElement?.querySelector("pre code");
			void copyText(code?.textContent ?? "").then(() => markCopied(copyButton));
			return;
		}

		if (target.tagName === "IMG") {
			e.preventDefault();
			e.stopPropagation();
			const img = target as HTMLImageElement;
			mediaLightbox.show({
				src: img.src,
				type: "image" as const,
				alt: img.alt,
			});
		} else if (
			target.tagName === "VIDEO" ||
			(target.tagName === "SOURCE" && target.parentElement?.tagName === "VIDEO")
		) {
			e.preventDefault();
			e.stopPropagation();
			const video =
				target.tagName === "VIDEO"
					? (target as HTMLVideoElement)
					: (target.parentElement as HTMLVideoElement);
			mediaLightbox.show({
				src: video.src || (video.querySelector("source")?.src ?? ""),
				type: "video" as const,
			});
		}
	}

	el.addEventListener("pointerdown", onPointerDown);
	el.addEventListener("click", onClick);
	themeObserver = new MutationObserver(() => resetMermaidDiagrams());
	themeObserver.observe(document.documentElement, {
		attributeFilter: ["data-theme"],
	});

	return () => {
		el.removeEventListener("pointerdown", onPointerDown);
		el.removeEventListener("click", onClick);
		themeObserver?.disconnect();
		themeObserver = null;
	};
});

onDestroy(() => {
	if (copyResetTimer) clearTimeout(copyResetTimer);
	themeObserver?.disconnect();
	for (const { instance } of mountedAudioPlayers) {
		unmountComponent(instance);
	}
	mountedAudioPlayers.length = 0;
});
</script>

<div
	bind:this={markdownEl}
	class="markdown-content"
	data-variant={variant}
>
	{#if stableHtml}
		<div class="markdown-stable-region">{@html stableHtml}</div>
	{/if}
	{#if tailHtml || streamingLive}
		<div
			class="markdown-live-region"
			class:streaming-live-markdown={streamingLive}
		>
			{@html tailHtml}
		</div>
	{/if}
</div>
