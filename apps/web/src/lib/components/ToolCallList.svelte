<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import type { MessageToolCallsFile } from "@cohub/protocol/model";
import ToolCallItem from "$lib/components/ToolCallItem.svelte";
import { buildToolCallViewModels } from "$lib/components/tool-call-format";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	content: ContentBlock[];
	toolCallsFile?: MessageToolCallsFile | null;
	streaming?: boolean;
	defaultExpanded?: boolean;
	onLoadToolCalls?: () => Promise<MessageToolCallsFile | null>;
	flush?: boolean;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
};

const {
	content,
	toolCallsFile = null,
	streaming = false,
	defaultExpanded = false,
	onLoadToolCalls,
	flush = false,
	onOpenFile,
}: Props = $props();
let loading = $state(false);
let loadError = $state<string | null>(null);
let loadedFile = $state<MessageToolCallsFile | null>(null);
let requestedLoad = $state(false);

const effectiveFile = $derived(toolCallsFile ?? loadedFile);
const tools = $derived(
	buildToolCallViewModels({ content, toolCallsFile: effectiveFile }),
);

// DEBUG(each_key_duplicate 排查): 核心疑点——这里是 {#each tools as tool (tool.id)}
// 实际拿到的 tool_use.id 数组，最贴近崩溃现场的另一层 key 源。上游疑点是：
// 中间消息的 content 数组里，session-patch-reducer.ts 的 applyPatchOpsToBlocks
// 在处理 replace ops 时，如果 findBlockForReplacement 判定同一个 streamIndex 上
// 的两个 tool_use 不兼容(blockIdentityCompatible false,比如 id/name 不同)，会走
// push 而不是 replace，导致同一个 content 数组里出现两个 tool_use blocks。
// 如果这两个 block 恰好有相同的 id(比如 patch 重复应用/网络重传)，
// 就会触发 Svelte each_key_duplicate。
$effect(() => {
	const ids = tools.map((t) => t.id);
	const seen = new Map<string, number>();
	const duplicates: string[] = [];
	for (const id of ids) {
		seen.set(id, (seen.get(id) ?? 0) + 1);
	}
	for (const [id, count] of seen) {
		if (count > 1) duplicates.push(id);
	}
	if (duplicates.length > 0) {
		console.log(
			"[each_key_duplicate DEBUG] ToolCallList tools has duplicate tool.id",
			{
				duplicateIds: duplicates,
				allIds: ids,
				allNames: tools.map((t) => t.name),
				contentLength: content.length,
				contentToolUseBlocks: content
					.filter(
						(block): block is Extract<typeof block, { type: "tool_use" }> =>
							block.type === "tool_use",
					)
					.map((block) => ({ id: block.id, name: block.name })),
			},
		);
	}
});

async function ensureLoaded() {
	if (!onLoadToolCalls || effectiveFile || loading) return;
	requestedLoad = true;
	loading = true;
	loadError = null;
	try {
		loadedFile = await onLoadToolCalls();
	} catch (error) {
		loadError =
			error instanceof Error ? error.message : "Failed to load tool details";
	} finally {
		loading = false;
	}
}

function retryLoad() {
	requestedLoad = false;
	void ensureLoaded();
}
</script>

{#if tools.length > 0}
	<div class={flush ? "space-y-0.5" : "mt-2 space-y-0.5"}>
		{#if loadError}
			<button type="button" class="ml-[26px] mb-1 rounded-md border border-status-error/30 bg-status-error/5 px-2 py-1 text-left text-[12px] leading-snug text-status-error hover:bg-status-error/10" onclick={retryLoad}>
				{loadError} · Retry
			</button>
		{/if}
		{#each tools as tool (tool.id)}
			<ToolCallItem {tool} loading={loading && requestedLoad && !effectiveFile} needsDetails={Boolean(onLoadToolCalls) && !effectiveFile} defaultExpanded={defaultExpanded || (streaming && tool.status === 'running')} autoExpandWhileRunning={streaming} onExpand={ensureLoaded} {onOpenFile} />
		{/each}
	</div>
{/if}
