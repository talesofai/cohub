<script lang="ts">
/**
 * Full-capability session chat panel.
 * Reads a SessionChatHost view-model — no 80-field prop bag.
 */
import { ArrowDown, FileCode2, ListTree, Plus, Upload } from "lucide-svelte";
import type { Snippet } from "svelte";
import { untrack } from "svelte";
import AccessStateView from "$lib/components/AccessStateView.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import ChatTimeline from "$lib/components/ChatTimeline.svelte";
import NewChatBackground from "$lib/components/NewChatBackground.svelte";
import SessionComposer from "$lib/components/SessionComposer.svelte";
import SessionTaskTray from "$lib/components/SessionTaskTray.svelte";
import TurnBottomSheet from "$lib/components/TurnBottomSheet.svelte";
import TurnRail from "$lib/components/TurnRail.svelte";
import {
	type ChatDraftDropKind,
	classifyChatDraftDrop,
	readCohubPathFromDataTransfer,
} from "$lib/drag/chat-draft-drop";
import SessionModelSelectorDialog from "$lib/features/space/modules/SessionModelSelectorDialog.svelte";
import type { NewChatBackgroundConfig } from "$lib/space-config";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import { modelsStatusStore } from "$lib/stores/models-status.svelte";
import { entriesFromDataTransfer } from "$lib/upload-entries";
import type { SessionChatHost } from "./session-chat-host.controller.svelte";

let {
	host,
	newChatProfile,
	shouldShowNewChatBackground = false,
	newChatBackground = null,
	newChatBackgroundSpaceId = null,
	shouldShowNewChatProfile = false,
	newChatProfileExpanded = false,
	newChatProfileViewportEl = $bindable(),
}: {
	host: SessionChatHost;
	newChatProfile?: Snippet;
	shouldShowNewChatBackground?: boolean;
	newChatBackground?: NewChatBackgroundConfig | null;
	newChatBackgroundSpaceId?: string | null;
	shouldShowNewChatProfile?: boolean;
	newChatProfileExpanded?: boolean;
	newChatProfileViewportEl?: HTMLDivElement | null;
} = $props();

const access = $derived(host.access);
const activeSessionState = $derived(host.activeSessionState);
const activeSessionId = $derived(host.activeSessionId);
const isNewSessionRoute = $derived(host.isNewSessionRoute);
const timeline = $derived(host.timeline);
const followupQueue = $derived(host.followupQueue);
const activeTurnRailItems = $derived(host.activeTurnRailItems);

// Local DOM / UI binds synced into host (cannot bind directly to host getters).
let listEl = $state<HTMLDivElement | null>(null);
let chatTimelineRef = $state<unknown>(null);
let composerHostEl = $state<HTMLDivElement | null>(null);
let chatChromeEl = $state<HTMLDivElement | null>(null);
let composerInput = $state("");
let composerSystemInstructions = $state("");
let shouldAutoFollow = $state(true);
let showTurnBottomSheet = $state(false);
let showModelSelector = $state(false);
let draftDropKind = $state<ChatDraftDropKind | null>(null);
let draftDropCounter = 0;
const modelsCatalog = $derived(modelsCatalogStore.items);
const modelsStatus = $derived(modelsStatusStore.status);
const generationModelsCatalog = $derived(host.generationModelsCatalog);
const generationPolicyMode = $derived(host.generationPolicyMode);
const selectedGenerationModels = $derived(host.selectedGenerationModels);
const generationEnumSelections = $derived(host.generationEnumSelections);
const generationNumericConstraints = $derived(
	host.generationNumericConstraints,
);
const generationBooleanConstraints = $derived(
	host.generationBooleanConstraints,
);
const activeSessionModel = $derived(host.activeSessionModel);
const hasCustomPage = $derived(
	shouldShowNewChatProfile || shouldShowNewChatBackground,
);

