<script module lang="ts">
let markdownModulePromise: Promise<typeof import("$lib/markdown")> | null =
	null;

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPlainTextFallback(markdownSource: string) {
	return escapeHtml(markdownSource).replaceAll("\n", "<br>");
}

function loadMarkdownModule() {
	markdownModulePromise ??= import("$lib/markdown");
	return markdownModulePromise;
}
</script>

<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { onDestroy, tick, untrack } from "svelte";
import MarkdownFrontmatter from "$lib/components/MarkdownFrontmatter.svelte";
import MarkdownSurface from "$lib/components/MarkdownSurface.svelte";
import { parseMarkdownFrontmatter } from "$lib/markdown-frontmatter";
import { StreamingMarkdownController } from "$lib/streaming-markdown-controller";
import {
	prepareWorkspaceAssetHtml,
	type ResolveWorkspaceAsset,
} from "$lib/workspace-assets";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";

type MarkdownTextBlock = Extract<ContentBlock, { type: "text" }>;
type MarkdownVariant = "chat" | "document";

type Props = {
	source?: string;
	blocks?: MarkdownTextBlock[];
	variant?: MarkdownVariant;
	isStreaming?: boolean;
	baseFilePath?: string | null;
	onStart?: () => void;
	onRendered?: () => void;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
};

const {
	source: sourceProp,
	blocks,
	variant = "chat",
	isStreaming = false,
	baseFilePath = null,
	onStart,
	onRendered,
	onOpenFile,
	onOpenUrl,
	resolveWorkspaceAsset,
}: Props = $props();

let stableHtml = $state("");
let tailHtml = $state("");
let renderSeq = 0;
let controller: StreamingMarkdownController | null = null;
let unsubscribeController: (() => void) | null = null;

const source = $derived.by(() => {
	const raw =
		sourceProp ?? blocks?.map((block) => block.text).join("\n\n") ?? "";
	return isStreaming ? raw : raw.trim();
});

const frontmatter = $derived(
	!isStreaming && variant === "document"
		? parseMarkdownFrontmatter(source)
		: null,
);
const renderSource = $derived(frontmatter?.body ?? source);

function ensureController() {
	if (controller) return controller;
	controller = new StreamingMarkdownController();
	unsubscribeController = controller.subscribe((snapshot) => {
		stableHtml = snapshot.stableHtml;
		tailHtml = snapshot.tailHtml;
		void tick().then(() => untrack(() => onRendered?.()));
	});
	return controller;
}

function destroyController() {
	unsubscribeController?.();
	unsubscribeController = null;
	controller?.dispose();
	controller = null;
}

function renderFullMarkdown(
	markdownSource: string,
	assetBasePath: string | null,
	assetResolver: ResolveWorkspaceAsset | undefined,
) {
	const seq = ++renderSeq;
	stableHtml = renderPlainTextFallback(markdownSource);
	tailHtml = "";
	untrack(() => onStart?.());
	void loadMarkdownModule()
		.then(({ renderMarkdown }) => renderMarkdown(markdownSource))
		.then((html) => {
			if (seq !== renderSeq) return;
			stableHtml =
				assetBasePath && assetResolver
					? prepareWorkspaceAssetHtml(html, assetBasePath)
					: html;
			tailHtml = "";
			void tick().then(() => {
				if (seq === renderSeq) untrack(() => onRendered?.());
			});
		})
		.catch(() => {
			if (seq !== renderSeq) return;
			void tick().then(() => untrack(() => onRendered?.()));
		});
}

$effect(() => {
	const markdownSource = renderSource;
	const streaming = isStreaming;
	const assetBasePath = baseFilePath;
	const assetResolver = resolveWorkspaceAsset;

	if (streaming) {
		untrack(() => onStart?.());
		ensureController().setTarget(markdownSource);
		return;
	}

	destroyController();
	renderFullMarkdown(markdownSource, assetBasePath, assetResolver);
});

onDestroy(() => {
	destroyController();
});
</script>

<div
	class="streaming-markdown-flow"
	class:is-streaming={isStreaming}
	data-variant={variant}
>
	{#if frontmatter}
		<MarkdownFrontmatter
			raw={frontmatter.raw}
			entries={frontmatter.entries}
		/>
	{/if}
	<MarkdownSurface
		{stableHtml}
		{tailHtml}
		{variant}
		streamingLive={isStreaming}
		{baseFilePath}
		{onOpenFile}
		{onOpenUrl}
		{resolveWorkspaceAsset}
	/>
</div>
