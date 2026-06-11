<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { onDestroy, untrack } from "svelte";
import MarkdownFrontmatter from "$lib/components/MarkdownFrontmatter.svelte";
import MarkdownSurface from "$lib/components/MarkdownSurface.svelte";
import { parseMarkdownFrontmatter } from "$lib/markdown-frontmatter";
import { StreamingMarkdownController } from "$lib/streaming-markdown-controller";

type MarkdownTextBlock = Extract<ContentBlock, { type: "text" }>;
type MarkdownVariant = "chat" | "document";

type Props = {
	source?: string;
	blocks?: MarkdownTextBlock[];
	variant?: MarkdownVariant;
	isStreaming?: boolean;
	onStart?: () => void;
	onRendered?: () => void;
};

const {
	source: sourceProp,
	blocks,
	variant = "chat",
	isStreaming = false,
	onStart,
	onRendered,
}: Props = $props();

let renderedHtml = $state("");
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
		renderedHtml = snapshot.html;
		requestAnimationFrame(() => untrack(() => onRendered?.()));
	});
	return controller;
}

function destroyController() {
	unsubscribeController?.();
	unsubscribeController = null;
	controller?.dispose();
	controller = null;
}

function renderFullMarkdown(markdownSource: string) {
	const seq = ++renderSeq;
	untrack(() => onStart?.());
	void import("$lib/markdown")
		.then(({ renderMarkdown }) => renderMarkdown(markdownSource))
		.then((html) => {
			if (seq !== renderSeq) return;
			renderedHtml = html;
			requestAnimationFrame(() => {
				if (seq === renderSeq) untrack(() => onRendered?.());
			});
		})
		.catch(() => {
			if (seq !== renderSeq) return;
			requestAnimationFrame(() => untrack(() => onRendered?.()));
		});
}

$effect(() => {
	const markdownSource = renderSource;
	const streaming = isStreaming;

	if (streaming) {
		untrack(() => onStart?.());
		ensureController().setTarget(markdownSource);
		return;
	}

	destroyController();
	renderFullMarkdown(markdownSource);
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
	<MarkdownSurface html={renderedHtml} {variant} streamingLive={isStreaming} />
</div>