$effect(() => {
	const el = listEl;
	untrack(() => {
		host.listEl = el;
	});
});
$effect(() => {
	const ref = chatTimelineRef;
	untrack(() => {
		host.chatTimelineRef = ref;
	});
});
$effect(() => {
	const el = composerHostEl;
	untrack(() => {
		host.composerHostEl = el;
	});
});
$effect(() => {
	const el = chatChromeEl;
	untrack(() => {
		host.chatChromeEl = el;
	});
});
$effect(() => {
	const next = host.input;
	untrack(() => {
		if (next !== composerInput) composerInput = next;
	});
});
$effect(() => {
	const value = composerInput;
	untrack(() => {
		if (value !== host.input) host.input = value;
	});
});
$effect(() => {
	const next = host.systemInstructions;
	untrack(() => {
		if (next !== composerSystemInstructions) composerSystemInstructions = next;
	});
});
$effect(() => {
	const value = composerSystemInstructions;
	untrack(() => {
		if (value !== host.systemInstructions) host.systemInstructions = value;
	});
});
$effect(() => {
	const next = host.shouldAutoFollow;
	untrack(() => {
		if (shouldAutoFollow !== next) shouldAutoFollow = next;
	});
});
$effect(() => {
	const next = shouldAutoFollow;
	untrack(() => {
		if (host.shouldAutoFollow !== next) host.shouldAutoFollow = next;
	});
});
$effect(() => {
	const next = host.showTurnBottomSheet;
	untrack(() => {
		if (showTurnBottomSheet !== next) showTurnBottomSheet = next;
	});
});
$effect(() => {
	const next = showTurnBottomSheet;
	untrack(() => {
		if (host.showTurnBottomSheet !== next) host.showTurnBottomSheet = next;
	});
});
$effect(() => {
	const next = host.showModelSelector;
	untrack(() => {
		if (showModelSelector !== next) showModelSelector = next;
	});
});
$effect(() => {
	const next = showModelSelector;
	untrack(() => {
		if (host.showModelSelector !== next) host.showModelSelector = next;
	});
});

const canAcceptDraftDrop = $derived(
	Boolean(activeSessionState || isNewSessionRoute),
);

function resetDraftDropState() {
	draftDropKind = null;
	draftDropCounter = 0;
}

function acceptDraftDrop(event: DragEvent) {
	if (!canAcceptDraftDrop) return null;
	const kind = classifyChatDraftDrop(event.dataTransfer);
	if (!kind) return null;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	return kind;
}

function handleDraftDragEnter(event: DragEvent) {
	const kind = acceptDraftDrop(event);
	if (!kind) return;
	draftDropCounter += 1;
	draftDropKind = kind;
}

function handleDraftDragOver(event: DragEvent) {
	const kind = acceptDraftDrop(event);
	if (!kind) return;
	draftDropKind = kind;
}

function handleDraftDragLeave(event: DragEvent) {
	if (!classifyChatDraftDrop(event.dataTransfer)) return;
	event.preventDefault();
	draftDropCounter = Math.max(0, draftDropCounter - 1);
	if (draftDropCounter === 0) draftDropKind = null;
}

async function handleDraftDrop(event: DragEvent) {
	const kind = acceptDraftDrop(event);
	resetDraftDropState();
	if (!kind || !event.dataTransfer) return;

	if (kind === "files") {
		await host.handlePickAttachments(
			await entriesFromDataTransfer(event.dataTransfer),
		);
		return;
	}

	const path = readCohubPathFromDataTransfer(event.dataTransfer);
	if (!path) return;
	insertComposerSnippet(` \`${path}\` `);
}
</script>

{#if access.spaceLoadError && !access.spaceHasMinimalAccess}
	<div class="m-4">
		<AccessStateView
			state={{ kind: "error", message: access.spaceLoadError }}
			size="compact"
		/>
	</div>
{/if}
{#if host.createSessionError}
	<div class="m-4 mt-0">
		<AccessStateView
			state={{ kind: "error", message: host.createSessionError }}
			size="compact"
		/>
	</div>
{/if}
{#if access.bootstrapping && !activeSessionState && !isNewSessionRoute}
	<CenteredLoading label="Loading space…" />
{:else if !activeSessionState}
	<div
		class="flex-1 flex flex-col items-center justify-center text-text-tertiary gap-4"
	>
		<div class="text-[14px]">No chat selected</div>
		{#if !access.spaceHasMinimalAccess}
			<button
				type="button"
				class="flex items-center gap-1.5 px-3 py-2 rounded-[5px] bg-bg-hover hover:bg-bg-hover-strong border border-border-subtle text-[12px] text-text-secondary hover:text-text-primary transition-colors duration-100 disabled:opacity-50"
				onclick={() => host.handleCreateNewSession()}
				disabled={!access.canCreateSession}
			>
				<Plus class="w-3.5 h-3.5" />
				Create a session
			</button>
		{/if}
	</div>
{:else if activeSessionState.loading && !activeSessionState.loaded && host.activeSessionInitialLoadingVisible}
	<CenteredLoading label="Loading turns…" />
{:else}
	{#if activeSessionState.error}
		<div class="m-4">
			<AccessStateView state={activeSessionState.error} size="compact" />
		</div>
	{/if}
	<div
		class="relative flex-1 min-h-0 flex flex-col overflow-hidden"
		role="region"
		aria-label="Chat panel"
		ondragenter={handleDraftDragEnter}
		ondragover={handleDraftDragOver}
		ondragleave={handleDraftDragLeave}
		ondrop={handleDraftDrop}
	>
		{#if draftDropKind}
			<div
				class="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-[28px] border border-dashed border-brand/40 bg-bg-primary/72 backdrop-blur-[2px]"
				aria-hidden="true"
			>
				<div
					class="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-elevated px-4 py-2 text-[12px] text-text-secondary shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
				>
					{#if draftDropKind === "files"}
						<Upload class="h-4 w-4 text-brand" />
						<span>Drop files to attach</span>
					{:else}
						<FileCode2 class="h-4 w-4 text-brand" />
						<span>Drop to insert path</span>
					{/if}
				</div>
			</div>
		{/if}
		<SessionTaskTray
			notices={host.sessionTaskNotices}
			hasMore={host.sessionTaskHasMore}
			loadingMore={host.sessionTaskRecentLoading}
			onExpand={host.handleSessionTaskTrayExpand}
			onLoadMore={host.handleSessionTaskTrayLoadMore}
			onOpenGenerationMedia={host.handleOpenGenerationTaskMedia}
		/>
		{#if shouldShowNewChatBackground && newChatBackground}
			<NewChatBackground background={newChatBackground} spaceId={newChatBackgroundSpaceId} />
			<div class="relative z-10 flex-1 min-h-0 pointer-events-none"></div>
		{:else if shouldShowNewChatProfile}
			<div
				bind:this={newChatProfileViewportEl}
				class="flex-1 min-h-0 overflow-hidden sm:overflow-y-auto"
				class:overflow-y-auto={newChatProfileExpanded}
			>
				{#if newChatProfile}{@render newChatProfile()}{/if}
			</div>
		{:else}
			{#key activeSessionId ?? "none"}
				<ChatTimeline
					bind:this={chatTimelineRef}
					bind:bindListEl={listEl}
					timeline={timeline}
					preloadThreshold={10}
					onFirstVisible={host.handleFirstVisible}
					onLoadToolCalls={host.onLoadToolCalls}
					onLoadIntermediate={host.onLoadIntermediate}
					onRequestIntermediateSync={host.onRequestIntermediateSync}
					onMarkdownRenderStart={host.handleTimelineMarkdownRenderStart}
					onMarkdownRendered={host.handleTimelineMarkdownRendered}
					onForkTurn={host.handleForkTurn}
					forkingTurnId={host.forkingTurnId}
					loading={host.activeSessionInitialLoadingVisible}
					loadingOlder={activeSessionState?.loadingOlder ?? false}
					onOpenFile={(target) => {
						void host.openPath(target);
					}}
					modelsCatalog={host.modelsCatalog ?? undefined}
				/>
			{/key}
		{/if}
		<div
			bind:this={chatChromeEl}
			class="chat-chrome relative z-10 shrink-0"
			class:bg-chat-panel={!hasCustomPage}
			class:chat-chrome--overlay={hasCustomPage}
		>
			{#if followupQueue.length > 0}
				<div
					class="mx-auto w-full max-w-4xl border-t border-chat-panel-border/70 px-4 py-2 sm:px-6"
					class:bg-chat-panel={!hasCustomPage}
				>
					<div
						class="mb-1 flex items-center gap-2 text-[11px] text-text-placeholder"
					>
						<span class="font-medium text-text-secondary">Follow-up</span>
						<span>{followupQueue.length} queued</span>
					</div>
					<div
						class="max-h-[min(22dvh,9rem)] space-y-1 overflow-y-auto overscroll-contain pr-1 sm:max-h-[min(28vh,12rem)]"
					>
						{#each followupQueue as turn (turn.id)}
							<div
								class="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-text-tertiary hover:bg-bg-hover/60"
							>
								<div class="min-w-0 flex-1 truncate">
									{host.turnPreviewText(turn)}
								</div>
								<button
									type="button"
									class="shrink-0 rounded px-1.5 py-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:cursor-default disabled:opacity-50"
									disabled={host.pendingFollowupActionIds.has(turn.id)}
									onclick={() => {
										void host.handleSteerFollowup(turn.id);
									}}>Steer now</button
								>
								<button
									type="button"
									class="shrink-0 rounded px-1.5 py-1 text-text-placeholder hover:bg-bg-surface hover:text-text-secondary disabled:cursor-default disabled:opacity-50"
									disabled={host.pendingFollowupActionIds.has(turn.id)}
									onclick={() => {
										void host.handleCancelFollowup(turn.id);
									}}>Cancel</button
								>
							</div>
						{/each}
					</div>
				</div>
			{/if}
			<div
				bind:this={composerHostEl}
				class:relative={shouldShowNewChatBackground}
				class:z-10={shouldShowNewChatBackground}
			>
				<SessionComposer
					bind:value={composerInput}
					bind:systemInstructions={composerSystemInstructions}
					disabled={!activeSessionState && !isNewSessionRoute}
					sending={host.sending}
					isRunning={host.activeSessionIsRunning}
					aborting={host.aborting}
					streamError={host.composerNotice}
					showBillingAction={host.composerShowsBillingAction}
					attachments={host.attachments}
					viewportContexts={host.viewportContexts}
					currentModel={host.activeSessionModel}
					thinkingLevelLabel={host.activeSessionThinkingLevelLabel}
					generationPolicyLabel={host.generationPolicyLabel}
					currentSpaceId={host.spaceId}
					mobileAutoFocusOnMount={isNewSessionRoute && !activeSessionId}
					promptTemplates={host.promptTemplates}
					promptTemplatesLoaded={host.promptTemplatesLoaded}
					skills={host.skills}
					skillsLoaded={host.skillsLoaded}
					onpickattachment={host.handlePickAttachments}
					onremoveattachment={host.handleRemoveAttachment}
					onremoveviewport={host.handleRemoveViewportContext}
					onsubmit={host.handleSend}
					onabort={host.handleAbort}
					onModelSelect={() => {
						void host.loadModelsCatalog();
						void host.loadGenerationModelsCatalog();
						void modelsStatusStore.load();
						showModelSelector = true;
					}}
				/>
			</div>
		</div>
		<TurnRail
			turns={activeTurnRailItems}
			loadedTurns={activeSessionState.turns}
			markerPositions={host.turnMarkerPositions}
			markerHeights={host.turnMarkerHeights}
			scrollTop={host.timelineScrollTop}
			scrollHeight={host.timelineScrollHeight}
			clientHeight={host.timelineClientHeight}
			bottomOffset={host.chatChromeHeight}
			olderCount={host.unloadedOlderTurnCount}
			newerCount={host.unloadedNewerTurnCount}
			hasMoreOlder={activeSessionState.hasMore}
			hasMoreNewer={activeSessionState.hasMoreNewer}
			loadingOlder={activeSessionState.loadingOlder}
			loadingNewer={activeSessionState.loadingNewer}
			currentSequence={host.currentTurnSequence}
			loadingSequence={host.loadingTurnSequence}
			onJump={(sequence) => {
				void host.jumpToTurnAndUpdateUrl(sequence);
			}}
			onScrollTo={(scrollTop) => {
				host.setProgrammaticScrollTop(scrollTop);
			}}
			onScrollCommit={() => {
				host.snapScrollToNearestTurn();
			}}
			onLoadOlder={() => {
				if (activeSessionId) void host.loadOlderTurns(activeSessionId);
			}}
			onLoadNewer={() => {
				if (activeSessionId) void host.syncSessionNewer(activeSessionId, null);
			}}
		/>
		{#if host.highlightedTurnSequence}
			<div
				class="pointer-events-none absolute left-0 right-0 top-0 z-10 h-px bg-brand/70"
			></div>
		{/if}
		{#if host.hasUnread || !shouldAutoFollow || activeTurnRailItems.length > 1}
			<div
				class={`pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 ${!host.hasUnread && host.shouldAutoFollow ? "lg:hidden" : ""}`}
				style:bottom={`${Math.max(host.chatChromeHeight + 12, 96)}px`}
				style="animation: cohub-scroll-to-bottom-in 180ms cubic-bezier(0.22, 1, 0.36, 1);"
			>
				<div
					class="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border-subtle/80 bg-bg-primary/95 p-1 shadow-[0_4px_18px_rgba(0,0,0,0.16)] backdrop-blur-sm"
				>
					{#if host.hasUnread}
						<button
							type="button"
							aria-label="Jump to new messages"
							class="flex h-7 items-center justify-center rounded-full bg-brand px-2.5 text-[11px] font-semibold leading-none text-brand-contrast-fg transition-colors duration-150 hover:bg-brand-hover active:scale-95"
							onclick={() => {
								shouldAutoFollow = true;
								void host.forceScrollToBottom();
							}}
						>
							New
						</button>
					{/if}
					{#if !shouldAutoFollow}
						<button
							type="button"
							aria-label="Jump to bottom"
							class="flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary active:scale-95"
							onclick={() => {
								shouldAutoFollow = true;
								void host.forceScrollToBottom();
							}}
						>
							<ArrowDown class="w-4 h-4" />
						</button>
					{/if}
					{#if activeTurnRailItems.length > 1}
						<button
							type="button"
							aria-label="Open turn list"
							class="flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary active:scale-95 lg:hidden"
							onclick={() => {
								showTurnBottomSheet = true;
								if (activeSessionId) void host.loadTurnIndex(activeSessionId, true);
							}}
						>
							<ListTree class="w-4 h-4" />
						</button>
					{/if}
				</div>
			</div>
		{/if}
		<TurnBottomSheet
			open={showTurnBottomSheet}
			turns={activeTurnRailItems}
			currentSequence={host.currentTurnSequence}
			onClose={() => {
				showTurnBottomSheet = false;
			}}
			onJump={(sequence) => {
				void host.jumpToTurnAndUpdateUrl(sequence);
			}}
		/>
		<SessionModelSelectorDialog
			open={showModelSelector}
			onClose={() => {
				showModelSelector = false;
			}}
			onSelect={host.handleModelSelect}
			models={modelsCatalog ?? []}
			currentModel={activeSessionModel}
			thinkingLevelModel={host.activeSessionTurnModel ?? activeSessionModel}
			currentThinkingLevel={host.activeSessionThinkingLevel}
			modelStatus={modelsStatus?.models ?? null}
			generationModels={generationModelsCatalog ?? []}
			{generationPolicyMode}
			{selectedGenerationModels}
			{generationEnumSelections}
			{generationNumericConstraints}
			{generationBooleanConstraints}
			onGenerationTabOpen={() => {
				void host.loadGenerationModelsCatalog();
			}}
			onGenerationPolicyModeChange={host.setGenerationPolicyMode}
			onGenerationModelToggle={host.setGenerationModelSelected}
			onGenerationEnumValueToggle={host.setGenerationEnumValueSelected}
			onGenerationNumericConstraintChange={host.setGenerationNumericConstraint}
			onGenerationBooleanConstraintChange={host.setGenerationBooleanConstraint}
		/>
	</div>
{/if}

<style>
	.chat-chrome--overlay {
		background: linear-gradient(
			to bottom,
			transparent 0%,
			color-mix(in srgb, var(--bg-content) 48%, transparent) 30%,
			color-mix(in srgb, var(--bg-content) 82%, transparent) 65%,
			var(--bg-content) 100%
		);
	}
</style>
